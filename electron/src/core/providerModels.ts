import { DEFAULT_CLEANUP_MODELS } from "./cleanup";
import { DEFAULT_STT_MODELS } from "./transcriber";
import { isRecord } from "./config";
import type { HttpGetClient, HttpResponse } from "../platform/http";
import type {
  CloudProviderId,
  ProviderModelCatalogSnapshot,
  ProviderModelKind,
  ProviderModelOption,
} from "../shared/settings";

const MODEL_TIMEOUT_MS = 15_000;
const MODEL_CACHE_MS = 15 * 60 * 1_000;
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const XAI_LANGUAGE_MODELS_URL = "https://api.x.ai/v1/language-models";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_USER_MODELS_URL = "https://openrouter.ai/api/v1/models/user";

interface CacheEntry {
  expiresAt: number;
  snapshot: ProviderModelCatalogSnapshot;
}

export class ProviderModelCatalog {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<ProviderModelCatalogSnapshot>>();

  constructor(
    private readonly http: HttpGetClient,
    private readonly now: () => number = Date.now,
  ) {}

  async list(
    provider: CloudProviderId,
    kind: ProviderModelKind,
    apiKey: string,
    refresh = false,
  ): Promise<ProviderModelCatalogSnapshot> {
    if (provider === "xai" && kind === "stt") {
      return snapshot(provider, kind, false, []);
    }
    if (apiKey.trim().length === 0) {
      throw new Error(`Save the ${providerName(provider)} API key to load models.`);
    }
    const cacheKey = `${provider}:${kind}`;
    if (!refresh) {
      const cached = this.cache.get(cacheKey);
      if (cached !== undefined && cached.expiresAt > this.now()) return cached.snapshot;
      const inFlight = this.pending.get(cacheKey);
      if (inFlight !== undefined) return await inFlight;
    }
    const operation = this.fetch(provider, kind, apiKey)
      .then((result) => {
        this.cache.set(cacheKey, { expiresAt: this.now() + MODEL_CACHE_MS, snapshot: result });
        return result;
      })
      .finally(() => this.pending.delete(cacheKey));
    this.pending.set(cacheKey, operation);
    return await operation;
  }

  clear(provider: CloudProviderId): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${provider}:`)) this.cache.delete(key);
    }
  }

  private async fetch(
    provider: CloudProviderId,
    kind: ProviderModelKind,
    apiKey: string,
  ): Promise<ProviderModelCatalogSnapshot> {
    const url = modelUrl(provider, kind);
    let response: HttpResponse;
    try {
      response = await this.http.get(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: MODEL_TIMEOUT_MS,
      });
    } catch (error) {
      throw new Error(`Could not load ${providerName(provider)} models. ${errorMessage(error)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`${providerName(provider)} rejected the saved API key while loading models.`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`${providerName(provider)} model discovery failed (HTTP ${response.status}).`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.body) as unknown;
    } catch {
      throw new Error(`${providerName(provider)} returned an invalid model list.`);
    }
    return snapshot(provider, kind, true, parseModels(provider, kind, payload));
  }
}

function modelUrl(provider: CloudProviderId, kind: ProviderModelKind): string {
  if (provider === "openai") return OPENAI_MODELS_URL;
  if (provider === "xai") return XAI_LANGUAGE_MODELS_URL;
  return kind === "stt"
    ? `${OPENROUTER_MODELS_URL}?output_modalities=transcription`
    : OPENROUTER_USER_MODELS_URL;
}

function parseModels(
  provider: CloudProviderId,
  kind: ProviderModelKind,
  payload: unknown,
): ProviderModelOption[] {
  const entries = provider === "xai"
    ? isRecord(payload) && Array.isArray(payload.models) ? payload.models : null
    : isRecord(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (entries === null) throw new Error(`${providerName(provider)} returned an invalid model list.`);
  const models: ProviderModelOption[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    if (!supportsKind(provider, kind, entry)) continue;
    models.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name.trim().length > 0
        ? entry.name.trim()
        : entry.id,
    });
    if (provider === "xai" && Array.isArray(entry.aliases)) {
      for (const alias of entry.aliases) {
        if (typeof alias === "string" && alias.trim().length > 0) {
          models.push({ id: alias, name: alias });
        }
      }
    }
  }
  const unique = new Map(models.map((model) => [model.id, model]));
  return [...unique.values()].sort((left, right) => (
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  ));
}

function supportsKind(
  provider: CloudProviderId,
  kind: ProviderModelKind,
  model: Record<string, unknown>,
): boolean {
  if (provider === "xai") return kind === "cleanup";
  if (provider === "openai") {
    const id = String(model.id).toLowerCase();
    if (kind === "stt") return id === "whisper-1" || id.includes("transcribe");
    return true;
  }
  const architecture = isRecord(model.architecture) ? model.architecture : {};
  const inputs = stringArray(architecture.input_modalities);
  const outputs = stringArray(architecture.output_modalities);
  if (kind === "stt") return outputs.includes("transcription");
  const parameters = stringArray(model.supported_parameters);
  return inputs.includes("text")
    && outputs.includes("text")
    && (parameters.includes("response_format") || parameters.includes("structured_outputs"));
}

function snapshot(
  provider: CloudProviderId,
  kind: ProviderModelKind,
  selectable: boolean,
  models: ProviderModelOption[],
): ProviderModelCatalogSnapshot {
  const defaults = kind === "stt" ? DEFAULT_STT_MODELS : DEFAULT_CLEANUP_MODELS;
  return {
    provider,
    kind,
    selectable,
    defaultModel: selectable ? defaults[provider] || null : null,
    models,
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function providerName(provider: CloudProviderId): string {
  return provider === "xai" ? "xAI" : provider === "openai" ? "OpenAI" : "OpenRouter";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
