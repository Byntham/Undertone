import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import {
  isRecord,
  type CleanupReasoningEffort,
  type CleanupServiceTier,
} from "../core/config";
import type { SubscriptionCleanupRuntime } from "../core/cleanup";
import type { HttpClient, HttpGetClient, HttpResponse } from "../platform/http";
import type { ProviderModelOption } from "../shared/settings";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const MODELS_URL = "https://chatgpt.com/backend-api/codex/models?client_version=0.146.1";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;
const TOKEN_TIMEOUT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;
const MODEL_CACHE_MS = 15 * 60_000;
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_MODEL_ORDER = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "gpt-5.4-mini",
  "gpt-5.4",
] as const;

export interface OpenAiSubscriptionCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}

interface OpenAiSubscriptionOptions {
  http: HttpClient & HttpGetClient;
  credentials: OpenAiSubscriptionCredentials | null;
  persist(credentials: OpenAiSubscriptionCredentials | null): Promise<void>;
  openExternal(url: string): Promise<void>;
  appVersion: string;
  now?: () => number;
}

interface ModelCache {
  expiresAt: number;
  models: ProviderModelOption[];
}

export class OpenAiSubscription implements SubscriptionCleanupRuntime {
  private credentials: OpenAiSubscriptionCredentials | null;
  private readonly now: () => number;
  private refreshOperation: Promise<OpenAiSubscriptionCredentials> | null = null;
  private connectOperation: Promise<void> | null = null;
  private cancelConnect: (() => void) | null = null;
  private modelCache: ModelCache | null = null;

  constructor(private readonly options: OpenAiSubscriptionOptions) {
    this.credentials = options.credentials;
    this.now = options.now ?? Date.now;
  }

  connected(): boolean {
    return this.credentials !== null;
  }

  async connect(): Promise<void> {
    if (this.connectOperation !== null) return await this.connectOperation;
    this.connectOperation = this.performConnect().finally(() => {
      this.connectOperation = null;
    });
    return await this.connectOperation;
  }

  async disconnect(): Promise<void> {
    await this.options.persist(null);
    this.credentials = null;
    this.modelCache = null;
  }

  dispose(): void {
    this.cancelConnect?.();
  }

  async listModels(refresh = false): Promise<{ models: ProviderModelOption[]; defaultModel: string | null }> {
    if (!refresh && this.modelCache !== null && this.modelCache.expiresAt > this.now()) {
      return {
        models: this.modelCache.models,
        defaultModel: preferredDefault(this.modelCache.models),
      };
    }
    const response = await this.authorizedGet(MODELS_URL, TOKEN_TIMEOUT_MS);
    assertSuccess(response, "OpenAI Subscription model discovery");
    const models = parseModels(response.body);
    this.modelCache = { expiresAt: this.now() + MODEL_CACHE_MS, models };
    return { models, defaultModel: preferredDefault(models) };
  }

  async complete(options: {
    model: string;
    reasoningEffort: CleanupReasoningEffort;
    serviceTier: CleanupServiceTier;
    systemPrompt: string;
    userPrompt: string;
    timeoutMs: number;
  }): Promise<string> {
    if (!this.connected()) throw new Error("Connect your OpenAI account before using subscription cleanup.");
    const model = options.model.trim().length > 0
      ? options.model.trim()
      : (await this.listModels()).defaultModel;
    if (model === null) throw new Error("Your OpenAI subscription returned no cleanup models.");
    const lunaOptions = model === "gpt-5.6-luna"
      ? { service_tier: options.serviceTier === "fast" ? "priority" : "default" }
      : {};
    const requestBody = JSON.stringify({
      model,
      instructions: options.systemPrompt,
      input: [{
        role: "user",
        content: [{ type: "input_text", text: options.userPrompt }],
      }],
      text: {
        format: {
          type: "json_schema",
          name: "insertion",
          strict: true,
          schema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
      reasoning: { effort: model === "gpt-5.6-luna" ? options.reasoningEffort : "low" },
      ...lunaOptions,
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

  private async performConnect(): Promise<void> {
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
    this.cancelConnect = callback.cancel;
    try {
      await this.options.openExternal(authorization.toString());
      const code = await withTimeout(
        callback.code,
        LOGIN_TIMEOUT_MS,
        "OpenAI sign-in timed out. Try Connect again.",
      );
      const credentials = await this.exchangeCode(code, verifier);
      await this.options.persist(credentials);
      this.credentials = credentials;
      this.modelCache = null;
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
      await this.options.persist(next);
      this.credentials = next;
      return next;
    })().finally(() => {
      this.refreshOperation = null;
    });
    return await this.refreshOperation;
  }

  private async authorizedGet(url: string, timeoutMs: number): Promise<HttpResponse> {
    let credentials = await this.refresh();
    let response = await this.options.http.get(url, {
      headers: this.headers(credentials, "application/json"),
      timeoutMs,
    });
    if (response.status === 401) {
      credentials = await this.refresh(true);
      response = await this.options.http.get(url, {
        headers: this.headers(credentials, "application/json"),
        timeoutMs,
      });
    }
    return response;
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

function parseModels(body: string): ProviderModelOption[] {
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    throw new Error("OpenAI Subscription returned an invalid model list.");
  }
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error("OpenAI Subscription returned an invalid model list.");
  }
  const unique = new Map<string, ProviderModelOption>();
  for (const entry of payload.models) {
    if (!isRecord(entry)) continue;
    if (typeof entry.visibility === "string" && entry.visibility.toLowerCase() !== "list") continue;
    if (entry.show_in_picker === false || entry.showInPicker === false) continue;
    const id = typeof entry.slug === "string" ? entry.slug.trim()
      : typeof entry.id === "string" ? entry.id.trim()
        : "";
    if (id.length === 0) continue;
    const name = typeof entry.display_name === "string" && entry.display_name.trim().length > 0
      ? entry.display_name.trim()
      : id;
    unique.set(id, { id, name });
  }
  return [...unique.values()].sort((left, right) => (
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
  ));
}

function preferredDefault(models: readonly ProviderModelOption[]): string | null {
  for (const id of DEFAULT_MODEL_ORDER) {
    if (models.some((model) => model.id.toLowerCase() === id)) return id;
  }
  return models[0]?.id ?? null;
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
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    response.setHeader("Connection", "close");
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
    if (url.pathname !== "/auth/callback") {
      response.statusCode = 404;
      response.end(authPage("OpenAI sign-in callback was not recognized."));
      return;
    }
    if (url.searchParams.get("state") !== state) {
      response.statusCode = 400;
      response.end(authPage("OpenAI sign-in could not be verified."));
      if (!settled) {
        settled = true;
        rejectCode?.(new Error("OpenAI sign-in state did not match."));
      }
      return;
    }
    const error = url.searchParams.get("error");
    const authorizationCode = url.searchParams.get("code");
    if (error !== null || authorizationCode === null) {
      response.statusCode = 400;
      response.end(authPage("OpenAI sign-in was cancelled or failed."));
      if (!settled) {
        settled = true;
        rejectCode?.(new Error(error === null ? "OpenAI sign-in returned no code." : `OpenAI sign-in failed: ${error}`));
      }
      return;
    }
    response.statusCode = 200;
    response.end(authPage("OpenAI sign-in received. Return to Undertone to finish."));
    if (!settled) {
      settled = true;
      resolveCode?.(authorizationCode);
    }
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
