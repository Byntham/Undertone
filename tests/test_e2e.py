"""End-to-end pipeline test: hotkey → record → (faked) STT → smart paste.

Runs the real App wiring (keyboard hook, recorder, overlay, caret context,
formatting) against a live Notepad window, with transcribe() replaced by
canned responses so no API key or network is needed. AI cleanup is disabled
so results are deterministic; the cleanup module has its own live test.

Key injection happens from a helper subprocess: the keyboard library hides
its own injected events from hooks in the same process (is_replaying), so
in-process keyboard.press() would never reach the app's hook.

NEEDS AN IDLE DESKTOP: pastes land in the foreground window, so touching
the mouse/keyboard while this runs steals focus and fails the run (the
clipboard sentinel catches it honestly rather than false-passing).

Two phases:
- A: real caret context (Notepad's Edit control via the Win32
  EM_GETSEL/WM_GETTEXT tier) — empty field means sentence start, so the
  first dictation is capitalized.
- B: caret reading stubbed to None, forcing the insertion-memory fallback
  (the terminal-like path) — unknown first context leaves the transcript
  untouched; the second dictation is spaced/lowercased from memory alone.
"""

import subprocess
import sys
import threading
import time

sys.path.insert(0, r"C:\Users\graham\Projects\Undertone")

import pyperclip

import main as main_mod

PY = r"C:\Users\graham\Projects\Undertone\.venv\Scripts\python.exe"

CANNED = [
    "hello world this is a test",
    "The second part continues",
]
EXPECTED_A = "Hello world this is a test the second part continues"
EXPECTED_B = "hello world this is a test the second part continues"

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


def _notepad_hwnds():
    """All visible top-level Notepad windows. Win11 Notepad is single-
    instance: a spawned notepad.exe hands its window to an already-running
    process, so windows must be tracked by class, never by spawned pid."""
    import ctypes
    import ctypes.wintypes as wt
    user32 = ctypes.windll.user32
    found = []

    @ctypes.WINFUNCTYPE(ctypes.c_int, wt.HWND, wt.LPARAM)
    def enum(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(32)
            user32.GetClassNameW(hwnd, buf, 32)
            if buf.value == "Notepad":
                found.append(hwnd)
        return True

    user32.EnumWindows(enum, 0)
    return set(found)


def wait_new_notepad(before, timeout=6.0):
    """The one Notepad window that appeared since the `before` snapshot."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        new = _notepad_hwnds() - before
        if new:
            return new.pop()
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


def phase(app, expected, label):
    before = _notepad_hwnds()
    notepad = subprocess.Popen(["notepad.exe"])
    hwnd = None
    try:
        hwnd = wait_new_notepad(before)
        assert hwnd, f"{label}: no new Notepad window appeared"
        assert focus_window(hwnd), f"{label}: could not focus Notepad"
        time.sleep(0.6)  # let Notepad's input queue settle (first-paste flake)
        for _ in range(2):
            inject("keyboard.press('f13'); time.sleep(0.6); "
                   "keyboard.release('f13')")
            time.sleep(2.0)  # transcribe + paste + clipboard restore
        got = read_back()
        if got != expected:
            failures.append(f"{label}: got {got!r}, want {expected!r}")
        else:
            print(f"  [e2e] {label} OK: {got!r}")
    except Exception as exc:
        failures.append(f"{label}: {type(exc).__name__}: {exc}")
    finally:
        if hwnd:
            # kill() can't reach the single-instance owner; close the window.
            import ctypes
            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        notepad.kill()
        time.sleep(0.5)


def scenario(app):
    try:
        phase(app, EXPECTED_A, "phase A (caret context)")
        # Phase B: no caret reading — insertion memory only.
        main_mod.caretctx.text_before_caret = lambda *a, **k: None
        phase(app, EXPECTED_B, "phase B (insertion memory)")
    finally:
        app._post(app.root.destroy)


def run():
    main_mod.transcribe = fake_transcribe
    main_mod.config_mod.load_config = lambda: dict(TEST_CFG)

    app = main_mod.App()
    app.ptt.start()
    threading.Thread(target=scenario, args=(app,), daemon=True).start()
    app.root.mainloop()

    if failures:
        print("FAILED:", *failures, sep="\n  ")
        sys.exit(1)
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    run()
