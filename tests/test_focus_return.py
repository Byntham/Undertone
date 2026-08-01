"""Manual focus-return integration test using disposable WPF targets.

Starts a dictation into target A, then focuses target B while fake STT is in
flight. The pipeline must restore A and paste there. This necessarily changes
the foreground window: set UNDERTONE_FOCUS_E2E=1 only on an idle desktop.
"""

import ctypes
import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pyperclip

import caretctx
import localproc
import main as main_mod

PY = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
EXPECTED = "landed in the right window"
TITLE_A = f"Undertone Focus A {os.getpid()}"
TITLE_B = f"Undertone Focus B {os.getpid()}"
failures = []


def wpf_script(title):
    return rf"""
Add-Type -AssemblyName PresentationFramework
$win = New-Object System.Windows.Window
$win.Title = '{title}'
$win.Width = 500; $win.Height = 220; $win.Topmost = $true
$tb = New-Object System.Windows.Controls.TextBox
$win.Content = $tb
$win.Add_ContentRendered({{ $win.Activate() | Out-Null; $tb.Focus() | Out-Null }})
[void]$win.ShowDialog()
"""


def start_target(title):
    proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-STA",
         "-Command", wpf_script(title)]
    )
    return proc, localproc.attach_job(proc)


def stop_target(proc, job, hwnd):
    if hwnd:
        ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        localproc.close_job(job)
        job = None
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
    finally:
        localproc.close_job(job)


def wait_target(title, timeout=6.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        hwnd = ctypes.windll.user32.FindWindowW(None, title)
        if hwnd:
            return hwnd
        time.sleep(0.2)
    return 0


def inject(code):
    subprocess.run([PY, "-c", f"import keyboard, time\n{code}"], check=True)


def read_back():
    pyperclip.copy("<<SENTINEL>>")
    inject("keyboard.send('ctrl+a'); time.sleep(0.2); keyboard.send('ctrl+c')")
    time.sleep(0.5)
    return pyperclip.paste()


def fake_transcribe(wav, api_key, *args, **kwargs):
    time.sleep(1.5)  # window for target B to take focus
    return EXPECTED


TEST_CFG = {
    **main_mod.config_mod.DEFAULT_CONFIG,
    "api_key": "test-key",
    "hotkey": "f13",
    "sound_cues": False,
    "ai_cleanup": False,
    "smart_formatting": False,
}


def scenario(app):
    proc_a, job_a = start_target(TITLE_A)
    proc_b = job_b = None
    hwnd_a = hwnd_b = 0
    try:
        hwnd_a = wait_target(TITLE_A)
        assert hwnd_a and caretctx.focus_window(hwnd_a), \
            "could not focus target A"
        time.sleep(0.5)

        inject("keyboard.press('f13'); time.sleep(0.6); "
               "keyboard.release('f13')")
        proc_b, job_b = start_target(TITLE_B)
        hwnd_b = wait_target(TITLE_B)
        assert hwnd_b and caretctx.focus_window(hwnd_b), \
            "could not focus target B"
        time.sleep(3.0)  # transcribe + refocus + paste + clipboard restore

        assert caretctx.focus_window(hwnd_a), "could not refocus target A"
        time.sleep(0.3)
        got = read_back()
        if got != EXPECTED:
            failures.append(f"target A content: {got!r}, want {EXPECTED!r}")
        else:
            print(f"  [focus] paste followed the dictation target: {got!r}")
    except Exception as exc:
        failures.append(f"{type(exc).__name__}: {exc}")
    finally:
        if proc_b is not None:
            stop_target(proc_b, job_b, hwnd_b)
        stop_target(proc_a, job_a, hwnd_a)
        app._post(app._quit)


def run():
    if os.environ.get("UNDERTONE_FOCUS_E2E") != "1":
        print("SKIPPED: set UNDERTONE_FOCUS_E2E=1 only on an idle desktop")
        return
    main_mod.transcribe = fake_transcribe
    main_mod.config_mod.load_config = lambda: dict(TEST_CFG)

    app = main_mod.App()
    app.ptt.start()
    threading.Thread(target=scenario, args=(app,), daemon=True).start()
    app.qapp.exec()

    if failures:
        print("FAILED:", repr(failures))
        sys.exit(1)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    run()
