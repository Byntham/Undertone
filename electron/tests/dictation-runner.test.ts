import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import {
  DictationJobRunner,
  type DictationRunnerDependencies,
} from "../src/core/dictationRunner";
import { SessionHistory } from "../src/core/pipelineQueue";
import { InsertionMemory } from "../src/core/textPreparation";

const WAV = Uint8Array.of(1, 2, 3);

describe("dictation job runner", () => {
  it("transcribes, restores twice, pastes, and registers success memory", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    await runner.run(
      WAV,
      { window: "42", executable: "editor.exe" },
      normalizeConfig({
        provider: "xai",
        api_key: "key",
        vocabulary: ["Undertone"],
        corrections: { kubernetes: "Kubernetes", product: "Undertone" },
      }),
    );
    expect(state.restoreCalls).toBe(2);
    expect(state.pasted).toEqual([{ text: "Hello world.", restore: true }]);
    expect(state.transcribeOptions).toMatchObject({
      apiKey: "key",
      language: "en",
      provider: "xai",
      vocabulary: ["Undertone", "Kubernetes"],
    });
    expect(dependencies.history.latestSuccessText()).toBe("Hello world.");
    expect(await dependencies.insertionMemory.acquire({
      async getCaretContext() { return null; },
      async getForegroundWindow() { return "42"; },
    })).toEqual({ before: "Hello world.", after: null });
    expect(state.messages).toEqual([]);
    expect(state.dismissed).toBe(1);
  });

  it("parks text on clipboard and history when target restoration fails", async () => {
    const { dependencies, state } = harness();
    dependencies.restoreTarget = async () => {
      state.restoreCalls += 1;
      return false;
    };
    const runner = new DictationJobRunner(dependencies);
    await runner.run(WAV, { window: "42", executable: "editor.exe" }, normalizeConfig({
      repaste_hotkey: "ctrl+alt+v",
    }));
    expect(state.restoreCalls).toBe(1);
    expect(state.pasted).toEqual([]);
    expect(state.fallback).toBe("Hello world.");
    expect(dependencies.history.latestSuccessText()).toBe("Hello world.");
    expect(state.messages.at(-1)).toEqual({
      text: "Couldn't paste — press ctrl+alt+v where you want it",
      kind: "warning",
    });
  });

  it("uses the same fallback when paste injection throws", async () => {
    const { dependencies, state } = harness();
    dependencies.paster.paste = async () => { throw new Error("paste failed"); };
    const runner = new DictationJobRunner(dependencies);
    await runner.run(WAV, null, normalizeConfig(undefined));
    expect(state.restoreCalls).toBe(2);
    expect(state.fallback).toBe("Hello world.");
    expect(dependencies.history.latestSuccessText()).toBe("Hello world.");
  });

  it("keeps cleanup fallback visible after a successful paste", async () => {
    const { dependencies, state } = harness();
    dependencies.prepareText = async () => ({
      text: "Hello world.",
      cleanupFailed: true,
    });
    await new DictationJobRunner(dependencies).run(WAV, null, normalizeConfig(undefined));
    expect(state.pasted).toEqual([{ text: "Hello world.", restore: true }]);
    expect(state.dismissed).toBe(0);
    expect(state.messages.at(-1)).toEqual({
      text: "AI cleanup failed — used basic formatting",
      kind: "warning",
    });
  });

  it("retains failed audio for retry and handles empty speech without a history failure", async () => {
    const first = harness();
    first.dependencies.transcriber.transcribe = async () => {
      throw new Error("Could not reach the xAI API");
    };
    await new DictationJobRunner(first.dependencies).run(WAV, null, normalizeConfig(undefined));
    const failure = first.dependencies.history.snapshot()[0]!;
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.wav).toEqual(WAV);
    expect(first.state.messages.at(-1)?.kind).toBe("error");

    const second = harness();
    second.dependencies.transcriber.transcribe = async () => "";
    await new DictationJobRunner(second.dependencies).run(WAV, null, normalizeConfig(undefined));
    expect(second.dependencies.history.snapshot()).toEqual([]);
    expect(second.state.messages.at(-1)).toEqual({
      text: "No speech detected",
      kind: "error",
    });
  });

  it("keeps paste memory invalid after raced input without success feedback", async () => {
    const { dependencies, state } = harness();
    dependencies.paster.paste = async (text, restore) => {
      state.pasted.push({ text, restore });
      dependencies.insertionMemory.invalidate();
    };
    const runner = new DictationJobRunner(dependencies);
    await runner.run(WAV, null, normalizeConfig({ provider: "local" }));
    expect(state.messages).toEqual([]);
    expect(state.dismissed).toBe(1);
    expect(await dependencies.insertionMemory.acquire({
      async getCaretContext() { return null; },
      async getForegroundWindow() { return "42"; },
    })).toEqual({ before: null, after: null });
  });
});

function harness(): {
  dependencies: DictationRunnerDependencies;
  state: {
    restoreCalls: number;
    pasted: Array<{ text: string; restore: boolean }>;
    fallback: string | null;
    dismissed: number;
    messages: Array<{ text: string; kind: "normal" | "warning" | "error" | undefined }>;
    transcribeOptions: Record<string, unknown> | null;
  };
} {
  const state = {
    restoreCalls: 0,
    pasted: [] as Array<{ text: string; restore: boolean }>,
    fallback: null as string | null,
    dismissed: 0,
    messages: [] as Array<{
      text: string;
      kind: "normal" | "warning" | "error" | undefined;
    }>,
    transcribeOptions: null as Record<string, unknown> | null,
  };
  return {
    state,
    dependencies: {
      transcriber: {
        async transcribe(options) {
          state.transcribeOptions = options;
          return "hello world.";
        },
      },
      async prepareText() {
        return { text: "Hello world.", cleanupFailed: false };
      },
      async restoreTarget() {
        state.restoreCalls += 1;
        return true;
      },
      async getForegroundWindow() {
        return "42";
      },
      paster: {
        async paste(text, restore) {
          state.pasted.push({ text, restore });
        },
        copyFallback(text) {
          state.fallback = text;
        },
      },
      history: new SessionHistory(),
      insertionMemory: new InsertionMemory(() => 100),
      feedback: {
        message(text, kind) {
          state.messages.push({ text, kind });
        },
        dismiss() {
          state.dismissed += 1;
        },
      },
    },
  };
}
