import { describe, expect, it } from "vitest";

import {
  OpenAiSubscription,
  accountIdFromAccessToken,
  parseResponseText,
  type OpenAiSubscriptionCredentials,
} from "../src/main/openAiSubscription";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
} from "../src/platform/http";

class FakeHttp implements HttpClient {
  readonly posts: Array<{ url: string; request: HttpRequest }> = [];
  readonly postResponses: HttpResponse[] = [];

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    this.posts.push({ url, request });
    const response = this.postResponses.shift();
    if (response === undefined) throw new Error("No fake POST response configured");
    return response;
  }
}

describe("OpenAI Subscription", () => {
  it("extracts the account identity and parses streamed response text", () => {
    const token = jwt("account-123");
    expect(accountIdFromAccessToken(token)).toBe("account-123");
    expect(accountIdFromAccessToken("not-a-jwt")).toBeNull();
    expect(parseResponseText([
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "{\"text\":\"" })}`,
      `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "done\"}" })}`,
      `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
      "data: [DONE]",
    ].join("\n\n"))).toBe('{"text":"done"}');
  });

  it("refreshes expired credentials and uses Luna when no override is configured", async () => {
    const http = new FakeHttp();
    http.postResponses.push(tokenResponse("new-account", "new-access", "new-refresh"), {
      status: 200,
      body: `data: ${JSON.stringify({ type: "response.output_text.done", text: '{"text":"clean"}' })}`,
    });
    const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
    const subscription = createSubscription(http, expiredCredentials(), persisted);
    await subscription.complete({
      model: "",
      reasoningEffort: "none",
      serviceTier: "priority",
      systemPrompt: "Copyedit only.",
      userPrompt: "raw",
      timeoutMs: 2_500,
    });
    expect(persisted[0]).toMatchObject({ refreshToken: "new-refresh", accountId: "new-account" });
    expect(http.posts[0]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(http.posts[1]?.request.headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer "),
      "ChatGPT-Account-ID": "new-account",
    });
    expect(JSON.parse(http.posts[1]!.request.body as string)).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "none" },
      service_tier: "priority",
    });
  });

  it("sends a direct structured Responses request and disconnects locally", async () => {
    const http = new FakeHttp();
    http.postResponses.push({
      status: 200,
      body: [
        `data: ${JSON.stringify({ type: "response.output_text.done", text: '{"text":"clean"}' })}`,
        `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`,
      ].join("\n\n"),
    });
    const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
    const subscription = createSubscription(http, validCredentials(), persisted);
    expect(await subscription.complete({
      model: "gpt-5.6-luna",
      reasoningEffort: "high",
      serviceTier: "priority",
      systemPrompt: "Copyedit only.",
      userPrompt: "raw",
      timeoutMs: 2_500,
    })).toBe('{"text":"clean"}');
    const call = http.posts[0]!;
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(call.request.headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer "),
      "ChatGPT-Account-ID": "account-123",
      originator: "undertone",
    });
    const body = JSON.parse(call.request.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "gpt-5.6-luna",
      reasoning: { effort: "high" },
      service_tier: "priority",
      store: false,
      stream: true,
    });
    expect(body).not.toHaveProperty("metadata");

    await subscription.disconnect();
    expect(subscription.connected()).toBe(false);
    expect(persisted.at(-1)).toBeNull();
  });

  it("does not apply Luna request tuning to another subscription model", async () => {
    const http = new FakeHttp();
    http.postResponses.push({
      status: 200,
      body: `data: ${JSON.stringify({ type: "response.output_text.done", text: '{"text":"clean"}' })}`,
    });
    const subscription = createSubscription(http, validCredentials(), []);
    await subscription.complete({
      model: "gpt-5.6-terra",
      reasoningEffort: "max",
      serviceTier: "priority",
      systemPrompt: "Copyedit only.",
      userPrompt: "raw",
      timeoutMs: 2_500,
    });
    const body = JSON.parse(http.posts[0]!.request.body as string) as Record<string, unknown>;
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("service_tier");
  });
});

function createSubscription(
  http: FakeHttp,
  credentials: OpenAiSubscriptionCredentials,
  persisted: Array<OpenAiSubscriptionCredentials | null>,
): OpenAiSubscription {
  return new OpenAiSubscription({
    http,
    credentials,
    async persist(value) { persisted.push(value); },
    async openExternal() {},
    appVersion: "1.8.0",
    now: () => 1_000_000,
  });
}

function expiredCredentials(): OpenAiSubscriptionCredentials {
  return { ...validCredentials(), expiresAt: 999_999 };
}

function validCredentials(): OpenAiSubscriptionCredentials {
  return {
    accessToken: jwt("account-123"),
    refreshToken: "refresh",
    expiresAt: 2_000_000,
    accountId: "account-123",
  };
}

function tokenResponse(accountId: string, _label: string, refreshToken: string): HttpResponse {
  return {
    status: 200,
    body: JSON.stringify({
      access_token: jwt(accountId),
      refresh_token: refreshToken,
      expires_in: 3_600,
    }),
  };
}

function jwt(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).toString("base64url");
  return `header.${payload}.signature`;
}
