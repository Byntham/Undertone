import { SYSTEM_PROMPT } from "../src/core/cleanupPrompt";

export const CLEANUP_PROMPT_IDS = {
  default: "default",
} as const;

export type CleanupPromptId = typeof CLEANUP_PROMPT_IDS[keyof typeof CLEANUP_PROMPT_IDS];

export interface CleanupPromptCandidate {
  id: CleanupPromptId;
  prompt: string;
}

export const CLEANUP_PROMPT_CANDIDATES: readonly CleanupPromptCandidate[] = [{
  id: CLEANUP_PROMPT_IDS.default,
  prompt: SYSTEM_PROMPT,
}];
