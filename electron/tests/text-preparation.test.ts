import { describe, expect, it } from "vitest";

import { CleanupError } from "../src/core/cleanup";
import { normalizeConfig } from "../src/core/config";
import {
  prepareText,
  type CleanupRequest,
  type TextPreparationDependencies,
} from "../src/core/textPreparation";

describe("text preparation pipeline", () => {
  it("sends only the open turn and explicit cleanup configuration", async () => {
    let captured: CleanupRequest | undefined;
    const dependencies = makeDependencies();
    dependencies.cleanup = async (request) => {
      captured = request;
      return "Hello.";
    };
    expect(await prepareText("under tone", normalizeConfig({
      ai_cleanup: true,
      corrections: { "under tone": "Undertone" },
    }), dependencies)).toEqual({ text: "Hello.", cleanupFailed: false });
    expect(captured).toMatchObject({
      transcript: "under tone",
      reasoningEffort: "none",
      serviceTier: "priority",
    });
    expect(captured).not.toHaveProperty("context");
    expect(captured).not.toHaveProperty("app");
    expect(captured).not.toHaveProperty("corrections");
  });

  it("uses deterministic corrections when cleanup is disabled", async () => {
    expect(await prepareText(
      "  under tone works.  ",
      normalizeConfig({ ai_cleanup: false, corrections: { "under tone": "Undertone" } }),
      makeDependencies(),
    )).toEqual({ text: "Undertone works.", cleanupFailed: false });
  });

  it("uses a cold local fallback without reporting a provider failure", async () => {
    expect(await prepareText(
      "  hello world.  ",
      normalizeConfig({ ai_cleanup: true }),
      makeDependencies(),
    )).toEqual({ text: "hello world.", cleanupFailed: false });
  });

  it("applies exact local corrections once after AI cleanup or fallback", async () => {
    const config = normalizeConfig({
      ai_cleanup: true,
      corrections: { foo: "bar", bar: "baz" },
    });
    const successful = makeDependencies();
    successful.cleanup = async () => "foo";

    expect(await prepareText("foo", config, successful))
      .toEqual({ text: "bar", cleanupFailed: false });
    expect(await prepareText("foo", config, makeDependencies()))
      .toEqual({ text: "bar", cleanupFailed: false });
  });

  it("uses deterministic output and reports a real cleanup failure", async () => {
    const dependencies = makeDependencies();
    dependencies.cleanup = async () => {
      throw new CleanupError("Cleanup request failed.");
    };
    expect(await prepareText(
      "foo",
      normalizeConfig({ ai_cleanup: true, corrections: { foo: "bar" } }),
      dependencies,
    )).toEqual({ text: "bar", cleanupFailed: true });
  });

  it("does not hide unexpected implementation errors", async () => {
    const dependencies = makeDependencies();
    dependencies.cleanup = async () => { throw new TypeError("bug"); };
    await expect(prepareText("foo", normalizeConfig({ ai_cleanup: true }), dependencies))
      .rejects.toThrow(TypeError);
  });
});

function makeDependencies(): TextPreparationDependencies {
  return { async cleanup() { return null; } };
}
