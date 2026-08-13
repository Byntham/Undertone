import { cloneConfig, type UndertoneConfig } from "./config";
import type { PasteTarget } from "./clipboardPaster";
import type { LocalSttEngineId } from "../shared/settings";

export type DictationTarget = PasteTarget;

export type AutomaticDictationTarget =
  | { state: "captured"; value: DictationTarget }
  | { state: "unavailable" };

export type DictationDestination =
  | { completion: "open-turn" }
  | { completion: "commit"; target: AutomaticDictationTarget };

export interface PendingDictation {
  input: DictationInput;
  overlayRevision: number | undefined;
  destination: DictationDestination;
}

export type DictationInput =
  | { type: "audio"; wav: Uint8Array; captureId?: number; localEngine?: LocalSttEngineId }
  | { type: "transcript"; text: string; previewId: number };

export interface PipelineHandlers {
  dictate(
    input: DictationInput,
    destination: DictationDestination,
    config: UndertoneConfig,
    overlayRevision: number | undefined,
  ): Promise<void>;
  repaste(text: string, config: UndertoneConfig): Promise<void>;
  commit(config: UndertoneConfig): Promise<void>;
  discard(): Promise<void>;
  scratch(): Promise<void>;
}

export class DictationPipelineQueue {
  private tail = Promise.resolve();

  constructor(
    private readonly configSource: () => UndertoneConfig,
    private readonly handlers: PipelineHandlers,
  ) {}

  /** Reserve queue order while the audio renderer finishes the recording. */
  enqueuePendingDictation(pending: Promise<PendingDictation | null>): Promise<void> {
    return this.enqueue(async (config) => {
      const dictation = await pending;
      if (dictation === null) return;
      await this.handlers.dictate(
        dictation.input,
        dictation.destination,
        config,
        dictation.overlayRevision,
      );
    });
  }

  enqueueRetry(wav: Uint8Array): Promise<void> {
    return this.enqueue((config) => this.handlers.dictate(
      { type: "audio", wav },
      { completion: "open-turn" },
      config,
      undefined,
    ));
  }

  enqueueRepaste(text: string): Promise<void> {
    return this.enqueue((config) => this.handlers.repaste(text, config));
  }

  enqueueCommit(): Promise<void> {
    return this.enqueue((config) => this.handlers.commit(config));
  }

  enqueueDiscard(): Promise<void> {
    return this.enqueue(() => this.handlers.discard());
  }

  enqueueScratch(): Promise<void> {
    return this.enqueue(() => this.handlers.scratch());
  }

  private enqueue(run: (config: UndertoneConfig) => Promise<void>): Promise<void> {
    const result = this.tail.then(() => run(cloneConfig(this.configSource())));
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export interface SuccessHistoryEntry {
  id: number;
  ok: true;
  text: string;
  timestamp: number;
}

export interface FailureHistoryEntry {
  id: number;
  ok: false;
  error: string;
  timestamp: number;
  retryable: boolean;
}

export type HistoryEntry = SuccessHistoryEntry | FailureHistoryEntry;

interface StoredFailureHistoryEntry {
  id: number;
  ok: false;
  error: string;
  timestamp: number;
  retryAudio?: Uint8Array;
}

type StoredHistoryEntry = SuccessHistoryEntry | StoredFailureHistoryEntry;

const PCM16_BYTES_PER_SECOND = 16_000 * Int16Array.BYTES_PER_ELEMENT;
const MAX_RETAINED_RETRY_AUDIO_BYTES = PCM16_BYTES_PER_SECOND * 60 * 10;

export class SessionHistory {
  private readonly entries: StoredHistoryEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly maximumEntries = 20,
    private readonly maximumRetryAudio = 3,
    private readonly now: () => number = () => Date.now(),
    private readonly maximumRetryAudioBytes = MAX_RETAINED_RETRY_AUDIO_BYTES,
  ) {}

  registerSuccess(text: string): void {
    const entry: SuccessHistoryEntry = {
      id: this.nextId++,
      ok: true,
      text,
      timestamp: this.now(),
    };
    this.append(entry);
  }

  registerFailure(error: string, wav: Uint8Array): void {
    const entry: StoredFailureHistoryEntry = {
      id: this.nextId++,
      ok: false,
      error,
      retryAudio: wav,
      timestamp: this.now(),
    };
    this.append(entry);
    this.trimRetryAudio();
  }

  lookup(id: number): HistoryEntry | null {
    const entry = this.entries.find((candidate) => candidate.id === id);
    return entry === undefined ? null : historyMetadata(entry);
  }

  takeRetry(id: number): Uint8Array | null {
    const entry = this.entries.find((candidate) => !candidate.ok && candidate.id === id);
    if (entry === undefined || entry.ok || entry.retryAudio === undefined) return null;
    const wav = entry.retryAudio;
    delete entry.retryAudio;
    return wav;
  }

  latestSuccessText(): string | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.ok) return entry.text;
    }
    return null;
  }

  snapshot(): HistoryEntry[] {
    return [...this.entries].reverse().map(historyMetadata);
  }

  private append(entry: StoredHistoryEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maximumEntries) this.entries.shift();
  }

  private trimRetryAudio(): void {
    let retainedCount = 0;
    let retainedBytes = 0;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.ok || entry.retryAudio === undefined) continue;
      const fits = retainedCount < this.maximumRetryAudio
        && retainedBytes + entry.retryAudio.byteLength <= this.maximumRetryAudioBytes;
      if (!fits) {
        delete entry.retryAudio;
        continue;
      }
      retainedCount += 1;
      retainedBytes += entry.retryAudio.byteLength;
    }
  }
}

function historyMetadata(entry: StoredHistoryEntry): HistoryEntry {
  if (entry.ok) return { ...entry };
  return {
    id: entry.id,
    ok: false,
    error: entry.error,
    timestamp: entry.timestamp,
    retryable: entry.retryAudio !== undefined,
  };
}
