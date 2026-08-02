import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
  createLocalCleanupRuntime,
  createLocalSttRuntime,
  quoteWindowsArgument,
  type LocalProcessHost,
} from "../src/main/localRuntime";
import { WindowsHost } from "../src/platform/windowsHost";
import { FetchHttpClient } from "../src/platform/http";
import { encodePcm16Wav } from "../src/core/audio";
import { CleanupClient } from "../src/core/cleanup";
import { Transcriber } from "../src/core/transcriber";

const temporaryDirectories: string[] = [];

class FakeHost implements LocalProcessHost {
  readonly starts: Array<{
    processId: number;
    file: string;
    argumentsValue: string;
    workingDirectory: string;
    logFile: string;
  }> = [];
  readonly stopped: number[] = [];
  readonly running = new Map<number, boolean>();
  failCuda = false;
  private nextProcessId = 100;

  async spawnSupervised(
    file: string,
    argumentsValue = "",
    workingDirectory = "",
    logFile = "",
  ): Promise<number> {
    const processId = this.nextProcessId++;
    this.starts.push({ processId, file, argumentsValue, workingDirectory, logFile });
    this.running.set(processId, !(this.failCuda && file.includes("cuda")));
    return processId;
  }

  async stopSupervised(processId: number): Promise<boolean> {
    this.stopped.push(processId);
    this.running.set(processId, false);
    return true;
  }

  async isSupervisedRunning(processId: number): Promise<boolean> {
    return this.running.get(processId) === true;
  }
}

afterEach(async () => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe("local runtime", () => {
  it("starts, reuses, and ejects the installed CPU STT runtime", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });

    const baseUrl = await runtime.ensureReady();
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(host.starts).toHaveLength(1);
    expect(host.starts[0]?.file).toBe(path.join(root, "runtime", "cpu", "whisper-server.exe"));
    expect(host.starts[0]?.argumentsValue).toContain(LOCAL_STT_MODEL);
    expect(host.starts[0]?.argumentsValue).toContain(LOCAL_VAD_MODEL);
    expect(runtime.baseUrl()).toBe(baseUrl);
    expect((await runtime.ensureReady())).toBe(baseUrl);
    expect(host.starts).toHaveLength(1);

    await runtime.eject();
    expect(runtime.baseUrl()).toBeNull();
    expect(host.stopped).toContain(host.starts[0]?.processId);
  });

  it("persists CUDA disablement and falls back to CPU", async () => {
    const root = await installedRoot("stt", true);
    const host = new FakeHost();
    host.failCuda = true;
    const notices: string[] = [];
    const runtime = createLocalSttRuntime(host, root, {
      fetch: readyFetch,
      onNotice: (message) => notices.push(message),
    });

    await runtime.ensureReady();
    expect(host.starts.map((start) => path.basename(path.dirname(start.file))))
      .toEqual(["cuda", "cpu"]);
    expect(notices).toEqual(["GPU transcription failed — using CPU (slower)."]);
    const state = JSON.parse(await readFile(
      path.join(root, "runtime", "runtime.json"),
      "utf8",
    )) as Record<string, unknown>;
    expect(state.cuda_disabled).toBe(true);
    await runtime.shutdown();
  });

  it("warms cleanup single-flight without blocking the current caller", async () => {
    const root = await installedRoot("cleanup");
    const host = new FakeHost();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = createLocalCleanupRuntime(host, root, {
      fetch: async () => {
        await gate;
        return { status: 200 };
      },
    });

    expect(runtime.baseUrl()).toBeNull();
    runtime.loadAsync();
    runtime.loadAsync();
    expect(runtime.baseUrl()).toBeNull();
    await waitUntil(() => host.starts.length === 1);
    release?.();
    await waitUntil(() => runtime.baseUrl() !== null);
    expect(host.starts).toHaveLength(1);

    const firstProcess = host.starts[0]?.processId;
    if (firstProcess !== undefined) host.running.set(firstProcess, false);
    runtime.loadAsync();
    await waitUntil(() => host.starts.length === 2);
    await runtime.shutdown();
  });

  it("rejects model path traversal and quotes Windows arguments", async () => {
    const root = await installedRoot("stt");
    const runtime = createLocalSttRuntime(new FakeHost(), root, { fetch: readyFetch });
    expect(() => runtime.isInstalled("../outside.bin")).toThrow(/filename/u);
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("C:\\Model Files\\model.bin"))
      .toBe('"C:\\Model Files\\model.bin"');
    expect(quoteWindowsArgument('ends with slash\\')).toBe('"ends with slash\\\\"');
  });

  it.skipIf(process.env.UNDERTONE_LOCAL_RUNTIME_E2E !== "1")(
    "reuses the installed whisper.cpp and llama.cpp servers",
    async () => {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData === undefined) throw new Error("LOCALAPPDATA is unavailable");
      const root = path.join(localAppData, "Undertone");
      const host = new WindowsHost({ requestTimeoutMs: 5_000 });
      const stt = createLocalSttRuntime(host, root);
      const cleanup = createLocalCleanupRuntime(host, root);
      try {
        await host.start();
        expect(stt.isInstalled()).toBe(true);
        expect(await stt.ensureReady()).toMatch(/^http:\/\/127\.0\.0\.1:/u);
        expect(stt.status().build).toMatch(/^(cpu|cuda)$/u);
        const http = new FetchHttpClient();
        const transcriber = new Transcriber(http, stt);
        const silence = new Uint8Array(encodePcm16Wav(new Float32Array(8_000), 16_000));
        expect(await transcriber.transcribe({
          wav: silence,
          apiKey: "",
          provider: "local",
          language: "en",
        })).toBe("");
        await stt.eject();

        expect(cleanup.isInstalled()).toBe(true);
        expect(await cleanup.ensureReady()).toMatch(/^http:\/\/127\.0\.0\.1:/u);
        expect(cleanup.baseUrl()).not.toBeNull();
        expect(cleanup.status().build).toMatch(/^(cpu|cuda)$/u);
        const cleaner = new CleanupClient(http, cleanup);
        expect(await cleaner.cleanup({
          transcript: "um hello there",
          context: "",
          app: "Undertone local E2E",
          corrections: {},
          apiKey: "",
          provider: "local",
          timeoutSeconds: 10,
        })).not.toBeNull();
      } finally {
        await cleanup.shutdown();
        await stt.shutdown();
        await host.stop();
      }
    },
    150_000,
  );
});

async function installedRoot(kind: "stt" | "cleanup", cuda = false): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "undertone-local-runtime-"));
  temporaryDirectories.push(root);
  const runtime = path.join(root, "runtime");
  const models = path.join(root, "models");
  await mkdir(models, { recursive: true });
  if (kind === "stt") {
    await touch(path.join(runtime, "cpu", "whisper-server.exe"));
    await touch(path.join(models, LOCAL_STT_MODEL));
    await touch(path.join(models, LOCAL_VAD_MODEL));
    if (cuda) {
      await touch(path.join(runtime, "cuda", "whisper-server.exe"));
      await writeFile(
        path.join(runtime, "runtime.json"),
        JSON.stringify({ cuda_installed: true, cuda_disabled: false }),
        "utf8",
      );
    }
  } else {
    await touch(path.join(runtime, "llm-cpu", "llama-server.exe"));
    await touch(path.join(models, LOCAL_CLEANUP_MODEL));
  }
  return root;
}

async function touch(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "", "utf8");
}

async function readyFetch(): Promise<{ status: number }> {
  return { status: 200 };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Condition timed out");
}
