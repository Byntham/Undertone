import type { OpenTurnCleanupStrategy } from "../shared/settings";

interface TurnFragment {
  raw: string;
  text: string;
}
interface OpenTurn {
  fragments: TurnFragment[];
  cleanupStrategy: OpenTurnCleanupStrategy;
}

interface TurnAppendResult {
  fragmentCount: number;
  text: string;
}

interface TurnScratchResult {
  fragmentCount: number;
  text: string;
}

interface TurnDraftSnapshot {
  text: string;
  fragmentCount: number;
}

export class TurnBuffer {
  private open: OpenTurn | null = null;

  /** Peek joined turn text without clearing. */
  peekText(): string | null {
    return this.open?.fragments.at(-1)?.text ?? null;
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
      text: this.open.fragments.at(-1)!.text,
      fragmentCount: this.open.fragments.length,
    };
  }

  /** Append a raw fragment and the complete display-text snapshot it produced. */
  append(
    raw: string,
    text: string,
    cleanupStrategy: OpenTurnCleanupStrategy,
  ): TurnAppendResult {
    requireNonblank(raw, "raw fragment");
    requireNonblank(text, "display text");
    if (this.open === null) {
      this.open = {
        fragments: [],
        cleanupStrategy,
      };
    }
    this.open.fragments.push({
      raw,
      text,
    });
    return {
      fragmentCount: this.open.fragments.length,
      text,
    };
  }

  /** Cleanup timing is fixed when a turn starts and changes with the next turn. */
  activeCleanupStrategy(): OpenTurnCleanupStrategy | null {
    return this.open?.cleanupStrategy ?? null;
  }

  /** Replace the current display snapshot, preserving the raw fragments for later cleanup. */
  replaceText(text: string): void {
    requireNonblank(text, "display text");
    if (this.open === null || this.open.fragments.length === 0) return;
    this.open.fragments.at(-1)!.text = text;
  }

  /** Remove the last fragment and restore the preceding display snapshot. */
  scratchLast(): TurnScratchResult | null {
    if (this.open === null || this.open.fragments.length === 0) return null;
    this.open.fragments.pop();
    if (this.open.fragments.length === 0) {
      this.open = null;
      return {
        fragmentCount: 0,
        text: "",
      };
    }
    const text = this.open.fragments.at(-1)!.text;
    return {
      fragmentCount: this.open.fragments.length,
      text,
    };
  }

  /** Clear open turn. Returns true if there was content. */
  clear(): boolean {
    const had = this.open !== null;
    this.open = null;
    return had;
  }
}

function requireNonblank(value: string, label: string): void {
  if (value.trim().length === 0) throw new Error(`${label} must not be blank`);
}
