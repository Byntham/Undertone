import WebSocket from "ws";

import { isRecord } from "./config";

export type LiveTranscriptionProvider = "openai" | "xai";

export interface LiveTranscriptionOptions {
  provider: LiveTranscriptionProvider;
  apiKey: string;
  language: string;
  vocabulary: readonly unknown[];
}

export interface LiveTranscriptionCallbacks {
  partial(text: string): void;
  failed(error: Error): void;
}

export interface LiveTranscriptionSession {
  readonly sampleRate: number;
  append(pcm16: Uint8Array): void;
  finish(): Promise<string>;
  cancel(): void;
}

export interface LiveSocket {
  on(event: "open", listener: () => void): LiveSocket;
  on(event: "message", listener: (data: unknown) => void): LiveSocket;
  on(event: "error", listener: (error: Error) => void): LiveSocket;
  on(event: "close", listener: () => void): LiveSocket;
  send(data: string | Uint8Array): void;
  close(): void;
}

export type LiveSocketFactory = (
  url: string,
  headers: Readonly<Record<string, string>>,
) => LiveSocket;

const FINAL_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 10_000;
const MAX_BUFFERED_AUDIO_BYTES = 10 * 1024 * 1024;

export class LiveTranscriber {
  constructor(private readonly socketFactory: LiveSocketFactory = createSocket) {}

  start(
    options: LiveTranscriptionOptions,
    callbacks: LiveTranscriptionCallbacks,
  ): LiveTranscriptionSession {
    const apiKey = options.apiKey.trim();
    if (apiKey.length === 0) {
      throw new Error("No API key configured for live transcription.");
    }
    return options.provider === "openai"
      ? new OpenAiLiveSession(this.socketFactory, { ...options, apiKey }, callbacks)
      : new XaiLiveSession(this.socketFactory, { ...options, apiKey }, callbacks);
  }
}

abstract class BaseLiveSession implements LiveTranscriptionSession {
  abstract readonly sampleRate: number;
  protected readonly socket: LiveSocket;
  private readonly queuedAudio: Uint8Array[] = [];
  private queuedBytes = 0;
  private ready = false;
  private finishRequested = false;
  private terminalMessageSent = false;
  private settled = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly finalPromise: Promise<string>;
  private resolveFinal!: (text: string) => void;
  private rejectFinal!: (error: Error) => void;

  protected constructor(
    factory: LiveSocketFactory,
    url: string,
    headers: Readonly<Record<string, string>>,
    protected readonly callbacks: LiveTranscriptionCallbacks,
  ) {
    this.finalPromise = new Promise<string>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    void this.finalPromise.catch(() => undefined);
    this.socket = factory(url, headers);
    this.socket.on("open", () => this.onOpen());
    this.socket.on("message", (data) => this.onMessage(parseMessage(data)));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", () => {
      if (!this.settled) this.fail(new Error("Live transcription connection closed early."));
    });
    this.readyTimer = setTimeout(() => {
      this.fail(new Error("Live transcription connection timed out."));
    }, READY_TIMEOUT_MS);
  }

  append(pcm16: Uint8Array): void {
    if (pcm16.length === 0 || this.settled || this.finishRequested) return;
    if (this.ready) {
      this.sendAudio(pcm16);
      return;
    }
    this.queuedBytes += pcm16.length;
    if (this.queuedBytes > MAX_BUFFERED_AUDIO_BYTES) {
      this.fail(new Error("Live transcription could not keep up with the recording."));
      return;
    }
    this.queuedAudio.push(pcm16.slice());
  }

  async finish(): Promise<string> {
    if (this.settled) return await this.finalPromise;
    if (!this.finishRequested) {
      this.finishRequested = true;
      this.finalTimer = setTimeout(() => {
        this.fail(new Error("Live transcription finalization timed out."));
      }, FINAL_TIMEOUT_MS);
      this.flushAndFinish();
    }
    return await this.finalPromise;
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.socket.close();
    this.rejectFinal(new Error("Live transcription cancelled."));
  }

  protected markReady(): void {
    if (this.ready || this.settled) return;
    this.ready = true;
    if (this.readyTimer !== null) {
      clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    this.flushAndFinish();
  }

  protected succeed(text: string): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.resolveFinal(text.trim());
    this.socket.close();
  }

  protected fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.rejectFinal(error);
    this.socket.close();
    this.callbacks.failed(error);
  }

  protected abstract onOpen(): void;
  protected abstract onMessage(event: unknown): void;
  protected abstract sendAudio(pcm16: Uint8Array): void;
  protected abstract sendFinish(): void;

  protected transmit(data: string | Uint8Array): void {
    if (this.settled) return;
    try {
      this.socket.send(data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private flushAndFinish(): void {
    if (!this.ready || this.settled) return;
    for (const pcm of this.queuedAudio.splice(0)) {
      this.sendAudio(pcm);
      if (this.settled) return;
    }
    this.queuedBytes = 0;
    if (this.finishRequested && !this.terminalMessageSent) {
      this.terminalMessageSent = true;
      this.sendFinish();
    }
  }

  private clearTimers(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    if (this.finalTimer !== null) clearTimeout(this.finalTimer);
    this.readyTimer = null;
    this.finalTimer = null;
  }
}

class OpenAiLiveSession extends BaseLiveSession {
  readonly sampleRate = 24_000;
  private partialText = "";

  constructor(
    factory: LiveSocketFactory,
    private readonly options: LiveTranscriptionOptions,
    callbacks: LiveTranscriptionCallbacks,
  ) {
    super(
      factory,
      "wss://api.openai.com/v1/realtime?intent=transcription",
      { Authorization: `Bearer ${options.apiKey}` },
      callbacks,
    );
  }

  protected onOpen(): void {
    this.transmit(JSON.stringify({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: this.sampleRate },
            transcription: {
              model: "gpt-live-transcribe",
              languages: [this.options.language],
              delay: "low",
            },
            turn_detection: null,
          },
        },
      },
    }));
  }

  protected onMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "session.updated") {
      this.markReady();
    } else if (value.type === "conversation.item.input_audio_transcription.delta"
      && typeof value.delta === "string") {
      this.partialText += value.delta;
      this.callbacks.partial(this.partialText);
    } else if (value.type === "conversation.item.input_audio_transcription.completed"
      && typeof value.transcript === "string") {
      this.succeed(value.transcript.trim() || this.partialText);
    } else if (value.type === "error") {
      this.fail(new Error(apiError(value, "OpenAI live transcription failed.")));
    }
  }

  protected sendAudio(pcm16: Uint8Array): void {
    this.transmit(JSON.stringify({
      type: "input_audio_buffer.append",
      audio: Buffer.from(pcm16).toString("base64"),
    }));
  }

  protected sendFinish(): void {
    this.transmit(JSON.stringify({ type: "input_audio_buffer.commit" }));
  }
}

class XaiLiveSession extends BaseLiveSession {
  readonly sampleRate = 16_000;
  private readonly completedUtterances: string[] = [];
  private readonly lockedChunks: string[] = [];
  private interim = "";

  constructor(
    factory: LiveSocketFactory,
    options: LiveTranscriptionOptions,
    callbacks: LiveTranscriptionCallbacks,
  ) {
    const query = new URLSearchParams({
      sample_rate: "16000",
      encoding: "pcm",
      interim_results: "true",
      language: options.language,
    });
    for (const term of vocabularyTerms(options.vocabulary)) query.append("keyterm", term);
    super(
      factory,
      `wss://api.x.ai/v1/stt?${query.toString()}`,
      { Authorization: `Bearer ${options.apiKey}` },
      callbacks,
    );
  }

  protected onOpen(): void {}

  protected onMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "transcript.created") {
      this.markReady();
    } else if (value.type === "transcript.partial" && typeof value.text === "string") {
      this.acceptPartial(value);
    } else if (value.type === "transcript.done") {
      const final = typeof value.text === "string" ? value.text.trim() : "";
      this.succeed(final || this.displayText());
    } else if (value.type === "error") {
      this.fail(new Error(apiError(value, "xAI live transcription failed.")));
    }
  }

  protected sendAudio(pcm16: Uint8Array): void {
    this.transmit(pcm16);
  }

  protected sendFinish(): void {
    this.transmit(JSON.stringify({ type: "audio.done" }));
  }

  private acceptPartial(value: Record<string, unknown>): void {
    const text = typeof value.text === "string" ? value.text.trim() : "";
    if (value.is_final === true) {
      this.interim = "";
      if (value.speech_final === true) {
        if (text.length > 0) this.completedUtterances.push(text);
        this.lockedChunks.length = 0;
      } else if (text.length > 0) {
        this.lockedChunks.push(text);
      }
    } else {
      this.interim = text;
    }
    this.callbacks.partial(this.displayText());
  }

  private displayText(): string {
    return joinText([
      ...this.completedUtterances,
      ...this.lockedChunks,
      this.interim,
    ]);
  }
}

function createSocket(
  url: string,
  headers: Readonly<Record<string, string>>,
): LiveSocket {
  return new WebSocket(url, { headers: { ...headers } }) as unknown as LiveSocket;
}

function parseMessage(data: unknown): unknown {
  try {
    if (typeof data === "string") return JSON.parse(data) as unknown;
    if (data instanceof ArrayBuffer) {
      return JSON.parse(Buffer.from(data).toString("utf8")) as unknown;
    }
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(
        Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8"),
      ) as unknown;
    }
    return JSON.parse(String(data)) as unknown;
  } catch {
    return null;
  }
}

function apiError(value: Record<string, unknown>, fallback: string): string {
  if (typeof value.message === "string" && value.message.trim().length > 0) {
    return value.message;
  }
  if (isRecord(value.error) && typeof value.error.message === "string"
    && value.error.message.trim().length > 0) {
    return value.error.message;
  }
  return fallback;
}

function vocabularyTerms(values: readonly unknown[]): string[] {
  return values.slice(0, 100).map((value) => String(value).trim().slice(0, 50)).filter(Boolean);
}

function joinText(parts: readonly string[]): string {
  return parts.map((part) => part.trim()).filter(Boolean).join(" ");
}
