import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { describe, expect, it } from "vitest";

import { DirectLiveTextWriter } from "../src/core/directLiveTextWriter";
import {
  getCudaStatusBestEffort,
  resolveWindowsHost,
  WindowsHost,
} from "../src/platform/windowsHost";

describe("Windows host", () => {
  it("treats an unavailable optional CUDA probe as no compatible GPU", async () => {
    const errors: unknown[] = [];
    await expect(getCudaStatusBestEffort({
      async getCudaStatus() {
        throw new Error("CUDA probe timed out");
      },
    }, (error) => errors.push(error))).resolves.toEqual({
      driverPresent: false,
      compatible: false,
      driverApiVersion: 0,
      deviceCount: 0,
    });
    expect(errors).toHaveLength(1);
  });

  it("negotiates protocol and handles lifecycle commands", async () => {
    const host = new WindowsHost();
    try {
      const ready = await host.start();
      expect(ready.protocol).toBe(11);
      expect(ready.keyboardHook).toBe(true);
      expect(ready.mouseHook).toBe(true);
      const foreground = await host.getForeground();
      expect(typeof foreground.window).toBe("string");
      expect(typeof foreground.focus).toBe("string");
      expect(foreground.focusIdentityState).toMatch(/^(available|unavailable|degraded)$/u);
      expect(foreground.focusIdentityState === "available"
        ? typeof foreground.focusIdentity === "string"
        : foreground.focusIdentity === null).toBe(true);
      expect(typeof foreground.generation).toBe("string");
      expect(foreground.targetState).toMatch(
        /^(editable|non-editable|password|disabled|read-only|unknown)$/u,
      );
      const protectedValue = await host.protectSecret("test-only-secret");
      expect(protectedValue).toMatch(/^dpapi:/);
      expect(await host.unprotectSecret(protectedValue)).toBe("test-only-secret");
      expect(await host.unprotectSecret("plaintext")).toBe("");
      expect(await host.unprotectSecret("dpapi:not-base64")).toBe("");
      const cuda = await host.getCudaStatus();
      expect(typeof cuda.driverPresent).toBe("boolean");
      expect(typeof cuda.compatible).toBe("boolean");
      expect(cuda.driverApiVersion).toBeGreaterThanOrEqual(0);
      expect(cuda.deviceCount).toBeGreaterThanOrEqual(0);
      await host.setInputMode("listen");
      await host.setInputMode("shortcut-capture");
      await host.setInputMode("off");
      await expect(host.sendText("")).resolves.toBe(true);
    } finally {
      await host.stop();
    }
  }, 10_000);

  it("requires guarded target identity fields and accepts only explicit input modes", async () => {
    const child = spawn(resolveWindowsHost(), [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    let requestId = 0;
    const command = async (
      type: string,
      values: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const id = String(++requestId);
      child.stdin.write(`${JSON.stringify({
        ...values,
        protocol: 11,
        type,
        requestId: id,
      })}\n`);
      return await nextResponse(lines, id);
    };
    try {
      await nextLine(lines);
      await expect(command("setInputMode", { mode: "invalid" })).resolves.toMatchObject({
        type: "error",
      });
      await expect(command("sendText", { text: 42 })).resolves.toMatchObject({ type: "error" });

      const required = {
        window: "not-current",
        focus: "0",
        focusIdentityState: "unavailable",
        focusIdentity: null,
        generation: "0",
      };
      await expect(command("guardedPaste", required)).resolves.toMatchObject({
        type: "guardedPasteResult",
        status: "focus-changed",
      });
      await expect(command("guardedText", { ...required, text: "hello" }))
        .resolves.toMatchObject({
          type: "guardedTextResult",
          status: "focus-changed",
        });
      for (const invalid of [
        { ...required, focus: undefined },
        { ...required, generation: undefined },
        { ...required, focusIdentityState: undefined },
        { ...required, window: 42 },
        { ...required, focus: 0 },
        { ...required, generation: 0 },
        { ...required, focusIdentityState: "available", focusIdentity: null },
        { ...required, focusIdentityState: "unavailable", focusIdentity: "uia:1" },
        { ...required, focusIdentityState: "degraded" },
      ]) {
        await expect(command("guardedPaste", invalid)).resolves.toMatchObject({ type: "error" });
      }
    } finally {
      await stopChild(child, true);
    }
  });

  it("exits when its parent pipe closes", async () => {
    const child = spawn(resolveWindowsHost(), [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = readline.createInterface({ input: child.stdout });
    try {
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
    } finally {
      await stopChild(child, true);
    }
  });

  it("extracts only matching runtime files from ZIP archives", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "undertone-host-zip-"));
    const source = path.join(temporary, "source");
    const archive = path.join(temporary, "runtime.zip");
    const target = path.join(temporary, "target");
    const stoppedTarget = path.join(temporary, "stopped-target");
    const disconnectedTarget = path.join(temporary, "disconnected-target");
    const host = new WindowsHost();
    let extractionChild: ReturnType<typeof spawn> | null = null;
    try {
      await mkdir(source);
      await writeFile(path.join(source, "whisper-server.exe"), "server", "utf8");
      await writeFile(path.join(source, "unused-demo.exe"), "unused", "utf8");
      await writeFile(path.join(source, "large-model.bin"), Buffer.alloc(16 * 1024 * 1024));
      const zipped = spawnSync("powershell", [
        "-NoProfile",
        "-Command",
        `Compress-Archive -Path '${source}\\*' -DestinationPath '${archive}'`,
      ], { windowsHide: true, encoding: "utf8" });
      if (zipped.status !== 0) throw new Error(`Could not create test ZIP: ${zipped.stderr}`);

      expect(await host.extractSubset(
        [archive],
        ["whisper-server.exe", "ggml-cpu-*.dll"],
        target,
      )).toBe(1);
      expect(await readFile(path.join(target, "whisper-server.exe"), "utf8"))
        .toBe("server");
      await expect(readFile(path.join(target, "unused-demo.exe"), "utf8"))
        .rejects.toThrow();

      const stoppedExtraction = host.extractSubset(
        [archive],
        ["large-model.bin"],
        stoppedTarget,
      );
      const stoppedResult = expect(stoppedExtraction).rejects.toThrow();
      await host.stop();
      await stoppedResult;
      await expect(readFile(path.join(stoppedTarget, "large-model.bin")))
        .rejects.toThrow();

      const child = spawn(resolveWindowsHost(), ["--extract-subset"], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      extractionChild = child;
      child.stdout.resume();
      child.stderr.resume();
      child.stdin.write(`${JSON.stringify({
        protocol: 11,
        zipFiles: [archive],
        patterns: ["large-model.bin"],
        targetDirectory: disconnectedTarget,
      })}\n`);
      child.stdin.end();
      expect(await waitForChildExitCode(child)).not.toBe(0);
      await expect(readFile(path.join(disconnectedTarget, "large-model.bin")))
        .rejects.toThrow();
      await expect(stat(`${disconnectedTarget}.tmp`)).rejects.toThrow();
    } finally {
      try {
        await host.stop();
      } finally {
        if (extractionChild !== null) await stopChild(extractionChild);
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }, 20_000);

  it("terminates supervised processes when the host exits", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "undertone-host-log-"));
    const logFile = path.join(temporary, "child.log");
    const host = new WindowsHost();
    let processId: number | undefined;
    try {
      await host.start();
      const windows = process.env.SystemRoot ?? "C:\\Windows";
      processId = await host.spawnSupervised(
        path.join(windows, "System32", "ping.exe"),
        "127.0.0.1 -n 30",
        "",
        logFile,
      );
      expect(isProcessAlive(processId)).toBe(true);
      expect(await host.isSupervisedRunning(processId)).toBe(true);
      expect((await waitForTextFile(logFile)).length).toBeGreaterThan(0);
      await host.stop();
      await waitUntilStopped(processId);
      expect(isProcessAlive(processId)).toBe(false);
    } finally {
      await host.stop();
      if (processId !== undefined && isProcessAlive(processId)) {
        process.kill(processId);
      }
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("tracks liveness and terminates an individual process tree", async () => {
    const temporary = await mkdtemp(path.join(os.tmpdir(), "undertone-host-tree-"));
    const scriptPath = path.join(temporary, "tree.ps1");
    const childIdPath = path.join(temporary, "child.txt");
    const host = new WindowsHost();
    let rootProcessId: number | undefined;
    let childProcessId: number | undefined;
    try {
      await writeFile(scriptPath, [
        "Start-Sleep -Milliseconds 300",
        "$child = Start-Process ping.exe -ArgumentList '127.0.0.1 -n 30' -PassThru -WindowStyle Hidden",
        `[IO.File]::WriteAllText('${childIdPath.replaceAll("'", "''")}', $child.Id.ToString())`,
        "$child.WaitForExit()",
      ].join("\r\n"), "utf8");
      await host.start();
      rootProcessId = await host.spawnSupervised(
        "powershell.exe",
        `-NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
        temporary,
      );
      childProcessId = Number(await waitForTextFile(childIdPath));
      expect(isProcessAlive(rootProcessId)).toBe(true);
      expect(isProcessAlive(childProcessId)).toBe(true);
      expect(await host.stopSupervised(rootProcessId)).toBe(true);
      await waitUntilStopped(rootProcessId);
      await waitUntilStopped(childProcessId);
      expect(isProcessAlive(rootProcessId)).toBe(false);
      expect(isProcessAlive(childProcessId)).toBe(false);

      const exitProcessId = await host.spawnSupervised("cmd.exe", "/d /s /c \"exit /b 0\"");
      await waitUntilHostReportsStopped(host, exitProcessId);
      expect(await host.isSupervisedRunning(exitProcessId)).toBe(false);
    } finally {
      await host.stop();
      if (rootProcessId !== undefined && isProcessAlive(rootProcessId)) {
        process.kill(rootProcessId);
      }
      if (childProcessId !== undefined && isProcessAlive(childProcessId)) {
        process.kill(childProcessId);
      }
      await rm(temporary, { recursive: true, force: true });
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
        protocol: 11,
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
      await stopChild(child);
      if (processId !== undefined && isProcessAlive(processId)) {
        process.kill(processId);
      }
    }
  });

  it.skipIf(process.env.UNDERTONE_HOST_DESKTOP_E2E !== "1")(
    "validates focused controls and sends paste and Unicode text through SendInput",
    async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "undertone-host-e2e-"));
      const scriptPath = path.join(temporary, "target.ps1");
      const target = desktopTargetPaths(temporary, "target");
      const thief = desktopTargetPaths(temporary, "thief");
      // This opt-in test can preserve text only; run it with a disposable text clipboard.
      const previousClipboard = getClipboardText();
      let targetProcess: ReturnType<typeof spawn> | null = null;
      let thiefProcess: ReturnType<typeof spawn> | null = null;
      const host = new WindowsHost({ requestTimeoutMs: 5_000 });
      try {
        await writeFile(scriptPath, WPF_TARGET_SCRIPT, "utf8");
        targetProcess = startDesktopTarget(
          scriptPath,
          "Undertone Electron Host Target",
          target,
          "I like apples.",
          7,
        );
        thiefProcess = startDesktopTarget(
          scriptPath,
          "Undertone Electron Host Thief",
          thief,
          "",
          0,
        );
        const targetWindow = await waitForTextFile(target.hwnd);
        const thiefWindow = await waitForTextFile(thief.hwnd);

        await host.start();
        await activateTarget(thief);
        await waitForForeground(host, (foreground) => foreground.window === thiefWindow);
        await activateTarget(target);
        const textTarget = await waitForAvailableForeground(
          host,
          (foreground) => foreground.window === targetWindow,
        );

        await writeFile(target.focusOther, "", "utf8");
        await waitForAvailableForeground(host, (foreground) => (
          foreground.window === targetWindow
          && foreground.focusIdentity !== textTarget.focusIdentity
        ));
        setClipboardText("should not paste");
        expect(await host.sendGuardedPaste(textTarget)).toBe("focus-changed");

        await writeFile(target.focusText, "", "utf8");
        const freshTarget = await waitForAvailableForeground(host, (foreground) => (
          foreground.window === targetWindow
          && foreground.focusIdentity === textTarget.focusIdentity
        ));
        setClipboardText("hello ");
        expect(await host.sendGuardedPaste(freshTarget)).toBe("pasted");
        const writer = new DirectLiveTextWriter(
          async (text) => await host.sendGuardedText(freshTarget, text),
          (error) => { throw error; },
        );
        writer.append("café");
        writer.append(" 😀");
        await writer.finish("café 😀");
        await delay(300);
        await writeFile(target.stop, "", "utf8");
        await writeFile(thief.stop, "", "utf8");
        await waitForChildExit(targetProcess, 5_000);
        await waitForChildExit(thiefProcess, 5_000);
        expect(await readFile(target.result, "utf8")).toBe("I like hello café 😀 apples.");
      } finally {
        try {
          await host.stop();
        } finally {
          try {
            setClipboardText(previousClipboard);
          } finally {
            targetProcess?.kill();
            thiefProcess?.kill();
            await rm(temporary, { recursive: true, force: true });
          }
        }
      }
    },
    20_000,
  );
});

interface DesktopTargetPaths {
  hwnd: string;
  result: string;
  stop: string;
  activate: string;
  focusOther: string;
  focusText: string;
}

const WPF_TARGET_SCRIPT = String.raw`param(
  [string]$Title,
  [string]$HwndPath,
  [string]$ResultPath,
  [string]$StopPath,
  [string]$ActivatePath,
  [string]$FocusOtherPath,
  [string]$FocusTextPath,
  [string]$InitialText,
  [int]$InsertionIndex
)
Add-Type -AssemblyName PresentationFramework
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class TestFocus {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool value);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static void Activate(IntPtr target) {
    uint ignored;
    var foreground = GetForegroundWindow();
    var foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out ignored);
    var targetThread = GetWindowThreadProcessId(target, out ignored);
    var currentThread = GetCurrentThreadId();
    var attachedForeground = foregroundThread != 0 && foregroundThread != currentThread
      && AttachThreadInput(currentThread, foregroundThread, true);
    var attachedTarget = targetThread != 0 && targetThread != currentThread
      && targetThread != foregroundThread && AttachThreadInput(currentThread, targetThread, true);
    try {
      for (var attempt = 0; attempt < 10 && GetForegroundWindow() != target; attempt++) {
        BringWindowToTop(target);
        SetForegroundWindow(target);
        Thread.Sleep(20);
      }
    } finally {
      if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
      if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
    }
  }
}
'@
$window = New-Object System.Windows.Window
$window.Title = $Title
$window.Width = 500
$window.Height = 220
$window.Topmost = $true
$textBox = New-Object System.Windows.Controls.TextBox
$textBox.Text = $InitialText
$textBox.CaretIndex = [Math]::Min($InsertionIndex, $textBox.Text.Length)
$other = New-Object System.Windows.Controls.Button
$other.Content = "Other control"
$panel = New-Object System.Windows.Controls.StackPanel
[void]$panel.Children.Add($textBox)
[void]$panel.Children.Add($other)
$window.Content = $panel
$window.Add_ContentRendered({
  $script:windowHandle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  [IO.File]::WriteAllText($HwndPath, $script:windowHandle.ToInt64().ToString())
  $window.Activate() | Out-Null
  $textBox.Focus() | Out-Null
})
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
  if (Test-Path -LiteralPath $ActivatePath) {
    Remove-Item -LiteralPath $ActivatePath
    [TestFocus]::Activate($script:windowHandle)
    $textBox.Focus() | Out-Null
  }
  if (Test-Path -LiteralPath $FocusOtherPath) {
    Remove-Item -LiteralPath $FocusOtherPath
    $other.Focus() | Out-Null
  }
  if (Test-Path -LiteralPath $FocusTextPath) {
    Remove-Item -LiteralPath $FocusTextPath
    $textBox.Focus() | Out-Null
  }
  if (Test-Path -LiteralPath $StopPath) {
    [IO.File]::WriteAllText($ResultPath, $textBox.Text)
    $timer.Stop()
    $window.Close()
  }
})
$timer.Start()
[void]$window.ShowDialog()
`;

function desktopTargetPaths(directory: string, name: string): DesktopTargetPaths {
  return {
    hwnd: path.join(directory, `${name}.hwnd`),
    result: path.join(directory, `${name}.txt`),
    stop: path.join(directory, `${name}.stop`),
    activate: path.join(directory, `${name}.activate`),
    focusOther: path.join(directory, `${name}.focus-other`),
    focusText: path.join(directory, `${name}.focus-text`),
  };
}

function startDesktopTarget(
  scriptPath: string,
  title: string,
  files: DesktopTargetPaths,
  initialText: string,
  insertionIndex: number,
): ReturnType<typeof spawn> {
  const arguments_ = [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Title", title,
    "-HwndPath", files.hwnd,
    "-ResultPath", files.result,
    "-StopPath", files.stop,
    "-ActivatePath", files.activate,
    "-FocusOtherPath", files.focusOther,
    "-FocusTextPath", files.focusText,
    "-InitialText", initialText,
    "-InsertionIndex", String(insertionIndex),
  ];
  return spawn("powershell", arguments_, { windowsHide: true, stdio: "ignore" });
}

async function activateTarget(files: DesktopTargetPaths): Promise<void> {
  await writeFile(files.activate, "", "utf8");
}

async function waitForForeground(
  host: WindowsHost,
  matches: (foreground: Awaited<ReturnType<WindowsHost["getForeground"]>>) => boolean,
): Promise<Awaited<ReturnType<WindowsHost["getForeground"]>>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const foreground = await host.getForeground();
    if (matches(foreground)) return foreground;
    await delay(25);
  }
  throw new Error("Foreground target did not reach the expected state");
}

type ForegroundInfo = Awaited<ReturnType<WindowsHost["getForeground"]>>;
type AvailableForeground = Extract<ForegroundInfo, { focusIdentityState: "available" }>;

async function waitForAvailableForeground(
  host: WindowsHost,
  matches: (foreground: AvailableForeground) => boolean,
): Promise<AvailableForeground> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const foreground = await host.getForeground();
    if (foreground.focusIdentityState === "available" && matches(foreground)) return foreground;
    await delay(25);
  }
  throw new Error("Foreground target did not reach the expected state");
}

async function waitForTextFile(file: string): Promise<string> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    try {
      const value = (await readFile(file, "utf8")).trim();
      if (value.length > 0) return value;
    } catch {
      // The WPF window has not finished rendering yet.
    }
    await delay(50);
  }
  throw new Error(`Desktop target did not become ready: ${file}`);
}

function getClipboardText(): string {
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command", "[Console]::Out.Write((Get-Clipboard -Raw))",
  ], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error("Could not read the clipboard");
  return result.stdout;
}

function setClipboardText(value: string): void {
  const result = spawnSync("powershell", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-Command", "$value=[Console]::In.ReadToEnd(); if ($value.Length -eq 0) { Set-Clipboard -Value @() } else { Set-Clipboard -Value $value }",
  ], { encoding: "utf8", input: value, windowsHide: true });
  if (result.status !== 0) throw new Error("Could not write the clipboard");
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function nextLine(lines: readline.Interface): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host response timed out")), 2_000);
    lines.once("line", (line) => {
      clearTimeout(timer);
      resolve(line);
    });
  });
}

async function nextResponse(
  lines: readline.Interface,
  requestId: string,
): Promise<Record<string, unknown>> {
  for (;;) {
    const value = JSON.parse(await nextLine(lines)) as Record<string, unknown>;
    if (value.requestId === requestId) return value;
  }
}

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Child exit timed out")), timeoutMs);
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

async function waitUntilHostReportsStopped(
  host: WindowsHost,
  processId: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!await host.isSupervisedRunning(processId)) return;
    await delay(25);
  }
  throw new Error(`Process did not stop: ${processId}`);
}

async function waitForChildExitCode(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5_000,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Child exit timed out"));
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function stopChild(
  child: ReturnType<typeof spawn>,
  closeInput = false,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (closeInput && child.stdin !== null && !child.stdin.destroyed) child.stdin.end();
  else child.kill();
  try {
    await waitForChildExit(child);
  } catch (error) {
    child.kill();
    await waitForChildExit(child).catch(() => undefined);
    throw error;
  }
}
