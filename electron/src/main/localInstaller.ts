import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, readdir, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { finished } from "node:stream/promises";

import type {
  LocalEngineKind,
  LocalRuntimeBuild,
  LocalSttEngineId,
} from "../shared/settings";
import {
  componentOutputsExist,
  createLocalArtifactPlan,
  isComponentCurrent,
  writeComponentReceipt,
  type InstallArtifact,
  type LocalArtifactComponent,
} from "./localArtifacts";

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

const INSTALL_SAFETY_RESERVE_BYTES = 200 * 1024 * 1024;

interface InstallSpaceEstimate {
  downloadBytes: number;
  extractionWorkspaceBytes: number;
}


export class LocalInstaller {
  private readonly installs = new Map<string, Promise<void>>();
  private readonly components: readonly LocalArtifactComponent[];
  private preparation: Promise<void> | null = null;

  constructor(
    private readonly host: LocalInstallHost,
    private readonly root: string,
    private readonly fetcher: InstallFetch = fetch,
    private readonly systemRoot = process.env.SystemRoot ?? "C:\\Windows",
    components?: readonly LocalArtifactComponent[],
    private readonly nvidiaGpu?: boolean,
    private readonly nemotronCompatibleGpu?: boolean,
  ) {
    this.components = components
      ?? createLocalArtifactPlan(root, this.hasNvidiaGpu());
  }

  installSize(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId = "whisper",
    build: LocalRuntimeBuild = this.recommendedNemotronBuild(),
  ): number {
    return this.estimateInstallSpace(kind, sttEngine, build).downloadBytes;
  }

  isInstalled(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId = "whisper",
    build: LocalRuntimeBuild = this.recommendedNemotronBuild(),
  ): boolean {
    return this.componentsFor(kind, sttEngine, build).every((component) =>
      isComponentCurrent(this.root, component));
  }

  recommendedNemotronBuild(): LocalRuntimeBuild {
    return this.hasNemotronCompatibleGpu() ? "cuda" : "cpu";
  }

  installedNemotronBuild(): LocalRuntimeBuild | null {
    for (const build of ["cuda", "cpu"] as const) {
      if (this.isInstalled("stt", "nemotron", build)) return build;
    }
    return null;
  }

  requiredInstallSpace(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId = "whisper",
    build: LocalRuntimeBuild = this.recommendedNemotronBuild(),
  ): number {
    const estimate = this.estimateInstallSpace(kind, sttEngine, build);
    return estimate.downloadBytes
      + estimate.extractionWorkspaceBytes
      + INSTALL_SAFETY_RESERVE_BYTES;
  }

  private estimateInstallSpace(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId,
    build: LocalRuntimeBuild,
  ): InstallSpaceEstimate {
    let downloadBytes = 0;
    let extractionWorkspaceBytes = 0;
    for (const component of this.componentsFor(kind, sttEngine, build)) {
      if (isComponentCurrent(this.root, component)) continue;
      downloadBytes += component.artifacts.reduce((total, artifact) => total + artifact.size, 0);
      extractionWorkspaceBytes += component.workspaceBytes;
    }
    return { downloadBytes, extractionWorkspaceBytes };
  }

  async install(
    kind: LocalEngineKind,
    progress: InstallProgressListener,
    sttEngine: LocalSttEngineId = "whisper",
    build: LocalRuntimeBuild = this.recommendedNemotronBuild(),
  ): Promise<void> {
    const key = `${kind}:${sttEngine}:${build}`;
    const existing = this.installs.get(key);
    if (existing !== undefined) return await existing;
    const operation = this.installMissing(kind, sttEngine, build, progress);
    this.installs.set(key, operation);
    try {
      await operation;
    } finally {
      if (this.installs.get(key) === operation) this.installs.delete(key);
    }
  }

  private async installMissing(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId,
    build: LocalRuntimeBuild,
    progress: InstallProgressListener,
  ): Promise<void> {
    await this.prepare(kind, sttEngine, build);
    for (const component of this.componentsFor(kind, sttEngine, build)) {
      if (isComponentCurrent(this.root, component)) continue;
      await this.installComponent(component, progress);
    }
  }

  private async prepare(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId,
    build: LocalRuntimeBuild,
  ): Promise<void> {
    this.preparation ??= this.recoverInterruptedInstalls();
    await this.preparation;
    const required = BigInt(this.requiredInstallSpace(kind, sttEngine, build));
    const disk = await statfs(this.root, { bigint: true });
    const free = disk.bavail * disk.bsize;
    if (free < required) {
      const gib = Number(required) / (1 << 30);
      throw new Error(`Not enough disk space — needs about ${gib.toFixed(1)} GB free.`);
    }
  }

  private async recoverInterruptedInstalls(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, "runtime"), { recursive: true });
    await mkdir(path.join(this.root, "models"), { recursive: true });
    const work = path.join(this.root, ".install-work");
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const componentsByTarget = new Map<string, LocalArtifactComponent[]>();
    for (const component of this.components) {
      const target = path.resolve(component.target);
      const variants = componentsByTarget.get(target) ?? [];
      variants.push(component);
      componentsByTarget.set(target, variants);
    }
    for (const variants of componentsByTarget.values()) {
      await recoverComponentBackup(this.root, variants);
    }
  }

  private async installComponent(
    component: LocalArtifactComponent,
    progress: InstallProgressListener,
  ): Promise<void> {
    const work = path.join(
      this.root,
      ".install-work",
      `${component.id}-${process.pid}-${Date.now()}`,
    );
    await mkdir(work, { recursive: true });
    try {
      const downloads: string[] = [];
      for (const [index, artifact] of component.artifacts.entries()) {
        const destination = path.join(work, `artifact-${index}`);
        await downloadPinnedArtifact(artifact, destination, this.fetcher,
          (fraction) => progress({
            phase: component.format === "file" ? "Downloading model" : "Downloading engine",
            fraction,
          }));
        downloads.push(destination);
      }

      if (component.format === "file") {
        const downloaded = downloads[0];
        if (downloaded === undefined) throw new Error("Local artifact plan has no download");
        await promoteFile(downloaded, component.target);
      } else {
        const staged = path.join(work, "staged");
        progress({ phase: "Installing engine", fraction: 0 });
        await this.host.extractSubset(
          downloads,
          component.requiredOutputs.map((output) => output.pattern),
          staged,
        );
        if (!componentOutputsExist({ ...component, target: staged })) {
          throw new Error("The local engine archive did not contain every required file.");
        }
        await promoteDirectory(staged, component.target);
        progress({ phase: "Installing engine", fraction: 1 });
      }
      if (!componentOutputsExist(component)) {
        throw new Error("The installed local component failed validation.");
      }
      writeComponentReceipt(this.root, component);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  }

  private componentsFor(
    kind: LocalEngineKind,
    sttEngine: LocalSttEngineId,
    build: LocalRuntimeBuild,
  ): readonly LocalArtifactComponent[] {
    return this.components.filter((component) => component.kind === kind
      && component.applicable
      && (kind !== "stt" || component.sttEngine === undefined || component.sttEngine === sttEngine)
      && (component.build === undefined || sttEngine !== "nemotron" || component.build === build));
  }

  private hasNvidiaGpu(): boolean {
    return this.nvidiaGpu
      ?? existsSync(path.join(this.systemRoot, "System32", "nvcuda.dll"));
  }

  private hasNemotronCompatibleGpu(): boolean {
    return this.nemotronCompatibleGpu ?? this.hasNvidiaGpu();
  }
}

async function recoverComponentBackup(
  root: string,
  components: readonly LocalArtifactComponent[],
): Promise<void> {
  const component = components[0];
  if (component === undefined) return;
  if (components.some((variant) => variant.target !== component.target)) {
    throw new Error("Local artifact variants do not share an install target");
  }
  if (!isWithin(root, component.target)) {
    throw new Error(`Local artifact target is outside the install root: ${component.id}`);
  }
  const parent = path.dirname(component.target);
  const prefix = `${path.basename(component.target)}.previous-`;
  let names: string[];
  try {
    names = (await readdir(parent)).filter((name) => name.startsWith(prefix));
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return;
    throw error;
  }
  const candidates = (await Promise.all(names.map(async (name) => {
    const candidate = path.join(parent, name);
    try {
      const status = await lstat(candidate);
      return {
        candidate,
        modified: status.mtimeMs,
        restorable: !status.isSymbolicLink(),
      };
    } catch {
      return null;
    }
  }))).filter((candidate) => candidate !== null)
    .sort((left, right) => right.modified - left.modified);

  let restored: string | null = null;
  if (!components.some((variant) => componentOutputsExist(variant))) {
    restored = candidates.find(({ candidate, restorable }) => restorable
      && components.some((variant) => componentOutputsExist({
        ...variant,
        target: candidate,
      })))?.candidate ?? null;
    if (restored !== null) {
      await rm(component.target, { recursive: true, force: true });
      await rename(restored, component.target);
    }
  }
  await Promise.all(candidates
    .filter(({ candidate }) => candidate !== restored)
    .map(async ({ candidate }) => await rm(candidate, { recursive: true, force: true })));
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== ""
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function isFileSystemError(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

async function promoteFile(staged: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await promote(staged, target);
}

async function promoteDirectory(staged: string, target: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await promote(staged, target);
}

async function promote(staged: string, target: string): Promise<void> {
  const backup = `${target}.previous-${process.pid}-${Date.now()}`;
  const hadTarget = existsSync(target);
  if (hadTarget) await rename(target, backup);
  try {
    await rename(staged, target);
  } catch (error) {
    if (hadTarget) await rename(backup, target);
    throw error;
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true });
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
  const outputFinished = finished(output);
  let responseFinished = false;
  const outputMonitor = outputFinished.then(() => {
    if (!responseFinished) {
      throw new Error("Download output closed before the response finished");
    }
  });
  const reader = response.body.getReader();
  let received = 0;
  try {
    const transfer = (async () => {
      while (true) {
        const chunk = await readWithTimeout(reader, controller, 60_000);
        if (chunk.done) break;
        digest.update(chunk.value);
        received += chunk.value.byteLength;
        if (!output.write(chunk.value)) await once(output, "drain");
        progress(Math.min(1, received / artifact.size));
      }
      responseFinished = true;
      output.end();
      await outputFinished;
    })();
    await Promise.all([transfer, outputMonitor]);
  } catch (error) {
    output.destroy();
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await rm(partial, { force: true }).catch(() => undefined);
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
