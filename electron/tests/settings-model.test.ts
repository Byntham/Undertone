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
      soundCues: true,
      startWithWindows: false,
      hotkey: "right ctrl",
      repasteHotkey: "ctrl+alt+v",
      inputDevice: "",
      microphones: [],
      appVersion: "1.3.0",
      preview: true,
      provider: "local",
      cleanupProvider: "local",
      keyConfigured: { xai: true, openai: false, openrouter: false },
      sttModel: "",
      cleanupModel: "",
      localLoaded: false,
      localIdleMinutes: 0,
      sttVocabHints: true,
      vocabulary: [],
      corrections: {},
      cleanupTimeout: 2.5,
      cleanupPrompt: "",
      cleanupPrompts: {},
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

  it("falls back to local when a corrupt config contains unknown providers", () => {
    const config = normalizeConfig({ provider: "broken", cleanup_provider: 42 });
    const snapshot = settingsSnapshot(config, "1.3.0", true);
    expect(snapshot.provider).toBe("local");
    expect(snapshot.cleanupProvider).toBe("local");
  });

  it("applies supported fields without mutating the existing config", () => {
    const config = normalizeConfig(undefined);
    const next = applySettingsPatch(config, {
      language: "fr",
      smartFormatting: false,
      aiCleanup: false,
      restoreClipboard: false,
      inputDevice: "USB Podcast Mic",
      localLoaded: true,
      localIdleMinutes: 15,
      soundCues: false,
      startWithWindows: true,
      sttVocabHints: false,
      vocabulary: [" Undertone ", "Undertone", "Kubernetes"],
      corrections: { "under tone": "Undertone" },
      cleanupTimeout: 4.5,
      cleanupPrompt: " custom prompt ",
      cleanupPrompts: { Fast: "multi\nline prompt" },
    });
    expect(next).not.toBe(config);
    expect(next.language).toBe("fr");
    expect(next.smart_formatting).toBe(false);
    expect(next.ai_cleanup).toBe(false);
    expect(next.restore_clipboard).toBe(false);
    expect(next.input_device).toBe("USB Podcast Mic");
    expect(next.local_loaded).toBe(true);
    expect(next.local_idle_minutes).toBe(15);
    expect(next.sound_cues).toBe(false);
    expect(next.stt_vocab_hints).toBe(false);
    expect(next.vocabulary).toEqual(["Undertone", "Kubernetes"]);
    expect(next.corrections).toEqual({ "under tone": "Undertone" });
    expect(next.cleanup_timeout).toBe(4.5);
    expect(next.cleanup_prompt).toBe("custom prompt");
    expect(next.cleanup_prompts).toEqual({ Fast: "multi\nline prompt" });
    expect(config.language).toBe("en");
  });

  it("normalizes shortcut updates and rejects collisions", () => {
    const config = normalizeConfig(undefined);
    const next = applySettingsPatch(config, {
      hotkey: " Control + Shift + A ",
      repasteHotkey: "Alt+V",
    });
    expect(next.hotkey).toBe("ctrl+shift+a");
    expect(next.repaste_hotkey).toBe("alt+v");
    expect(() => applySettingsPatch(config, {
      repasteHotkey: "right ctrl",
    })).toThrow(/already assigned/u);
  });

  it("rejects unknown, mistyped, or malformed patches", () => {
    const config = normalizeConfig(undefined);
    expect(() => applySettingsPatch(config, { api_key: "steal-me" }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { onboarded: true }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { smartFormatting: "yes" }))
      .toThrow(/must be boolean/u);
    expect(() => applySettingsPatch(config, { language: "../bad" }))
      .toThrow(/Invalid transcription language/u);
    expect(() => applySettingsPatch(config, { localIdleMinutes: 7 }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, { cleanupTimeout: 31 }))
      .toThrow(/between/u);
    expect(() => applySettingsPatch(config, { vocabulary: ["bad\nterm"] }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, { corrections: { heard: "" } }))
      .toThrow(/empty/u);
    expect(() => applySettingsPatch(config, null)).toThrow(/must be an object/u);
  });
});
