import { describe, expect, it } from "vitest";

import {
  normalizeShortcut,
  ShortcutBinding,
  ShortcutCapture,
} from "../src/core/shortcuts";

const down = (virtualKey: number) => ({ eventType: "down" as const, virtualKey });
const up = (virtualKey: number) => ({ eventType: "up" as const, virtualKey });

describe("shortcut binding", () => {
  it("fires one press and one release for a chord while filtering repeat", () => {
    const binding = new ShortcutBinding("ctrl+alt+v");
    expect(binding.update(down(0xa2)).pressed).toBe(false);
    expect(binding.update(down(0xa4)).pressed).toBe(false);
    expect(binding.update(down(0x56)).pressed).toBe(true);
    expect(binding.update(down(0x56)).pressed).toBe(false);
    expect(binding.update(up(0x56)).released).toBe(true);
    expect(binding.update(up(0xa4)).released).toBe(false);
    expect(binding.update(up(0xa2)).released).toBe(false);
  });

  it("completes a chord only after every shortcut key is physically released", () => {
    const binding = new ShortcutBinding("ctrl+alt+v");
    binding.update(down(0xa2));
    binding.update(down(0xa4));
    expect(binding.update(down(0x56)).completed).toBe(false);
    expect(binding.update(up(0x56)).completed).toBe(false);
    expect(binding.update(up(0xa4)).completed).toBe(false);
    expect(binding.update(up(0xa2)).completed).toBe(true);
    expect(binding.update(up(0xa2)).completed).toBe(false);
  });

  it("distinguishes right modifiers while generic modifiers accept either side", () => {
    const exact = new ShortcutBinding("right ctrl");
    expect(exact.update(down(0xa2)).pressed).toBe(false);
    exact.update(up(0xa2));
    expect(exact.update(down(0xa3)).pressed).toBe(true);

    const generic = new ShortcutBinding("ctrl");
    expect(generic.update(down(0xa2)).pressed).toBe(true);
    expect(generic.update(up(0xa2)).released).toBe(true);
    expect(generic.update(down(0xa3)).pressed).toBe(true);
  });

  it("normalizes aliases and rejects empty, duplicate, and unknown bindings", () => {
    expect(normalizeShortcut(" Control + SHIFT + A ")).toBe("ctrl+shift+a");
    expect(normalizeShortcut("", true)).toBe("");
    expect(() => normalizeShortcut("")).toThrow(/Choose/u);
    expect(() => normalizeShortcut("ctrl+control")).toThrow(/duplicate/u);
    expect(() => normalizeShortcut("hyper+z")).toThrow(/supported/u);
  });
});

describe("shortcut capture", () => {
  it("captures a chord after every physical key is released", () => {
    const capture = new ShortcutCapture();
    expect(capture.update(down(0xa2)).done).toBe(false);
    capture.update(down(0xa4));
    capture.update(down(0x56));
    expect(capture.update(up(0x56)).done).toBe(false);
    capture.update(up(0xa4));
    expect(capture.update(up(0xa2))).toEqual({ done: true, shortcut: "left ctrl+left alt+v" });
  });

  it("ignores repeat and cancels on Escape release", () => {
    const capture = new ShortcutCapture();
    capture.update(down(0x41));
    capture.update(down(0x41));
    expect(capture.update(up(0x41))).toEqual({ done: true, shortcut: "a" });

    const cancelled = new ShortcutCapture();
    cancelled.update(down(0x1b));
    expect(cancelled.update(up(0x1b))).toEqual({ done: true, shortcut: null });
  });
});
