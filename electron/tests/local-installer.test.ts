import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  downloadPinnedArtifact,
  LocalInstaller,
} from "../src/main/localInstaller";
import {
  CLEANUP_ARTIFACTS,
  componentIdentity,
  componentOutputsExist,
  createLocalArtifactPlan,
  isComponentCurrent,
  NEMOTRON_ARTIFACTS,
  receiptPath,
  STT_ARTIFACTS,
  type InstallArtifact,
  type LocalArtifactComponent,
} from "../src/main/localArtifacts";
import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "../src/shared/models";
import { WindowsHost } from "../src/platform/windowsHost";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

describe("local installer", () => {
  it("rejects archive outputs that only match required filenames", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "runtime");
    await mkdir(path.join(target, "server.exe"), { recursive: true });
    await writeFile(path.join(target, "runtime.dll"), "runtime", "utf8");
    const component: LocalArtifactComponent = {
      id: "runtime",
      kind: "stt",
      applicable: true,
      format: "archive",
      artifacts: [],
      target,
      requiredOutputs: [{ pattern: "server.exe" }, { pattern: "*.dll" }],
      workspaceBytes: 0,
    };

    expect(componentOutputsExist(component)).toBe(false);
  });

  it("downloads to a partial file and promotes only verified bytes", async () => {
    const root = await temporaryDirectory();
    const destination = path.join(root, "models", "artifact.bin");
    const bytes = Buffer.from("pinned local artifact", "utf8");
    const progress: number[] = [];
    const fetcher = vi.fn(async () => new Response(bytes));

    await downloadPinnedArtifact({
      url: "https://example.invalid/artifact.bin",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }, destination, fetcher, (fraction) => progress.push(fraction));

    expect(await readFile(destination)).toEqual(bytes);
    expect(existsSync(`${destination}.part`)).toBe(false);
    expect(progress.at(-1)).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("removes unverified downloads without replacing the destination", async () => {
    const root = await temporaryDirectory();
    const destination = path.join(root, "artifact.bin");
    const existing = Buffer.from("existing verified artifact", "utf8");
    const bytes = Buffer.from("wrong bytes", "utf8");
    await writeFile(destination, existing);

    await expect(downloadPinnedArtifact({
      url: "https://example.invalid/artifact.bin",
      sha256: "0".repeat(64),
      size: bytes.byteLength,
    }, destination, async () => new Response(bytes))).rejects.toThrow(/verification/u);

    expect(await readFile(destination)).toEqual(existing);
    expect(existsSync(`${destination}.part`)).toBe(false);
  });

  it("catches asynchronous download output failures immediately", async () => {
    const root = await temporaryDirectory();
    const parent = path.join(root, "models");
    const destination = path.join(parent, "artifact.bin");
    const bytes = Buffer.from("never written", "utf8");

    await expect(downloadPinnedArtifact({
      url: "https://example.invalid/artifact.bin",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    }, destination, async () => {
      await rm(parent, { recursive: true });
      await writeFile(parent, "blocks the output directory", "utf8");
      return new Response(new ReadableStream<Uint8Array>({
        pull: () => new Promise(() => undefined),
      }));
    })).rejects.toThrow(/Download failed/u);
  });

  it("reports only missing CPU artifacts on machines without NVIDIA", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const installer = new LocalInstaller({
      extractSubset: async () => 0,
    }, root, fetch, systemRoot);

    expect(installer.installSize("stt")).toBe(
      STT_ARTIFACTS.cpu_runtime.size
      + STT_ARTIFACTS.model.size
      + STT_ARTIFACTS.vad_model.size,
    );
    expect(installer.installSize("cleanup")).toBe(
      CLEANUP_ARTIFACTS.cpu_runtime.size + CLEANUP_ARTIFACTS.model.size,
    );

    await createInstalledFiles(root);
    expect(installer.installSize("stt")).toBe(0);
    expect(installer.installSize("cleanup")).toBe(0);
    expect(JSON.parse(await readFile(
      path.join(root, ".install-receipts", "stt-cpu.json"),
      "utf8",
    ))).toMatchObject({ provenance: "legacy" });
  });

  it("includes missing CUDA archives only when an NVIDIA driver is present", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    await mkdir(path.join(systemRoot, "System32"), { recursive: true });
    await writeFile(path.join(systemRoot, "System32", "nvcuda.dll"), "fake", "utf8");
    const installer = new LocalInstaller({
      extractSubset: async () => 0,
    }, root, fetch, systemRoot);

    expect(installer.installSize("stt")).toBe(
      STT_ARTIFACTS.cpu_runtime.size
      + STT_ARTIFACTS.cuda_runtime.size
      + STT_ARTIFACTS.model.size
      + STT_ARTIFACTS.vad_model.size,
    );
    expect(installer.installSize("cleanup")).toBe(
      CLEANUP_ARTIFACTS.cpu_runtime.size
      + CLEANUP_ARTIFACTS.cuda_runtime.size
      + CLEANUP_ARTIFACTS.cudart.size
      + CLEANUP_ARTIFACTS.model.size,
    );
  });

  it("recommends NVIDIA for Nemotron but installs only the selected runtime", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    await mkdir(path.join(systemRoot, "System32"), { recursive: true });
    await writeFile(path.join(systemRoot, "System32", "nvcuda.dll"), "fake", "utf8");
    const installer = new LocalInstaller({ extractSubset: async () => 0 }, root, fetch, systemRoot);

    expect(installer.recommendedNemotronBuild()).toBe("cuda");
    expect(installer.installSize("stt", "nemotron", "cuda")).toBe(
      NEMOTRON_ARTIFACTS.cuda_runtime.size + NEMOTRON_ARTIFACTS.model.size,
    );
    expect(installer.installSize("stt", "nemotron", "cpu")).toBe(
      NEMOTRON_ARTIFACTS.cpu_runtime.size + NEMOTRON_ARTIFACTS.model.size,
    );
  });

  it("recommends CPU for Nemotron without an NVIDIA driver", async () => {
    const installer = new LocalInstaller(
      { extractSubset: async () => 0 },
      await temporaryDirectory(),
      fetch,
      await temporaryDirectory(),
    );
    expect(installer.recommendedNemotronBuild()).toBe("cpu");
  });

  it("keeps general CUDA installs available when the GPU is not a Nemotron build target", async () => {
    const installer = new LocalInstaller(
      { extractSubset: async () => 0 },
      await temporaryDirectory(),
      fetch,
      await temporaryDirectory(),
      undefined,
      true,
      false,
    );

    expect(installer.recommendedNemotronBuild()).toBe("cpu");
    expect(installer.installSize("stt", "whisper")).toBe(
      STT_ARTIFACTS.cpu_runtime.size
      + STT_ARTIFACTS.cuda_runtime.size
      + STT_ARTIFACTS.model.size
      + STT_ARTIFACTS.vad_model.size,
    );
    expect(installer.installSize("cleanup")).toBe(
      CLEANUP_ARTIFACTS.cpu_runtime.size
      + CLEANUP_ARTIFACTS.cuda_runtime.size
      + CLEANUP_ARTIFACTS.cudart.size
      + CLEANUP_ARTIFACTS.model.size,
    );
  });

  it("pins every Hugging Face artifact URL to an immutable revision", () => {
    const modelArtifacts = [
      STT_ARTIFACTS.model,
      STT_ARTIFACTS.vad_model,
      NEMOTRON_ARTIFACTS.model,
      CLEANUP_ARTIFACTS.model,
    ];
    for (const artifact of modelArtifacts) {
      expect(artifact.url).toMatch(/\/resolve\/[0-9a-f]{40}\//u);
      expect(artifact.url).not.toContain("/resolve/main/");
    }
  });

  it("keeps receipts current when only an artifact download URL changes", async () => {
    const root = await temporaryDirectory();
    const target = path.join(root, "models", "model.bin");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "model", "utf8");
    const component: LocalArtifactComponent = {
      id: "model",
      kind: "stt",
      applicable: true,
      format: "file",
      artifacts: [{
        url: `https://huggingface.co/example/model/resolve/${"a".repeat(40)}/model.bin`,
        sha256: "b".repeat(64),
        size: 5,
      }],
      target,
      requiredOutputs: [{ pattern: "model.bin", size: 5 }],
      workspaceBytes: 0,
    };
    const oldArtifacts = component.artifacts.map((artifact) => ({
      ...artifact,
      url: artifact.url.replace(/\/resolve\/[0-9a-f]{40}\//u, "/resolve/main/"),
    }));
    const oldIdentity = createHash("sha256").update(JSON.stringify({
      id: component.id,
      kind: component.kind,
      format: component.format,
      artifacts: oldArtifacts,
      outputs: component.requiredOutputs,
    })).digest("hex");
    const receipt = receiptPath(root, component);
    await mkdir(path.dirname(receipt), { recursive: true });
    await writeFile(receipt, `${JSON.stringify({
      schema: 1,
      identity: oldIdentity,
      provenance: "pinned",
    })}\n`, "utf8");

    expect(isComponentCurrent(root, component)).toBe(true);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
      identity: componentIdentity(component),
      provenance: "pinned",
    });
  });

  it("estimates download, extraction coexistence, and reserve from missing artifacts", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    await mkdir(path.join(systemRoot, "System32"), { recursive: true });
    await writeFile(path.join(systemRoot, "System32", "nvcuda.dll"), "fake", "utf8");
    const installer = new LocalInstaller({
      extractSubset: async () => 0,
    }, root, fetch, systemRoot);
    const reserve = 200 * 1024 * 1024;
    const plan = createLocalArtifactPlan(root, true);
    const workspace = (kind: "stt" | "cleanup") => plan
      .filter((component) => component.kind === kind
        && component.applicable
        && (kind !== "stt" || component.sttEngine === undefined || component.sttEngine === "whisper"))
      .reduce((total, component) => total + component.workspaceBytes, 0);

    expect(workspace("stt")).toBe((64 + 2_048) * 1024 * 1024);
    expect(workspace("cleanup")).toBe((128 + 2_048) * 1024 * 1024);

    expect(installer.requiredInstallSpace("stt")).toBe(
      installer.installSize("stt")
      + workspace("stt")
      + reserve,
    );
    expect(installer.requiredInstallSpace("cleanup")).toBe(
      installer.installSize("cleanup")
      + workspace("cleanup")
      + reserve,
    );

    await createInstalledFiles(root, true);
    expect(installer.requiredInstallSpace("stt")).toBe(reserve);
    expect(installer.requiredInstallSpace("cleanup")).toBe(reserve);
  });

  it("repairs only a component with a missing output or invalid receipt", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    await createInstalledFiles(root);
    const installer = new LocalInstaller({ extractSubset: async () => 0 }, root, fetch, systemRoot);
    expect(installer.installSize("stt")).toBe(0);

    await unlink(path.join(root, "runtime", "cpu", "whisper.dll"));
    expect(installer.installSize("stt")).toBe(STT_ARTIFACTS.cpu_runtime.size);
    await touch(path.join(root, "runtime", "cpu", "whisper.dll"));
    expect(installer.installSize("stt")).toBe(0);

    const model = createLocalArtifactPlan(root, false)
      .find((component) => component.id === "stt-model");
    expect(model).toBeDefined();
    if (model === undefined) return;
    await writeFile(receiptPath(root, model), "not json", "utf8");
    expect(installer.installSize("stt")).toBe(STT_ARTIFACTS.model.size);
    await writeFile(receiptPath(root, model), JSON.stringify({
      schema: 1,
      identity: `${componentIdentity(model)}-stale`,
      provenance: "pinned",
    }), "utf8");
    expect(installer.installSize("stt")).toBe(STT_ARTIFACTS.model.size);
  });

  it("validates staged outputs, writes receipts after promotion, and resumes components", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const runtimeBytes = Buffer.from("runtime archive", "utf8");
    const modelBytes = Buffer.from("model", "utf8");
    const runtimeArtifact = testArtifact("runtime", runtimeBytes);
    const modelArtifact = testArtifact("model", modelBytes);
    const runtimeTarget = path.join(root, "runtime", "cpu");
    const components: readonly LocalArtifactComponent[] = [
      {
        id: "stt-cpu",
        kind: "stt",
        applicable: true,
        format: "archive",
        artifacts: [runtimeArtifact],
        target: runtimeTarget,
        requiredOutputs: [{ pattern: "server.exe" }, { pattern: "runtime-*.dll" }],
        workspaceBytes: runtimeBytes.byteLength,
      },
      {
        id: "stt-model",
        kind: "stt",
        applicable: true,
        format: "file",
        artifacts: [modelArtifact],
        target: path.join(root, "models", "model.bin"),
        requiredOutputs: [{ pattern: "model.bin", size: modelBytes.byteLength }],
        workspaceBytes: 0,
      },
    ];
    const host = {
      extractSubset: async (_archives: readonly string[], _patterns: readonly string[], staged: string) => {
        expect(staged).not.toBe(runtimeTarget);
        expect(existsSync(runtimeTarget)).toBe(false);
        expect(existsSync(receiptPath(root, components[0]!))).toBe(false);
        await touch(path.join(staged, "server.exe"));
        await touch(path.join(staged, "runtime-cpu.dll"));
        return 2;
      },
    };
    const requested: string[] = [];
    let failModel = true;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      requested.push(value);
      if (value.endsWith("runtime")) return new Response(runtimeBytes);
      if (failModel) return new Response(Buffer.from("bad", "utf8"));
      return new Response(modelBytes);
    }) as typeof fetch;
    const installer = new LocalInstaller(host, root, fetcher, systemRoot, components);

    await expect(installer.install("stt", () => undefined)).rejects.toThrow(/verification/u);
    expect(existsSync(runtimeTarget)).toBe(true);
    expect(existsSync(receiptPath(root, components[0]!))).toBe(true);
    expect(existsSync(receiptPath(root, components[1]!))).toBe(false);

    failModel = false;
    await installer.install("stt", () => undefined);
    expect(existsSync(path.join(runtimeTarget, "runtime-cpu.dll"))).toBe(true);
    expect(existsSync(receiptPath(root, components[0]!))).toBe(true);
    expect(existsSync(receiptPath(root, components[1]!))).toBe(true);
    expect(requested.filter((url) => url.endsWith("runtime"))).toHaveLength(1);
    expect(requested.filter((url) => url.endsWith("model"))).toHaveLength(2);
    const requestsAfterSuccess = requested.length;
    await installer.install("stt", () => undefined);
    expect(requested).toHaveLength(requestsAfterSuccess);
  });

  it("keeps an old runtime intact when staged extraction is incomplete", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const bytes = Buffer.from("archive", "utf8");
    const target = path.join(root, "runtime", "cpu");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "server.exe"), "old", "utf8");
    await writeFile(path.join(target, "runtime-old.dll"), "old", "utf8");
    const component: LocalArtifactComponent = {
      id: "stt-cpu",
      kind: "stt",
      applicable: true,
      format: "archive",
      artifacts: [testArtifact("runtime", bytes)],
      target,
      requiredOutputs: [{ pattern: "server.exe" }, { pattern: "runtime-*.dll" }],
      workspaceBytes: bytes.byteLength,
    };
    await mkdir(path.dirname(receiptPath(root, component)), { recursive: true });
    await writeFile(receiptPath(root, component), "stale", "utf8");
    const installer = new LocalInstaller({
      extractSubset: async (_archives, _patterns, staged) => {
        await touch(path.join(staged, "server.exe"));
        return 1;
      },
    }, root, async () => new Response(bytes), systemRoot, [component]);

    await expect(installer.install("stt", () => undefined)).rejects.toThrow(/required file/u);
    expect(await readFile(path.join(target, "server.exe"), "utf8")).toBe("old");
    expect(await readFile(path.join(target, "runtime-old.dll"), "utf8")).toBe("old");
  });

  it("cleans abandoned work and restores the newest valid promotion backup", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const target = path.join(root, "models", "model.bin");
    const bytes = Buffer.from("new", "utf8");
    const component = fileComponent("stt-model", "stt", target, bytes);
    const oldBackup = `${target}.previous-1-100`;
    const newBackup = `${target}.previous-1-200`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(oldBackup, "old", "utf8");
    await writeFile(newBackup, bytes);
    await utimes(oldBackup, 1, 1);
    await utimes(newBackup, 2, 2);
    const abandoned = path.join(root, ".install-work", "stt-model-crashed", "artifact.part");
    await touch(abandoned);
    const fetcher = vi.fn(async () => {
      throw new Error("A valid backup should not be downloaded again");
    }) as typeof fetch;
    const installer = new LocalInstaller(
      { extractSubset: async () => 0 }, root, fetcher, systemRoot, [component],
    );

    await installer.install("stt", () => undefined);

    expect(await readFile(target)).toEqual(bytes);
    expect(existsSync(oldBackup)).toBe(false);
    expect(existsSync(newBackup)).toBe(false);
    expect(existsSync(abandoned)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a valid promoted target and removes obsolete backup siblings", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const target = path.join(root, "models", "model.bin");
    const bytes = Buffer.from("now", "utf8");
    const component = fileComponent("stt-model", "stt", target, bytes);
    const backup = `${target}.previous-1-100`;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
    await writeFile(backup, "old", "utf8");
    const fetcher = vi.fn(async () => new Response(bytes));
    const installer = new LocalInstaller(
      { extractSubset: async () => 0 }, root, fetcher, systemRoot, [component],
    );

    await installer.install("stt", () => undefined);

    expect(await readFile(target)).toEqual(bytes);
    expect(existsSync(backup)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shares first-use cleanup so a concurrent prepare cannot delete active work", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const sttBytes = Buffer.from("stt", "utf8");
    const cleanupBytes = Buffer.from("cleanup", "utf8");
    const components = [
      fileComponent("stt-model", "stt", path.join(root, "models", "stt.bin"), sttBytes),
      fileComponent(
        "cleanup-model", "cleanup", path.join(root, "models", "cleanup.bin"), cleanupBytes,
      ),
    ] as const;
    let releaseStt: (() => void) | undefined;
    const sttGate = new Promise<void>((resolve) => { releaseStt = resolve; });
    let markSttStarted: (() => void) | undefined;
    const sttStarted = new Promise<void>((resolve) => { markSttStarted = resolve; });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("stt-model")) {
        markSttStarted?.();
        await sttGate;
        return new Response(sttBytes);
      }
      return new Response(cleanupBytes);
    }) as typeof fetch;
    const installer = new LocalInstaller(
      { extractSubset: async () => 0 }, root, fetcher, systemRoot, components,
    );

    const sttInstall = installer.install("stt", () => undefined);
    await sttStarted;
    try {
      await installer.install("cleanup", () => undefined);
      const activeWork = (await readdir(path.join(root, ".install-work")))
        .find((name) => name.startsWith("stt-model-"));
      expect(activeWork).toBeDefined();
      if (activeWork !== undefined) {
        expect(existsSync(path.join(root, ".install-work", activeWork))).toBe(true);
      }
    } finally {
      releaseStt?.();
    }
    await sttInstall;
  });

  const networkTest = process.env.UNDERTONE_LOCAL_INSTALLER_E2E === "1" ? it : it.skip;
  networkTest("installs and receipts the pinned CPU runtime and VAD artifacts", async () => {
    const root = await temporaryDirectory();
    const systemRoot = await temporaryDirectory();
    const components = createLocalArtifactPlan(root, false)
      .filter(({ id }) => id === "stt-cpu" || id === "stt-vad");
    const installer = new LocalInstaller(
      new WindowsHost({ requestTimeoutMs: 5_000 }),
      root,
      fetch,
      systemRoot,
      components,
    );

    await installer.install("stt", () => undefined);

    expect(installer.isInstalled("stt")).toBe(true);
    for (const component of components) {
      expect(existsSync(receiptPath(root, component))).toBe(true);
    }
    expect(existsSync(path.join(root, "runtime", "cpu", "whisper-server.exe"))).toBe(true);
    expect((await readFile(path.join(root, "models", LOCAL_VAD_MODEL))).byteLength)
      .toBe(STT_ARTIFACTS.vad_model.size);
  }, 120_000);

  networkTest("installs and receipts the pinned Nemotron CPU runtime", async () => {
    const root = await temporaryDirectory();
    const components = createLocalArtifactPlan(root, false)
      .filter(({ id }) => id === "nemotron-cpu");
    const installer = new LocalInstaller(
      new WindowsHost({ requestTimeoutMs: 5_000 }),
      root,
      fetch,
      await temporaryDirectory(),
      components,
      false,
      false,
    );

    await installer.install("stt", () => undefined, "nemotron", "cpu");

    expect(installer.isInstalled("stt", "nemotron", "cpu")).toBe(true);
    expect(existsSync(receiptPath(root, components[0]!))).toBe(true);
    expect(existsSync(path.join(root, "runtime", "nemotron", "nemo-speech.exe"))).toBe(true);
    expect(existsSync(path.join(
      root,
      "runtime",
      "nemotron",
      "undertone-nemotron-cpu.txt",
    ))).toBe(true);
  }, 120_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "undertone-installer-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createInstalledFiles(root: string, includeCuda = false): Promise<void> {
  const runtimeFiles = [
    path.join(root, "runtime", "cpu", "whisper-server.exe"),
    path.join(root, "runtime", "cpu", "whisper.dll"),
    path.join(root, "runtime", "cpu", "ggml.dll"),
    path.join(root, "runtime", "cpu", "ggml-base.dll"),
    path.join(root, "runtime", "cpu", "ggml-cpu-test.dll"),
    path.join(root, "runtime", "llm-cpu", "llama-server.exe"),
    path.join(root, "runtime", "llm-cpu", "llama-server-impl.dll"),
    path.join(root, "runtime", "llm-cpu", "llama-common.dll"),
    path.join(root, "runtime", "llm-cpu", "llama.dll"),
    path.join(root, "runtime", "llm-cpu", "mtmd.dll"),
    path.join(root, "runtime", "llm-cpu", "ggml.dll"),
    path.join(root, "runtime", "llm-cpu", "ggml-base.dll"),
    path.join(root, "runtime", "llm-cpu", "ggml-cpu-test.dll"),
    path.join(root, "runtime", "llm-cpu", "libomp140.dll"),
  ];
  if (includeCuda) {
    runtimeFiles.push(
      path.join(root, "runtime", "cuda", "whisper-server.exe"),
      path.join(root, "runtime", "cuda", "whisper.dll"),
      path.join(root, "runtime", "cuda", "ggml.dll"),
      path.join(root, "runtime", "cuda", "ggml-base.dll"),
      path.join(root, "runtime", "cuda", "ggml-cpu-test.dll"),
      path.join(root, "runtime", "cuda", "ggml-cuda.dll"),
      path.join(root, "runtime", "cuda", "cublas64_12.dll"),
      path.join(root, "runtime", "cuda", "cublasLt64_12.dll"),
      path.join(root, "runtime", "cuda", "cudart64_12.dll"),
      path.join(root, "runtime", "cuda", "nvrtc64_120_0.dll"),
      path.join(root, "runtime", "cuda", "nvrtc-builtins64_124.dll"),
      path.join(root, "runtime", "llm-cuda", "llama-server.exe"),
      path.join(root, "runtime", "llm-cuda", "llama-server-impl.dll"),
      path.join(root, "runtime", "llm-cuda", "llama-common.dll"),
      path.join(root, "runtime", "llm-cuda", "llama.dll"),
      path.join(root, "runtime", "llm-cuda", "mtmd.dll"),
      path.join(root, "runtime", "llm-cuda", "ggml.dll"),
      path.join(root, "runtime", "llm-cuda", "ggml-base.dll"),
      path.join(root, "runtime", "llm-cuda", "ggml-cpu-test.dll"),
      path.join(root, "runtime", "llm-cuda", "libomp140.dll"),
      path.join(root, "runtime", "llm-cuda", "ggml-cuda.dll"),
      path.join(root, "runtime", "llm-cuda", "cublas64_12.dll"),
      path.join(root, "runtime", "llm-cuda", "cublasLt64_12.dll"),
      path.join(root, "runtime", "llm-cuda", "cudart64_12.dll"),
    );
  }
  await Promise.all(runtimeFiles.map(touch));
  await sizedFile(path.join(root, "models", LOCAL_STT_MODEL), STT_ARTIFACTS.model.size);
  await sizedFile(path.join(root, "models", LOCAL_VAD_MODEL), STT_ARTIFACTS.vad_model.size);
  await sizedFile(path.join(root, "models", LOCAL_CLEANUP_MODEL), CLEANUP_ARTIFACTS.model.size);
}

async function touch(file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "", "utf8");
}

async function sizedFile(file: string, size: number): Promise<void> {
  await touch(file);
  await truncate(file, size);
}

function testArtifact(url: string, bytes: Buffer): InstallArtifact {
  return {
    url: `https://example.invalid/${url}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}

function fileComponent(
  id: string,
  kind: "stt" | "cleanup",
  target: string,
  bytes: Buffer,
): LocalArtifactComponent {
  return {
    id,
    kind,
    applicable: true,
    format: "file",
    artifacts: [testArtifact(id, bytes)],
    target,
    requiredOutputs: [{ pattern: path.basename(target), size: bytes.byteLength }],
    workspaceBytes: 0,
  };
}
