import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  modelOverride,
  normalizeConfig,
  providerKey,
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

  it("migrates the removed hybrid stack cleanup strategy to the default", () => {
    expect(normalizeConfig({
      stack_cleanup_strategy: "live-delta-commit-full",
    }).stack_cleanup_strategy)
      .toBe("live-full");
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

  it("keeps only current fields and repairs model override containers", () => {
    const config = normalizeConfig({
      language: "fr",
      sample_rate: 48_000,
      dev_mode: true,
      onboarded: true,
      stt_model: "whisper-1",
      stt_models: "invalid",
      cleanup_models: null,
    });
    expect(config.language).toBe("fr");
    expect(config).not.toHaveProperty("sample_rate");
    expect(config).not.toHaveProperty("dev_mode");
    expect(config).not.toHaveProperty("onboarded");
    expect(config).not.toHaveProperty("stt_model");
    expect(config.stt_models).toEqual({});
    expect(config.cleanup_models).toEqual({});
    expect(modelOverride(config, "stt", "openai")).toBe("");
  });

  it("removes obsolete local model overrides", () => {
    const config = normalizeConfig({
      stt_models: { local: "other.bin", openai: "whisper-1" },
      cleanup_models: { local: "other.gguf", xai: "grok-latest" },
    });
    expect(config.stt_models).toEqual({ openai: "whisper-1" });
    expect(config.cleanup_models).toEqual({ xai: "grok-latest" });
    expect(modelOverride(config, "stt", "local")).toBe("");
    expect(modelOverride(config, "cleanup", "local")).toBe("");
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

  it("falls back safely for missing or corrupt files", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const store = new ConfigStore({ configPath, cipher });
    expect((await store.load()).language).toBe("en");
    await writeFile(configPath, "not-json", "utf8");
    expect((await store.load()).language).toBe("en");
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
