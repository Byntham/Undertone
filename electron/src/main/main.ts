import { app, BrowserWindow, screen } from "electron";
import path from "node:path";

import { GestureState, TapStateMachine } from "../core/gestures";
import { WindowsHost } from "../platform/windowsHost";

const gotLock = app.requestSingleInstanceLock();

if (!gotLock) {
  app.quit();
} else {
  let settingsWindow: BrowserWindow | null = null;
  let overlayWindow: BrowserWindow | null = null;
  const windowsHost = new WindowsHost();
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
      sendOverlay("recording");
      return true;
    },
    onFinish: () => {
      sendOverlay("message", "Input path verified");
      setTimeout(() => sendOverlay("hidden"), 1_200);
    },
    onDiscard: () => sendOverlay("hidden"),
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
      settingsWindow.once("ready-to-show", () => settingsWindow?.show());
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
  app.whenReady().then(async () => {
    await createOverlay();
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
  }).catch((error: unknown) => {
    console.error("Electron startup failed", error);
    app.quit();
  });
}
