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

  hasOpenTurn(): boolean {
    return this.open !== null && this.open.text.length > 0;
  }

  fragmentCount(): number {
    return this.open?.fragments.length ?? 0;
  }

  charCount(): number {
    return this.open?.text.length ?? 0;
  }

  /** Peek joined turn text without clearing. */
  peekText(): string | null {
    if (this.open === null || this.open.text.length === 0) return null;
    return this.open.text;
  }

  /** Raw transcriptions joined as a complete turn, including an optional next fragment. */
  rawText(nextFragment?: string): string | null {
    const fragments = this.open?.fragments.map((fragment) => fragment.raw) ?? [];
    if (nextFragment !== undefined) fragments.push(nextFragment);
    const text = fragments.map((fragment) => fragment.trim()).filter(Boolean).join(" ");
    return text.length > 0 ? text : null;
  }

  /** Full open-turn snapshot for the draft panel, or null when empty. */
  snapshot(): TurnDraftSnapshot | null {
    if (this.open === null || this.open.fragments.length === 0) return null;
    return {
      text: this.open.text,
      fragmentCount: this.open.fragments.length,
      charCount: this.open.text.length,
    };
  }

  /** Append a raw fragment and the complete display-text snapshot it produced. */
  append(raw: string, text: string): TurnAppendResult {
    const createdAt = Date.now();
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
    this.open.text = text;
    this.open.updatedAt = createdAt;
    return {
      fragmentCount: this.open.fragments.length,
      charCount: this.open.text.length,
      text: this.open.text,
    };
  }

  /** Replace the current display snapshot, preserving the raw fragments for later cleanup. */
  replaceText(text: string): void {
    if (this.open === null || this.open.fragments.length === 0) return;
    this.open.text = text;
    this.open.fragments.at(-1)!.text = text;
    this.open.updatedAt = Date.now();
  }

  /** Remove the last fragment and restore the preceding display snapshot. */
  scratchLast(): TurnScratchResult | null {
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
    this.open.text = this.open.fragments.at(-1)!.text;
    this.open.updatedAt = Date.now();
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
}

export function isStackDictationMode(mode: unknown): boolean {
  return mode === "stack";
}
