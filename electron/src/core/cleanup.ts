import { isRecord } from "./config";
import { SYSTEM_PROMPT } from "./cleanupPrompt";
import type { HttpClient } from "../platform/http";
import type { CleanupReasoningEffort, CleanupServiceTier } from "./config";
import type { CleanupProviderId, CloudProviderId } from "../shared/settings";
import { DEFAULT_CLEANUP_MODELS } from "../shared/models";

export const CLEANUP_API_URLS: Readonly<Record<CloudProviderId, string>> = {
  xai: "https://api.x.ai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

const JSON_SCHEMA_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "cleanup",
    strict: true,
    schema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  },
} as const;

const JSON_OBJECT_RESPONSE_FORMAT = { type: "json_object" } as const;

type ResponseFormat = "json_schema" | "json_object";

export interface LocalCleanupRuntime {
  withServer<T>(
    policy: "fallback",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T | null>;
  warm(): void;
}

export interface SubscriptionCleanupRuntime {
  complete(options: {
    reasoningEffort: CleanupReasoningEffort;
    serviceTier: CleanupServiceTier;
    userPrompt: string;
    timeoutMs: number;
  }): Promise<string>;
}

export interface CleanupOptions {
  transcript: string;
  apiKey: string;
  provider: CleanupProviderId;
  timeoutSeconds?: number;
  reasoningEffort?: CleanupReasoningEffort;
  serviceTier?: CleanupServiceTier;
}

/** A safe, user-facing cleanup failure. `null` is reserved for a cold local model. */
export class CleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CleanupError";
  }
}

export class CleanupClient {
  private readonly responseFormats = new Map<string, ResponseFormat>();

  constructor(
    private readonly http: HttpClient,
    private readonly local: LocalCleanupRuntime,
    private readonly subscription: SubscriptionCleanupRuntime | null = null,
  ) {}

  async cleanup(options: CleanupOptions): Promise<string | null> {
    const provider = options.provider;
    const effectiveModel = DEFAULT_CLEANUP_MODELS[provider];
    const user = JSON.stringify({ transcript: options.transcript });
    if (provider === "openai-subscription") {
      if (this.subscription === null) {
        throw new CleanupError("OpenAI Subscription cleanup is not available.");
      }
      try {
        const content = await this.subscription.complete({
          reasoningEffort: options.reasoningEffort ?? "none",
          serviceTier: options.serviceTier ?? "priority",
          userPrompt: user,
          timeoutMs: Math.max(1, (options.timeoutSeconds ?? 2.5) * 1_000),
        });
        return validateCleanupContent(content, options.transcript);
      } catch (error) {
        throw cleanupError(error);
      }
    }
    const formatKey = `${provider}:${effectiveModel}`;
    const modelOptions = provider === "openai" && effectiveModel === "gpt-5.6-luna"
      ? {
          reasoning_effort: options.reasoningEffort ?? "none",
          service_tier: options.serviceTier ?? "priority",
        }
      : provider === "openrouter" && effectiveModel === "openai/gpt-5.6-luna"
        ? {
            reasoning: { effort: options.reasoningEffort ?? "none" },
            service_tier: options.serviceTier ?? "priority",
          }
        : provider === "xai" && effectiveModel === "grok-4.3"
          ? { reasoning_effort: "none" }
          : {};
    const requestCleanup = async (
      url: string,
      headers: Readonly<Record<string, string>>,
    ): Promise<string | null> => {
      let responseFormat = this.responseFormats.get(formatKey) ?? "json_schema";
      const request = (format: ResponseFormat) => this.http.post(url, {
        headers,
        body: JSON.stringify({
          model: effectiveModel,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: user },
          ],
          response_format: format === "json_schema"
            ? JSON_SCHEMA_RESPONSE_FORMAT
            : JSON_OBJECT_RESPONSE_FORMAT,
          ...modelOptions,
        }),
        timeoutMs: Math.max(1, (options.timeoutSeconds ?? 2.5) * 1_000),
      });

      let response = await request(responseFormat);
      let usedFallback = false;
      if (responseFormat === "json_schema" && rejectsResponseFormat(response)) {
        responseFormat = "json_object";
        response = await request(responseFormat);
        usedFallback = true;
      }
      if (response.status !== 200) {
        if (responseFormat === "json_object" && rejectsResponseFormat(response)) {
          this.responseFormats.delete(formatKey);
        }
        throw new CleanupError(providerFailure(response.status, response.body));
      }
      const payload = JSON.parse(response.body) as unknown;
      const content = responseContent(payload);
      if (content === null) {
        throw new CleanupError("Cleanup provider returned no text.");
      }
      if (usedFallback) this.responseFormats.set(formatKey, "json_object");
      return validateCleanupContent(content, options.transcript);
    };

    try {
      if (provider === "local") {
        return await this.local.withServer("fallback", async (baseUrl) =>
          await requestCleanup(`${baseUrl}/v1/chat/completions`, {
            "Content-Type": "application/json",
          }));
      }
      const url = provider === "xai" || provider === "openai" || provider === "openrouter"
        ? CLEANUP_API_URLS[provider]
        : undefined;
      if (url === undefined) {
        throw new CleanupError(`Unsupported cleanup provider: ${provider}`);
      }
      return await requestCleanup(url, {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      });
    } catch (error) {
      if (provider === "local") this.local.warm();
      throw cleanupError(error);
    }
  }
}

function validateCleanupContent(content: string, transcript: string): string {
  const structured = JSON.parse(content) as unknown;
  if (!isRecord(structured) || typeof structured.text !== "string") {
    throw new CleanupError("Cleanup provider returned an invalid structured response.");
  }
  const rawText = structured.text.trim();
  if (rawText.length === 0) {
    throw new CleanupError("Cleanup provider returned empty text.");
  }
  if (!plausibleLength(rawText, transcript)) {
    throw new CleanupError("Cleanup response failed the safety checks.");
  }
  return rawText;
}

function cleanupError(error: unknown): CleanupError {
  if (error instanceof CleanupError) return error;
  if (error instanceof SyntaxError) {
    return new CleanupError("Cleanup provider returned invalid JSON.");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new CleanupError("Cleanup request timed out.");
  }
  return new CleanupError("Cleanup request failed.");
}

function providerFailure(status: number, body: string): string {
  const detail = providerErrorDetail(body);
  return detail.length > 0
    ? `Cleanup request rejected (${status}): ${detail}`
    : `Cleanup request rejected (${status}).`;
}

function providerErrorDetail(body: string): string {
  let detail = "";
  try {
    const payload = JSON.parse(body) as unknown;
    if (isRecord(payload) && isRecord(payload.error)
      && typeof payload.error.message === "string") {
      detail = payload.error.message;
    }
  } catch {
    return "";
  }
  return detail.replace(/\s+/gu, " ").trim().slice(0, 300);
}

function rejectsResponseFormat(response: { status: number; body: string }): boolean {
  if (response.status !== 400 && response.status !== 422) return false;
  const detail = providerErrorDetail(response.body).toLowerCase();
  return detail.includes("response_format")
    || detail.includes("response format")
    || detail.includes("json_schema")
    || detail.includes("json schema")
    || detail.includes("json_object")
    || detail.includes("json object")
    || detail.includes("structured output");
}

export function plausibleLength(cleaned: string, transcript: string): boolean {
  return Array.from(cleaned).length <= Array.from(transcript).length * 1.5 + 30;
}

function responseContent(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const choice = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  return typeof choice.message.content === "string" ? choice.message.content : null;
}
