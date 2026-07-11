"""Push-to-talk hotkey handling for Undertone.

Wraps the `keyboard` library to support a single key ("right ctrl", "f9") or a
combination ("ctrl+shift+space", "alt+z"). on_press fires once when every key in
the combo is held simultaneously; on_release fires once when any key is let go.
Auto-repeat "down" events are naturally filtered.
"""

import sys
from typing import Callable, List

import keyboard


def validate_hotkey(hotkey: str) -> str:
    """Parse and validate a hotkey string, returning a normalized form.

    Parts are stripped, lowercased and rejoined with "+". Splitting is done only
    on "+", so single key names containing spaces ("right ctrl") are preserved.
    Raises ValueError with a friendly message if empty or any part is unknown.
    """
    parts = [p.strip().lower() for p in hotkey.split("+") if p.strip()]
    if not parts:
        raise ValueError("No hotkey given. Choose a key or key combination.")
    for part in parts:
        try:
            keyboard.key_to_scan_codes(part)
        except Exception as exc:
            raise ValueError(
                f"'{part}' is not a valid key name. Choose a different hotkey."
            ) from exc
    return "+".join(parts)


class PushToTalk:
    def __init__(
        self,
        hotkey: str,
        on_press: Callable[[], None],
        on_release: Callable[[], None],
    ):
        self.hotkey = hotkey
        self.on_press = on_press
        self.on_release = on_release
        self._parts: List[frozenset] = []
        self._down = set()
        self._active = False
        self._hook = None

    def _parse(self) -> None:
        """Resolve each combo part to a frozenset of accepted scan codes."""
        normalized = validate_hotkey(self.hotkey)
        parts = normalized.split("+")
        self._parts = [frozenset(keyboard.key_to_scan_codes(p)) for p in parts]

    def _fire(self, callback: Callable[[], None]) -> None:
        try:
            callback()
        except Exception as exc:
            print(f"[hotkey] callback error: {exc}", file=sys.stderr)

    def _on_event(self, event):
        # Injected events can lack a real scan code; ignore them.
        if not event.scan_code:
            return
        if event.event_type == "down":
            self._down.add(event.scan_code)
        elif event.event_type == "up":
            self._down.discard(event.scan_code)
        else:
            return

        active = all(part & self._down for part in self._parts)
        if active and not self._active:
            self._active = True
            self._fire(self.on_press)
        elif not active and self._active:
            self._active = False
            self._fire(self.on_release)

    def start(self) -> None:
        """Register the global hook. Raises ValueError on an invalid hotkey."""
        self._parse()  # raises ValueError if invalid
        self.stop()  # idempotent: never leave two hooks registered
        self._hook = keyboard.hook(self._on_event)

    def stop(self) -> None:
        """Remove the hook if registered and reset state."""
        if self._hook is not None:
            try:
                keyboard.unhook(self._hook)
            except Exception:
                pass
            self._hook = None
        self._down = set()
        self._active = False

    def rebind(self, new_hotkey: str) -> None:
        """Stop the current hook and register a new one."""
        self.stop()
        self.hotkey = new_hotkey
        self.start()
