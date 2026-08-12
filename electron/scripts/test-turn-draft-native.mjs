import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const electron = require("electron");
const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "test-output", "turn-draft-native");
const localAppData = process.env.LOCALAPPDATA;
if (!localAppData) throw new Error("LOCALAPPDATA is unavailable");
const profileDir = path.join(localAppData, "Undertone", "TurnDraftNativeE2E");
const driverSource = path.join(import.meta.dirname, "turn-draft-native-driver.cs");
const driver = path.join(outputDir, "TurnDraftNativeDriver.exe");
const compiler = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

await cleanTestState();
try {
  await mkdir(outputDir, { recursive: true });
  await execFileAsync(compiler, [
    "/nologo",
    "/optimize+",
    "/platform:x64",
    `/out:${driver}`,
    driverSource,
  ]);

  await runAppTest(20, "stress");
  await runAppTest(1, "restart");
  console.log("TURN_DRAFT_NATIVE_E2E_OK cycles=20 restarts=1");
} finally {
  await cleanTestState();
}

async function runAppTest(cycles, label) {
  const env = { ...process.env, UNDERTONE_TURN_DRAFT_NATIVE_E2E: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const appProcess = spawn(electron, ["."], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let appOutput = "";
  appProcess.stdout.on("data", (chunk) => { appOutput += chunk; });
  appProcess.stderr.on("data", (chunk) => { appOutput += chunk; });
  try {
    const result = await execFileAsync(driver, [String(cycles)], {
      cwd: root,
      timeout: 120_000,
      windowsHide: true,
    });
    process.stdout.write(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} failed: ${detail}\n${appOutput}`);
  } finally {
    if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill();
    if (!await waitForExit(appProcess, 2_000)) {
      if (appProcess.pid !== undefined) {
        await execFileAsync("taskkill", ["/PID", String(appProcess.pid), "/T", "/F"])
          .catch(() => undefined);
      }
      await waitForExit(appProcess, 2_000);
      throw new Error(`${label} left Electron running after termination\n${appOutput}`);
    }
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function cleanTestState() {
  await rm(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
