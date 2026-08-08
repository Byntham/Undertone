import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import {
  DictationJobRunner,
  type DictationRunnerDependencies,
} from "../src/core/dictationRunner";
import { SessionHistory } from "../src/core/pipelineQueue";
import { InsertionMemory } from "../src/core/textPreparation";
import { TurnBuffer } from "../src/core/turnBuffer";

const WAV = Uint8Array.of(1, 2, 3);

describe("dictation job runner", () => {
  it("transcribes, restores twice, pastes, and registers success memory", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    await runner.run(
      WAV,
      { window: "42", executable: "editor.exe" },
      normalizeConfig({
        dictation_mode: "instant",
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

  it("regenerates the whole turn after each fragment", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    await runner.run(WAV, { window: "42", executable: "editor.exe" }, normalizeConfig({
      dictation_mode: "stack",
    }));
    await runner.run(WAV, { window: "42", executable: "editor.exe" }, normalizeConfig({
      dictation_mode: "stack",
    }));
    expect(state.pasted).toEqual([]);
    expect(state.restoreCalls).toBe(0);
    expect(dependencies.turnBuffer.peekText()).toBe("Hello world. hello world.");
    expect(state.preparations).toEqual([
      { text: "hello world.", aiCleanup: true, context: "isolated" },
      { text: "hello world. hello world.", aiCleanup: true, context: "isolated" },
    ]);
    expect(dependencies.history.snapshot()).toEqual([]);
    expect(state.messages.map((entry) => entry.text)).toEqual([
      "Turn · 1 · hello world.",
      "Turn · 2 · hello world.",
    ]);
    expect(state.dismissed).toBe(0);
  });

  it("accepts a completed live transcript without invoking batch transcription", async () => {
    const { dependencies, state } = harness();
    dependencies.transcriber.transcribe = async () => {
      throw new Error("batch transcription must not run");
    };
    await new DictationJobRunner(dependencies).runTranscript(
      "live words.",
      null,
      normalizeConfig({ dictation_mode: "stack" }),
    );
    expect(dependencies.turnBuffer.rawText()).toBe("live words.");
    expect(state.preparations).toEqual([
      { text: "live words.", aiCleanup: true, context: "isolated" },
    ]);
    expect(dependencies.history.snapshot()).toEqual([]);
  });

  it("keeps a live fragment when stack post-processing throws", async () => {
    const { dependencies, state } = harness();
    dependencies.prepareText = async () => {
      throw new Error("cleanup path failed");
    };
    await new DictationJobRunner(dependencies).runTranscript(
      "do not lose this",
      null,
      normalizeConfig({ dictation_mode: "stack" }),
    );
    expect(dependencies.turnBuffer.peekText()).toBe("do not lose this");
    expect(state.messages.at(-1)?.kind).toBe("warning");
  });

  it("uses a deterministic live preview and cleans the whole turn on commit", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    const config = normalizeConfig({
      dictation_mode: "stack",
      stack_cleanup_strategy: "commit-full",
    });
    await runner.run(WAV, null, config);
    const changedConfig = normalizeConfig({
      dictation_mode: "stack",
      stack_cleanup_strategy: "live-full",
    });
    await runner.run(WAV, null, changedConfig);
    expect(state.preparations).toEqual([
      { text: "hello world.", aiCleanup: false, context: "isolated" },
      { text: "hello world. hello world.", aiCleanup: false, context: "isolated" },
    ]);

    await runner.commit(changedConfig);
    expect(state.preparations.at(-1)).toEqual({
      text: "hello world. hello world.",
      aiCleanup: true,
      context: "isolated",
    });
    expect(state.pasted.at(-1)?.text).toBe("Hello world. hello world.");
  });

  it("scratches the last stacked fragment", async () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("Hello world.", "Hello world.", "live-full");
    dependencies.turnBuffer.append("More.", "Hello world. More.", "live-full");
    const runner = new DictationJobRunner(dependencies);
    runner.scratchLast();
    expect(dependencies.turnBuffer.peekText()).toBe("Hello world.");
    expect(state.messages.at(-1)?.text).toBe("Scratched · 1 · Hello world.");
    runner.scratchLast();
    expect(dependencies.turnBuffer.peekText()).toBeNull();
    expect(state.messages.at(-1)?.text).toBe("Last fragment scratched · turn empty");
  });

  it("commits the open turn once and clears the buffer", async () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("Hello world.", "Hello world.", "live-full");
    const runner = new DictationJobRunner(dependencies);
    await runner.commit(normalizeConfig({ dictation_mode: "stack" }));
    expect(state.pasted).toEqual([{ text: "Hello world.", restore: true }]);
    expect(dependencies.turnBuffer.peekText()).toBeNull();
    expect(dependencies.history.latestSuccessText()).toBe("Hello world.");
    expect(state.dismissed).toBe(1);
  });

  it("keeps the open turn when commit paste fails", async () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("Keep me", "Keep me", "live-full");
    dependencies.paster.paste = async () => { throw new Error("paste failed"); };
    const runner = new DictationJobRunner(dependencies);
    await runner.commit(normalizeConfig({
      dictation_mode: "stack",
      commit_hotkey: "ctrl+alt+enter",
    }));
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.fallback).toBe("Keep me");
    expect(dependencies.history.snapshot()).toEqual([]);
    expect(state.messages.at(-1)?.kind).toBe("warning");
  });

  it("parks text on clipboard and history when target restoration fails", async () => {
    const { dependencies, state } = harness();
    dependencies.restoreTarget = async () => {
      state.restoreCalls += 1;
      return false;
    };
    const runner = new DictationJobRunner(dependencies);
    await runner.run(WAV, { window: "42", executable: "editor.exe" }, normalizeConfig({
      dictation_mode: "instant",
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
    await runner.run(WAV, null, normalizeConfig({ dictation_mode: "instant" }));
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
    await new DictationJobRunner(dependencies).run(WAV, null, normalizeConfig({
      dictation_mode: "instant",
    }));
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
    await new DictationJobRunner(first.dependencies).run(
      WAV,
      null,
      normalizeConfig({ dictation_mode: "instant" }),
    );
    const failure = first.dependencies.history.snapshot()[0]!;
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.wav).toEqual(WAV);
    expect(first.state.messages.at(-1)?.kind).toBe("error");

    const second = harness();
    second.dependencies.transcriber.transcribe = async () => "";
    await new DictationJobRunner(second.dependencies).run(
      WAV,
      null,
      normalizeConfig({ dictation_mode: "instant" }),
    );
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
    await runner.run(WAV, null, normalizeConfig({
      dictation_mode: "instant",
      provider: "local",
    }));
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
    preparations: Array<{
      text: string;
      aiCleanup: boolean;
      context: "insertion" | "isolated";
    }>;
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
    preparations: [] as Array<{
      text: string;
      aiCleanup: boolean;
      context: "insertion" | "isolated";
    }>,
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
      async prepareText(text, config, context) {
        state.preparations.push({ text, aiCleanup: config.ai_cleanup, context });
        const prepared = text.length > 0
          ? `${text[0]!.toUpperCase()}${text.slice(1)}`
          : text;
        return { text: prepared, cleanupFailed: false };
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
      turnBuffer: new TurnBuffer(),
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
