import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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

  it.skipIf(process.env.UNDERTONE_HOST_DESKTOP_E2E !== "1")(
    "restores a WPF target, reads its caret, and pastes through SendInput",
    async () => {
      const temporary = await mkdtemp(path.join(os.tmpdir(), "undertone-host-e2e-"));
      const scriptPath = path.join(temporary, "target.ps1");
      const target = desktopTargetPaths(temporary, "target");
      const thief = desktopTargetPaths(temporary, "thief");
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
        expect(await host.focusWindow(thiefWindow)).toBe(true);
        expect((await host.getForeground()).window).toBe(thiefWindow);
        expect(await host.focusWindow(targetWindow)).toBe(true);
        expect((await host.getForeground()).window).toBe(targetWindow);
        expect(await host.getCaretContext(120, 120)).toEqual({
          before: "I like ",
          after: "apples.",
        });

        setClipboardText("hello ");
        expect(await host.sendPaste()).toBe(true);
        await delay(300);
        await writeFile(target.stop, "", "utf8");
        await writeFile(thief.stop, "", "utf8");
        await waitForChildExit(targetProcess, 5_000);
        await waitForChildExit(thiefProcess, 5_000);
        expect(await readFile(target.result, "utf8")).toBe("I like hello apples.");
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
}

const WPF_TARGET_SCRIPT = String.raw`param(
  [string]$Title,
  [string]$HwndPath,
  [string]$ResultPath,
  [string]$StopPath,
  [string]$InitialText,
  [int]$CaretIndex
)
Add-Type -AssemblyName PresentationFramework
$window = New-Object System.Windows.Window
$window.Title = $Title
$window.Width = 500
$window.Height = 220
$window.Topmost = $true
$textBox = New-Object System.Windows.Controls.TextBox
$textBox.Text = $InitialText
$textBox.CaretIndex = [Math]::Min($CaretIndex, $textBox.Text.Length)
$window.Content = $textBox
$window.Add_ContentRendered({
  $handle = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  [IO.File]::WriteAllText($HwndPath, $handle.ToInt64().ToString())
  $window.Activate() | Out-Null
  $textBox.Focus() | Out-Null
})
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(50)
$timer.Add_Tick({
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
  };
}

function startDesktopTarget(
  scriptPath: string,
  title: string,
  files: DesktopTargetPaths,
  initialText: string,
  caretIndex: number,
): ReturnType<typeof spawn> {
  return spawn("powershell", [
    "-NoProfile",
    "-WindowStyle", "Hidden",
    "-STA",
    "-ExecutionPolicy", "Bypass",
    "-File", scriptPath,
    "-Title", title,
    "-HwndPath", files.hwnd,
    "-ResultPath", files.result,
    "-StopPath", files.stop,
    "-InitialText", initialText,
    "-CaretIndex", String(caretIndex),
  ], { windowsHide: true, stdio: "ignore" });
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
    "-Command", "$value=[Console]::In.ReadToEnd(); Set-Clipboard -Value $value",
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

async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 2_000,
): Promise<void> {
  if (child.exitCode !== null) return;
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
