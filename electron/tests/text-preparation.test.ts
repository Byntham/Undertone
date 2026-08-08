import { describe, expect, it } from "vitest";

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
    expect(await prepareText("hello", normalizeConfig({
      ai_cleanup: true,
      corrections: { "under tone": "Undertone" },
    }), dependencies)).toEqual({ text: "Hello.", cleanupFailed: false });
    expect(captured).toMatchObject({
      transcript: "hello",
      corrections: { "under tone": "Undertone" },
      reasoningEffort: "none",
      serviceTier: "priority",
    });
    expect(captured).not.toHaveProperty("context");
    expect(captured).not.toHaveProperty("app");
  });

  it("uses deterministic corrections when cleanup is disabled", async () => {
    expect(await prepareText(
      "  under tone works.  ",
      normalizeConfig({ ai_cleanup: false, corrections: { "under tone": "Undertone" } }),
      makeDependencies(),
    )).toEqual({ text: "Undertone works.", cleanupFailed: false });
  });

  it("keeps deterministic output when cleanup is unavailable", async () => {
    expect(await prepareText(
      "  hello world.  ",
      normalizeConfig({ ai_cleanup: true }),
      makeDependencies(),
    )).toEqual({ text: "hello world.", cleanupFailed: true });
  });
});

function makeDependencies(): TextPreparationDependencies {
  return { async cleanup() { return null; } };
}
