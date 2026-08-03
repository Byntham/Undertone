import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

const executableArgument = process.argv.slice(2).find((value) => !value.startsWith("--"));
const executable = executableArgument === undefined
  ? path.resolve("release", "win-unpacked", "Undertone.exe")
  : path.resolve(executableArgument);
if (!existsSync(executable)) {
  throw new Error(`Packaged executable is missing: ${executable}`);
}

const resultPath = path.join(os.tmpdir(), `undertone-package-smoke-${randomUUID()}.txt`);
const profilePath = `${resultPath}-profile`;
const localRuntimeSmoke = process.argv.includes("--local");
const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...childEnvironment,
    UNDERTONE_PACKAGE_SMOKE: "1",
    UNDERTONE_PACKAGE_SMOKE_RESULT: resultPath,
    UNDERTONE_PACKAGE_SMOKE_PROFILE: profilePath,
    ...(localRuntimeSmoke ? { UNDERTONE_LOCAL_RUNTIME_SMOKE: "1" } : {}),
  },
});

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill();
    reject(new Error("Packaged smoke timed out"));
  }, localRuntimeSmoke ? 150_000 : 10_000);
  child.once("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.once("close", (code) => {
    clearTimeout(timer);
    resolve(code);
  });
});

let marker = "";
try {
  marker = await readFile(resultPath, "utf8");
} catch {
  // The failure below reports the process exit alongside the absent marker.
} finally {
  await unlink(resultPath).catch(() => undefined);
  await rm(profilePath, { recursive: true, force: true });
}
if (result !== 0 || marker !== "ok") {
  throw new Error(`Packaged smoke failed (exit ${String(result)}, marker ${marker || "missing"})`);
}
console.log(localRuntimeSmoke ? "PACKAGED_LOCAL_RUNTIME_SMOKE_OK" : "PACKAGED_SMOKE_OK");
