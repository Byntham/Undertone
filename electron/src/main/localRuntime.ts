import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalCleanupRuntime } from "../core/cleanup";
import type { LocalSttRuntime } from "../core/transcriber";

export const LOCAL_STT_MODEL = "ggml-large-v3-turbo.bin";
export const LOCAL_VAD_MODEL = "ggml-silero-v6.2.0.bin";
export const LOCAL_CLEANUP_MODEL = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf";

export type LocalBuild = "cpu" | "cuda";

export interface LocalProcessHost {
  spawnSupervised(
    file: string,
    argumentsValue?: string,
    workingDirectory?: string,
    logFile?: string,
  ): Promise<number>;
  stopSupervised(processId: number): Promise<boolean>;
  isSupervisedRunning(processId: number): Promise<boolean>;
}

export interface LocalRuntimeStatus {
  installed: boolean;
  loaded: boolean;
  loading: boolean;
  build: LocalBuild | null;
  model: string;
}

interface ReadyResponse {
  status: number;
}

export type LocalFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<ReadyResponse>;

export interface LocalRuntimeOptions {
  fetch?: LocalFetch;
  onNotice?: (message: string) => void;
}

interface EngineSpec {
  defaultModel: string;
  logFile: string;
  serverFile(build: LocalBuild): string;
  requiredFiles(model: string): readonly string[];
  arguments(build: LocalBuild, model: string, port: number): readonly string[];
  readyUrl(port: number): string;
  ready(response: ReadyResponse): boolean;
  readyTimeoutMs: number;
  unavailableMessage: string;
  failedMessage: string;
  fallbackNotice: string;
}

interface ActiveServer {
  processId: number;
  port: number;
  build: LocalBuild;
  model: string;
}

export class LocalServerRuntime {
  private readonly fetcher: LocalFetch;
  private readonly notice: ((message: string) => void) | undefined;
  private active: ActiveServer | null = null;
  private startingProcessId: number | null = null;
  private loadingPromise: Promise<string> | null = null;
  private generation = 0;
  private idleSeconds = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastUsed = 0;
  private cudaUnavailable = false;

  constructor(
    private readonly host: LocalProcessHost,
    private readonly spec: EngineSpec,
    options: LocalRuntimeOptions = {},
  ) {
    this.fetcher = options.fetch ?? (async (url, init) => await fetch(url, init));
    this.notice = options.onNotice;
  }

  isInstalled(requestedModel = ""): boolean {
    const model = this.modelName(requestedModel);
    return this.spec.requiredFiles(model).every((file) => existsSync(file));
  }

  status(requestedModel = ""): LocalRuntimeStatus {
    const model = this.modelName(requestedModel);
    return {
      installed: this.isInstalled(model),
      loaded: this.active?.model === model && this.loadingPromise === null,
      loading: this.loadingPromise !== null,
      build: this.active?.build ?? null,
      model,
    };
  }

  baseUrl(requestedModel = ""): string | null {
    const model = this.modelName(requestedModel);
    if (this.loadingPromise !== null || this.active?.model !== model) return null;
    this.touch();
    return this.url(this.active.port);
  }

  loadAsync(requestedModel = ""): void {
    if (!this.isInstalled(requestedModel)) return;
    void this.ensureReady(requestedModel).catch(() => undefined);
  }

  async ensureReady(requestedModel = ""): Promise<string> {
    const model = this.modelName(requestedModel);
    while (this.loadingPromise !== null) {
      const pending = this.loadingPromise;
      try { await pending; } catch { /* The next attempt may fall back or retry. */ }
      if (this.loadingPromise === pending) await Promise.resolve();
    }

    if (this.active?.model === model
      && await this.host.isSupervisedRunning(this.active.processId)) {
      this.touch();
      return this.url(this.active.port);
    }
    if (!this.isInstalled(model)) throw new Error(this.spec.unavailableMessage);

    const generation = this.generation;
    const operation = this.startServer(model, generation);
    this.loadingPromise = operation;
    try {
      return await operation;
    } finally {
      if (this.loadingPromise === operation) this.loadingPromise = null;
    }
  }

  setIdleTimeout(seconds: number): void {
    this.idleSeconds = Math.max(0, Math.floor(seconds));
    this.cancelIdleTimer();
    if (this.idleSeconds > 0 && this.active !== null) this.armIdleTimer();
  }

  async eject(): Promise<void> {
    this.generation += 1;
    this.cancelIdleTimer();
    const processIds = new Set<number>();
    if (this.startingProcessId !== null) processIds.add(this.startingProcessId);
    if (this.active !== null) processIds.add(this.active.processId);
    this.startingProcessId = null;
    this.active = null;
    await Promise.all([...processIds].map(async (processId) => {
      try { await this.host.stopSupervised(processId); } catch { /* Host shutdown wins. */ }
    }));
  }

  async shutdown(): Promise<void> {
    await this.eject();
  }

  private async startServer(model: string, generation: number): Promise<string> {
    await this.stopActive();
    const builds: LocalBuild[] = ["cpu"];
    if (!this.cudaUnavailable && existsSync(this.spec.serverFile("cuda"))) {
      builds.unshift("cuda");
    }

    let lastError: unknown;
    for (const build of builds) {
      if (generation !== this.generation) throw new Error("Local model load was cancelled");
      try {
        const active = await this.spawn(build, model, generation);
        this.active = active;
        this.startingProcessId = null;
        this.touch();
        return this.url(active.port);
      } catch (error) {
        lastError = error;
        if (generation !== this.generation) throw error;
        if (build !== "cuda") break;
        this.cudaUnavailable = true;
        this.notice?.(this.spec.fallbackNotice);
      }
    }
    throw new Error(this.spec.failedMessage, { cause: lastError });
  }

  private async spawn(
    build: LocalBuild,
    model: string,
    generation: number,
  ): Promise<ActiveServer> {
    const port = await pickPort();
    const executable = this.spec.serverFile(build);
    const processId = await this.host.spawnSupervised(
      executable,
      this.spec.arguments(build, model, port).map(quoteWindowsArgument).join(" "),
      path.dirname(executable),
      this.spec.logFile,
    );
    this.startingProcessId = processId;
    const deadline = Date.now() + this.spec.readyTimeoutMs;
    while (Date.now() < deadline && generation === this.generation) {
      if (!await this.host.isSupervisedRunning(processId)) break;
      try {
        const response = await fetchWithTimeout(
          this.fetcher,
          this.spec.readyUrl(port),
          1_000,
        );
        if (this.spec.ready(response)) return { processId, port, build, model };
      } catch {
        // Server is still loading or has not bound the loopback port yet.
      }
      await delay(250);
    }
    try { await this.host.stopSupervised(processId); } catch { /* Best effort. */ }
    if (this.startingProcessId === processId) this.startingProcessId = null;
    throw new Error(this.spec.failedMessage);
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active !== null) {
      try { await this.host.stopSupervised(active.processId); } catch { /* Best effort. */ }
    }
  }

  private modelName(requested: string): string {
    const model = requested.trim() || this.spec.defaultModel;
    if (path.basename(model) !== model || /[\\/\0]/u.test(model)) {
      throw new Error("Local model override must be a filename in Undertone's models folder");
    }
    return model;
  }

  private url(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  private touch(): void {
    this.lastUsed = Date.now();
    if (this.idleSeconds > 0) this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    const delayMs = Math.max(50, this.idleSeconds * 1_000 - (Date.now() - this.lastUsed));
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active === null || this.idleSeconds === 0) return;
      const remaining = this.idleSeconds * 1_000 - (Date.now() - this.lastUsed);
      if (remaining <= 0) void this.eject();
      else this.armIdleTimer();
    }, delayMs);
  }

  private cancelIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export function createLocalSttRuntime(
  host: LocalProcessHost,
  root: string,
  options: LocalRuntimeOptions = {},
): LocalServerRuntime & LocalSttRuntime {
  const runtime = path.join(root, "runtime");
  const models = path.join(root, "models");
  return new LocalServerRuntime(host, {
    defaultModel: LOCAL_STT_MODEL,
    logFile: path.join(runtime, "server.log"),
    serverFile: (build) => path.join(runtime, build, "whisper-server.exe"),
    requiredFiles: (model) => [
      path.join(runtime, "cpu", "whisper-server.exe"),
      path.join(models, model),
      path.join(models, LOCAL_VAD_MODEL),
    ],
    arguments: (build, model, port) => [
      "-m", path.join(models, model),
      "--vad",
      "--vad-model", path.join(models, LOCAL_VAD_MODEL),
      "--host", "127.0.0.1",
      "--port", String(port),
      ...(build === "cpu" ? ["-t", String(Math.min(8, os.cpus().length || 4))] : []),
    ],
    readyUrl: (port) => `http://127.0.0.1:${port}/`,
    ready: () => true,
    readyTimeoutMs: 60_000,
    unavailableMessage: "The local model isn't installed — download it in Settings → Speech & AI.",
    failedMessage: "The local transcription engine failed to start — see server.log.",
    fallbackNotice: "GPU transcription failed — using CPU (slower).",
  }, options);
}

export function createLocalCleanupRuntime(
  host: LocalProcessHost,
  root: string,
  options: LocalRuntimeOptions = {},
): LocalServerRuntime & LocalCleanupRuntime {
  const runtime = path.join(root, "runtime");
  const models = path.join(root, "models");
  return new LocalServerRuntime(host, {
    defaultModel: LOCAL_CLEANUP_MODEL,
    logFile: path.join(runtime, "llm-server.log"),
    serverFile: (build) => path.join(runtime, `llm-${build}`, "llama-server.exe"),
    requiredFiles: (model) => [
      path.join(runtime, "llm-cpu", "llama-server.exe"),
      path.join(models, model),
    ],
    arguments: (build, model, port) => [
      "-m", path.join(models, model),
      "--host", "127.0.0.1",
      "--port", String(port),
      "-c", "8192",
      "--jinja",
      ...(build === "cuda"
        ? ["-ngl", "99"]
        : ["-t", String(Math.min(8, os.cpus().length || 4))]),
    ],
    readyUrl: (port) => `http://127.0.0.1:${port}/health`,
    ready: (response) => response.status === 200,
    readyTimeoutMs: 120_000,
    unavailableMessage: "The local cleanup model isn't installed — download it in Settings → Speech & AI.",
    failedMessage: "The local cleanup engine failed to start — see llm-server.log.",
    fallbackNotice: "GPU cleanup failed — using CPU (slower).",
  }, options);
}

export function quoteWindowsArgument(value: string): string {
  if (value.length > 0 && !/[\s"]/u.test(value)) return value;
  return `"${value
    .replace(/(\\*)"/gu, "$1$1\\\"")
    .replace(/(\\+)$/u, "$1$1")}"`;
}

async function fetchWithTimeout(
  fetcher: LocalFetch,
  url: string,
  timeoutMs: number,
): Promise<ReadyResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pickPort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port"));
        return;
      }
      const port = address.port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
