import { normalizeConfig, type UndertoneConfig } from "./config";
import type { DictationCompletion } from "./gestures";
import type { PasteTarget } from "./clipboardPaster";

export type DictationTarget = PasteTarget;

export interface PendingDictation {
  input: DictationInput;
  target: DictationTarget | null;
  overlayRevision: number | undefined;
  completion: DictationCompletion;
}

export type DictationInput =
  | { type: "audio"; wav: Uint8Array }
  | { type: "transcript"; text: string; previewId: number };

export interface PipelineHandlers {
  dictate(
    input: DictationInput,
    target: DictationTarget | null,
    config: UndertoneConfig,
    overlayRevision: number | undefined,
    completion: DictationCompletion,
  ): Promise<void>;
  repaste(text: string, config: UndertoneConfig): Promise<void>;
  commit(config: UndertoneConfig): Promise<void>;
  discard(): Promise<void>;
  scratch(): Promise<void>;
}

type PipelineJob =
  | {
    type: "dictate";
    pending: Promise<PendingDictation | null>;
  }
  | { type: "retry"; wav: Uint8Array }
  | { type: "repaste"; text: string }
  | { type: "commit" }
  | { type: "discard" }
  | { type: "scratch" };

interface QueuedJob {
  job: PipelineJob;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class DictationPipelineQueue {
  private readonly queue: QueuedJob[] = [];
  private running = false;

  constructor(
    private readonly configSource: () => UndertoneConfig,
    private readonly handlers: PipelineHandlers,
  ) {}

  /** Reserve queue order while the audio renderer finishes the recording. */
  enqueuePendingDictation(pending: Promise<PendingDictation | null>): Promise<void> {
    return this.enqueue({ type: "dictate", pending });
  }

  enqueueRetry(wav: Uint8Array): Promise<void> {
    return this.enqueue({ type: "retry", wav: wav.slice() });
  }

  enqueueRepaste(text: string): Promise<void> {
    return this.enqueue({ type: "repaste", text });
  }

  enqueueCommit(): Promise<void> {
    return this.enqueue({ type: "commit" });
  }

  enqueueDiscard(): Promise<void> {
    return this.enqueue({ type: "discard" });
  }

  enqueueScratch(): Promise<void> {
    return this.enqueue({ type: "scratch" });
  }

  private async enqueue(job: PipelineJob): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      this.queue.push({ job, resolve, reject });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const queued = this.queue.shift()!;
        try {
          const config = normalizeConfig(this.configSource());
          if (queued.job.type === "dictate") {
            const pending = await queued.job.pending;
            if (pending !== null) {
              await this.handlers.dictate(
                cloneInput(pending.input),
                pending.target === null ? null : { ...pending.target },
                config,
                pending.overlayRevision,
                pending.completion,
              );
            }
          } else if (queued.job.type === "retry") {
            await this.handlers.dictate(
              { type: "audio", wav: queued.job.wav },
              null,
              config,
              undefined,
              "open-turn",
            );
          } else if (queued.job.type === "repaste") {
            await this.handlers.repaste(queued.job.text, config);
          } else if (queued.job.type === "commit") {
            await this.handlers.commit(config);
          } else if (queued.job.type === "discard") {
            await this.handlers.discard();
          } else {
            await this.handlers.scratch();
          }
          queued.resolve();
        } catch (error) {
          queued.reject(error);
        }
      }
    } finally {
      this.running = false;
      if (this.queue.length > 0) void this.drain();
    }
  }
}

function cloneInput(input: DictationInput): DictationInput {
  return input.type === "audio"
    ? { type: "audio", wav: input.wav.slice() }
    : { ...input };
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
  wav?: Uint8Array;
  timestamp: number;
}

export type HistoryEntry = SuccessHistoryEntry | FailureHistoryEntry;

export class SessionHistory {
  private readonly entries: HistoryEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly maximumEntries = 20,
    private readonly maximumRetryAudio = 3,
    private readonly now: () => number = () => Date.now(),
  ) {}

  registerSuccess(text: string): SuccessHistoryEntry {
    const entry: SuccessHistoryEntry = {
      id: this.nextId++,
      ok: true,
      text,
      timestamp: this.now(),
    };
    this.append(entry);
    return { ...entry };
  }

  registerFailure(error: string, wav: Uint8Array): FailureHistoryEntry {
    const entry: FailureHistoryEntry = {
      id: this.nextId++,
      ok: false,
      error,
      wav: wav.slice(),
      timestamp: this.now(),
    };
    this.append(entry);
    let retained = 0;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const candidate = this.entries[index]!;
      if (candidate.ok || candidate.wav === undefined) continue;
      retained += 1;
      if (retained > this.maximumRetryAudio) delete candidate.wav;
    }
    return entry.wav === undefined ? { ...entry } : { ...entry, wav: entry.wav.slice() };
  }

  consumeRetry(id: number): Uint8Array | null {
    const index = this.entries.findIndex((entry) => !entry.ok && entry.id === id);
    if (index < 0) return null;
    const [entry] = this.entries.splice(index, 1);
    return entry !== undefined && !entry.ok && entry.wav !== undefined
      ? entry.wav
      : null;
  }

  latestSuccessText(): string | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index]!;
      if (entry.ok) return entry.text;
    }
    return null;
  }

  snapshot(): HistoryEntry[] {
    return [...this.entries].reverse().map(cloneEntry);
  }

  private append(entry: HistoryEntry): void {
    this.entries.push(entry);
    while (this.entries.length > this.maximumEntries) this.entries.shift();
  }
}

function cloneEntry(entry: HistoryEntry): HistoryEntry {
  if (entry.ok) return { ...entry };
  return entry.wav === undefined ? { ...entry } : { ...entry, wav: entry.wav.slice() };
}
