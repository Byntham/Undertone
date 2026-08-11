const { contextBridge } = require("electron");

const versionPrefix = "--undertone-capture-version=";
const versionArgument = process.argv.find((argument) => argument.startsWith(versionPrefix));
if (versionArgument === undefined) throw new Error("Capture app version is missing");
const appVersion = versionArgument.slice(versionPrefix.length);

let snapshot = {
  language: "en",
  aiCleanup: true,
  restoreClipboard: true,
  soundCues: true,
  startWithWindows: false,
  hotkey: "left ctrl+left windows",
  repasteHotkey: "left alt+v",
  commitHotkey: "left ctrl+left alt",
  scratchHotkey: "left ctrl+left alt+backspace",
  discardHotkey: "ctrl+alt+shift+backspace",
  shortcutWarning: null,
  liveTranscription: false,
  openTurnCleanupStrategy: "live-full",
  inputDevice: "",
  microphones: ["Microphone Array (Realtek Audio)", "USB Podcast Mic"],
  appVersion,
  provider: "openai",
  cleanupProvider: "openai-subscription",
  keyConfigured: { xai: false, openai: true, openrouter: false },
  openAiSubscriptionConnected: true,
  sttModel: "gpt-transcribe",
  cleanupModel: "gpt-5.6-luna",
  localLoaded: false,
  localIdleMinutes: 0,
  sttVocabHints: true,
  vocabulary: ["Undertone", "Kubernetes"],
  corrections: { "under tone": "Undertone" },
  localEngines: {
    stt: {
      installed: true,
      loaded: false,
      loading: false,
      build: null,
      installing: false,
      installPhase: "",
      installFraction: 0,
      installBytes: 0,
    },
    cleanup: {
      installed: false,
      loaded: false,
      loading: false,
      build: null,
      installing: false,
      installPhase: "",
      installFraction: 0,
      installBytes: 3_155_769_803,
    },
  },
};

const updateStatus = {
  supported: false,
  phase: "unavailable",
  currentVersion: appVersion,
  availableVersion: null,
  progress: null,
  message: "Update checks are available in the installed app.",
};

contextBridge.exposeInMainWorld("undertoneSettings", {
  load: async () => snapshot,
  update: async (patch) => {
    if (patch.providerKey !== undefined) {
      snapshot = {
        ...snapshot,
        keyConfigured: {
          ...snapshot.keyConfigured,
          [patch.providerKey.provider]: patch.providerKey.value.trim().length > 0,
        },
      };
    }
    const { providerKey: _providerKey, ...plain } = patch;
    snapshot = { ...snapshot, ...plain };
    return snapshot;
  },
  setStartWithWindows: async (enabled) => {
    snapshot = { ...snapshot, startWithWindows: enabled };
    return snapshot;
  },
  captureShortcut: async () => snapshot,
  localAction: async () => snapshot,
  history: async () => [
    { id: 2, ok: true, text: "Undertone is ready.", error: null, timestamp: Date.now(), retryable: false },
    { id: 1, ok: false, text: "", error: "A provider request timed out", timestamp: Date.now() - 60_000, retryable: true },
  ],
  historyAction: async () => undefined,
  systemAction: async () => undefined,
  providerTest: async (kind) => `${kind} works`,
  openAiSubscriptionAction: async (action) => {
    snapshot = { ...snapshot, openAiSubscriptionConnected: action === "connect" };
    return snapshot;
  },
  microphoneTest: async () => 0.18,
  updateStatus: async () => updateStatus,
  checkForUpdates: async () => updateStatus,
  installUpdate: async () => { throw new Error(updateStatus.message); },
  onUpdateStatus: () => () => undefined,
});
