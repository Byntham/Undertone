import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  KEY_FIELDS,
  cloneConfig,
  isRecord,
  normalizeConfig,
  type UndertoneConfig,
} from "../core/config";

export interface SecretCipher {
  protectSecret(value: string): Promise<string>;
  unprotectSecret(value: string): Promise<string>;
}

export interface ConfigStoreOptions {
  configPath: string;
  legacyConfigPath?: string;
  cipher: SecretCipher;
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly legacyConfigPath: string | undefined;
  private readonly cipher: SecretCipher;

  constructor(options: ConfigStoreOptions) {
    this.configPath = options.configPath;
    this.legacyConfigPath = options.legacyConfigPath;
    this.cipher = options.cipher;
  }

  async load(): Promise<UndertoneConfig> {
    await this.migrateLegacyConfig();
    await mkdir(path.dirname(this.configPath), { recursive: true });
    let parsed: unknown;
    try {
      const text = await readFile(this.configPath, "utf8");
      parsed = JSON.parse(text.replace(/^\ufeff/u, ""));
    } catch {
      parsed = undefined;
    }
    const config = normalizeConfig(parsed);
    for (const field of Object.values(KEY_FIELDS)) {
      const value = config[field];
      if (typeof value === "string") config[field] = await this.cipher.unprotectSecret(value);
    }
    return config;
  }

  async save(config: UndertoneConfig): Promise<void> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    const onDisk = cloneConfig(config);
    for (const field of Object.values(KEY_FIELDS)) {
      const value = onDisk[field];
      if (typeof value === "string" && value.length > 0) {
        onDisk[field] = await this.cipher.protectSecret(value);
      }
    }
    const ordered = sortJson(onDisk);
    const temporary = `${this.configPath}.tmp`;
    await writeFile(temporary, JSON.stringify(ordered, null, 2), "utf8");
    await rename(temporary, this.configPath);
  }

  private async migrateLegacyConfig(): Promise<void> {
    if (this.legacyConfigPath === undefined) return;
    try {
      if (!await exists(this.legacyConfigPath) || await exists(this.configPath)) return;
      const currentDirectory = path.dirname(this.configPath);
      const legacyDirectory = path.dirname(this.legacyConfigPath);
      if (!await exists(currentDirectory)) {
        await rename(legacyDirectory, currentDirectory);
      } else {
        await rename(this.legacyConfigPath, this.configPath);
      }
    } catch {
      // Loading defaults is safer than making startup depend on a legacy move.
    }
  }
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
