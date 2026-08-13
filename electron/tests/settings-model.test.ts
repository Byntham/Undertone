import { describe, expect, it } from "vitest";

import { normalizeConfig } from "../src/core/config";
import { applySettingsPatch, settingsSnapshot } from "../src/core/settingsModel";

describe("settings model", () => {
  it("exposes only the initial renderer-safe settings surface", () => {
    const snapshot = settingsSnapshot(normalizeConfig({ api_key: "secret" }), "1.3.0");
    expect(snapshot).toEqual({
      language: "en",
      aiCleanup: true,
      restoreClipboard: true,
      soundCues: true,
      startWithWindows: false,
      hotkey: "left ctrl+left windows",
      repasteHotkey: "left alt+v",
      commitHotkey: "left ctrl+left alt",
      scratchHotkey: "left ctrl+left alt+backspace",
      discardHotkey: "ctrl+alt+shift+backspace",
      shortcutWarning: null,
      liveTranscription: false,
      openTurnCleanupStrategy: "live-full",
      inputDevice: "",
      microphones: [],
      appVersion: "1.3.0",
      provider: "local",
      localSttEngine: "whisper",
      cleanupProvider: "local",
      keyConfigured: { xai: true, openai: false, openrouter: false },
      openAiSubscriptionConnected: false,
      sttModel: "ggml-large-v3-turbo.bin",
      cleanupModel: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
      localLoaded: false,
      localIdleMinutes: 0,
      sttVocabHints: true,
      vocabulary: [],
      corrections: {},
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

  it("updates providers and write-only keys while exposing fixed supported models", () => {
    let config = normalizeConfig({
      api_key: "x-secret",
      openai_api_key: "old-secret",
    });
    config = applySettingsPatch(config, {
      provider: "openai",
      cleanupProvider: "openrouter",
      providerKey: { provider: "openai", value: "  replacement  " },
    });
    expect(config.provider).toBe("openai");
    expect(config.cleanup_provider).toBe("openrouter");
    expect(config.openai_api_key).toBe("replacement");
    expect(config.api_key).toBe("x-secret");
    const snapshot = settingsSnapshot(config, "1.3.0");
    expect(snapshot.keyConfigured).toEqual({ xai: true, openai: true, openrouter: false });
    expect(JSON.stringify(snapshot)).not.toContain("secret");
    expect(snapshot.sttModel).toBe("gpt-transcribe");
    expect(snapshot.cleanupModel).toBe("openai/gpt-5.6-luna");
  });

  it("reports the model used by live transcription", () => {
    const openAi = normalizeConfig({ provider: "openai", live_transcription: true });
    expect(settingsSnapshot(openAi, "1.8.1").sttModel)
      .toBe("gpt-live-transcribe");

    const xai = normalizeConfig({ provider: "xai", live_transcription: true });
    expect(settingsSnapshot(xai, "1.8.1").sttModel).toBe("");

    const local = normalizeConfig({ provider: "local", live_transcription: true });
    expect(local.live_transcription).toBe(false);
    expect(settingsSnapshot(local, "1.8.1").sttModel)
      .toBe("ggml-large-v3-turbo.bin");

    const nemotron = normalizeConfig({
      provider: "local",
      local_stt_engine: "nemotron",
      live_transcription: true,
    });
    expect(settingsSnapshot(nemotron, "1.8.1").sttModel)
      .toBe("nemotron-speech-streaming-en-0.6b.q8_0.gguf");
    expect(nemotron.language).toBe("en");
  });

  it("allows subscription cleanup without exposing it as transcription", () => {
    const config = applySettingsPatch(normalizeConfig({
      openai_oauth_access_token: "access",
      openai_oauth_refresh_token: "refresh",
      openai_oauth_account_id: "account",
    }), {
      cleanupProvider: "openai-subscription",
    });
    const snapshot = settingsSnapshot(config, "1.8.0");
    expect(snapshot.cleanupProvider).toBe("openai-subscription");
    expect(snapshot.cleanupModel).toBe("gpt-5.6-luna");
    expect(snapshot.openAiSubscriptionConnected).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("access");
    expect(() => applySettingsPatch(config, { provider: "openai-subscription" }))
      .toThrow(/supported provider/u);
    expect(() => applySettingsPatch(config, {
      sttModel: { provider: "openai-subscription", value: "gpt-5.6-luna" },
    })).toThrow(/Unsupported settings field/u);
  });

  it("uses fixed models and rejects malformed provider updates", () => {
    const config = normalizeConfig({
      provider: "xai",
    });
    expect(settingsSnapshot(config, "1.8.0").sttModel).toBe("");
    expect(() => applySettingsPatch(config, {
      sttModel: { provider: "xai", value: "" },
    })).toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, {
      cleanupModel: { provider: "openai", value: "gpt-5.6-luna" },
    })).toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { provider: "unknown" }))
      .toThrow(/supported provider/u);
    expect(() => applySettingsPatch(config, {
      providerKey: { provider: "local", value: "not-valid" },
    })).toThrow(/unsupported provider/u);
    expect(() => applySettingsPatch(config, {
      providerKey: { provider: "xai", value: "ok", leaked: true },
    })).toThrow(/invalid fields/u);
  });

  it("applies supported fields without mutating the existing config", () => {
    const config = normalizeConfig({ provider: "openai" });
    const next = applySettingsPatch(config, {
      language: "fr",
      aiCleanup: false,
      restoreClipboard: false,
      inputDevice: "USB Podcast Mic",
      localLoaded: true,
      localIdleMinutes: 15,
      soundCues: false,
      sttVocabHints: false,
      vocabulary: [" Undertone ", "Undertone", "Kubernetes"],
      corrections: { "under tone": "Undertone" },
      openTurnCleanupStrategy: "commit-full",
      liveTranscription: true,
    });
    expect(next).not.toBe(config);
    expect(next.language).toBe("fr");
    expect(next.ai_cleanup).toBe(false);
    expect(next.restore_clipboard).toBe(false);
    expect(next.input_device).toBe("USB Podcast Mic");
    expect(next.local_loaded).toBe(true);
    expect(next.local_idle_minutes).toBe(15);
    expect(next.sound_cues).toBe(false);
    expect(next.stt_vocab_hints).toBe(false);
    expect(next.vocabulary).toEqual(["Undertone", "Kubernetes"]);
    expect(next.corrections).toEqual({ "under tone": "Undertone" });
    expect(next.cleanup_reasoning_effort).toBe("none");
    expect(next.cleanup_service_tier).toBe("priority");
    expect(next.stack_cleanup_strategy).toBe("commit-full");
    expect(next.live_transcription).toBe(true);
    expect(config.language).toBe("en");
  });

  it("turns live preview off when local Whisper is selected", () => {
    const config = normalizeConfig({
      provider: "local",
      local_stt_engine: "nemotron",
      live_transcription: true,
    });
    const next = applySettingsPatch(config, { localSttEngine: "whisper" });
    expect(next.live_transcription).toBe(false);
    expect(next.local_stt_engine).toBe("whisper");
  });

  it("normalizes shortcut updates and rejects collisions", () => {
    const config = normalizeConfig(undefined);
    const next = applySettingsPatch(config, {
      hotkey: " Control + Shift + A ",
      repasteHotkey: "Alt+V",
      commitHotkey: "ctrl+alt",
    });
    expect(next.hotkey).toBe("ctrl+shift+a");
    expect(next.repaste_hotkey).toBe("alt+v");
    expect(next.commit_hotkey).toBe("ctrl+alt");
    expect(() => applySettingsPatch(config, {
      repasteHotkey: "left ctrl+left alt",
    })).toThrow(/already assigned/u);
  });

  it("rejects physical PTT overlap while allowing intentional action subsets", () => {
    const config = normalizeConfig(undefined);
    expect(() => applySettingsPatch(config, {
      hotkey: "left ctrl",
    })).toThrow(/Dictate shortcut overlaps/u);
    expect(() => applySettingsPatch(config, {
      commitHotkey: "left ctrl+left windows+enter",
    })).toThrow(/Dictate shortcut overlaps/u);
    expect(() => applySettingsPatch(config, {
      hotkey: "left ctrl+left alt",
    })).toThrow(/cannot include Left Alt/u);
    expect(() => applySettingsPatch(config, {
      commitHotkey: "left alt",
    })).toThrow(/reserved/u);
    expect(() => applySettingsPatch(config, {
      scratchHotkey: "left ctrl+left alt+backspace",
      discardHotkey: "left ctrl+left alt+left shift+backspace",
    })).not.toThrow();
  });

  it("warns about legacy PTT conflicts and permits repairing them one at a time", () => {
    const legacy = normalizeConfig({
      hotkey: "right ctrl",
      repaste_hotkey: "ctrl+alt+v",
      commit_hotkey: "ctrl+alt+enter",
      scratch_hotkey: "ctrl+alt+backspace",
      discard_hotkey: "ctrl+alt+shift+backspace",
    });
    expect(settingsSnapshot(legacy, "1.8.0").shortcutWarning)
      .toMatch(/Re-paste, Commit, Scratch, and Discard/u);
    const repaired = applySettingsPatch(legacy, {
      commitHotkey: "left ctrl+left alt+enter",
    });
    expect(repaired.commit_hotkey).toBe("left ctrl+left alt+enter");
    expect(settingsSnapshot(repaired, "1.8.0").shortcutWarning)
      .toMatch(/Re-paste, Scratch, and Discard/u);
  });

  it("rejects unknown, mistyped, or malformed patches", () => {
    const config = normalizeConfig(undefined);
    expect(() => applySettingsPatch(config, { api_key: "steal-me" }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { startWithWindows: true }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { liveTranscription: "yes" }))
      .toThrow(/must be boolean/u);
    expect(() => applySettingsPatch(config, { language: "../bad" }))
      .toThrow(/Invalid transcription language/u);
    expect(() => applySettingsPatch(config, { localIdleMinutes: 7 }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, { cleanupTimeout: 4.5 }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { cleanupReasoningEffort: "minimal" }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { cleanupServiceTier: "priority" }))
      .toThrow(/Unsupported settings field/u);
    expect(() => applySettingsPatch(config, { scratchHotkey: "ctrl+alt" }))
      .toThrow(/one non-modifier/u);
    expect(() => applySettingsPatch(config, { discardHotkey: "ctrl+k+s" }))
      .toThrow(/one non-modifier/u);
    expect(() => applySettingsPatch(config, { commitHotkey: "ctrl+k+s" }))
      .toThrow(/at most one/u);
    expect(() => applySettingsPatch(config, { openTurnCleanupStrategy: "sometimes" }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, { vocabulary: ["bad\nterm"] }))
      .toThrow(/invalid/u);
    expect(() => applySettingsPatch(config, { corrections: { heard: "" } }))
      .toThrow(/empty/u);
    expect(() => applySettingsPatch(config, null)).toThrow(/must be an object/u);
  });
});
