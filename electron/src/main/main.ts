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
import { encodePcm16Wav, StreamingPcm16Encoder } from "../core/audio";
import { ClipboardPaster } from "../core/clipboardPaster";
import {
  DEFAULT_CONFIG,
  modelOverride,
  normalizeConfig,
  providerKey,
  type UndertoneConfig,
} from "../core/config";
import { DictationJobRunner } from "../core/dictationRunner";
import { GestureState, TapStateMachine } from "../core/gestures";
import {
  LiveTranscriber,
  type LiveTranscriptionSession,
} from "../core/liveTranscriber";
import { OverlayController } from "../core/overlayController";
import { applySettingsPatch, settingsSnapshot } from "../core/settingsModel";
import {
  DictationPipelineQueue,
  SessionHistory,
  type DictationInput,
  type DictationTarget,
  type PendingDictation,
} from "../core/pipelineQueue";
import { prepareText } from "../core/textPreparation";
import { Transcriber } from "../core/transcriber";
import { TurnBuffer } from "../core/turnBuffer";
import {
  ActionShortcutBinding,
  actionShortcutsOverlap,
  KEEP_OPEN_SHORTCUT,
  pttActionShortcutsOverlap,
  PttActionRouter,
  ShortcutBinding,
  ShortcutCapture,
} from "../core/shortcuts";
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
  OpenAiSubscription,
  type OpenAiSubscriptionCredentials,
} from "./openAiSubscription";
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
import {
  canHideTurnDraftAfterDismissal,
  hasActiveTurnDraftWork,
  type OverlayState,
  type OverlayTone,
  type TurnDraftView,
} from "../shared/overlay";
import {
  turnFeedbackFamily,
  type TurnFeedbackFamily,
} from "../shared/turnWindow";

const DEV_QUIT_ARGUMENT = "--undertone-dev-quit";
const OPEN_SETTINGS_ARGUMENT = "--undertone-open-settings";
const packagedSmoke = process.env.UNDERTONE_PACKAGE_SMOKE === "1";
const localRuntimeSmoke = process.env.UNDERTONE_LOCAL_RUNTIME_SMOKE === "1";
const packagedSmokeResult = process.env.UNDERTONE_PACKAGE_SMOKE_RESULT;
const turnDraftNativeE2e = process.env.UNDERTONE_TURN_DRAFT_NATIVE_E2E === "1";
const managedDev = process.env.UNDERTONE_MANAGED_DEV === "1";
const electronPreview = !app.isPackaged || process.env.UNDERTONE_ELECTRON_PREVIEW === "1";
const devBranch = electronPreview ? process.env.UNDERTONE_DEV_BRANCH?.trim() : undefined;
const devQuitRequest = electronPreview && process.argv.includes(DEV_QUIT_ARGUMENT);
const isolatedProfile = electronPreview || packagedSmoke;
const TURN_DRAFT_COMPACT_SIZE = { width: 72, height: 44 } as const;
const TURN_DRAFT_TEXT_SIZE = { width: 400, height: 68 } as const;
const TURN_DRAFT_TEXT_MIN_WIDTH = 300;
const TURN_DRAFT_AUTO_MAX_HEIGHT = 360;
const TURN_DRAFT_AUTO_WORK_AREA_RATIO = 0.45;

interface CapturedAudio {
  wav: Uint8Array | null;
}

interface LiveCapture {
  provider: "openai" | "xai";
  session: LiveTranscriptionSession;
  encoder: StreamingPcm16Encoder;
  text: string;
  state: "listening" | "finalizing" | "processing";
  /** Stable text through this capture, latched before the turn buffer changes. */
  latchedText?: string;
}

interface TurnDraftDismissal {
  revision: number;
  captureId?: number;
  timer?: ReturnType<typeof setTimeout>;
}

if (packagedSmoke) {
  const profilePath = process.env.UNDERTONE_PACKAGE_SMOKE_PROFILE;
  if (profilePath === undefined || !isWithin(profilePath, app.getPath("temp"))) {
    throw new Error("Packaged smoke profile path is invalid");
  }
  app.setPath("userData", profilePath);
} else if (turnDraftNativeE2e) {
  const previewRoot = process.env.LOCALAPPDATA ?? app.getPath("appData");
  app.setPath("userData", path.join(previewRoot, "Undertone", "TurnDraftNativeE2E"));
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
  let turnDraftWindow: BrowserWindow | null = null;
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
  let openAiSubscription: OpenAiSubscription | null = null;
  const localInstallState: Record<LocalEngineKind, InstallProgress & { installing: boolean }> = {
    stt: { installing: false, phase: "", fraction: 0 },
    cleanup: { installing: false, phase: "", fraction: 0 },
  };
  let shutdownComplete = false;
  let shutdownPromise: Promise<void> | null = null;
  const pendingAudioFinalizations = new Map<number, {
    resolve: (capture: CapturedAudio | null) => void;
    timer: ReturnType<typeof setTimeout>;
    streamed: boolean;
    liveFailed: boolean;
  }>();
  let nextAudioFinalizationId = 1;
  let activeAudioCaptureId: number | null = null;
  let shortcutCapture: {
    collector: ShortcutCapture;
    completed: boolean;
    resolve: (shortcut: string | null) => void;
  } | null = null;
  const history = new SessionHistory();
  const turnBuffer = new TurnBuffer();
  const liveTranscriber = new LiveTranscriber();
  const liveCaptures = new Map<number, LiveCapture>();
  const activeDictationCaptureIds = new Set<number>();
  const dictationFeedbackFamilies = new Map<number, TurnFeedbackFamily>();
  const autostart = new AutostartManager(process.execPath);
  const windowsHost = new WindowsHost(app.isPackaged ? {
    executable: path.join(process.resourcesPath, "native", "Undertone.WinHost.exe"),
  } : {});
  const pttShortcut = new ShortcutBinding(config.hotkey);
  const repasteShortcut = new ActionShortcutBinding(config.repaste_hotkey, "release", true);
  const commitShortcut = new ActionShortcutBinding(config.commit_hotkey, "release", true);
  const scratchShortcut = new ActionShortcutBinding(config.scratch_hotkey, "trigger", true);
  const discardShortcut = new ActionShortcutBinding(config.discard_hotkey, "trigger", true);
  const keepOpenShortcut = new ActionShortcutBinding(
    KEEP_OPEN_SHORTCUT,
    "release",
    false,
    true,
  );
  const pttActionRouter = new PttActionRouter();
  let keepOpenArmedForRecording = false;
  let pttCompletionDeferred = false;
  let overlayDisplayId: number | undefined;
  let turnDraftUserPositioned = false;
  let turnDraftReady = false;
  let turnDraftMode: "hidden" | "compact" | "text" = "hidden";
  let turnDraftTurnActive = false;
  let turnDraftUserHeightFloor: number = TURN_DRAFT_TEXT_SIZE.height;
  let turnDraftRevision = 0;
  let turnDraftDismissal: TurnDraftDismissal | null = null;
  let turnDraftManualProcessing = false;
  let lastTurnDraftView: TurnDraftView | null = null;
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

  const presentOverlayWindow = (): void => {
    const overlay = overlayWindow;
    if (overlay === null || overlay.isDestroyed()) return;
    positionOverlay(overlay);
    overlay.setAlwaysOnTop(true, "screen-saver");
    if (!overlay.isVisible()) overlay.showInactive();
    overlay.moveTop();
  };

  const defaultTurnDraftPosition = (width: number, height: number): Electron.Point => {
    const display = overlayDisplayId === undefined
      ? screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      : screen.getAllDisplays().find(({ id }) => id === overlayDisplayId)
        ?? screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const bounds = display.workArea;
    return {
      x: bounds.x + Math.round((bounds.width - width) / 2),
      y: bounds.y + bounds.height - height - 84,
    };
  };

  const positionTurnDraft = (draftWindow: BrowserWindow): void => {
    const current = draftWindow.getBounds();
    const { x, y } = defaultTurnDraftPosition(current.width, current.height);
    if (current.x === x && current.y === y) return;
    draftWindow.setPosition(x, y, false);
  };

  const keepTurnDraftOnScreen = (draftWindow: BrowserWindow): void => {
    const current = draftWindow.getBounds();
    const workArea = screen.getDisplayMatching(current).workArea;
    const x = Math.max(workArea.x, Math.min(
      current.x,
      workArea.x + workArea.width - current.width,
    ));
    const y = Math.max(workArea.y, Math.min(
      current.y,
      workArea.y + workArea.height - current.height,
    ));
    if (x === current.x && y === current.y) return;
    draftWindow.setPosition(x, y, false);
  };

  const turnDraftAutoHeightLimit = (draftWindow: BrowserWindow): number => {
    const { height } = screen.getDisplayMatching(draftWindow.getBounds()).workArea;
    return Math.max(
      TURN_DRAFT_TEXT_SIZE.height,
      Math.floor(Math.min(TURN_DRAFT_AUTO_MAX_HEIGHT, height * TURN_DRAFT_AUTO_WORK_AREA_RATIO)),
    );
  };

  const resizeTurnDraftAnchored = (
    draftWindow: BrowserWindow,
    width: number,
    height: number,
  ): void => {
    const current = draftWindow.getBounds();
    if (current.width === width && current.height === height) return;
    const workArea = screen.getDisplayMatching(current).workArea;
    const centerX = current.x + current.width / 2;
    const bottom = current.y + current.height;
    const x = Math.max(workArea.x, Math.min(
      Math.round(centerX - width / 2),
      workArea.x + workArea.width - width,
    ));
    const y = Math.max(workArea.y, Math.min(
      bottom - height,
      workArea.y + workArea.height - height,
    ));
    draftWindow.setBounds({ x, y, width, height }, false);
  };

  const setTurnDraftMode = (
    draftWindow: BrowserWindow,
    mode: "compact" | "text",
  ): void => {
    if (turnDraftMode === mode) return;
    if (mode === "compact") {
      draftWindow.setMinimumSize(
        TURN_DRAFT_COMPACT_SIZE.width,
        TURN_DRAFT_COMPACT_SIZE.height,
      );
      draftWindow.setResizable(false);
      draftWindow.setIgnoreMouseEvents(true);
      resizeTurnDraftAnchored(
        draftWindow,
        TURN_DRAFT_COMPACT_SIZE.width,
        TURN_DRAFT_COMPACT_SIZE.height,
      );
    } else {
      draftWindow.setResizable(true);
      draftWindow.setIgnoreMouseEvents(false);
      resizeTurnDraftAnchored(
        draftWindow,
        TURN_DRAFT_TEXT_SIZE.width,
        Math.max(TURN_DRAFT_TEXT_SIZE.height, turnDraftUserHeightFloor),
      );
      draftWindow.setMinimumSize(TURN_DRAFT_TEXT_MIN_WIDTH, TURN_DRAFT_TEXT_SIZE.height);
    }
    turnDraftMode = mode;
  };

  const presentTurnDraftWindow = (): void => {
    const draftWindow = turnDraftWindow;
    if (draftWindow === null || draftWindow.isDestroyed()) return;
    if (!turnDraftUserPositioned) positionTurnDraft(draftWindow);
    if (!draftWindow.isVisible()) draftWindow.showInactive();
  };

  const isIntegratedOverlayActivity = (state: OverlayState["state"]): boolean => {
    return state === "recording"
      || state === "locked"
      || state === "transcribing"
      || state === "slow";
  };

  const activeTurnFeedbackFamily = (): TurnFeedbackFamily | null => {
    let family: TurnFeedbackFamily | null = null;
    for (const captureId of activeDictationCaptureIds) {
      family = dictationFeedbackFamilies.get(captureId) ?? family;
    }
    return family;
  };

  const renderOverlay = (state: OverlayState): void => {
    const overlay = overlayWindow;
    if (overlay === null || overlay.isDestroyed()) return;
    publishTurnDraft();
    const projectedState = activeTurnFeedbackFamily() === "turn-window"
      && isIntegratedOverlayActivity(state.state)
      ? { state: "hidden", text: "", tone: "normal" } satisfies OverlayState
      : state;
    if (projectedState.state === "hidden") {
      // Keep the click-through native window presented. Windows fades a newly
      // shown layered window and shifts its raster by a pixel during that fade.
      overlay.webContents.send("overlay:state", projectedState);
      return;
    }
    presentOverlayWindow();
    overlay.webContents.send("overlay:state", projectedState);
  };

  const composeTurnDraftText = (throughCaptureId = Number.POSITIVE_INFINITY): string => {
    const captures = [...liveCaptures.entries()]
      .filter(([captureId]) => captureId <= throughCaptureId);
    const latched = captures.find(([, capture]) => capture.state === "processing"
      && capture.latchedText !== undefined);
    const parts = latched === undefined
      ? [turnBuffer.snapshot()?.text ?? "", ...captures.map(([, capture]) => capture.text)]
      : [
        latched[1].latchedText ?? "",
        ...captures
          .filter(([captureId]) => captureId > latched[0])
          .map(([, capture]) => capture.text),
      ];
    return parts.map((part) => part.trim()).filter(Boolean).join(" ");
  };

  const cancelTurnDraftDismissal = (): void => {
    const dismissal = turnDraftDismissal;
    if (dismissal === null) return;
    if (dismissal.timer !== undefined) clearTimeout(dismissal.timer);
    turnDraftDismissal = null;
    if (dismissal.captureId !== undefined) liveCaptures.delete(dismissal.captureId);
    turnDraftManualProcessing = false;
  };

  const completeTurnDraftDismissal = (revision: number): void => {
    const dismissal = turnDraftDismissal;
    if (dismissal === null || dismissal.revision !== revision) return;
    if (dismissal.timer !== undefined) clearTimeout(dismissal.timer);
    turnDraftDismissal = null;
    if (dismissal.captureId !== undefined) liveCaptures.delete(dismissal.captureId);
    turnDraftManualProcessing = false;
    const hasActiveWork = hasActiveTurnDraftWork(
      turnBuffer.snapshot() !== null,
      [...activeDictationCaptureIds],
      dismissal.captureId,
    );
    if (!canHideTurnDraftAfterDismissal(dismissal.revision, revision, hasActiveWork)) {
      publishTurnDraft();
      return;
    }
    const draftWindow = turnDraftWindow;
    if (draftWindow !== null && !draftWindow.isDestroyed() && draftWindow.isVisible()) {
      draftWindow.hide();
    }
    turnDraftMode = "hidden";
    turnDraftTurnActive = false;
    lastTurnDraftView = null;
  };

  const beginTurnDraftDismissal = (captureId?: number): void => {
    const hasNewerWork = hasActiveTurnDraftWork(
      turnBuffer.snapshot() !== null,
      [...activeDictationCaptureIds],
      captureId,
    );
    if (hasNewerWork) {
      if (captureId !== undefined) liveCaptures.delete(captureId);
      turnDraftManualProcessing = false;
      publishTurnDraft();
      return;
    }
    cancelTurnDraftDismissal();
    const revision = ++turnDraftRevision;
    turnDraftDismissal = { revision, ...(captureId === undefined ? {} : { captureId }) };
    publishTurnDraft();
    const dismissal = turnDraftDismissal;
    if (dismissal === null || dismissal.revision !== revision) return;
    dismissal.timer = setTimeout(() => completeTurnDraftDismissal(revision), 320);
  };

  const publishTurnDraft = (): void => {
    const draftWindow = turnDraftWindow;
    if (draftWindow === null || draftWindow.isDestroyed() || !turnDraftReady) return;
    const snapshot = turnBuffer.snapshot();
    const dismissal = turnDraftDismissal;
    const hasNewerWork = dismissal !== null && hasActiveTurnDraftWork(
      snapshot !== null,
      [...activeDictationCaptureIds],
      dismissal.captureId,
    );
    if (hasNewerWork) cancelTurnDraftDismissal();
    const activeDismissal = turnDraftDismissal;
    const provisional = [...liveCaptures.values()];
    let text = composeTurnDraftText();
    if (text.length === 0 && (turnDraftManualProcessing || activeDismissal !== null)) {
      text = lastTurnDraftView?.text ?? "";
    }
    const liveState = [...liveCaptures.values()].some(({ state }) => state === "listening")
      ? "listening"
      : [...liveCaptures.values()].some(({ state }) => state !== "listening")
        ? "finalizing"
        : null;
    const overlayState = overlayController.current().state;
    const overlayActivity: TurnDraftView["activity"] = overlayState === "recording"
      || overlayState === "locked"
      || overlayState === "transcribing"
      || overlayState === "slow"
      ? overlayState
      : "idle";
    const activity: TurnDraftView["activity"] = overlayState === "locked"
      || overlayState === "slow"
      ? overlayState
      : turnDraftManualProcessing ? "finalizing" : liveState ?? overlayActivity;
    const turnWindowSessionActive = activeTurnFeedbackFamily() === "turn-window";
    const hasActiveTurn = snapshot !== null
      || liveCaptures.size > 0
      || turnDraftManualProcessing
      || activeDismissal !== null
      || turnWindowSessionActive;
    if (hasActiveTurn && !turnDraftTurnActive) {
      turnDraftUserHeightFloor = TURN_DRAFT_TEXT_SIZE.height;
    }
    turnDraftTurnActive = hasActiveTurn;
    const fullLiveWindow = liveCaptures.size > 0 || turnDraftManualProcessing;
    const draft: TurnDraftView | null = text.length === 0
      && !fullLiveWindow
      && activeDismissal === null
      && !turnWindowSessionActive ? null : {
      design: config.turn_window_design,
      text,
      fragmentCount: (snapshot?.fragmentCount ?? 0) + provisional.length,
      charCount: text.length,
      liveState,
      activity,
      presentation: activeDismissal === null ? "visible" : "dismissing",
      revision: activeDismissal?.revision ?? ++turnDraftRevision,
    };
    if (draft === null) {
      if (draftWindow.isVisible()) draftWindow.hide();
      turnDraftMode = "hidden";
      lastTurnDraftView = null;
      return;
    }
    lastTurnDraftView = draft;
    setTurnDraftMode(
      draftWindow,
      text.length === 0 && !fullLiveWindow ? "compact" : "text",
    );
    draftWindow.webContents.send("turnDraft:view", draft);
    presentTurnDraftWindow();
  };

  const overlayController = new OverlayController(renderOverlay);

  const anchorOverlayToCursor = (): void => {
    overlayDisplayId = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  };

  const sendOverlayLevel = (rms: number): void => {
    const overlay = overlayWindow;
    const state = overlayController.current().state;
    if (state !== "recording" && state !== "locked") return;
    if (overlay !== null && !overlay.isDestroyed()) {
      overlay.webContents.send("overlay:level", rms);
    }
    const draftWindow = turnDraftWindow;
    if (turnDraftReady
      && activeTurnFeedbackFamily() === "turn-window"
      && draftWindow !== null
      && !draftWindow.isDestroyed()) {
      draftWindow.webContents.send("turnDraft:level", rms);
    }
  };

  const showFeedback = (
    text: string,
    kind: OverlayTone = "normal",
  ): void => {
    const barOnlySignal = (text.startsWith("Recording too short") && kind === "warning")
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
        : "Undertone — hold to paste, tap to toggle, Left Alt to keep open";
    tray?.setToolTip(devBranch === undefined || devBranch.length === 0
      ? tooltip
      : `${tooltip}\nDev: ${devBranch}`);
  };

  const configureShortcuts = (): void => {
    pttActionRouter.reset();
    keepOpenArmedForRecording = false;
    pttCompletionDeferred = false;
    try {
      const dictateHotkey = pttActionShortcutsOverlap(config.hotkey, KEEP_OPEN_SHORTCUT)
        ? DEFAULT_CONFIG.hotkey
        : config.hotkey;
      pttShortcut.set(dictateHotkey);
      if (dictateHotkey !== config.hotkey) {
        showFeedback(
          `Left Alt is reserved; using ${DEFAULT_CONFIG.hotkey} for Dictate`,
          "warning",
        );
      }
    } catch {
      pttShortcut.set(DEFAULT_CONFIG.hotkey);
      showFeedback(
        `The saved Dictate shortcut is unsupported; using ${DEFAULT_CONFIG.hotkey}`,
        "warning",
      );
    }
    try {
      repasteShortcut.set(actionShortcut(config.repaste_hotkey), true);
    } catch {
      repasteShortcut.set("", true);
      showFeedback("The saved re-paste shortcut is unsupported", "warning");
    }
    try {
      commitShortcut.set(actionShortcut(config.commit_hotkey), true);
    } catch {
      commitShortcut.set("", true);
      showFeedback("The saved commit shortcut is unsupported", "warning");
    }
    try {
      scratchShortcut.set(config.scratch_hotkey, true);
    } catch {
      scratchShortcut.set("", true);
      showFeedback("The saved scratch shortcut is unsupported", "warning");
    }
    try {
      discardShortcut.set(config.discard_hotkey, true);
    } catch {
      discardShortcut.set("", true);
      showFeedback("The saved discard shortcut is unsupported", "warning");
    }
    keepOpenShortcut.set(KEEP_OPEN_SHORTCUT);
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

  const commitOpenTurn = (): void => {
    const activePipeline = pipeline;
    if (activePipeline === null) {
      showFeedback("Dictation service is not ready", "error");
      return;
    }
    void activePipeline.enqueueCommit().catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : "Could not commit turn", "error");
    });
  };

  const captureForegroundTarget = async (): Promise<DictationTarget | null> => {
    try {
      const foreground = await windowsHost.getForeground();
      return {
        window: foreground.window,
        focus: foreground.focus,
        focusIdentity: foreground.focusIdentity,
        generation: foreground.generation,
      };
    } catch {
      return null;
    }
  };

  const discardOpenTurn = (): void => {
    void pipeline?.enqueueDiscard().catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : "Could not discard turn", "error");
    });
  };

  const scratchLastFragment = (): void => {
    void pipeline?.enqueueScratch().catch((error: unknown) => {
      showFeedback(error instanceof Error ? error.message : "Could not scratch fragment", "error");
    });
  };

  const abandonLiveCapture = (captureId: number): void => {
    const capture = liveCaptures.get(captureId);
    if (capture === undefined) return;
    liveCaptures.delete(captureId);
    capture.session.cancel();
    publishTurnDraft();
  };

  const failLiveCapture = (captureId: number, error: Error): void => {
    const capture = liveCaptures.get(captureId);
    if (capture === undefined) return;
    const shouldCancelRecording = activeAudioCaptureId === captureId;
    liveCaptures.delete(captureId);
    const pending = pendingAudioFinalizations.get(captureId);
    if (pending !== undefined) pending.liveFailed = true;
    console.warn(`Live ${capture.provider} transcription failed: ${error.message}`);
    publishTurnDraft();
    if (shouldCancelRecording) gestures.cancel();
    showFeedback(`Live transcription failed: ${error.message}`, "error");
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
      const captureId = nextAudioFinalizationId++;
      const streamLive = liveTranscriptionEnabled(config);
      const feedbackFamily = turnFeedbackFamily(config.turn_window_design, streamLive);
      if (feedbackFamily === "turn-window"
        && (!turnDraftReady
          || turnDraftWindow === null
          || turnDraftWindow.isDestroyed())) {
        showFeedback("Turn window unavailable — recording did not start", "error");
        return false;
      }
      if (streamLive) {
        try {
          const provider = config.provider === "openai" ? "openai" : "xai";
          const liveCapture: LiveCapture = {
            provider,
            session: liveTranscriber.start({
              provider,
              apiKey: providerKey(config, provider),
              language: config.language,
              vocabulary: provider === "xai" ? liveVocabulary(config) : [],
            }, {
              partial: (text) => {
                const active = liveCaptures.get(captureId);
                if (active === undefined) return;
                active.text = text;
                publishTurnDraft();
              },
              failed: (error) => failLiveCapture(captureId, error),
            }),
            encoder: new StreamingPcm16Encoder(provider === "openai" ? 24_000 : 16_000),
            text: "",
            state: "listening",
          };
          liveCaptures.set(captureId, liveCapture);
        } catch (error) {
          showFeedback(
            `Live transcription failed: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
          return false;
        }
      }
      activeAudioCaptureId = captureId;
      activeDictationCaptureIds.add(captureId);
      dictationFeedbackFamilies.set(captureId, feedbackFamily);
      anchorOverlayToCursor();
      audioWindow.webContents.send("audio:command", {
        type: "start",
        captureId,
        deviceName: config.input_device,
        stream: streamLive,
      });
      playCue("start");
      setTrayRecording(true);
      overlayController.recording();
      return true;
    },
    onFinish: (completion) => {
      const captureId = activeAudioCaptureId;
      activeAudioCaptureId = null;
      if (captureId === null) return;
      const activePipeline = pipeline;
      const target = completion === "commit"
        ? captureForegroundTarget()
        : Promise.resolve(null);
      const liveCapture = liveCaptures.get(captureId);
      if (liveCapture !== undefined) liveCapture.state = "finalizing";
      const overlayRevision = overlayController.transcribing();
      if (activePipeline !== null) {
        let resolveAudio!: (capture: CapturedAudio | null) => void;
        const audio = new Promise<CapturedAudio | null>((resolve) => { resolveAudio = resolve; });
        const timer = setTimeout(() => {
          const pending = pendingAudioFinalizations.get(captureId);
          if (pending === undefined) return;
          pendingAudioFinalizations.delete(captureId);
          pending.resolve(null);
          showFeedback("Audio finalization timed out", "error");
        }, 5_000);
        pendingAudioFinalizations.set(captureId, {
          resolve: resolveAudio,
          timer,
          streamed: liveCapture !== undefined,
          liveFailed: false,
        });
        const pending = Promise.all([audio, target]).then<PendingDictation | null>(
          async ([captured, capturedTarget]) => {
            if (captured === null) {
              abandonLiveCapture(captureId);
              return null;
            }
            const activeLive = liveCaptures.get(captureId);
            let input: DictationInput;
            if (activeLive !== undefined) {
              try {
                activeLive.session.append(activeLive.encoder.finish());
                const text = await activeLive.session.finish();
                if (text.length === 0) {
                  abandonLiveCapture(captureId);
                  showFeedback("No speech detected", "error");
                  return null;
                }
                activeLive.text = text;
                console.log(
                  `Live ${activeLive.provider} transcription finalized (${text.length} characters)`,
                );
                publishTurnDraft();
                input = { type: "transcript", text, previewId: captureId };
              } catch (error) {
                if (liveCaptures.has(captureId)) {
                  failLiveCapture(
                    captureId,
                    error instanceof Error ? error : new Error(String(error)),
                  );
                }
                return null;
              }
            } else if (captured.wav !== null) {
              input = { type: "audio", wav: captured.wav, captureId };
            } else {
              return null;
            }
            return {
              input,
              target: capturedTarget ?? (completion === "commit"
                ? { window: "0", generation: "-1" }
                : null),
              overlayRevision,
              completion,
            };
          },
        );
        void activePipeline.enqueuePendingDictation(pending)
          .catch((error: unknown) => {
            console.error("Dictation pipeline failed", error);
            showFeedback(
              error instanceof Error ? error.message : "The dictation pipeline failed",
              "error",
            );
          })
          .finally(() => {
            activeDictationCaptureIds.delete(captureId);
            dictationFeedbackFamilies.delete(captureId);
            publishTurnDraft();
          });
      } else {
        activeDictationCaptureIds.delete(captureId);
        dictationFeedbackFamilies.delete(captureId);
        abandonLiveCapture(captureId);
        showFeedback("Dictation service is not ready", "error");
      }
      audioWindow?.webContents.send("audio:command", { type: "stop", requestId: captureId });
      playCue("stop");
      setTrayRecording(false);
    },
    onDiscard: () => {
      const captureId = activeAudioCaptureId;
      activeAudioCaptureId = null;
      if (captureId !== null) {
        activeDictationCaptureIds.delete(captureId);
        dictationFeedbackFamilies.delete(captureId);
        abandonLiveCapture(captureId);
      }
      audioWindow?.webContents.send("audio:command", { type: "cancel" });
      playCue("cancel");
      setTrayRecording(false);
      overlayController.hide();
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
      publishTurnDraft();
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
      if (turnDraftWindow !== null && !turnDraftWindow.isDestroyed()) {
        if (turnDraftMode === "text") {
          const heightLimit = screen.getDisplayMatching(
            turnDraftWindow.getBounds(),
          ).workArea.height;
          turnDraftUserHeightFloor = Math.min(turnDraftUserHeightFloor, heightLimit);
          const { width, height } = turnDraftWindow.getBounds();
          if (height > heightLimit) {
            resizeTurnDraftAnchored(turnDraftWindow, width, heightLimit);
          }
        }
        keepTurnDraftOnScreen(turnDraftWindow);
      }
    };
    screen.on("display-metrics-changed", repositionOverlay);
    screen.on("display-removed", repositionOverlay);
  };

  const createTurnDraft = async (): Promise<void> => {
    const draftWindow = new BrowserWindow({
      width: TURN_DRAFT_TEXT_SIZE.width,
      height: TURN_DRAFT_TEXT_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      focusable: false,
      movable: true,
      resizable: true,
      minWidth: TURN_DRAFT_TEXT_MIN_WIDTH,
      minHeight: TURN_DRAFT_TEXT_SIZE.height,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        preload: path.join(__dirname, "../preload/turnDraftPreload.js"),
      },
    });
    turnDraftWindow = draftWindow;
    draftWindow.setAlwaysOnTop(true, "screen-saver");
    draftWindow.on("will-move", () => {
      turnDraftUserPositioned = true;
    });
    draftWindow.on("will-resize", (_event, nextBounds) => {
      if (turnDraftMode !== "text"
        || nextBounds.height === draftWindow.getBounds().height) return;
      turnDraftUserHeightFloor = Math.max(
        TURN_DRAFT_TEXT_SIZE.height,
        Math.min(
          screen.getDisplayMatching(nextBounds).workArea.height,
          Math.round(nextBounds.height),
        ),
      );
    });
    draftWindow.webContents.on("did-start-loading", () => {
      turnDraftReady = false;
      renderOverlay(overlayController.current());
    });
    draftWindow.webContents.on("did-finish-load", () => {
      turnDraftReady = true;
      publishTurnDraft();
      renderOverlay(overlayController.current());
    });
    draftWindow.webContents.on("render-process-gone", (_event, details) => {
      const requiredByActiveDictation = activeTurnFeedbackFamily() === "turn-window";
      turnDraftReady = false;
      console.error("Open-turn draft renderer exited", details);
      if (requiredByActiveDictation && !quitting) {
        gestures.cancel();
        showFeedback("Turn window unavailable", "error");
      } else {
        renderOverlay(overlayController.current());
      }
      if (!quitting && !draftWindow.isDestroyed()) draftWindow.reload();
    });
    await draftWindow.loadFile(
      path.join(__dirname, "../../renderer/turn-draft/index.html"),
    );
    positionTurnDraft(draftWindow);
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
    openAiSubscription = new OpenAiSubscription({
      http,
      credentials: openAiCredentials(config),
      persist: persistOpenAiCredentials,
      openExternal: async (url) => {
        await shell.openExternal(url);
      },
      appVersion: app.getVersion(),
    });
    transcriberClient = new Transcriber(http, localStt);
    cleanupClient = new CleanupClient(http, localCleanup, openAiSubscription);
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
          cleanup: async (request) => await cleanupClient!.cleanup(request),
        });
      },
      paster,
      history,
      turnBuffer,
      feedback: {
        message: showFeedback,
        dismiss: () => { overlayController.confirm(); },
      },
    });
    pipeline = new DictationPipelineQueue(
      () => config,
      {
        dictate: async (input, target, snapshot, overlayRevision, completion) => {
          const captureId = input.type === "transcript" ? input.previewId : input.captureId;
          const feedbackFamily = captureId === undefined
            ? "five-bar"
            : dictationFeedbackFamilies.get(captureId) ?? "five-bar";
          if (input.type === "transcript") {
            const capture = liveCaptures.get(input.previewId);
            if (capture !== undefined) {
              capture.latchedText = composeTurnDraftText(input.previewId);
              capture.state = "processing";
            }
            publishTurnDraft();
          }
          try {
            const feedback = {
              message: showFeedback,
              dismiss: () => {
                if (feedbackFamily === "turn-window") {
                  overlayController.hide(overlayRevision);
                } else {
                  overlayController.confirm("Text pasted", 1_000, overlayRevision);
                }
              },
            };
            if (input.type === "audio") {
              await runner.run(input.wav, target, snapshot, completion, feedback);
            } else {
              await runner.runTranscript(input.text, target, snapshot, completion, feedback);
            }
            if (completion === "commit"
              && turnBuffer.snapshot() === null
              && feedbackFamily === "turn-window"
              && captureId !== undefined) {
              beginTurnDraftDismissal(captureId);
            } else if (input.type === "transcript") {
              liveCaptures.delete(input.previewId);
              publishTurnDraft();
            } else {
              publishTurnDraft();
            }
          } catch (error) {
            if (input.type === "transcript") liveCaptures.delete(input.previewId);
            publishTurnDraft();
            throw error;
          }
        },
        repaste: async (text, snapshot) => {
          await paster.paste(text, Boolean(snapshot.restore_clipboard));
          history.registerSuccess(text);
          overlayController.confirm();
        },
        commit: async (snapshot) => {
          turnDraftManualProcessing = turnBuffer.snapshot() !== null;
          publishTurnDraft();
          try {
            await runner.commit(snapshot, {
              message: showFeedback,
              dismiss: () => {
                if (activeDictationCaptureIds.size === 0) {
                  overlayController.hide();
                }
              },
            });
            if (turnDraftManualProcessing && turnBuffer.snapshot() === null) {
              beginTurnDraftDismissal();
            } else {
              turnDraftManualProcessing = false;
              publishTurnDraft();
            }
          } catch (error) {
            turnDraftManualProcessing = false;
            publishTurnDraft();
            throw error;
          }
        },
        discard: async () => {
          runner.discard({
            message: showFeedback,
            dismiss: () => { overlayController.confirm(); },
          });
          publishTurnDraft();
        },
        scratch: async () => {
          runner.scratchLast({
            message: showFeedback,
            dismiss: () => { overlayController.confirm(); },
          });
          publishTurnDraft();
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
    if (turnDraftDismissal?.timer !== undefined) clearTimeout(turnDraftDismissal.timer);
    turnDraftDismissal = null;
    activeDictationCaptureIds.clear();
    dictationFeedbackFamilies.clear();
    openAiSubscription?.dispose();
    for (const pending of pendingAudioFinalizations.values()) {
      clearTimeout(pending.timer);
      pending.resolve(null);
    }
    pendingAudioFinalizations.clear();
    for (const capture of liveCaptures.values()) capture.session.cancel();
    liveCaptures.clear();
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
      const previousCommit = config.commit_hotkey;
      const previousScratch = config.scratch_hotkey;
      const previousDiscard = config.discard_hotkey;
      const previousProvider = config.provider;
      const previousLiveTranscription = config.live_transcription;
      const previousTurnWindowDesign = config.turn_window_design;
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
      if (previousTurnWindowDesign !== config.turn_window_design) {
        publishTurnDraft();
        renderOverlay(overlayController.current());
      }
      if ((previousProvider !== config.provider
        || previousLiveTranscription !== config.live_transcription)
        && gestures.state !== GestureState.idle) {
        gestures.cancel();
      }
      if (config.hotkey !== previousHotkey
        || config.repaste_hotkey !== previousRepaste
        || config.commit_hotkey !== previousCommit
        || config.scratch_hotkey !== previousScratch
        || config.discard_hotkey !== previousDiscard) {
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

  async function persistOpenAiCredentials(
    credentials: OpenAiSubscriptionCredentials | null,
  ): Promise<void> {
    const operation = settingsUpdateChain.then(async () => {
      const store = configStore;
      if (store === null) throw new Error("Settings store is not ready");
      const next = normalizeConfig(config);
      next.openai_oauth_access_token = credentials?.accessToken ?? "";
      next.openai_oauth_refresh_token = credentials?.refreshToken ?? "";
      next.openai_oauth_expires_at = credentials?.expiresAt ?? 0;
      next.openai_oauth_account_id = credentials?.accountId ?? "";
      await store.save(next);
      config = next;
    });
    settingsUpdateChain = operation.catch(() => undefined);
    await operation;
  }

  async function captureShortcut(field: ShortcutSetting): Promise<ReturnType<typeof settingsSnapshot>> {
    if (shortcutCapture !== null) throw new Error("A shortcut is already being captured");
    gestures.cancel();
    pttActionRouter.reset();
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
      pttActionRouter.reset();
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
    if (!isRecord(value)
      || (value.field !== "hotkey"
        && value.field !== "repasteHotkey"
        && value.field !== "commitHotkey"
        && value.field !== "scratchHotkey"
        && value.field !== "discardHotkey")) {
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
      error: null,
      timestamp: entry.timestamp,
      retryable: false,
    } : {
      id: entry.id,
      ok: false,
      text: "",
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
      corrections: {},
      apiKey: providerKey(config, provider),
      provider,
      model,
      timeoutSeconds: provider === "local" ? 30 : config.cleanup_timeout,
      reasoningEffort: config.cleanup_reasoning_effort,
      serviceTier: config.cleanup_service_tier,
      throwOnError: true,
    });
    if (cleaned === null) throw new Error("Cleanup test failed");
    return `Cleanup works (${providerName(provider)}).`;
  });
  ipcMain.handle("openai-subscription:action", async (event, value: unknown) => {
    authorizeSettingsSender(event.sender, settingsWindow);
    if (!isRecord(value) || (value.action !== "connect" && value.action !== "disconnect")) {
      throw new Error("Invalid OpenAI Subscription action");
    }
    const subscription = openAiSubscription;
    if (subscription === null) throw new Error("OpenAI Subscription is not ready");
    if (value.action === "connect") await subscription.connect();
    else await subscription.disconnect();
    return currentSettingsSnapshot();
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
  ipcMain.on("turnDraft:discard", (event) => {
    if (event.sender !== turnDraftWindow?.webContents) return;
    discardOpenTurn();
  });
  ipcMain.on("turnDraft:snap", (event) => {
    const draftWindow = turnDraftWindow;
    if (event.sender !== draftWindow?.webContents) return;
    turnDraftUserPositioned = false;
    positionTurnDraft(draftWindow);
  });
  ipcMain.on("turnDraft:content-height", (event, height: unknown) => {
    const draftWindow = turnDraftWindow;
    if (event.sender !== draftWindow?.webContents
      || turnDraftMode !== "text"
      || typeof height !== "number"
      || !Number.isFinite(height)
      || !Number.isInteger(height)) return;
    const workAreaHeight = screen.getDisplayMatching(draftWindow.getBounds()).workArea.height;
    const desiredHeight = Math.min(
      workAreaHeight,
      Math.max(
        TURN_DRAFT_TEXT_SIZE.height,
        turnDraftUserHeightFloor,
        Math.min(turnDraftAutoHeightLimit(draftWindow), height),
      ),
    );
    const { width } = draftWindow.getBounds();
    resizeTurnDraftAnchored(draftWindow, width, desiredHeight);
  });
  ipcMain.on("turnDraft:dismiss-complete", (event, revision: unknown) => {
    if (event.sender !== turnDraftWindow?.webContents
      || typeof revision !== "number"
      || !Number.isSafeInteger(revision)) return;
    completeTurnDraftDismissal(revision);
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
    } else if (payload.type === "chunk") {
      const captureId = typeof payload.captureId === "number" ? payload.captureId : -1;
      const live = liveCaptures.get(captureId);
      const samples = toFloat32Array(payload.samples);
      const sampleRate = typeof payload.sampleRate === "number" ? payload.sampleRate : 0;
      if (live === undefined || samples === null) return;
      try {
        live.session.append(live.encoder.append(samples, sampleRate));
      } catch (error) {
        failLiveCapture(
          captureId,
          error instanceof Error ? error : new Error(String(error)),
        );
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
      const requestId = typeof payload.requestId === "number" ? payload.requestId : -1;
      const pending = pendingAudioFinalizations.get(requestId);
      if (pending === undefined) return;
      pendingAudioFinalizations.delete(requestId);
      clearTimeout(pending.timer);
      const wav = toByteArray(payload.wav);
      const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : 0;
      if (pending.liveFailed) {
        pending.resolve(null);
        return;
      }
      if ((!pending.streamed && (wav === null || wav.byteLength <= 44)) || durationMs < 250) {
        pending.resolve(null);
        showFeedback("Recording too short — speak a little longer", "warning");
        return;
      }
      pending.resolve({ wav: pending.streamed ? null : wav });
    } else if (payload.type === "error") {
      const requestId = typeof payload.requestId === "number" ? payload.requestId : -1;
      const pending = pendingAudioFinalizations.get(requestId);
      if (pending !== undefined) {
        pendingAudioFinalizations.delete(requestId);
        clearTimeout(pending.timer);
        pending.resolve(null);
      }
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
    await createTurnDraft();
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
      const commit = commitShortcut.update(event);
      const scratch = scratchShortcut.update(event);
      const discard = discardShortcut.update(event);
      const keepOpen = keepOpenShortcut.update(event);
      if (keepOpen.pressed) {
        keepOpenArmedForRecording = gestures.state !== GestureState.idle;
        if (keepOpenArmedForRecording) {
          repasteShortcut.reset();
          commitShortcut.reset();
          scratchShortcut.reset();
          discardShortcut.reset();
        }
      }
      const deferPttCompletion = ptt.completed && keepOpenArmedForRecording;
      if (deferPttCompletion) pttCompletionDeferred = true;
      pttActionRouter.update(
        event,
        deferPttCompletion ? { ...ptt, completed: false } : ptt,
        keepOpenArmedForRecording ? [] : [repaste, commit, scratch, discard],
        gestures,
      );
      if (keepOpen.completed
        && keepOpenArmedForRecording
        && gestures.state !== GestureState.idle) {
        gestures.finishOpenTurn();
        pttCompletionDeferred = false;
      }
      if (keepOpen.keyBelongsToShortcut && event.eventType === "up") {
        if (!keepOpen.completed && pttCompletionDeferred) gestures.release();
        keepOpenArmedForRecording = false;
        pttCompletionDeferred = false;
      }
      // Wait until the physical re-paste chord is fully released. Sending
      // Ctrl+V while its Ctrl/Alt keys are still held turns the injected paste
      // back into the re-paste chord in the target application.
      if (!keepOpenArmedForRecording && repaste.completed) repasteLast();
      if (!keepOpenArmedForRecording && commit.completed) commitOpenTurn();
      if (!keepOpenArmedForRecording && scratch.completed) scratchLastFragment();
      if (!keepOpenArmedForRecording && discard.completed) discardOpenTurn();
    });
    await windowsHost.start();
    await initializePipeline();
    if (turnDraftNativeE2e) {
      turnDraftWindow?.setTitle("Undertone open turn native test");
      const updateDraft = (): void => {
        const snapshot = turnBuffer.snapshot();
        if (snapshot !== null) return;
        const text = "Full-app native test fragment. ";
        turnBuffer.append(text, text, "live-full");
        publishTurnDraft();
      };
      updateDraft();
      setInterval(updateDraft, 250);
    }
    await initializeDeveloperController();
    if (!managedDev) createTray();
    updateTrayTooltip();
    const sttConfigured = config.provider === "local"
      || providerKey(config, config.provider).trim().length > 0;
    if (!turnDraftNativeE2e && (packagedSmoke || !sttConfigured)) openSettings();
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
      : provider === "openai-subscription" ? "OpenAI Subscription"
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

function openAiCredentials(config: UndertoneConfig): OpenAiSubscriptionCredentials | null {
  return config.openai_oauth_access_token.length > 0
    && config.openai_oauth_refresh_token.length > 0
    && config.openai_oauth_account_id.length > 0
    && Number.isFinite(config.openai_oauth_expires_at)
    && config.openai_oauth_expires_at > 0
    ? {
        accessToken: config.openai_oauth_access_token,
        refreshToken: config.openai_oauth_refresh_token,
        expiresAt: config.openai_oauth_expires_at,
        accountId: config.openai_oauth_account_id,
      }
    : null;
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

function toFloat32Array(value: unknown): Float32Array | null {
  if (value instanceof ArrayBuffer
    && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    return new Float32Array(value.slice(0));
  }
  if (ArrayBuffer.isView(value) && value.byteLength % Float32Array.BYTES_PER_ELEMENT === 0) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
    return new Float32Array(bytes.buffer);
  }
  return null;
}

function liveTranscriptionEnabled(config: UndertoneConfig): boolean {
  return config.live_transcription
    && (config.provider === "openai" || config.provider === "xai");
}

function actionShortcut(shortcut: string): string {
  try {
    return actionShortcutsOverlap(shortcut, KEEP_OPEN_SHORTCUT) ? "" : shortcut;
  } catch {
    return shortcut;
  }
}

function liveVocabulary(config: UndertoneConfig): unknown[] {
  if (!config.stt_vocab_hints) return [];
  const values: unknown[] = Array.isArray(config.vocabulary) ? [...config.vocabulary] : [];
  if (isRecord(config.corrections)) {
    for (const correction of Object.values(config.corrections)) {
      if (typeof correction === "string" && !values.includes(correction)) values.push(correction);
    }
  }
  return values;
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
