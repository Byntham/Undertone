import type {
  LocalSttEngineId,
  SettingsProviderId,
  TranscriptionProviderId,
} from "./settings";

export const LOCAL_STT_MODEL = "ggml-large-v3-turbo.bin";
export const LOCAL_NEMOTRON_STT_MODEL = "nemotron-speech-streaming-en-0.6b.q8_0.gguf";
export const LOCAL_VAD_MODEL = "ggml-silero-v6.2.0.bin";
export const LOCAL_CLEANUP_MODEL = "Qwen3.5-27B-UD-IQ2_XXS.gguf";

export const DEFAULT_STT_MODELS = {
  xai: "",
  openai: "gpt-transcribe",
  openrouter: "openai/gpt-transcribe",
  local: LOCAL_STT_MODEL,
} as const satisfies Readonly<Record<TranscriptionProviderId, string>>;

export const LOCAL_STT_MODELS = {
  whisper: LOCAL_STT_MODEL,
  nemotron: LOCAL_NEMOTRON_STT_MODEL,
} as const satisfies Readonly<Record<LocalSttEngineId, string>>;

export const LIVE_STT_MODELS = {
  openai: "gpt-live-transcribe",
  xai: null,
} as const;

export const DEFAULT_CLEANUP_MODELS = {
  xai: "grok-4.3",
  openai: "gpt-5.6-luna",
  "openai-subscription": "gpt-5.6-luna",
  openrouter: "openai/gpt-5.6-luna",
  local: LOCAL_CLEANUP_MODEL,
} as const satisfies Readonly<Record<SettingsProviderId, string>>;
