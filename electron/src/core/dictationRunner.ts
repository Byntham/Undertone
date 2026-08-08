import {
  DEFAULT_CONFIG,
  modelOverride,
  providerKey,
  type UndertoneConfig,
} from "./config";
import type { DictationCompletion } from "./gestures";
import type { TextPreparationResult } from "./textPreparation";
import { finalizeTranscript } from "./corrections";
import { SessionHistory, type DictationTarget } from "./pipelineQueue";
import type { TurnBuffer } from "./turnBuffer";

export interface TranscriberPort {
  transcribe(options: {
    wav: Uint8Array;
    apiKey: string;
    language: string;
    vocabulary: readonly unknown[];
    provider: string;
    model: string;
  }): Promise<string>;
}

export interface PasterPort {
  paste(
    text: string,
    restoreClipboard: boolean,
    target?: DictationTarget,
  ): Promise<boolean>;
  copyFallback(text: string): void;
}

export interface DictationFeedback {
  message(text: string, kind?: "normal" | "warning" | "error"): void;
  dismiss(): void;
}

export interface DictationRunnerDependencies {
  transcriber: TranscriberPort;
  prepareText(
    text: string,
    config: UndertoneConfig,
  ): Promise<TextPreparationResult>;
  paster: PasterPort;
  history: SessionHistory;
  turnBuffer: TurnBuffer;
  feedback: DictationFeedback;
}

export class DictationJobRunner {
  constructor(private readonly dependencies: DictationRunnerDependencies) {}

  async run(
    wav: Uint8Array,
    target: DictationTarget | null,
    config: UndertoneConfig,
    completion: DictationCompletion = "commit",
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    const provider = stringValue(config.provider, DEFAULT_CONFIG.provider);
    let transcript: string;
    try {
      transcript = await this.dependencies.transcriber.transcribe({
        wav,
        apiKey: providerKey(config, provider),
        language: stringValue(config.language, "en"),
        vocabulary: vocabularyFor(config),
        provider,
        model: modelOverride(config, "stt", provider),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.history.registerFailure(message, wav);
      feedback.message(message, "error");
      return;
    }
    await this.runTranscript(transcript, target, config, completion, feedback);
  }

  async runTranscript(
    transcript: string,
    target: DictationTarget | null,
    config: UndertoneConfig,
    completion: DictationCompletion = "commit",
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    if (transcript.length === 0) {
      feedback.message("No speech detected", "error");
      return;
    }

    const corrections = isStringMap(config.corrections) ? config.corrections : {};
    let appended: Awaited<ReturnType<DictationJobRunner["appendToTurn"]>>;
    try {
      appended = await this.appendToTurn(transcript, config);
    } catch {
      const cleanupStrategy = this.dependencies.turnBuffer.activeCleanupStrategy()
        ?? config.stack_cleanup_strategy;
      const rawTurn = this.dependencies.turnBuffer.rawText(transcript) ?? transcript;
      const text = finalizeTranscript(rawTurn, corrections);
      appended = {
        ...this.dependencies.turnBuffer.append(transcript, text, cleanupStrategy),
        cleanupFailed: true,
      };
    }

    if (completion === "open-turn") {
      if (appended.cleanupFailed) {
        feedback.message("AI cleanup failed — used basic formatting", "warning");
      } else {
        feedback.message(turnStatusFeedback(appended.fragmentCount, transcript), "normal");
      }
      return;
    }
    await this.commitTurn(config, feedback, target, appended.cleanupFailed);
  }

  async commit(
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    await this.commitTurn(config, feedback, null, false);
  }

  discard(feedback: DictationFeedback = this.dependencies.feedback): void {
    if (!this.dependencies.turnBuffer.clear()) {
      feedback.message("No open turn", "warning");
      return;
    }
    feedback.message("Turn discarded", "normal");
  }

  scratchLast(feedback: DictationFeedback = this.dependencies.feedback): void {
    const scratched = this.dependencies.turnBuffer.scratchLast();
    if (scratched === null) {
      feedback.message("Nothing to scratch", "warning");
      return;
    }
    if (scratched.fragmentCount === 0) {
      feedback.message("Last fragment scratched · turn empty", "normal");
      return;
    }
    feedback.message(
      turnStatusFeedback(scratched.fragmentCount, scratched.text, "Scratched"),
      "normal",
    );
  }

  private async appendToTurn(
    transcript: string,
    config: UndertoneConfig,
  ): Promise<ReturnType<TurnBuffer["append"]> & { cleanupFailed: boolean }> {
    const cleanupStrategy = this.dependencies.turnBuffer.activeCleanupStrategy()
      ?? config.stack_cleanup_strategy;
    const rawTurn = this.dependencies.turnBuffer.rawText(transcript) ?? transcript;
    const preparationConfig = cleanupStrategy === "commit-full"
      ? { ...config, ai_cleanup: false }
      : config;
    const prepared = await this.dependencies.prepareText(
      rawTurn,
      preparationConfig,
    );
    return {
      ...this.dependencies.turnBuffer.append(transcript, prepared.text, cleanupStrategy),
      cleanupFailed: prepared.cleanupFailed,
    };
  }

  private async commitTurn(
    config: UndertoneConfig,
    feedback: DictationFeedback,
    target: DictationTarget | null,
    cleanupFailed: boolean,
  ): Promise<void> {
    let text = this.dependencies.turnBuffer.peekText();
    if (text === null) {
      feedback.message("Nothing to commit", "warning");
      return;
    }
    if (this.dependencies.turnBuffer.activeCleanupStrategy() !== "live-full") {
      const rawTurn = this.dependencies.turnBuffer.rawText();
      if (rawTurn === null) {
        feedback.message("Nothing to commit", "warning");
        return;
      }
      const prepared = await this.dependencies.prepareText(rawTurn, config);
      text = prepared.text;
      cleanupFailed = cleanupFailed || prepared.cleanupFailed;
      this.dependencies.turnBuffer.replaceText(text);
    }

    try {
      const pasted = await this.dependencies.paster.paste(
        text,
        Boolean(config.restore_clipboard),
        target ?? undefined,
      );
      if (!pasted) {
        this.focusChanged(config, feedback);
        return;
      }
    } catch {
      // Keep the turn so the user can choose a target and retry manually.
      this.dependencies.paster.copyFallback(text);
      const shortcut = stringValue(config.commit_hotkey, "")
        || stringValue(config.repaste_hotkey, "");
      const message = shortcut.length > 0
        ? `Couldn't paste — focus the target and press ${shortcut}`
        : "Couldn't paste — the turn is on your clipboard and still open";
      feedback.message(message, "warning");
      return;
    }

    this.dependencies.turnBuffer.clear();
    this.dependencies.history.registerSuccess(text);
    if (cleanupFailed) {
      feedback.message("AI cleanup failed — used basic formatting", "warning");
    } else {
      feedback.dismiss();
    }
  }

  private focusChanged(config: UndertoneConfig, feedback: DictationFeedback): void {
    const shortcut = stringValue(config.commit_hotkey, "");
    const message = shortcut.length > 0
      ? `Focus changed — press ${shortcut} to paste`
      : "Focus changed — commit the open turn manually";
    feedback.message(message, "error");
  }

}

function turnStatusFeedback(
  fragmentCount: number,
  previewSource: string,
  prefix = "Turn",
): string {
  const preview = previewSource.trim().replace(/\s+/gu, " ");
  const clipped = preview.length > 40 ? `${preview.slice(0, 37)}…` : preview;
  return clipped.length > 0
    ? `${prefix} · ${fragmentCount} · ${clipped}`
    : `${prefix} · ${fragmentCount}`;
}

function vocabularyFor(config: UndertoneConfig): unknown[] {
  if (!config.stt_vocab_hints) return [];
  const vocabulary = Array.isArray(config.vocabulary) ? [...config.vocabulary] : [];
  if (isStringMap(config.corrections)) {
    for (const value of Object.values(config.corrections)) {
      if (!vocabulary.includes(value)) vocabulary.push(value);
    }
  }
  return vocabulary;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "string");
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}
