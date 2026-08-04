export type ProviderId = "xai" | "openai" | "openrouter" | "local";
export type ConfigRecord = Record<string, unknown>;

export interface UndertoneConfig extends ConfigRecord {
  api_key: string;
  openai_api_key: string;
  openrouter_api_key: string;
  hotkey: string;
  language: string;
  restore_clipboard: boolean;
  input_device: string;
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
  input_device: "",
  provider: "local",
  stt_models: {},
  smart_formatting: true,
  ai_cleanup: true,
  cleanup_provider: "local",
  cleanup_models: {},
  sound_cues: true,
  vocabulary: [],
  corrections: {},
  stt_vocab_hints: true,
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

export function normalizeConfig(value: unknown): UndertoneConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  if (isRecord(value)) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) config[key] = value[key];
    }
  }
  cloneContainers(config);
  ensureStringMap(config, "stt_models");
  ensureStringMap(config, "cleanup_models");
  return config as UndertoneConfig;
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

export function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
