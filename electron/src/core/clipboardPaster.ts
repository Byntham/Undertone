export interface ClipboardAdapter {
  readText(): string;
  writeText(value: string): void;
}

export interface PasteSender {
  sendPaste(): Promise<boolean>;
  sendGuardedPaste?(target: PasteTarget): Promise<boolean>;
}

export interface PasteTarget {
  window: string;
  focus?: string;
  focusIdentity?: string | null;
  generation?: string;
}

type Scheduler = (callback: () => Promise<void>, delayMs: number) => void;

export class ClipboardPaster {
  private generation = 0;

  constructor(
    private readonly clipboard: ClipboardAdapter,
    private readonly sender: PasteSender,
    private readonly wait: (delayMs: number) => Promise<void> = delay,
    private readonly schedule: Scheduler = scheduleLater,
  ) {}

  async paste(
    text: string,
    restoreClipboard = true,
    target?: PasteTarget,
  ): Promise<boolean> {
    if (text.length === 0) return true;
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
      return false;
    }
    if (!restoreClipboard || previous === null || previous.length === 0) return true;
    this.schedule(async () => {
      if (generation !== this.generation) return;
      try {
        if (this.clipboard.readText() !== pastedText) return;
        this.clipboard.writeText(previous);
      } catch {
        // Clipboard restoration is best effort after the paste has succeeded.
      }
    }, 500);
    return true;
  }

  copyFallback(text: string): void {
    this.generation += 1;
    this.clipboard.writeText(text);
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
