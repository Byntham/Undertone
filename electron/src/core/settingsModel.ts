import { normalizeConfig, type UndertoneConfig } from "./config";
import type { SettingsPatch, SettingsSnapshot } from "../shared/settings";

const PATCH_FIELDS = new Set([
  "language",
  "smartFormatting",
  "aiCleanup",
  "restoreClipboard",
]);

export function settingsSnapshot(
  config: UndertoneConfig,
  appVersion: string,
  preview: boolean,
): SettingsSnapshot {
  return {
    language: config.language,
    smartFormatting: config.smart_formatting,
    aiCleanup: config.ai_cleanup,
    restoreClipboard: config.restore_clipboard,
    hotkey: config.hotkey,
    appVersion,
    preview,
  };
}

export function applySettingsPatch(
  config: UndertoneConfig,
  value: unknown,
): UndertoneConfig {
  if (!isRecord(value)) throw new Error("Settings update must be an object");
  for (const key of Object.keys(value)) {
    if (!PATCH_FIELDS.has(key)) throw new Error(`Unsupported settings field: ${key}`);
  }
  const next = normalizeConfig(config);
  if (value.language !== undefined) {
    if (typeof value.language !== "string"
      || value.language.length < 2
      || value.language.length > 16
      || !/^[A-Za-z-]+$/u.test(value.language)) {
      throw new Error("Invalid transcription language");
    }
    next.language = value.language;
  }
  if (value.smartFormatting !== undefined) {
    next.smart_formatting = booleanField(value.smartFormatting, "smartFormatting");
  }
  if (value.aiCleanup !== undefined) {
    next.ai_cleanup = booleanField(value.aiCleanup, "aiCleanup");
  }
  if (value.restoreClipboard !== undefined) {
    next.restore_clipboard = booleanField(value.restoreClipboard, "restoreClipboard");
  }
  return next;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
