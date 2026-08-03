import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestureState, TapStateMachine } from "../src/core/gestures";

const SHORT_MS = 100;
const DOUBLE_MS = 150;

function make(startOk = true): {
  machine: TapStateMachine;
  actions: string[];
} {
  const actions: string[] = [];
  const machine = new TapStateMachine(
    {
      onStart: () => {
        actions.push("start");
        return startOk;
      },
      onFinish: () => actions.push("finish"),
      onDiscard: () => actions.push("discard"),
      onLock: () => actions.push("lock"),
    },
    { shortTapMs: SHORT_MS, doubleTapMs: DOUBLE_MS },
  );
  return { machine, actions };
}

describe("TapStateMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes a held recording on release", () => {
    const { machine, actions } = make();
    machine.press();
    vi.advanceTimersByTime(SHORT_MS + 50);
    machine.release();
    expect(actions).toEqual(["start", "finish"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("discards a stray tap after the double-tap window", () => {
    const { machine, actions } = make();
    machine.press();
    machine.release();
    expect(machine.state).toBe(GestureState.tapWait);
    vi.advanceTimersByTime(DOUBLE_MS);
    expect(actions).toEqual(["start", "discard"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("locks on a double tap and finishes on the next press", () => {
    const { machine, actions } = make();
    machine.press();
    machine.release();
    vi.advanceTimersByTime(DOUBLE_MS / 2);
    machine.press();
    expect(machine.state).toBe(GestureState.locked);
    machine.release();
    vi.advanceTimersByTime(DOUBLE_MS);
    expect(actions).toEqual(["start", "lock"]);
    machine.press();
    expect(actions).toEqual(["start", "lock", "finish"]);
    expect(machine.state).toBe(GestureState.idle);
    machine.release();
    expect(actions).toEqual(["start", "lock", "finish"]);
  });

  it("measures the double-tap gap from the first release", () => {
    const { machine, actions } = make();
    machine.press();
    vi.advanceTimersByTime(SHORT_MS * 0.8);
    machine.release();
    vi.advanceTimersByTime(DOUBLE_MS * 0.7);
    machine.press();
    expect(machine.state).toBe(GestureState.locked);
    expect(actions).toEqual(["start", "lock"]);
  });

  it("starts a fresh dictation after a late second press", () => {
    const { machine, actions } = make();
    machine.press();
    machine.release();
    vi.advanceTimersByTime(DOUBLE_MS);
    machine.press();
    expect(actions).toEqual(["start", "discard", "start"]);
    expect(machine.state).toBe(GestureState.held);
  });

  it("round-trips the dedicated toggle", () => {
    const { machine, actions } = make();
    machine.toggle();
    expect(machine.state).toBe(GestureState.locked);
    expect(actions).toEqual(["start", "lock"]);
    machine.toggle();
    expect(machine.state).toBe(GestureState.idle);
    expect(actions).toEqual(["start", "lock", "finish"]);
  });

  it("stays idle when recording cannot start", () => {
    const { machine, actions } = make(false);
    machine.press();
    expect(machine.state).toBe(GestureState.idle);
    machine.release();
    expect(actions).toEqual(["start"]);
  });

  it("cancels held recording and ignores its later release", () => {
    const { machine, actions } = make();
    machine.press();
    expect(machine.cancel()).toBe(true);
    machine.release();
    expect(machine.state).toBe(GestureState.idle);
    expect(actions).toEqual(["start", "discard"]);
  });

  it("does not cancel while idle", () => {
    const { machine, actions } = make();
    expect(machine.cancel()).toBe(false);
    expect(actions).toEqual([]);
  });

  it("cancels a locked recording", () => {
    const { machine, actions } = make();
    machine.toggle();
    expect(machine.cancel()).toBe(true);
    expect(machine.state).toBe(GestureState.idle);
    expect(actions).toEqual(["start", "lock", "discard"]);
  });

  it("cancels a pending tap without a second discard", () => {
    const { machine, actions } = make();
    machine.press();
    machine.release();
    expect(machine.cancel()).toBe(true);
    vi.advanceTimersByTime(DOUBLE_MS);
    expect(machine.state).toBe(GestureState.idle);
    expect(actions).toEqual(["start", "discard"]);
  });
});
