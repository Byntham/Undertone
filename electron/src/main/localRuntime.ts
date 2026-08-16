import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LocalCleanupRuntime } from "../core/cleanup";
import type { LocalSttRuntime } from "../core/transcriber";
import type { LocalRuntimeBuild, LocalSttEngineId } from "../shared/settings";
import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_NEMOTRON_STT_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "../shared/models";

export type LocalBuild = LocalRuntimeBuild;

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

interface LocalRuntimeStatus {
  installed: boolean;
  loaded: boolean;
  loading: boolean;
  build: LocalBuild | null;
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
  isInstalled?: () => boolean;
  build?: () => LocalBuild;
}

type LocalServerUsePolicy = "wait" | "fallback";

interface EngineSpec {
  logFile: string;
  serverFile(build: LocalBuild): string;
  requiredFiles(): readonly string[];
  arguments(build: LocalBuild, port: number): readonly string[];
  readyUrl(port: number): string;
  ready(response: ReadyResponse): boolean;
  readyTimeoutMs: number;
  unavailableMessage: string;
  failedMessage: string;
  fallbackNotice: string;
  builds?(): readonly LocalBuild[];
}

interface ActiveServer {
  processId: number;
  port: number;
  build: LocalBuild;
}

const STOP_TIMEOUT_MS = 5_000;

export class LocalServerRuntime {
  private readonly fetcher: LocalFetch;
  private readonly notice: ((message: string) => void) | undefined;
  private readonly installed: (() => boolean) | undefined;
  private active: ActiveServer | null = null;
  private startingProcessId: number | null = null;
  private readonly pendingStopIds = new Set<number>();
  private loadingPromise: Promise<ActiveServer> | null = null;
  private generation = 0;
  private idleSeconds = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private activeCallbacks = 0;
  private callbacksDrained: Promise<void> | null = null;
  private resolveCallbacksDrained: (() => void) | null = null;
  private ejectPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private cudaUnavailable = false;

  constructor(
    private readonly host: LocalProcessHost,
    private readonly spec: EngineSpec,
    options: LocalRuntimeOptions = {},
  ) {
    this.fetcher = options.fetch ?? (async (url, init) => await fetch(url, init));
    this.notice = options.onNotice;
    this.installed = options.isInstalled;
  }

  isInstalled(): boolean {
    if (this.installed !== undefined) return this.installed();
    return this.spec.requiredFiles().every((file) => existsSync(file));
  }

  async status(): Promise<LocalRuntimeStatus> {
    const active = await this.liveActive();
    return {
      installed: this.isInstalled(),
      loaded: active !== null && this.loadingPromise === null,
      loading: this.loadingPromise !== null,
      build: active?.build ?? null,
    };
  }

  async load(): Promise<void> {
    await this.ensureReady();
  }

  warm(): void {
    if (this.shuttingDown || this.ejectPromise !== null || !this.isInstalled()) return;
    void this.ensureReady().catch(() => undefined);
  }

  async withServer<T>(
    policy: "wait",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T>;
  async withServer<T>(
    policy: "fallback",
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T | null>;
  async withServer<T>(
    policy: LocalServerUsePolicy,
    callback: (baseUrl: string) => Promise<T> | T,
  ): Promise<T | null> {
    while (true) {
      if (this.shuttingDown) {
        if (policy === "fallback") return null;
        throw new Error("Local model runtime is shutting down");
      }
      if (this.ejectPromise !== null) {
        if (policy === "fallback") return null;
        await this.ejectPromise;
        continue;
      }

      const generation = this.generation;
      let active: ActiveServer | null;
      if (policy === "wait") {
        active = await this.ensureReady();
      } else {
        active = await this.liveActive();
        if (active === null || this.loadingPromise !== null) {
          this.warm();
          return null;
        }
      }
      if (this.ejectPromise !== null
        || generation !== this.generation
        || this.active !== active) {
        if (policy === "fallback") return null;
        continue;
      }

      if (this.activeCallbacks === 0) {
        this.callbacksDrained = new Promise<void>((resolve) => {
          this.resolveCallbacksDrained = resolve;
        });
      }
      this.activeCallbacks += 1;
      this.cancelIdleTimer();
      try {
        return await callback(this.url(active.port));
      } finally {
        this.activeCallbacks -= 1;
        if (this.activeCallbacks === 0) {
          this.resolveCallbacksDrained?.();
          this.resolveCallbacksDrained = null;
          this.callbacksDrained = null;
          if (this.active !== null && this.idleSeconds > 0) this.armIdleTimer();
        }
      }
    }
  }

  setIdleTimeout(seconds: number): void {
    this.idleSeconds = Math.max(0, seconds);
    this.cancelIdleTimer();
    if (this.idleSeconds > 0 && this.active !== null && this.activeCallbacks === 0) {
      this.armIdleTimer();
    }
  }

  async eject(): Promise<void> {
    if (this.ejectPromise !== null) return await this.ejectPromise;
    const operation = this.finishEject();
    this.ejectPromise = operation;
    try {
      await operation;
    } finally {
      if (this.ejectPromise === operation) this.ejectPromise = null;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    try { await this.eject(); } catch { /* The host shutdown will terminate its job. */ }
  }

  private async finishEject(): Promise<void> {
    this.generation += 1;
    this.cancelIdleTimer();
    const pendingCallbacks = this.callbacksDrained;
    if (pendingCallbacks !== null) await pendingCallbacks;
    if (this.startingProcessId !== null) this.pendingStopIds.add(this.startingProcessId);
    if (this.active !== null) this.pendingStopIds.add(this.active.processId);
    this.startingProcessId = null;
    this.active = null;
    await this.stopPendingProcesses();
  }

  private async ensureReady(): Promise<ActiveServer> {
    while (true) {
      if (this.shuttingDown) throw new Error("Local model runtime is shutting down");
      if (this.ejectPromise !== null) {
        await this.ejectPromise;
        continue;
      }
      const pending = this.loadingPromise;
      if (pending !== null) {
        try { await pending; } catch { /* The next attempt may fall back or retry. */ }
        continue;
      }

      const active = await this.liveActive();
      if (this.loadingPromise !== null) continue;
      if (active !== null) return active;
      if (!this.isInstalled()) throw new Error(this.spec.unavailableMessage);

      const generation = this.generation;
      const operation = this.startServer(generation);
      this.loadingPromise = operation;
      try {
        return await operation;
      } finally {
        if (this.loadingPromise === operation) {
          this.loadingPromise = null;
        }
      }
    }
  }

  private async liveActive(): Promise<ActiveServer | null> {
    const active = this.active;
    if (active === null) return null;
    if (await this.host.isSupervisedRunning(active.processId)) return active;
    if (this.active === active) {
      this.active = null;
      this.cancelIdleTimer();
    }
    return null;
  }

  private async startServer(generation: number): Promise<ActiveServer> {
    if (this.callbacksDrained !== null) await this.callbacksDrained;
    if (generation !== this.generation) throw new Error("Local model load was cancelled");
    await this.stopPendingProcesses();
    await this.stopActive();
    const configuredBuilds = this.spec.builds?.();
    const builds: readonly LocalBuild[] = configuredBuilds ?? (() => {
      const detected: LocalBuild[] = ["cpu"];
      if (!this.cudaUnavailable && existsSync(this.spec.serverFile("cuda"))) {
        detected.unshift("cuda");
      }
      return detected;
    })();

    let lastError: unknown;
    for (const build of builds) {
      if (generation !== this.generation) throw new Error("Local model load was cancelled");
      try {
        await this.stopPendingProcesses();
        const active = await this.spawn(build, generation);
        this.active = active;
        this.startingProcessId = null;
        if (this.idleSeconds > 0 && this.activeCallbacks === 0) this.armIdleTimer();
        return active;
      } catch (error) {
        lastError = error;
        if (generation !== this.generation) throw error;
        if (build !== "cuda" || !builds.includes("cpu")) break;
        this.cudaUnavailable = true;
        this.notice?.(this.spec.fallbackNotice);
      }
    }
    throw new Error(this.spec.failedMessage, { cause: lastError });
  }

  private async spawn(
    build: LocalBuild,
    generation: number,
  ): Promise<ActiveServer> {
    const port = await pickPort();
    const executable = this.spec.serverFile(build);
    const processId = await this.host.spawnSupervised(
      executable,
      this.spec.arguments(build, port).map(quoteWindowsArgument).join(" "),
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
        if (this.spec.ready(response)) return { processId, port, build };
      } catch {
        // Server is still loading or has not bound the loopback port yet.
      }
      await delay(250);
    }
    await this.stopTrackedProcess(processId);
    if (this.startingProcessId === processId) this.startingProcessId = null;
    throw new Error(this.spec.failedMessage);
  }

  private async stopActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active !== null) await this.stopTrackedProcess(active.processId);
  }

  private async stopTrackedProcess(processId: number): Promise<void> {
    this.pendingStopIds.add(processId);
    await this.stopProcess(processId);
    this.pendingStopIds.delete(processId);
  }

  private async stopPendingProcesses(): Promise<void> {
    await Promise.all([...this.pendingStopIds].map(async (processId) => {
      await this.stopTrackedProcess(processId);
    }));
  }

  private async stopProcess(processId: number): Promise<void> {
    await this.host.stopSupervised(processId);
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (!await this.host.isSupervisedRunning(processId)) return;
      } catch {
        // Unknown liveness is not proof of exit. Retry until the same bound.
      }
      await delay(50);
    }
    throw new Error("Local engine process did not stop");
  }

  private url(port: number): string {
    return `http://127.0.0.1:${port}`;
  }

  private armIdleTimer(): void {
    this.cancelIdleTimer();
    if (this.activeCallbacks > 0 || this.active === null || this.idleSeconds === 0) return;
    const active = this.active;
    const delayMs = Math.max(50, this.idleSeconds * 1_000);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active === active && this.activeCallbacks === 0 && this.idleSeconds > 0) {
        void this.eject().catch(() => undefined);
      }
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
): LocalServerRuntime {
  const runtime = path.join(root, "runtime");
  const models = path.join(root, "models");
  return new LocalServerRuntime(host, {
    logFile: path.join(runtime, "server.log"),
    serverFile: (build) => path.join(runtime, build, "whisper-server.exe"),
    requiredFiles: () => [
      path.join(runtime, "cpu", "whisper-server.exe"),
      path.join(models, LOCAL_STT_MODEL),
      path.join(models, LOCAL_VAD_MODEL),
    ],
    arguments: (build, port) => [
      "-m", path.join(models, LOCAL_STT_MODEL),
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

export function createNemotronSttRuntime(
  host: LocalProcessHost,
  root: string,
  options: LocalRuntimeOptions = {},
): LocalServerRuntime {
  const bundledExecutable = path.join(root, "runtime", "nemotron", "nemo-speech.exe");
  const legacyExecutable = path.join(
    process.env.LOCALAPPDATA ?? root,
    "Programs", "NeMoSpeech", "bin", "nemo-speech.exe",
  );
  const externalExecutable = process.env.UNDERTONE_NEMO_SPEECH_EXE?.trim();
  const executable = (): string => externalExecutable
    || (existsSync(bundledExecutable) ? bundledExecutable : legacyExecutable);
  const model = path.join(root, "models", LOCAL_NEMOTRON_STT_MODEL);
  const selectedBuild = (): LocalBuild => options.build?.() ?? "cuda";
  return new LocalServerRuntime(host, {
    logFile: path.join(root, "runtime", "nemotron-server.log"),
    serverFile: () => executable(),
    requiredFiles: () => [
      executable(),
      model,
      ...(executable() === bundledExecutable
        ? [path.join(root, "runtime", "nemotron", `undertone-nemotron-${selectedBuild()}.txt`)]
        : []),
    ],
    arguments: (build, port) => [
      "serve",
      "--asr-model", model,
      "--device", build === "cuda" ? "cuda:0" : "cpu",
      "--host", "127.0.0.1",
      "--port", String(port),
      "--no-ui",
    ],
    readyUrl: (port) => `http://127.0.0.1:${port}/ready`,
    ready: (response) => response.status === 200,
    readyTimeoutMs: 120_000,
    unavailableMessage: "Nemotron streaming isn't installed — download it in Settings → Speech & AI.",
    failedMessage: "The Nemotron streaming engine failed to start - see nemotron-server.log.",
    fallbackNotice: "",
    builds: () => [selectedBuild()],
  }, options);
}

export function createLocalSttRouter(
  whisper: LocalServerRuntime,
  nemotron: LocalServerRuntime,
): LocalSttRuntime {
  return {
    async withServer<T>(
      engine: LocalSttEngineId,
      policy: "wait",
      callback: (baseUrl: string) => Promise<T> | T,
    ): Promise<T> {
      const runtime = engine === "nemotron" ? nemotron : whisper;
      return await runtime.withServer(policy, callback);
    },
  };
}

export function createLocalCleanupRuntime(
  host: LocalProcessHost,
  root: string,
  options: LocalRuntimeOptions = {},
): LocalServerRuntime & LocalCleanupRuntime {
  const runtime = path.join(root, "runtime");
  const models = path.join(root, "models");
  return new LocalServerRuntime(host, {
    logFile: path.join(runtime, "llm-server.log"),
    serverFile: (build) => path.join(runtime, `llm-${build}`, "llama-server.exe"),
    requiredFiles: () => [
      path.join(runtime, "llm-cpu", "llama-server.exe"),
      path.join(models, LOCAL_CLEANUP_MODEL),
    ],
    arguments: (build, port) => [
      "-m", path.join(models, LOCAL_CLEANUP_MODEL),
      "--host", "127.0.0.1",
      "--port", String(port),
      "-c", "8192",
      "--jinja",
      "--reasoning", "off",
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
