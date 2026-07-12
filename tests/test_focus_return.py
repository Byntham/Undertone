"""Focus-return test: a paste must land in the window it was dictated into.

Starts a dictation into Notepad A, then — while the (slowed) fake STT is
in flight — launches Notepad B, which takes foreground. The pipeline must
detect the focus change, restore Notepad A, and paste there.

NEEDS AN IDLE DESKTOP (see test_e2e.py).
"""

import ctypes
import subprocess
import sys
import threading
import time

sys.path.insert(0, r"C:\Users\graham\Projects\Undertone")

import pyperclip

import main as main_mod

PY = r"C:\Users\graham\Projects\Undertone\.venv\Scripts\python.exe"
EXPECTED = "landed in the right window"

failures = []


def fake_transcribe(wav, api_key, *args, **kwargs):
    time.sleep(1.5)  # window for the focus thief
    return EXPECTED


TEST_CFG = {
    **main_mod.config_mod.DEFAULT_CONFIG,
    "api_key": "test-key",
    "hotkey": "f13",
    "sound_cues": False,
    "ai_cleanup": False,
    "smart_formatting": False,
}


def inject(code):
    subprocess.run([PY, "-c", f"import keyboard, time\n{code}"], check=True)


def read_back():
    pyperclip.copy("<<SENTINEL>>")
    inject("keyboard.send('ctrl+a'); time.sleep(0.2); keyboard.send('ctrl+c')")
    time.sleep(0.5)
    return pyperclip.paste()


def scenario(app):
    notepad_a = subprocess.Popen(["notepad.exe"])
    notepad_b = None
    try:
        time.sleep(1.5)
        hwnd_a = ctypes.windll.user32.GetForegroundWindow()

        inject("keyboard.press('f13'); time.sleep(0.6); "
               "keyboard.release('f13')")
        # STT is sleeping 1.5s; steal focus with a second Notepad.
        notepad_b = subprocess.Popen(["notepad.exe"])
        time.sleep(3.0)  # transcribe + refocus + paste + restore

        # Whose window has the text? Focus A explicitly and read it.
        import caretctx
        assert caretctx.focus_window(hwnd_a), "could not refocus Notepad A"
        time.sleep(0.3)
        got = read_back()
        if got != EXPECTED:
            failures.append(f"Notepad A content: {got!r}, want {EXPECTED!r}")
        else:
            print(f"  [focus] paste followed the dictation target: {got!r}")
    except Exception as exc:
        failures.append(f"{type(exc).__name__}: {exc}")
    finally:
        notepad_a.kill()
        if notepad_b:
            notepad_b.kill()
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
