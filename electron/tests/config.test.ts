import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  normalizeConfig,
  providerKey,
  xaiVocabularyHints,
} from "../src/core/config";
import { ConfigStore, type SecretCipher } from "../src/main/configStore";

const temporaryDirectories: string[] = [];
const cipher: SecretCipher = {
  async protectSecret(value) {
    return `dpapi:test:${Buffer.from(value, "utf8").toString("base64")}`;
  },
  async unprotectSecret(value) {
    if (!value.startsWith("dpapi:test:")) return "";
    return Buffer.from(value.slice("dpapi:test:".length), "base64").toString("utf8");
  },
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("configuration", () => {
  it("fills defaults without sharing mutable default containers", () => {
    const first = normalizeConfig({ language: "fr" });
    const second = normalizeConfig(undefined);
    expect(first.language).toBe("fr");
    expect(second.language).toBe("en");
    expect(second.provider).toBe("local");
    expect(second.cleanup_provider).toBe("local");
    expect(second.stack_cleanup_strategy).toBe("live-full");
    expect(second.live_transcription).toBe(false);
    expect(second.cleanup_reasoning_effort).toBe("none");
    expect(second.cleanup_service_tier).toBe("priority");
    expect(second.hotkey).toBe("left ctrl+left windows");
    expect(second.repaste_hotkey).toBe("left alt+v");
    expect(second.commit_hotkey).toBe("left ctrl+left alt");
    expect(second.scratch_hotkey).toBe("left ctrl+left alt+backspace");
    expect(second.discard_hotkey).toBe("ctrl+alt+shift+backspace");
    first.vocabulary.push("Undertone");
    first.corrections.test = "value";
    expect(second.vocabulary).toEqual([]);
    expect(second.corrections).toEqual({});
    expect(DEFAULT_CONFIG.vocabulary).toEqual([]);
  });

  it("repairs every malformed persisted scalar and drops unknown fields", () => {
    const config = normalizeConfig({
      api_key: 1,
      openai_api_key: false,
      openai_oauth_access_token: [],
      openai_oauth_refresh_token: {},
      openai_oauth_expires_at: Number.POSITIVE_INFINITY,
      openai_oauth_account_id: null,
      openrouter_api_key: "bad\nkey",
      hotkey: "x".repeat(257),
      language: "../bad",
      restore_clipboard: "true",
      input_device: "bad\0device",
      provider: "openai-subscription",
      ai_cleanup: 1,
      cleanup_provider: "unknown",
      sound_cues: null,
      vocabulary: {},
      corrections: [],
      stt_vocab_hints: "false",
      repaste_hotkey: false,
      commit_hotkey: null,
      scratch_hotkey: 42,
      discard_hotkey: [],
      live_transcription: "true",
      stack_cleanup_strategy: "sometimes",
      local_loaded: "false",
      local_idle_minutes: 7,
      cleanup_timeout: Number.NaN,
      cleanup_reasoning_effort: "minimal",
      cleanup_service_tier: "turbo",
      unknown: "drop me",
    });

    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config).not.toHaveProperty("unknown");
  });

  it("canonicalizes persisted strings, lists, maps, and bounded numbers", () => {
    const config = normalizeConfig({
      api_key: "  x-key  ",
      language: "  fr-CA  ",
      input_device: "  USB Mic  ",
      openai_oauth_expires_at: 123_456,
      local_idle_minutes: 15,
      cleanup_timeout: 0.5,
      vocabulary: [" Undertone ", 42, "Undertone", "bad\nterm", "Kubernetes"],
      corrections: {
        " under tone ": " Undertone ",
        invalid: false,
        multiline: "bad\nvalue",
      },
    });

    expect(config.api_key).toBe("x-key");
    expect(config.language).toBe("fr-CA");
    expect(config.input_device).toBe("USB Mic");
    expect(config.openai_oauth_expires_at).toBe(123_456);
    expect(config.local_idle_minutes).toBe(15);
    expect(config.cleanup_timeout).toBe(0.5);
    expect(config.vocabulary).toEqual(["Undertone", "Kubernetes"]);
    expect(config.corrections).toEqual({ "under tone": "Undertone" });
  });

  it("defaults overlarge persisted containers and out-of-range numbers", () => {
    expect(normalizeConfig({
      openai_oauth_expires_at: -1,
      local_idle_minutes: 60.5,
      cleanup_timeout: 30.1,
      vocabulary: Array.from({ length: 201 }, (_, index) => `term-${index}`),
      corrections: Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`heard-${index}`, `written-${index}`]),
      ),
    })).toMatchObject({
      openai_oauth_expires_at: 0,
      local_idle_minutes: 0,
      cleanup_timeout: 2.5,
      vocabulary: [],
      corrections: {},
    });
  });

  it("repairs a malformed live-transcription flag", () => {
    expect(normalizeConfig({ live_transcription: "false" }).live_transcription).toBe(false);
    expect(normalizeConfig({ live_transcription: true }).live_transcription).toBe(true);
  });

  it("repairs invalid Luna request settings and migrates fast to priority", () => {
    const config = normalizeConfig({
      cleanup_reasoning_effort: "minimal",
      cleanup_service_tier: "turbo",
    });
    expect(config.cleanup_reasoning_effort).toBe("none");
    expect(config.cleanup_service_tier).toBe("priority");
    expect(normalizeConfig({ cleanup_service_tier: "fast" }).cleanup_service_tier)
      .toBe("priority");
  });

  it("keeps cleanup timeout config-only and repairs invalid values", () => {
    expect(normalizeConfig({ cleanup_timeout: 4.5 }).cleanup_timeout).toBe(4.5);
    expect(normalizeConfig({ cleanup_timeout: 31 }).cleanup_timeout).toBe(2.5);
    expect(normalizeConfig({ cleanup_timeout: "slow" }).cleanup_timeout).toBe(2.5);
  });

  it("maps provider keys without an implicit xAI fallback", () => {
    const config = {
      api_key: "X",
      openai_api_key: "O",
      openrouter_api_key: "R",
    };
    expect(providerKey(config, "xai")).toBe("X");
    expect(providerKey(config, "openai")).toBe("O");
    expect(providerKey(config, "openrouter")).toBe("R");
    expect(providerKey(config, "local")).toBe("");
    expect(providerKey(config, "unknown")).toBe("");
  });

  it("defaults a missing file and moves a corrupt file aside", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const warnings: string[] = [];
    const store = new ConfigStore({
      configPath,
      cipher,
      onWarning: (message) => { warnings.push(message); },
    });
    expect((await store.load()).language).toBe("en");
    await writeFile(configPath, "not-json", "utf8");
    expect((await store.load()).language).toBe("en");
    const files = await readdir(path.dirname(configPath));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^config\.json\.corrupt-/u);
    expect(await readFile(path.join(path.dirname(configPath), files[0]!), "utf8"))
      .toBe("not-json");
    expect(warnings).toEqual([expect.stringContaining(files[0]!)]);
  });

  it("builds deduplicated vocabulary hints for xAI only", () => {
    const values = {
      vocabulary: ["Undertone", "Kubernetes"],
      corrections: { kubernetes: "Kubernetes", codex: "Codex" },
      stt_vocab_hints: true,
    };
    expect(xaiVocabularyHints(normalizeConfig({ ...values, provider: "xai" })))
      .toEqual(["Undertone", "Kubernetes", "Codex"]);
    expect(xaiVocabularyHints(normalizeConfig({ ...values, provider: "openai" })))
      .toEqual([]);
    expect(xaiVocabularyHints(normalizeConfig({
      ...values,
      provider: "xai",
      stt_vocab_hints: false,
    }))).toEqual([]);
  });

  it("does not hide config filesystem failures", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    await mkdir(configPath, { recursive: true });
    const store = new ConfigStore({ configPath, cipher });
    await expect(store.load()).rejects.toMatchObject({ code: expect.any(String) });
  });

  it("encrypts keys and OAuth tokens, preserves memory, and replaces atomically", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const store = new ConfigStore({ configPath, cipher });
    const config = normalizeConfig({
      api_key: "sk-super-secret-123",
      openai_oauth_access_token: "oauth-access",
      openai_oauth_refresh_token: "oauth-refresh",
      openai_oauth_account_id: "oauth-account",
      openai_oauth_expires_at: 123456,
    });
    await store.save(config);
    const firstDiskValue = await readFile(configPath, "utf8");
    expect(firstDiskValue).not.toContain("sk-super-secret-123");
    expect(firstDiskValue).not.toContain("oauth-access");
    expect(firstDiskValue).not.toContain("oauth-refresh");
    expect(firstDiskValue).not.toContain("oauth-account");
    expect(firstDiskValue).toContain("dpapi:test:");
    expect(config.api_key).toBe("sk-super-secret-123");
    expect((await store.load()).api_key).toBe("sk-super-secret-123");
    const loaded = await store.load();
    expect(loaded.openai_oauth_access_token).toBe("oauth-access");
    expect(loaded.openai_oauth_refresh_token).toBe("oauth-refresh");
    expect(loaded.openai_oauth_account_id).toBe("oauth-account");
    expect(loaded.openai_oauth_expires_at).toBe(123456);

    config.language = "es";
    await store.save(config);
    expect((await store.load()).language).toBe("es");
    expect(await fileExists(`${configPath}.tmp`)).toBe(false);
  });

  it("rejects plaintext and malformed encrypted keys", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const store = new ConfigStore({ configPath, cipher });
    await store.load();
    await writeFile(configPath, JSON.stringify({ api_key: "plain-legacy-key" }), "utf8");
    expect((await store.load()).api_key).toBe("");
    await writeFile(configPath, JSON.stringify({ api_key: "dpapi:not-a-blob" }), "utf8");
    expect((await store.load()).api_key).toBe("");
  });
});

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "undertone-config-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await readFile(candidate);
    return true;
  } catch {
    return false;
  }
}
