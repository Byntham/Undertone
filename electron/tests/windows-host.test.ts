import { spawn } from "node:child_process";
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
});
