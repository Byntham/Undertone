import { describe, expect, it } from "vitest";

import { TurnBuffer } from "../src/core/turnBuffer";

describe("turn buffer", () => {
  it("appends fragments and exposes joined text as left context", () => {
    const buffer = new TurnBuffer(() => 60_000, () => 1_000);
    expect(buffer.contextBefore()).toBe("");
    expect(buffer.append("hello", "Hello")).toMatchObject({
      fragmentCount: 1,
      text: "Hello",
      lastFragment: "Hello",
    });
    expect(buffer.contextBefore()).toBe("Hello");
    buffer.append(" world", " world");
    expect(buffer.peekText()).toBe("Hello world");
    expect(buffer.fragmentCount()).toBe(2);
  });

  it("clears only when there was content", () => {
    const buffer = new TurnBuffer(() => 60_000, () => 1_000);
    expect(buffer.clear()).toBe(false);
    buffer.append("a", "A");
    expect(buffer.clear()).toBe(true);
    expect(buffer.peekText()).toBeNull();
    expect(buffer.contextBefore()).toBe("");
  });

  it("expires an idle open turn", () => {
    let now = 1_000;
    const buffer = new TurnBuffer(() => 5_000, () => now);
    buffer.append("one", "One");
    now = 5_999;
    expect(buffer.peekText()).toBe("One");
    now = 6_000;
    expect(buffer.peekText()).toBeNull();
    expect(buffer.contextBefore()).toBe("");
  });

  it("never expires when idle limit is zero", () => {
    let now = 1_000;
    const buffer = new TurnBuffer(() => 0, () => now);
    buffer.append("keep", "Keep");
    now = 1_000_000;
    expect(buffer.peekText()).toBe("Keep");
  });

  it("scratches the last fragment and rebuilds joined text", () => {
    const buffer = new TurnBuffer(() => 60_000, () => 1_000);
    buffer.append("one", "One");
    buffer.append(" two", " two");
    buffer.append(" three", " three");
    expect(buffer.scratchLast()).toEqual({
      removed: " three",
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
});
