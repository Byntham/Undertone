import { describe, expect, it } from "vitest";

import {
  CLEANUP_API_URLS,
  CleanupClient,
  CleanupError,
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
  warmCount = 0;
  async withServer<T>(
    _policy: "fallback",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T | null> {
    if (this.url === null) {
      this.warm();
      return null;
    }
    return await callback(this.url);
  }
  warm(): void { this.warmCount += 1; }
}

const baseOptions = {
  transcript: "some words",
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
      reasoningEffort: "high",
      serviceTier: "priority",
    })).toBe("subscription result");
    expect(http.calls).toHaveLength(0);
    expect(calls[0]).toMatchObject({
      reasoningEffort: "high",
      serviceTier: "priority",
      userPrompt: JSON.stringify({ transcript: "some words" }),
    });
  });

  it("uses the production prompt and structured response schema", async () => {
    expect(SYSTEM_PROMPT).not.toContain("text_before_cursor");

    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    for (const provider of ["xai", "openai", "openrouter"] as const) {
      const url = CLEANUP_API_URLS[provider];
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

  it("honors the configured timeout", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      provider: "openrouter",
      timeoutSeconds: 7.5,
    });
    const request = http.calls[0]!.request;
    expect(request.timeoutMs).toBe(7_500);
  });

  it("preserves safe subscription recovery instructions and sanitizes other failures", async () => {
    let message = "OpenAI Subscription cleanup was not authorized. Reconnect your OpenAI account.";
    const subscription: SubscriptionCleanupRuntime = {
      async complete() { throw new Error(message); },
    };
    const client = new CleanupClient(new FakeHttp(), new FakeLocal(), subscription);
    const options = { ...baseOptions, provider: "openai-subscription" as const };

    await expect(client.cleanup(options)).rejects.toThrow(message);
    message = "secret-token-must-not-leak";
    await expect(client.cleanup(options)).rejects.toThrow("Cleanup request failed.");
  });

  it("applies compatible tuning to each fixed cleanup model", async () => {
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
    });
    expect(jsonBody(http.calls[0]!.request)).toMatchObject({
      reasoning_effort: "low",
      service_tier: "priority",
    });

    await client.cleanup({
      ...tuned,
      provider: "openrouter",
    });
    expect(jsonBody(http.calls[1]!.request)).toMatchObject({
      reasoning: { effort: "low" },
      service_tier: "priority",
    });
    expect(jsonBody(http.calls[1]!.request)).not.toHaveProperty("provider");

    await client.cleanup({
      ...tuned,
      provider: "xai",
    });
    expect(jsonBody(http.calls[2]!.request)).toMatchObject({ reasoning_effort: "none" });

  });

  it("uses keyless local cleanup and never blocks on a cold model", async () => {
    const http = new FakeHttp();
    const local = new FakeLocal();
    const client = new CleanupClient(http, local);
    expect(await client.cleanup({ ...baseOptions, apiKey: "", provider: "local" })).toBe("ok");
    expect(http.calls[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(http.calls[0]!.request.headers).not.toHaveProperty("Authorization");
    expect(jsonBody(http.calls[0]!.request).model).toBe(DEFAULT_CLEANUP_MODELS.local);
    expect(local.warmCount).toBe(0);

    local.url = null;
    expect(await client.cleanup({
      ...baseOptions,
      apiKey: "",
      provider: "local",
    })).toBeNull();
    expect(http.calls).toHaveLength(1);
    expect(local.warmCount).toBe(1);
  });

  it("throws sanitized errors for HTTP errors, invalid replies, and exceptions", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    http.response = { status: 500, body: "error" };
    await expect(client.cleanup({ ...baseOptions, provider: "xai" }))
      .rejects.toThrow(new CleanupError("Cleanup request rejected (500)."));
    http.response = { status: 200, body: "not-json" };
    await expect(client.cleanup({ ...baseOptions, provider: "xai" }))
      .rejects.toThrow(new CleanupError("Cleanup provider returned invalid JSON."));
    http.error = new Error("secret-token-must-not-leak");
    await expect(client.cleanup({ ...baseOptions, provider: "xai" }))
      .rejects.toThrow(new CleanupError("Cleanup request failed."));
  });

  it("reports sanitized provider failures", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    http.response = {
      status: 400,
      body: JSON.stringify({ error: { message: "Unsupported parameter: temperature" } }),
    };
    await expect(client.cleanup({
      ...baseOptions,
      provider: "openai",
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
    })).toBe("first result");
    expect(http.calls).toHaveLength(2);
    expect(responseFormat(http.calls[0]!.request)).toBe("json_schema");
    expect(responseFormat(http.calls[1]!.request)).toBe("json_object");

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openai",
    })).toBe("second result");
    expect(responseFormat(http.calls[2]!.request)).toBe("json_object");

    expect(await client.cleanup({
      ...baseOptions,
      provider: "openrouter",
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
    })).rejects.toThrow(
      "Cleanup request rejected (400): JSON object output is not supported for this model.",
    );
    expect(http.calls.map(({ request }) => responseFormat(request)))
      .toEqual(["json_schema", "json_object"]);

    expect(await client.cleanup({ ...baseOptions, provider: "openrouter" })).toBe("ok");
    expect(responseFormat(http.calls[2]!.request)).toBe("json_schema");
  });

  it("sends only the transcript and rejects implausible expansion", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      transcript: "hello",
      provider: "xai",
    });
    const messages = jsonBody(http.calls[0]!.request).messages as Array<Record<string, unknown>>;
    expect(JSON.parse(messages[1]!.content as string)).toEqual({ transcript: "hello" });
    expect(SYSTEM_PROMPT).not.toContain("dictionary");
    expect(plausibleLength("A short cleaned reply.", "some words")).toBe(true);
    expect(plausibleLength("x".repeat(100), "tiny")).toBe(false);

    http.response = cleanupResponse("x".repeat(100));
    await expect(client.cleanup({ ...baseOptions, transcript: "tiny", provider: "xai" }))
      .rejects.toThrow("Cleanup response failed the safety checks.");
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
