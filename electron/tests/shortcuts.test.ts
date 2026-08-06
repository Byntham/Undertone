import { describe, expect, it } from "vitest";

import {
  ActionShortcutBinding,
  normalizeReleaseShortcut,
  normalizeShortcut,
  normalizeTriggerShortcut,
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

describe("trigger shortcut binding", () => {
  it("fires once per trigger tap while modifiers remain held", () => {
    const binding = new ActionShortcutBinding("ctrl+alt+backspace");
    expect(binding.update(down(0xa2)).completed).toBe(false);
    expect(binding.update(down(0xa4)).completed).toBe(false);
    expect(binding.update(down(0x08)).completed).toBe(true);
    expect(binding.update(down(0x08)).completed).toBe(false);
    expect(binding.update(up(0x08)).completed).toBe(false);
    expect(binding.update(down(0x08)).completed).toBe(true);
  });

  it("requires exact modifiers so a longer chord does not fire its subset", () => {
    const scratch = new ActionShortcutBinding("ctrl+alt+backspace");
    const discard = new ActionShortcutBinding("ctrl+alt+shift+backspace");
    for (const binding of [scratch, discard]) {
      binding.update(down(0xa2));
      binding.update(down(0xa4));
      binding.update(down(0xa0));
    }
    expect(scratch.update(down(0x08)).completed).toBe(false);
    expect(discard.update(down(0x08)).completed).toBe(true);
  });

  it("can latch on the trigger and wait for full chord release", () => {
    const binding = new ActionShortcutBinding("ctrl+alt+v", "release");
    binding.update(down(0xa2));
    binding.update(down(0xa4));
    expect(binding.update(down(0x56)).completed).toBe(false);
    expect(binding.update(up(0x56)).completed).toBe(false);
    expect(binding.update(up(0xa4)).completed).toBe(false);
    expect(binding.update(up(0xa2)).completed).toBe(true);
  });

  it("does not latch a release action when extra modifiers are held", () => {
    const binding = new ActionShortcutBinding("ctrl+alt+v", "release");
    binding.update(down(0xa2));
    binding.update(down(0xa4));
    binding.update(down(0xa0));
    expect(binding.update(down(0x56)).pressed).toBe(false);
    binding.update(up(0x56));
    binding.update(up(0xa0));
    binding.update(up(0xa4));
    expect(binding.update(up(0xa2)).completed).toBe(false);
  });

  it("completes a modifier-only chord after its full release", () => {
    const single = new ActionShortcutBinding("right alt", "release");
    expect(single.update(down(0xa5)).completed).toBe(false);
    expect(single.update(up(0xa5)).completed).toBe(true);

    const combination = new ActionShortcutBinding("ctrl+alt", "release");
    combination.update(down(0xa2));
    expect(combination.update(down(0xa4)).pressed).toBe(true);
    expect(combination.update(up(0xa4)).completed).toBe(false);
    expect(combination.update(up(0xa2)).completed).toBe(true);
  });

  it("cancels a modifier-only chord when another key joins it", () => {
    const binding = new ActionShortcutBinding("ctrl+alt", "release");
    binding.update(down(0xa2));
    binding.update(down(0xa4));
    binding.update(down(0x58));
    binding.update(up(0x58));
    binding.update(up(0xa4));
    expect(binding.update(up(0xa2)).completed).toBe(false);
  });

  it("accepts one configurable trigger and rejects ambiguous action chords", () => {
    expect(normalizeTriggerShortcut("Control + Z")).toBe("ctrl+z");
    expect(normalizeTriggerShortcut("F8")).toBe("f8");
    expect(normalizeTriggerShortcut("", true)).toBe("");
    expect(() => normalizeTriggerShortcut("ctrl+alt")).toThrow(/one non-modifier/u);
    expect(() => normalizeTriggerShortcut("ctrl+k+s")).toThrow(/one non-modifier/u);
    expect(normalizeReleaseShortcut("right alt")).toBe("right alt");
    expect(normalizeReleaseShortcut("ctrl+alt")).toBe("ctrl+alt");
    expect(() => normalizeReleaseShortcut("ctrl+k+s")).toThrow(/at most one/u);
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
