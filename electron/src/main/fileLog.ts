import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";

interface FileLog {
  flush(): Promise<void>;
}

export function installFileLog(logPath: string): FileLog {
  let writes: Promise<void> = Promise.resolve();
  const originals = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    log: console.log.bind(console),
  };
  const write = (level: string, values: readonly unknown[]): void => {
    const line = `${new Date().toISOString()} ${level} ${values.map(format).join(" ")}\n`;
    writes = writes.then(async () => {
      await mkdir(path.dirname(logPath), { recursive: true });
      await appendFile(logPath, line, "utf8");
    }).catch(() => undefined);
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

function format(value: unknown): string {
  return typeof value === "string" ? value : inspect(value, { depth: 4, breakLength: 160 });
}
