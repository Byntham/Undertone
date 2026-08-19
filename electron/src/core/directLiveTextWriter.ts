export class DirectLiveTextWriter {
  private hypothesis = "";
  private tail = Promise.resolve();
  private failure: Error | null = null;
  private closed = false;
  private cancelled = false;
  private inserted = "";
  private scheduled = "";
  private pending = "";
  private pumping = false;

  constructor(
    private readonly insert: (text: string) => Promise<boolean>,
    private readonly onFailure: (error: Error) => void,
    private readonly settle: () => Promise<void> = settleTarget,
  ) {}

  update(hypothesis: string): void {
    if (this.closed || this.failure !== null || hypothesis === this.hypothesis) return;
    const suffix = hypothesis.startsWith(this.hypothesis)
      ? hypothesis.slice(this.hypothesis.length)
      : "";
    this.hypothesis = hypothesis;
    if (suffix.length > 0) this.enqueue(suffix);
  }

  async finish(finalText: string): Promise<string> {
    if (this.closed) return this.inserted.trimEnd();
    this.update(finalText);
    if (finalText.trim().length > 0 && !/\s$/u.test(this.scheduled)) this.enqueue(" ");
    this.closed = true;
    await this.tail;
    if (this.failure !== null) throw this.failure;
    return this.inserted.trimEnd();
  }

  cancel(): void {
    this.closed = true;
    this.cancelled = true;
    this.pending = "";
  }

  private enqueue(text: string): void {
    this.scheduled += text;
    this.pending += text;
    if (this.pumping) return;
    this.pumping = true;
    const operation = this.pump();
    this.tail = operation.catch((reason: unknown) => {
      if (this.failure !== null) return;
      this.failure = reason instanceof Error ? reason : new Error(String(reason));
      this.onFailure(this.failure);
    }).finally(() => {
      this.pumping = false;
    });
  }

  private async pump(): Promise<void> {
    while (!this.cancelled && this.failure === null && this.pending.length > 0) {
      const text = this.pending;
      this.pending = "";
      if (!await this.insert(text)) throw new Error("Windows did not accept live text input");
      this.inserted += text;
      await this.settle();
    }
  }
}

async function settleTarget(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}
