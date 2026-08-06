import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import electronUpdater = require("electron-updater");
import { existsSync } from "node:fs";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { CleanupClient } from "../core/cleanup";
import { encodePcm16Wav } from "../core/audio";
import { ClipboardPaster } from "../core/clipboardPaster";
import {
  modelOverride,
  normalizeConfig,
  providerKey,
  type UndertoneConfig,
} from "../core/config";
import { DictationJobRunner } from "../core/dictationRunner";
import { GestureState, TapStateMachine } from "../core/gestures";
import { OverlayController } from "../core/overlayController";
import { applySettingsPatch, settingsSnapshot } from "../core/settingsModel";
import {
  DictationPipelineQueue,
  SessionHistory,
  type DictationTarget,
} from "../core/pipelineQueue";
import { InsertionMemory, prepareText } from "../core/textPreparation";
import { Transcriber } from "../core/transcriber";
import { ShortcutBinding, ShortcutCapture } from "../core/shortcuts";
import { ConfigStore } from "./configStore";
import { AutostartManager } from "./autostart";
import { AppUpdateService } from "./appUpdater";
import {
  DeveloperController,
  worktreeDisplayName,
  type DeveloperRepositoryDiscovery,
  type DeveloperSnapshot,
  type DeveloperWorktree,
} from "./developerController";
import { installFileLog } from "./fileLog";
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
  HistoryAction,
  ShortcutSetting,
  SystemAction,
} from "../shared/settings";
import type { OverlayState, OverlayTone } from "../shared/overlay";

const DEV_QUIT_ARGUMENT = "--undertone-dev-quit";
const OPEN_SETTINGS_ARGUMENT = "--undertone-open-settings";
const packagedSmoke = process.env.UNDERTONE_PACKAGE_SMOKE === "1";
const localRuntimeSmoke = process.env.UNDERTONE_LOCAL_RUNTIME_SMOKE === "1";
const packagedSmokeResult = process.env.UNDERTONE_PACKAGE_SMOKE_RESULT;
const managedDev = process.env.UNDERTONE_MANAGED_DEV === "1";
const electronPreview = !app.isPackaged || process.env.UNDERTONE_ELECTRON_PREVIEW === "1";
const devBranch = electronPreview ? process.env.UNDERTONE_DEV_BRANCH?.trim() : undefined;
const devQuitRequest = electronPreview && process.argv.includes(DEV_QUIT_ARGUMENT);
const isolatedProfile = electronPreview || packagedSmoke;
if (packagedSmoke) {
  const profilePath = process.env.UNDERTONE_PACKAGE_SMOKE_PROFILE;
  if (profilePath === undefined || !isWithin(profilePath, app.getPath("temp"))) {
    throw new Error("Packaged smoke profile path is invalid");
  }
  app.setPath("userData", profilePath);
} else if (managedDev) {
  const previewRoot = process.env.LOCALAPPDATA ?? app.getPath("appData");
  app.setPath("userData", path.join(previewRoot, "Undertone", "ManagedDev"));
} else if (electronPreview) {
  const previewRoot = process.env.LOCALAPPDATA ?? app.getPath("appData");
  app.setPath("userData", path.join(previewRoot, "Undertone", "ElectronPreview"));
}
const gotLock = app.requestSingleInstanceLock();
const fileLog = installFileLog(path.join(app.getPath("userData"), "app.log"));

if (!gotLock || devQuitRequest) {
  app.quit();
} else {
  let settingsWindow: BrowserWindow | null = null;
  let overlayWindow: BrowserWindow | null = null;
  let audioWindow: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let quitting = false;
  let paused = false;
  let audioReady = false;
  let microphones: string[] = [];
  let settingsReady = false;
  let config: UndertoneConfig = normalizeConfig(undefined);
  let configStore: ConfigStore | null = null;
  let settingsUpdateChain: Promise<void> = Promise.resolve();
  let startWithWindows = false;
  let pipeline: DictationPipelineQueue | null = null;
  let localStt: LocalServerRuntime | null = null;
  let localCleanup: LocalServerRuntime | null = null;
  let localInstaller: LocalInstaller | null = null;
  let appUpdateService: AppUpdateService | null = null;
  let developerController: DeveloperController | null = null;
  let discoveredDeveloperRepository: DeveloperRepositoryDiscovery | null = null;
  let developerWorktrees: DeveloperWorktree[] = [];
  let developerSnapshot: DeveloperSnapshot = {
    phase: "production",
    repositoryRoot: null,
    activeWorktree: null,
    message: "Production active",
  };
  let productionPausedForDev = false;
  let transcriberClient: Transcriber | null = null;
  let cleanupClient: CleanupClient | null = null;
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
  const autostart = new AutostartManager(process.execPath);
  const windowsHost = new WindowsHost(app.isPackaged ? {
    executable: path.join(process.resourcesPath, "native", "Undertone.WinHost.exe"),
  } : {});
  const pttShortcut = new ShortcutBinding(config.hotkey);
  const repasteShortcut = new ShortcutBinding(config.repaste_hotkey, true);
  let overlayDisplayId: number | undefined;
  let pendingOverlayRevision: number | undefined;
  let normalTrayImage: Electron.NativeImage | null = null;
  let recordingTrayImage: Electron.NativeImage | null = null;
  let microphoneTest: {
    requestId: number;
    resolve: (peak: number) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let nextMicrophoneTestId = 1;

  const positionOverlay = (overlay: BrowserWindow): void => {
    if (overlayDisplayId === undefined) {
      overlayDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
    }
    const display = screen.getAllDisplays().find(({ id }) => id === overlayDisplayId)
      ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = display.workArea;
    const { width, height } = overlay.getBounds();
    overlay.setPosition(
      bounds.x + Math.round((bounds.width - width) / 2),
      bounds.y + bounds.height - height - 24,
      false,
    );
  };

  const renderOverlay = (state: OverlayState): void => {
    const overlay = overlayWindow;
    if (overlay === null || overlay.isDestroyed()) return;
    if (state.state === "hidden") {
      // Keep the click-through native window presented. Windows fades a newly
      // shown layered window and shifts its raster by a pixel during that fade.
      overlay.webContents.send("overlay:state", state);
      return;
    }
    positionOverlay(overlay);
    overlay.setAlwaysOnTop(true, "screen-saver");
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.moveTop();
    overlay.webContents.send("overlay:state", state);
  };

  const overlayController = new OverlayController(renderOverlay);

  const anchorOverlayToCursor = (): void => {
    overlayDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  };

  const sendOverlayLevel = (rms: number): void => {
    const overlay = overlayWindow;
    const state = overlayController.current().state;
    if (overlay === null || overlay.isDestroyed()
      || (state !== "recording" && state !== "locked")) return;
    overlay.webContents.send("overlay:level", rms);
  };

  const showFeedback = (
    text: string,
    kind: OverlayTone = "normal",
  ): void => {
    const barOnlySignal = (text.startsWith("Too short") && kind === "warning")
      || (text === "No speech detected" && kind === "error");
    const duration = barOnlySignal
      ? 1_000
        : kind === "normal"
          ? 1_200
          : kind === "warning"
            ? 2_200
            : 2_600;
    if (barOnlySignal) {
      overlayController.signal(text, kind, duration);
    } else {
      overlayController.feedback(text, kind, duration);
    }
  };

  const playCue = (name: "start" | "stop" | "lock" | "cancel"): void => {
    if (!config.sound_cues) return;
    audioWindow?.webContents.send("audio:command", { type: "cue", name });
  };

  const setTrayRecording = (recording: boolean): void => {
    const image = recording ? recordingTrayImage : normalTrayImage;
    if (image !== null) tray?.setImage(image);
  };

  const updateTrayTooltip = (): void => {
    const activeDevBranch = developerSnapshot.activeWorktree?.branch;
    const tooltip = activeDevBranch !== undefined
      ? `Undertone — Dev: ${activeDevBranch}`
      : paused
      ? "Undertone — paused"
      : `Undertone — hold ${config.hotkey} to dictate`;
    tray?.setToolTip(devBranch === undefined || devBranch.length === 0
      ? tooltip
      : `${tooltip}\nDev: ${devBranch}`);
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
      if (microphoneTest !== null) {
        showFeedback("Finish the microphone test before dictating", "warning");
        return false;
      }
      if (!audioReady || audioWindow === null) {
        showFeedback("Audio service is not ready", "error");
        return false;
      }
      anchorOverlayToCursor();
      audioWindow.webContents.send("audio:command", {
        type: "start",
        deviceName: config.input_device,
      });
      playCue("start");
      setTrayRecording(true);
      overlayController.recording();
      return true;
    },
    onFinish: () => {
      pendingTarget = windowsHost.getForeground().then((foreground) => ({
        window: foreground.window,
        executable: foreground.executable,
      })).catch(() => null);
      audioWindow?.webContents.send("audio:command", { type: "stop" });
      playCue("stop");
      setTrayRecording(false);
      pendingOverlayRevision = overlayController.transcribing();
    },
    onDiscard: (reason) => {
      pendingTarget = null;
      pendingOverlayRevision = undefined;
      audioWindow?.webContents.send("audio:command", { type: "cancel" });
      playCue("cancel");
      setTrayRecording(false);
      if (reason === "short-tap") {
        showFeedback("Too short — hold the key while you speak", "warning");
      } else {
        overlayController.hide();
      }
    },
    onLock: () => {
      playCue("lock");
      overlayController.locked();
    },
  });

  const createOverlay = async (): Promise<void> => {
    const overlay = new BrowserWindow({
      width: 420,
      height: 52,
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
    overlayWindow = overlay;
    overlay.setIgnoreMouseEvents(true);
    overlay.setAlwaysOnTop(true, "screen-saver");
    overlay.webContents.on("did-finish-load", () => {
      renderOverlay(overlayController.current());
    });
    overlay.webContents.on("render-process-gone", (_event, details) => {
      console.error("Overlay renderer exited", details);
      if (!quitting && !overlay.isDestroyed()) overlay.reload();
    });
    await overlay.loadFile(
      path.join(__dirname, "../../renderer/overlay/index.html"),
    );
    positionOverlay(overlay);
    overlay.showInactive();
    overlay.moveTop();
    const repositionOverlay = (): void => {
      overlayDisplayId = undefined;
      if (overlayController.current().state === "hidden") {
        positionOverlay(overlay);
      } else {
        renderOverlay(overlayController.current());
      }
    };
    screen.on("display-metrics-changed", repositionOverlay);
    screen.on("display-removed", repositionOverlay);
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

  const refreshDeveloperWorktrees = async (): Promise<void> => {
    const controller = developerController;
    if (controller === null) return;
    try {
      if (controller.snapshot().repositoryRoot === null) {
        discoveredDeveloperRepository = await controller.discoverT3Repository(
          path.join(app.getPath("home"), ".t3", "worktrees", "Undertone"),
        );
        developerWorktrees = discoveredDeveloperRepository?.worktrees ?? [];
      } else {
        discoveredDeveloperRepository = null;
        developerWorktrees = await controller.worktrees();
      }
    } catch (error) {
      discoveredDeveloperRepository = null;
      developerWorktrees = [];
      console.warn("Could not discover Undertone worktrees", error);
    }
    rebuildTrayMenu();
  };

  const runDeveloperAction = async (
    action: () => Promise<void>,
    successMessage: string,
  ): Promise<void> => {
    try {
      await action();
      showFeedback(successMessage, "normal");
    } catch (error) {
      showFeedback(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const confirmDeveloperAccess = async (): Promise<boolean> => {
    const confirmation = await dialog.showMessageBox({
      type: "warning",
      title: "Enable Undertone development controls?",
      message: "Development builds run local worktree code with your Windows user permissions.",
      detail: "Enable this only for an Undertone repository that you trust.",
      buttons: ["Cancel", "Enable development"],
      defaultId: 0,
      cancelId: 0,
    });
    return confirmation.response === 1;
  };

  const chooseDeveloperRepository = async (): Promise<void> => {
    const controller = developerController;
    if (controller === null) return;
    if (controller.snapshot().repositoryRoot === null && !await confirmDeveloperAccess()) return;
    const result = await dialog.showOpenDialog({
      title: "Choose the main Undertone repository folder",
      properties: ["openDirectory"],
    });
    const selected = result.filePaths[0];
    if (result.canceled || selected === undefined) return;
    await runDeveloperAction(async () => {
      await controller.setRepository(selected);
      await refreshDeveloperWorktrees();
    }, "Development repository configured");
  };

  const activateDeveloperWorktree = async (worktree: DeveloperWorktree): Promise<void> => {
    const controller = developerController;
    if (controller === null) return;
    let repositoryToConfigure: string | null = null;
    if (controller.snapshot().repositoryRoot === null) {
      const discovery = discoveredDeveloperRepository;
      if (discovery === null || !await confirmDeveloperAccess()) return;
      repositoryToConfigure = discovery.repositoryRoot;
    }
    const displayName = worktreeDisplayName(worktree.branch);
    showFeedback(`Building ${displayName}`, "normal");
    await runDeveloperAction(
      async () => {
        if (repositoryToConfigure !== null) {
          await controller.setRepository(repositoryToConfigure);
          await refreshDeveloperWorktrees();
        }
        await controller.activate(worktree);
      },
      `${displayName} is active`,
    );
  };

  const developerMenu = (): MenuItemConstructorOptions[] => {
    const controller = developerController;
    if (controller === null) return [];
    const activeRoot = developerSnapshot.activeWorktree?.root;
    const items: MenuItemConstructorOptions[] = [
      {
        label: "Production",
        type: "radio",
        checked: activeRoot === undefined,
        click: () => {
          void runDeveloperAction(
            async () => await controller.returnToProduction(),
            "Production Undertone restored",
          );
        },
      },
    ];
    if (developerSnapshot.repositoryRoot !== null || discoveredDeveloperRepository !== null) {
      if (developerSnapshot.repositoryRoot === null) {
        items.push(
          { type: "separator" },
          { label: "Available worktrees", enabled: false },
        );
      }
      for (const worktree of developerWorktrees) {
        const displayBranch = worktreeDisplayName(worktree.branch);
        items.push({
          label: worktree.compatible
            ? displayBranch
            : `${displayBranch} — ${worktree.compatibilityError ?? "incompatible"}`,
          type: "radio",
          checked: activeRoot !== undefined
            && path.resolve(activeRoot).toLowerCase() === path.resolve(worktree.root).toLowerCase(),
          enabled: worktree.compatible && developerSnapshot.phase !== "building",
          click: () => { void activateDeveloperWorktree(worktree); },
        });
      }
      items.push({ type: "separator" });
      if (developerSnapshot.repositoryRoot !== null) {
        items.push({
          label: "Rebuild active worktree",
          enabled: developerSnapshot.activeWorktree !== null
            && developerSnapshot.phase !== "building",
          click: () => {
            showFeedback("Building active worktree", "normal");
            void runDeveloperAction(
              async () => await controller.rebuildActive(),
              "Development build updated",
            );
          },
        });
      }
      items.push({
        label: "Refresh worktrees",
        click: () => { void refreshDeveloperWorktrees(); },
      });
    }
    items.push(
      { type: "separator" },
      {
        label: developerSnapshot.repositoryRoot === null
          ? "Choose repository folder…"
          : "Choose another repository…",
        click: () => { void chooseDeveloperRepository(); },
      },
    );
    if (developerSnapshot.repositoryRoot !== null) {
      items.push({
        label: "Disable development",
        click: () => {
          void runDeveloperAction(async () => {
            await controller.disable();
            await refreshDeveloperWorktrees();
          }, "Developer mode disabled");
        },
      });
    }
    return items;
  };

  const rebuildTrayMenu = (): void => {
    if (tray === null) return;
    const devActive = developerSnapshot.activeWorktree !== null;
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Open Settings",
        click: () => {
          if (!developerController?.openDevSettings()) openSettings();
        },
      },
      { type: "separator" },
      {
        label: "Pause dictation",
        type: "checkbox",
        checked: paused,
        enabled: !devActive,
        click: (item) => {
          if (shortcutCapture !== null) {
            item.checked = paused;
            showFeedback("Finish the shortcut, or press Esc to cancel capture", "warning");
            return;
          }
          paused = item.checked;
          if (paused) gestures.cancel();
          void (paused ? windowsHost.stopInput() : windowsHost.startInput())
            .then(() => {
              updateTrayTooltip();
              showFeedback(
                paused ? "Dictation paused" : "Dictation resumed",
                paused ? "warning" : "normal",
              );
            })
            .catch((error: unknown) => {
              item.checked = !paused;
              paused = item.checked;
              updateTrayTooltip();
              showFeedback(
                error instanceof Error ? error.message : "Could not change dictation state",
                "error",
              );
            });
        },
      },
      { type: "separator" },
      {
        label: "Development",
        submenu: developerMenu(),
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ];
    tray.setContextMenu(Menu.buildFromTemplate(template));
    updateTrayTooltip();
  };

  const initializeDeveloperController = async (): Promise<void> => {
    if (managedDev || packagedSmoke) return;
    const localAppData = process.env.LOCALAPPDATA ?? app.getPath("appData");
    const controller = new DeveloperController({
      configPath: path.join(app.getPath("appData"), "Undertone", "developer.json"),
      buildRoot: path.join(localAppData, "Undertone", "DevBuilds"),
      processHost: windowsHost,
      onBeforeDevStart: async () => {
        if (productionPausedForDev) return;
        const developmentConfig = path.join(localAppData, "Undertone", "ManagedDev", "config.json");
        const productionConfig = path.join(app.getPath("appData"), "Undertone", "config.json");
        if (!existsSync(developmentConfig) && existsSync(productionConfig)) {
          await mkdir(path.dirname(developmentConfig), { recursive: true });
          await copyFile(productionConfig, developmentConfig);
        }
        productionPausedForDev = true;
        try {
          gestures.cancel();
          await windowsHost.stopInput();
          await Promise.all([
            localStt?.eject() ?? Promise.resolve(),
            localCleanup?.eject() ?? Promise.resolve(),
          ]);
        } catch (error) {
          productionPausedForDev = false;
          if (!paused && !quitting) await windowsHost.startInput().catch(() => undefined);
          throw error;
        }
      },
      onDevUnavailable: async () => {
        if (!productionPausedForDev) return;
        productionPausedForDev = false;
        if (!paused && !quitting) {
          await windowsHost.startInput();
          configureLocalResidency();
        }
      },
      onStateChange: (snapshot) => {
        developerSnapshot = snapshot;
        rebuildTrayMenu();
      },
    });
    developerController = controller;
    await controller.load();
    const environmentRepository = process.env.UNDERTONE_DEV_REPOSITORY;
    if (environmentRepository !== undefined && environmentRepository.trim().length > 0) {
      await controller.setRepository(environmentRepository);
    }
    await refreshDeveloperWorktrees();
  };

  const createTray = (): void => {
    normalTrayImage = nativeImage.createFromPath(resolveAsset("icon.png"));
    recordingTrayImage = nativeImage.createFromDataURL(recordingTraySvg());
    tray = new Tray(normalTrayImage);
    rebuildTrayMenu();
    tray.on("double-click", () => {
      if (!developerController?.openDevSettings()) openSettings();
    });
  };

  const initializePipeline = async (): Promise<void> => {
    const configPath = isolatedProfile
      ? path.join(app.getPath("userData"), "config.json")
      : path.join(app.getPath("appData"), "Undertone", "config.json");
    configStore = new ConfigStore({ configPath, cipher: windowsHost });
    config = await configStore.load();
    if (!electronPreview && !packagedSmoke) {
      try {
        await autostart.reconcile();
        startWithWindows = await autostart.isEnabled();
      } catch (error) {
        console.warn("Autostart reconciliation failed", error);
      }
    }
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
    transcriberClient = new Transcriber(http, localStt);
    cleanupClient = new CleanupClient(http, localCleanup);
    const paster = new ClipboardPaster(
      {
        readText: () => clipboard.readText(),
        writeText: (value) => clipboard.writeText(value),
      },
      windowsHost,
    );
    const runner = new DictationJobRunner({
      transcriber: transcriberClient,
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
          cleanup: async (request) => await cleanupClient!.cleanup(request),
        });
      },
      restoreTarget: async (target) => {
        if (target === null || target.window === "" || target.window === "0") return true;
        const foreground = await windowsHost.getForeground();
        return foreground.window === target.window
          || await windowsHost.focusWindow(target.window);
      },
      getForegroundWindow: async () => (await windowsHost.getForeground()).window,
      paster,
      history,
      insertionMemory,
      feedback: {
        message: showFeedback,
        dismiss: () => { overlayController.confirm(); },
      },
    });
    pipeline = new DictationPipelineQueue(
      () => config,
      {
        dictate: async (wav, target, snapshot, overlayRevision) => {
          await runner.run(wav, target, snapshot, {
            message: showFeedback,
            dismiss: () => {
              overlayController.confirm("Text pasted", 1_000, overlayRevision);
            },
          });
        },
        repaste: async (text, snapshot) => {
          const generation = insertionMemory.captureGeneration();
          await paster.paste(text, Boolean(snapshot.restore_clipboard));
          history.registerSuccess(text, null);
          const foreground = await windowsHost.getForeground();
          insertionMemory.registerPaste(foreground.window, text, generation);
          overlayController.confirm();
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
    overlayController.dispose();
    if (microphoneTest !== null) {
      clearTimeout(microphoneTest.timer);
      microphoneTest.reject(new Error("Undertone is shutting down"));
      microphoneTest = null;
    }
    await Promise.all([
      developerController?.dispose() ?? Promise.resolve(),
      localStt?.shutdown() ?? Promise.resolve(),
      localCleanup?.shutdown() ?? Promise.resolve(),
    ]);
    await windowsHost.stop();
    await fileLog.flush();
  }

  async function finishShutdown(): Promise<void> {
    shutdownPromise ??= shutdownServices()
      .catch((error: unknown) => console.error("Electron shutdown failed", error));
    await shutdownPromise;
    shutdownComplete = true;
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
    }, microphones, startWithWindows);
  }

  async function persistSettingsPatch(value: unknown): Promise<ReturnType<typeof settingsSnapshot>> {
    let result = currentSettingsSnapshot();
    const operation = settingsUpdateChain.then(async () => {
      const store = configStore;
      if (store === null) throw new Error("Settings store is not ready");
      const previousHotkey = config.hotkey;
      const previousRepaste = config.repaste_hotkey;
      if (isRecord(value) && value.startWithWindows !== undefined) {
        if (typeof value.startWithWindows !== "boolean") {
          throw new Error("startWithWindows must be boolean");
        }
        if (!electronPreview) {
          await autostart.setEnabled(value.startWithWindows);
        }
        startWithWindows = value.startWithWindows;
      }
      const next = applySettingsPatch(config, value);
      await store.save(next);
      config = next;
      if (config.hotkey !== previousHotkey || config.repaste_hotkey !== previousRepaste) {
        gestures.cancel();
        configureShortcuts();
      }
      configureLocalResidency();
      updateTrayTooltip();
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
        minWidth: 800,
        minHeight: 600,
        useContentSize: true,
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

  app.on("second-instance", (_event, argv) => {
    if (electronPreview && argv.includes(DEV_QUIT_ARGUMENT)) {
      app.quit();
      return;
    }
    if (argv.includes(OPEN_SETTINGS_ARGUMENT)) {
      openSettings();
      return;
    }
    openSettings();
  });
  app.on("before-quit", (event) => {
    quitting = true;
    if (shutdownComplete) return;
    event.preventDefault();
    void finishShutdown().finally(() => app.quit());
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
  ipcMain.handle("history:get", (event) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    return history.snapshot().map((entry) => entry.ok ? {
      id: entry.id,
      ok: true,
      text: entry.text,
      raw: entry.raw,
      error: null,
      timestamp: entry.timestamp,
      retryable: false,
    } : {
      id: entry.id,
      ok: false,
      text: "",
      raw: null,
      error: entry.error,
      timestamp: entry.timestamp,
      retryable: entry.wav !== undefined,
    });
  });
  ipcMain.handle("history:action", async (event, value: unknown) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (!isRecord(value)
      || typeof value.id !== "number"
      || !Number.isInteger(value.id)
      || !isHistoryAction(value.action)) {
      throw new Error("Invalid history action");
    }
    const entry = history.snapshot().find((candidate) => candidate.id === value.id);
    if (entry === undefined) throw new Error("That history entry is no longer available");
    const activePipeline = pipeline;
    if (activePipeline === null && value.action !== "copy") {
      throw new Error("Dictation pipeline is not ready");
    }
    if (value.action === "copy") {
      if (!entry.ok) throw new Error("Only successful dictations can be copied");
      clipboard.writeText(entry.text);
      return;
    }
    settingsWindow?.minimize();
    await delay(600);
    if (value.action === "repaste") {
      if (!entry.ok) throw new Error("Only successful dictations can be re-pasted");
      await activePipeline!.enqueueRepaste(entry.text);
      return;
    }
    const wav = history.consumeRetry(entry.id);
    if (wav === null) throw new Error("Retry audio is no longer available");
    await activePipeline!.enqueueRetry(wav);
  });
  ipcMain.handle("system:action", async (event, value: unknown) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (!isRecord(value) || !isSystemAction(value.action)) {
      throw new Error("Invalid system action");
    }
    const settingsRoot = path.join(app.getPath("appData"), "Undertone");
    const target = value.action === "openLog"
      ? path.join(settingsRoot, "app.log")
      : settingsRoot;
    const result = await shell.openPath(target);
    if (result.length > 0 && value.action === "openLog") {
      const fallback = await shell.openPath(settingsRoot);
      if (fallback.length > 0) throw new Error(fallback);
    } else if (result.length > 0) {
      throw new Error(result);
    }
  });
  ipcMain.handle("provider:test", async (event, value: unknown) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (!isRecord(value) || (value.kind !== "stt" && value.kind !== "cleanup")) {
      throw new Error("Invalid provider test");
    }
    if (value.kind === "stt") {
      const client = transcriberClient;
      if (client === null) throw new Error("Transcription service is not ready");
      const provider = config.provider;
      await client.transcribe({
        wav: new Uint8Array(encodePcm16Wav(new Float32Array(8_000), 16_000)),
        apiKey: providerKey(config, provider),
        language: config.language,
        vocabulary: [],
        provider,
        model: modelOverride(config, "stt", provider),
      });
      return `Transcription works (${providerName(provider)}).`;
    }
    const client = cleanupClient;
    if (client === null) throw new Error("Cleanup service is not ready");
    const provider = config.cleanup_provider;
    const model = modelOverride(config, "cleanup", provider);
    if (provider === "local") await localCleanup?.ensureReady(model);
    const cleaned = await client.cleanup({
      transcript: "testing one two three",
      context: null,
      app: "",
      corrections: {},
      apiKey: providerKey(config, provider),
      provider,
      model,
      timeoutSeconds: provider === "local" ? 30 : config.cleanup_timeout,
      systemPrompt: config.cleanup_prompt,
    });
    if (cleaned === null) throw new Error("Cleanup test failed — check the provider and key");
    return `Cleanup works (${providerName(provider)}).`;
  });
  ipcMain.handle("microphone:test", async (event) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (!audioReady || audioWindow === null) throw new Error("Audio service is not ready");
    if (microphoneTest !== null || gestures.state !== GestureState.idle) {
      throw new Error("The microphone is already in use");
    }
    const requestId = nextMicrophoneTestId;
    nextMicrophoneTestId += 1;
    const result = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (microphoneTest?.requestId !== requestId) return;
        microphoneTest = null;
        reject(new Error("Microphone test timed out"));
      }, 5_000);
      microphoneTest = { requestId, resolve, reject, timer };
    });
    audioWindow.webContents.send("audio:command", {
      type: "meter",
      deviceName: config.input_device,
      requestId,
    });
    return await result;
  });
  ipcMain.handle("update:status", (event) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (appUpdateService === null) throw new Error("Update service is not ready");
    return appUpdateService.snapshot();
  });
  ipcMain.handle("update:check", async (event) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (appUpdateService === null) throw new Error("Update service is not ready");
    return await appUpdateService.check();
  });
  ipcMain.handle("update:install", async (event) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (appUpdateService === null) throw new Error("Update service is not ready");
    await appUpdateService.install();
  });
  ipcMain.on("audio:event", (event, payload: unknown) => {
    if (event.sender !== audioWindow?.webContents || !isRecord(payload)) return;
    if (payload.type === "ready") {
      audioReady = true;
      microphones = stringArray(payload.devices);
    } else if (payload.type === "devices") {
      microphones = stringArray(payload.devices);
    } else if (payload.type === "level") {
      if (typeof payload.rms === "number" && Number.isFinite(payload.rms)) {
        sendOverlayLevel(Math.max(0, Math.min(1, payload.rms)));
      }
    } else if (payload.type === "meter") {
      const activeTest = microphoneTest;
      if (activeTest === null || payload.requestId !== activeTest.requestId) return;
      clearTimeout(activeTest.timer);
      microphoneTest = null;
      if (typeof payload.error === "string") {
        activeTest.reject(new Error(payload.error));
      } else if (typeof payload.peak === "number" && Number.isFinite(payload.peak)) {
        activeTest.resolve(Math.max(0, Math.min(1, payload.peak)));
      } else {
        activeTest.reject(new Error("Microphone test returned an invalid level"));
      }
    } else if (payload.type === "stopped") {
      const wav = toByteArray(payload.wav);
      const target = pendingTarget;
      const overlayRevision = pendingOverlayRevision;
      pendingTarget = null;
      pendingOverlayRevision = undefined;
      const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : 0;
      if (wav === null || wav.byteLength <= 44 || durationMs < 300) {
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
        }, overlayRevision);
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
    const updaterSupported = app.isPackaged && !packagedSmoke;
    const { autoUpdater } = electronUpdater;
    appUpdateService = new AppUpdateService({
      updater: updaterSupported ? autoUpdater : null,
      currentVersion: app.getVersion(),
      unavailableMessage: electronPreview
        ? "Update checks are available in the installed app."
        : "Updates are unavailable in this build.",
      prepareToInstall: async () => {
        quitting = true;
        await finishShutdown();
      },
      onStatus: (snapshot) => {
        settingsWindow?.webContents.send("update:status", snapshot);
        if (snapshot.phase === "downloaded") {
          showFeedback(`${snapshot.message} Open Settings to restart.`, "normal");
        }
      },
    });
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
      if (ptt.pressed) gestures.press();
      if (ptt.released) gestures.release();
      // Wait until the physical re-paste chord is fully released. Sending
      // Ctrl+V while its Ctrl/Alt keys are still held turns the injected paste
      // back into the re-paste chord in the target application.
      if (repaste.completed) repasteLast();
      if (event.eventType === "down"
        && !ptt.keyBelongsToShortcut
        && !repaste.keyBelongsToShortcut) {
        insertionMemory.invalidate();
      }
    });
    windowsHost.onMouse(() => insertionMemory.invalidate());
    await windowsHost.start();
    await initializePipeline();
    await initializeDeveloperController();
    if (!managedDev) createTray();
    updateTrayTooltip();
    const sttConfigured = config.provider === "local"
      || providerKey(config, config.provider).trim().length > 0;
    if (packagedSmoke || !sttConfigured) openSettings();
    await windowsHost.startInput();
    if (managedDev) {
      const readyFile = process.env.UNDERTONE_MANAGED_READY_FILE;
      const localAppData = process.env.LOCALAPPDATA ?? app.getPath("appData");
      const buildRoot = path.join(localAppData, "Undertone", "DevBuilds");
      if (readyFile === undefined || !isWithin(readyFile, buildRoot)) {
        throw new Error("Managed development readiness path is invalid");
      }
      await writeFile(readyFile, "ready", "utf8");
    }
    if (updaterSupported) {
      setTimeout(() => {
        if (developerSnapshot.activeWorktree === null) void appUpdateService?.check();
      }, 15_000);
    }
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
    await fileLog.flush();
    app.exit(1);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isHistoryAction(value: unknown): value is HistoryAction {
  return value === "copy" || value === "repaste" || value === "retry";
}

function isSystemAction(value: unknown): value is SystemAction {
  return value === "openSettingsFolder" || value === "openLog";
}

function providerName(provider: string): string {
  return provider === "xai" ? "xAI"
    : provider === "openai" ? "OpenAI"
      : provider === "openrouter" ? "OpenRouter"
        : "Local";
}

function authorizeSettingsSender(
  sender: Electron.WebContents,
  settingsWindow: BrowserWindow | null,
): void {
  if (sender !== settingsWindow?.webContents) {
    throw new Error("Request came from an unauthorized renderer");
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function toByteArray(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
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
  if (managedDev) return path.join(app.getAppPath(), "assets", name);
  return app.isPackaged
    ? path.join(process.resourcesPath, "assets", name)
    : path.resolve(__dirname, "../../../../assets", name);
}

function recordingTraySvg(): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#c9525c"/>
    <path d="M10 9v8a6 6 0 0 0 12 0V9h-4v8a2 2 0 0 1-4 0V9z" fill="#fff"/>
    <rect x="14" y="22" width="4" height="4" rx="1" fill="#fff"/>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
