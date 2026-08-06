import { describe, expect, it } from "vitest";

import {
  actionShortcutsOverlap,
  ActionShortcutBinding,
  normalizeReleaseShortcut,
  normalizeShortcut,
  normalizeTriggerShortcut,
  pttActionShortcutsOverlap,
  PttActionRouter,
  ShortcutBinding,
  ShortcutCapture,
} from "../src/core/shortcuts";
import { TapStateMachine } from "../src/core/gestures";

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

describe("shortcut collision handling", () => {
  it("detects generic, sided, and subset PTT conflicts", () => {
    expect(pttActionShortcutsOverlap("right ctrl", "ctrl+alt+enter")).toBe(true);
    expect(pttActionShortcutsOverlap("ctrl", "left ctrl+left alt+enter")).toBe(true);
    expect(pttActionShortcutsOverlap(
      "right ctrl+space",
      "ctrl+space+alt+enter",
    )).toBe(true);
    expect(pttActionShortcutsOverlap(
      "ctrl+alt+shift+backspace",
      "ctrl+alt+backspace",
    )).toBe(true);
    expect(pttActionShortcutsOverlap("right ctrl", "left ctrl+left alt+enter"))
      .toBe(false);
  });

  it("rejects equivalent action chords but allows exact-modifier subsets", () => {
    expect(actionShortcutsOverlap(
      "ctrl+alt+enter",
      "left ctrl+left alt+enter",
    )).toBe(true);
    expect(actionShortcutsOverlap(
      "ctrl+alt+backspace",
      "ctrl+alt+shift+backspace",
    )).toBe(false);
  });

  it.each([
    ["re-paste", "ctrl+alt+v", "release", 0x56, []],
    ["commit", "ctrl+alt+enter", "release", 0x0d, []],
    ["scratch", "ctrl+alt+backspace", "trigger", 0x08, []],
    ["discard", "ctrl+alt+shift+backspace", "trigger", 0x08, [0xa0]],
  ] as const)(
    "lets legacy %s win without finalizing PTT audio",
    (_name, shortcut, completeOn, trigger, extraModifiers) => {
      const ptt = new ShortcutBinding("right ctrl");
      const action = new ActionShortcutBinding(shortcut, completeOn);
      const router = new PttActionRouter();
      let audioStarts = 0;
      let audioFinalizations = 0;
      let audioCancellations = 0;
      let actionCompletions = 0;
      const gestures = new TapStateMachine({
        onStart() { audioStarts += 1; return true; },
        onFinish() { audioFinalizations += 1; },
        onDiscard() { audioCancellations += 1; },
      }, { shortTapMs: 0 });
      const send = (event: ReturnType<typeof down> | ReturnType<typeof up>): void => {
        const pttTransition = ptt.update(event);
        const actionTransition = action.update(event);
        router.update(event, pttTransition, [actionTransition], gestures);
        if (actionTransition.completed) actionCompletions += 1;
      };

      send(down(0xa3));
      send(down(0xa4));
      for (const modifier of extraModifiers) send(down(modifier));
      send(down(trigger));
      send(up(trigger));
      for (const modifier of [...extraModifiers].reverse()) send(up(modifier));
      send(up(0xa4));
      send(up(0xa3));

      expect(audioStarts).toBe(1);
      expect(audioCancellations).toBe(1);
      expect(audioFinalizations).toBe(0);
      expect(actionCompletions).toBe(1);
    },
  );

  it("suppresses a legacy PTT chord that contains an action chord", () => {
    const ptt = new ShortcutBinding("right ctrl+left alt+left shift+backspace");
    const action = new ActionShortcutBinding("ctrl+alt+backspace", "trigger");
    const router = new PttActionRouter();
    let audioStarts = 0;
    let audioFinalizations = 0;
    let actionCompletions = 0;
    const gestures = new TapStateMachine({
      onStart() { audioStarts += 1; return true; },
      onFinish() { audioFinalizations += 1; },
      onDiscard() {},
    }, { shortTapMs: 0 });
    const send = (event: ReturnType<typeof down> | ReturnType<typeof up>): void => {
      const pttTransition = ptt.update(event);
      const actionTransition = action.update(event);
      router.update(event, pttTransition, [actionTransition], gestures);
      if (actionTransition.completed) actionCompletions += 1;
    };

    send(down(0xa3));
    send(down(0xa4));
    send(down(0x08));
    send(down(0xa0));
    send(up(0xa0));
    send(up(0x08));
    send(up(0xa4));
    send(up(0xa3));

    expect(actionCompletions).toBe(1);
    expect(audioStarts).toBe(0);
    expect(audioFinalizations).toBe(0);
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
