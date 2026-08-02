export type SettingsProviderId = "xai" | "openai" | "openrouter" | "local";
export type CloudProviderId = Exclude<SettingsProviderId, "local">;

export interface SettingsSnapshot {
  language: string;
  smartFormatting: boolean;
  aiCleanup: boolean;
  restoreClipboard: boolean;
  hotkey: string;
  appVersion: string;
  preview: boolean;
  provider: SettingsProviderId;
  cleanupProvider: SettingsProviderId;
  keyConfigured: Record<CloudProviderId, boolean>;
  sttModel: string;
  cleanupModel: string;
}

export interface SettingsPatch {
  language?: string;
  smartFormatting?: boolean;
  aiCleanup?: boolean;
  restoreClipboard?: boolean;
  provider?: SettingsProviderId;
  cleanupProvider?: SettingsProviderId;
  providerKey?: { provider: CloudProviderId; value: string };
  sttModel?: { provider: SettingsProviderId; value: string };
  cleanupModel?: { provider: SettingsProviderId; value: string };
}

export interface SettingsApi {
  load(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsSnapshot>;
}
