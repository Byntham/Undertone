import { isRecord } from "./config";
import { SYSTEM_PROMPT } from "./cleanupPrompt";
import type { HttpClient } from "../platform/http";

export { SYSTEM_PROMPT } from "./cleanupPrompt";

export const CLEANUP_API_URLS: Readonly<Record<string, string>> = {
  xai: "https://api.x.ai/v1/chat/completions",
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

export const DEFAULT_CLEANUP_MODELS: Readonly<Record<string, string>> = {
  xai: "grok-4.20-0309-non-reasoning",
  openai: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
  local: "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
};

const RESPONSE_FORMAT = {
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

export interface LocalCleanupRuntime {
  baseUrl(model: string): string | null;
  loadAsync(model: string): void;
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
  systemPrompt?: string;
}

export class CleanupClient {
  constructor(
    private readonly http: HttpClient,
    private readonly local: LocalCleanupRuntime,
  ) {}

  async cleanup(options: CleanupOptions): Promise<string | null> {
    const provider = options.provider ?? "xai";
    const model = options.model ?? "";
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
      if (cloudUrl === undefined) return null;
      url = cloudUrl;
      headers = {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      };
    }

    const user = JSON.stringify({
      text_before_cursor: options.context,
      app: options.app,
      dictionary: options.corrections ?? {},
      transcript: options.transcript,
    });
    const body = JSON.stringify({
      model: model || DEFAULT_CLEANUP_MODELS[provider] || "",
      temperature: 0,
      messages: [
        { role: "system", content: options.systemPrompt || SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      response_format: RESPONSE_FORMAT,
    });

    try {
      const response = await this.http.post(url, {
        headers,
        body,
        timeoutMs: Math.max(1, (options.timeoutSeconds ?? 2.5) * 1_000),
      });
      if (response.status !== 200) return null;
      const payload = JSON.parse(response.body) as unknown;
      const content = responseContent(payload);
      if (content === null) return null;
      const structured = JSON.parse(content) as unknown;
      if (!isRecord(structured) || typeof structured.text !== "string") return null;
      const rawText = structured.text.trim();
      if (rawText.length === 0) return null;
      const withoutEcho = dropEchoedContext(rawText, options.context);
      if (withoutEcho === null || !plausibleLength(withoutEcho, options.transcript)) {
        return null;
      }
      return withoutEcho;
    } catch {
      if (provider === "local") this.local.loadAsync(model);
      return null;
    }
  }
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
