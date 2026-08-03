export const APP_VERSION = "1.5.0";
export const APP_NAME = "Undertone";
export const LEGACY_APP_NAME = "PushToTalkSTT";

export type ProviderId = "xai" | "openai" | "openrouter" | "local";
export type ConfigRecord = Record<string, unknown>;

export interface UndertoneConfig extends ConfigRecord {
  api_key: string;
  openai_api_key: string;
  openrouter_api_key: string;
  hotkey: string;
  language: string;
  restore_clipboard: boolean;
  sample_rate: number;
  input_device: string;
  onboarded: boolean;
  provider: ProviderId;
  stt_models: Record<string, string>;
  smart_formatting: boolean;
  ai_cleanup: boolean;
  cleanup_provider: ProviderId;
  cleanup_models: Record<string, string>;
  sound_cues: boolean;
  vocabulary: string[];
  corrections: Record<string, string>;
  stt_vocab_hints: boolean;
  toggle_hotkey: string;
  repaste_hotkey: string;
  local_loaded: boolean;
  local_idle_minutes: number;
  cleanup_timeout: number;
  cleanup_prompt: string;
  cleanup_prompts: Record<string, string>;
}

export const DEFAULT_CONFIG: Readonly<UndertoneConfig> = {
  api_key: "",
  openai_api_key: "",
  openrouter_api_key: "",
  hotkey: "right ctrl",
  language: "en",
  restore_clipboard: true,
  sample_rate: 16_000,
  input_device: "",
  onboarded: false,
  provider: "xai",
  stt_models: {},
  smart_formatting: true,
  ai_cleanup: true,
  cleanup_provider: "xai",
  cleanup_models: {},
  sound_cues: true,
  vocabulary: [],
  corrections: {},
  stt_vocab_hints: true,
  toggle_hotkey: "",
  repaste_hotkey: "ctrl+alt+v",
  local_loaded: false,
  local_idle_minutes: 0,
  cleanup_timeout: 2.5,
  cleanup_prompt: "",
  cleanup_prompts: {},
};

export const KEY_FIELDS = {
  xai: "api_key",
  openai: "openai_api_key",
  openrouter: "openrouter_api_key",
} as const;

const LEGACY_XAI_CLEANUP = "grok-4.20-0309-non-reasoning";

export function normalizeConfig(value: unknown): UndertoneConfig {
  const config = cloneConfig(DEFAULT_CONFIG) as UndertoneConfig;
  if (isRecord(value)) Object.assign(config, value);
  delete config.dev_mode;
  cloneContainers(config);
  foldLegacyModels(config);
  foldLegacyLocal(config);
  return config;
}

export function foldLegacyModels(config: ConfigRecord): void {
  const sttModel = takeString(config, "stt_model");
  const cleanupModel = takeString(config, "cleanup_model");
  const sttModels = ensureStringMap(config, "stt_models");
  const cleanupModels = ensureStringMap(config, "cleanup_models");
  if (sttModel.length > 0) {
    const provider = stringValue(config.provider, "xai");
    if (sttModels[provider] === undefined) sttModels[provider] = sttModel;
  }
  if (cleanupModel.length > 0 && cleanupModel !== LEGACY_XAI_CLEANUP) {
    const provider = stringValue(config.cleanup_provider, "xai");
    if (cleanupModels[provider] === undefined) cleanupModels[provider] = cleanupModel;
  }
}

export function foldLegacyLocal(config: ConfigRecord): void {
  const sttLoaded = Boolean(take(config, "local_stt_loaded") ?? false);
  const llmLoaded = Boolean(take(config, "local_llm_loaded") ?? false);
  const sttIdle = take(config, "local_stt_idle_minutes") ?? 0;
  const llmIdle = take(config, "local_llm_idle_minutes") ?? 0;
  if ((sttLoaded || llmLoaded) && !config.local_loaded) config.local_loaded = true;
  if (!config.local_idle_minutes && (sttIdle || llmIdle)) {
    config.local_idle_minutes = sttIdle || llmIdle;
  }
}

export function providerKey(config: ConfigRecord, provider: string): string {
  const field = KEY_FIELDS[provider as keyof typeof KEY_FIELDS];
  if (field === undefined) return "";
  return typeof config[field] === "string" ? config[field] : "";
}

export function modelOverride(
  config: ConfigRecord,
  kind: "stt" | "cleanup",
  provider: string,
): string {
  const models = config[`${kind}_models`];
  if (!isRecord(models)) return "";
  return typeof models[provider] === "string" ? models[provider] : "";
}

export function cloneConfig(config: Readonly<ConfigRecord>): ConfigRecord {
  const clone = { ...config };
  cloneContainers(clone);
  return clone;
}

function cloneContainers(config: ConfigRecord): void {
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) config[key] = [...value];
    else if (isRecord(value)) config[key] = { ...value };
  }
}

function ensureStringMap(config: ConfigRecord, key: string): Record<string, string> {
  const value = config[key];
  if (isRecord(value)) return value as Record<string, string>;
  const replacement: Record<string, string> = {};
  config[key] = replacement;
  return replacement;
}

function take(config: ConfigRecord, key: string): unknown {
  const value = config[key];
  delete config[key];
  return value;
}

function takeString(config: ConfigRecord, key: string): string {
  const value = take(config, key);
  return typeof value === "string" ? value : "";
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

export function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
