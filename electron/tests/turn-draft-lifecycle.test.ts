import { describe, expect, it } from "vitest";

import { canHideTurnDraftAfterDismissal } from "../src/shared/overlay";

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
});
