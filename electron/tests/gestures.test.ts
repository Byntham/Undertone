import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GestureState, TapStateMachine } from "../src/core/gestures";

const TAP_MS = 100;

function make(startOk = true, toggleOnly = false): {
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
      onFinish: (completion) => actions.push(`finish:${completion}`),
      onDiscard: () => actions.push("discard"),
      onLock: () => actions.push("lock"),
    },
    { tapMs: TAP_MS, toggleOnly: () => toggleOnly },
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

  it("auto-commits a held recording on release", () => {
    const { machine, actions } = make();
    machine.press();
    vi.advanceTimersByTime(TAP_MS);
    machine.release();
    expect(actions).toEqual(["start", "finish:commit"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("locks recording after one tap and commits when the next tap is released", () => {
    const { machine, actions } = make();
    machine.press();
    vi.advanceTimersByTime(TAP_MS - 1);
    machine.release();
    expect(machine.state).toBe(GestureState.locked);
    expect(actions).toEqual(["start", "lock"]);

    machine.press();
    expect(actions).toEqual(["start", "lock"]);
    expect(machine.state).toBe(GestureState.stopping);
    machine.release();
    expect(actions).toEqual(["start", "lock", "finish:commit"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("starts recording immediately even when the gesture becomes a tap", () => {
    const { machine, actions } = make();
    machine.press();
    expect(actions).toEqual(["start"]);
    expect(machine.state).toBe(GestureState.held);
    machine.release();
    expect(machine.state).toBe(GestureState.locked);
  });

  it("starts and stops toggle-only recording after the shortcut is released", () => {
    const { machine, actions } = make(true, true);
    machine.press();
    vi.advanceTimersByTime(TAP_MS * 2);
    expect(actions).toEqual([]);
    machine.release();
    expect(actions).toEqual(["start", "lock"]);
    expect(machine.state).toBe(GestureState.locked);

    machine.press();
    expect(actions).toEqual(["start", "lock"]);
    machine.release();
    expect(actions).toEqual(["start", "lock", "finish:commit"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("cancels a deferred toggle without discarding a recording", () => {
    const { machine, actions } = make(true, true);
    machine.press();
    expect(machine.cancel()).toBe(true);
    machine.release();
    expect(actions).toEqual([]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("finishes a held recording into the open turn", () => {
    const { machine, actions } = make();
    machine.press();
    expect(machine.finishOpenTurn()).toBe(true);
    machine.release();
    expect(actions).toEqual(["start", "finish:open-turn"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("finishes a locked recording into the open turn", () => {
    const { machine, actions } = make();
    machine.press();
    machine.release();
    expect(machine.finishOpenTurn()).toBe(true);
    expect(actions).toEqual(["start", "lock", "finish:open-turn"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("stays idle when recording cannot start", () => {
    const { machine, actions } = make(false);
    machine.press();
    machine.release();
    expect(actions).toEqual(["start"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("cancels a recording and ignores its later release", () => {
    const { machine, actions } = make();
    machine.press();
    expect(machine.cancel()).toBe(true);
    machine.release();
    expect(actions).toEqual(["start", "discard"]);
    expect(machine.state).toBe(GestureState.idle);
  });

  it("does nothing when idle completion or cancellation is requested", () => {
    const { machine, actions } = make();
    expect(machine.finishOpenTurn()).toBe(false);
    expect(machine.cancel()).toBe(false);
    expect(actions).toEqual([]);
  });
});
