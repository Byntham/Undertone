import { isRecord } from "./config";
import { SYSTEM_PROMPT } from "./cleanupPrompt";
import type { HttpClient } from "../platform/http";
import type { CleanupReasoningEffort, CleanupServiceTier } from "./config";

export { SYSTEM_PROMPT } from "./cleanupPrompt";

export const CLEANUP_API_URLS: Readonly<Record<string, string>> = {
  xai: "https://api.x.ai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export const DEFAULT_CLEANUP_MODELS: Readonly<Record<string, string>> = {
  xai: "grok-4.3",
  openai: "gpt-5.6-luna",
  "openai-subscription": "gpt-5.6-luna",
  openrouter: "openai/gpt-5.6-luna",
  local: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
};

const JSON_SCHEMA_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "insertion",
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
  baseUrl(model: string): string | null;
  loadAsync(model: string): void;
}

export interface SubscriptionCleanupRuntime {
  complete(options: {
    model: string;
    reasoningEffort: CleanupReasoningEffort;
    serviceTier: CleanupServiceTier;
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
  }): Promise<string>;
}

export interface CleanupOptions {
  transcript: string;
  context: string | null;
  app: string;
  corrections: Readonly<Record<string, string>>;
  apiKey: string;
  model?: string;
  provider?: string;
  timeoutSeconds?: number;
  reasoningEffort?: CleanupReasoningEffort;
  serviceTier?: CleanupServiceTier;
  systemPrompt?: string;
  throwOnError?: boolean;
}

export class CleanupClient {
  private readonly responseFormats = new Map<string, ResponseFormat>();

  constructor(
    private readonly http: HttpClient,
    private readonly local: LocalCleanupRuntime,
    private readonly subscription: SubscriptionCleanupRuntime | null = null,
  ) {}

  async cleanup(options: CleanupOptions): Promise<string | null> {
    const provider = options.provider ?? "xai";
    const model = options.model ?? "";
    const effectiveModel = model || DEFAULT_CLEANUP_MODELS[provider] || "";
    const user = JSON.stringify({
      text_before_cursor: options.context,
      app: options.app,
      dictionary: options.corrections ?? {},
      transcript: options.transcript,
    });
    if (provider === "openai-subscription") {
      if (this.subscription === null) {
        return failure(options, "OpenAI Subscription cleanup is not available.");
      }
      try {
        const content = await this.subscription.complete({
          model,
          reasoningEffort: options.reasoningEffort ?? "none",
          serviceTier: options.serviceTier ?? "priority",
          systemPrompt: options.systemPrompt || SYSTEM_PROMPT,
          userPrompt: user,
          timeoutMs: Math.max(1, (options.timeoutSeconds ?? 2.5) * 1_000),
        });
        return validateCleanupContent(content, options);
      } catch (error) {
        if (options.throwOnError) {
          if (error instanceof CleanupFailure) throw error;
          throw new CleanupFailure(error instanceof Error ? error.message : "Cleanup request failed.");
        }
        return null;
      }
    }
    let url: string;
    let headers: Readonly<Record<string, string>>;
    if (provider === "local") {
      const baseUrl = this.local.baseUrl(model);
      if (baseUrl === null) {
        this.local.loadAsync(model);
        return null;
      }
      url = `${baseUrl}/v1/chat/completions`;
      headers = { "Content-Type": "application/json" };
    } else {
      const cloudUrl = CLEANUP_API_URLS[provider];
      if (cloudUrl === undefined) {
        return failure(options, `Unsupported cleanup provider: ${provider}`);
      }
      url = cloudUrl;
      headers = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      };
    }

    const formatKey = `${provider}:${effectiveModel}`;
    let responseFormat = this.responseFormats.get(formatKey) ?? "json_schema";
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
    const request = (format: ResponseFormat) => this.http.post(url, {
      headers,
      body: JSON.stringify({
        model: effectiveModel,
        messages: [
          { role: "system", content: options.systemPrompt || SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        response_format: format === "json_schema"
          ? JSON_SCHEMA_RESPONSE_FORMAT
          : JSON_OBJECT_RESPONSE_FORMAT,
        ...modelOptions,
      }),
      timeoutMs: Math.max(1, (options.timeoutSeconds ?? 2.5) * 1_000),
    });

    try {
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
        return failure(options, providerFailure(response.status, response.body));
      }
      const payload = JSON.parse(response.body) as unknown;
      const content = responseContent(payload);
      if (content === null) {
        return failure(options, "Cleanup provider returned no text.");
      }
      if (usedFallback) this.responseFormats.set(formatKey, "json_object");
      return validateCleanupContent(content, options);
    } catch (error) {
      if (provider === "local") this.local.loadAsync(model);
      if (options.throwOnError) {
        if (error instanceof CleanupFailure) throw error;
        throw new CleanupFailure(
          error instanceof SyntaxError
            ? "Cleanup provider returned invalid JSON."
            : error instanceof Error && error.name === "AbortError"
              ? "Cleanup request timed out."
              : "Cleanup request failed.",
        );
      }
      return null;
    }
  }
}

class CleanupFailure extends Error {}

function validateCleanupContent(content: string, options: CleanupOptions): string | null {
  const structured = JSON.parse(content) as unknown;
  if (!isRecord(structured) || typeof structured.text !== "string") {
    return failure(options, "Cleanup provider returned an invalid structured response.");
  }
  const rawText = structured.text.trim();
  if (rawText.length === 0) {
    return failure(options, "Cleanup provider returned empty text.");
  }
  const withoutEcho = dropEchoedContext(rawText, options.context);
  if (withoutEcho === null || !plausibleLength(withoutEcho, options.transcript)) {
    return failure(options, "Cleanup response failed the safety checks.");
  }
  return withoutEcho;
}

function failure(options: CleanupOptions, message: string): null {
  if (options.throwOnError) throw new CleanupFailure(message);
  return null;
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

export function dropEchoedContext(text: string, context: string | null): string | null {
  if (context === null || context.length === 0) return text;
  const tail = Array.from(context.trimEnd());
  const reply = Array.from(text);
  const lowerReply = text.toLowerCase();
  for (let count = tail.length; count >= 4; count -= 1) {
    const suffix = tail.slice(-count).join("");
    if (!lowerReply.startsWith(suffix.toLowerCase())) continue;
    const startsClean = count === tail.length || !isWord(tail[tail.length - count - 1]!);
    const endsClean = count === reply.length || !isWord(reply[count]!);
    if (startsClean && endsClean) {
      const remaining = reply.slice(count).join("").trimStart();
      return remaining.length > 0 ? remaining : null;
    }
  }
  return text;
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

function isWord(character: string): boolean {
  return /[\p{L}\p{M}\p{N}_]/u.test(character);
}
