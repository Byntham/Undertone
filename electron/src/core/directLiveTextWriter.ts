export type LiveTextInsertResult =
  | boolean
  | "inserted"
  | "focus-changed"
  | "focus-unavailable";

export type LiveInsertionStopReason =
  | "focus-changed"
  | "focus-unavailable"
  | "cancelled"
  | "timeout"
  | "final-mismatch";

export interface DirectLiveTextResult {
  insertedText: string;
  finalText: string;
  complete: boolean;
  stopReason: LiveInsertionStopReason | null;
}

type PendingOperation =
  | { type: "append"; text: string }
  | { type: "replace"; removeCount: number; text: string; resultingText: string };

export class DirectLiveTextWriter {
  private tail = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private cancelled = false;
  private paused = false;
  private inserted = "";
  private scheduled = "";
  private readonly pending: PendingOperation[] = [];
  private pumping = false;
  private stopReason: LiveInsertionStopReason | null = null;
  private replaceTail: ((removeCount: number, text: string) => Promise<LiveTextInsertResult>) | null = null;

  constructor(
    private readonly insert: (text: string) => Promise<LiveTextInsertResult>,
    private readonly onFailure: (error: Error) => void,
    private readonly onStopped: (reason: LiveInsertionStopReason) => void = () => undefined,
    private readonly settle: () => Promise<void> = settleTarget,
  ) {}

  append(text: string): void {
    if (text.length === 0 || this.closed || this.failure !== null || this.stopReason !== null) return;
    this.scheduled += text;
    this.pending.push({ type: "append", text });
    this.startPump();
  }

  updateHypothesis(text: string): void {
    if (this.closed || this.failure !== null || this.stopReason !== null || text === this.scheduled) {
      return;
    }
    if (text.startsWith(this.scheduled)) {
      this.append(text.slice(this.scheduled.length));
      return;
    }
    if (this.replaceTail === null) return;
    const prefixLength = commonPrefixLength(this.scheduled, text);
    this.pending.push({
      type: "replace",
      removeCount: Array.from(this.scheduled.slice(prefixLength)).length,
      text: text.slice(prefixLength),
      resultingText: text,
    });
    this.scheduled = text;
    this.startPump();
  }

  enableTailCorrection(
    replace: (removeCount: number, text: string) => Promise<LiveTextInsertResult>,
  ): void {
    this.replaceTail = replace;
  }

  pause(): void {
    if (!this.closed) this.paused = true;
  }

  resume(): void {
    if (this.closed || this.stopReason !== null) return;
    this.paused = false;
    this.startPump();
  }

  stop(reason: LiveInsertionStopReason): void {
    if (this.stopReason !== null) return;
    this.stopReason = reason;
    this.pending.length = 0;
    this.onStopped(reason);
  }

  async finish(
    finalText: string,
    options: { appendFinal?: boolean; trailingSpace?: boolean } = {},
  ): Promise<DirectLiveTextResult> {
    if (this.closed) return this.result(finalText);
    if (options.appendFinal !== false && this.stopReason === null) {
      if (finalText.startsWith(this.scheduled)) {
        this.append(finalText.slice(this.scheduled.length));
      } else if (this.scheduled.trimEnd() !== finalText) {
        if (this.replaceTail === null) {
          this.stop("final-mismatch");
        } else {
          this.updateHypothesis(finalText);
        }
      }
    }
    if (options.trailingSpace !== false
      && this.stopReason === null
      && finalText.trim().length > 0
      && !/\s$/u.test(this.scheduled)) {
      this.append(" ");
    }
    this.closed = true;
    this.paused = false;
    this.startPump();
    await this.tail;
    if (this.failure !== null) throw this.failure;
    return this.result(finalText);
  }

  cancel(): void {
    this.closed = true;
    this.cancelled = true;
    this.pending.length = 0;
    if (this.stopReason === null) this.stopReason = "cancelled";
  }

  snapshot(finalText = ""): DirectLiveTextResult {
    return this.result(finalText);
  }

  private result(finalText: string): DirectLiveTextResult {
    return {
      insertedText: this.inserted.trimEnd(),
      finalText: finalText.trim(),
      complete: this.failure === null && this.stopReason === null,
      stopReason: this.stopReason,
    };
  }

  private startPump(): void {
    if (this.pumping || this.paused || this.cancelled || this.failure !== null
      || this.stopReason !== null || this.pending.length === 0) return;
    this.pumping = true;
    const operation = this.pump();
    this.tail = operation.catch((reason: unknown) => {
      if (this.failure !== null) return;
      this.failure = reason instanceof Error ? reason : new Error(String(reason));
      this.onFailure(this.failure);
    }).finally(() => {
      this.pumping = false;
      this.startPump();
    });
  }

  private async pump(): Promise<void> {
    while (!this.paused && !this.cancelled && this.failure === null
      && this.stopReason === null && this.pending.length > 0) {
      const operation = this.pending.shift()!;
      const result = operation.type === "append"
        ? await this.insert(operation.text)
        : await this.replaceTail!(operation.removeCount, operation.text);
      if (result === false) throw new Error("Windows did not accept live text input");
      if (result === "focus-changed" || result === "focus-unavailable") {
        this.stop(result);
        return;
      }
      this.inserted = operation.type === "append"
        ? this.inserted + operation.text
        : operation.resultingText;
      await this.settle();
    }
  }
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

async function settleTarget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
