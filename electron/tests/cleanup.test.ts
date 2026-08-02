import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CLEANUP_API_URLS,
  CleanupClient,
  DEFAULT_CLEANUP_MODELS,
  SYSTEM_PROMPT,
  dropEchoedContext,
  plausibleLength,
  type LocalCleanupRuntime,
} from "../src/core/cleanup";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/platform/http";

class FakeHttp implements HttpClient {
  readonly calls: Array<{ url: string; request: HttpRequest }> = [];
  response: HttpResponse = cleanupResponse("ok");
  error: Error | undefined;

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    this.calls.push({ url, request });
    if (this.error !== undefined) throw this.error;
    return this.response;
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
  context: null,
  app: "",
  corrections: {},
  apiKey: "k",
};

describe("cleanup providers", () => {
  it("keeps the cleanup prompt byte-for-byte equivalent across runtimes", async () => {
    const source = await readFile(
      path.resolve(__dirname, "../../cleanup.py"),
      "utf8",
    );
    const match = /SYSTEM_PROMPT = """\\\r?\n([\s\S]*?)"""\r?\n\r?\n_RESPONSE_FORMAT/u
      .exec(source);
    expect(match).not.toBeNull();
    expect(SYSTEM_PROMPT).toBe(match![1]!.replaceAll("\r\n", "\n"));
  });

  it("uses the exact migrated prompt and structured response schema", async () => {
    expect(SYSTEM_PROMPT.startsWith("COPYEDIT ONLY.")).toBe(true);
    expect(SYSTEM_PROMPT).toContain("text_before_cursor");
    expect(SYSTEM_PROMPT).toContain("Final audit:");
    expect(SYSTEM_PROMPT).not.toContain("\r");

    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    for (const [provider, url] of Object.entries(CLEANUP_API_URLS)) {
      expect(await client.cleanup({ ...baseOptions, provider })).toBe("ok");
      const call = http.calls.at(-1)!;
      expect(call.url).toBe(url);
      const body = jsonBody(call.request);
      expect(body.model).toBe(DEFAULT_CLEANUP_MODELS[provider]);
      expect(body.temperature).toBe(0);
      expect((body.response_format as Record<string, unknown>).type).toBe("json_schema");
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages[0]!.content).toBe(SYSTEM_PROMPT);
    }
  });

  it("honors model, timeout, and developer prompt overrides", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      provider: "openrouter",
      model: "my-model",
      timeoutSeconds: 7.5,
      systemPrompt: "Be terse.",
    });
    const request = http.calls[0]!.request;
    expect(request.timeoutMs).toBe(7_500);
    const body = jsonBody(request);
    expect(body.model).toBe("my-model");
    expect((body.messages as Array<Record<string, unknown>>)[0]!.content).toBe("Be terse.");
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

  it("sends context as quoted data and rejects echoes or implausible expansion", async () => {
    const http = new FakeHttp();
    const client = new CleanupClient(http, new FakeLocal());
    await client.cleanup({
      ...baseOptions,
      transcript: "hello",
      context: "I already said ",
      app: "slack.exe (Chat)",
      corrections: { "under tone": "Undertone" },
      provider: "xai",
    });
    const messages = jsonBody(http.calls[0]!.request).messages as Array<Record<string, unknown>>;
    expect(JSON.parse(messages[1]!.content as string)).toEqual({
      text_before_cursor: "I already said ",
      app: "slack.exe (Chat)",
      dictionary: { "under tone": "Undertone" },
      transcript: "hello",
    });

    expect(dropEchoedContext("I already said hello.", "I already said ")).toBe("hello.");
    expect(dropEchoedContext("table works", "notable")).toBe("table works");
    expect(dropEchoedContext("I already said", "I already said ")).toBeNull();
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

function jsonBody(request: HttpRequest): Record<string, unknown> {
  expect(typeof request.body).toBe("string");
  return JSON.parse(request.body as string) as Record<string, unknown>;
}
