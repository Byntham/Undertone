import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { APP_LOG_MAX_BYTES, installFileLog } from "../src/main/fileLog";

const originalConsole = {
  error: console.error,
  warn: console.warn,
  log: console.log,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.log = originalConsole.log;
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
  vi.restoreAllMocks();
});

describe.sequential("file logging", () => {
  it("creates a missing log directory and preserves console output", async () => {
    const root = await temporaryDirectory();
    const logPath = path.join(root, "logs", "app.log");
    const originalLog = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const log = installFileLog(logPath);
    console.log("ready", { count: 2 });
    await log.flush();

    expect(originalLog).toHaveBeenCalledWith("ready", { count: 2 });
    expect(await readFile(logPath, "utf8")).toMatch(
      /INFO Electron app starting\r?\n.*INFO ready \{ count: 2 \}\r?\n$/s,
    );
  });

  it("rotates an oversized log into one startup backup", async () => {
    const root = await temporaryDirectory();
    const logPath = path.join(root, "app.log");
    await writeFile(`${logPath}.previous`, "obsolete", "utf8");
    await writeFile(logPath, "old", "utf8");
    await truncate(logPath, APP_LOG_MAX_BYTES);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const log = installFileLog(logPath);
    console.log("new session");
    await log.flush();

    expect((await stat(`${logPath}.previous`)).size).toBe(APP_LOG_MAX_BYTES);
    expect(await readFile(logPath, "utf8")).toMatch(
      /INFO Electron app starting\r?\n.*INFO new session\r?\n$/s,
    );
  });

  it("reports a rotation failure and continues writing without an unhandled rejection", async () => {
    const root = await temporaryDirectory();
    const logPath = path.join(root, "app.log");
    await writeFile(logPath, "old", "utf8");
    await truncate(logPath, APP_LOG_MAX_BYTES);
    await mkdir(`${logPath}.previous`);
    await writeFile(path.join(`${logPath}.previous`, "keep"), "occupied", "utf8");
    const originalError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const log = installFileLog(logPath);
    await expect(log.flush()).resolves.toBeUndefined();

    expect(originalError).toHaveBeenCalledWith(
      "File logging initialization failed:",
      expect.anything(),
    );
    expect((await stat(logPath)).size).toBeGreaterThan(APP_LOG_MAX_BYTES);
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "undertone-file-log-"));
  temporaryDirectories.push(directory);
  return directory;
}
