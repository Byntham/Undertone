import type {
  SettingsProviderId,
  TranscriptionProviderId,
} from "./settings";

export const DEFAULT_STT_MODELS = {
  xai: "",
  openai: "gpt-transcribe",
  openrouter: "openai/gpt-transcribe",
  local: "ggml-large-v3-turbo.bin",
} as const satisfies Readonly<Record<TranscriptionProviderId, string>>;

export const LIVE_STT_MODELS = {
  openai: "gpt-live-transcribe",
  xai: null,
} as const;

export const DEFAULT_CLEANUP_MODELS = {
  xai: "grok-4.3",
  openai: "gpt-5.6-luna",
  "openai-subscription": "gpt-5.6-luna",
  openrouter: "openai/gpt-5.6-luna",
  local: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
} as const satisfies Readonly<Record<SettingsProviderId, string>>;
