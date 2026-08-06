import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import {
  InsertionMemory,
  prepareText,
  type CleanupRequest,
  type ContextSource,
  type TextPreparationDependencies,
} from "../src/core/textPreparation";

describe("text preparation pipeline", () => {
  it("formats an insertion using both local caret boundaries", async () => {
    const dependencies = makeDependencies();
    dependencies.acquireContext = async () => ({ before: "I like ", after: "apples." });
    expect(await prepareText("red.", normalizeConfig({ ai_cleanup: false }), dependencies))
      .toEqual({ text: "red ", cleanupFailed: false });
  });

  it("sends only left context to cleanup and keeps the right seam local", async () => {
    let captured: CleanupRequest | undefined;
    const dependencies = makeDependencies();
    dependencies.acquireContext = async () => ({
      before: "I already said ",
      after: "today.",
    });
    dependencies.getAppIdentity = async () => ({
      executable: "slack.exe",
      title: "Chat",
    });
    dependencies.cleanup = async (request) => {
      captured = request;
      return "hello.";
    };
    expect(await prepareText("hello", normalizeConfig({ ai_cleanup: true }), dependencies))
      .toEqual({ text: "hello ", cleanupFailed: false });
    expect(captured).toMatchObject({
      transcript: "hello",
      context: "I already said ",
      app: "slack.exe (Chat)",
      corrections: {},
    });
    expect(captured).not.toHaveProperty("after");
  });

  it("falls back to deterministic rules when cleanup skips", async () => {
    const dependencies = makeDependencies();
    dependencies.acquireContext = async () => ({ before: "", after: "" });
    dependencies.cleanup = async () => null;
    expect(await prepareText(
      "  hello world.  ",
      normalizeConfig({ ai_cleanup: true }),
      dependencies,
    )).toEqual({ text: "Hello world.", cleanupFailed: true });
  });

  it("does not query caret context when smart formatting is disabled", async () => {
    const dependencies = makeDependencies();
    dependencies.acquireContext = async () => {
      throw new Error("caret context should not be queried");
    };
    expect(await prepareText(
      "  under tone works.  ",
      normalizeConfig({
        ai_cleanup: false,
        smart_formatting: false,
        corrections: { "under tone": "Undertone" },
      }),
      dependencies,
    )).toEqual({ text: "Undertone works.", cleanupFailed: false });
  });
});

describe("insertion memory", () => {
  it("lets an explicit empty native context beat stale memory", async () => {
    let now = 100;
    const memory = new InsertionMemory(() => now);
    memory.registerPaste("42", "Previous words");
    now += 10;
    const source = contextSource({ before: "", after: "" }, "42");
    expect(await memory.acquire(source)).toEqual({ before: "", after: "" });
  });

  it("supplies only the left side while window and generation still match", async () => {
    let now = 100;
    const memory = new InsertionMemory(() => now);
    memory.registerPaste("42", "Previous words");
    now += 10;
    const source = contextSource(null, "42");
    expect(await memory.acquire(source)).toEqual({
      before: "Previous words",
      after: null,
    });
    memory.invalidate();
    expect(await memory.acquire(source)).toEqual({ before: null, after: null });
  });

  it("cannot erase input that races post-paste bookkeeping", async () => {
    const memory = new InsertionMemory(() => 100);
    const pasteGeneration = memory.captureGeneration();
    memory.invalidate();
    memory.registerPaste("42", "Previous words", pasteGeneration);
    expect(await memory.acquire(contextSource(null, "42")))
      .toEqual({ before: null, after: null });
  });

  it("expires or rejects memory from another foreground window", async () => {
    let now = 100;
    const memory = new InsertionMemory(() => now);
    memory.registerPaste("42", "Previous words");
    expect(await memory.acquire(contextSource(null, "43")))
      .toEqual({ before: null, after: null });
    now += 300_000;
    expect(await memory.acquire(contextSource(null, "42")))
      .toEqual({ before: null, after: null });
  });
});

function makeDependencies(): TextPreparationDependencies {
  return {
    async acquireContext() {
      return { before: null, after: null };
    },
    async getAppIdentity() {
      return { executable: "editor.exe", title: "Document" };
    },
    async cleanup() {
      return null;
    },
  };
}

function contextSource(
  context: { before: string; after: string | null } | null,
  window: string,
): ContextSource {
  return {
    async getCaretContext() {
      return context;
    },
    async getForegroundWindow() {
      return window;
    },
  };
}
