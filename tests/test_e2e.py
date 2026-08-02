"""End-to-end pipeline test: hotkey → record → (faked) STT → smart paste.

Runs the real App wiring (keyboard hook, recorder, overlay, caret context,
formatting) against a disposable WPF text box, with transcribe() replaced by
canned responses so no API key or network is needed. AI cleanup is disabled
so results are deterministic; the cleanup module has its own live test.

Key injection happens from a helper subprocess: the keyboard library hides
its own injected events from hooks in the same process (is_replaying), so
in-process keyboard.press() would never reach the app's hook.

NEEDS AN IDLE DESKTOP: pastes land in the foreground window, so touching
the mouse/keyboard while this runs steals focus and fails the run (the
clipboard sentinel catches it honestly rather than false-passing).
Set UNDERTONE_DESKTOP_E2E=1 to acknowledge and run this manual test.

Three phases:
- A: real caret context (WPF's UI Automation TextPattern) — an empty field
  means sentence start, so the first dictation is capitalized.
- B: a single dictation inserted before an existing word — both caret sides
  supply exactly one space around the insertion.
- C: caret reading stubbed to None, forcing the insertion-memory fallback
  (the terminal-like path) — unknown first context leaves the transcript
  untouched; the second dictation is spaced/lowercased from memory alone.
"""

import os
import subprocess
import sys
import threading
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pyperclip

import localproc
import main as main_mod

PY = os.path.join(ROOT, ".venv", "Scripts", "python.exe")
TARGET_TITLE = f"Undertone E2E {os.getpid()}"
WPF_SCRIPT = rf"""
Add-Type -AssemblyName PresentationFramework
$win = New-Object System.Windows.Window
$win.Title = '{TARGET_TITLE}'
$win.Width = 500; $win.Height = 220; $win.Topmost = $true
$tb = New-Object System.Windows.Controls.TextBox
$tb.AcceptsReturn = $true
$win.Content = $tb
$win.Add_ContentRendered({{ $win.Activate() | Out-Null; $tb.Focus() | Out-Null }})
[void]$win.ShowDialog()
"""

CANNED = [
    "hello world this is a test",
    "The second part continues",
]
EXPECTED_A = "Hello world this is a test the second part continues"
EXPECTED_B = "I like hello world this is a test apples."
EXPECTED_C = "hello world this is a test the second part continues"

_i = [0]
failures = []


def fake_transcribe(wav, api_key, *args, **kwargs):
    print(f"  [e2e] transcribe called: {len(wav)} bytes")
    assert len(wav) > main_mod.MIN_AUDIO_BYTES, "recorder produced audio"
    text = CANNED[_i[0] % len(CANNED)]
    _i[0] += 1
    return text


TEST_CFG = {
    **main_mod.config_mod.DEFAULT_CONFIG,
    "api_key": "test-key",
    "hotkey": "f13",
    "sound_cues": False,
    "ai_cleanup": False,
}


def inject(code):
    subprocess.run([PY, "-c", f"import keyboard, time\n{code}"], check=True)


def read_back():
    # Sentinel first: if the copy silently fails (wrong focus, empty
    # selection) we must not "pass" on a stale clipboard.
    pyperclip.copy("<<E2E-SENTINEL>>")
    inject("keyboard.send('ctrl+a'); time.sleep(0.2); keyboard.send('ctrl+c')")
    time.sleep(0.5)
    return pyperclip.paste()


def wait_target(timeout=6.0):
    """Wait for the disposable WPF target window."""
    import ctypes
    user32 = ctypes.windll.user32
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        hwnd = user32.FindWindowW(None, TARGET_TITLE)
        if hwnd:
            return hwnd
        time.sleep(0.3)
    return None


def focus_window(hwnd, timeout=5.0):
    """Force the window to the foreground."""
    import ctypes
    user32 = ctypes.windll.user32
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        # Tap Alt first: Windows' foreground lock lets the last
        # input-sending process claim SetForegroundWindow. The lone Alt
        # tap arms the target's menu-bar keyboard mode, so tap Escape
        # right after to disarm it (it would swallow the next Ctrl+V).
        keyboard_event = user32.keybd_event
        keyboard_event(0x12, 0, 0, 0)      # VK_MENU down
        keyboard_event(0x12, 0, 2, 0)      # VK_MENU up
        user32.ShowWindow(hwnd, 9)         # SW_RESTORE
        user32.SetForegroundWindow(hwnd)
        time.sleep(0.2)
        keyboard_event(0x1B, 0, 0, 0)      # VK_ESCAPE down
        keyboard_event(0x1B, 0, 2, 0)      # VK_ESCAPE up
        time.sleep(0.2)
        if user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.3)
    return False


def phase(app, expected, label, initial_text=None, dictations=2):
    _i[0] = 0
    target = subprocess.Popen(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden", "-STA",
         "-Command", WPF_SCRIPT]
    )
    job = localproc.attach_job(target)
    hwnd = None
    try:
        hwnd = wait_target()
        assert hwnd, f"{label}: target window did not appear"
        assert focus_window(hwnd), f"{label}: could not focus target"
        time.sleep(0.6)  # let the target's input queue settle
        if initial_text:
            inject(f"keyboard.write({initial_text!r}); time.sleep(0.2); "
                   "keyboard.send('home'); keyboard.send('ctrl+right'); "
                   "keyboard.send('ctrl+right')")
            time.sleep(0.4)
            prepared = main_mod.caretctx.text_around_caret(120, 120)
            assert prepared == ("I like ", "apples."), \
                f"{label}: caret setup failed, got {prepared!r}"
        for _ in range(dictations):
            inject("keyboard.press('f13'); time.sleep(0.6); "
                   "keyboard.release('f13')")
            time.sleep(2.0)  # transcribe + paste + clipboard restore
        got = read_back()
        print(f"  [e2e] {label} observed: {got!r}")
        if got != expected:
            failures.append(f"{label}: got {got!r}, want {expected!r}")
        else:
            print(f"  [e2e] {label} OK: {got!r}")
    except Exception as exc:
        failures.append(f"{label}: {type(exc).__name__}: {exc}")
    finally:
        if hwnd:
            import ctypes
            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        try:
            target.wait(timeout=2)
        except subprocess.TimeoutExpired:
            target.kill()
            target.wait(timeout=2)
        localproc.close_job(job)
        time.sleep(0.5)


def scenario(app):
    try:
        phase(app, EXPECTED_A, "phase A (caret context)")
        phase(app, EXPECTED_B, "phase B (middle insertion)",
              initial_text="I like apples.", dictations=1)
        # Phase C: no caret reading — insertion memory only.
        main_mod.caretctx.text_around_caret = lambda *a, **k: None
        app._last_paste = None
        phase(app, EXPECTED_C, "phase C (insertion memory)")
    finally:
        app._post(app._quit)


def run():
    if os.environ.get("UNDERTONE_DESKTOP_E2E") != "1":
        print("SKIPPED: set UNDERTONE_DESKTOP_E2E=1 only on an idle desktop")
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
