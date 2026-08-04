import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_CONFIG,
  foldLegacyLocal,
  foldLegacyModels,
  modelOverride,
  normalizeConfig,
  providerKey,
  type ConfigRecord,
} from "../src/core/config";
import { ConfigStore, type SecretCipher } from "../src/main/configStore";

const temporaryDirectories: string[] = [];
const cipher: SecretCipher = {
  async protectSecret(value) {
    return `dpapi:test:${Buffer.from(value, "utf8").toString("base64")}`;
  },
  async unprotectSecret(value) {
    if (!value.startsWith("dpapi:")) return value;
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
    first.vocabulary.push("Undertone");
    first.corrections.test = "value";
    expect(second.vocabulary).toEqual([]);
    expect(second.corrections).toEqual({});
    expect(DEFAULT_CONFIG.vocabulary).toEqual([]);
  });

  it("drops retired settings", () => {
    const config = normalizeConfig({ dev_mode: true, onboarded: true });
    expect(config).not.toHaveProperty("dev_mode");
    expect(config).not.toHaveProperty("onboarded");
  });

  it("folds legacy model fields under their selected providers", () => {
    const shippedDefault: ConfigRecord = {
      ...normalizeConfig(undefined),
      stt_models: {},
      cleanup_models: {},
      cleanup_model: "grok-4.20-0309-non-reasoning",
      stt_model: "",
    };
    foldLegacyModels(shippedDefault);
    expect(shippedDefault).not.toHaveProperty("cleanup_model");
    expect(shippedDefault).not.toHaveProperty("stt_model");
    expect(shippedDefault.cleanup_models).toEqual({});

    const overrides: ConfigRecord = {
      ...normalizeConfig(undefined),
      stt_models: {},
      cleanup_models: {},
      provider: "openai",
      stt_model: "whisper-1",
      cleanup_provider: "openrouter",
      cleanup_model: "meta/llama-x",
    };
    foldLegacyModels(overrides);
    expect(overrides.stt_models).toEqual({ openai: "whisper-1" });
    expect(overrides.cleanup_models).toEqual({ openrouter: "meta/llama-x" });
    expect(modelOverride(overrides, "stt", "openai")).toBe("whisper-1");
    expect(modelOverride(overrides, "stt", "xai")).toBe("");
  });

  it("folds per-engine local residency into the unified fields", () => {
    const config: ConfigRecord = {
      ...normalizeConfig(undefined),
      local_stt_loaded: false,
      local_llm_loaded: true,
      local_stt_idle_minutes: 60,
      local_llm_idle_minutes: 15,
    };
    foldLegacyLocal(config);
    expect(config.local_loaded).toBe(true);
    expect(config.local_idle_minutes).toBe(60);
    expect(config).not.toHaveProperty("local_stt_loaded");
    expect(config).not.toHaveProperty("local_llm_loaded");

    const cleanupWindow: ConfigRecord = {
      ...normalizeConfig(undefined),
      local_stt_idle_minutes: 0,
      local_llm_idle_minutes: 30,
    };
    foldLegacyLocal(cleanupWindow);
    expect(cleanupWindow.local_idle_minutes).toBe(30);

    const unifiedWins: ConfigRecord = {
      ...normalizeConfig(undefined),
      local_loaded: true,
      local_idle_minutes: 5,
      local_stt_idle_minutes: 60,
    };
    foldLegacyLocal(unifiedWins);
    expect(unifiedWins.local_loaded).toBe(true);
    expect(unifiedWins.local_idle_minutes).toBe(5);
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

  it("loads BOM JSON and falls back safely for missing or corrupt files", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const store = new ConfigStore({ configPath, cipher });
    expect((await store.load()).language).toBe("en");
    await writeFile(configPath, "\ufeff{\"language\":\"de\"}", "utf8");
    expect((await store.load()).language).toBe("de");
    await writeFile(configPath, "not-json", "utf8");
    expect((await store.load()).language).toBe("en");
  });

  it("encrypts keys, preserves the in-memory config, and replaces atomically", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const store = new ConfigStore({ configPath, cipher });
    const config = normalizeConfig({ api_key: "sk-super-secret-123" });
    await store.save(config);
    const firstDiskValue = await readFile(configPath, "utf8");
    expect(firstDiskValue).not.toContain("sk-super-secret-123");
    expect(firstDiskValue).toContain("dpapi:test:");
    expect(config.api_key).toBe("sk-super-secret-123");
    expect((await store.load()).api_key).toBe("sk-super-secret-123");

    config.language = "es";
    await store.save(config);
    expect((await store.load()).language).toBe("es");
    expect(await fileExists(`${configPath}.tmp`)).toBe(false);
  });

  it("backs up the pre-Electron config exactly once", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    const backupPath = path.join(directory, "Undertone", "config.pre-electron.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    const original = JSON.stringify({ language: "fr", api_key: "dpapi:test:b2xk" });
    await writeFile(configPath, original, "utf8");
    const store = new ConfigStore({ configPath, backupPath, cipher });
    expect((await store.load()).language).toBe("fr");
    expect(await readFile(backupPath, "utf8")).toBe(original);

    await writeFile(configPath, JSON.stringify({ language: "de" }), "utf8");
    expect((await store.load()).language).toBe("de");
    expect(await readFile(backupPath, "utf8")).toBe(original);
  });

  it("loads legacy plaintext keys and treats malformed DPAPI as empty", async () => {
    const directory = await makeTemporaryDirectory();
    const configPath = path.join(directory, "Undertone", "config.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    const store = new ConfigStore({ configPath, cipher });
    await writeFile(configPath, JSON.stringify({ api_key: "plain-legacy-key" }), "utf8");
    expect((await store.load()).api_key).toBe("plain-legacy-key");
    await writeFile(configPath, JSON.stringify({ api_key: "dpapi:not-a-blob" }), "utf8");
    expect((await store.load()).api_key).toBe("");
  });

  it("moves a legacy config into an existing current data directory", async () => {
    const directory = await makeTemporaryDirectory();
    const legacyPath = path.join(directory, "PushToTalkSTT", "config.json");
    const configPath = path.join(directory, "Undertone", "config.json");
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(legacyPath, JSON.stringify({ language: "fr" }), "utf8");
    const store = new ConfigStore({ configPath, legacyConfigPath: legacyPath, cipher });
    expect((await store.load()).language).toBe("fr");
    expect(await fileExists(configPath)).toBe(true);
    expect(await fileExists(legacyPath)).toBe(false);
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
