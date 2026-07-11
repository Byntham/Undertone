"""End-to-end pipeline test: hotkey → record → (faked) STT → smart paste.

Runs the real App wiring (keyboard hook, recorder, overlay, caret context,
formatting) against a live Notepad window, with transcribe() replaced by
canned responses so no API key or network is needed.

Key injection happens from a helper subprocess: the keyboard library hides
its own injected events from hooks in the same process (is_replaying), so
in-process keyboard.press() would never reach the app's hook.

Notepad's Edit control exposes no UIA TextPattern on this machine, so this
exercises the insertion-memory fallback (the terminal-like path): the first
dictation has no context at all (left untouched), the second is spaced and
lowercased purely from what Undertone itself pasted before it.
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
    "hello world this is a test",   # unknown ctx → pasted as-is
    "The second part continues",    # memory ctx → " the second part continues"
]
EXPECTED = "hello world this is a test the second part continues"

_i = [0]
failures = []


def fake_transcribe(wav, api_key, language="en", vocabulary=None):
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
}


def inject(code):
    subprocess.run([PY, "-c", f"import keyboard, time\n{code}"], check=True)


def scenario(app):
    notepad = subprocess.Popen(["notepad.exe"])
    try:
        time.sleep(1.5)
        for step in range(2):
            inject("keyboard.press('f13'); time.sleep(0.6); "
                   "keyboard.release('f13')")
            time.sleep(2.0)  # transcribe + paste + clipboard restore
        inject("keyboard.send('ctrl+a'); time.sleep(0.2); "
               "keyboard.send('ctrl+c')")
        time.sleep(0.5)
        got = pyperclip.paste()
        if got != EXPECTED:
            failures.append(f"got: {got!r}, want: {EXPECTED!r}")
    except Exception as exc:
        failures.append(f"{type(exc).__name__}: {exc}")
    finally:
        notepad.kill()
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
