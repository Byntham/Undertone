export interface SettingsSnapshot {
  language: string;
  smartFormatting: boolean;
  aiCleanup: boolean;
  restoreClipboard: boolean;
  hotkey: string;
  appVersion: string;
  preview: boolean;
}

export interface SettingsPatch {
  language?: string;
  smartFormatting?: boolean;
  aiCleanup?: boolean;
  restoreClipboard?: boolean;
}

export interface SettingsApi {
  load(): Promise<SettingsSnapshot>;
  update(patch: SettingsPatch): Promise<SettingsSnapshot>;
}
