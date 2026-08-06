import { describe, expect, it } from "vitest";

import { TurnBuffer } from "../src/core/turnBuffer";

describe("turn buffer", () => {
  it("appends raw fragments and complete display snapshots", () => {
    const buffer = new TurnBuffer();
    expect(buffer.append("hello", "Hello", "live-full")).toMatchObject({
      fragmentCount: 1,
      text: "Hello",
    });
    buffer.append("world", "Hello world", "live-full");
    expect(buffer.peekText()).toBe("Hello world");
    expect(buffer.rawText()).toBe("hello world");
    expect(buffer.rawText("again")).toBe("hello world again");
    expect(buffer.fragmentCount()).toBe(2);
  });

  it("clears only when there was content", () => {
    const buffer = new TurnBuffer();
    expect(buffer.clear()).toBe(false);
    buffer.append("a", "A", "live-full");
    expect(buffer.clear()).toBe(true);
    expect(buffer.peekText()).toBeNull();
  });

  it("exposes a draft snapshot for the open-turn panel", () => {
    const buffer = new TurnBuffer();
    expect(buffer.snapshot()).toBeNull();
    buffer.append("one", "One", "live-full");
    buffer.append("two", "One two", "live-full");
    expect(buffer.snapshot()).toEqual({
      text: "One two",
      fragmentCount: 2,
      charCount: 7,
    });
  });

  it("scratches the last fragment and restores the preceding snapshot", () => {
    const buffer = new TurnBuffer();
    buffer.append("one", "One", "live-full");
    buffer.append("two", "One two", "live-full");
    buffer.append("three", "One, two, and three", "live-full");
    expect(buffer.scratchLast()).toEqual({
      removed: "One, two, and three",
      fragmentCount: 2,
      charCount: 7,
      text: "One two",
    });
    expect(buffer.peekText()).toBe("One two");
    expect(buffer.scratchLast()?.fragmentCount).toBe(1);
    expect(buffer.scratchLast()).toEqual({
      removed: "One",
      fragmentCount: 0,
      charCount: 0,
      text: "",
    });
    expect(buffer.scratchLast()).toBeNull();
  });

  it("replaces the latest snapshot without losing raw fragments", () => {
    const buffer = new TurnBuffer();
    buffer.append("one", "One", "live-full");
    buffer.append("two", "One two", "live-full");
    buffer.replaceText("One and two.");
    expect(buffer.peekText()).toBe("One and two.");
    expect(buffer.rawText()).toBe("one two");
    expect(buffer.scratchLast()?.text).toBe("One");
  });

  it("keeps the cleanup strategy selected when the turn began", () => {
    const buffer = new TurnBuffer();
    expect(buffer.activeCleanupStrategy()).toBeNull();
    buffer.append("one", "One", "commit-full");
    buffer.append("two", "One two", "live-full");
    expect(buffer.activeCleanupStrategy()).toBe("commit-full");
    buffer.clear();
    expect(buffer.activeCleanupStrategy()).toBeNull();
  });
});
