import { describe, expect, it } from "vitest";

import {
  CLEANUP_API_URLS,
  CleanupClient,
  plausibleLength,
  type LocalCleanupRuntime,
  type SubscriptionCleanupRuntime,
} from "../src/core/cleanup";
import { SYSTEM_PROMPT } from "../src/core/cleanupPrompt";
import { DEFAULT_CLEANUP_MODELS } from "../src/shared/models";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/platform/http";

class FakeHttp implements HttpClient {
  readonly calls: Array<{ url: string; request: HttpRequest }> = [];
  readonly responses: HttpResponse[] = [];
  response: HttpResponse = cleanupResponse("ok");
  error: Error | undefined;

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    this.calls.push({ url, request });
    if (this.error !== undefined) throw this.error;
    return this.responses.shift() ?? this.response;
  }
}

class FakeLocal implements LocalCleanupRuntime {
  url: string | null = "http://127.0.0.1:9";
  readonly warmed: string[] = [];
  baseUrl(): string | null { return this.url; }
  loadAsync(model: string): void { this.warmed.push(model); }
}

const baseOptions = {
  transcript: "some words",
  corrections: {},
  apiKey: "k",
};

describe("cleanup providers", () => {
  it("uses the dedicated subscription runtime and keeps its token out of cleanup options", async () => {
    const calls: Parameters<SubscriptionCleanupRuntime["complete"]>[0][] = [];
    const subscription: SubscriptionCleanupRuntime = {
      async complete(options) {
        calls.push(options);
        return JSON.stringify({ text: "subscription result" });
      },
    };
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal(), subscription);
    expect(await client.cleanup({
      ...baseOptions,
      apiKey: "",
      provider: "openai-subscription",
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "priority",
    })).toBe("subscription result");
    expect(http.calls).toHaveLength(0);
    expect(calls[0]).toMatchObject({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
  });

  it("uses the production prompt and structured response schema", async () => {
    expect(SYSTEM_PROMPT.startsWith("COPYEDIT ONLY.")).toBe(true);
    expect(SYSTEM_PROMPT).not.toContain("text_before_cursor");
    expect(SYSTEM_PROMPT).toContain("Final audit:");
    expect(SYSTEM_PROMPT).not.toContain("\r");

    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    for (const [provider, url] of Object.entries(CLEANUP_API_URLS)) {
      expect(await client.cleanup({ ...baseOptions, provider })).toBe("ok");
      const call = http.calls.at(-1)!;
      expect(call.url).toBe(url);
      const body = jsonBody(call.request);
      expect(body.model).toBe(
        DEFAULT_CLEANUP_MODELS[provider as keyof typeof DEFAULT_CLEANUP_MODELS],
      );
      expect(body).not.toHaveProperty("temperature");
      expect((body.response_format as Record<string, unknown>).type).toBe("json_schema");
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    }
  });

  it("honors model and timeout while always using the production prompt", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      provider: "openrouter",
      model: "my-model",
      timeoutSeconds: 7.5,
    });
    const request = http.calls[0]!.request;
    expect(request.timeoutMs).toBe(7_500);
    const body = jsonBody(request);
    expect(body.model).toBe("my-model");
    expect((body.messages as Array<Record<string, unknown>>)[0]!.content).toBe(SYSTEM_PROMPT);
  });

  it("applies compatible tuning only to each provider's opinionated cleanup model", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    const tuned = {
      ...baseOptions,
      reasoningEffort: "low" as const,
      serviceTier: "priority" as const,
    };

    await client.cleanup({
      ...tuned,
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(jsonBody(http.calls[0]!.request)).toMatchObject({
      reasoning_effort: "low",
      service_tier: "priority",
    });

    await client.cleanup({
      ...tuned,
      provider: "openrouter",
      model: "openai/gpt-5.6-luna",
    });
    expect(jsonBody(http.calls[1]!.request)).toMatchObject({
      reasoning: { effort: "low" },
      service_tier: "priority",
    });
    expect(jsonBody(http.calls[1]!.request)).not.toHaveProperty("provider");

    await client.cleanup({
      ...tuned,
      provider: "xai",
      model: "grok-4.3",
    });
    expect(jsonBody(http.calls[2]!.request)).toMatchObject({ reasoning_effort: "none" });

    await client.cleanup({
      ...tuned,
      provider: "openai",
      model: "gpt-5.6-terra",
    });
    await client.cleanup({
      ...tuned,
      provider: "openrouter",
      model: "openai/gpt-5.6-terra",
    });
    for (const call of http.calls.slice(3)) {
      const body = jsonBody(call.request);
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("reasoning");
      expect(body).not.toHaveProperty("service_tier");
    }
  });

  it("uses keyless local cleanup and never blocks on a cold model", async () => {
    const http = new FakeHttp();
    const local = new FakeLocal();
    const client = new CleanupClient(http, local);
    expect(await client.cleanup({ ...baseOptions, apiKey: "", provider: "local" })).toBe("ok");
    expect(http.calls[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(http.calls[0]!.request.headers).not.toHaveProperty("Authorization");
    expect(jsonBody(http.calls[0]!.request).model).toBe(DEFAULT_CLEANUP_MODELS.local);
    expect(local.warmed).toEqual([]);

    local.url = null;
    expect(await client.cleanup({
      ...baseOptions,
      apiKey: "",
      provider: "local",
      model: "my.gguf",
    })).toBeNull();
    expect(http.calls).toHaveLength(1);
    expect(local.warmed).toEqual(["my.gguf"]);
  });

  it("returns null for unknown providers, HTTP errors, invalid replies, and exceptions", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    expect(await client.cleanup({ ...baseOptions, provider: "grok9000" })).toBeNull();
    expect(http.calls).toHaveLength(0);
    http.response = { status: 500, body: "error" };
    expect(await client.cleanup({ ...baseOptions, provider: "xai" })).toBeNull();
    http.response = { status: 200, body: "not-json" };
    expect(await client.cleanup({ ...baseOptions, provider: "xai" })).toBeNull();
    http.error = new Error("timeout");
    expect(await client.cleanup({ ...baseOptions, provider: "xai" })).toBeNull();
  });

  it("reports sanitized provider failures when requested", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    http.response = {
      status: 400,
      body: JSON.stringify({ error: { message: "Unsupported parameter: temperature" } }),
    };
    await expect(client.cleanup({
      ...baseOptions,
      provider: "openai",
      throwOnError: true,
    })).rejects.toThrow("Cleanup request rejected (400): Unsupported parameter: temperature");
    expect(http.calls).toHaveLength(1);
  });

  it("falls back to JSON mode and remembers it for that provider model", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    http.responses.push(
      responseFormatFailure("The response_format type json_schema is not supported."),
      cleanupResponse("first result"),
      cleanupResponse("second result"),
    );

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openai",
      model: "compatibility-model",
    })).toBe("first result");
    expect(http.calls).toHaveLength(2);
    expect(responseFormat(http.calls[0]!.request)).toBe("json_schema");
    expect(responseFormat(http.calls[1]!.request)).toBe("json_object");

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openai",
      model: "compatibility-model",
    })).toBe("second result");
    expect(responseFormat(http.calls[2]!.request)).toBe("json_object");

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openai",
      model: "different-model",
    })).toBe("ok");
    expect(responseFormat(http.calls[3]!.request)).toBe("json_schema");
  });

  it("reports the fallback rejection and only remembers successful fallbacks", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    http.responses.push(
      responseFormatFailure("The response format json_schema is unsupported."),
      responseFormatFailure("JSON object output is not supported for this model."),
    );

    await expect(client.cleanup({
      ...baseOptions,
      provider: "openrouter",
      model: "incompatible-model",
      throwOnError: true,
    })).rejects.toThrow(
      "Cleanup request rejected (400): JSON object output is not supported for this model.",
    );
    expect(http.calls.map(({ request }) => responseFormat(request)))
      .toEqual(["json_schema", "json_object"]);

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openrouter",
      model: "incompatible-model",
    })).toBe("ok");
    expect(responseFormat(http.calls[2]!.request)).toBe("json_schema");
  });

  it("sends only turn data and rejects implausible expansion", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      transcript: "hello",
      corrections: { "under tone": "Undertone" },
      provider: "xai",
    });
    const messages = jsonBody(http.calls[0]!.request).messages as Array<Record<string, unknown>>;
    expect(JSON.parse(messages[1]!.content as string)).toEqual({
      dictionary: { "under tone": "Undertone" },
      transcript: "hello",
    });
    expect(plausibleLength("A short cleaned reply.", "some words")).toBe(true);
    expect(plausibleLength("x".repeat(100), "tiny")).toBe(false);

    http.response = cleanupResponse("x".repeat(100));
    expect(await client.cleanup({ ...baseOptions, transcript: "tiny", provider: "xai" }))
      .toBeNull();
  });
});

function cleanupResponse(text: string): HttpResponse {
  return {
    status: 200,
    body: JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ text }) } }],
    }),
  };
}

function responseFormatFailure(message: string): HttpResponse {
  return {
    status: 400,
    body: JSON.stringify({ error: { message } }),
  };
}

function responseFormat(request: HttpRequest): unknown {
  const format = jsonBody(request).response_format as Record<string, unknown>;
  return format.type;
}

function jsonBody(request: HttpRequest): Record<string, unknown> {
  expect(typeof request.body).toBe("string");
  return JSON.parse(request.body as string) as Record<string, unknown>;
}
