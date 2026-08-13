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
    const failed = vi.fn();
    const session = new NemotronLiveTranscriber(runtime, factory)
      .start("en", { partial, failed });

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

    const final = session.finish();
    expect(jsonMessages(socket).at(-1)).toEqual({ type: "input_audio_buffer.commit" });
    socket.message({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "Second phrase.",
    });
    socket.message({ type: "input_audio_buffer.committed" });
    await expect(final).resolves.toBe("First phrase. Second phrase.");
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
