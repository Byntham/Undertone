import { describe, expect, it, vi } from "vitest";

import {
  LiveTranscriber,
  type LiveSocket,
  type LiveSocketFactory,
} from "../src/core/liveTranscriber";

describe("live transcriber", () => {
  it("streams OpenAI PCM after session setup and commits on release", async () => {
    const harness = socketHarness();
    const partial = vi.fn();
    const stable = vi.fn();
    const failed = vi.fn();
    const session = new LiveTranscriber(harness.factory).start({
      provider: "openai",
      apiKey: "openai-secret",
      language: "en",
    }, { partial, stable, failed });

    expect(session.sampleRate).toBe(24_000);
    expect(harness.url).toBe(
      "wss://api.openai.com/v1/realtime?intent=transcription",
    );
    expect(harness.headers).toEqual({ Authorization: "Bearer openai-secret" });
    session.append(Uint8Array.of(0, 1, 2, 3));
    expect(harness.socket.sent).toEqual([]);

    harness.socket.emit("open");
    expect(jsonMessages(harness.socket)[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: {
              model: "gpt-live-transcribe",
              languages: ["en"],
              delay: "low",
            },
            turn_detection: null,
          },
        },
      },
    });
    harness.socket.message({ type: "session.updated" });
    expect(jsonMessages(harness.socket)[1]).toEqual({
      type: "input_audio_buffer.append",
      audio: "AAECAw==",
    });
    harness.socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " Hello",
    });
    harness.socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " world",
    });
    expect(partial).toHaveBeenLastCalledWith("Hello world");
    expect(stable.mock.calls.map(([text]) => text)).toEqual(["Hello", " world"]);

    const final = session.finish();
    expect(jsonMessages(harness.socket).at(-1)).toEqual({
      type: "input_audio_buffer.commit",
    });
    harness.socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Hello world.",
    });
    await expect(final).resolves.toBe("Hello world.");
    expect(failed).not.toHaveBeenCalled();
    expect(harness.socket.closed).toBe(true);
  });

  it("streams raw xAI PCM and revises partials without recognition hints", async () => {
    const harness = socketHarness();
    const partial = vi.fn();
    const session = new LiveTranscriber(harness.factory).start({
      provider: "xai",
      apiKey: "xai-secret",
      language: "fr",
    }, { partial, failed: vi.fn() });

    expect(session.sampleRate).toBe(16_000);
    expect(harness.headers).toEqual({ Authorization: "Bearer xai-secret" });
    const url = new URL(harness.url);
    expect(`${url.origin}${url.pathname}`).toBe("wss://api.x.ai/v1/stt");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("encoding")).toBe("pcm");
    expect(url.searchParams.get("interim_results")).toBe("true");
    expect(url.searchParams.get("language")).toBe("fr");
    expect(url.searchParams.has("keyterm")).toBe(false);

    harness.socket.emit("open");
    session.append(Uint8Array.of(4, 5));
    expect(harness.socket.sent).toEqual([]);
    harness.socket.message({ type: "transcript.created" });
    expect(harness.socket.sent[0]).toEqual(Uint8Array.of(4, 5));
    harness.socket.message({
      type: "transcript.partial",
      text: "I would",
      is_final: false,
      speech_final: false,
    });
    harness.socket.message({
      type: "transcript.partial",
      text: "I will",
      is_final: false,
      speech_final: false,
    });
    harness.socket.message({
      type: "transcript.partial",
      text: "I will dictate",
      is_final: true,
      speech_final: true,
    });
    expect(partial.mock.calls.map(([text]) => text)).toEqual([
      "I would",
      "I will",
      "I will dictate",
    ]);

    const final = session.finish();
    expect(jsonMessages(harness.socket).at(-1)).toEqual({ type: "audio.done" });
    harness.socket.message({ type: "transcript.done", text: "I will dictate." });
    await expect(final).resolves.toBe("I will dictate.");
  });

  it("requests finalized-only xAI events for live typing and emits locked chunks once", async () => {
    const harness = socketHarness();
    const stable = vi.fn();
    const session = new LiveTranscriber(harness.factory).start({
      provider: "xai",
      apiKey: "xai-secret",
      language: "en",
      interimResults: false,
    }, { partial: vi.fn(), stable, failed: vi.fn() });
    expect(new URL(harness.url).searchParams.get("interim_results")).toBe("false");
    harness.socket.emit("open");
    harness.socket.message({ type: "transcript.created" });
    harness.socket.message({
      type: "transcript.partial",
      text: "One locked chunk",
      is_final: true,
      speech_final: false,
    });
    harness.socket.message({
      type: "transcript.partial",
      text: "One locked chunk with punctuation.",
      is_final: true,
      speech_final: true,
    });
    expect(stable).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledWith("One locked chunk");
    const final = session.finish();
    harness.socket.message({ type: "transcript.done", text: "One locked chunk with punctuation." });
    await expect(final).resolves.toBe("One locked chunk with punctuation.");
  });

  it("reports streaming failures and never substitutes another transcription path", async () => {
    const harness = socketHarness();
    const failed = vi.fn();
    const session = new LiveTranscriber(harness.factory).start({
      provider: "openai",
      apiKey: "secret",
      language: "en",
    }, { partial: vi.fn(), failed });
    harness.socket.emit("open");
    harness.socket.message({ type: "error", error: { message: "quota exceeded" } });
    expect(failed).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "quota exceeded" }));
    await expect(session.finish()).rejects.toThrow("quota exceeded");
    expect(harness.socket.closed).toBe(true);
  });

  it("preserves the latest live text when a terminal event has no transcript", async () => {
    const openAi = socketHarness();
    const openAiSession = new LiveTranscriber(openAi.factory).start({
      provider: "openai",
      apiKey: "secret",
      language: "en",
    }, { partial: vi.fn(), failed: vi.fn() });
    openAi.socket.emit("open");
    openAi.socket.message({ type: "session.updated" });
    openAi.socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Keep this",
    });
    const openAiFinal = openAiSession.finish();
    openAi.socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "",
    });
    await expect(openAiFinal).resolves.toBe("Keep this");

    const xai = socketHarness();
    const xaiSession = new LiveTranscriber(xai.factory).start({
      provider: "xai",
      apiKey: "secret",
      language: "en",
    }, { partial: vi.fn(), failed: vi.fn() });
    xai.socket.emit("open");
    xai.socket.message({ type: "transcript.created" });
    xai.socket.message({
      type: "transcript.partial",
      text: "Keep this too",
      is_final: false,
      speech_final: false,
    });
    const xaiFinal = xaiSession.finish();
    xai.socket.message({ type: "transcript.done", duration: 1 });
    await expect(xaiFinal).resolves.toBe("Keep this too");
  });

  it("reports a stalled setup instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    try {
      const harness = socketHarness();
      const failed = vi.fn();
      const session = new LiveTranscriber(harness.factory).start({
        provider: "xai",
        apiKey: "secret",
        language: "en",
      }, { partial: vi.fn(), failed });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({
        message: "Live transcription connection timed out.",
      }));
      await expect(session.finish()).rejects.toThrow(/connection timed out/u);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes WebSocket send errors through the live failure callback", async () => {
    const harness = socketHarness();
    const failed = vi.fn();
    const session = new LiveTranscriber(harness.factory).start({
      provider: "openai",
      apiKey: "secret",
      language: "en",
    }, { partial: vi.fn(), failed });
    harness.socket.sendError = new Error("socket write failed");
    harness.socket.emit("open");
    expect(failed).toHaveBeenCalledWith(harness.socket.sendError);
    await expect(session.finish()).rejects.toThrow("socket write failed");
  });

  it("refuses to create a session without the selected provider key", () => {
    expect(() => new LiveTranscriber(socketHarness().factory).start({
      provider: "xai",
      apiKey: " ",
      language: "en",
    }, { partial: vi.fn(), failed: vi.fn() })).toThrow(/No API key/u);
  });
});

class FakeSocket implements LiveSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  sendError: Error | null = null;
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();

  on(event: "open" | "message" | "error" | "close", listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value?: unknown) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string | Uint8Array): void {
    if (this.sendError !== null) throw this.sendError;
    this.sent.push(typeof data === "string" ? data : data.slice());
  }

  close(): void {
    this.closed = true;
  }

  emit(event: "open" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  message(value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    for (const listener of this.listeners.get("message") ?? []) listener(data);
  }
}

function socketHarness(): {
  factory: LiveSocketFactory;
  socket: FakeSocket;
  url: string;
  headers: Readonly<Record<string, string>>;
} {
  const socket = new FakeSocket();
  const result: {
    factory: LiveSocketFactory;
    socket: FakeSocket;
    url: string;
    headers: Readonly<Record<string, string>>;
  } = {
    socket,
    url: "",
    headers: {} as Readonly<Record<string, string>>,
    factory: () => socket,
  };
  result.factory = (url, headers) => {
    result.url = url;
    result.headers = headers;
    return socket;
  };
  return result;
}

function jsonMessages(socket: FakeSocket): unknown[] {
  return socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as unknown);
}
