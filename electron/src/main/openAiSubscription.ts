import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  isRecord,
  type CleanupReasoningEffort,
  type CleanupServiceTier,
} from "../core/config";
import { SYSTEM_PROMPT } from "../core/cleanupPrompt";
import type { SubscriptionCleanupRuntime } from "../core/cleanup";
import type { HttpClient, HttpResponse } from "../platform/http";
import { DEFAULT_CLEANUP_MODELS } from "../shared/models";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_URL = new URL(REDIRECT_URI);
const CALLBACK_PORT = 1455;
const TOKEN_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
const REFRESH_SKEW_MS = 60_000;

export interface OpenAiSubscriptionCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

interface OpenAiSubscriptionOptions {
  http: HttpClient;
  credentials: OpenAiSubscriptionCredentials | null;
  persist(credentials: OpenAiSubscriptionCredentials | null): Promise<void>;
  openExternal(url: string): Promise<void>;
  appVersion: string;
  now?: () => number;
}

export class OpenAiSubscription implements SubscriptionCleanupRuntime {
  private credentials: OpenAiSubscriptionCredentials | null;
  private readonly now: () => number;
  private refreshOperation: Promise<OpenAiSubscriptionCredentials> | null = null;
  private connectOperation: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private credentialGeneration = 0;
  private persistOperation: Promise<void> = Promise.resolve();

  constructor(private readonly options: OpenAiSubscriptionOptions) {
    this.credentials = options.credentials;
    this.now = options.now ?? Date.now;
  }

  connected(): boolean {
    return this.credentials !== null;
  }

  async connect(): Promise<void> {
    if (this.connectOperation !== null) return await this.connectOperation;
    const generation = ++this.credentialGeneration;
    this.connectOperation = this.performConnect(generation).finally(() => {
      this.connectOperation = null;
    });
    return await this.connectOperation;
  }

  async disconnect(): Promise<void> {
    const generation = ++this.credentialGeneration;
    this.credentials = null;
    this.cancelConnect?.();
    await this.persistCredentials(null, generation);
  }

  dispose(): void {
    this.credentialGeneration += 1;
    this.cancelConnect?.();
  }

  async complete(options: {
    reasoningEffort: CleanupReasoningEffort;
    serviceTier: CleanupServiceTier;
    userPrompt: string;
    timeoutMs: number;
  }): Promise<string> {
    if (!this.connected()) throw new Error("Connect your OpenAI account before using subscription cleanup.");
    const requestBody = JSON.stringify({
      model: DEFAULT_CLEANUP_MODELS["openai-subscription"],
      instructions: SYSTEM_PROMPT,
      input: [{
        role: "user",
        content: [{ type: "input_text", text: options.userPrompt }],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "cleanup",
          strict: true,
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
      reasoning: { effort: options.reasoningEffort },
      service_tier: options.serviceTier,
      tools: [],
      parallel_tool_calls: false,
      store: false,
      stream: true,
    });
    let response = await this.authorizedPost(RESPONSES_URL, requestBody, options.timeoutMs);
    if (response.status === 401) {
      await this.refresh(true);
      response = await this.authorizedPost(RESPONSES_URL, requestBody, options.timeoutMs);
    }
    assertSuccess(response, "OpenAI Subscription cleanup");
    return parseResponseText(response.body);
  }

  private async performConnect(generation: number): Promise<void> {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("hex");
    const authorization = new URL(AUTHORIZE_URL);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("client_id", CLIENT_ID);
    authorization.searchParams.set("redirect_uri", REDIRECT_URI);
    authorization.searchParams.set("scope", "openid profile email offline_access");
    authorization.searchParams.set("code_challenge", challenge);
    authorization.searchParams.set("code_challenge_method", "S256");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("id_token_add_organizations", "true");
    authorization.searchParams.set("codex_cli_simplified_flow", "true");
    authorization.searchParams.set("originator", "undertone");

    const callback = await listenForAuthorizationCode(state);
    if (generation !== this.credentialGeneration) {
      callback.cancel();
      throw new Error("OpenAI sign-in was superseded by another account action.");
    }
    this.cancelConnect = callback.cancel;
    try {
      await this.options.openExternal(authorization.toString());
      const code = await withTimeout(
        callback.code,
        LOGIN_TIMEOUT_MS,
        "OpenAI sign-in timed out. Try Connect again.",
      );
      const credentials = await this.exchangeCode(code, verifier);
      if (!await this.persistCredentials(credentials, generation)) {
        throw new Error("OpenAI sign-in was superseded by another account action.");
      }
    } finally {
      this.cancelConnect = null;
      closeServer(callback.server);
    }
  }

  private async exchangeCode(code: string, verifier: string): Promise<OpenAiSubscriptionCredentials> {
    const response = await this.options.http.post(TOKEN_URL, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      timeoutMs: TOKEN_TIMEOUT_MS,
    });
    return tokenCredentials(response, this.now());
  }

  private async refresh(force = false): Promise<OpenAiSubscriptionCredentials> {
    const current = this.credentials;
    if (current === null) throw new Error("Connect your OpenAI account before using subscription cleanup.");
    if (!force && current.expiresAt > this.now() + REFRESH_SKEW_MS) return current;
    if (this.refreshOperation !== null) return await this.refreshOperation;
    if (this.connectOperation !== null) throw new Error("OpenAI sign-in is already in progress.");
    const generation = this.credentialGeneration;
    this.refreshOperation = (async () => {
      const response = await this.options.http.post(TOKEN_URL, {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: current.refreshToken,
          client_id: CLIENT_ID,
        }),
        timeoutMs: TOKEN_TIMEOUT_MS,
      });
      const next = tokenCredentials(response, this.now());
      if (generation !== this.credentialGeneration) {
        throw new Error("OpenAI token refresh was superseded by another account action.");
      }
      const replacementGeneration = ++this.credentialGeneration;
      if (!await this.persistCredentials(next, replacementGeneration)) {
        throw new Error("OpenAI token refresh was superseded by another account action.");
      }
      return next;
    })().finally(() => {
      this.refreshOperation = null;
    });
    return await this.refreshOperation;
  }

  private async persistCredentials(
    credentials: OpenAiSubscriptionCredentials | null,
    generation: number,
  ): Promise<boolean> {
    let committed = false;
    const operation = this.persistOperation.then(async () => {
      // A disconnect must still clear persisted credentials if a newer connect
      // starts before this queued write runs. A later successful connect is
      // queued after it and will replace the cleared value.
      if (credentials !== null && generation !== this.credentialGeneration) return;
      await this.options.persist(credentials);
      if (generation !== this.credentialGeneration) return;
      this.credentials = credentials;
      committed = true;
    });
    this.persistOperation = operation.catch(() => undefined);
    await operation;
    return committed;
  }

  private async authorizedPost(url: string, body: string, timeoutMs: number): Promise<HttpResponse> {
    const credentials = await this.refresh();
    return await this.options.http.post(url, {
      headers: this.headers(credentials, "text/event-stream"),
      body,
      timeoutMs,
    });
  }

  private headers(
    credentials: OpenAiSubscriptionCredentials,
    accept: string,
  ): Readonly<Record<string, string>> {
    return {
      Authorization: `Bearer ${credentials.accessToken}`,
      "ChatGPT-Account-ID": credentials.accountId,
      "Content-Type": "application/json",
      Accept: accept,
      originator: "undertone",
      version: this.options.appVersion,
      "User-Agent": `undertone/${this.options.appVersion}`,
    };
  }
}

function tokenCredentials(response: HttpResponse, now: number): OpenAiSubscriptionCredentials {
  assertSuccess(response, "OpenAI sign-in");
  let payload: unknown;
  try {
    payload = JSON.parse(response.body) as unknown;
  } catch {
    throw new Error("OpenAI sign-in returned invalid token data.");
  }
  if (!isRecord(payload)
    || typeof payload.access_token !== "string"
    || typeof payload.refresh_token !== "string"
    || typeof payload.expires_in !== "number"
    || !Number.isFinite(payload.expires_in)
    || payload.expires_in <= 0) {
    throw new Error("OpenAI sign-in returned incomplete token data.");
  }
  const accountId = accountIdFromAccessToken(payload.access_token);
  if (accountId === null) throw new Error("OpenAI sign-in did not identify an account.");
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: now + payload.expires_in * 1_000,
    accountId,
  };
}

export function accountIdFromAccessToken(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!isRecord(payload)) return null;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth) || typeof auth.chatgpt_account_id !== "string") return null;
    const result = auth.chatgpt_account_id.trim();
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

export function parseResponseText(body: string): string {
  let streamed = "";
  let terminal: string | null = null;
  for (const line of body.split(/\r?\n/u)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (data.length === 0 || data === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(data) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
      streamed += event.delta;
    } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
      terminal = event.text;
    } else if (event.type === "response.completed" && isRecord(event.response)) {
      terminal = outputText(event.response) ?? terminal;
    } else if (event.type === "error" || event.type === "response.failed") {
      throw new Error(responseError(event) || "OpenAI Subscription cleanup failed.");
    }
  }
  const result = terminal ?? streamed;
  if (result.length === 0) throw new Error("OpenAI Subscription returned no cleanup text.");
  return result;
}

function outputText(response: Record<string, unknown>): string | null {
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return null;
}

function responseError(event: Record<string, unknown>): string {
  const candidates = [event.error, isRecord(event.response) ? event.response.error : undefined];
  for (const candidate of candidates) {
    if (isRecord(candidate) && typeof candidate.message === "string") return candidate.message;
  }
  return typeof event.message === "string" ? event.message : "";
}

function assertSuccess(response: HttpResponse, operation: string): void {
  if (response.status >= 200 && response.status < 300) return;
  let detail = "";
  try {
    const payload = JSON.parse(response.body) as unknown;
    if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
      detail = payload.error.message.replace(/\s+/gu, " ").trim().slice(0, 300);
    }
  } catch {
    // Status is enough when the server does not return JSON.
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${operation} was not authorized. Reconnect your OpenAI account.`);
  }
  if (response.status === 429) {
    throw new Error(`${operation} reached your subscription limit. Try again later.`);
  }
  throw new Error(detail.length > 0
    ? `${operation} failed (${response.status}): ${detail}`
    : `${operation} failed (${response.status}).`);
}

async function listenForAuthorizationCode(state: string): Promise<{
  server: Server;
  code: Promise<string>;
  cancel: () => void;
}> {
  let settled = false;
  let resolveCode: ((code: string) => void) | null = null;
  let rejectCode: ((error: Error) => void) | null = null;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  void code.catch(() => undefined);
  const server = createServer((request, response) => {
    response.setHeader("Connection", "close");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    const finish = (status: number, message: string, result?: { code: string } | { error: string }): void => {
      response.statusCode = status;
      response.end(authPage(message));
      if (settled || result === undefined) return;
      settled = true;
      if ("code" in result) resolveCode?.(result.code);
      else rejectCode?.(new Error(result.error));
    };
    const fail = (status: number, message: string): void => {
      finish(status, message, { error: message });
    };

    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      fail(403, "OpenAI sign-in callback did not come from this computer.");
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "", CALLBACK_URL);
    } catch {
      finish(404, "OpenAI sign-in callback was not recognized.");
      return;
    }
    if (url.origin !== CALLBACK_URL.origin || url.pathname !== CALLBACK_URL.pathname) {
      finish(404, "OpenAI sign-in callback was not recognized.");
      return;
    }
    if (request.method !== "GET") {
      finish(405, "OpenAI sign-in callback method was not recognized.");
      return;
    }
    const states = url.searchParams.getAll("state");
    const codes = url.searchParams.getAll("code");
    const errors = url.searchParams.getAll("error");
    if (states.length > 1 || codes.length > 1 || errors.length > 1 || (codes.length > 0 && errors.length > 0)) {
      fail(400, "OpenAI sign-in callback was ambiguous.");
      return;
    }
    if (states.length !== 1 || states[0] !== state) {
      fail(400, "OpenAI sign-in state did not match.");
      return;
    }
    if (errors.length === 1) {
      fail(400, "OpenAI sign-in returned an error.");
      return;
    }
    const authorizationCode = codes[0];
    if (codes.length !== 1 || authorizationCode === undefined || authorizationCode.trim().length === 0) {
      fail(400, "OpenAI sign-in returned no code.");
      return;
    }
    finish(200, "OpenAI sign-in received. Return to Undertone to finish.", { code: authorizationCode });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(CALLBACK_PORT, "localhost", () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((error: unknown) => {
    closeServer(server);
    throw new Error(error instanceof Error && "code" in error && error.code === "EADDRINUSE"
      ? "OpenAI sign-in cannot start because local port 1455 is already in use."
      : "OpenAI sign-in could not start its local callback.");
  });
  return {
    server,
    code,
    cancel: () => {
      if (settled) return;
      settled = true;
      rejectCode?.(new Error("OpenAI sign-in was cancelled."));
      closeServer(server);
    },
  };
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === "::1") return true;
  const ipv4 = address?.startsWith("::ffff:") === true ? address.slice(7) : address;
  const octets = ipv4?.split(".");
  return octets?.length === 4
    && octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}

function closeServer(server: Server): void {
  try {
    server.close();
    server.closeAllConnections();
  } catch {
    // The server may already be closed.
  }
}

function authPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Undertone</title><style>body{font:16px system-ui;background:#17191d;color:#e8eaf0;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:34rem;padding:2rem;text-align:center}</style><main><h1>Undertone</h1><p>${message}</p></main>`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
