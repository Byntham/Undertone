const { contextBridge } = require("electron");

const versionPrefix = "--undertone-capture-version=";
const versionArgument = process.argv.find((argument) => argument.startsWith(versionPrefix));
if (versionArgument === undefined) throw new Error("Capture app version is missing");
const appVersion = versionArgument.slice(versionPrefix.length);

const snapshot = {
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
  localSttEngine: "whisper",
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

const history = [
  { id: 2, ok: true, text: "Undertone is ready.", error: null, timestamp: Date.now(), retryable: false },
  { id: 1, ok: false, text: "", error: "A provider request timed out", timestamp: Date.now() - 60_000, retryable: true },
];

const unexpected = (name) => async () => {
  throw new Error(`${name} is not available in the settings capture`);
};

contextBridge.exposeInMainWorld("undertoneSettings", {
  load: async () => snapshot,
  update: unexpected("Updating settings"),
  setStartWithWindows: unexpected("Changing autostart"),
  captureShortcut: unexpected("Capturing shortcuts"),
  localAction: unexpected("Changing local engines"),
  history: async () => history,
  historyAction: unexpected("Changing history"),
  systemAction: unexpected("Opening system files"),
  providerTest: unexpected("Testing providers"),
  openAiSubscriptionAction: unexpected("Changing the OpenAI subscription"),
  microphoneTest: unexpected("Testing the microphone"),
  updateStatus: async () => updateStatus,
  checkForUpdates: unexpected("Checking for updates"),
  installUpdate: unexpected("Installing updates"),
  onUpdateStatus: () => () => undefined,
});
