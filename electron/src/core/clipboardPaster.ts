export interface ClipboardAdapter {
  readText(): string;
  writeText(value: string): void;
}

export interface PasteSender {
  sendPaste(): Promise<boolean>;
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

  async paste(text: string, restoreClipboard = true): Promise<void> {
    if (text.length === 0) return;
    const generation = ++this.generation;
    let previous: string | null;
    try {
      previous = this.clipboard.readText();
    } catch {
      previous = null;
    }
    this.clipboard.writeText(text);
    await this.wait(150);
    if (!await this.sender.sendPaste()) {
      throw new Error("Windows did not accept the paste keystroke");
    }
    if (!restoreClipboard || previous === null || previous.length === 0) return;
    this.schedule(async () => {
      if (generation !== this.generation) return;
      try {
        if (this.clipboard.readText() !== text) return;
        this.clipboard.writeText(previous);
      } catch {
        // Clipboard restoration is best effort after the paste has succeeded.
      }
    }, 500);
  }

  copyFallback(text: string): void {
    this.generation += 1;
    this.clipboard.writeText(text);
  }
}

async function delay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function scheduleLater(callback: () => Promise<void>, delayMs: number): void {
  setTimeout(() => { void callback(); }, delayMs);
}
