import {
  providerKey,
  type CleanupReasoningEffort,
  type CleanupServiceTier,
  type UndertoneConfig,
} from "./config";
import type { CleanupProviderId } from "../shared/settings";
import { CleanupError } from "./cleanup";
import { finalizeTranscript } from "./corrections";

export interface CleanupRequest {
  transcript: string;
  apiKey: string;
  provider: CleanupProviderId;
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
  const corrections = config.corrections;
  let prepared = text;
  let cleanupFailed = false;
  if (config.ai_cleanup) {
    const provider = config.cleanup_provider;
    try {
      const cleaned = await dependencies.cleanup({
        transcript: text,
        apiKey: providerKey(config, provider),
        provider,
        timeoutSeconds: config.cleanup_timeout,
        reasoningEffort: config.cleanup_reasoning_effort,
        serviceTier: config.cleanup_service_tier,
      });
      // A cold local model intentionally falls back without reporting a
      // provider failure; CleanupClient reserves null for that state.
      if (cleaned !== null) prepared = cleaned;
    } catch (error) {
      if (!(error instanceof CleanupError)) throw error;
      cleanupFailed = true;
    }
  }
  return {
    text: finalizeTranscript(prepared, corrections),
    cleanupFailed,
  };
}
