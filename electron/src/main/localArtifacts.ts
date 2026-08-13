import { existsSync, lstatSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_NEMOTRON_STT_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "../shared/models";
import type {
  LocalEngineKind,
  LocalRuntimeBuild,
  LocalSttEngineId,
} from "../shared/settings";

export interface InstallArtifact {
  url: string;
  sha256: string;
  size: number;
}

export interface RequiredOutput {
  pattern: string;
  size?: number;
}

export interface LocalArtifactComponent {
  id: string;
  kind: LocalEngineKind;
  applicable: boolean;
  format: "archive" | "file";
  artifacts: readonly InstallArtifact[];
  target: string;
  requiredOutputs: readonly RequiredOutput[];
  workspaceBytes: number;
  sttEngine?: LocalSttEngineId;
  build?: LocalRuntimeBuild;
}

const WHISPER_RELEASE = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1";
const LLAMA_RELEASE = "https://github.com/ggml-org/llama.cpp/releases/download/b10064";
const NEMOTRON_RELEASE = "https://github.com/Byntham/Undertone/releases/download/nemotron-runtime-v0.1.0";

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

export const NEMOTRON_ARTIFACTS = {
  cpu_runtime: {
    url: `${NEMOTRON_RELEASE}/undertone-nemotron-runtime-0.1.0-windows-x64-cpu.zip`,
    sha256: "10dd90d5fb07f9896de79b65ccad1117216de14642112ad8ff1b59e8378721d4",
    size: 4_608_018,
  },
  cuda_runtime: {
    url: `${NEMOTRON_RELEASE}/undertone-nemotron-runtime-0.1.0-windows-x64-cuda.zip`,
    sha256: "6dfa36ec91f8832dbb063099d93710373e94de7d10f461fcf68c8dd73d92b49a",
    size: 739_233_685,
  },
  model: {
    url: `https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b/resolve/main/${LOCAL_NEMOTRON_STT_MODEL}`,
    sha256: "d9a01898d2a611c8764e23a1c2f45e70bbd5a425dc4de93692ac951dd603812d",
    size: 699_872_960,
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

const NEMOTRON_SUBSET = {
  common: [
    "nemo-speech.exe", "nemo_speech_asr.dll", "nemo_speech_asr_c.dll",
    "ggml.dll", "ggml-base.dll", "ggml-cpu.dll", "abseil_dll.dll",
    "libprotobuf.dll", "msvcp140.dll", "vcruntime140.dll",
    "vcruntime140_1.dll", "vcomp140.dll", "LICENSE-*.txt",
    "NOTICE-*.txt", "THIRD-PARTY-NOTICES.md",
  ],
  cpu: ["undertone-nemotron-cpu.txt"],
  cuda: [
    "ggml-cuda.dll", "cublas64_12.dll", "cublasLt64_12.dll",
    "cudart64_12.dll", "undertone-nemotron-cuda.txt",
  ],
} as const;

const MIB = 1024 * 1024;
const EXTRACTION_WORKSPACE = {
  sttCpu: 64 * MIB,
  sttCuda: 2_048 * MIB,
  cleanupCpu: 128 * MIB,
  cleanupCuda: 2_048 * MIB,
  nemotronCpu: 128 * MIB,
  nemotronCuda: 1_280 * MIB,
} as const;

export function createLocalArtifactPlan(root: string, hasNvidiaGpu: boolean): readonly LocalArtifactComponent[] {
  return [
    archive(
      "stt-cpu", "stt", true, [STT_ARTIFACTS.cpu_runtime],
      path.join(root, "runtime", "cpu"), STT_SUBSET.cpu, EXTRACTION_WORKSPACE.sttCpu,
      "whisper", "cpu",
    ),
    archive(
      "stt-cuda", "stt", hasNvidiaGpu, [STT_ARTIFACTS.cuda_runtime],
      path.join(root, "runtime", "cuda"), STT_SUBSET.cuda, EXTRACTION_WORKSPACE.sttCuda,
      "whisper", "cuda",
    ),
    file("stt-model", "stt", STT_ARTIFACTS.model, path.join(root, "models", LOCAL_STT_MODEL), "whisper"),
    file("stt-vad", "stt", STT_ARTIFACTS.vad_model, path.join(root, "models", LOCAL_VAD_MODEL), "whisper"),
    archive(
      "nemotron-cpu", "stt", true, [NEMOTRON_ARTIFACTS.cpu_runtime],
      path.join(root, "runtime", "nemotron"),
      [...NEMOTRON_SUBSET.common, ...NEMOTRON_SUBSET.cpu],
      EXTRACTION_WORKSPACE.nemotronCpu, "nemotron", "cpu",
    ),
    archive(
      "nemotron-cuda", "stt", true, [NEMOTRON_ARTIFACTS.cuda_runtime],
      path.join(root, "runtime", "nemotron"),
      [...NEMOTRON_SUBSET.common, ...NEMOTRON_SUBSET.cuda],
      EXTRACTION_WORKSPACE.nemotronCuda, "nemotron", "cuda",
    ),
    file(
      "nemotron-model", "stt", NEMOTRON_ARTIFACTS.model,
      path.join(root, "models", LOCAL_NEMOTRON_STT_MODEL), "nemotron",
    ),
    archive(
      "cleanup-cpu", "cleanup", true, [CLEANUP_ARTIFACTS.cpu_runtime],
      path.join(root, "runtime", "llm-cpu"), CLEANUP_SUBSET.cpu,
      EXTRACTION_WORKSPACE.cleanupCpu,
    ),
    archive(
      "cleanup-cuda", "cleanup", hasNvidiaGpu,
      [CLEANUP_ARTIFACTS.cuda_runtime, CLEANUP_ARTIFACTS.cudart],
      path.join(root, "runtime", "llm-cuda"), CLEANUP_SUBSET.cuda,
      EXTRACTION_WORKSPACE.cleanupCuda,
    ),
    file("cleanup-model", "cleanup", CLEANUP_ARTIFACTS.model, path.join(root, "models", LOCAL_CLEANUP_MODEL)),
  ];
}

function archive(
  id: string,
  kind: LocalEngineKind,
  applicable: boolean,
  artifacts: readonly InstallArtifact[],
  target: string,
  patterns: readonly string[],
  workspaceBytes: number,
  sttEngine?: LocalSttEngineId,
  build?: LocalRuntimeBuild,
): LocalArtifactComponent {
  return {
    id,
    kind,
    applicable,
    format: "archive",
    artifacts,
    target,
    requiredOutputs: patterns.map((pattern) => ({ pattern })),
    workspaceBytes,
    ...(sttEngine === undefined ? {} : { sttEngine }),
    ...(build === undefined ? {} : { build }),
  };
}

function file(
  id: string,
  kind: LocalEngineKind,
  artifact: InstallArtifact,
  target: string,
  sttEngine?: LocalSttEngineId,
): LocalArtifactComponent {
  return {
    id,
    kind,
    applicable: true,
    format: "file",
    artifacts: [artifact],
    target,
    requiredOutputs: [{ pattern: path.basename(target), size: artifact.size }],
    workspaceBytes: 0,
    ...(sttEngine === undefined ? {} : { sttEngine }),
  };
}

interface ComponentReceipt {
  schema: 1;
  identity: string;
  provenance: "pinned" | "legacy";
}

export function componentIdentity(component: LocalArtifactComponent): string {
  return createHash("sha256").update(JSON.stringify({
    id: component.id,
    kind: component.kind,
    format: component.format,
    artifacts: component.artifacts,
    outputs: component.requiredOutputs,
  })).digest("hex");
}

export function componentOutputsExist(component: LocalArtifactComponent): boolean {
  if (component.format === "file") {
    const output = component.requiredOutputs[0];
    if (output === undefined || output.size === undefined || !existsSync(component.target)) return false;
    try {
      const status = statSync(component.target);
      return status.isFile() && status.size === output.size;
    } catch {
      return false;
    }
  }
  if (!existsSync(component.target)) return false;
  let entries: string[];
  try {
    entries = readdirSync(component.target);
  } catch {
    return false;
  }
  return component.requiredOutputs.every(({ pattern }) => {
    const expression = new RegExp(`^${escapeRegex(pattern).replace(/\*/gu, ".*")}$`, "iu");
    return entries.some((entry) => {
      if (!expression.test(entry)) return false;
      try {
        return lstatSync(path.join(component.target, entry)).isFile();
      } catch {
        return false;
      }
    });
  });
}

export function receiptPath(root: string, component: LocalArtifactComponent): string {
  return path.join(root, ".install-receipts", `${component.id}.json`);
}

export function isComponentCurrent(
  root: string,
  component: LocalArtifactComponent,
  adoptLegacy = true,
): boolean {
  const receipt = readReceipt(receiptPath(root, component));
  if (receipt !== null) {
    return receipt.identity === componentIdentity(component) && componentOutputsExist(component);
  }
  const receiptExists = existsSync(receiptPath(root, component));
  if (!receiptExists && adoptLegacy && componentOutputsExist(component)) {
    try {
      writeComponentReceipt(root, component, "legacy");
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function writeComponentReceipt(
  root: string,
  component: LocalArtifactComponent,
  provenance: ComponentReceipt["provenance"] = "pinned",
): void {
  const destination = receiptPath(root, component);
  mkdirSync(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  const receipt: ComponentReceipt = {
    schema: 1,
    identity: componentIdentity(component),
    provenance,
  };
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readReceipt(file: string): ComponentReceipt | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<ComponentReceipt>;
    if (candidate.schema !== 1
      || typeof candidate.identity !== "string"
      || (candidate.provenance !== "pinned" && candidate.provenance !== "legacy")) return null;
    return candidate as ComponentReceipt;
  } catch {
    return null;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}
