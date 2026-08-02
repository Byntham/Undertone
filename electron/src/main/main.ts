import { app, BrowserWindow, ipcMain, screen, session } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { GestureState, TapStateMachine } from "../core/gestures";
import { WindowsHost } from "../platform/windowsHost";

const packagedSmoke = process.env.UNDERTONE_PACKAGE_SMOKE === "1";
const packagedSmokeResult = process.env.UNDERTONE_PACKAGE_SMOKE_RESULT;
if (packagedSmoke) {
  const profilePath = process.env.UNDERTONE_PACKAGE_SMOKE_PROFILE;
  if (profilePath === undefined || !isWithin(profilePath, app.getPath("temp"))) {
    throw new Error("Packaged smoke profile path is invalid");
  }
  app.setPath("userData", profilePath);
} else if (app.getVersion().includes("-electron.")) {
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
  let audioReady = false;
  let settingsReady = false;
  const windowsHost = new WindowsHost(app.isPackaged ? {
    executable: path.join(process.resourcesPath, "native", "Undertone.WinHost.exe"),
  } : {});
  let rightControlDown = false;

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
      audioWindow?.webContents.send("audio:command", { type: "stop" });
      sendOverlay("message", "Finalizing audio…");
    },
    onDiscard: () => {
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

  const openSettings = (): void => {
    if (settingsWindow === null) {
      settingsWindow = new BrowserWindow({
        width: 960,
        height: 720,
        show: false,
        backgroundColor: "#282c34",
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
      settingsWindow.on("closed", () => {
        settingsWindow = null;
        app.quit();
      });
    } else {
      settingsWindow.show();
      settingsWindow.focus();
    }
  };

  app.on("second-instance", openSettings);
  app.on("window-all-closed", () => {
    // The spike has no tray yet, so closing its only window must end it.
    app.quit();
  });
  app.on("before-quit", () => {
    void windowsHost.stop();
  });
  ipcMain.on("audio:event", (event, payload: unknown) => {
    if (event.sender !== audioWindow?.webContents || !isRecord(payload)) return;
    if (payload.type === "ready") {
      audioReady = true;
    } else if (payload.type === "stopped") {
      const wav = payload.wav;
      const byteLength = wav instanceof ArrayBuffer
        ? wav.byteLength
        : ArrayBuffer.isView(wav) ? wav.byteLength : 0;
      sendOverlay("message", `Audio captured · ${Math.round(byteLength / 1024)} KB`);
      setTimeout(() => sendOverlay("hidden"), 1_500);
    } else if (payload.type === "error") {
      gestures.cancel();
      sendOverlay(
        "message",
        typeof payload.message === "string" ? payload.message : "Microphone unavailable",
      );
      setTimeout(() => sendOverlay("hidden"), 3_000);
    }
  });
  app.whenReady().then(async () => {
    await createOverlay();
    await createAudio();
    openSettings();
    windowsHost.onKeyboard((event) => {
      if (event.injected) return;
      if (event.virtualKey === 0x1b && event.eventType === "down") {
        if (gestures.state !== GestureState.idle) gestures.cancel();
        return;
      }
      if (event.virtualKey !== 0xa3) return;
      if (event.eventType === "down" && !rightControlDown) {
        rightControlDown = true;
        gestures.press();
      } else if (event.eventType === "up" && rightControlDown) {
        rightControlDown = false;
        gestures.release();
      }
    });
    await windowsHost.start();
    await windowsHost.startInput();
    if (packagedSmoke) {
      await waitUntil(() => audioReady && settingsReady, 5_000);
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
