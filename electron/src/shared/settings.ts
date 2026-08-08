export type SettingsProviderId = "xai" | "openai" | "openai-subscription" | "openrouter" | "local";
export type CloudProviderId = "xai" | "openai" | "openrouter";
export type ModelProviderId = CloudProviderId | "openai-subscription";
export type TranscriptionProviderId = CloudProviderId | "local";
export type CleanupProviderId = ModelProviderId | "local";
export type OpenAiSubscriptionAction = "connect" | "disconnect";
export type LocalEngineKind = "stt" | "cleanup";
export type LocalEngineAction = "install" | "load" | "eject";
export type ShortcutSetting =
  | "hotkey"
  | "repasteHotkey"
  | "commitHotkey"
  | "scratchHotkey"
  | "discardHotkey";
export type OpenTurnCleanupStrategySetting =
  | "live-full"
  | "commit-full";
export type HistoryAction = "copy" | "repaste" | "retry";
export type SystemAction = "openSettingsFolder" | "openLog";
export type ProviderTestKind = "stt" | "cleanup";
export type AppUpdatePhase =
  | "unavailable"
  | "idle"
  | "checking"
  | "downloading"
  | "up-to-date"
  | "downloaded"
  | "error";

export interface AppUpdateSnapshot {
  supported: boolean;
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  progress: number | null;
  message: string;
}

export interface LocalEngineSnapshot {
  installed: boolean;
  loaded: boolean;
  loading: boolean;
  build: "cpu" | "cuda" | null;
  installing: boolean;
  installPhase: string;
  installFraction: number;
  installBytes: number;
}

export interface SettingsSnapshot {
  language: string;
  aiCleanup: boolean;
  restoreClipboard: boolean;
  soundCues: boolean;
  startWithWindows: boolean;
  hotkey: string;
  repasteHotkey: string;
  commitHotkey: string;
  scratchHotkey: string;
  discardHotkey: string;
  shortcutWarning: string | null;
  liveTranscription: boolean;
  openTurnCleanupStrategy: OpenTurnCleanupStrategySetting;
  inputDevice: string;
  microphones: string[];
  appVersion: string;
  preview: boolean;
  provider: TranscriptionProviderId;
  cleanupProvider: CleanupProviderId;
  keyConfigured: Record<CloudProviderId, boolean>;
  openAiSubscriptionConnected: boolean;
  sttModel: string;
  cleanupModel: string;
  localLoaded: boolean;
  localIdleMinutes: number;
  sttVocabHints: boolean;
  vocabulary: string[];
  corrections: Record<string, string>;
  localEngines: Record<LocalEngineKind, LocalEngineSnapshot>;
}

export interface HistorySnapshotEntry {
  id: number;
  ok: boolean;
  text: string;
  error: string | null;
  timestamp: number;
  retryable: boolean;
}

export interface SettingsPatch {
  language?: string;
  aiCleanup?: boolean;
  restoreClipboard?: boolean;
  soundCues?: boolean;
  startWithWindows?: boolean;
  hotkey?: string;
  repasteHotkey?: string;
  commitHotkey?: string;
  scratchHotkey?: string;
  discardHotkey?: string;
  liveTranscription?: boolean;
  openTurnCleanupStrategy?: OpenTurnCleanupStrategySetting;
  inputDevice?: string;
  provider?: TranscriptionProviderId;
  cleanupProvider?: CleanupProviderId;
  providerKey?: { provider: CloudProviderId; value: string };
  localLoaded?: boolean;
  localIdleMinutes?: number;
  sttVocabHints?: boolean;
  vocabulary?: string[];
  corrections?: Record<string, string>;
}

export interface SettingsApi {
  load(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsSnapshot>;
  captureShortcut(field: ShortcutSetting): Promise<SettingsSnapshot>;
  localAction(kind: LocalEngineKind, action: LocalEngineAction): Promise<SettingsSnapshot>;
  history(): Promise<HistorySnapshotEntry[]>;
  historyAction(id: number, action: HistoryAction): Promise<void>;
  systemAction(action: SystemAction): Promise<void>;
  providerTest(kind: ProviderTestKind): Promise<string>;
  openAiSubscriptionAction(action: OpenAiSubscriptionAction): Promise<SettingsSnapshot>;
  microphoneTest(): Promise<number>;
  updateStatus(): Promise<AppUpdateSnapshot>;
  checkForUpdates(): Promise<AppUpdateSnapshot>;
  installUpdate(): Promise<void>;
  onUpdateStatus(listener: (snapshot: AppUpdateSnapshot) => void): () => void;
}
