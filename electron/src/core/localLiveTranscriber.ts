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
const DRAFT_REWRITE_SECONDS = 1.25;
const RECONCILE_INTERVAL_SECONDS = 2;
const RETAINED_OVERLAP_SECONDS = 1;
const SILENCE_SETTLE_SECONDS = 0.4;
const SPEECH_RMS_THRESHOLD = 0.006;
const PREVIEW_TIMEOUT_MS = 10_000;
const TIMESTAMP_TOLERANCE_SECONDS = 0.05;
const MAX_REPEATED_TOKEN_RUNS = 3;

export const LOCAL_PREVIEW_DIAGNOSTIC_PARAMETERS = {
  sampleRate: SAMPLE_RATE,
  draftIntervalSeconds: DRAFT_INTERVAL_SECONDS,
  draftWindowSeconds: DRAFT_WINDOW_SECONDS,
  draftRewriteSeconds: DRAFT_REWRITE_SECONDS,
  reconcileIntervalSeconds: RECONCILE_INTERVAL_SECONDS,
  retainedOverlapSeconds: RETAINED_OVERLAP_SECONDS,
  silenceSettleSeconds: SILENCE_SETTLE_SECONDS,
  speechRmsThreshold: SPEECH_RMS_THRESHOLD,
} as const;

export type LocalPreviewPass = "draft" | "reconcile";

export type LocalPreviewDiagnosticEvent =
  | {
    type: "audio";
    atMs: number;
    durationMs: number;
    rms: number;
    speech: boolean;
    accumulatedSilenceMs: number;
    previewPending: boolean;
  }
  | {
    type: "request";
    atMs: number;
    requestId: number;
    pass: LocalPreviewPass;
    windowStartSeconds: number;
    windowEndSeconds: number;
    windowSeconds: number;
    settlingSilence: boolean;
  }
  | {
    type: "result";
    atMs: number;
    requestId: number;
    pass: LocalPreviewPass;
    inferenceMs: number;
    rawText: string;
    rawTokens: readonly LocalPreviewToken[];
    displayedText: string;
  }
  | { type: "display"; atMs: number; text: string }
  | { type: "failure"; atMs: number; message: string }
  | { type: "finish" | "cancel"; atMs: number; text: string };

export interface LocalPreviewTranscriberPort {
  transcribeLocalPreview(options: LocalPreviewTranscribeOptions): Promise<LocalPreviewResult>;
}

export interface LocalLiveCallbacks {
  partial(text: string): void;
  failed(error: Error): void;
  diagnostic?(event: LocalPreviewDiagnosticEvent): void;
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
  private silentBytes = 0;
  private speechSeen = false;
  private silenceSettled = false;
  private visibleTokens: AbsoluteToken[] = [];
  private lastText = "";
  private active = true;
  private failed = false;
  private inFlight: Promise<void> | null = null;
  private requestController: AbortController | null = null;
  private readonly startedAt = Date.now();
  private nextRequestId = 1;

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
    const rms = pcmRms(pcm16);
    const speech = rms >= SPEECH_RMS_THRESHOLD;
    this.chunks.push({ startByte: this.totalBytes, data: pcm16.slice() });
    this.totalBytes += pcm16.length;
    if (speech) {
      this.speechSeen = true;
      this.silentBytes = 0;
      this.silenceSettled = false;
    } else if (this.speechSeen) {
      this.silentBytes += pcm16.length;
    }
    const previewPending = this.hasPreviewWork();
    this.record({
      type: "audio",
      atMs: this.elapsedMs(),
      durationMs: pcm16.length / BYTES_PER_SECOND * 1_000,
      rms,
      speech,
      accumulatedSilenceMs: this.silentBytes / BYTES_PER_SECOND * 1_000,
      previewPending,
    });
    if (this.inFlight === null && previewPending) this.startPreview();
  }

  async finish(): Promise<string> {
    if (!this.active) return this.lastText;
    this.active = false;
    this.requestController?.abort();
    await this.inFlight;
    this.releaseAudio();
    this.record({ type: "finish", atMs: this.elapsedMs(), text: this.lastText });
    return this.lastText;
  }

  cancel(): void {
    if (!this.active) return;
    this.active = false;
    this.requestController?.abort();
    this.releaseAudio();
    this.record({ type: "cancel", atMs: this.elapsedMs(), text: this.lastText });
  }

  private hasPreviewWork(): boolean {
    if (!this.speechSeen) return false;
    if (this.silentBytes === 0) {
      return this.totalBytes - this.requestedThroughBytes
        >= secondsToBytes(DRAFT_INTERVAL_SECONDS);
    }
    return !this.silenceSettled
      && this.silentBytes >= secondsToBytes(SILENCE_SETTLE_SECONDS)
      && this.totalBytes > this.requestedThroughBytes;
  }

  private startPreview(): void {
    if (!this.active || this.failed || this.inFlight !== null) return;
    const settlingSilence = this.silentBytes >= secondsToBytes(SILENCE_SETTLE_SECONDS);
    const pass: LocalPreviewPass = settlingSilence
      || this.totalBytes - this.lastReconcileRequestBytes
        >= secondsToBytes(RECONCILE_INTERVAL_SECONDS)
      ? "reconcile"
      : "draft";
    const requestedThroughBytes = this.totalBytes;
    if (settlingSilence) {
      this.silenceSettled = true;
    }
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
    const requestId = this.nextRequestId++;
    this.record({
      type: "request",
      atMs: this.elapsedMs(),
      requestId,
      pass,
      windowStartSeconds: windowStartBytes / BYTES_PER_SECOND,
      windowEndSeconds: requestedThroughBytes / BYTES_PER_SECOND,
      windowSeconds: pcm.length / BYTES_PER_SECOND,
      settlingSilence,
    });
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
      this.acceptPass(tokens, windowStartSeconds, totalSeconds, pass);
      this.publishText();
      this.record({
        type: "result",
        atMs: this.elapsedMs(),
        requestId,
        pass,
        inferenceMs: Date.now() - startedAt,
        rawText: result.text,
        rawTokens: result.tokens.map((token) => ({ ...token })),
        displayedText: this.lastText,
      });
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
      if (this.active && !this.failed && this.hasPreviewWork()) this.startPreview();
    });
    this.inFlight = request;
  }

  private acceptPass(
    tokens: readonly AbsoluteToken[],
    windowStartSeconds: number,
    totalSeconds: number,
    pass: LocalPreviewPass,
  ): void {
    if (pass === "reconcile") {
      this.visibleTokens = [...tokens];
      return;
    }
    const replaceFrom = windowStartSeconds <= TIMESTAMP_TOLERANCE_SECONDS
      ? 0
      : Math.max(
        windowStartSeconds + RETAINED_OVERLAP_SECONDS,
        totalSeconds - DRAFT_REWRITE_SECONDS,
      );
    const preserved = this.visibleTokens.filter((token) =>
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
    this.record({ type: "display", atMs: this.elapsedMs(), text });
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
    this.record({ type: "failure", atMs: this.elapsedMs(), message: error.message });
    this.callbacks.failed(error);
  }

  private elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  private record(event: LocalPreviewDiagnosticEvent): void {
    try {
      this.callbacks.diagnostic?.(event);
    } catch {
      // Diagnostics must never interfere with dictation.
    }
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

function pcmRms(pcm16: Uint8Array): number {
  if (pcm16.length < 2) return 0;
  const view = new DataView(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength);
  let squareSum = 0;
  const sampleCount = Math.floor(pcm16.length / 2);
  for (let offset = 0; offset < sampleCount * 2; offset += 2) {
    const sample = view.getInt16(offset, true) / 32_768;
    squareSum += sample * sample;
  }
  return Math.sqrt(squareSum / sampleCount);
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
