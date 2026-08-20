import { describe, expect, it, vi } from "vitest";

import type { LiveSocket, LiveSocketFactory } from "../src/core/liveTranscriber";
import {
  NemotronLiveTranscriber,
  type NemotronRealtimeRuntime,
} from "../src/core/nemotronLiveTranscriber";

describe("Nemotron live transcriber", () => {
  it("streams new PCM once, locks completed utterances, and uses the stream final", async () => {
    const socket = new FakeSocket();
    let url = "";
    const factory: LiveSocketFactory = (nextUrl) => {
      url = nextUrl;
      return socket;
    };
    const runtime: NemotronRealtimeRuntime = {
      async withServer(_policy, callback) {
        return await callback("http://127.0.0.1:8123");
      },
    };
    const partial = vi.fn();
    const stable = vi.fn();
    const failed = vi.fn();
    const session = new NemotronLiveTranscriber(runtime, factory)
      .start("en", { partial, stable, failed });

    expect(session.sampleRate).toBe(16_000);
    expect(url).toBe("ws://127.0.0.1:8123/v1/realtime");
    session.append(Uint8Array.of(1, 2, 3, 4));
    expect(socket.sent).toEqual([]);

    socket.message({ type: "session.created" });
    expect(jsonMessages(socket)).toEqual([{
      type: "session.update",
      session: {
        sample_rate: 16_000,
        language: "en",
        automatic_punctuation: true,
      },
    }]);
    socket.message({ type: "session.updated" });
    expect(socket.sent.at(-1)).toEqual(Uint8Array.of(1, 2, 3, 4));

    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "",
    });
    expect(partial).not.toHaveBeenCalled();
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "First phrase",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "First phrase.",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Second phrase",
    });
    expect(partial).toHaveBeenLastCalledWith("First phrase. Second phrase");
    expect(stable).toHaveBeenCalledTimes(1);
    expect(stable).toHaveBeenCalledWith("First phrase.");

    const final = session.finish();
    expect(jsonMessages(socket).at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Second phrase.",
    });
    socket.message({ type: "input_audio_buffer.committed" });
    await expect(final).resolves.toBe("First phrase. Second phrase.");
    expect(stable.mock.calls.map(([text]) => text)).toEqual([
      "First phrase.",
      " Second phrase.",
    ]);
    expect(failed).not.toHaveBeenCalled();
    expect(socket.closed).toBe(true);
  });

  it("reports runtime startup failure and preserves it for finalization", async () => {
    const failure = new Error("Nemotron is not installed");
    const failed = vi.fn();
    const runtime: NemotronRealtimeRuntime = {
      async withServer() {
        throw failure;
      },
    };
    const session = new NemotronLiveTranscriber(runtime, () => new FakeSocket())
      .start("en", { partial: vi.fn(), failed });
    await vi.waitFor(() => expect(failed).toHaveBeenCalledWith(failure));
    await expect(session.finish()).rejects.toThrow("Nemotron is not installed");
  });

  it("replaces a revised non-prefix hypothesis instead of duplicating it", () => {
    const socket = new FakeSocket();
    const partial = vi.fn();
    const runtime: NemotronRealtimeRuntime = {
      async withServer(_policy, callback) {
        return await callback("http://127.0.0.1:8123");
      },
    };
    new NemotronLiveTranscriber(runtime, () => socket)
      .start("en", { partial, failed: vi.fn() });
    socket.message({ type: "session.created" });
    socket.message({ type: "session.updated" });

    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "hello wor",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "yellow world",
    });

    expect(partial).toHaveBeenLastCalledWith("yellow world");
  });

  it("still appends ordinary word and mid-word suffix deltas", () => {
    const socket = new FakeSocket();
    const partial = vi.fn();
    const runtime: NemotronRealtimeRuntime = {
      async withServer(_policy, callback) {
        return await callback("http://127.0.0.1:8123");
      },
    };
    new NemotronLiveTranscriber(runtime, () => socket)
      .start("en", { partial, failed: vi.fn() });
    socket.message({ type: "session.created" });
    socket.message({ type: "session.updated" });

    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "Go",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: "ing",
    });
    socket.message({
      type: "conversation.item.input_audio_transcription.delta",
      delta: " forward now",
    });

    expect(partial).toHaveBeenLastCalledWith("Going forward now");
  });

  it("starts the finalization timeout only after the streaming session is ready", async () => {
    vi.useFakeTimers();
    try {
      const socket = new FakeSocket();
      const failed = vi.fn();
      const runtime: NemotronRealtimeRuntime = {
        async withServer(_policy, callback) {
          return await callback("http://127.0.0.1:8123");
        },
      };
      const session = new NemotronLiveTranscriber(runtime, () => socket)
        .start("en", { partial: vi.fn(), failed });

      const final = session.finish();
      let settled = false;
      void final.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      expect(failed).not.toHaveBeenCalled();
      expect(jsonMessages(socket)).not.toContainEqual({ type: "input_audio_buffer.commit" });

      socket.message({ type: "session.created" });
      socket.message({ type: "session.updated" });
      expect(jsonMessages(socket).at(-1)).toEqual({ type: "input_audio_buffer.commit" });

      await vi.advanceTimersByTimeAsync(15_001);
      await expect(final).rejects.toThrow("finalization timed out");
      expect(failed).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

class FakeSocket implements LiveSocket {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  private readonly listeners = new Map<string, Array<(value?: unknown) => void>>();

  on(event: "open" | "message" | "error" | "close", listener: (...args: never[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener as (value?: unknown) => void);
    this.listeners.set(event, listeners);
    return this;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === "string" ? data : data.slice());
  }

  close(): void {
    this.closed = true;
  }

  message(value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    for (const listener of this.listeners.get("message") ?? []) listener(data);
  }
}

function jsonMessages(socket: FakeSocket): unknown[] {
  return socket.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message) as unknown);
}
