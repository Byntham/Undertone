import WebSocket from "ws";

import { isRecord } from "./config";
import type {
  LiveSocket,
  LiveSocketFactory,
  LiveTranscriptionCallbacks,
  LiveTranscriptionSession,
} from "./liveTranscriber";

export interface NemotronRealtimeRuntime {
  withServer<T>(
    policy: "wait",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T>;
}

const READY_TIMEOUT_MS = 120_000;
const FINAL_TIMEOUT_MS = 15_000;
const MAX_BUFFERED_AUDIO_BYTES = 10 * 1024 * 1024;

export class NemotronLiveTranscriber {
  constructor(
    private readonly runtime: NemotronRealtimeRuntime,
    private readonly socketFactory: LiveSocketFactory = createSocket,
  ) {}

  start(language: string, callbacks: LiveTranscriptionCallbacks): LiveTranscriptionSession {
    return new NemotronLiveSession(
      this.runtime,
      this.socketFactory,
      language,
      callbacks,
    );
  }
}

class NemotronLiveSession implements LiveTranscriptionSession {
  readonly sampleRate = 16_000;
  private readonly queuedAudio: Uint8Array[] = [];
  private readonly completed: string[] = [];
  private readonly finalPromise: Promise<string>;
  private socket: LiveSocket | null = null;
  private partial = "";
  private stableText = "";
  private queuedBytes = 0;
  private ready = false;
  private finishRequested = false;
  private finishSent = false;
  private settled = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveFinal!: (text: string) => void;
  private rejectFinal!: (error: Error) => void;

  constructor(
    runtime: NemotronRealtimeRuntime,
    private readonly socketFactory: LiveSocketFactory,
    private readonly language: string,
    private readonly callbacks: LiveTranscriptionCallbacks,
  ) {
    this.finalPromise = new Promise<string>((resolve, reject) => {
      this.resolveFinal = resolve;
      this.rejectFinal = reject;
    });
    void this.finalPromise.catch(() => undefined);
    this.readyTimer = setTimeout(() => {
      this.fail(new Error("Nemotron streaming connection timed out."));
    }, READY_TIMEOUT_MS);
    void runtime.withServer("wait", async (baseUrl) => {
      if (this.settled) return;
      await this.connect(baseUrl);
      await this.finalPromise;
    }).catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  append(pcm16: Uint8Array): void {
    if (pcm16.length === 0 || this.settled || this.finishRequested) return;
    if (this.ready) {
      this.transmit(pcm16);
      return;
    }
    this.queuedBytes += pcm16.length;
    if (this.queuedBytes > MAX_BUFFERED_AUDIO_BYTES) {
      this.fail(new Error("Nemotron streaming could not keep up with the recording."));
      return;
    }
    this.queuedAudio.push(pcm16.slice());
  }

  async finish(): Promise<string> {
    if (!this.finishRequested && !this.settled) {
      this.finishRequested = true;
      this.flushAndFinish();
    }
    return await this.finalPromise;
  }

  cancel(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.socket?.close();
    this.rejectFinal(new Error("Nemotron streaming cancelled."));
  }

  private async connect(baseUrl: string): Promise<void> {
    const socket = this.socketFactory(realtimeUrl(baseUrl), {});
    this.socket = socket;
    socket.on("open", () => undefined);
    socket.on("message", (data) => this.onMessage(parseMessage(data)));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.settled) this.fail(new Error("Nemotron streaming connection closed early."));
    });
  }

  private onMessage(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "session.created") {
      this.transmit(JSON.stringify({
        type: "session.update",
        session: {
          sample_rate: this.sampleRate,
          language: this.language,
          automatic_punctuation: true,
        },
      }));
    } else if (value.type === "session.updated") {
      this.markReady();
    } else if (value.type === "conversation.item.input_audio_transcription.delta"
      && typeof value.delta === "string") {
      if (value.delta.length === 0) return;
      this.partial = reconcilePartial(this.partial, value.delta);
      this.callbacks.partial(this.displayText());
    } else if (value.type === "conversation.item.input_audio_transcription.completed"
      && typeof value.transcript === "string") {
      const transcript = value.transcript.trim();
      if (transcript.length > 0) {
        this.completed.push(transcript);
        const appended = `${this.stableText.length > 0 ? " " : ""}${transcript}`;
        this.stableText += appended;
        this.callbacks.stable?.(appended);
      }
      this.partial = "";
      this.callbacks.partial(this.displayText());
    } else if (value.type === "input_audio_buffer.committed") {
      this.succeed(this.displayText());
    } else if (value.type === "error") {
      this.fail(new Error(apiError(value)));
    }
  }

  private markReady(): void {
    if (this.ready || this.settled) return;
    this.ready = true;
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.flushAndFinish();
  }

  private flushAndFinish(): void {
    if (!this.ready || this.settled) return;
    for (const pcm of this.queuedAudio.splice(0)) this.transmit(pcm);
    this.queuedBytes = 0;
    if (this.finishRequested && !this.finishSent) {
      this.finishSent = true;
      this.finalTimer = setTimeout(() => {
        this.fail(new Error("Nemotron streaming finalization timed out."));
      }, FINAL_TIMEOUT_MS);
      this.transmit(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
  }

  private transmit(data: string | Uint8Array): void {
    if (this.settled || this.socket === null) return;
    try {
      this.socket.send(data);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private displayText(): string {
    return [...this.completed, this.partial]
      .map((part) => part.trim())
      .filter(Boolean)
      .join(" ");
  }

  private succeed(text: string): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.resolveFinal(text.trim());
    this.socket?.close();
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    this.rejectFinal(error);
    this.socket?.close();
    this.callbacks.failed(error);
  }

  private clearTimers(): void {
    if (this.readyTimer !== null) clearTimeout(this.readyTimer);
    if (this.finalTimer !== null) clearTimeout(this.finalTimer);
    this.readyTimer = null;
    this.finalTimer = null;
  }
}

function realtimeUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/v1/realtime";
  parsed.search = "";
  return parsed.toString();
}

function createSocket(url: string, headers: Readonly<Record<string, string>>): LiveSocket {
  return new WebSocket(url, { headers: { ...headers } }) as unknown as LiveSocket;
}

function parseMessage(data: unknown): unknown {
  try {
    if (typeof data === "string") return JSON.parse(data) as unknown;
    if (data instanceof ArrayBuffer) return JSON.parse(Buffer.from(data).toString("utf8")) as unknown;
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

function apiError(value: Record<string, unknown>): string {
  if (isRecord(value.error) && typeof value.error.message === "string") {
    return value.error.message;
  }
  return "Nemotron streaming transcription failed.";
}

function reconcilePartial(previous: string, delta: string): string {
  if (previous.length === 0 || delta.startsWith(previous)) return delta;
  // NeMo sends an append-only suffix while a hypothesis grows, but sends the
  // complete new hypothesis when recognition revises earlier text. The
  // protocol has no explicit reset flag, so recognize a replacement by its
  // substantial overlap with the prior hypothesis.
  if (!/^\s/u.test(delta) && hasSubstantialOverlap(previous, delta)) return delta;
  return previous + delta;
}

function hasSubstantialOverlap(left: string, right: string): boolean {
  const shorterLength = Math.min(left.length, right.length);
  if (shorterLength < 8 || right.length * 2 < left.length) return false;
  const runLength = Math.max(4, Math.floor(shorterLength / 2));
  for (let start = 0; start + runLength <= left.length; start += 1) {
    if (right.includes(left.slice(start, start + runLength))) return true;
  }
  return false;
}
