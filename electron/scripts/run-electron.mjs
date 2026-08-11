import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: node scripts/run-electron.mjs <app-path>");
}

const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const captureProfile = path.basename(target).startsWith("capture-")
  ? path.join(tmpdir(), `undertone-${path.basename(target, ".cjs")}-${process.pid}`)
  : null;
if (captureProfile !== null) env.UNDERTONE_CAPTURE_PROFILE = captureProfile;

const child = spawn(electron, [target, ...process.argv.slice(3)], {
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", async (code, signal) => {
  if (captureProfile !== null) {
    try {
      await rm(captureProfile, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      console.error(`Failed to remove capture profile: ${error}`);
      process.exitCode = 1;
      return;
    }
  }
  if (signal !== null) {
    console.error(`Electron exited via ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
