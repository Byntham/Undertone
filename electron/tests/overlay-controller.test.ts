import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayController } from "../src/core/overlayController";
import type { OverlayState } from "../src/shared/overlay";

describe("overlay controller", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not let an old feedback timer hide a new recording", () => {
    const states: OverlayState[] = [];
    const controller = new OverlayController((state) => states.push(state), {
      warningMs: 100,
    });
    controller.feedback("Previous warning", "warning");
    vi.advanceTimersByTime(50);
    controller.recording();
    vi.advanceTimersByTime(100);
    expect(states.map(({ state }) => state)).toEqual(["message", "recording"]);
    expect(controller.current().state).toBe("recording");
  });

  it("uses an icon-only slow state and lets the matching job dismiss it", () => {
    const states: OverlayState[] = [];
    const controller = new OverlayController((state) => states.push(state), {
      slowMs: 100,
    });
    const revision = controller.transcribing();
    vi.advanceTimersByTime(100);
    expect(controller.current()).toEqual({ state: "slow", text: "", tone: "normal" });
    expect(controller.hide(revision)).toBe(true);
    expect(states.map(({ state }) => state)).toEqual(["transcribing", "slow", "hidden"]);
  });

  it("does not let an older transcription dismiss a newer overlay state", () => {
    const controller = new OverlayController(() => undefined);
    const oldRevision = controller.transcribing();
    controller.recording();
    expect(controller.hide(oldRevision)).toBe(false);
    expect(controller.current().state).toBe("recording");
  });

  it("publishes an accessible icon-only failure signal and hides it", () => {
    const states: OverlayState[] = [];
    const controller = new OverlayController((state) => states.push(state));
    controller.signal("No speech detected", "error", 100);
    expect(controller.current()).toEqual({
      state: "signal",
      text: "No speech detected",
      tone: "error",
    });
    vi.advanceTimersByTime(100);
    expect(states.map(({ state }) => state)).toEqual(["signal", "hidden"]);
  });

  it("publishes a guarded icon-only paste confirmation and hides it", () => {
    const states: OverlayState[] = [];
    const controller = new OverlayController((state) => states.push(state));
    const revision = controller.transcribing();
    expect(controller.confirm("Text pasted", 100, revision)).toBe(true);
    expect(controller.current()).toEqual({
      state: "signal",
      text: "Text pasted",
      tone: "success",
    });
    vi.advanceTimersByTime(100);
    expect(states.map(({ state }) => state)).toEqual(["transcribing", "signal", "hidden"]);
  });

  it("does not let an older paste confirmation replace a newer overlay state", () => {
    const controller = new OverlayController(() => undefined);
    const oldRevision = controller.transcribing();
    controller.recording();
    expect(controller.confirm("Text pasted", 100, oldRevision)).toBe(false);
    expect(controller.current().state).toBe("recording");
  });
});
