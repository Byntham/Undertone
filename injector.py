"""Text injection for Undertone.

Pastes transcribed text into the focused application via the clipboard and a
Ctrl+V keystroke, optionally restoring the previous clipboard afterward.
"""

import sys
import threading
import time

import keyboard
import pyperclip


def _restore_later(previous: str, delay: float = 0.5) -> None:
    time.sleep(delay)
    try:
        pyperclip.copy(previous)
    except Exception as exc:
        print(f"[injector] clipboard restore failed: {exc}", file=sys.stderr)


def paste_text(text: str, restore_clipboard: bool = True) -> None:
    """Paste text into the focused app via clipboard + Ctrl+V.

    If restore_clipboard is set and there was previous clipboard content, it is
    restored shortly after on a daemon thread so the caller is not blocked.
    """
    if not text:
        return

    previous = None
    try:
        previous = pyperclip.paste()
    except Exception:
        previous = None

    pyperclip.copy(text)
    # Let the target app's focus settle and the clipboard propagate.
    time.sleep(0.15)
    keyboard.send("ctrl+v")

    if restore_clipboard and previous:
        threading.Thread(
            target=_restore_later, args=(previous,), daemon=True
        ).start()
