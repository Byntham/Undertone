export type ProviderId = "xai" | "openai" | "openai-subscription" | "openrouter" | "local";
export type DictationMode = "stack" | "instant";
export type StackCleanupStrategy = "live-full" | "commit-full";
export type CleanupReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type CleanupServiceTier = "default" | "priority";
export type ConfigRecord = Record<string, unknown>;

export interface UndertoneConfig extends ConfigRecord {
  api_key: string;
  openai_api_key: string;
  openai_oauth_access_token: string;
  openai_oauth_refresh_token: string;
  openai_oauth_expires_at: number;
  openai_oauth_account_id: string;
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
  commit_hotkey: string;
  scratch_hotkey: string;
  discard_hotkey: string;
  dictation_mode: DictationMode;
  stack_cleanup_strategy: StackCleanupStrategy;
  local_loaded: boolean;
  local_idle_minutes: number;
  cleanup_timeout: number;
  cleanup_reasoning_effort: CleanupReasoningEffort;
  cleanup_service_tier: CleanupServiceTier;
  cleanup_prompt: string;
  cleanup_prompts: Record<string, string>;
}

export const DEFAULT_CONFIG: Readonly<UndertoneConfig> = {
  api_key: "",
  openai_api_key: "",
  openai_oauth_access_token: "",
  openai_oauth_refresh_token: "",
  openai_oauth_expires_at: 0,
  openai_oauth_account_id: "",
  openrouter_api_key: "",
  hotkey: "left ctrl+left windows",
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
  repaste_hotkey: "left alt+v",
  commit_hotkey: "left ctrl+left alt",
  scratch_hotkey: "left ctrl+left alt+backspace",
  discard_hotkey: "ctrl+alt+shift+backspace",
  dictation_mode: "stack",
  stack_cleanup_strategy: "live-full",
  local_loaded: false,
  local_idle_minutes: 0,
  cleanup_timeout: 2.5,
  cleanup_reasoning_effort: "none",
  cleanup_service_tier: "priority",
  cleanup_prompt: "",
  cleanup_prompts: {},
};

export const KEY_FIELDS = {
  xai: "api_key",
  openai: "openai_api_key",
  openrouter: "openrouter_api_key",
} as const;

export const SECRET_FIELDS = [
  ...Object.values(KEY_FIELDS),
  "openai_oauth_access_token",
  "openai_oauth_refresh_token",
  "openai_oauth_account_id",
] as const;

export function normalizeConfig(value: unknown): UndertoneConfig {
  const config = cloneConfig(DEFAULT_CONFIG);
  if (isRecord(value)) {
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) config[key] = value[key];
    }
  }
  cloneContainers(config);
  const sttModels = ensureStringMap(config, "stt_models");
  const cleanupModels = ensureStringMap(config, "cleanup_models");
  delete sttModels.local;
  delete cleanupModels.local;
  if (!isTranscriptionProvider(config.provider)) config.provider = DEFAULT_CONFIG.provider;
  if (!isCleanupProvider(config.cleanup_provider)) {
    config.cleanup_provider = DEFAULT_CONFIG.cleanup_provider;
  }
  if (config.dictation_mode !== "stack" && config.dictation_mode !== "instant") {
    config.dictation_mode = DEFAULT_CONFIG.dictation_mode;
  }
  if (config.stack_cleanup_strategy !== "live-full"
    && config.stack_cleanup_strategy !== "commit-full") {
    config.stack_cleanup_strategy = DEFAULT_CONFIG.stack_cleanup_strategy;
  }
  if (!CLEANUP_REASONING_EFFORTS.has(config.cleanup_reasoning_effort)) {
    config.cleanup_reasoning_effort = DEFAULT_CONFIG.cleanup_reasoning_effort;
  }
  if ((config.cleanup_service_tier as unknown) === "fast") {
    config.cleanup_service_tier = "priority";
  } else if (config.cleanup_service_tier !== "default"
    && config.cleanup_service_tier !== "priority") {
    config.cleanup_service_tier = DEFAULT_CONFIG.cleanup_service_tier;
  }
  if (typeof config.commit_hotkey !== "string") {
    config.commit_hotkey = DEFAULT_CONFIG.commit_hotkey;
  }
  if (typeof config.scratch_hotkey !== "string") {
    config.scratch_hotkey = DEFAULT_CONFIG.scratch_hotkey;
  }
  if (typeof config.discard_hotkey !== "string") {
    config.discard_hotkey = DEFAULT_CONFIG.discard_hotkey;
  }
  return config as UndertoneConfig;
}

function isTranscriptionProvider(value: unknown): value is Exclude<ProviderId, "openai-subscription"> {
  return value === "xai" || value === "openai" || value === "openrouter" || value === "local";
}

function isCleanupProvider(value: unknown): value is ProviderId {
  return isTranscriptionProvider(value) || value === "openai-subscription";
}

export const CLEANUP_REASONING_EFFORTS = new Set<unknown>([
  "none", "low", "medium", "high", "xhigh", "max",
]);

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
