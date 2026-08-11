import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

export const APP_LOG_MAX_BYTES = 5 * 1024 * 1024;

interface FileLog {
  flush(): Promise<void>;
}

export function installFileLog(logPath: string): FileLog {
  const originals = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    log: console.log.bind(console),
  };
  const reportFailure = (action: string, error: unknown): void => {
    originals.error(`File logging ${action} failed:`, error);
  };
  let writes = initialize(logPath).catch((error: unknown) => {
    reportFailure("initialization", error);
  });
  const write = (level: string, values: readonly unknown[]): void => {
    const line = `${new Date().toISOString()} ${level} ${values.map(format).join(" ")}\n`;
    writes = writes
      .then(() => appendFile(logPath, line, "utf8"))
      .catch((error: unknown) => {
        reportFailure("write", error);
      });
  };
  console.error = (...values: unknown[]) => {
    originals.error(...values);
    write("ERROR", values);
  };
  console.warn = (...values: unknown[]) => {
    originals.warn(...values);
    write("WARNING", values);
  };
  console.log = (...values: unknown[]) => {
    originals.log(...values);
    write("INFO", values);
  };
  write("INFO", ["Electron app starting"]);
  return { flush: async () => await writes };
}

async function initialize(logPath: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  try {
    if ((await stat(logPath)).size < APP_LOG_MAX_BYTES) return;
  } catch (error: unknown) {
    if (isMissingFile(error)) return;
    throw error;
  }

  const backupPath = `${logPath}.previous`;
  await rm(backupPath, { force: true });
  await rename(logPath, backupPath);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function format(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 160 });
}
