export type SettingsProviderId = "xai" | "openai" | "openrouter" | "local";
export type CloudProviderId = Exclude<SettingsProviderId, "local">;
export type LocalEngineKind = "stt" | "cleanup";
export type LocalEngineAction = "install" | "load" | "eject";
export type ShortcutSetting = "hotkey" | "repasteHotkey";

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
  smartFormatting: boolean;
  aiCleanup: boolean;
  restoreClipboard: boolean;
  hotkey: string;
  repasteHotkey: string;
  inputDevice: string;
  microphones: string[];
  appVersion: string;
  preview: boolean;
  provider: SettingsProviderId;
  cleanupProvider: SettingsProviderId;
  keyConfigured: Record<CloudProviderId, boolean>;
  sttModel: string;
  cleanupModel: string;
  localLoaded: boolean;
  localIdleMinutes: number;
  localEngines: Record<LocalEngineKind, LocalEngineSnapshot>;
}

export interface SettingsPatch {
  language?: string;
  smartFormatting?: boolean;
  aiCleanup?: boolean;
  restoreClipboard?: boolean;
  hotkey?: string;
  repasteHotkey?: string;
  inputDevice?: string;
  provider?: SettingsProviderId;
  cleanupProvider?: SettingsProviderId;
  providerKey?: { provider: CloudProviderId; value: string };
  sttModel?: { provider: SettingsProviderId; value: string };
  cleanupModel?: { provider: SettingsProviderId; value: string };
  localLoaded?: boolean;
  localIdleMinutes?: number;
}

export interface SettingsApi {
  load(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsSnapshot>;
  captureShortcut(field: ShortcutSetting): Promise<SettingsSnapshot>;
  localAction(kind: LocalEngineKind, action: LocalEngineAction): Promise<SettingsSnapshot>;
}
