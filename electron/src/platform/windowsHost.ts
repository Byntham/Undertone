import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PROTOCOL_VERSION = 3;
const HOST_NAME = "Undertone.WinHost.exe";

interface HostReady {
  protocol: number;
  type: "ready";
  keyboardHook: boolean;
  mouseHook: boolean;
}

export interface KeyboardEvent {
  protocol: number;
  type: "keyboard";
  eventType: "down" | "up";
  scanCode: number;
  virtualKey: number;
  injected: boolean;
  extended: boolean;
}

export interface MouseEvent {
  protocol: number;
  type: "mouse";
  eventType: "down";
  button: "left" | "right" | "middle" | "x1" | "x2";
}

interface HostResponse extends Record<string, unknown> {
  protocol: number;
  type: string;
  requestId: string;
}

interface ForegroundInfo {
  window: string;
  executable: string | null;
  title: string | null;
}

export interface SupervisedProcessStatus {
  running: boolean;
  exitCode: number | null;
}

export interface CaretContext {
  before: string;
  after: string | null;
}

interface PendingRequest {
  expectedType: string;
  resolve: (response: HostResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WindowsHostOptions {
  executable?: string;
  requestTimeoutMs?: number;
}

export class WindowsHost {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly keyboardListeners = new Set<(event: KeyboardEvent) => void>();
  private readonly mouseListeners = new Set<(event: MouseEvent) => void>();
  private readonly executable: string;
  private readonly requestTimeoutMs: number;
  private readyResolve: ((ready: HostReady) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WindowsHostOptions = {}) {
    this.executable = options.executable ?? resolveWindowsHost();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
  }

  async start(): Promise<HostReady> {
    if (this.child !== null) {
      throw new Error("Windows host is already running");
    }
    if (!existsSync(this.executable)) {
      throw new Error(`Windows host executable is missing: ${this.executable}`);
    }

    const child = spawn(this.executable, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.handleLine(line));

    return await new Promise<HostReady>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
      this.readyTimer = setTimeout(() => {
        this.failStart(new Error("Windows host did not become ready"));
        child.kill();
      }, this.requestTimeoutMs);
      child.once("error", (error) => {
        this.failStart(error);
      });
      child.once("close", (code) => {
        this.child = null;
        const error = new Error(`Windows host exited with code ${code}`);
        this.failStart(error);
        this.rejectPending(error);
      });
    });
  }

  onKeyboard(listener: (event: KeyboardEvent) => void): () => void {
    this.keyboardListeners.add(listener);
    return () => this.keyboardListeners.delete(listener);
  }

  onMouse(listener: (event: MouseEvent) => void): () => void {
    this.mouseListeners.add(listener);
    return () => this.mouseListeners.delete(listener);
  }

  async startInput(): Promise<void> {
    await this.request("startInput", "inputStarted");
  }

  async stopInput(): Promise<void> {
    await this.request("stopInput", "inputStopped");
  }

  async startShortcutCapture(): Promise<void> {
    await this.request("startShortcutCapture", "shortcutCaptureStarted");
  }

  async stopShortcutCapture(): Promise<void> {
    await this.request("stopShortcutCapture", "shortcutCaptureStopped");
  }

  async getForeground(): Promise<ForegroundInfo> {
    const response = await this.request("getForeground", "foreground");
    if (typeof response.window !== "string"
      || !isNullableString(response.executable)
      || !isNullableString(response.title)) {
      throw new Error("Windows host returned an invalid foreground window");
    }
    return {
      window: response.window,
      executable: response.executable,
      title: response.title,
    };
  }

  async focusWindow(window: string): Promise<boolean> {
    const response = await this.request("focusWindow", "focusResult", { window });
    if (typeof response.focused !== "boolean") {
      throw new Error("Windows host returned an invalid focus result");
    }
    return response.focused;
  }

  async getCaretContext(before = 300, after = 300): Promise<CaretContext | null> {
    const response = await this.request("getCaretContext", "caretContext", {
      before,
      after,
    });
    if (typeof response.available !== "boolean") {
      throw new Error("Windows host returned an invalid caret context");
    }
    if (!response.available) return null;
    if (typeof response.before !== "string" || !isNullableString(response.after)) {
      throw new Error("Windows host returned an invalid caret context");
    }
    return { before: response.before, after: response.after };
  }

  async sendPaste(): Promise<boolean> {
    const response = await this.request("sendPaste", "pasteResult");
    if (typeof response.sent !== "boolean") {
      throw new Error("Windows host returned an invalid paste result");
    }
    return response.sent;
  }

  async protectSecret(value: string): Promise<string> {
    const response = await this.request("protectSecret", "secretProtected", { value });
    if (typeof response.value !== "string") {
      throw new Error("Windows host returned an invalid protected secret");
    }
    return response.value;
  }

  async unprotectSecret(value: string): Promise<string> {
    const response = await this.request("unprotectSecret", "secretUnprotected", { value });
    if (typeof response.value !== "string") {
      throw new Error("Windows host returned an invalid unprotected secret");
    }
    return response.value;
  }

  async spawnSupervised(
    file: string,
    argumentsValue = "",
    workingDirectory = "",
    logFile = "",
    environment: Readonly<Record<string, string | null>> = {},
  ): Promise<number> {
    const response = await this.request("spawnSupervised", "processStarted", {
      file,
      arguments: argumentsValue,
      workingDirectory,
      logFile,
      environment,
    });
    if (typeof response.processId !== "number") {
      throw new Error("Windows host returned an invalid process ID");
    }
    return response.processId;
  }

  async isSupervisedRunning(processId: number): Promise<boolean> {
    return (await this.supervisedProcessStatus(processId)).running;
  }

  async supervisedProcessStatus(processId: number): Promise<SupervisedProcessStatus> {
    const response = await this.request("isSupervisedRunning", "processStatus", {
      processId,
    });
    if (typeof response.running !== "boolean"
      || (response.exitCode !== null && typeof response.exitCode !== "number")) {
      throw new Error("Windows host returned an invalid process status");
    }
    return {
      running: response.running,
      exitCode: response.exitCode,
    };
  }

  async extractSubset(
    zipFiles: readonly string[],
    patterns: readonly string[],
    targetDirectory: string,
  ): Promise<number> {
    const response = await this.request(
      "extractSubset",
      "subsetExtracted",
      {
        zipFiles: [...zipFiles],
        patterns: [...patterns],
        targetDirectory,
      },
      300_000,
    );
    if (typeof response.fileCount !== "number") {
      throw new Error("Windows host returned an invalid extraction result");
    }
    return response.fileCount;
  }

  async stopSupervised(processId: number): Promise<boolean> {
    const response = await this.request("stopSupervised", "processStopped", {
      processId,
    });
    if (typeof response.stopped !== "boolean") {
      throw new Error("Windows host returned an invalid process result");
    }
    return response.stopped;
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (child === null) return;
    try {
      await this.request("shutdown", "shuttingDown");
    } catch {
      child.kill();
    }
    await waitForExit(child, this.requestTimeoutMs);
    if (child.exitCode === null) child.kill();
    this.child = null;
  }

  private async request(
    type: string,
    expectedType: string,
    values: Record<string, unknown> = {},
    timeoutMs = this.requestTimeoutMs,
  ): Promise<HostResponse> {
    const child = this.child;
    if (child === null || !child.stdin.writable) {
      throw new Error("Windows host is not running");
    }
    const requestId = String(this.nextRequestId++);
    return await new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Windows host request timed out: ${type}`));
      }, timeoutMs);
      this.pending.set(requestId, { expectedType, resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({
        ...values,
        protocol: PROTOCOL_VERSION,
        type,
        requestId,
      })}\n`);
    });
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message)) return;

    if (isReady(message)) {
      if (message.protocol !== PROTOCOL_VERSION) {
        this.failStart(new Error(
          `Windows host protocol ${message.protocol} is unsupported`,
        ));
        this.child?.kill();
        return;
      }
      if (!message.keyboardHook || !message.mouseHook) {
        this.failStart(new Error("Windows host could not install its input hooks"));
        this.child?.kill();
        return;
      }
      if (this.readyTimer !== undefined) clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      const resolve = this.readyResolve;
      this.readyResolve = null;
      this.readyReject = null;
      resolve?.(message);
      return;
    }
    if (message.protocol !== PROTOCOL_VERSION) return;

    if (isKeyboard(message)) {
      for (const listener of this.keyboardListeners) listener(message);
      return;
    }
    if (isMouse(message)) {
      for (const listener of this.mouseListeners) listener(message);
      return;
    }
    if (typeof message.requestId === "string") {
      const pending = this.pending.get(message.requestId);
      if (pending === undefined) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.type === pending.expectedType) {
        pending.resolve(message as unknown as HostResponse);
      } else {
        const detail = typeof message.message === "string" ? `: ${message.message}` : "";
        pending.reject(new Error(
          `Windows host returned ${String(message.type)}; expected ${pending.expectedType}${detail}`,
        ));
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private failStart(error: Error): void {
    if (this.readyTimer !== undefined) clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    const reject = this.readyReject;
    this.readyResolve = null;
    this.readyReject = null;
    reject?.(error);
  }
}

export function resolveWindowsHost(): string {
  const candidates = [
    path.resolve(__dirname, "../../native", HOST_NAME),
    path.resolve(__dirname, "../../dist/native", HOST_NAME),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isReady(value: unknown): value is HostReady {
  return isRecord(value)
    && value.type === "ready"
    && typeof value.protocol === "number"
    && typeof value.keyboardHook === "boolean"
    && typeof value.mouseHook === "boolean";
}

function isKeyboard(
  value: Record<string, unknown>,
): value is Record<string, unknown> & KeyboardEvent {
  return value.type === "keyboard"
    && (value.eventType === "down" || value.eventType === "up")
    && typeof value.scanCode === "number"
    && typeof value.virtualKey === "number"
    && typeof value.injected === "boolean"
    && typeof value.extended === "boolean";
}

function isMouse(
  value: Record<string, unknown>,
): value is Record<string, unknown> & MouseEvent {
  return value.type === "mouse"
    && value.eventType === "down"
    && ["left", "right", "middle", "x1", "x2"].includes(String(value.button));
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
