import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "./localRuntime";
import type { LocalEngineKind } from "../shared/settings";

export interface InstallArtifact {
  url: string;
  sha256: string;
  size: number;
}

interface LocalInstallHost {
  extractSubset(
    zipFiles: readonly string[],
    patterns: readonly string[],
    targetDirectory: string,
  ): Promise<number>;
}

export interface InstallProgress {
  phase: string;
  fraction: number;
}

export type InstallProgressListener = (progress: InstallProgress) => void;
export type InstallFetch = typeof fetch;

const WHISPER_RELEASE = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1";
const LLAMA_RELEASE = "https://github.com/ggml-org/llama.cpp/releases/download/b10064";

export const STT_ARTIFACTS = {
  cpu_runtime: {
    url: `${WHISPER_RELEASE}/whisper-bin-x64.zip`,
    sha256: "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
    size: 7_982_101,
  },
  cuda_runtime: {
    url: `${WHISPER_RELEASE}/whisper-cublas-12.4.0-bin-x64.zip`,
    sha256: "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
    size: 677_887_125,
  },
  model: {
    url: `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${LOCAL_STT_MODEL}`,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    size: 1_624_555_275,
  },
  vad_model: {
    url: `https://huggingface.co/ggml-org/whisper-vad/resolve/main/${LOCAL_VAD_MODEL}`,
    sha256: "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
    size: 885_098,
  },
} as const satisfies Record<string, InstallArtifact>;

export const CLEANUP_ARTIFACTS = {
  cpu_runtime: {
    url: `${LLAMA_RELEASE}/llama-b10064-bin-win-cpu-x64.zip`,
    sha256: "c9b770b584a007a1aeea1b729e0e4724fb79a2cb136ece46be92704aaee5099e",
    size: 18_007_056,
  },
  cuda_runtime: {
    url: `${LLAMA_RELEASE}/llama-b10064-bin-win-cuda-12.4-x64.zip`,
    sha256: "d3df8c73874d9bf00cb3631a902a6afea556d57f11cb226e165689be9aa9e34b",
    size: 249_038_000,
  },
  cudart: {
    url: `${LLAMA_RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip`,
    sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    size: 391_443_627,
  },
  model: {
    url: `https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/${LOCAL_CLEANUP_MODEL}`,
    sha256: "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
    size: 2_497_281_120,
  },
} as const satisfies Record<string, InstallArtifact>;

const STT_SUBSET = {
  cpu: ["whisper-server.exe", "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-*.dll"],
  cuda: [
    "whisper-server.exe", "whisper.dll", "ggml.dll", "ggml-base.dll",
    "ggml-cpu-*.dll", "ggml-cuda.dll", "cublas64_12.dll", "cublasLt64_12.dll",
    "cudart64_12.dll", "nvrtc64_120_0.dll", "nvrtc-builtins64_124.dll",
  ],
} as const;

const CLEANUP_SUBSET = {
  cpu: [
    "llama-server.exe", "llama-server-impl.dll", "llama-common.dll", "llama.dll",
    "mtmd.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-*.dll", "libomp140*.dll",
  ],
  cuda: [
    "llama-server.exe", "llama-server-impl.dll", "llama-common.dll", "llama.dll",
    "mtmd.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-*.dll", "libomp140*.dll",
    "ggml-cuda.dll", "cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll",
  ],
} as const;

export class LocalInstaller {
  private readonly installs = new Map<LocalEngineKind, Promise<void>>();

  constructor(
    private readonly host: LocalInstallHost,
    private readonly root: string,
    private readonly fetcher: InstallFetch = fetch,
    private readonly systemRoot = process.env.SystemRoot ?? "C:\\Windows",
  ) {}

  installSize(kind: LocalEngineKind): number {
    const runtime = path.join(this.root, "runtime");
    const models = path.join(this.root, "models");
    const gpu = this.hasNvidiaGpu();
    if (kind === "stt") {
      let bytes = 0;
      if (!existsSync(path.join(runtime, "cpu", "whisper-server.exe"))) {
        bytes += STT_ARTIFACTS.cpu_runtime.size;
      }
      if (gpu && !existsSync(path.join(runtime, "cuda", "whisper-server.exe"))) {
        bytes += STT_ARTIFACTS.cuda_runtime.size;
      }
      if (!existsSync(path.join(models, LOCAL_STT_MODEL))) bytes += STT_ARTIFACTS.model.size;
      if (!existsSync(path.join(models, LOCAL_VAD_MODEL))) bytes += STT_ARTIFACTS.vad_model.size;
      return bytes;
    }
    let bytes = 0;
    if (!existsSync(path.join(runtime, "llm-cpu", "llama-server.exe"))) {
      bytes += CLEANUP_ARTIFACTS.cpu_runtime.size;
    }
    if (gpu && !existsSync(path.join(runtime, "llm-cuda", "llama-server.exe"))) {
      bytes += CLEANUP_ARTIFACTS.cuda_runtime.size + CLEANUP_ARTIFACTS.cudart.size;
    }
    if (!existsSync(path.join(models, LOCAL_CLEANUP_MODEL))) {
      bytes += CLEANUP_ARTIFACTS.model.size;
    }
    return bytes;
  }

  async install(kind: LocalEngineKind, progress: InstallProgressListener): Promise<void> {
    const existing = this.installs.get(kind);
    if (existing !== undefined) return await existing;
    const operation = kind === "stt"
      ? this.installStt(progress)
      : this.installCleanup(progress);
    this.installs.set(kind, operation);
    try {
      await operation;
    } finally {
      if (this.installs.get(kind) === operation) this.installs.delete(kind);
    }
  }

  private async installStt(progress: InstallProgressListener): Promise<void> {
    await this.prepare("stt");
    const runtime = path.join(this.root, "runtime");
    const models = path.join(this.root, "models");
    await this.installBuild(
      STT_ARTIFACTS.cpu_runtime,
      path.join(runtime, "cpu.zip"),
      path.join(runtime, "cpu"),
      STT_SUBSET.cpu,
      progress,
    );
    const wantCuda = this.hasNvidiaGpu();
    if (wantCuda) {
      await this.installBuild(
        STT_ARTIFACTS.cuda_runtime,
        path.join(runtime, "cuda.zip"),
        path.join(runtime, "cuda"),
        STT_SUBSET.cuda,
        progress,
      );
    }
    await this.installModel(
      STT_ARTIFACTS.model,
      path.join(models, LOCAL_STT_MODEL),
      progress,
    );
    await this.installModel(
      STT_ARTIFACTS.vad_model,
      path.join(models, LOCAL_VAD_MODEL),
      progress,
    );
  }

  private async installCleanup(progress: InstallProgressListener): Promise<void> {
    await this.prepare("cleanup");
    const runtime = path.join(this.root, "runtime");
    const models = path.join(this.root, "models");
    await this.installBuild(
      CLEANUP_ARTIFACTS.cpu_runtime,
      path.join(runtime, "llm-cpu_runtime.zip"),
      path.join(runtime, "llm-cpu"),
      CLEANUP_SUBSET.cpu,
      progress,
    );
    const wantCuda = this.hasNvidiaGpu();
    if (wantCuda && !existsSync(path.join(runtime, "llm-cuda", "llama-server.exe"))) {
      const engineZip = path.join(runtime, "llm-cuda_runtime.zip");
      const cudartZip = path.join(runtime, "llm-cudart.zip");
      await downloadPinnedArtifact(CLEANUP_ARTIFACTS.cuda_runtime, engineZip, this.fetcher,
        (fraction) => progress({ phase: "Downloading engine", fraction }));
      await downloadPinnedArtifact(CLEANUP_ARTIFACTS.cudart, cudartZip, this.fetcher,
        (fraction) => progress({ phase: "Downloading engine", fraction }));
      progress({ phase: "Installing engine", fraction: 0 });
      await this.host.extractSubset(
        [engineZip, cudartZip],
        CLEANUP_SUBSET.cuda,
        path.join(runtime, "llm-cuda"),
      );
      progress({ phase: "Installing engine", fraction: 1 });
      await rm(engineZip, { force: true });
      await rm(cudartZip, { force: true });
    }
    await this.installModel(
      CLEANUP_ARTIFACTS.model,
      path.join(models, LOCAL_CLEANUP_MODEL),
      progress,
    );
  }

  private async prepare(kind: LocalEngineKind): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "runtime"), { recursive: true });
    await mkdir(path.join(this.root, "models"), { recursive: true });
    const runtime = path.join(this.root, "runtime");
    const pendingCudaBytes = this.hasNvidiaGpu()
      ? kind === "stt"
        ? existsSync(path.join(runtime, "cuda", "whisper-server.exe"))
          ? 0
          : STT_ARTIFACTS.cuda_runtime.size
        : existsSync(path.join(runtime, "llm-cuda", "llama-server.exe"))
          ? 0
          : CLEANUP_ARTIFACTS.cuda_runtime.size + CLEANUP_ARTIFACTS.cudart.size
      : 0;
    const required = BigInt(this.installSize(kind))
      + BigInt(pendingCudaBytes)
      + BigInt(200 << 20);
    const disk = await statfs(this.root, { bigint: true });
    const free = disk.bavail * disk.bsize;
    if (free < required) {
      const gib = Number(required) / (1 << 30);
      throw new Error(`Not enough disk space — needs about ${gib.toFixed(1)} GB free.`);
    }
  }

  private async installBuild(
    artifact: InstallArtifact,
    archive: string,
    target: string,
    patterns: readonly string[],
    progress: InstallProgressListener,
  ): Promise<void> {
    const serverName = path.basename(target).startsWith("llm-")
      ? "llama-server.exe"
      : "whisper-server.exe";
    if (existsSync(path.join(target, serverName))) return;
    await downloadPinnedArtifact(artifact, archive, this.fetcher,
      (fraction) => progress({ phase: "Downloading engine", fraction }));
    progress({ phase: "Installing engine", fraction: 0 });
    await this.host.extractSubset([archive], patterns, target);
    progress({ phase: "Installing engine", fraction: 1 });
    await rm(archive, { force: true });
  }

  private async installModel(
    artifact: InstallArtifact,
    target: string,
    progress: InstallProgressListener,
  ): Promise<void> {
    if (existsSync(target)) return;
    await downloadPinnedArtifact(artifact, target, this.fetcher,
      (fraction) => progress({ phase: "Downloading model", fraction }));
  }

  private hasNvidiaGpu(): boolean {
    return existsSync(path.join(this.systemRoot, "System32", "nvcuda.dll"));
  }
}

export async function downloadPinnedArtifact(
  artifact: InstallArtifact,
  destination: string,
  fetcher: InstallFetch = fetch,
  progress: (fraction: number) => void = () => undefined,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  await rm(partial, { force: true });
  const controller = new AbortController();
  const connectTimer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetcher(artifact.url, { signal: controller.signal });
  } catch (error) {
    throw new Error("Download failed — check your internet connection and retry.", {
      cause: error,
    });
  } finally {
    clearTimeout(connectTimer);
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error("Download failed — check your internet connection and retry.");
  }

  const digest = createHash("sha256");
  const output = createWriteStream(partial, { flags: "wx" });
  const reader = response.body.getReader();
  let received = 0;
  try {
    while (true) {
      const chunk = await readWithTimeout(reader, controller, 60_000);
      if (chunk.done) break;
      digest.update(chunk.value);
      received += chunk.value.byteLength;
      if (!output.write(chunk.value)) await once(output, "drain");
      progress(Math.min(1, received / artifact.size));
    }
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    controller.abort();
    await rm(partial, { force: true });
    throw new Error("Download failed — check your internet connection and retry.", {
      cause: error,
    });
  }
  if (received !== artifact.size || digest.digest("hex") !== artifact.sha256) {
    await rm(partial, { force: true });
    throw new Error("A downloaded file failed verification — retry the download.");
  }
  try {
    await rm(destination, { force: true });
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  progress(1);
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  controller: AbortController,
  timeoutMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error("Download read timed out"));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
