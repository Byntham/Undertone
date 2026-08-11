import { describe, expect, it } from "vitest";

import { CleanupError } from "../src/core/cleanup";
import { normalizeConfig } from "../src/core/config";
import {
  DictationJobRunner,
  type DictationRunnerDependencies,
} from "../src/core/dictationRunner";
import {
  SessionHistory,
  type DictationDestination,
  type DictationTarget,
} from "../src/core/pipelineQueue";
import { TurnBuffer } from "../src/core/turnBuffer";
import { prepareText } from "../src/core/textPreparation";

const WAV = Uint8Array.of(1, 2, 3);
const TARGET: DictationTarget = {
  window: "42",
  focus: "420",
  focusIdentityState: "unavailable",
  focusIdentity: null,
  generation: "7",
};
const OPEN_TURN: DictationDestination = { completion: "open-turn" };

function autoCommit(target: DictationTarget = TARGET): DictationDestination {
  return { completion: "commit", target: { state: "captured", value: target } };
}

describe("dictation job runner", () => {
  it("transcribes, cleans, and auto-commits to the finish target", async () => {
    const { dependencies, state } = harness();
    await new DictationJobRunner(dependencies).run(WAV, autoCommit(), normalizeConfig({
      provider: "xai",
      api_key: "key",
      vocabulary: ["Undertone"],
      corrections: { kubernetes: "Kubernetes" },
    }));

    expect(state.transcribeOptions).toMatchObject({
      apiKey: "key",
      provider: "xai",
      vocabulary: ["Undertone", "Kubernetes"],
    });
    expect(state.preparations).toEqual([
      { text: "hello world.", aiCleanup: true },
    ]);
    expect(state.pasted).toEqual([{ text: "Hello world.", restore: true }]);
    expect(dependencies.turnBuffer.peekText()).toBeNull();
    expect(dependencies.history.latestSuccessText()).toBe("Hello world.");
    expect(state.dismissed).toBe(1);
  });

  it("appends one or more recordings to the open turn when requested", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    const config = normalizeConfig(undefined);
    await runner.run(WAV, OPEN_TURN, config);
    await runner.run(WAV, OPEN_TURN, config);

    expect(state.pasted).toEqual([]);
    expect(dependencies.turnBuffer.peekText()).toBe("Hello world. hello world.");
    expect(state.preparations.map(({ text }) => text)).toEqual([
      "hello world.",
      "hello world. hello world.",
    ]);
    expect(state.messages.map(({ text }) => text)).toEqual([
      "Turn · 1 · hello world.",
      "Turn · 2 · hello world.",
    ]);
  });

  it("auto-commit includes fragments already in the open turn", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    const config = normalizeConfig(undefined);
    await runner.runTranscript("first", OPEN_TURN, config);
    await runner.runTranscript("second", autoCommit(), config);

    expect(state.pasted.at(-1)?.text).toBe("First second");
    expect(dependencies.turnBuffer.peekText()).toBeNull();
  });

  it("accepts a completed live transcript without batch transcription", async () => {
    const { dependencies, state } = harness();
    dependencies.transcriber.transcribe = async () => {
      throw new Error("batch transcription must not run");
    };
    await new DictationJobRunner(dependencies).runTranscript(
      "live words.",
      OPEN_TURN,
      normalizeConfig(undefined),
    );
    expect(dependencies.turnBuffer.rawText()).toBe("live words.");
    expect(state.preparations.at(-1)?.text).toBe("live words.");
  });

  it("propagates unexpected preparation errors without mutating the turn", async () => {
    const { dependencies, state } = harness();
    dependencies.prepareText = async () => { throw new TypeError("implementation bug"); };
    await expect(new DictationJobRunner(dependencies).runTranscript(
      "do not hide this error",
      OPEN_TURN,
      normalizeConfig(undefined),
    )).rejects.toThrow(TypeError);
    expect(dependencies.turnBuffer.peekText()).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it("runs deferred whole-turn cleanup before automatic commit", async () => {
    const { dependencies, state } = harness();
    const runner = new DictationJobRunner(dependencies);
    const config = normalizeConfig({ stack_cleanup_strategy: "commit-full" });
    await runner.runTranscript("first", OPEN_TURN, config);
    await runner.runTranscript("second", autoCommit(), config);

    expect(state.preparations).toEqual([
      { text: "first", aiCleanup: false },
      { text: "first second", aiCleanup: false },
      { text: "first second", aiCleanup: true },
    ]);
    expect(state.pasted.at(-1)?.text).toBe("First second");
  });

  it("keeps the complete turn when focus changed before auto-commit", async () => {
    const { dependencies, state } = harness();
    state.foreground = "99";
    await new DictationJobRunner(dependencies).runTranscript(
      "keep me",
      autoCommit(),
      normalizeConfig({ commit_hotkey: "ctrl+alt" }),
    );

    expect(state.pasted).toEqual([]);
    expect(state.fallback).toBeNull();
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.messages.at(-1)).toEqual({
      text: "Focus changed — press ctrl+alt to paste",
      kind: "error",
    });
  });

  it("keeps the complete turn when the automatic target could not be captured", async () => {
    const { dependencies, state } = harness();
    await new DictationJobRunner(dependencies).runTranscript(
      "keep me",
      { completion: "commit", target: { state: "unavailable" } },
      normalizeConfig({ commit_hotkey: "ctrl+alt" }),
    );

    expect(state.pasted).toEqual([]);
    expect(state.fallback).toBeNull();
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.messages.at(-1)).toEqual({
      text: "Focus changed — press ctrl+alt to paste",
      kind: "error",
    });
  });

  it("revalidates focus immediately before paste injection", async () => {
    const { dependencies, state } = harness();
    state.changeFocusBeforeSend = true;
    await new DictationJobRunner(dependencies).runTranscript(
      "keep me",
      autoCommit(),
      normalizeConfig(undefined),
    );
    expect(state.pasted).toEqual([]);
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.messages.at(-1)?.kind).toBe("error");
  });

  it("detects focus moving to another control in the same window", async () => {
    const { dependencies, state } = harness();
    state.foregroundFocus = "421";
    await new DictationJobRunner(dependencies).runTranscript(
      "keep me",
      autoCommit(),
      normalizeConfig(undefined),
    );
    expect(state.pasted).toEqual([]);
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.messages.at(-1)?.kind).toBe("error");
  });

  it("detects UI Automation focus moving when the window handles stay the same", async () => {
    const { dependencies, state } = harness();
    state.foregroundFocusIdentity = "uia:2";
    await new DictationJobRunner(dependencies).runTranscript(
      "keep me",
      autoCommit({
        ...TARGET,
        focusIdentityState: "available",
        focusIdentity: "uia:1",
      }),
      normalizeConfig(undefined),
    );
    expect(state.pasted).toEqual([]);
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.messages.at(-1)?.kind).toBe("error");
  });

  it("manual commit pastes to the current focus without target validation", async () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("Keep me", "Keep me", "live-full");
    state.foreground = "99";
    await new DictationJobRunner(dependencies).commit(normalizeConfig(undefined));
    expect(state.pasted.at(-1)?.text).toBe("Keep me");
    expect(dependencies.turnBuffer.peekText()).toBeNull();
  });

  it("keeps the open turn and stages clipboard when paste injection fails", async () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("Keep me", "Keep me", "live-full");
    dependencies.paster.paste = async () => { throw new Error("paste failed"); };
    await new DictationJobRunner(dependencies).commit(normalizeConfig({
      commit_hotkey: "ctrl+alt+enter",
    }));
    expect(dependencies.turnBuffer.peekText()).toBe("Keep me");
    expect(state.fallback).toBe("Keep me");
    expect(state.messages.at(-1)?.kind).toBe("warning");
  });

  it("commits the normal fallback produced for a CleanupError", async () => {
    const { dependencies, state } = harness();
    dependencies.prepareText = async (text, config) => await prepareText(text, config, {
      cleanup: async () => { throw new CleanupError("Cleanup request failed."); },
    });
    await new DictationJobRunner(dependencies).run(WAV, autoCommit(), normalizeConfig(undefined));
    expect(state.pasted.at(-1)?.text).toBe("hello world.");
    expect(state.messages.at(-1)).toEqual({
      text: "AI cleanup failed — used basic formatting",
      kind: "warning",
    });
  });

  it("retains failed audio and rejects empty speech", async () => {
    const first = harness();
    first.dependencies.transcriber.transcribe = async () => { throw new Error("offline"); };
    await new DictationJobRunner(first.dependencies).run(
      WAV,
      autoCommit(),
      normalizeConfig(undefined),
    );
    const failure = first.dependencies.history.snapshot()[0]!;
    expect(failure.ok).toBe(false);
    if (!failure.ok) expect(failure.retryable).toBe(true);

    const second = harness();
    second.dependencies.transcriber.transcribe = async () => "";
    await new DictationJobRunner(second.dependencies).run(
      WAV,
      autoCommit(),
      normalizeConfig(undefined),
    );
    expect(second.state.messages.at(-1)).toEqual({
      text: "No speech detected",
      kind: "error",
      destination: "turn-draft",
    });
  });

  it("rejects whitespace-only speech without opening a turn", async () => {
    const { dependencies, state } = harness();
    await new DictationJobRunner(dependencies).runTranscript(
      "  \r\n ",
      OPEN_TURN,
      normalizeConfig(undefined),
    );

    expect(dependencies.turnBuffer.snapshot()).toBeNull();
    expect(state.preparations).toEqual([]);
    expect(state.pasted).toEqual([]);
    expect(state.messages.at(-1)).toEqual({
      text: "No speech detected",
      kind: "error",
      destination: "turn-draft",
    });
  });

  it("scratches and discards staged fragments", () => {
    const { dependencies, state } = harness();
    dependencies.turnBuffer.append("One", "One", "live-full");
    dependencies.turnBuffer.append("Two", "One Two", "live-full");
    const runner = new DictationJobRunner(dependencies);
    runner.scratchLast();
    expect(dependencies.turnBuffer.peekText()).toBe("One");
    runner.discard();
    expect(dependencies.turnBuffer.peekText()).toBeNull();
    expect(state.messages.at(-1)?.text).toBe("Turn discarded");
  });
});

function harness(): {
  dependencies: DictationRunnerDependencies;
  state: {
    foreground: string;
    foregroundFocus: string;
    foregroundFocusIdentity: string | null;
    changeFocusBeforeSend: boolean;
    pasted: Array<{ text: string; restore: boolean }>;
    fallback: string | null;
    dismissed: number;
    messages: Array<{
      text: string;
      kind: "normal" | "warning" | "error" | undefined;
      destination?: "overlay" | "turn-draft";
    }>;
    transcribeOptions: Record<string, unknown> | null;
    preparations: Array<{ text: string; aiCleanup: boolean }>;
  };
} {
  const state = {
    foreground: "42",
    foregroundFocus: "420",
    foregroundFocusIdentity: null as string | null,
    changeFocusBeforeSend: false,
    pasted: [] as Array<{ text: string; restore: boolean }>,
    fallback: null as string | null,
    dismissed: 0,
    messages: [] as Array<{
      text: string;
      kind: "normal" | "warning" | "error" | undefined;
      destination?: "overlay" | "turn-draft";
    }>,
    transcribeOptions: null as Record<string, unknown> | null,
    preparations: [] as Array<{ text: string; aiCleanup: boolean }>,
  };
  const dependencies: DictationRunnerDependencies = {
    transcriber: {
      async transcribe(options) {
        state.transcribeOptions = options;
        return "hello world.";
      },
    },
    async prepareText(text, config) {
      state.preparations.push({ text, aiCleanup: config.ai_cleanup });
      return {
        text: text.length > 0 ? `${text[0]!.toUpperCase()}${text.slice(1)}` : text,
        cleanupFailed: false,
      };
    },
    paster: {
      async paste(text, restore, target) {
        if (state.changeFocusBeforeSend) state.foreground = "99";
        if (target !== undefined && (
          target.window !== state.foreground
          || target.focus !== state.foregroundFocus
          || (target.focusIdentityState === "available"
            ? target.focusIdentity !== state.foregroundFocusIdentity
            : state.foregroundFocusIdentity !== null)
        )) return false;
        state.pasted.push({ text, restore });
        return true;
      },
      copyFallback(text) { state.fallback = text; },
    },
    history: new SessionHistory(),
    turnBuffer: new TurnBuffer(),
    feedback: {
      message(message) {
        state.messages.push({
          text: message.text,
          kind: message.tone,
          ...(message.destination === undefined ? {} : { destination: message.destination }),
        });
      },
      dismiss() { state.dismissed += 1; },
    },
  };
  return { state, dependencies };
}
