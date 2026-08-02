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
import { modelOverride, normalizeConfig, type UndertoneConfig } from "../core/config";
import { DictationJobRunner } from "../core/dictationRunner";
import { GestureState, TapStateMachine } from "../core/gestures";
import { applySettingsPatch, settingsSnapshot } from "../core/settingsModel";
import {
  DictationPipelineQueue,
  SessionHistory,
  type DictationTarget,
} from "../core/pipelineQueue";
import { InsertionMemory, prepareText } from "../core/textPreparation";
import { Transcriber } from "../core/transcriber";
import { ShortcutBinding, ShortcutCapture } from "../core/shortcuts";
import { ConfigStore, type ConfigStoreOptions } from "./configStore";
import { LocalInstaller, type InstallProgress } from "./localInstaller";
import {
  createLocalCleanupRuntime,
  createLocalSttRuntime,
  type LocalServerRuntime,
} from "./localRuntime";
import { FetchHttpClient } from "../platform/http";
import { WindowsHost } from "../platform/windowsHost";
import type {
  LocalEngineKind,
  LocalEngineSnapshot,
  ShortcutSetting,
} from "../shared/settings";

const packagedSmoke = process.env.UNDERTONE_PACKAGE_SMOKE === "1";
const localRuntimeSmoke = process.env.UNDERTONE_LOCAL_RUNTIME_SMOKE === "1";
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
  let configStore: ConfigStore | null = null;
  let settingsUpdateChain: Promise<void> = Promise.resolve();
  let pipeline: DictationPipelineQueue | null = null;
  let localStt: LocalServerRuntime | null = null;
  let localCleanup: LocalServerRuntime | null = null;
  let localInstaller: LocalInstaller | null = null;
  const localInstallState: Record<LocalEngineKind, InstallProgress & { installing: boolean }> = {
    stt: { installing: false, phase: "", fraction: 0 },
    cleanup: { installing: false, phase: "", fraction: 0 },
  };
  let shutdownComplete = false;
  let shutdownPromise: Promise<void> | null = null;
  let pendingTarget: Promise<DictationTarget | null> | null = null;
  let shortcutCapture: {
    collector: ShortcutCapture;
    completed: boolean;
    resolve: (shortcut: string | null) => void;
  } | null = null;
  const insertionMemory = new InsertionMemory();
  const history = new SessionHistory();
  const windowsHost = new WindowsHost(app.isPackaged ? {
    executable: path.join(process.resourcesPath, "native", "Undertone.WinHost.exe"),
  } : {});
  const pttShortcut = new ShortcutBinding(config.hotkey);
  const repasteShortcut = new ShortcutBinding(config.repaste_hotkey, true);
  const toggleShortcut = new ShortcutBinding(config.toggle_hotkey, true);
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

  const configureShortcuts = (): void => {
    try {
      pttShortcut.set(config.hotkey);
    } catch {
      pttShortcut.set("right ctrl");
      showFeedback("The saved push-to-talk shortcut is unsupported; using Right Ctrl", "warning");
    }
    try {
      repasteShortcut.set(config.repaste_hotkey, true);
    } catch {
      repasteShortcut.set("", true);
      showFeedback("The saved re-paste shortcut is unsupported", "warning");
    }
    try {
      toggleShortcut.set(config.toggle_hotkey, true);
    } catch {
      toggleShortcut.set("", true);
      showFeedback("The saved toggle shortcut is unsupported", "warning");
    }
  };

  const repasteLast = (): void => {
    const text = history.latestSuccessText();
    if (text === null) {
      showFeedback("Nothing to re-paste yet", "warning");
      return;
    }
    void pipeline?.enqueueRepaste(text).catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : "Could not re-paste", "error");
    });
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
          if (shortcutCapture !== null) {
            item.checked = paused;
            showFeedback("Finish the shortcut, or press Esc to cancel capture", "warning");
            return;
          }
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
    configStore = new ConfigStore(storeOptions);
    config = await configStore.load();
    configureShortcuts();

    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData === undefined) throw new Error("LOCALAPPDATA is unavailable");
    const localRoot = path.join(localAppData, "Undertone");
    localInstaller = new LocalInstaller(windowsHost, localRoot);
    localStt = createLocalSttRuntime(windowsHost, localRoot, {
      onNotice: (message) => showFeedback(message, "warning"),
    });
    localCleanup = createLocalCleanupRuntime(windowsHost, localRoot, {
      onNotice: (message) => showFeedback(message, "warning"),
    });
    configureLocalResidency();

    const http = new FetchHttpClient();
    const transcriber = new Transcriber(http, localStt);
    const cleanup = new CleanupClient(http, localCleanup);
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
      isLocalSttLoaded: () => localStt?.status(
        modelOverride(config, "stt", "local"),
      ).loaded ?? false,
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

  function configureLocalResidency(): void {
    const idleSeconds = Math.max(0, Number(config.local_idle_minutes) || 0) * 60;
    localStt?.setIdleTimeout(idleSeconds);
    localCleanup?.setIdleTimeout(idleSeconds);
    if (!config.local_loaded) return;
    if (config.provider === "local") {
      localStt?.loadAsync(modelOverride(config, "stt", "local"));
    }
    if (config.ai_cleanup && config.cleanup_provider === "local") {
      localCleanup?.loadAsync(modelOverride(config, "cleanup", "local"));
    }
  }

  async function shutdownServices(): Promise<void> {
    await Promise.all([
      localStt?.shutdown() ?? Promise.resolve(),
      localCleanup?.shutdown() ?? Promise.resolve(),
    ]);
    await windowsHost.stop();
  }

  function currentSettingsSnapshot(): ReturnType<typeof settingsSnapshot> {
    const engineSnapshot = (
      kind: LocalEngineKind,
      runtime: LocalServerRuntime | null,
      model: string,
    ): LocalEngineSnapshot => {
      const install = localInstallState[kind];
      const installBytes = localInstaller?.installSize(kind) ?? 0;
      if (runtime === null) {
        return {
          installed: false,
          loaded: false,
          loading: false,
          build: null,
          installing: install.installing,
          installPhase: install.phase,
          installFraction: install.fraction,
          installBytes,
        };
      }
      try {
        const status = runtime.status(model);
        return {
          installed: status.installed,
          loaded: status.loaded,
          loading: status.loading,
          build: status.build,
          installing: install.installing,
          installPhase: install.phase,
          installFraction: install.fraction,
          installBytes,
        };
      } catch {
        return {
          installed: false,
          loaded: false,
          loading: false,
          build: null,
          installing: install.installing,
          installPhase: install.phase,
          installFraction: install.fraction,
          installBytes,
        };
      }
    };
    return settingsSnapshot(config, app.getVersion(), electronPreview, {
      stt: engineSnapshot("stt", localStt, modelOverride(config, "stt", "local")),
      cleanup: engineSnapshot(
        "cleanup",
        localCleanup,
        modelOverride(config, "cleanup", "local"),
      ),
    });
  }

  async function persistSettingsPatch(value: unknown): Promise<ReturnType<typeof settingsSnapshot>> {
    let result = currentSettingsSnapshot();
    const operation = settingsUpdateChain.then(async () => {
      const store = configStore;
      if (store === null) throw new Error("Settings store is not ready");
      const previousHotkey = config.hotkey;
      const previousRepaste = config.repaste_hotkey;
      const previousToggle = config.toggle_hotkey;
      const next = applySettingsPatch(config, value);
      await store.save(next);
      config = next;
      if (config.hotkey !== previousHotkey
        || config.repaste_hotkey !== previousRepaste
        || config.toggle_hotkey !== previousToggle) {
        gestures.cancel();
        configureShortcuts();
      }
      configureLocalResidency();
      tray?.setToolTip(`Undertone · ${config.hotkey}`);
      result = currentSettingsSnapshot();
    });
    settingsUpdateChain = operation.catch(() => undefined);
    await operation;
    return result;
  }

  async function captureShortcut(field: ShortcutSetting): Promise<ReturnType<typeof settingsSnapshot>> {
    if (shortcutCapture !== null) throw new Error("A shortcut is already being captured");
    gestures.cancel();
    const captured = new Promise<string | null>((resolve) => {
      shortcutCapture = {
        collector: new ShortcutCapture(),
        completed: false,
        resolve,
      };
    });
    try {
      await windowsHost.startShortcutCapture();
      const shortcut = await captured;
      if (shortcut === null) return currentSettingsSnapshot();
      return await persistSettingsPatch({ [field]: shortcut });
    } finally {
      shortcutCapture = null;
      await windowsHost.stopShortcutCapture().catch(() => undefined);
      if (paused) await windowsHost.stopInput().catch(() => undefined);
    }
  }

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
          if (shortcutCapture !== null) {
            showFeedback("Finish the shortcut, or press Esc to cancel capture", "warning");
            return;
          }
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
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    shutdownPromise ??= shutdownServices()
      .catch((error: unknown) => console.error("Electron shutdown failed", error))
      .finally(() => {
        shutdownComplete = true;
        app.quit();
      });
  });
  ipcMain.handle("settings:get", (event) => {
    if (event.sender !== settingsWindow?.webContents) {
      throw new Error("Settings request came from an unauthorized renderer");
    }
    return currentSettingsSnapshot();
  });
  ipcMain.handle("settings:update", async (event, value: unknown) => {
    if (event.sender !== settingsWindow?.webContents) {
      throw new Error("Settings update came from an unauthorized renderer");
    }
    return await persistSettingsPatch(value);
  });
  ipcMain.handle("shortcut:capture", async (event, value: unknown) => {
    if (event.sender !== settingsWindow?.webContents) {
      throw new Error("Shortcut capture came from an unauthorized renderer");
    }
    if (!isRecord(value) || (value.field !== "hotkey" && value.field !== "repasteHotkey")) {
      throw new Error("Invalid shortcut capture target");
    }
    return await captureShortcut(value.field);
  });
  ipcMain.handle("local:action", async (event, value: unknown) => {
    if (event.sender !== settingsWindow?.webContents) {
      throw new Error("Local action came from an unauthorized renderer");
    }
    if (!isRecord(value)
      || (value.kind !== "stt" && value.kind !== "cleanup")
      || (value.action !== "install"
        && value.action !== "load"
        && value.action !== "eject")) {
      throw new Error("Invalid local engine action");
    }
    const kind = value.kind;
    const runtime = value.kind === "stt" ? localStt : localCleanup;
    if (runtime === null) throw new Error("Local engine service is not ready");
    const model = modelOverride(config, kind, "local");
    if (value.action === "install") {
      if (localInstaller === null) throw new Error("Local installer is not ready");
      localInstallState[kind] = { installing: true, phase: "Preparing", fraction: 0 };
      try {
        await localInstaller.install(kind, (progress) => {
          localInstallState[kind] = { installing: true, ...progress };
        });
      } finally {
        localInstallState[kind] = { installing: false, phase: "", fraction: 0 };
      }
    } else if (value.action === "load") {
      await runtime.ensureReady(model);
    } else {
      await runtime.eject();
    }
    return currentSettingsSnapshot();
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
    windowsHost.onKeyboard((event) => {
      if (event.injected) return;
      const activeCapture = shortcutCapture;
      if (activeCapture !== null) {
        if (activeCapture.completed) return;
        const result = activeCapture.collector.update(event);
        if (result.done) {
          activeCapture.completed = true;
          activeCapture.resolve(result.shortcut);
        }
        return;
      }
      if (event.virtualKey === 0x1b && event.eventType === "down") {
        if (gestures.state !== GestureState.idle) gestures.cancel();
        return;
      }
      const ptt = pttShortcut.update(event);
      const repaste = repasteShortcut.update(event);
      const toggle = toggleShortcut.update(event);
      if (ptt.pressed) gestures.press();
      if (ptt.released) gestures.release();
      if (repaste.pressed) repasteLast();
      if (toggle.pressed) gestures.toggle();
      if (event.eventType === "down"
        && !ptt.keyBelongsToShortcut
        && !repaste.keyBelongsToShortcut
        && !toggle.keyBelongsToShortcut) {
        insertionMemory.invalidate();
      }
    });
    windowsHost.onMouse(() => insertionMemory.invalidate());
    await windowsHost.start();
    await initializePipeline();
    createTray();
    tray?.setToolTip(`Undertone · ${config.hotkey}`);
    openSettings();
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
      if (localRuntimeSmoke) {
        if (localStt === null || localCleanup === null) {
          throw new Error("Local runtimes did not initialize");
        }
        await localStt.ensureReady();
        await localStt.eject();
        await localCleanup.ensureReady();
        await localCleanup.eject();
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
