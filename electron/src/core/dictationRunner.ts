import {
  DEFAULT_CONFIG,
  modelOverride,
  providerKey,
  type UndertoneConfig,
} from "./config";
import { InsertionMemory } from "./textPreparation";
import { applyCorrections } from "./textproc";
import { SessionHistory, type DictationTarget } from "./pipelineQueue";
import { isStackDictationMode, type TurnBuffer } from "./turnBuffer";

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
  prepareText(
    text: string,
    config: UndertoneConfig,
    context: "insertion" | "isolated",
  ): Promise<string>;
  restoreTarget(target: DictationTarget | null): Promise<boolean>;
  getForegroundWindow(): Promise<string>;
  paster: PasterPort;
  history: SessionHistory;
  insertionMemory: InsertionMemory;
  turnBuffer: TurnBuffer;
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
    if (transcript.length === 0) {
      feedback.message("No speech detected", "error");
      return;
    }

    const corrections = isStringMap(config.corrections) ? config.corrections : {};
    const raw = applyCorrections(transcript, corrections);

    if (isStackDictationMode(config.dictation_mode)) {
      const stacked = await this.appendToTurn(transcript, config);
      feedback.message(
        turnStatusFeedback(stacked.fragmentCount, transcript),
        "normal",
      );
      return;
    }

    let refocused = await this.dependencies.restoreTarget(target);
    const final = await this.dependencies.prepareText(transcript, config, "insertion");
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

  async commit(
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    let text = this.dependencies.turnBuffer.peekText();
    if (text === null) {
      feedback.message("Nothing to commit", "warning");
      return;
    }
    if (config.stack_cleanup_strategy !== "live-full") {
      const rawTurn = this.dependencies.turnBuffer.rawText();
      if (rawTurn === null) {
        feedback.message("Nothing to commit", "warning");
        return;
      }
      text = await this.dependencies.prepareText(rawTurn, config, "isolated");
      this.dependencies.turnBuffer.replaceText(text);
    }

    const inputGeneration = this.dependencies.insertionMemory.captureGeneration();
    try {
      await this.dependencies.paster.paste(text, Boolean(config.restore_clipboard));
    } catch {
      // Keep the open turn so the user can retry commit; only stage clipboard.
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
    this.dependencies.history.registerSuccess(text, null);
    const foreground = await this.dependencies.getForegroundWindow();
    this.dependencies.insertionMemory.registerPaste(foreground, text, inputGeneration);
    feedback.dismiss();
  }

  private async appendToTurn(
    transcript: string,
    config: UndertoneConfig,
  ): Promise<ReturnType<TurnBuffer["append"]>> {
    const rawTurn = this.dependencies.turnBuffer.rawText(transcript) ?? transcript;
    const preparationConfig = config.stack_cleanup_strategy === "commit-full"
      ? { ...config, ai_cleanup: false }
      : config;
    const snapshot = await this.dependencies.prepareText(
      rawTurn,
      preparationConfig,
      "isolated",
    );
    return this.dependencies.turnBuffer.append(transcript, snapshot);
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
