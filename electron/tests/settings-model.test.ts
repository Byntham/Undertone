import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import { applySettingsPatch, settingsSnapshot } from "../src/core/settingsModel";

describe("settings model", () => {
  it("exposes only the initial renderer-safe settings surface", () => {
    const snapshot = settingsSnapshot(normalizeConfig({ api_key: "secret" }), "1.3.0", true);
    expect(snapshot).toEqual({
      language: "en",
      smartFormatting: true,
      aiCleanup: true,
      restoreClipboard: true,
      hotkey: "right ctrl",
      appVersion: "1.3.0",
      preview: true,
    });
    expect(snapshot).not.toHaveProperty("api_key");
  });

  it("applies supported fields without mutating the existing config", () => {
    const config = normalizeConfig(undefined);
    const next = applySettingsPatch(config, {
      language: "fr",
      smartFormatting: false,
      aiCleanup: false,
      restoreClipboard: false,
    });
    expect(next).not.toBe(config);
    expect(next.language).toBe("fr");
    expect(next.smart_formatting).toBe(false);
    expect(next.ai_cleanup).toBe(false);
    expect(next.restore_clipboard).toBe(false);
    expect(config.language).toBe("en");
  });

  it("rejects unknown, mistyped, or malformed patches", () => {
    const config = normalizeConfig(undefined);
    expect(() => applySettingsPatch(config, { api_key: "steal-me" }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { smartFormatting: "yes" }))
      .toThrow(/must be boolean/u);
    expect(() => applySettingsPatch(config, { language: "../bad" }))
      .toThrow(/Invalid transcription language/u);
    expect(() => applySettingsPatch(config, null)).toThrow(/must be an object/u);
  });
});
