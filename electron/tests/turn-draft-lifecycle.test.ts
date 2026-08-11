import { describe, expect, it } from "vitest";

import {
  canHideTurnDraftAfterDismissal,
  hasActiveTurnDraftWork,
  nextTurnDraftMode,
} from "../src/shared/overlay";

describe("turn draft dismissal", () => {
  it("allows the matching completion when no work remains", () => {
    expect(canHideTurnDraftAfterDismissal(12, 12, false)).toBe(true);
  });

  it("rejects a stale completion from an older turn", () => {
    expect(canHideTurnDraftAfterDismissal(13, 12, false)).toBe(false);
  });

  it("rejects missing and malformed completion tokens", () => {
    expect(canHideTurnDraftAfterDismissal(null, 12, false)).toBe(false);
    expect(canHideTurnDraftAfterDismissal(12, "12", false)).toBe(false);
    expect(canHideTurnDraftAfterDismissal(12, 12.5, false)).toBe(false);
  });

  it("keeps the window visible when newer work is active", () => {
    expect(canHideTurnDraftAfterDismissal(12, 12, true)).toBe(false);
  });

  it("treats a newer non-live capture as active work", () => {
    const hasActiveWork = hasActiveTurnDraftWork(false, [41, 42], 41);
    expect(hasActiveWork).toBe(true);
    expect(canHideTurnDraftAfterDismissal(12, 12, hasActiveWork)).toBe(false);
  });

  it("ignores the capture whose successful commit is being dismissed", () => {
    expect(hasActiveTurnDraftWork(false, [41], 41)).toBe(false);
  });

  it("keeps buffered text active even when no capture remains", () => {
    expect(hasActiveTurnDraftWork(true, [], undefined)).toBe(true);
  });

  it("keeps the current native size throughout dismissal", () => {
    expect(nextTurnDraftMode("text", false, false, "dismissing")).toBe("text");
    expect(nextTurnDraftMode("compact", false, false, "dismissing")).toBe("compact");
    expect(nextTurnDraftMode("text", false, false, "visible")).toBe("compact");
  });
});
