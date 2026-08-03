import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLEANUP_ARTIFACTS,
  downloadPinnedArtifact,
  LocalInstaller,
  STT_ARTIFACTS,
} from "../src/main/localInstaller";
import {
  LOCAL_CLEANUP_MODEL,
  LOCAL_STT_MODEL,
  LOCAL_VAD_MODEL,
} from "../src/main/localRuntime";
import { WindowsHost } from "../src/platform/windowsHost";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { force: true, recursive: true });
  }));
});

describe("local installer", () => {
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
    const bytes = Buffer.from("wrong bytes", "utf8");

    await expect(downloadPinnedArtifact({
      url: "https://example.invalid/artifact.bin",
      sha256: "0".repeat(64),
      size: bytes.byteLength,
    }, destination, async () => new Response(bytes))).rejects.toThrow(/verification/u);

    expect(existsSync(destination)).toBe(false);
    expect(existsSync(`${destination}.part`)).toBe(false);
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

  const networkTest = process.env.UNDERTONE_LOCAL_INSTALLER_E2E === "1" ? it : it.skip;
  networkTest("downloads pinned public artifacts and extracts the real CPU runtime", async () => {
    const root = await temporaryDirectory();
    const runtimeZip = path.join(root, "whisper-cpu.zip");
    const vadModel = path.join(root, LOCAL_VAD_MODEL);
    const host = new WindowsHost({ requestTimeoutMs: 5_000 });
    await host.start();
    try {
      await downloadPinnedArtifact(STT_ARTIFACTS.cpu_runtime, runtimeZip);
      await downloadPinnedArtifact(STT_ARTIFACTS.vad_model, vadModel);
      const extracted = path.join(root, "runtime");
      const count = await host.extractSubset(
        [runtimeZip],
        ["whisper-server.exe", "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu-*.dll"],
        extracted,
      );
      expect(count).toBeGreaterThanOrEqual(5);
      expect(existsSync(path.join(extracted, "whisper-server.exe"))).toBe(true);
      expect((await readFile(vadModel)).byteLength).toBe(STT_ARTIFACTS.vad_model.size);
    } finally {
      await host.stop();
    }
  }, 120_000);
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "undertone-installer-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createInstalledFiles(root: string): Promise<void> {
  const files = [
    path.join(root, "runtime", "cpu", "whisper-server.exe"),
    path.join(root, "runtime", "llm-cpu", "llama-server.exe"),
    path.join(root, "models", LOCAL_STT_MODEL),
    path.join(root, "models", LOCAL_VAD_MODEL),
    path.join(root, "models", LOCAL_CLEANUP_MODEL),
  ];
  await Promise.all(files.map(async (file) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "installed", "utf8");
  }));
}
