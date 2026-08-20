import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import {
  DictationPipelineQueue,
  SessionHistory,
  type PendingDictation,
  type PipelineHandlers,
} from "../src/core/pipelineQueue";

describe("dictation pipeline queue", () => {
  it("runs dictate, retry, and repaste jobs strictly in FIFO order", async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const handlers: PipelineHandlers = {
      async dictate(input, destination) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const value = input.type === "audio" ? input.wav[0] : input.text;
        events.push(`${destination.completion === "open-turn" ? "retry" : "dictate"}:${value}`);
        await tick();
        active -= 1;
      },
      async repaste(text) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`repaste:${text}`);
        await tick();
        active -= 1;
      },
      async commit() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push("commit");
        await tick();
        active -= 1;
      },
      async discard() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push("discard");
        await tick();
        active -= 1;
      },
      async scratch() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push("scratch");
        await tick();
        active -= 1;
      },
    };
    const queue = new DictationPipelineQueue(() => normalizeConfig(undefined), handlers);
    const jobs = [
      queue.enqueuePendingDictation(Promise.resolve({
        input: { type: "audio", wav: Uint8Array.of(1) },
        overlayRevision: undefined,
        destination: {
          completion: "commit",
          target: {
            state: "captured",
            value: {
              window: "42",
              focus: "0",
              focusIdentityState: "unavailable",
              focusIdentity: null,
              generation: "7",
            },
          },
        },
      })),
      queue.enqueueRetry(Uint8Array.of(2)),
      queue.enqueueRepaste("again"),
      queue.enqueueCommit(),
      queue.enqueueDiscard(),
      queue.enqueueScratch(),
    ];
    expect(queue.busy).toBe(true);
    await Promise.all(jobs);
    expect(queue.busy).toBe(false);
    expect(events).toEqual([
      "dictate:1", "retry:2", "repaste:again", "commit", "discard", "scratch",
    ]);
    expect(maximumActive).toBe(1);
  });

  it("snapshots config when each job leaves the queue", async () => {
    const config = normalizeConfig({ language: "en" });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const languages: string[] = [];
    const corrections: Array<Record<string, string>> = [];
    const handlers: PipelineHandlers = {
      async dictate(_wav, _target, snapshot) {
        languages.push(snapshot.language);
        corrections.push(snapshot.corrections);
        if (languages.length === 1) await firstGate;
      },
      async repaste(_text, snapshot) {
        languages.push(snapshot.language);
        corrections.push(snapshot.corrections);
      },
      async commit() {},
      async discard() {},
      async scratch() {},
    };
    const queue = new DictationPipelineQueue(() => config, handlers);
    const first = queue.enqueueRetry(Uint8Array.of(1));
    const second = queue.enqueueRepaste("again");
    await tick();
    config.language = "fr";
    config.corrections.new = "setting";
    releaseFirst!();
    await Promise.all([first, second]);
    expect(languages).toEqual(["en", "fr"]);
    expect(corrections).toEqual([{}, { new: "setting" }]);
  });

  it("reserves queue order while a recording finishes", async () => {
    const events: string[] = [];
    let finishRecording!: (value: PendingDictation) => void;
    const recording = new Promise<PendingDictation>(
      (resolve) => { finishRecording = resolve; },
    );
    const queue = new DictationPipelineQueue(
      () => normalizeConfig(undefined),
      {
        async dictate() { events.push("dictate"); },
        async repaste() {},
        async commit() { events.push("commit"); },
        async discard() {},
        async scratch() { events.push("scratch"); },
      },
    );
    const dictate = queue.enqueuePendingDictation(recording);
    const scratch = queue.enqueueScratch();
    const commit = queue.enqueueCommit();
    await tick();
    expect(events).toEqual([]);
    finishRecording({
      input: { type: "audio", wav: Uint8Array.of(1) },
      overlayRevision: undefined,
      destination: {
        completion: "commit",
        target: {
          state: "captured",
          value: {
            window: "42",
            focus: "0",
            focusIdentityState: "unavailable",
            focusIdentity: null,
            generation: "7",
          },
        },
      },
    });
    await Promise.all([dictate, scratch, commit]);
    expect(events).toEqual(["dictate", "scratch", "commit"]);
  });

  it("rejects a failed job without stalling later work", async () => {
    const events: string[] = [];
    const queue = new DictationPipelineQueue(
      () => normalizeConfig(undefined),
      {
        async dictate() {
          events.push("failed");
          throw new Error("boom");
        },
        async repaste(text) {
          events.push(text);
        },
        async commit() {},
        async discard() {},
        async scratch() {},
      },
    );
    const failed = queue.enqueueRetry(Uint8Array.of(1));
    const later = queue.enqueueRepaste("continued");
    await expect(failed).rejects.toThrow("boom");
    await later;
    expect(events).toEqual(["failed", "continued"]);
  });

  it("rejects an unfinished recording without poisoning later work", async () => {
    const events: string[] = [];
    const queue = new DictationPipelineQueue(
      () => normalizeConfig(undefined),
      {
        async dictate() { events.push("dictate"); },
        async repaste(text) { events.push(text); },
        async commit() {},
        async discard() {},
        async scratch() {},
      },
    );
    const failed = queue.enqueuePendingDictation(Promise.reject(new Error("capture failed")));
    const later = queue.enqueueRepaste("continued");
    await expect(failed).rejects.toThrow("capture failed");
    await later;
    expect(events).toEqual(["continued"]);
  });

  it("transfers a completed recording and destination without copying them", async () => {
    const input = { type: "audio" as const, wav: Uint8Array.of(1), captureId: 42 };
    const destination = { completion: "commit" as const, target: { state: "unavailable" as const } };
    let receivedInput: unknown;
    let receivedDestination: unknown;
    const queue = new DictationPipelineQueue(
      () => normalizeConfig(undefined),
      {
        async dictate(received, target) {
          receivedInput = received;
          receivedDestination = target;
        },
        async repaste() {},
        async commit() {},
        async discard() {},
        async scratch() {},
      },
    );
    await queue.enqueuePendingDictation(Promise.resolve({
      input,
      destination,
      overlayRevision: undefined,
    }));
    expect(receivedInput).toBe(input);
    expect(receivedDestination).toBe(destination);
  });

  it("transfers retry audio without copying it", async () => {
    const wav = Uint8Array.of(1, 2, 3);
    let received: Uint8Array | undefined;
    const queue = new DictationPipelineQueue(
      () => normalizeConfig(undefined),
      {
        async dictate(input) {
          if (input.type === "audio") received = input.wav;
        },
        async repaste() {},
        async commit() {},
        async discard() {},
        async scratch() {},
      },
    );
    await queue.enqueueRetry(wav);
    expect(received).toBe(wav);
  });
});

describe("session history", () => {
  it("returns newest-first copies and bounds total entries", () => {
    let now = 1;
    const history = new SessionHistory(2, 3, () => now++);
    history.registerSuccess("one");
    history.registerSuccess("two");
    history.registerSuccess("three");
    const snapshot = history.snapshot();
    expect(snapshot.map((entry) => entry.ok ? entry.text : entry.error))
      .toEqual(["three", "two"]);
    if (snapshot[0]!.ok) snapshot[0]!.text = "mutated snapshot";
    expect(history.latestSuccessText()).toBe("three");
  });

  it("retains retry audio only for the three newest failures", () => {
    const history = new SessionHistory(20, 3, () => 1);
    [1, 2, 3, 4].forEach((value) => {
      history.registerFailure(`failure ${value}`, Uint8Array.of(value));
    });
    const snapshot = history.snapshot().filter((entry) => !entry.ok);
    expect(snapshot.map((entry) => entry.retryable)).toEqual([true, true, true, false]);
  });

  it("bounds total retry bytes and leaves evicted failures visible", () => {
    const history = new SessionHistory(20, 3, () => 1, 5);
    history.registerFailure("first", Uint8Array.of(1, 2, 3));
    history.registerFailure("second", Uint8Array.of(4, 5, 6));
    history.registerFailure("oversized", new Uint8Array(6));
    expect(history.snapshot().map((entry) => ({
      error: entry.ok ? null : entry.error,
      retryable: entry.ok ? false : entry.retryable,
    }))).toEqual([
      { error: "oversized", retryable: false },
      { error: "second", retryable: true },
      { error: "first", retryable: false },
    ]);
  });

  it("transfers retained retry audio exactly once and keeps its metadata", () => {
    const history = new SessionHistory();
    const wav = Uint8Array.of(1, 2, 3);
    history.registerFailure("network", wav);
    const id = history.snapshot()[0]!.id;
    expect(history.takeRetry(id)).toBe(wav);
    expect(history.takeRetry(id)).toBeNull();
    expect(history.lookup(id)).toMatchObject({ error: "network", retryable: false });
  });

  it("finds the latest successful text across intervening failures", () => {
    const history = new SessionHistory();
    expect(history.latestSuccessText()).toBeNull();
    history.registerSuccess("paste me");
    history.registerFailure("network", Uint8Array.of(1));
    expect(history.latestSuccessText()).toBe("paste me");
  });

  it("stores one recoverable partial without making it globally re-pasteable", () => {
    const history = new SessionHistory();
    history.registerSuccess("complete");
    history.registerPartial("canonical final", "already inserted", "focus-changed");
    expect(history.snapshot()[0]).toMatchObject({
      ok: true,
      partial: true,
      text: "canonical final",
      insertedText: "already inserted",
      reason: "focus-changed",
    });
    expect(history.latestSuccessText()).toBe("complete");
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
