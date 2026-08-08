import {
  DEFAULT_CONFIG,
  isRecord,
  modelOverride,
  providerKey,
  type CleanupReasoningEffort,
  type CleanupServiceTier,
  type UndertoneConfig,
} from "./config";
import {
  applyCorrections,
  finalizeTranscript,
  type Corrections,
} from "./corrections";

export interface CleanupRequest {
  transcript: string;
  corrections: Corrections;
  apiKey: string;
  model: string;
  provider: string;
  timeoutSeconds: number;
  reasoningEffort: CleanupReasoningEffort;
  serviceTier: CleanupServiceTier;
}

export interface TextPreparationDependencies {
  cleanup(request: CleanupRequest): Promise<string | null>;
}

export interface TextPreparationResult {
  text: string;
  cleanupFailed: boolean;
}

export async function prepareText(
  text: string,
  config: UndertoneConfig,
  dependencies: TextPreparationDependencies,
): Promise<TextPreparationResult> {
  const corrections = stringMap(config.corrections);
  let final: string | null = null;
  let cleanupFailed = false;
  if (Boolean(config.ai_cleanup)) {
    const provider = stringValue(config.cleanup_provider, DEFAULT_CONFIG.cleanup_provider);
    const cleaned = await dependencies.cleanup({
      transcript: applyCorrections(text, corrections),
      corrections,
      apiKey: providerKey(config, provider),
      model: modelOverride(config, "cleanup", provider),
      provider,
      timeoutSeconds: nonzeroNumber(config.cleanup_timeout, DEFAULT_CONFIG.cleanup_timeout),
      reasoningEffort: config.cleanup_reasoning_effort,
      serviceTier: config.cleanup_service_tier,
    });
    if (cleaned !== null) {
      final = finalizeTranscript(cleaned, corrections);
    } else cleanupFailed = true;
  }
  final ??= finalizeTranscript(text, corrections);
  return {
    text: final,
    cleanupFailed,
  };
}

function stringMap(value: unknown): Record<string, string> {
  return isRecord(value) ? value as Record<string, string> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nonzeroNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value !== 0
    ? value
    : fallback;
}
