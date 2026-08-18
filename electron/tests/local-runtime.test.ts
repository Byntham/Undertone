import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLocalSttRouter,
  createLocalCleanupRuntime,
  createLocalSttRuntime,
  createNemotronSttRuntime,
  quoteWindowsArgument,
  type LocalProcessHost,
} from "../src/main/localRuntime";
import { LocalInstaller } from "../src/main/localInstaller";
import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_NEMOTRON_STT_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "../src/shared/models";
import { WindowsHost } from "../src/platform/windowsHost";
import { FetchHttpClient } from "../src/platform/http";
import { encodePcm16Wav } from "../src/core/audio";
import { CleanupClient } from "../src/core/cleanup";
import { NemotronLiveTranscriber } from "../src/core/nemotronLiveTranscriber";
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
  runningCheck: ((processId: number) => Promise<boolean>) | null = null;
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
    if (this.runningCheck !== null) return await this.runningCheck(processId);
    return this.running.get(processId) === true;
  }
}

afterEach(async () => {
  vi.useRealTimers();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

describe("local runtime", () => {
  it("starts the selected pinned Nemotron runtime", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "undertone-nemotron-runtime-"));
    temporaryDirectories.push(root);
    const executable = path.join(root, "external", "nemo-speech.exe");
    await touch(executable);
    await touch(path.join(root, "models", LOCAL_NEMOTRON_STT_MODEL));
    const previous = process.env.UNDERTONE_NEMO_SPEECH_EXE;
    process.env.UNDERTONE_NEMO_SPEECH_EXE = executable;
    try {
      const host = new FakeHost();
      const runtime = createNemotronSttRuntime(host, root, {
        fetch: readyFetch,
        build: () => "cpu",
      });
      await runtime.load();
      expect((await runtime.status()).build).toBe("cpu");
      expect(host.starts[0]?.file).toBe(executable);
      expect(host.starts[0]?.argumentsValue).toContain("serve");
      expect(host.starts[0]?.argumentsValue).toContain("--device cpu");
      expect(host.starts[0]?.argumentsValue).not.toContain("--endpointing");
      expect(host.starts[0]?.argumentsValue).toContain(LOCAL_NEMOTRON_STT_MODEL);
      await runtime.shutdown();
    } finally {
      if (previous === undefined) delete process.env.UNDERTONE_NEMO_SPEECH_EXE;
      else process.env.UNDERTONE_NEMO_SPEECH_EXE = previous;
    }
  });

  it("discovers a managed Nemotron runtime installed after startup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "undertone-nemotron-late-install-"));
    temporaryDirectories.push(root);
    const previousLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(root, "legacy-root");
    try {
      const host = new FakeHost();
      const runtime = createNemotronSttRuntime(host, root, {
        fetch: readyFetch,
        build: () => "cpu",
      });
      const managed = path.join(root, "runtime", "nemotron");
      await touch(path.join(managed, "nemo-speech.exe"));
      await touch(path.join(managed, "undertone-nemotron-cpu.txt"));
      await touch(path.join(root, "models", LOCAL_NEMOTRON_STT_MODEL));

      await runtime.load();
      expect(host.starts[0]?.file).toBe(path.join(managed, "nemo-speech.exe"));
      expect(host.starts[0]?.argumentsValue).toContain("--device cpu");
      await runtime.shutdown();
    } finally {
      if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previousLocalAppData;
    }
  });

  it("starts, reuses, and ejects the installed CPU STT runtime", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });

    await runtime.load();
    const baseUrl = await runtime.withServer("wait", (url) => url);
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(host.starts).toHaveLength(1);
    expect(host.starts[0]?.file).toBe(path.join(root, "runtime", "cpu", "whisper-server.exe"));
    expect(host.starts[0]?.argumentsValue).toContain(LOCAL_STT_MODEL);
    expect(host.starts[0]?.argumentsValue).toContain(LOCAL_VAD_MODEL);
    expect(await runtime.withServer("wait", (url) => url)).toBe(baseUrl);
    expect(host.starts).toHaveLength(1);

    await runtime.eject();
    expect(await runtime.withServer("fallback", () => "used")).toBeNull();
    expect(host.stopped).toContain(host.starts[0]?.processId);
  });

  it("falls back to CPU and skips further CUDA attempts in the same session", async () => {
    const root = await installedRoot("stt", true);
    const host = new FakeHost();
    host.failCuda = true;
    const notices: string[] = [];
    const runtime = createLocalSttRuntime(host, root, {
      fetch: readyFetch,
      onNotice: (message) => notices.push(message),
    });

    await runtime.load();
    expect(host.starts.map((start) => path.basename(path.dirname(start.file))))
      .toEqual(["cuda", "cpu"]);
    expect(notices).toEqual(["GPU transcription failed — using CPU (slower)."]);
    await runtime.eject();
    await runtime.load();
    expect(host.starts.map((start) => path.basename(path.dirname(start.file))))
      .toEqual(["cuda", "cpu", "cpu"]);
    expect(notices).toEqual(["GPU transcription failed — using CPU (slower)."]);
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

    expect(await runtime.withServer("fallback", () => "used")).toBeNull();
    runtime.warm();
    runtime.warm();
    expect(await runtime.withServer("fallback", () => "used")).toBeNull();
    await waitUntil(() => host.starts.length === 1);
    release?.();
    await runtime.load();
    expect(host.starts).toHaveLength(1);

    const firstProcess = host.starts[0]?.processId;
    if (firstProcess !== undefined) host.running.set(firstProcess, false);
    runtime.warm();
    await waitUntil(() => host.starts.length === 2);
    await runtime.shutdown();
  });

  it("loads Qwen3.8 cleanup with reasoning disabled", async () => {
    const root = await installedRoot("cleanup");
    const host = new FakeHost();
    const runtime = createLocalCleanupRuntime(host, root, {
      fetch: readyFetch,
    });

    await runtime.load();
    expect(host.starts[0]?.argumentsValue).toContain(LOCAL_CLEANUP_MODEL);
    expect(host.starts[0]?.argumentsValue).toContain("--reasoning off");
    await runtime.shutdown();
  });

  it("never posts to a stale cleanup process and starts only one replacement warm", async () => {
    const root = await installedRoot("cleanup");
    const host = new FakeHost();
    let blockReadiness = false;
    const readiness = deferred();
    const runtime = createLocalCleanupRuntime(host, root, {
      fetch: async () => {
        if (blockReadiness) await readiness.promise;
        return { status: 200 };
      },
    });
    await runtime.load();
    const firstProcess = host.starts[0]!.processId;
    host.running.set(firstProcess, false);
    blockReadiness = true;
    const posted: string[] = [];
    const cleaner = new CleanupClient({
      async post(url) {
        posted.push(url);
        return {
          status: 200,
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ text: "cleaned" }) } }],
          }),
        };
      },
    }, runtime);

    expect(await Promise.all([
      cleaner.cleanup(localCleanupOptions("words")),
      cleaner.cleanup(localCleanupOptions("words")),
    ])).toEqual([null, null]);
    await waitUntil(() => host.starts.length === 2);
    expect(posted).toEqual([]);
    expect(host.starts).toHaveLength(2);
    readiness.resolve();
    await runtime.load();
    await runtime.shutdown();
  });

  it("waits for STT and restarts a dead cached process before posting", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    host.running.set(host.starts[0]!.processId, false);
    const posted: string[] = [];
    const transcriber = new Transcriber({
      async post(url) {
        posted.push(url);
        return { status: 200, body: JSON.stringify({ text: " restarted  okay " }) };
      },
    }, createLocalSttRouter(runtime, runtime));

    expect(await transcriber.transcribe({
      wav: new Uint8Array(64),
      apiKey: "",
      provider: "local",
      language: "en",
    })).toBe("restarted okay");
    expect(host.starts).toHaveLength(2);
    expect(posted).toHaveLength(1);
    await runtime.shutdown();
  });

  it("keeps long and overlapping uses alive, then grants a full idle period", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    runtime.setIdleTimeout(0.05);
    const first = deferred();
    const second = deferred();
    const firstUse = runtime.withServer("wait", async () => await first.promise);
    const secondUse = runtime.withServer("wait", async () => await second.promise);

    await delayForTest(100);
    expect(host.stopped).toEqual([]);
    first.resolve();
    await firstUse;
    await delayForTest(100);
    expect(host.stopped).toEqual([]);
    second.resolve();
    await secondUse;
    await waitUntil(() => host.stopped.length === 1);
  });

  it("releases a throwing callback for idle eviction", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    runtime.setIdleTimeout(0.05);
    await expect(runtime.withServer("wait", () => {
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    await waitUntil(() => host.stopped.length === 1);
  });

  it.each(["eject", "shutdown"] as const)(
    "lets an active callback finish before %s stops its process",
    async (action) => {
      const root = await installedRoot("stt");
      const host = new FakeHost();
      const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
      await runtime.load();
      const callback = deferred();
      const entered = deferred();
      const use = runtime.withServer("wait", async () => {
        entered.resolve();
        await callback.promise;
      });
      await entered.promise;
      const stopping = runtime[action]();
      await delayForTest(25);
      expect(host.stopped).toEqual([]);
      callback.resolve();
      await Promise.all([use, stopping]);
      expect(host.stopped).toEqual([host.starts[0]!.processId]);
    },
  );

  it.each(["eject", "shutdown"] as const)(
    "does not restart a runtime when warm is called during %s",
    async (action) => {
      const root = await installedRoot("cleanup");
      const host = new FakeHost();
      const runtime = createLocalCleanupRuntime(host, root, { fetch: readyFetch });
      await runtime.load();
      const stopping = deferred();
      const releaseStop = deferred();
      host.stopSupervised = async (processId) => {
        host.stopped.push(processId);
        stopping.resolve();
        await releaseStop.promise;
        host.running.set(processId, false);
        return true;
      };

      const ejecting = runtime[action]();
      await stopping.promise;
      runtime.warm();
      releaseStop.resolve();
      await ejecting;
      await delayForTest(100);

      expect(host.starts).toHaveLength(1);
    },
  );

  it("does not acquire a stale server across the liveness-to-use await gap", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    const staleProcess = host.starts[0]!.processId;
    const checked = deferred();
    const releaseCheck = deferred();
    let block = true;
    host.runningCheck = async (processId) => {
      if (block && processId === staleProcess) {
        checked.resolve();
        await releaseCheck.promise;
      }
      return host.running.get(processId) === true;
    };
    const usedProcessCounts: number[] = [];
    const use = runtime.withServer("wait", () => {
      usedProcessCounts.push(host.starts.length);
    });
    await checked.promise;
    const eject = runtime.eject();
    block = false;
    releaseCheck.resolve();
    await eject;
    await use;
    expect(usedProcessCounts).toEqual([2]);
    await runtime.shutdown();
  });

  it("reports a dead process as unloaded", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    host.running.set(host.starts[0]!.processId, false);
    expect(await runtime.status()).toMatchObject({ loaded: false, build: null });
    await runtime.shutdown();
  });

  it("waits for supervised process death before resolving eject", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    const processId = host.starts[0]!.processId;
    host.runningCheck = async () => host.running.get(processId) === true;
    const originalStop = host.stopSupervised.bind(host);
    host.stopSupervised = async (stoppedProcessId) => {
      host.stopped.push(stoppedProcessId);
      return true;
    };
    let settled = false;
    const eject = runtime.eject().then(() => { settled = true; });
    await delayForTest(75);
    expect(settled).toBe(false);
    host.running.set(processId, false);
    await eject;
    expect(settled).toBe(true);
    host.stopSupervised = originalStop;
  });

  it("retries transient liveness-query failures until process death is confirmed", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    let queries = 0;
    host.runningCheck = async (processId) => {
      queries += 1;
      if (queries < 3) throw new Error("host query timed out");
      return host.running.get(processId) === true;
    };

    await runtime.eject();
    expect(queries).toBe(3);
  });

  it("rejects persistent unknown liveness and retains the process for retry", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    host.runningCheck = async () => { throw new Error("host unavailable"); };
    vi.useFakeTimers();
    try {
      const rejection = expect(runtime.eject()).rejects.toThrow("did not stop");
      await vi.advanceTimersByTimeAsync(5_100);
      await rejection;
    } finally {
      vi.useRealTimers();
    }

    host.runningCheck = async (processId) => host.running.get(processId) === true;
    await runtime.eject();
    expect(host.stopped).toEqual([
      host.starts[0]!.processId,
      host.starts[0]!.processId,
    ]);
  });

  it("contains an idle-stop failure and retains the process for retry", async () => {
    const root = await installedRoot("stt");
    const host = new FakeHost();
    const runtime = createLocalSttRuntime(host, root, { fetch: readyFetch });
    await runtime.load();
    host.runningCheck = async () => { throw new Error("host unavailable"); };
    vi.useFakeTimers();
    try {
      runtime.setIdleTimeout(0.05);
      await vi.advanceTimersByTimeAsync(5_200);
    } finally {
      vi.useRealTimers();
    }

    host.runningCheck = async (processId) => host.running.get(processId) === true;
    await runtime.eject();
    expect(host.stopped).toEqual([
      host.starts[0]!.processId,
      host.starts[0]!.processId,
    ]);
  });

  it("quotes Windows arguments", () => {
    expect(quoteWindowsArgument("plain")).toBe("plain");
    expect(quoteWindowsArgument("C:\\Model Files\\model.bin"))
      .toBe('"C:\\Model Files\\model.bin"');
    expect(quoteWindowsArgument('ends with slash\\')).toBe('"ends with slash\\\\"');
  });

  it.skipIf(process.env.UNDERTONE_LOCAL_RUNTIME_E2E !== "1")(
    "runs inference through installed Whisper, Nemotron, and cleanup servers",
    async () => {
      const localAppData = process.env.LOCALAPPDATA;
      if (localAppData === undefined) throw new Error("LOCALAPPDATA is unavailable");
      const root = path.join(localAppData, "Undertone");
      const host = new WindowsHost({ requestTimeoutMs: 5_000 });
      const installer = new LocalInstaller(host, root);
      const externalNemotron = process.env.UNDERTONE_NEMOTRON_RUNTIME_E2E_EXE?.trim();
      const usesExternalNemotron = externalNemotron !== undefined
        && externalNemotron.length > 0;
      const priorNemotronExecutable = process.env.UNDERTONE_NEMO_SPEECH_EXE;
      if (usesExternalNemotron) process.env.UNDERTONE_NEMO_SPEECH_EXE = externalNemotron;
      const stt = createLocalSttRuntime(host, root, {
        isInstalled: () => installer.isInstalled("stt"),
      });
      const nemotronBuild = usesExternalNemotron
        ? "cpu"
        : installer.installedNemotronBuild();
      if (nemotronBuild === null) {
        throw new Error("The managed Nemotron runtime is not installed");
      }
      const nemotron = createNemotronSttRuntime(host, root, {
        isInstalled: () => usesExternalNemotron
          || installer.installedNemotronBuild() !== null,
        build: () => nemotronBuild,
      });
      const cleanup = createLocalCleanupRuntime(host, root, {
        isInstalled: () => installer.isInstalled("cleanup"),
      });
      try {
        await host.start();
        expect(stt.isInstalled()).toBe(true);
        await stt.load();
        expect((await stt.status()).build).toMatch(/^(cpu|cuda)$/u);
        const http = new FetchHttpClient();
        const transcriber = new Transcriber(http, createLocalSttRouter(stt, stt));
        const silence = new Uint8Array(encodePcm16Wav(new Float32Array(8_000), 16_000));
        expect(await transcriber.transcribe({
          wav: silence,
          apiKey: "",
          provider: "local",
          language: "en",
        })).toBe("");
        await stt.eject();

        expect(nemotron.isInstalled()).toBe(true);
        await nemotron.load();
        expect((await nemotron.status()).build).toBe(nemotronBuild);
        const liveFailures: Error[] = [];
        const liveSession = new NemotronLiveTranscriber(nemotron).start("en", {
          partial: () => undefined,
          failed: (error) => liveFailures.push(error),
        });
        liveSession.append(new Uint8Array(32_000));
        expect(await liveSession.finish()).toBe("");
        expect(liveFailures).toEqual([]);
        const nemotronTranscriber = new Transcriber(
          http,
          createLocalSttRouter(stt, nemotron),
        );
        expect(await nemotronTranscriber.transcribe({
          wav: silence,
          apiKey: "",
          provider: "local",
          localEngine: "nemotron",
          language: "en",
        })).toBe("");
        await nemotron.eject();

        expect(cleanup.isInstalled()).toBe(true);
        await cleanup.load();
        expect((await cleanup.status()).build).toMatch(/^(cpu|cuda)$/u);
        const cleaner = new CleanupClient(http, cleanup);
        expect(await cleaner.cleanup({
          transcript: "um hello there",
          apiKey: "",
          provider: "local",
          timeoutSeconds: 10,
          reasoningEffort: "none",
          serviceTier: "priority",
        })).not.toBeNull();
      } finally {
        await cleanup.shutdown();
        await nemotron.shutdown();
        await stt.shutdown();
        await host.stop();
        if (priorNemotronExecutable === undefined) {
          delete process.env.UNDERTONE_NEMO_SPEECH_EXE;
        } else {
          process.env.UNDERTONE_NEMO_SPEECH_EXE = priorNemotronExecutable;
        }
      }
    },
    240_000,
  );
});

function localCleanupOptions(transcript: string) {
  return {
    transcript,
    apiKey: "",
    provider: "local" as const,
    timeoutSeconds: 2.5,
    reasoningEffort: "none" as const,
    serviceTier: "priority" as const,
  };
}

async function installedRoot(
  kind: "stt" | "cleanup",
  cuda = false,
): Promise<string> {
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

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  return {
    promise,
    resolve: resolvePromise,
  };
}

async function delayForTest(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
