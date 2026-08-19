import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

import type { GuardedPasteResult, PasteTarget } from "../core/clipboardPaster";

const PROTOCOL_VERSION = 10;
const HOST_NAME = "Undertone.WinHost.exe";
const EXTRACTION_TIMEOUT_MS = 300_000;

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
  virtualKey: number;
  injected: boolean;
}

interface HostResponse extends Record<string, unknown> {
  protocol: number;
  type: string;
  requestId: string;
}

export type InputMode = "off" | "listen" | "shortcut-capture";

export interface CudaStatus {
  driverPresent: boolean;
  compatible: boolean;
  driverApiVersion: number;
  deviceCount: number;
}

export const NO_CUDA_STATUS: Readonly<CudaStatus> = {
  driverPresent: false,
  compatible: false,
  driverApiVersion: 0,
  deviceCount: 0,
};

type ForegroundInfo = {
  window: string;
  focus: string;
  generation: string;
} & (
  | { focusIdentityState: "available"; focusIdentity: string }
  | { focusIdentityState: "unavailable"; focusIdentity: null }
  | { focusIdentityState: "degraded"; focusIdentity: null }
);

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
  private readonly extractionChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly executable: string;
  private readonly requestTimeoutMs: number;
  private stopOperation: Promise<void> | null = null;
  private readyResolve: ((ready: HostReady) => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: WindowsHostOptions = {}) {
    this.executable = options.executable ?? resolveWindowsHost();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  }

  async start(): Promise<HostReady> {
    if (this.stopOperation !== null) {
      throw new Error("Windows host is stopping");
    }
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

  async setInputMode(mode: InputMode): Promise<void> {
    const response = await this.request("setInputMode", "inputModeSet", { mode });
    if (response.mode !== mode) {
      throw new Error("Windows host returned an invalid input mode");
    }
  }

  async getForeground(): Promise<ForegroundInfo> {
    const response = await this.request("getForeground", "foreground");
    if (typeof response.window !== "string"
      || typeof response.focus !== "string"
      || !isFocusIdentity(response.focusIdentityState, response.focusIdentity)
      || typeof response.generation !== "string") {
      throw new Error("Windows host returned an invalid foreground window");
    }
    const common = {
      window: response.window,
      focus: response.focus,
      generation: response.generation,
    };
    return response.focusIdentityState === "available"
      ? {
        ...common,
        focusIdentityState: "available",
        focusIdentity: response.focusIdentity as string,
      }
      : {
        ...common,
        focusIdentityState: response.focusIdentityState,
        focusIdentity: null,
      };
  }

  async sendPaste(): Promise<boolean> {
    const response = await this.request("sendPaste", "pasteResult");
    if (typeof response.sent !== "boolean") {
      throw new Error("Windows host returned an invalid paste result");
    }
    return response.sent;
  }

  async sendText(text: string): Promise<boolean> {
    const response = await this.request("sendText", "textResult", { text });
    if (typeof response.sent !== "boolean") {
      throw new Error("Windows host returned an invalid text result");
    }
    return response.sent;
  }

  async sendGuardedPaste(target: PasteTarget): Promise<GuardedPasteResult> {
    const response = await this.request("guardedPaste", "guardedPasteResult", target);
    if (!isGuardedPasteResponse(response.status, response.reason)) {
      throw new Error("Windows host returned an invalid guarded paste result");
    }
    if (response.status !== "pasted") {
      console.warn(`Guarded paste ${response.status} (${response.reason})`);
    }
    if (response.status === "paste-failed") {
      throw new Error("Windows did not accept the paste keystroke");
    }
    return response.status;
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
  ): Promise<number> {
    const response = await this.request("spawnSupervised", "processStarted", {
      file,
      arguments: argumentsValue,
      workingDirectory,
      logFile,
    });
    if (typeof response.processId !== "number") {
      throw new Error("Windows host returned an invalid process ID");
    }
    return response.processId;
  }

  async isSupervisedRunning(processId: number): Promise<boolean> {
    const response = await this.request("isSupervisedRunning", "processRunning", {
      processId,
    });
    if (typeof response.running !== "boolean") {
      throw new Error("Windows host returned an invalid process status");
    }
    return response.running;
  }

  async getCudaStatus(): Promise<CudaStatus> {
    const response = await this.request("getCudaStatus", "cudaStatus");
    if (typeof response.driverPresent !== "boolean"
      || typeof response.compatible !== "boolean"
      || typeof response.driverApiVersion !== "number"
      || typeof response.deviceCount !== "number") {
      throw new Error("Windows host returned an invalid CUDA status");
    }
    return {
      driverPresent: response.driverPresent,
      compatible: response.compatible,
      driverApiVersion: response.driverApiVersion,
      deviceCount: response.deviceCount,
    };
  }

  async extractSubset(
    zipFiles: readonly string[],
    patterns: readonly string[],
    targetDirectory: string,
  ): Promise<number> {
    if (this.stopOperation !== null) {
      throw new Error("Windows host is stopping");
    }
    if (!existsSync(this.executable)) {
      throw new Error(`Windows host executable is missing: ${this.executable}`);
    }
    const child = spawn(this.executable, ["--extract-subset"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.extractionChildren.add(child);
    let stdout = "";
    let stderr = "";
    let stdinError = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.once("error", (error) => { stdinError = error.message; });

    let timedOut = false;
    const completion = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, EXTRACTION_TIMEOUT_MS);
    child.stdin.write(`${JSON.stringify({
      protocol: PROTOCOL_VERSION,
      zipFiles: [...zipFiles],
      patterns: [...patterns],
      targetDirectory,
    })}\n`);

    let exitCode: number | null;
    try {
      exitCode = await completion;
    } finally {
      clearTimeout(timer);
      this.extractionChildren.delete(child);
    }
    if (timedOut) {
      throw new Error("Windows host extraction timed out");
    }
    const response = parseOneShotResponse(stdout);
    if (exitCode !== 0) {
      const detail = typeof response?.message === "string"
        ? response.message
        : stderr.trim() || stdinError;
      throw new Error(`Windows host extraction failed${detail.length > 0 ? `: ${detail}` : ""}`);
    }
    if (response?.protocol !== PROTOCOL_VERSION || typeof response.fileCount !== "number") {
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
    if (this.stopOperation !== null) return await this.stopOperation;
    const operation = this.stopOwnedProcesses();
    this.stopOperation = operation;
    try {
      await operation;
    } finally {
      if (this.stopOperation === operation) this.stopOperation = null;
    }
  }

  private async stopOwnedProcesses(): Promise<void> {
    const extractions = [...this.extractionChildren];
    for (const extraction of extractions) {
      if (isRunning(extraction)) extraction.kill();
    }
    await Promise.all(extractions.map(waitForClose));

    const child = this.child;
    if (child === null) return;
    try {
      await this.request("shutdown", "shuttingDown");
    } catch {
      child.kill();
    }
    await waitForExit(child, this.requestTimeoutMs);
    if (isRunning(child)) {
      child.kill();
      await waitForExit(child, this.requestTimeoutMs);
    }
    if (isRunning(child)) throw new Error("Windows host did not exit");
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

export async function getCudaStatusBestEffort(
  host: Pick<WindowsHost, "getCudaStatus">,
  onError: (error: unknown) => void = () => undefined,
): Promise<CudaStatus> {
  try {
    return await host.getCudaStatus();
  } catch (error) {
    onError(error);
    return { ...NO_CUDA_STATUS };
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
    && typeof value.virtualKey === "number"
    && typeof value.injected === "boolean";
}

function isFocusIdentity(
  state: unknown,
  value: unknown,
): state is ForegroundInfo["focusIdentityState"] {
  return state === "available"
    ? typeof value === "string" && value.length > 0
    : (state === "unavailable" || state === "degraded") && value === null;
}

function isGuardedPasteResponse(
  status: unknown,
  reason: unknown,
): status is GuardedPasteResult | "paste-failed" {
  if (status === "pasted") return reason === "none";
  if (status === "paste-failed") return reason === "send-input";
  if (status === "focus-changed") {
    return reason === "window-changed"
      || reason === "control-changed"
      || reason === "identity-changed";
  }
  if (status !== "focus-unavailable") return false;
  return reason === "window-unavailable"
    || reason === "focus-unavailable"
    || reason === "identity-unavailable"
    || reason === "input-race"
    || reason === "snapshot-unstable";
}

function parseOneShotResponse(output: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(output.trim());
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<void> {
  if (!isRunning(child)) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForClose(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!isRunning(child)) return;
  await new Promise<void>((resolve) => child.once("close", () => resolve()));
}

function isRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}
