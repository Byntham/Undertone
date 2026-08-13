import {
  providerKey,
  type UndertoneConfig,
  xaiVocabularyHints,
} from "./config";
import type { TranscriptionProviderId } from "../shared/settings";
import type { LocalSttEngineId } from "../shared/settings";
import type { OverlayTone } from "../shared/overlay";
import type { TextPreparationResult } from "./textPreparation";
import {
  SessionHistory,
  type DictationDestination,
  type DictationTarget,
} from "./pipelineQueue";
import type { TurnBuffer } from "./turnBuffer";
import type { GuardedPasteResult } from "./clipboardPaster";

export interface TranscriberPort {
  transcribe(options: {
    wav: Uint8Array;
    apiKey: string;
    language: string;
    vocabulary: readonly string[];
    provider: TranscriptionProviderId;
    localEngine: LocalSttEngineId;
  }): Promise<string>;
}
export interface PasterPort {
  paste(
    text: string,
    restoreClipboard: boolean,
    target?: DictationTarget,
  ): Promise<GuardedPasteResult>;
  copyFallback(text: string): void;
}

export type DictationFeedbackMessage =
  | { text: string; tone?: OverlayTone; destination?: "overlay" }
  | { text: string; tone: "warning" | "error"; destination: "turn-draft" };

export interface DictationFeedback {
  message(message: DictationFeedbackMessage): void;
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
    destination: DictationDestination,
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    const provider = config.provider;
    let transcript: string;
    try {
      transcript = await this.dependencies.transcriber.transcribe({
        wav,
        apiKey: providerKey(config, provider),
        language: config.language,
        vocabulary: xaiVocabularyHints(config),
        provider,
        localEngine: config.local_stt_engine,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.dependencies.history.registerFailure(message, wav);
      feedback.message({ text: message, tone: "error" });
      return;
    }
    await this.runTranscript(transcript, destination, config, feedback);
  }

  async runTranscript(
    transcript: string,
    destination: DictationDestination,
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    if (transcript.trim().length === 0) {
      feedback.message({
        text: "No speech detected",
        tone: "error",
        destination: "turn-draft",
      });
      return;
    }

    const appended = await this.appendToTurn(transcript, config);

    if (destination.completion === "open-turn") {
      if (appended.cleanupFailed) {
        feedback.message({ text: "AI cleanup failed — used basic formatting", tone: "warning" });
      } else {
        feedback.message({
          text: turnStatusFeedback(appended.fragmentCount, transcript),
          tone: "normal",
        });
      }
      return;
    }
    if (destination.target.state === "unavailable") {
      this.focusUnavailable(config, feedback);
      return;
    }
    await this.commitTurn(
      config,
      feedback,
      destination.target.value,
      appended.cleanupFailed,
    );
  }

  async commit(
    config: UndertoneConfig,
    feedback: DictationFeedback = this.dependencies.feedback,
  ): Promise<void> {
    await this.commitTurn(config, feedback, null, false);
  }

  discard(feedback: DictationFeedback = this.dependencies.feedback): void {
    if (!this.dependencies.turnBuffer.clear()) {
      feedback.message({ text: "No open turn", tone: "warning" });
      return;
    }
    feedback.message({ text: "Turn discarded", tone: "normal" });
  }

  scratchLast(feedback: DictationFeedback = this.dependencies.feedback): void {
    const scratched = this.dependencies.turnBuffer.scratchLast();
    if (scratched === null) {
      feedback.message({ text: "Nothing to scratch", tone: "warning" });
      return;
    }
    if (scratched.fragmentCount === 0) {
      feedback.message({ text: "Last fragment scratched · turn empty", tone: "normal" });
      return;
    }
    feedback.message({
      text: turnStatusFeedback(scratched.fragmentCount, scratched.text, "Scratched"),
      tone: "normal",
    });
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
      feedback.message({ text: "Nothing to commit", tone: "warning" });
      return;
    }
    if (this.dependencies.turnBuffer.activeCleanupStrategy() !== "live-full") {
      const rawTurn = this.dependencies.turnBuffer.rawText();
      if (rawTurn === null) {
        feedback.message({ text: "Nothing to commit", tone: "warning" });
        return;
      }
      const prepared = await this.dependencies.prepareText(rawTurn, config);
      text = prepared.text;
      cleanupFailed = cleanupFailed || prepared.cleanupFailed;
      this.dependencies.turnBuffer.replaceText(text);
    }

    try {
      const pasteResult = await this.dependencies.paster.paste(
        text,
        config.restore_clipboard,
        target ?? undefined,
      );
      if (pasteResult === "focus-changed") {
        this.focusChanged(config, feedback);
        return;
      }
      if (pasteResult === "focus-unavailable") {
        this.focusUnavailable(config, feedback);
        return;
      }
    } catch {
      // Keep the turn so the user can choose a target and retry manually.
      this.dependencies.paster.copyFallback(text);
      const shortcut = config.commit_hotkey || config.repaste_hotkey;
      const message = shortcut.length > 0
        ? `Couldn't paste — focus the target and press ${shortcut}`
        : "Couldn't paste — the turn is on your clipboard and still open";
      feedback.message({ text: message, tone: "warning" });
      return;
    }

    this.dependencies.turnBuffer.clear();
    this.dependencies.history.registerSuccess(text);
    if (cleanupFailed) {
      feedback.message({ text: "AI cleanup failed — used basic formatting", tone: "warning" });
    } else {
      feedback.dismiss();
    }
  }

  private focusChanged(config: UndertoneConfig, feedback: DictationFeedback): void {
    const shortcut = config.commit_hotkey;
    const message = shortcut.length > 0
      ? `Focus changed — press ${shortcut} to paste`
      : "Focus changed — commit the open turn manually";
    feedback.message({ text: message, tone: "error" });
  }

  private focusUnavailable(config: UndertoneConfig, feedback: DictationFeedback): void {
    const shortcut = config.commit_hotkey;
    const message = shortcut.length > 0
      ? `Couldn't confirm the paste target — press ${shortcut} to paste`
      : "Couldn't confirm the paste target — commit the open turn manually";
    feedback.message({ text: message, tone: "error" });
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
