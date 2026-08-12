import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SECRET_FIELDS,
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
  cipher: SecretCipher;
  onWarning?: (message: string) => void;
}

export class ConfigStore {
  private readonly configPath: string;
  private readonly cipher: SecretCipher;
  private readonly onWarning: (message: string) => void;

  constructor(options: ConfigStoreOptions) {
    this.configPath = options.configPath;
    this.cipher = options.cipher;
    this.onWarning = options.onWarning ?? ((message) => { console.warn(message); });
  }

  async load(): Promise<UndertoneConfig> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    let text: string;
    try {
      text = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return normalizeConfig(undefined);
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const recoveryPath = `${this.configPath}.corrupt-${fileTimestamp(new Date())}`;
      await rename(this.configPath, recoveryPath);
      this.onWarning(`Invalid config moved to ${recoveryPath}`);
      parsed = undefined;
    }
    const config = normalizeConfig(parsed);
    for (const field of SECRET_FIELDS) {
      const value = config[field];
      if (typeof value === "string") config[field] = await this.cipher.unprotectSecret(value);
    }
    return config;
  }

  async save(config: UndertoneConfig): Promise<void> {
    await mkdir(path.dirname(this.configPath), { recursive: true });
    const onDisk = cloneConfig(config);
    for (const field of SECRET_FIELDS) {
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
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function fileTimestamp(date: Date): string {
  return date.toISOString().replaceAll(":", "-");
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
