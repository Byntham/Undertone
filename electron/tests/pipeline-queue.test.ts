import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import {
  DictationPipelineQueue,
  SessionHistory,
  type PipelineHandlers,
} from "../src/core/pipelineQueue";

describe("dictation pipeline queue", () => {
  it("runs dictate, retry, and repaste jobs strictly in FIFO order", async () => {
    const events: string[] = [];
    let active = 0;
    let maximumActive = 0;
    const handlers: PipelineHandlers = {
      async dictate(wav, target) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        events.push(`${target === null ? "retry" : "dictate"}:${wav[0]}`);
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
    await Promise.all([
      queue.enqueueDictation(Uint8Array.of(1), { window: "42", executable: "editor.exe" }),
      queue.enqueueRetry(Uint8Array.of(2)),
      queue.enqueueRepaste("again"),
      queue.enqueueCommit(),
      queue.enqueueDiscard(),
      queue.enqueueScratch(),
    ]);
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
    const handlers: PipelineHandlers = {
      async dictate(_wav, _target, snapshot) {
        languages.push(snapshot.language);
        if (languages.length === 1) await firstGate;
      },
      async repaste(_text, snapshot) {
        languages.push(snapshot.language);
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
    config.vocabulary.push("new-setting");
    releaseFirst!();
    await Promise.all([first, second]);
    expect(languages).toEqual(["en", "fr"]);
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
});

describe("session history", () => {
  it("returns newest-first copies and bounds total entries", () => {
    let now = 1;
    const history = new SessionHistory(2, 3, () => now++);
    history.registerSuccess("one", null);
    history.registerSuccess("two", "raw two");
    history.registerSuccess("three", null);
    const snapshot = history.snapshot();
    expect(snapshot.map((entry) => entry.ok ? entry.text : entry.error))
      .toEqual(["three", "two"]);
    if (snapshot[0]!.ok) snapshot[0]!.text = "mutated snapshot";
    expect(history.latestSuccessText()).toBe("three");
  });

  it("retains retry audio only for the three newest failures", () => {
    const history = new SessionHistory(20, 3, () => 1);
    const entries = [1, 2, 3, 4].map((value) => (
      history.registerFailure(`failure ${value}`, Uint8Array.of(value))
    ));
    const snapshot = history.snapshot().filter((entry) => !entry.ok);
    expect(snapshot.map((entry) => entry.wav?.[0] ?? null)).toEqual([4, 3, 2, null]);
    expect(history.consumeRetry(entries[0]!.id)).toBeNull();
    expect(history.consumeRetry(entries[3]!.id)).toEqual(Uint8Array.of(4));
    expect(history.consumeRetry(entries[3]!.id)).toBeNull();
  });

  it("finds the latest successful text across intervening failures", () => {
    const history = new SessionHistory();
    expect(history.latestSuccessText()).toBeNull();
    history.registerSuccess("paste me", null);
    history.registerFailure("network", Uint8Array.of(1));
    expect(history.latestSuccessText()).toBe("paste me");
  });
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
