import {
  modelOverride,
  providerKey,
  type UndertoneConfig,
} from "./config";
import { InsertionMemory } from "./textPreparation";
import { applyCorrections } from "./textproc";
import { SessionHistory, type DictationTarget } from "./pipelineQueue";

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
  paste(text: string, restoreClipboard: boolean): Promise<void>;
  copyFallback(text: string): void;
}

export interface DictationFeedback {
  message(text: string, kind?: "normal" | "warning" | "error"): void;
  dismiss(): void;
}

export interface DictationRunnerDependencies {
  transcriber: TranscriberPort;
  prepareText(text: string, config: UndertoneConfig): Promise<string>;
  restoreTarget(target: DictationTarget | null): Promise<boolean>;
  getForegroundWindow(): Promise<string>;
  paster: PasterPort;
  history: SessionHistory;
  insertionMemory: InsertionMemory;
  feedback: DictationFeedback;
}

export class DictationJobRunner {
  constructor(private readonly dependencies: DictationRunnerDependencies) {}

  async run(
    wav: Uint8Array,
    target: DictationTarget | null,
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    const provider = stringValue(config.provider, "xai");

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
    if (transcript.length === 0) {
      feedback.message("No speech detected", "error");
      return;
    }

    let refocused = await this.dependencies.restoreTarget(target);
    const corrections = isStringMap(config.corrections) ? config.corrections : {};
    const raw = applyCorrections(transcript, corrections);
    const final = await this.dependencies.prepareText(transcript, config);
    if (refocused) refocused = await this.dependencies.restoreTarget(target);
    const historyRaw = raw === final ? null : raw;
    if (!refocused) {
      this.clipboardFallback(final, historyRaw, config, feedback);
      return;
    }

    const inputGeneration = this.dependencies.insertionMemory.captureGeneration();
    try {
      await this.dependencies.paster.paste(final, Boolean(config.restore_clipboard));
    } catch {
      this.clipboardFallback(final, historyRaw, config, feedback);
      return;
    }
    this.dependencies.history.registerSuccess(final, historyRaw);
    const foreground = await this.dependencies.getForegroundWindow();
    this.dependencies.insertionMemory.registerPaste(foreground, final, inputGeneration);
    feedback.dismiss();
  }

  private clipboardFallback(
    final: string,
    raw: string | null,
    config: UndertoneConfig,
    feedback: DictationFeedback,
  ): void {
    this.dependencies.paster.copyFallback(final);
    this.dependencies.history.registerSuccess(final, raw);
    const shortcut = stringValue(config.repaste_hotkey, "");
    const message = shortcut.length > 0
      ? `Couldn't paste — press ${shortcut} where you want it`
      : "Couldn't paste — the text is on your clipboard";
    feedback.message(message, "warning");
  }
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
