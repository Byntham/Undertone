import {
  isCleanupProvider,
  isTranscriptionProvider,
  type CleanupProviderId,
  type LocalSttEngineId,
  type OpenTurnCleanupStrategy,
  type TranscriptionProviderId,
} from "../shared/settings";

export type CleanupReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type CleanupServiceTier = "default" | "priority";
export type ConfigRecord = Record<string, unknown>;

export interface UndertoneConfig {
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
  provider: TranscriptionProviderId;
  local_stt_engine: LocalSttEngineId;
  ai_cleanup: boolean;
  cleanup_provider: CleanupProviderId;
  sound_cues: boolean;
  vocabulary: string[];
  corrections: Record<string, string>;
  stt_vocab_hints: boolean;
  repaste_hotkey: string;
  commit_hotkey: string;
  scratch_hotkey: string;
  discard_hotkey: string;
  live_transcription: boolean;
  local_preview_diagnostics: boolean;
  // Keep the persisted key for compatibility with existing config files.
  stack_cleanup_strategy: OpenTurnCleanupStrategy;
  local_loaded: boolean;
  local_idle_minutes: number;
  cleanup_timeout: number;
  cleanup_reasoning_effort: CleanupReasoningEffort;
  cleanup_service_tier: CleanupServiceTier;
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
  local_stt_engine: "whisper",
  ai_cleanup: true,
  cleanup_provider: "local",
  sound_cues: true,
  vocabulary: [],
  corrections: {},
  stt_vocab_hints: true,
  repaste_hotkey: "left alt+v",
  commit_hotkey: "left ctrl+left alt",
  scratch_hotkey: "left ctrl+left alt+backspace",
  discard_hotkey: "ctrl+alt+shift+backspace",
  live_transcription: false,
  local_preview_diagnostics: false,
  stack_cleanup_strategy: "live-full",
  local_loaded: false,
  local_idle_minutes: 0,
  cleanup_timeout: 2.5,
  cleanup_reasoning_effort: "none",
  cleanup_service_tier: "priority",
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
  const input = isRecord(value) ? value : {};
  const selectedLocalSttEngine = localSttEngine(input.local_stt_engine);
  return {
    api_key: persistedString(input.api_key, DEFAULT_CONFIG.api_key, 8_192),
    openai_api_key: persistedString(input.openai_api_key, DEFAULT_CONFIG.openai_api_key, 8_192),
    openai_oauth_access_token: persistedString(
      input.openai_oauth_access_token,
      DEFAULT_CONFIG.openai_oauth_access_token,
      65_536,
    ),
    openai_oauth_refresh_token: persistedString(
      input.openai_oauth_refresh_token,
      DEFAULT_CONFIG.openai_oauth_refresh_token,
      65_536,
    ),
    openai_oauth_expires_at: boundedNumber(
      input.openai_oauth_expires_at,
      DEFAULT_CONFIG.openai_oauth_expires_at,
      0,
      Number.MAX_SAFE_INTEGER,
      true,
    ),
    openai_oauth_account_id: persistedString(
      input.openai_oauth_account_id,
      DEFAULT_CONFIG.openai_oauth_account_id,
      8_192,
    ),
    openrouter_api_key: persistedString(
      input.openrouter_api_key,
      DEFAULT_CONFIG.openrouter_api_key,
      8_192,
    ),
    hotkey: persistedString(input.hotkey, DEFAULT_CONFIG.hotkey, 256),
    language: selectedLocalSttEngine === "nemotron" ? "en" : language(input.language),
    restore_clipboard: booleanValue(input.restore_clipboard, DEFAULT_CONFIG.restore_clipboard),
    input_device: persistedString(input.input_device, DEFAULT_CONFIG.input_device, 512),
    provider: isTranscriptionProvider(input.provider) ? input.provider : DEFAULT_CONFIG.provider,
    local_stt_engine: selectedLocalSttEngine,
    ai_cleanup: booleanValue(input.ai_cleanup, DEFAULT_CONFIG.ai_cleanup),
    cleanup_provider: isCleanupProvider(input.cleanup_provider)
      ? input.cleanup_provider
      : DEFAULT_CONFIG.cleanup_provider,
    sound_cues: booleanValue(input.sound_cues, DEFAULT_CONFIG.sound_cues),
    vocabulary: persistedStringList(input.vocabulary, 200, 256),
    corrections: persistedStringMap(input.corrections, 200, 256),
    stt_vocab_hints: booleanValue(input.stt_vocab_hints, DEFAULT_CONFIG.stt_vocab_hints),
    repaste_hotkey: persistedString(input.repaste_hotkey, DEFAULT_CONFIG.repaste_hotkey, 256),
    commit_hotkey: persistedString(input.commit_hotkey, DEFAULT_CONFIG.commit_hotkey, 256),
    scratch_hotkey: persistedString(input.scratch_hotkey, DEFAULT_CONFIG.scratch_hotkey, 256),
    discard_hotkey: persistedString(input.discard_hotkey, DEFAULT_CONFIG.discard_hotkey, 256),
    live_transcription: booleanValue(
      input.live_transcription,
      DEFAULT_CONFIG.live_transcription,
    ),
    local_preview_diagnostics: booleanValue(
      input.local_preview_diagnostics,
      DEFAULT_CONFIG.local_preview_diagnostics,
    ),
    stack_cleanup_strategy: openTurnCleanupStrategy(input.stack_cleanup_strategy),
    local_loaded: booleanValue(input.local_loaded, DEFAULT_CONFIG.local_loaded),
    local_idle_minutes: localIdleMinutes(input.local_idle_minutes),
    cleanup_timeout: boundedNumber(
      input.cleanup_timeout,
      DEFAULT_CONFIG.cleanup_timeout,
      0.5,
      30,
    ),
    cleanup_reasoning_effort: cleanupReasoningEffort(input.cleanup_reasoning_effort),
    cleanup_service_tier: cleanupServiceTier(input.cleanup_service_tier),
  };
}

function localSttEngine(value: unknown): LocalSttEngineId {
  return value === "nemotron" ? "nemotron" : "whisper";
}

export function providerKey(
  config: Pick<UndertoneConfig, "api_key" | "openai_api_key" | "openrouter_api_key">,
  provider: string,
): string {
  const field = provider === "xai"
    ? KEY_FIELDS.xai
    : provider === "openai"
      ? KEY_FIELDS.openai
      : provider === "openrouter"
        ? KEY_FIELDS.openrouter
        : undefined;
  if (field === undefined) return "";
  return config[field];
}

export function cloneConfig(config: Readonly<UndertoneConfig>): UndertoneConfig {
  return {
    ...config,
    vocabulary: [...config.vocabulary],
    corrections: { ...config.corrections },
  };
}

export function xaiVocabularyHints(config: Readonly<UndertoneConfig>): string[] {
  if (config.provider !== "xai" || !config.stt_vocab_hints) return [];
  return [...new Set([...config.vocabulary, ...Object.values(config.corrections)])];
}

function persistedString(value: unknown, fallback: string, maximumLength: number): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized.length <= maximumLength && !/[\r\n\0]/u.test(normalized)
    ? normalized
    : fallback;
}

function language(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_CONFIG.language;
  const normalized = value.trim();
  return normalized.length >= 2
    && normalized.length <= 16
    && /^[A-Za-z-]+$/u.test(normalized)
    ? normalized
    : DEFAULT_CONFIG.language;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  integer = false,
): number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= minimum
    && value <= maximum
    && (!integer || Number.isInteger(value))
    ? value
    : fallback;
}

function persistedStringList(
  value: unknown,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumEntries) return [];
  const result: string[] = [];
  for (const item of value) {
    const normalized = persistedString(item, "", maximumLength);
    if (normalized.length > 0 && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function persistedStringMap(
  value: unknown,
  maximumEntries: number,
  maximumLength: number,
  removedKey?: string,
): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > maximumEntries) return {};
  const entries: [string, string][] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = persistedString(key, "", maximumLength);
    const normalizedValue = persistedString(child, "", maximumLength);
    if (normalizedKey.length > 0
      && normalizedValue.length > 0
      && normalizedKey !== removedKey) {
      entries.push([normalizedKey, normalizedValue]);
    }
  }
  return Object.fromEntries(entries);
}

function openTurnCleanupStrategy(value: unknown): OpenTurnCleanupStrategy {
  return value === "live-full" || value === "commit-full"
    ? value
    : DEFAULT_CONFIG.stack_cleanup_strategy;
}

function localIdleMinutes(value: unknown): number {
  return value === 0 || value === 5 || value === 15 || value === 30 || value === 60
    ? value
    : DEFAULT_CONFIG.local_idle_minutes;
}

function cleanupReasoningEffort(value: unknown): CleanupReasoningEffort {
  return value === "none"
    || value === "low"
    || value === "medium"
    || value === "high"
    || value === "xhigh"
    || value === "max"
    ? value
    : DEFAULT_CONFIG.cleanup_reasoning_effort;
}

function cleanupServiceTier(value: unknown): CleanupServiceTier {
  if (value === "fast") return "priority";
  return value === "default" || value === "priority"
    ? value
    : DEFAULT_CONFIG.cleanup_service_tier;
}

export function isRecord(value: unknown): value is ConfigRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
