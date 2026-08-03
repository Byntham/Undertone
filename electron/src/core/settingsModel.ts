import {
  KEY_FIELDS,
  modelOverride,
  normalizeConfig,
  providerKey,
  type ProviderId,
  type UndertoneConfig,
} from "./config";
import type {
  CloudProviderId,
  LocalEngineSnapshot,
  SettingsPatch,
  SettingsSnapshot,
} from "../shared/settings";
import { normalizeShortcut } from "./shortcuts";

const PATCH_FIELDS = new Set([
  "language",
  "smartFormatting",
  "aiCleanup",
  "restoreClipboard",
  "soundCues",
  "startWithWindows",
  "onboarded",
  "hotkey",
  "repasteHotkey",
  "inputDevice",
  "provider",
  "cleanupProvider",
  "providerKey",
  "sttModel",
  "cleanupModel",
  "localLoaded",
  "localIdleMinutes",
  "sttVocabHints",
  "vocabulary",
  "corrections",
  "devMode",
  "cleanupTimeout",
  "cleanupPrompt",
  "cleanupPrompts",
]);

const PROVIDERS = new Set<ProviderId>(["xai", "openai", "openrouter", "local"]);
const CLOUD_PROVIDERS = new Set<CloudProviderId>(["xai", "openai", "openrouter"]);

export function settingsSnapshot(
  config: UndertoneConfig,
  appVersion: string,
  preview: boolean,
  localEngines: {
    stt: LocalEngineSnapshot;
    cleanup: LocalEngineSnapshot;
  } = EMPTY_LOCAL_ENGINES,
  microphones: readonly string[] = [],
  startWithWindows = false,
): SettingsSnapshot {
  const provider = snapshotProvider(config.provider);
  const cleanupProvider = snapshotProvider(config.cleanup_provider);
  return {
    language: config.language,
    smartFormatting: config.smart_formatting,
    aiCleanup: config.ai_cleanup,
    restoreClipboard: config.restore_clipboard,
    soundCues: config.sound_cues,
    startWithWindows,
    onboarded: config.onboarded,
    hotkey: config.hotkey,
    repasteHotkey: config.repaste_hotkey,
    inputDevice: config.input_device,
    microphones: [...microphones],
    appVersion,
    preview,
    provider,
    cleanupProvider,
    keyConfigured: {
      xai: providerKey(config, "xai").trim().length > 0,
      openai: providerKey(config, "openai").trim().length > 0,
      openrouter: providerKey(config, "openrouter").trim().length > 0,
    },
    sttModel: modelOverride(config, "stt", provider),
    cleanupModel: modelOverride(config, "cleanup", cleanupProvider),
    localLoaded: config.local_loaded,
    localIdleMinutes: config.local_idle_minutes,
    sttVocabHints: config.stt_vocab_hints,
    vocabulary: [...config.vocabulary],
    corrections: { ...config.corrections },
    devMode: config.dev_mode,
    cleanupTimeout: config.cleanup_timeout,
    cleanupPrompt: config.cleanup_prompt,
    cleanupPrompts: { ...config.cleanup_prompts },
    localEngines: {
      stt: { ...localEngines.stt },
      cleanup: { ...localEngines.cleanup },
    },
  };
}

function snapshotProvider(value: unknown): ProviderId {
  return typeof value === "string" && PROVIDERS.has(value as ProviderId)
    ? value as ProviderId
    : "xai";
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
  if (value.soundCues !== undefined) {
    next.sound_cues = booleanField(value.soundCues, "soundCues");
  }
  if (value.startWithWindows !== undefined) {
    booleanField(value.startWithWindows, "startWithWindows");
  }
  if (value.onboarded !== undefined) {
    next.onboarded = booleanField(value.onboarded, "onboarded");
  }
  let shortcutChanged = false;
  if (value.hotkey !== undefined) {
    if (typeof value.hotkey !== "string") throw new Error("hotkey must be a string");
    next.hotkey = normalizeShortcut(value.hotkey);
    shortcutChanged = true;
  }
  if (value.repasteHotkey !== undefined) {
    if (typeof value.repasteHotkey !== "string") {
      throw new Error("repasteHotkey must be a string");
    }
    next.repaste_hotkey = normalizeShortcut(value.repasteHotkey, true);
    shortcutChanged = true;
  }
  if (shortcutChanged) validateDistinctShortcuts(next);
  if (value.inputDevice !== undefined) {
    next.input_device = boundedSingleLine(value.inputDevice, "inputDevice", 512);
  }
  if (value.provider !== undefined) {
    next.provider = providerField(value.provider, "provider");
  }
  if (value.cleanupProvider !== undefined) {
    next.cleanup_provider = providerField(value.cleanupProvider, "cleanupProvider");
  }
  if (value.providerKey !== undefined) {
    const update = providerKeyUpdate(value.providerKey);
    next[KEY_FIELDS[update.provider]] = update.value;
  }
  if (value.sttModel !== undefined) {
    const update = modelUpdate(value.sttModel, "sttModel");
    setModelOverride(next.stt_models, update.provider, update.value);
  }
  if (value.cleanupModel !== undefined) {
    const update = modelUpdate(value.cleanupModel, "cleanupModel");
    setModelOverride(next.cleanup_models, update.provider, update.value);
  }
  if (value.localLoaded !== undefined) {
    next.local_loaded = booleanField(value.localLoaded, "localLoaded");
  }
  if (value.localIdleMinutes !== undefined) {
    if (typeof value.localIdleMinutes !== "number"
      || ![0, 5, 15, 30, 60].includes(value.localIdleMinutes)) {
      throw new Error("localIdleMinutes is invalid");
    }
    next.local_idle_minutes = value.localIdleMinutes;
  }
  if (value.sttVocabHints !== undefined) {
    next.stt_vocab_hints = booleanField(value.sttVocabHints, "sttVocabHints");
  }
  if (value.vocabulary !== undefined) {
    next.vocabulary = stringList(value.vocabulary, "vocabulary", 200, 256);
  }
  if (value.corrections !== undefined) {
    next.corrections = stringMap(value.corrections, "corrections", 200, 256);
  }
  if (value.devMode !== undefined) {
    next.dev_mode = booleanField(value.devMode, "devMode");
  }
  if (value.cleanupTimeout !== undefined) {
    if (typeof value.cleanupTimeout !== "number"
      || !Number.isFinite(value.cleanupTimeout)
      || value.cleanupTimeout < 0.5
      || value.cleanupTimeout > 30) {
      throw new Error("cleanupTimeout must be between 0.5 and 30 seconds");
    }
    next.cleanup_timeout = value.cleanupTimeout;
  }
  if (value.cleanupPrompt !== undefined) {
    if (typeof value.cleanupPrompt !== "string" || value.cleanupPrompt.length > 40_000) {
      throw new Error("cleanupPrompt is invalid");
    }
    next.cleanup_prompt = value.cleanupPrompt.trim();
  }
  if (value.cleanupPrompts !== undefined) {
    next.cleanup_prompts = textMap(value.cleanupPrompts, "cleanupPrompts", 50, 40_000);
  }
  return next;
}

const EMPTY_LOCAL_ENGINE: LocalEngineSnapshot = {
  installed: false,
  loaded: false,
  loading: false,
  build: null,
  installing: false,
  installPhase: "",
  installFraction: 0,
  installBytes: 0,
};

const EMPTY_LOCAL_ENGINES = {
  stt: EMPTY_LOCAL_ENGINE,
  cleanup: EMPTY_LOCAL_ENGINE,
};

function providerField(value: unknown, name: string): ProviderId {
  if (typeof value !== "string" || !PROVIDERS.has(value as ProviderId)) {
    throw new Error(`${name} is not a supported provider`);
  }
  return value as ProviderId;
}

function providerKeyUpdate(value: unknown): { provider: CloudProviderId; value: string } {
  exactObject(value, ["provider", "value"], "providerKey");
  if (typeof value.provider !== "string"
    || !CLOUD_PROVIDERS.has(value.provider as CloudProviderId)) {
    throw new Error("providerKey has an unsupported provider");
  }
  const secret = boundedSingleLine(value.value, "providerKey.value", 4_096);
  return { provider: value.provider as CloudProviderId, value: secret };
}

function modelUpdate(
  value: unknown,
  name: string,
): { provider: ProviderId; value: string } {
  exactObject(value, ["provider", "value"], name);
  return {
    provider: providerField(value.provider, `${name}.provider`),
    value: boundedSingleLine(value.value, `${name}.value`, 512),
  };
}

function boundedSingleLine(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  const result = value.trim();
  if (result.length > maxLength || /[\r\n\0]/u.test(result)) {
    throw new Error(`${name} is invalid`);
  }
  return result;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  name: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${name} must be an object`);
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || fields.some((key) => !(key in value))) {
    throw new Error(`${name} has invalid fields`);
  }
}

function setModelOverride(
  models: Record<string, string>,
  provider: ProviderId,
  value: string,
): void {
  if (value.length === 0) delete models[provider];
  else models[provider] = value;
}

function booleanField(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function stringList(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) {
    throw new Error(`${name} is invalid`);
  }
  const result: string[] = [];
  for (const item of value) {
    const normalized = boundedSingleLine(item, name, maximumLength);
    if (normalized.length > 0 && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function stringMap(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength: number,
): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximumEntries) {
    throw new Error(`${name} is invalid`);
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = boundedSingleLine(key, `${name}.key`, maximumLength);
    const normalizedValue = boundedSingleLine(child, `${name}.value`, maximumLength);
    if (normalizedKey.length === 0 || normalizedValue.length === 0) {
      throw new Error(`${name} entries cannot be empty`);
    }
    result[normalizedKey] = normalizedValue;
  }
  return result;
}

function textMap(
  value: unknown,
  name: string,
  maximumEntries: number,
  maximumLength: number,
): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximumEntries) {
    throw new Error(`${name} is invalid`);
  }
  const result: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = boundedSingleLine(key, `${name}.key`, 128);
    if (normalizedKey.length === 0) throw new Error(`${name} is invalid`);
    if (typeof child !== "string" || child.trim().length === 0 || child.length > maximumLength) {
      throw new Error(`${name} is invalid`);
    }
    result[normalizedKey] = child.trim();
  }
  return result;
}

function validateDistinctShortcuts(config: UndertoneConfig): void {
  const bindings = [config.hotkey, config.repaste_hotkey, config.toggle_hotkey]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (new Set(bindings).size !== bindings.length) {
    throw new Error("That shortcut is already assigned to another action");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
