export interface ClipboardAdapter {
  readText(): string;
  writeText(value: string): void;
}

export interface PasteSender {
  sendPaste(): Promise<boolean>;
  sendGuardedPaste?(target: PasteTarget): Promise<GuardedPasteResult>;
}

export type GuardedPasteResult = "pasted" | "focus-changed" | "focus-unavailable";

export type PasteTarget = {
  window: string;
  focus: string;
  generation: string;
} & (
  | { focusIdentityState: "available"; focusIdentity: string }
  | { focusIdentityState: "unavailable"; focusIdentity: null }
);

type Scheduler = (callback: () => Promise<void>, delayMs: number) => void;

export class ClipboardPaster {
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly clipboard: ClipboardAdapter,
    private readonly sender: PasteSender,
    private readonly wait: (delayMs: number) => Promise<void> = delay,
    private readonly schedule: Scheduler = scheduleLater,
  ) {}

  paste(
    text: string,
    restoreClipboard = true,
    target?: PasteTarget,
  ): Promise<GuardedPasteResult> {
    if (text.length === 0) return Promise.resolve("pasted");

    return new Promise<GuardedPasteResult>((resolve, reject) => {
      const operation = this.tail.then(async () => {
        try {
          const result = await this.performPaste(text, restoreClipboard, target);
          resolve(result.result);
          await result.restored;
        } catch (error) {
          reject(error);
        }
      });
      this.tail = operation;
    });
  }

  copyFallback(text: string): void {
    this.generation += 1;
    this.clipboard.writeText(text);
  }

  private async performPaste(
    text: string,
    restoreClipboard: boolean,
    target: PasteTarget | undefined,
  ): Promise<{ result: GuardedPasteResult; restored: Promise<void> }> {
    const pastedText = trailingSpace(text);
    const generation = ++this.generation;
    let previous: string | null;
    try {
      previous = this.clipboard.readText();
    } catch {
      previous = null;
    }
    this.clipboard.writeText(pastedText);
    await this.wait(150);
    const result = target === undefined
      ? await this.sender.sendPaste() ? "pasted" : "paste-failed"
      : this.sender.sendGuardedPaste === undefined
        ? "focus-unavailable"
        : await this.sender.sendGuardedPaste(target);
    if (result === "paste-failed") {
      throw new Error("Windows did not accept the paste keystroke");
    }
    if (result !== "pasted") {
      if (previous !== null && this.clipboard.readText() === pastedText) {
        this.clipboard.writeText(previous);
      }
      return { result, restored: Promise.resolve() };
    }
    if (!restoreClipboard || previous === null) {
      return { result: "pasted", restored: Promise.resolve() };
    }
    return {
      result: "pasted",
      restored: new Promise((resolve) => {
        this.schedule(async () => {
          try {
            if (
              generation === this.generation
              && this.clipboard.readText() === pastedText
            ) {
              this.clipboard.writeText(previous);
            }
          } catch {
            // Clipboard restoration is best effort after the paste has succeeded.
          } finally {
            resolve();
          }
        }, 500);
      }),
    };
  }
}

function trailingSpace(text: string): string {
  return /\s$/u.test(text) ? text : `${text} `;
}

async function delay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function scheduleLater(callback: () => Promise<void>, delayMs: number): void {
  setTimeout(() => { void callback(); }, delayMs);
}
