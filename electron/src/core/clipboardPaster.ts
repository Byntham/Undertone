export interface ClipboardAdapter {
  readText(): string;
  writeText(value: string): void;
}

export interface PasteSender {
  sendPaste(): Promise<boolean>;
  sendGuardedPaste?(target: PasteTarget): Promise<boolean>;
}

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
  ): Promise<boolean> {
    if (text.length === 0) return Promise.resolve(true);

    return new Promise<boolean>((resolve, reject) => {
      const operation = this.tail.then(async () => {
        try {
          const result = await this.performPaste(text, restoreClipboard, target);
          resolve(result.sent);
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
  ): Promise<{ sent: boolean; restored: Promise<void> }> {
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
    const sent = target === undefined
      ? await this.sender.sendPaste()
      : this.sender.sendGuardedPaste === undefined
        ? false
        : await this.sender.sendGuardedPaste(target);
    if (target === undefined && !sent) {
      throw new Error("Windows did not accept the paste keystroke");
    }
    if (!sent) {
      if (previous !== null && this.clipboard.readText() === pastedText) {
        this.clipboard.writeText(previous);
      }
      return { sent: false, restored: Promise.resolve() };
    }
    if (!restoreClipboard || previous === null) {
      return { sent: true, restored: Promise.resolve() };
    }
    return {
      sent: true,
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
