import { describe, expect, it, vi } from "vitest";

import { SYSTEM_PROMPT } from "../src/core/cleanupPrompt";
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
  readonly postResponses: Array<HttpResponse | Promise<HttpResponse>> = [];

  async post(url: string, request: HttpRequest): Promise<HttpResponse> {
    this.posts.push({ url, request });
    const response = this.postResponses.shift();
    if (response === undefined) throw new Error("No fake POST response configured");
    return await response;
  }
}

describe("OpenAI Subscription", () => {
  it("ignores other local routes and rejects ambiguous callbacks", async () => {
    const subscription = createSubscription(new FakeHttp(), null, [], async (authorizationUrl) => {
      const state = new URL(authorizationUrl).searchParams.get("state");
      expect((await fetch("http://localhost:1455/not-the-callback")).status).toBe(404);
      await fetch(
        `http://localhost:1455/auth/callback?state=${encodeURIComponent(state ?? "")}&code=one&code=two`,
      );
    });
    await expect(subscription.connect()).rejects.toThrow("callback was ambiguous");
  });

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

  it("refreshes expired credentials before completing", async () => {
    const http = new FakeHttp();
    http.postResponses.push(tokenResponse("new-account", "new-refresh"), {
      status: 200,
      body: `data: ${JSON.stringify({ type: "response.output_text.done", text: '{"text":"clean"}' })}`,
    });
    const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
    const subscription = createSubscription(http, expiredCredentials(), persisted);
    await subscription.complete({
      reasoningEffort: "none",
      serviceTier: "priority",
      userPrompt: "raw",
      timeoutMs: 2_500,
    });
    expect(persisted[0]).toMatchObject({ refreshToken: "new-refresh", accountId: "new-account" });
    expect(http.posts[0]?.url).toBe("https://auth.openai.com/oauth/token");
    expect(http.posts[1]?.request.headers).toMatchObject({
      Authorization: expect.stringContaining("Bearer "),
      "ChatGPT-Account-ID": "new-account",
    });
  });

  it("does not let an in-flight refresh undo disconnect or disposal", async () => {
    for (const invalidate of ["disconnect", "dispose"] as const) {
      const http = new FakeHttp();
      const token = deferred<HttpResponse>();
      http.postResponses.push(token.promise);
      const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
      const subscription = createSubscription(http, expiredCredentials(), persisted);
      const completion = subscription.complete(completionOptions());
      expect(http.posts).toHaveLength(1);

      if (invalidate === "disconnect") await subscription.disconnect();
      else subscription.dispose();
      token.resolve(tokenResponse("stale", "stale-refresh"));

      await expect(completion).rejects.toThrow("superseded by another account action");
      expect(persisted).toEqual(invalidate === "disconnect" ? [null] : []);
      expect(subscription.connected()).toBe(invalidate === "dispose");
    }
  });

  it("does not let an in-flight refresh overwrite a replacement sign-in", async () => {
    const http = new FakeHttp();
    const staleToken = deferred<HttpResponse>();
    http.postResponses.push(
      staleToken.promise,
      tokenResponse("replacement", "replacement-refresh"),
    );
    const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
    const subscription = createSubscription(
      http,
      expiredCredentials(),
      persisted,
      completeBrowserCallback,
    );
    const completion = subscription.complete(completionOptions());
    expect(http.posts).toHaveLength(1);

    await subscription.connect();
    staleToken.resolve(tokenResponse("stale", "stale-refresh"));

    await expect(completion).rejects.toThrow("superseded by another account action");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ accountId: "replacement" });
    expect(subscription.connected()).toBe(true);
  });

  it("does not let an in-flight sign-in undo disconnect", async () => {
    const http = new FakeHttp();
    const token = deferred<HttpResponse>();
    http.postResponses.push(token.promise);
    const persisted: Array<OpenAiSubscriptionCredentials | null> = [];
    const subscription = createSubscription(http, null, persisted, completeBrowserCallback);
    const connection = subscription.connect();
    await vi.waitFor(() => { expect(http.posts).toHaveLength(1); });

    await subscription.disconnect();
    token.resolve(tokenResponse("stale", "stale-refresh"));

    await expect(connection).rejects.toThrow("superseded by another account action");
    expect(persisted).toEqual([null]);
    expect(subscription.connected()).toBe(false);
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
      reasoningEffort: "high",
      serviceTier: "priority",
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
      instructions: SYSTEM_PROMPT,
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
});

function createSubscription(
  http: FakeHttp,
  credentials: OpenAiSubscriptionCredentials | null,
  persisted: Array<OpenAiSubscriptionCredentials | null>,
  openExternal: (url: string) => Promise<void> = async () => {},
): OpenAiSubscription {
  return new OpenAiSubscription({
    http,
    credentials,
    async persist(value) { persisted.push(value); },
    openExternal,
    appVersion: "1.8.0",
    now: () => 1_000_000,
  });
}

function completionOptions(): Parameters<OpenAiSubscription["complete"]>[0] {
  return {
    reasoningEffort: "none",
    serviceTier: "default",
    userPrompt: "raw",
    timeoutMs: 2_500,
  };
}

async function completeBrowserCallback(authorizationUrl: string): Promise<void> {
  const state = new URL(authorizationUrl).searchParams.get("state");
  if (state === null) throw new Error("Authorization URL had no state");
  const response = await fetch(
    `http://localhost:1455/auth/callback?state=${encodeURIComponent(state)}&code=test-code`,
  );
  if (!response.ok) throw new Error(`Callback failed (${response.status})`);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve(value) { resolvePromise?.(value); },
  };
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

function tokenResponse(accountId: string, refreshToken: string): HttpResponse {
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
