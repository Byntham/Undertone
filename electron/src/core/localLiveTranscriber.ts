import { wrapPcm16Wav } from "./audio";
import type {
  LocalPreviewResult,
  LocalPreviewToken,
  LocalPreviewTranscribeOptions,
} from "./transcriber";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
const DRAFT_INTERVAL_SECONDS = 0.25;
const DRAFT_WINDOW_SECONDS = 5;
const RECONCILE_INTERVAL_SECONDS = 2;
const RETAINED_OVERLAP_SECONDS = 1;
const PREVIEW_TIMEOUT_MS = 10_000;
const TIMESTAMP_TOLERANCE_SECONDS = 0.05;
const MAX_REPEATED_TOKEN_RUNS = 3;

export type LocalPreviewPass = "draft" | "reconcile";

export interface LocalPreviewTranscriberPort {
  transcribeLocalPreview(options: LocalPreviewTranscribeOptions): Promise<LocalPreviewResult>;
}

export interface LocalLiveCallbacks {
  partial(text: string): void;
  failed(error: Error): void;
  timing?(
    pass: LocalPreviewPass,
    windowSeconds: number,
    totalSeconds: number,
    inferenceMs: number,
  ): void;
}

export interface LocalLiveSession {
  readonly sampleRate: number;
  append(pcm16: Uint8Array): void;
  finish(): Promise<string>;
  cancel(): void;
}

interface AbsoluteToken extends LocalPreviewToken {
  startSeconds: number;
  endSeconds: number;
}

interface AudioChunk {
  startByte: number;
  data: Uint8Array;
}

export class LocalLiveTranscriber {
  constructor(private readonly transcriber: LocalPreviewTranscriberPort) {}

  start(language: string, callbacks: LocalLiveCallbacks): LocalLiveSession {
    return new LocalPreviewSession(this.transcriber, language, callbacks);
  }
}

class LocalPreviewSession implements LocalLiveSession {
  readonly sampleRate = SAMPLE_RATE;
  private readonly chunks: AudioChunk[] = [];
  private totalBytes = 0;
  private requestedThroughBytes = 0;
  private lastReconcileRequestBytes = 0;
  private reconciledTokens: AbsoluteToken[] = [];
  private visibleTokens: AbsoluteToken[] = [];
  private lastText = "";
  private active = true;
  private failed = false;
  private inFlight: Promise<void> | null = null;
  private requestController: AbortController | null = null;

  constructor(
    private readonly transcriber: LocalPreviewTranscriberPort,
    private readonly language: string,
    private readonly callbacks: LocalLiveCallbacks,
  ) {}

  append(pcm16: Uint8Array): void {
    if (!this.active || this.failed || pcm16.length === 0) return;
    if (pcm16.length % 2 !== 0) {
      this.disable(new Error("Local live transcription received incomplete PCM16 audio."));
      return;
    }
    this.chunks.push({ startByte: this.totalBytes, data: pcm16.slice() });
    this.totalBytes += pcm16.length;
    if (this.inFlight === null && this.hasDraftInterval()) this.startPreview();
  }

  async finish(): Promise<string> {
    if (!this.active) return this.lastText;
    this.active = false;
    this.requestController?.abort();
    await this.inFlight;
    this.releaseAudio();
    return this.lastText;
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.requestController?.abort();
    this.releaseAudio();
  }

  private hasDraftInterval(): boolean {
    return this.totalBytes - this.requestedThroughBytes
      >= secondsToBytes(DRAFT_INTERVAL_SECONDS);
  }

  private startPreview(): void {
    if (!this.active || this.failed || this.inFlight !== null) return;
    const pass: LocalPreviewPass = this.totalBytes - this.lastReconcileRequestBytes
      >= secondsToBytes(RECONCILE_INTERVAL_SECONDS)
      ? "reconcile"
      : "draft";
    const requestedThroughBytes = this.totalBytes;
    const windowStartBytes = Math.max(
      this.bufferStartByte(),
      pass === "draft"
        ? requestedThroughBytes - secondsToBytes(DRAFT_WINDOW_SECONDS)
        : 0,
    );
    const pcm = this.audioSlice(windowStartBytes, requestedThroughBytes);
    this.requestedThroughBytes = requestedThroughBytes;
    if (pass === "reconcile") this.lastReconcileRequestBytes = requestedThroughBytes;
    const startedAt = Date.now();
    const controller = new AbortController();
    this.requestController = controller;
    const request = this.transcriber.transcribeLocalPreview({
      wav: wrapPcm16Wav(pcm, SAMPLE_RATE),
      language: this.language,
      prompt: this.previewPrompt(),
      signal: controller.signal,
      timeoutMs: PREVIEW_TIMEOUT_MS,
    }).then((result) => {
      if (!this.active || controller.signal.aborted) return;
      const windowStartSeconds = windowStartBytes / BYTES_PER_SECOND;
      const totalSeconds = requestedThroughBytes / BYTES_PER_SECOND;
      const tokens = absoluteTokens(
        trimTokenLoop(result.tokens),
        windowStartSeconds,
      );
      this.acceptPass(tokens, windowStartSeconds, pass);
      this.publishText();
      this.callbacks.timing?.(
        pass,
        pcm.length / BYTES_PER_SECOND,
        totalSeconds,
        Date.now() - startedAt,
      );
    }).catch((error: unknown) => {
      if (!this.active || controller.signal.aborted) return;
      this.disable(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (this.requestController === controller) this.requestController = null;
      if (this.inFlight === request) this.inFlight = null;
      if (this.active && !this.failed && this.hasDraftInterval()) this.startPreview();
    });
    this.inFlight = request;
  }

  private acceptPass(
    tokens: readonly AbsoluteToken[],
    windowStartSeconds: number,
    pass: LocalPreviewPass,
  ): void {
    if (pass === "reconcile") {
      this.reconciledTokens = [...tokens];
      this.visibleTokens = [...tokens];
      return;
    }
    const replaceFrom = windowStartSeconds <= TIMESTAMP_TOLERANCE_SECONDS
      ? 0
      : windowStartSeconds + RETAINED_OVERLAP_SECONDS;
    const preserved = this.reconciledTokens.filter((token) =>
      token.endSeconds <= replaceFrom + TIMESTAMP_TOLERANCE_SECONDS);
    const replacement = replaceFrom === 0
      ? [...tokens]
      : tokens.filter((token) =>
        token.endSeconds > replaceFrom + TIMESTAMP_TOLERANCE_SECONDS);
    this.visibleTokens = stitchTokens(preserved, replacement);
  }

  private publishText(): void {
    const text = normalizeTranscript(
      this.visibleTokens.map(({ text: tokenText }) => tokenText).join(""),
    );
    if (text === this.lastText) return;
    this.lastText = text;
    this.callbacks.partial(text);
  }

  private previewPrompt(): string {
    return "";
  }

  private bufferStartByte(): number {
    return this.chunks[0]?.startByte ?? this.totalBytes;
  }

  private audioSlice(startByte: number, endByte: number): Uint8Array {
    const result = new Uint8Array(endByte - startByte);
    for (const chunk of this.chunks) {
      const chunkEnd = chunk.startByte + chunk.data.length;
      const copyStart = Math.max(startByte, chunk.startByte);
      const copyEnd = Math.min(endByte, chunkEnd);
      if (copyEnd <= copyStart) continue;
      result.set(
        chunk.data.subarray(copyStart - chunk.startByte, copyEnd - chunk.startByte),
        copyStart - startByte,
      );
    }
    return result;
  }

  private disable(error: Error): void {
    if (this.failed) return;
    this.failed = true;
    this.releaseAudio();
    this.callbacks.failed(error);
  }

  private releaseAudio(): void {
    this.chunks.length = 0;
  }
}

function absoluteTokens(
  tokens: readonly LocalPreviewToken[],
  offsetSeconds: number,
): AbsoluteToken[] {
  return tokens.map((token) => ({
    ...token,
    startSeconds: token.startSeconds + offsetSeconds,
    endSeconds: token.endSeconds + offsetSeconds,
  }));
}

function secondsToBytes(seconds: number): number {
  return Math.max(0, Math.round(seconds * BYTES_PER_SECOND / 2) * 2);
}

function tokenOverlap(committed: readonly number[], current: readonly number[]): number {
  const maximum = Math.min(committed.length, current.length);
  for (let length = maximum; length > 0; length -= 1) {
    let matches = true;
    for (let index = 0; index < length; index += 1) {
      if (committed[committed.length - length + index] !== current[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return length;
  }
  return 0;
}

function stitchTokens(
  preserved: readonly AbsoluteToken[],
  replacement: readonly AbsoluteToken[],
): AbsoluteToken[] {
  if (preserved.length === 0) return [...replacement];
  if (replacement.length === 0) return [...preserved];

  const searchStart = Math.max(0, preserved.length - 64);
  let bestStart = -1;
  let bestLength = 0;
  let bestTimeDifference = Number.POSITIVE_INFINITY;
  for (let start = searchStart; start < preserved.length; start += 1) {
    const timeDifference = Math.abs(
      preserved[start]!.startSeconds - replacement[0]!.startSeconds,
    );
    let length = 0;
    while (start + length < preserved.length
      && length < replacement.length
      && preserved[start + length]?.id === replacement[length]?.id) {
      length += 1;
    }
    if (length > bestLength) {
      bestStart = start;
      bestLength = length;
      bestTimeDifference = timeDifference;
    }
  }
  if (bestLength >= 2
      && (bestTimeDifference <= RETAINED_OVERLAP_SECONDS * 1.5 || bestLength >= 5)) {
    return [...preserved.slice(0, bestStart), ...replacement];
  }

  const overlap = tokenOverlap(
    preserved.map(({ id }) => id),
    replacement.map(({ id }) => id),
  );
  return [...preserved, ...replacement.slice(overlap)];
}

function trimTokenLoop(tokens: readonly LocalPreviewToken[]): readonly LocalPreviewToken[] {
  for (let start = 0; start < tokens.length; start += 1) {
    const remaining = tokens.length - start;
    const maximumUnit = Math.min(24, Math.floor(remaining / (MAX_REPEATED_TOKEN_RUNS + 1)));
    for (let unit = 1; unit <= maximumUnit; unit += 1) {
      let repeated = true;
      for (let run = 1; run <= MAX_REPEATED_TOKEN_RUNS && repeated; run += 1) {
        for (let index = 0; index < unit; index += 1) {
          if (tokens[start + index]?.id !== tokens[start + run * unit + index]?.id) {
            repeated = false;
            break;
          }
        }
      }
      if (repeated) return tokens.slice(0, start + MAX_REPEATED_TOKEN_RUNS * unit);
    }
  }
  return tokens;
}

function normalizeTranscript(text: string): string {
  return text.trim().split(/\s+/u).filter(Boolean).join(" ");
}
