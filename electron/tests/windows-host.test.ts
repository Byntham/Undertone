import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

import { describe, expect, it } from "vitest";

import { resolveWindowsHost, WindowsHost } from "../src/platform/windowsHost";

describe("Windows host", () => {
  it("negotiates protocol and handles lifecycle commands", async () => {
    const host = new WindowsHost();
    const ready = await host.start();
    expect(ready.protocol).toBe(1);
    expect(ready.keyboardHook).toBe(true);
    expect(ready.mouseHook).toBe(true);
    await host.ping();
    const foreground = await host.getForeground();
    expect(typeof foreground.window).toBe("string");
    expect(typeof foreground.processId).toBe("number");
    const caret = await host.getCaretContext(20, 20);
    expect(caret === null || typeof caret.before === "string").toBe(true);
    const protectedValue = await host.protectSecret("test-only-secret");
    expect(protectedValue).toMatch(/^dpapi:/);
    expect(await host.unprotectSecret(protectedValue)).toBe("test-only-secret");
    expect(await host.unprotectSecret("legacy-plaintext")).toBe("legacy-plaintext");
    expect(await host.unprotectSecret("dpapi:not-base64")).toBe("");
    await host.startInput();
    await host.stopInput();
    await host.stop();
  });

  it("exits when its parent pipe closes", async () => {
    const child = spawn(resolveWindowsHost(), [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Host readiness timed out")), 2_000);
      lines.once("line", (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line) as Record<string, unknown>);
      });
    });
    expect(ready.type).toBe("ready");
    child.stdin.end();
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Host did not exit after stdin closed"));
      }, 2_000);
      child.once("close", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    expect(code).toBe(0);
  });

  it("terminates supervised processes when the host exits", async () => {
    const host = new WindowsHost();
    await host.start();
    let processId: number | undefined;
    try {
      const windows = process.env.SystemRoot ?? "C:\\Windows";
      processId = await host.spawnSupervised(
        path.join(windows, "System32", "ping.exe"),
        "127.0.0.1 -n 30",
      );
      expect(isProcessAlive(processId)).toBe(true);
      await host.stop();
      await waitUntilStopped(processId);
      expect(isProcessAlive(processId)).toBe(false);
    } finally {
      await host.stop();
      if (processId !== undefined && isProcessAlive(processId)) {
        process.kill(processId);
      }
    }
  });

  it("terminates supervised processes when the host is forcibly killed", async () => {
    const child = spawn(resolveWindowsHost(), [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let processId: number | undefined;
    try {
      await nextLine(lines);
      const responsePromise = nextLine(lines);
      const windows = process.env.SystemRoot ?? "C:\\Windows";
      child.stdin.write(`${JSON.stringify({
        protocol: 1,
        type: "spawnSupervised",
        requestId: "forced-exit",
        file: path.join(windows, "System32", "ping.exe"),
        arguments: "127.0.0.1 -n 30",
      })}\n`);
      const response = JSON.parse(await responsePromise) as Record<string, unknown>;
      expect(response.type).toBe("processStarted");
      expect(typeof response.processId).toBe("number");
      processId = response.processId as number;
      expect(isProcessAlive(processId)).toBe(true);
      child.kill();
      await waitForChildExit(child);
      await waitUntilStopped(processId);
      expect(isProcessAlive(processId)).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
      if (processId !== undefined && isProcessAlive(processId)) {
        process.kill(processId);
      }
    }
  });
});

async function nextLine(lines: readline.Interface): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host response timed out")), 2_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host exit timed out")), 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilStopped(processId: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && isProcessAlive(processId)) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
