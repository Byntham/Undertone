import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  Tray,
} from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { CleanupClient } from "../core/cleanup";
import { ClipboardPaster } from "../core/clipboardPaster";
import { normalizeConfig, type UndertoneConfig } from "../core/config";
import { DictationJobRunner } from "../core/dictationRunner";
import { GestureState, TapStateMachine } from "../core/gestures";
import {
  DictationPipelineQueue,
  SessionHistory,
  type DictationTarget,
} from "../core/pipelineQueue";
import { InsertionMemory, prepareText } from "../core/textPreparation";
import { Transcriber } from "../core/transcriber";
import { ConfigStore, type ConfigStoreOptions } from "./configStore";
import { FetchHttpClient } from "../platform/http";
import { WindowsHost } from "../platform/windowsHost";

const packagedSmoke = process.env.UNDERTONE_PACKAGE_SMOKE === "1";
const packagedSmokeResult = process.env.UNDERTONE_PACKAGE_SMOKE_RESULT;
const electronPreview = app.getVersion().includes("-electron.");
if (packagedSmoke) {
  const profilePath = process.env.UNDERTONE_PACKAGE_SMOKE_PROFILE;
  if (profilePath === undefined || !isWithin(profilePath, app.getPath("temp"))) {
    throw new Error("Packaged smoke profile path is invalid");
  }
  app.setPath("userData", profilePath);
} else if (electronPreview) {
  const previewRoot = process.env.LOCALAPPDATA ?? app.getPath("appData");
  app.setPath("userData", path.join(previewRoot, "Undertone", "ElectronPreview"));
}
const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let settingsWindow: BrowserWindow | null = null;
  let overlayWindow: BrowserWindow | null = null;
  let audioWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let paused = false;
  let audioReady = false;
  let settingsReady = false;
  let config: UndertoneConfig = normalizeConfig(undefined);
  let pipeline: DictationPipelineQueue | null = null;
  let pendingTarget: Promise<DictationTarget | null> | null = null;
  const insertionMemory = new InsertionMemory();
  const history = new SessionHistory();
  const windowsHost = new WindowsHost(app.isPackaged ? {
    executable: path.join(process.resourcesPath, "native", "Undertone.WinHost.exe"),
  } : {});
  let rightControlDown = false;
  let overlayHideTimer: ReturnType<typeof setTimeout> | undefined;

  const sendOverlay = (state: "recording" | "locked" | "message" | "hidden", text = ""): void => {
    const overlay = overlayWindow;
    if (overlay === null) return;
    overlay.webContents.send("overlay:state", { state, text });
    if (state === "hidden") {
      overlay.hide();
      return;
    }
    const bounds = screen.getPrimaryDisplay().bounds;
    const { width, height } = overlay.getBounds();
    overlay.setPosition(
      bounds.x + Math.round((bounds.width - width) / 2),
      bounds.y + bounds.height - height - 72,
      false,
    );
    overlay.showInactive();
  };

  const showFeedback = (
    text: string,
    kind: "normal" | "warning" | "error" = "normal",
  ): void => {
    if (overlayHideTimer !== undefined) clearTimeout(overlayHideTimer);
    overlayHideTimer = undefined;
    sendOverlay("message", text);
    if (text.startsWith("Loading the local model")) return;
    const duration = kind === "normal" ? 1_600 : 5_000;
    overlayHideTimer = setTimeout(() => sendOverlay("hidden"), duration);
  };

  const gestures = new TapStateMachine({
    onStart: () => {
      if (!audioReady || audioWindow === null) {
        sendOverlay("message", "Audio service is not ready");
        return false;
      }
      audioWindow.webContents.send("audio:command", { type: "start" });
      sendOverlay("recording");
      return true;
    },
    onFinish: () => {
      pendingTarget = windowsHost.getForeground().then((foreground) => ({
        window: foreground.window,
        executable: foreground.executable,
      })).catch(() => null);
      audioWindow?.webContents.send("audio:command", { type: "stop" });
      sendOverlay("message", "Finalizing audio…");
    },
    onDiscard: () => {
      pendingTarget = null;
      audioWindow?.webContents.send("audio:command", { type: "cancel" });
      sendOverlay("hidden");
    },
    onLock: () => sendOverlay("locked"),
  });

  const createOverlay = async (): Promise<void> => {
    overlayWindow = new BrowserWindow({
      width: 220,
      height: 60,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, "../preload/overlayPreload.js"),
      },
    });
    overlayWindow.setIgnoreMouseEvents(true);
    await overlayWindow.loadFile(
      path.join(__dirname, "../../renderer/overlay/index.html"),
    );
  };

  const createAudio = async (): Promise<void> => {
    audioWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, "../preload/audioPreload.js"),
      },
    });
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
      return permission === "media" && webContents === audioWindow?.webContents;
    });
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === "media" && webContents === audioWindow?.webContents);
    });
    await audioWindow.loadFile(
      path.join(__dirname, "../../renderer/audio/index.html"),
    );
  };

  const createTray = (): void => {
    const icon = nativeImage.createFromPath(resolveAsset("icon.png"));
    tray = new Tray(icon);
    tray.setToolTip("Undertone");
    const menu = Menu.buildFromTemplate([
      { label: "Open Settings", click: () => openSettings() },
      { type: "separator" },
      {
        label: "Pause dictation",
        type: "checkbox",
        checked: false,
        click: (item) => {
          paused = item.checked;
          if (paused) gestures.cancel();
          void (paused ? windowsHost.stopInput() : windowsHost.startInput())
            .catch((error: unknown) => {
              item.checked = !paused;
              paused = item.checked;
              showFeedback(
                error instanceof Error ? error.message : "Could not change dictation state",
                "error",
              );
            });
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
    tray.on("double-click", () => openSettings());
  };

  const initializePipeline = async (): Promise<void> => {
    const configPath = electronPreview
      ? path.join(app.getPath("userData"), "config.json")
      : path.join(app.getPath("appData"), "Undertone", "config.json");
    const storeOptions: ConfigStoreOptions = { configPath, cipher: windowsHost };
    if (!electronPreview) {
      storeOptions.legacyConfigPath = path.join(
        app.getPath("appData"),
        "PushToTalkSTT",
        "config.json",
      );
    }
    config = await new ConfigStore(storeOptions).load();

    const http = new FetchHttpClient();
    const transcriber = new Transcriber(http, {
      ensureReady() {
        throw new Error("Local transcription is not available in the Electron preview yet");
      },
    });
    const cleanup = new CleanupClient(http, {
      baseUrl() { return null; },
      loadAsync() { /* Local cleanup lifecycle is ported in a later milestone. */ },
    });
    const paster = new ClipboardPaster(
      {
        readText: () => clipboard.readText(),
        writeText: (value) => clipboard.writeText(value),
      },
      windowsHost,
    );
    const runner = new DictationJobRunner({
      transcriber,
      async prepareText(transcript, snapshot) {
        return await prepareText(transcript, snapshot, {
          acquireContext: async () => await insertionMemory.acquire({
            getCaretContext: async (before, after) => (
              await windowsHost.getCaretContext(before, after)
            ),
            getForegroundWindow: async () => (await windowsHost.getForeground()).window,
          }),
          getAppIdentity: async () => {
            const foreground = await windowsHost.getForeground();
            return {
              executable: foreground.executable,
              title: foreground.title,
            };
          },
          cleanup: async (request) => await cleanup.cleanup(request),
        });
      },
      restoreTarget: async (target) => {
        if (target === null || target.window === "" || target.window === "0") return true;
        const foreground = await windowsHost.getForeground();
        return foreground.window === target.window
          || await windowsHost.focusWindow(target.window);
      },
      getForegroundWindow: async () => (await windowsHost.getForeground()).window,
      isLocalSttLoaded: () => false,
      paster,
      history,
      insertionMemory,
      feedback: { message: showFeedback },
    });
    pipeline = new DictationPipelineQueue(
      () => config,
      {
        dictate: async (wav, target, snapshot) => {
          await runner.run(wav, target, snapshot);
        },
        repaste: async (text, snapshot) => {
          const generation = insertionMemory.captureGeneration();
          await paster.paste(text, Boolean(snapshot.restore_clipboard));
          history.registerSuccess(text, null);
          const foreground = await windowsHost.getForeground();
          insertionMemory.registerPaste(foreground.window, text, generation);
          showFeedback(`Pasted · ${text.split(/\s+/u).filter(Boolean).join(" ")}`);
        },
      },
    );
  };

  const openSettings = (): void => {
    if (settingsWindow === null) {
      settingsWindow = new BrowserWindow({
        width: 960,
        height: 720,
        show: false,
        backgroundColor: "#282c34",
        icon: resolveAsset("icon.ico"),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          preload: path.join(__dirname, "../preload/preload.js"),
        },
      });
      settingsWindow.setMenuBarVisibility(false);
      void settingsWindow.loadFile(
        path.join(__dirname, "../../renderer/index.html"),
      );
      settingsWindow.webContents.once("did-finish-load", () => {
        settingsReady = true;
      });
      settingsWindow.once("ready-to-show", () => {
        if (!packagedSmoke) settingsWindow?.show();
      });
      settingsWindow.on("close", (event) => {
        if (!quitting) {
          event.preventDefault();
          settingsWindow?.hide();
        }
      });
      settingsWindow.on("closed", () => {
        settingsWindow = null;
      });
    } else {
      settingsWindow.show();
      settingsWindow.focus();
    }
  };

  app.on("second-instance", openSettings);
  app.on("before-quit", () => {
    quitting = true;
    void windowsHost.stop();
  });
  ipcMain.on("audio:event", (event, payload: unknown) => {
    if (event.sender !== audioWindow?.webContents || !isRecord(payload)) return;
    if (payload.type === "ready") {
      audioReady = true;
    } else if (payload.type === "stopped") {
      const wav = toByteArray(payload.wav);
      const target = pendingTarget;
      pendingTarget = null;
      if (wav === null || wav.byteLength < 9_600) {
        showFeedback("Too short — hold the key while you speak", "warning");
        return;
      }
      const activePipeline = pipeline;
      if (activePipeline === null) {
        showFeedback("Dictation service is not ready", "error");
        return;
      }
      void (async () => {
        await activePipeline.enqueueDictation(wav, await target ?? {
          window: "0",
          executable: null,
        });
      })().catch((error: unknown) => {
        showFeedback(
          error instanceof Error ? error.message : "The dictation pipeline failed",
          "error",
        );
      });
    } else if (payload.type === "error") {
      pendingTarget = null;
      gestures.cancel();
      showFeedback(
        typeof payload.message === "string" ? payload.message : "Microphone unavailable",
        "error",
      );
    }
  });
  app.whenReady().then(async () => {
    app.setAppUserModelId("com.undertone.desktop");
    await createOverlay();
    await createAudio();
    createTray();
    openSettings();
    windowsHost.onKeyboard((event) => {
      if (event.injected) return;
      if (event.virtualKey === 0x1b && event.eventType === "down") {
        if (gestures.state !== GestureState.idle) gestures.cancel();
        return;
      }
      if (event.virtualKey === 0xa3) {
        if (event.eventType === "down" && !rightControlDown) {
          rightControlDown = true;
          gestures.press();
        } else if (event.eventType === "up" && rightControlDown) {
          rightControlDown = false;
          gestures.release();
        }
        return;
      }
      if (event.eventType === "down") insertionMemory.invalidate();
    });
    windowsHost.onMouse(() => insertionMemory.invalidate());
    await windowsHost.start();
    await initializePipeline();
    tray?.setToolTip(`Undertone · ${config.hotkey}`);
    await windowsHost.startInput();
    if (packagedSmoke) {
      await waitUntil(() => audioReady && settingsReady, 5_000);
      if (tray === null || settingsWindow === null) {
        throw new Error("Tray shell did not initialize");
      }
      settingsWindow.close();
      if (settingsWindow === null || settingsWindow.isDestroyed()) {
        throw new Error("Closing Settings terminated the tray-owned window");
      }
      if (packagedSmokeResult === undefined
        || !isWithin(packagedSmokeResult, app.getPath("temp"))) {
        throw new Error("Packaged smoke result path is invalid");
      }
      await writeFile(packagedSmokeResult, "ok", "utf8");
      await windowsHost.stop();
      app.quit();
    }
  }).catch(async (error: unknown) => {
    console.error("Electron startup failed", error);
    if (packagedSmokeResult !== undefined
      && isWithin(packagedSmokeResult, app.getPath("temp"))) {
      const message = error instanceof Error ? error.message : String(error);
      await writeFile(packagedSmokeResult, `error:${message}`, "utf8").catch(() => undefined);
    }
    app.exit(1);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toByteArray(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Renderer readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function resolveAsset(name: "icon.png" | "icon.ico"): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", name)
    : path.resolve(__dirname, "../../../../assets", name);
}
