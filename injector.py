"""Text injection for Undertone.

Pastes transcribed text into the focused application via the clipboard and a
Ctrl+V keystroke, optionally restoring the previous clipboard afterward.

A lock serializes clipboard use against the delayed restore threads, and a
generation counter makes each restore conditional: if a newer paste has
taken the clipboard since, the stale restore is skipped rather than
clobbering it mid-paste.
"""

import sys
import threading
import time

import keyboard
import pyperclip

_lock = threading.Lock()
_generation = 0


def _restore_later(previous: str, generation: int, delay: float = 0.5) -> None:
    time.sleep(delay)
    with _lock:
        if generation != _generation:
            return  # a newer paste owns the clipboard now
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

    global _generation
    with _lock:
        _generation += 1
        generation = _generation
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
            target=_restore_later, args=(previous, generation), daemon=True
        ).start()
