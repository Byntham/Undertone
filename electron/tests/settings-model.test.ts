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
      provider: "xai",
      cleanupProvider: "xai",
      keyConfigured: { xai: true, openai: false, openrouter: false },
      sttModel: "",
      cleanupModel: "",
      localLoaded: false,
      localIdleMinutes: 0,
      localEngines: {
        stt: {
          installed: false,
          loaded: false,
          loading: false,
          build: null,
          installing: false,
          installPhase: "",
          installFraction: 0,
          installBytes: 0,
        },
        cleanup: {
          installed: false,
          loaded: false,
          loading: false,
          build: null,
          installing: false,
          installPhase: "",
          installFraction: 0,
          installBytes: 0,
        },
      },
    });
    expect(snapshot).not.toHaveProperty("api_key");
  });

  it("updates providers, write-only keys, and provider-specific models", () => {
    let config = normalizeConfig({ api_key: "x-secret", openai_api_key: "old-secret" });
    config = applySettingsPatch(config, {
      provider: "openai",
      cleanupProvider: "openrouter",
      providerKey: { provider: "openai", value: "  replacement  " },
      sttModel: { provider: "openai", value: "custom-stt" },
      cleanupModel: { provider: "openrouter", value: "custom-cleanup" },
    });
    expect(config.provider).toBe("openai");
    expect(config.cleanup_provider).toBe("openrouter");
    expect(config.openai_api_key).toBe("replacement");
    expect(config.api_key).toBe("x-secret");
    expect(config.stt_models).toEqual({ openai: "custom-stt" });
    expect(config.cleanup_models).toEqual({ openrouter: "custom-cleanup" });
    const snapshot = settingsSnapshot(config, "1.3.0", true);
    expect(snapshot.keyConfigured).toEqual({ xai: true, openai: true, openrouter: false });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.sttModel).toBe("custom-stt");
    expect(snapshot.cleanupModel).toBe("custom-cleanup");
  });

  it("clears model overrides and rejects malformed provider updates", () => {
    const config = normalizeConfig({ stt_models: { xai: "custom" } });
    expect(applySettingsPatch(config, {
      sttModel: { provider: "xai", value: "" },
    }).stt_models).toEqual({});
    expect(() => applySettingsPatch(config, { provider: "unknown" }))
      .toThrow(/supported provider/u);
    expect(() => applySettingsPatch(config, {
      providerKey: { provider: "local", value: "not-valid" },
    })).toThrow(/unsupported provider/u);
    expect(() => applySettingsPatch(config, {
      providerKey: { provider: "xai", value: "ok", leaked: true },
    })).toThrow(/invalid fields/u);
    expect(() => applySettingsPatch(config, {
      cleanupModel: { provider: "xai", value: "bad\nmodel" },
    })).toThrow(/invalid/u);
  });

  it("falls back to xAI when a corrupt config contains unknown providers", () => {
    const config = normalizeConfig({ provider: "broken", cleanup_provider: 42 });
    const snapshot = settingsSnapshot(config, "1.3.0", true);
    expect(snapshot.provider).toBe("xai");
    expect(snapshot.cleanupProvider).toBe("xai");
  });

  it("applies supported fields without mutating the existing config", () => {
    const config = normalizeConfig(undefined);
    const next = applySettingsPatch(config, {
      language: "fr",
      smartFormatting: false,
      aiCleanup: false,
      restoreClipboard: false,
      localLoaded: true,
      localIdleMinutes: 15,
    });
    expect(next).not.toBe(config);
    expect(next.language).toBe("fr");
    expect(next.smart_formatting).toBe(false);
    expect(next.ai_cleanup).toBe(false);
    expect(next.restore_clipboard).toBe(false);
    expect(next.local_loaded).toBe(true);
    expect(next.local_idle_minutes).toBe(15);
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
    expect(() => applySettingsPatch(config, { localIdleMinutes: 7 }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, null)).toThrow(/must be an object/u);
  });
});
