import { describe, expect, it, vi } from "vitest";

import {
  LocalLiveTranscriber,
  type LocalPreviewPass,
  type LocalPreviewTranscriberPort,
} from "../src/core/localLiveTranscriber";
import type {
  LocalPreviewResult,
  LocalPreviewToken,
  LocalPreviewTranscribeOptions,
} from "../src/core/transcriber";

const ONE_SECOND = 16_000 * 2;
const QUARTER_SECOND = ONE_SECOND / 4;

describe("local live transcriber", () => {
  it("sends quarter-second WAV snapshots to the timestamped local preview endpoint", async () => {
    const calls: LocalPreviewTranscribeOptions[] = [];
    const transcriber: LocalPreviewTranscriberPort = {
      async transcribeLocalPreview(options) {
        calls.push(options);
        return preview(token(1, " hello world", 0, 0.2));
      },
    };
    const partial = vi.fn();
    const timing = vi.fn();
    const session = new LocalLiveTranscriber(transcriber).start("fr", {
      partial,
      timing,
      failed: vi.fn(),
    });

    session.append(voicedPcm(QUARTER_SECOND - 2));
    expect(calls).toHaveLength(0);
    session.append(voicedPcm(2));
    await flushPromises();

    expect(calls).toHaveLength(1);
    const options = calls[0]!;
    expect(options).toMatchObject({
      language: "fr",
      prompt: "",
      timeoutMs: 10_000,
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.wav.byteLength).toBe(44 + QUARTER_SECOND);
    expect(new DataView(options.wav.buffer).getUint32(24, true)).toBe(16_000);
    expect(partial).toHaveBeenCalledWith("hello world");
    expect(timing).toHaveBeenCalledWith("draft", 0.25, 0.25, expect.any(Number));
    await session.finish();
  });

  it("keeps inference single-flight and coalesces accumulated audio into the newest pass", async () => {
    const first = deferred<LocalPreviewResult>();
    const second = deferred<LocalPreviewResult>();
    let active = 0;
    let maximumActive = 0;
    const calls: Uint8Array[] = [];
    const transcriber: LocalPreviewTranscriberPort = {
      async transcribeLocalPreview(options) {
        calls.push(options.wav);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          return await (calls.length === 1 ? first.promise : second.promise);
        } finally {
          active -= 1;
        }
      },
    };
    const session = new LocalLiveTranscriber(transcriber).start("en", {
      partial: vi.fn(),
      failed: vi.fn(),
    });

    session.append(voicedPcm(QUARTER_SECOND));
    session.append(voicedPcm(ONE_SECOND));
    session.append(voicedPcm(ONE_SECOND * 2));
    expect(calls).toHaveLength(1);
    first.resolve(preview());
    await flushPromises();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.byteLength).toBe(44 + QUARTER_SECOND + ONE_SECOND * 3);
    expect(maximumActive).toBe(1);
    second.resolve(preview());
    await session.finish();
  });

  it("uses reconciliation passes to replace the recent provisional text", async () => {
    const calls: LocalPreviewTranscribeOptions[] = [];
    const results = [
      preview(token(1, " hello", 0, 0.2)),
      preview(token(1, " hello", 0.1, 0.5), token(2, " world", 0.6, 1.5)),
      preview(
        token(1, " hello", 0.1, 0.5),
        token(2, " world", 0.6, 1.5),
        token(3, " again", 2, 3.5),
      ),
      preview(token(3, " again", 1.5, 3), token(4, " today", 3.1, 3.7)),
    ];
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview(options) {
        calls.push(options);
        return results.shift() ?? preview();
      },
    }).start("en", { partial, failed: vi.fn() });

    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();
    session.append(voicedPcm(ONE_SECOND * 1.75));
    await flushPromises();
    session.append(voicedPcm(ONE_SECOND * 2));
    await flushPromises();

    expect(partial).toHaveBeenLastCalledWith("hello world again");
    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();
    expect(calls.at(-1)?.prompt).toBe("");
    expect(calls.at(-1)?.wav.byteLength).toBe(44 + ONE_SECOND * 4.25);
    await session.finish();
  });

  it("preserves text before the overlap when the five-second draft window advances", async () => {
    const results = [
      preview(
        token(1, " first", 0, 0.5),
        token(2, " stable", 0.6, 1),
        token(3, " recent", 2, 3),
        token(4, " tail", 4, 4.8),
      ),
      preview(
        token(9, " wrong", 0, 0.5),
        token(3, " recent", 1.75, 2.75),
        token(5, " new", 3.8, 4.9),
      ),
    ];
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return results.shift() ?? preview(); },
    }).start("en", { partial, failed: vi.fn() });

    session.append(voicedPcm(ONE_SECOND * 5));
    await flushPromises();
    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();

    expect(partial).toHaveBeenLastCalledWith("first stable recent new");
    await session.finish();
  });

  it("replaces only the recent tail during a fast draft", async () => {
    const results = [
      preview(
        token(1, " beginning", 0, 0.5),
        token(2, " stays", 1, 1.5),
        token(3, " stale", 4.2, 4.8),
      ),
      preview(
        token(9, " wrong beginning", 0, 0.5),
        token(4, " now", 4.5, 4.9),
      ),
    ];
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return results.shift() ?? preview(); },
    }).start("en", { partial, failed: vi.fn() });

    session.append(voicedPcm(ONE_SECOND * 5));
    await flushPromises();
    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();

    expect(partial).toHaveBeenLastCalledWith(
      "beginning stays now",
    );
    await session.finish();
  });

  it("runs one settling pass after speech and then stops during silence", async () => {
    const transcribeLocalPreview = vi.fn(async () => preview(
      token(1, " settled", 0, 0.2),
    ));
    const diagnostic = vi.fn();
    const session = new LocalLiveTranscriber({ transcribeLocalPreview }).start("en", {
      partial: vi.fn(),
      failed: vi.fn(),
      diagnostic,
    });

    session.append(new Uint8Array(ONE_SECOND * 2));
    await flushPromises();
    expect(transcribeLocalPreview).not.toHaveBeenCalled();

    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();
    expect(transcribeLocalPreview).toHaveBeenCalledTimes(1);

    session.append(new Uint8Array(QUARTER_SECOND));
    await flushPromises();
    expect(transcribeLocalPreview).toHaveBeenCalledTimes(1);
    session.append(new Uint8Array(QUARTER_SECOND));
    await flushPromises();
    expect(transcribeLocalPreview).toHaveBeenCalledTimes(2);
    expect(diagnostic.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "request")
      .at(-1)).toMatchObject({
        pass: "reconcile",
        settlingSilence: true,
        windowStartSeconds: 0,
      });

    session.append(new Uint8Array(ONE_SECOND * 2));
    await flushPromises();
    expect(transcribeLocalPreview).toHaveBeenCalledTimes(2);

    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();
    expect(transcribeLocalPreview).toHaveBeenCalledTimes(3);
    await session.finish();
    expect(diagnostic.mock.calls.map(([event]) => event.type)).toContain("audio");
    expect(diagnostic.mock.calls.map(([event]) => event.type)).toContain("request");
    expect(diagnostic.mock.calls.map(([event]) => event.type)).toContain("result");
    expect(diagnostic.mock.calls.map(([event]) => event.type)).toContain("display");
    expect(diagnostic.mock.calls.at(-1)?.[0]).toMatchObject({
      type: "finish",
      text: "settled",
    });
  });

  it("accepts words completed by the silence-settling reconciliation", async () => {
    const results = [
      preview(
        token(1, " it waits", 0.2, 1),
        token(2, " until I", 2, 3),
      ),
      preview(
        token(1, " it waits", 0.2, 1),
        token(2, " until I", 2, 3),
        token(3, " say the next word", 3.05, 3.6),
      ),
    ];
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return results.shift() ?? preview(); },
    }).start("en", { partial, failed: vi.fn() });

    session.append(voicedPcm(ONE_SECOND * 5));
    await flushPromises();
    expect(partial).toHaveBeenLastCalledWith("it waits until I");

    session.append(new Uint8Array(ONE_SECOND / 2));
    await flushPromises();

    expect(partial).toHaveBeenLastCalledWith("it waits until I say the next word");
    await session.finish();
  });

  it("does not let a diagnostic callback failure break transcription", async () => {
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return preview(token(1, " works", 0, 0.2)); },
    }).start("en", {
      partial,
      failed: vi.fn(),
      diagnostic() { throw new Error("diagnostic writer failed"); },
    });

    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();

    expect(partial).toHaveBeenCalledWith("works");
    await expect(session.finish()).resolves.toBe("works");
  });

  it("cuts decoder loops after three repeated token runs", async () => {
    const partial = vi.fn();
    const repeated = [
      token(1, " phrase", 0, 0.04),
      token(2, " here", 0.04, 0.08),
      token(1, " phrase", 0.08, 0.12),
      token(2, " here", 0.12, 0.16),
      token(1, " phrase", 0.16, 0.2),
      token(2, " here", 0.2, 0.22),
      token(1, " phrase", 0.22, 0.24),
      token(2, " here", 0.24, 0.25),
    ];
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return preview(...repeated); },
    }).start("en", { partial, failed: vi.fn() });

    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();

    expect(partial).toHaveBeenCalledWith("phrase here phrase here phrase here");
    await session.finish();
  });

  it("bounds fast drafts while reconciling the full accumulated recording", async () => {
    const timings: Array<{ pass: LocalPreviewPass; window: number; total: number }> = [];
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview() { return preview(); },
    }).start("en", {
      partial: vi.fn(),
      failed: vi.fn(),
      timing(pass, window, total) { timings.push({ pass, window, total }); },
    });

    for (let index = 0; index < 48; index += 1) {
      session.append(voicedPcm(QUARTER_SECOND));
      await flushPromises();
    }

    expect(timings
      .filter(({ pass }) => pass === "reconcile")
      .map(({ total }) => total)).toEqual([2, 4, 6, 8, 10, 12]);
    expect(Math.max(...timings
      .filter(({ pass }) => pass === "draft")
      .map(({ window }) => window))).toBeLessThanOrEqual(5);
    expect(Math.max(...timings
      .filter(({ pass }) => pass === "reconcile")
      .map(({ window }) => window))).toBe(12);
    expect(timings.at(-1)?.total).toBe(12);
    await session.finish();
  });

  it("aborts outstanding preview work on finish and suppresses late text", async () => {
    const result = deferred<LocalPreviewResult>();
    let signal: AbortSignal | undefined;
    const partial = vi.fn();
    const session = new LocalLiveTranscriber({
      async transcribeLocalPreview(options) {
        signal = options.signal;
        return await result.promise;
      },
    }).start("en", { partial, failed: vi.fn() });
    session.append(voicedPcm(QUARTER_SECOND));

    const finishing = session.finish();
    expect(signal?.aborted).toBe(true);
    result.resolve(preview(token(1, " too late", 0, 0.2)));
    await expect(finishing).resolves.toBe("");
    expect(partial).not.toHaveBeenCalled();
  });

  it("reports a preview failure once and stops scheduling without rejecting finish", async () => {
    const failed = vi.fn();
    const transcribeLocalPreview = vi.fn(async () => { throw new Error("preview failed"); });
    const session = new LocalLiveTranscriber({ transcribeLocalPreview }).start("en", {
      partial: vi.fn(),
      failed,
    });
    session.append(voicedPcm(QUARTER_SECOND));
    await flushPromises();
    session.append(voicedPcm(ONE_SECOND * 2));

    expect(transcribeLocalPreview).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ message: "preview failed" }));
    await expect(session.finish()).resolves.toBe("");
  });
});

function token(
  id: number,
  text: string,
  startSeconds: number,
  endSeconds: number,
): LocalPreviewToken {
  return { id, text, startSeconds, endSeconds };
}

function preview(...tokens: LocalPreviewToken[]): LocalPreviewResult {
  return { text: tokens.map(({ text }) => text).join(""), tokens };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => { resolve = promiseResolve; });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function voicedPcm(byteLength: number): Uint8Array {
  const pcm = new Uint8Array(byteLength);
  const view = new DataView(pcm.buffer);
  for (let offset = 0; offset < byteLength; offset += 2) {
    view.setInt16(offset, offset % 4 === 0 ? 4_000 : -4_000, true);
  }
  return pcm;
}
