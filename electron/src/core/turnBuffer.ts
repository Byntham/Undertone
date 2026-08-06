export interface TurnFragment {
  id: string;
  raw: string;
  text: string;
  createdAt: number;
}

export interface OpenTurn {
  id: string;
  fragments: TurnFragment[];
  text: string;
  startedAt: number;
  updatedAt: number;
}

export interface TurnAppendResult {
  fragmentCount: number;
  charCount: number;
  text: string;
  lastFragment: string;
}

export interface TurnScratchResult {
  removed: string;
  fragmentCount: number;
  charCount: number;
  text: string;
}

export interface TurnDraftSnapshot {
  text: string;
  fragmentCount: number;
  charCount: number;
}

export class TurnBuffer {
  private open: OpenTurn | null = null;
  private nextFragmentId = 1;
  private nextTurnId = 1;

  constructor(
    private readonly idleMs: () => number = () => 15 * 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Left context for formatting: full open turn, or "" at start of turn. */
  contextBefore(): string {
    this.expireIfIdle();
    return this.open?.text ?? "";
  }

  hasOpenTurn(): boolean {
    this.expireIfIdle();
    return this.open !== null && this.open.text.length > 0;
  }

  fragmentCount(): number {
    this.expireIfIdle();
    return this.open?.fragments.length ?? 0;
  }

  charCount(): number {
    this.expireIfIdle();
    return this.open?.text.length ?? 0;
  }

  /** Peek joined turn text without clearing. */
  peekText(): string | null {
    this.expireIfIdle();
    if (this.open === null || this.open.text.length === 0) return null;
    return this.open.text;
  }

  /** Full open-turn snapshot for the draft panel, or null when empty. */
  snapshot(): TurnDraftSnapshot | null {
    this.expireIfIdle();
    if (this.open === null || this.open.fragments.length === 0) return null;
    return {
      text: this.open.text,
      fragmentCount: this.open.fragments.length,
      charCount: this.open.text.length,
    };
  }

  append(raw: string, text: string): TurnAppendResult {
    this.expireIfIdle();
    const createdAt = this.now();
    if (this.open === null) {
      this.open = {
        id: String(this.nextTurnId++),
        fragments: [],
        text: "",
        startedAt: createdAt,
        updatedAt: createdAt,
      };
    }
    this.open.fragments.push({
      id: String(this.nextFragmentId++),
      raw,
      text,
      createdAt,
    });
    this.open.text += text;
    this.open.updatedAt = createdAt;
    return {
      fragmentCount: this.open.fragments.length,
      charCount: this.open.text.length,
      text: this.open.text,
      lastFragment: text,
    };
  }

  /** Remove the last fragment and rebuild joined text. */
  scratchLast(): TurnScratchResult | null {
    this.expireIfIdle();
    if (this.open === null || this.open.fragments.length === 0) return null;
    const removed = this.open.fragments.pop()!;
    if (this.open.fragments.length === 0) {
      this.open = null;
      return {
        removed: removed.text,
        fragmentCount: 0,
        charCount: 0,
        text: "",
      };
    }
    this.open.text = this.open.fragments.map((fragment) => fragment.text).join("");
    this.open.updatedAt = this.now();
    return {
      removed: removed.text,
      fragmentCount: this.open.fragments.length,
      charCount: this.open.text.length,
      text: this.open.text,
    };
  }

  /** Clear open turn. Returns true if there was content. */
  clear(): boolean {
    const had = this.open !== null && this.open.text.length > 0;
    this.open = null;
    return had;
  }

  private expireIfIdle(): void {
    if (this.open === null) return;
    const limit = this.idleMs();
    if (limit <= 0) return;
    if (this.now() - this.open.updatedAt >= limit) this.open = null;
  }
}

export function isStackDictationMode(mode: unknown): boolean {
  return mode === "stack";
}
