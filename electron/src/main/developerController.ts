import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEV_PROTOCOL = 1;

export interface DeveloperWorktree {
  root: string;
  electronRoot: string;
  branch: string;
  compatible: boolean;
  compatibilityError: string | null;
}

export interface DeveloperRepositoryDiscovery {
  repositoryRoot: string;
  worktrees: DeveloperWorktree[];
}

export type DeveloperPhase = "production" | "building" | "dev" | "error";

export interface DeveloperSnapshot {
  phase: DeveloperPhase;
  repositoryRoot: string | null;
  activeWorktree: DeveloperWorktree | null;
  message: string;
}

interface ManagedRuntime {
  appRoot: string;
  electronExecutable: string;
  readyFile: string;
  worktree: DeveloperWorktree;
  child: ChildProcess | null;
  intentionalStop: boolean;
}

interface DeveloperControllerOptions {
  configPath: string;
  buildRoot: string;
  onBeforeDevStart(): Promise<void>;
  onDevUnavailable(): Promise<void>;
  onStateChange(snapshot: DeveloperSnapshot): void;
}

export class DeveloperController {
  private repositoryRoot: string | null = null;
  private active: ManagedRuntime | null = null;
  private operation: Promise<void> = Promise.resolve();
  private phase: DeveloperPhase = "production";
  private message = "Production active";
  private disposed = false;

  constructor(private readonly options: DeveloperControllerOptions) {}

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.options.configPath, "utf8"));
      if (isRecord(parsed) && typeof parsed.repositoryRoot === "string") {
        await validateRepository(parsed.repositoryRoot);
        this.repositoryRoot = path.resolve(parsed.repositoryRoot);
      }
    } catch {
      this.repositoryRoot = null;
    }
    this.emit();
  }

  snapshot(): DeveloperSnapshot {
    return {
      phase: this.phase,
      repositoryRoot: this.repositoryRoot,
      activeWorktree: this.active?.worktree ?? null,
      message: this.message,
    };
  }

  async setRepository(root: string): Promise<void> {
    await validateRepository(root);
    this.repositoryRoot = path.resolve(root);
    await mkdir(path.dirname(this.options.configPath), { recursive: true });
    await writeFile(
      this.options.configPath,
      JSON.stringify({ repositoryRoot: this.repositoryRoot }, null, 2),
      "utf8",
    );
    this.message = "Development repository configured";
    this.emit();
  }

  async disable(): Promise<void> {
    await this.returnToProduction();
    this.repositoryRoot = null;
    await rm(this.options.configPath, { force: true });
    this.message = "Developer mode disabled";
    this.emit();
  }

  async worktrees(): Promise<DeveloperWorktree[]> {
    if (this.repositoryRoot === null) return [];
    return await inspectRepositoryWorktrees(this.repositoryRoot);
  }

  async discoverT3Repository(t3ProjectRoot: string): Promise<DeveloperRepositoryDiscovery | null> {
    const entries = await readdir(t3ProjectRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(t3ProjectRoot, entry.name);
      if (!await isUndertoneRoot(candidate)) continue;
      try {
        const commonDirectory = (await capture("git", [
          "-C", candidate, "rev-parse", "--path-format=absolute", "--git-common-dir",
        ])).trim();
        const repositoryRoot = path.basename(commonDirectory).toLowerCase() === ".git"
          ? path.dirname(commonDirectory)
          : candidate;
        await validateRepository(repositoryRoot);
        return {
          repositoryRoot: path.resolve(repositoryRoot),
          worktrees: await inspectRepositoryWorktrees(repositoryRoot),
        };
      } catch {
        // A stale T3 worktree should not prevent discovery of the remaining entries.
      }
    }
    return null;
  }

  async worktreesForRepository(root: string): Promise<DeveloperWorktree[]> {
    await validateRepository(root);
    return await inspectRepositoryWorktrees(root);
  }

  async activate(worktree: DeveloperWorktree): Promise<void> {
    const operation = this.operation.catch(() => undefined).then(async () => {
      if (this.disposed) return;
      if (!worktree.compatible) {
        throw new Error(worktree.compatibilityError ?? "This worktree is incompatible");
      }
      this.phase = "building";
      this.message = `Building ${worktree.branch}`;
      this.emit();
      const candidate = await this.build(worktree);
      const previous = this.active;
      if (previous === null) await this.options.onBeforeDevStart();
      else await this.stopRuntime(previous);
      try {
        await this.launchRuntime(candidate);
        this.active = candidate;
        this.phase = "dev";
        this.message = `${worktree.branch} active`;
        this.emit();
        await this.cleanupBuilds(candidate.appRoot).catch(() => undefined);
      } catch (error) {
        if (previous !== null) {
          try {
            await this.launchRuntime(previous);
            this.active = previous;
            this.phase = "dev";
            this.message = `${previous.worktree.branch} restored after launch failure`;
            this.emit();
          } catch {
            this.active = null;
            await this.options.onDevUnavailable();
          }
        } else {
          this.active = null;
          await this.options.onDevUnavailable();
        }
        throw error;
      }
    }).catch((error: unknown) => {
      this.phase = this.active === null ? "error" : "dev";
      this.message = error instanceof Error ? error.message : String(error);
      this.emit();
      throw error;
    });
    this.operation = operation.catch(() => undefined);
    await operation;
  }

  async rebuildActive(): Promise<void> {
    const worktree = this.active?.worktree;
    if (worktree === undefined) throw new Error("No development worktree is active");
    await this.activate(worktree);
  }

  async returnToProduction(): Promise<void> {
    const operation = this.operation.catch(() => undefined).then(async () => {
      const runtime = this.active;
      if (runtime !== null) await this.stopRuntime(runtime);
      this.active = null;
      await this.options.onDevUnavailable();
      this.phase = "production";
      this.message = "Production active";
      this.emit();
    });
    this.operation = operation.catch(() => undefined);
    await operation;
  }

  openDevSettings(): boolean {
    const runtime = this.active;
    if (runtime === null) return false;
    const child = spawn(runtime.electronExecutable, [runtime.appRoot, "--undertone-open-settings"], {
      cwd: runtime.appRoot,
      env: managedEnvironment(runtime),
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const runtime = this.active;
    if (runtime !== null) await this.stopRuntime(runtime);
    this.active = null;
  }

  private async build(worktree: DeveloperWorktree): Promise<ManagedRuntime> {
    const electronPackage = path.join(
      worktree.electronRoot, "node_modules", "electron", "package.json",
    );
    if (!existsSync(electronPackage)) {
      const installCode = await run("npm.cmd", ["ci"], worktree.electronRoot, true);
      if (installCode !== 0) throw new Error("Dependency installation failed");
    }
    const electronExecutable = path.join(
      worktree.electronRoot, "node_modules", "electron", "dist", "electron.exe",
    );
    if (!existsSync(electronExecutable)) {
      const prepareCode = await run(
        "node.exe", ["-e", "require('electron')"], worktree.electronRoot,
      );
      if (prepareCode !== 0 || !existsSync(electronExecutable)) {
        throw new Error("Electron runtime setup failed");
      }
    }
    const buildCode = await run("npm.cmd", ["run", "build"], worktree.electronRoot, true);
    if (buildCode !== 0) throw new Error(`Build failed for ${worktree.branch}`);

    await mkdir(this.options.buildRoot, { recursive: true });
    const appRoot = path.join(
      this.options.buildRoot,
      `${safeName(worktree.branch)}-${Date.now()}`,
    );
    if (!isWithin(appRoot, this.options.buildRoot)) {
      throw new Error("Invalid development build path");
    }
    await mkdir(appRoot, { recursive: true });
    await cp(path.join(worktree.electronRoot, "dist"), path.join(appRoot, "dist"), {
      recursive: true,
    });
    await cp(path.join(worktree.electronRoot, "package.json"), path.join(appRoot, "package.json"));
    await cp(path.join(worktree.root, "assets"), path.join(appRoot, "assets"), {
      recursive: true,
    });
    await symlink(
      path.join(worktree.electronRoot, "node_modules"),
      path.join(appRoot, "node_modules"),
      "junction",
    );
    await writeFile(
      path.join(appRoot, "build.json"),
      JSON.stringify({ branch: worktree.branch, source: worktree.root, createdAt: Date.now() }, null, 2),
      "utf8",
    );
    return {
      appRoot,
      electronExecutable,
      readyFile: path.join(appRoot, "ready"),
      worktree,
      child: null,
      intentionalStop: false,
    };
  }

  private async launchRuntime(runtime: ManagedRuntime): Promise<void> {
    await rm(runtime.readyFile, { force: true });
    runtime.intentionalStop = false;
    const child = spawn(runtime.electronExecutable, [runtime.appRoot], {
      cwd: runtime.appRoot,
      env: managedEnvironment(runtime),
      stdio: "ignore",
      windowsHide: true,
    });
    runtime.child = child;
    child.once("error", () => undefined);
    child.once("close", () => {
      runtime.child = null;
      if (!runtime.intentionalStop && this.active === runtime && !this.disposed) {
        this.active = null;
        this.phase = "error";
        this.message = `${runtime.worktree.branch} exited; production restored`;
        this.emit();
        void this.options.onDevUnavailable();
      }
    });
    const deadline = Date.now() + 15_000;
    while (!existsSync(runtime.readyFile)) {
      if (child.exitCode !== null) throw new Error(`${runtime.worktree.branch} exited during startup`);
      if (Date.now() >= deadline) {
        runtime.intentionalStop = true;
        child.kill();
        throw new Error(`${runtime.worktree.branch} did not become ready`);
      }
      await delay(100);
    }
  }

  private async stopRuntime(runtime: ManagedRuntime): Promise<void> {
    const child = runtime.child;
    runtime.intentionalStop = true;
    if (child === null || child.exitCode !== null) return;
    const request = spawn(runtime.electronExecutable, [runtime.appRoot, "--undertone-dev-quit"], {
      cwd: runtime.appRoot,
      env: managedEnvironment(runtime),
      stdio: "ignore",
      windowsHide: true,
    });
    request.once("error", () => undefined);
    await Promise.race([waitForExit(child), delay(5_000)]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([waitForExit(child), delay(2_000)]);
    }
  }

  private emit(): void {
    this.options.onStateChange(this.snapshot());
  }

  private async cleanupBuilds(activeRoot: string): Promise<void> {
    const entries = await readdir(this.options.buildRoot, { withFileTypes: true }).catch(() => []);
    const builds = await Promise.all(entries
      .filter((entry) => entry.isDirectory() && entry.name !== path.basename(activeRoot))
      .map(async (entry) => {
        const root = path.join(this.options.buildRoot, entry.name);
        return { root, modified: (await stat(root)).mtimeMs };
      }));
    builds.sort((left, right) => right.modified - left.modified);
    for (const build of builds.slice(2)) {
      if (isWithin(build.root, this.options.buildRoot)) {
        await rm(build.root, { recursive: true, force: true });
      }
    }
  }
}

export function parseWorktreeList(output: string): Array<{ root: string; branch: string }> {
  const result: Array<{ root: string; branch: string }> = [];
  let root: string | null = null;
  let branch = "detached HEAD";
  const flush = (): void => {
    if (root !== null) result.push({ root, branch });
    root = null;
    branch = "detached HEAD";
  };
  for (const line of output.split(/\r?\n/u)) {
    if (line.length === 0) flush();
    else if (line.startsWith("worktree ")) {
      if (root !== null) flush();
      root = line.slice("worktree ".length);
    } else if (line.startsWith("branch refs/heads/")) {
      branch = line.slice("branch refs/heads/".length);
    }
  }
  flush();
  return result;
}

export function worktreeDisplayName(branch: string): string {
  if (branch === "dev/integration") return "Integration";
  const unprefixed = branch.startsWith("t3code/") ? branch.slice("t3code/".length) : branch;
  const readable = unprefixed.replace(/[-_]+/gu, " ").trim();
  return readable.length === 0
    ? branch
    : `${readable[0]?.toUpperCase() ?? ""}${readable.slice(1)}`;
}

async function inspectRepositoryWorktrees(root: string): Promise<DeveloperWorktree[]> {
  const output = await capture("git", [
    "-C", root, "worktree", "list", "--porcelain",
  ]);
  return await Promise.all(
    parseWorktreeList(output).map(async (entry) => await inspectWorktree(entry)),
  );
}

async function inspectWorktree(entry: { root: string; branch: string }): Promise<DeveloperWorktree> {
  const root = path.resolve(entry.root);
  const electronRoot = path.join(root, "electron");
  let error: string | null = null;
  try {
    const parsed: unknown = JSON.parse(await readFile(path.join(electronRoot, "package.json"), "utf8"));
    if (!isRecord(parsed) || parsed.name !== "undertone-electron") {
      error = "Not an Undertone worktree";
    } else if (parsed.undertoneDevProtocol !== DEV_PROTOCOL) {
      error = "Update this branch from main";
    }
  } catch {
    error = "Undertone package is unavailable";
  }
  return {
    root,
    electronRoot,
    branch: entry.branch,
    compatible: error === null,
    compatibilityError: error,
  };
}

async function validateRepository(root: string): Promise<void> {
  const resolved = path.resolve(root);
  if (!await isUndertoneRoot(resolved)) {
    throw new Error("Choose the root of the Undertone repository");
  }
  const result = await run("git", ["-C", resolved, "rev-parse", "--show-toplevel"]);
  if (result !== 0) throw new Error("The selected folder is not an Undertone Git repository");
}

async function isUndertoneRoot(root: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(root, "electron", "package.json"), "utf8"),
    );
    return isRecord(parsed) && parsed.name === "undertone-electron";
  } catch {
    return false;
  }
}

function managedEnvironment(runtime: ManagedRuntime): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    UNDERTONE_MANAGED_DEV: "1",
    UNDERTONE_DEV_BRANCH: runtime.worktree.branch,
    UNDERTONE_MANAGED_READY_FILE: runtime.readyFile,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

async function run(command: string, args: readonly string[], cwd?: string, shell = false): Promise<number> {
  const child = spawn(command, [...args], { cwd, shell, stdio: "ignore", windowsHide: true });
  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function capture(command: string, args: readonly string[]): Promise<string> {
  const child = spawn(command, [...args], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
  return output;
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function safeName(value: string): string {
  return value.replace(/[^a-z0-9.-]+/giu, "-").replace(/^-+|-+$/gu, "") || "worktree";
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
