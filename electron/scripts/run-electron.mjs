import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const target = process.argv[2];
if (!target) {
  throw new Error("Usage: node scripts/run-electron.mjs <app-path>");
}

const require = createRequire(import.meta.url);
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, [target], {
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  if (signal !== null) {
    console.error(`Electron exited via ${signal}`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});
