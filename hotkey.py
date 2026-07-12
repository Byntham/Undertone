"""Push-to-talk hotkey handling for Undertone.

Wraps the `keyboard` library to support a single key ("right ctrl", "f9") or a
combination ("ctrl+shift+space", "alt+z"). on_press fires once when every key in
the combo is held simultaneously; on_release fires once when any key is let go.
Auto-repeat "down" events are naturally filtered.

TapStateMachine turns raw press/release events into recording gestures
(hold-to-talk, double-tap hands-free lock, stray-tap discard) under one lock
with one timing convention, so hook-thread and timer-thread events can never
interleave into an inconsistent state.
"""

import sys
import threading
import time
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

    def matches(self, scan_code: int) -> bool:
        """True if scan_code belongs to any key of the bound combo."""
        return any(scan_code in part for part in self._parts)

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


class TapStateMachine:
    """Recording gestures from hotkey events: hold, double-tap lock, stray tap.

    States: IDLE (not recording), HELD (key down, recording), TAP_WAIT
    (released after a short tap; recording continues while a timer waits for
    the second tap), LOCKED (hands-free; recording until the next press).

    The double-tap gap is measured from the RELEASE of the first tap — that
    matches how people perceive a double-tap; anchoring it to the first press
    made slow-ish taps silently discard recordings.

    Callbacks: on_start() -> bool (False = recording could not start; stay
    IDLE), on_finish() (stop + transcribe), on_discard() (stop + drop). They
    are invoked under the machine's lock and must not call back in.
    """

    IDLE, HELD, TAP_WAIT, LOCKED = "idle", "held", "tap_wait", "locked"

    def __init__(self, on_start: Callable[[], bool],
                 on_finish: Callable[[], None],
                 on_discard: Callable[[], None],
                 short_tap_s: float = 0.30, double_tap_s: float = 0.40):
        self._on_start = on_start
        self._on_finish = on_finish
        self._on_discard = on_discard
        self._short_tap_s = short_tap_s
        self._double_tap_s = double_tap_s
        self._lock = threading.RLock()
        self._state = self.IDLE
        self._press_time = 0.0
        self._timer = None

    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def press(self):
        with self._lock:
            if self._state == self.IDLE:
                self._press_time = time.monotonic()
                self._state = self.HELD if self._on_start() else self.IDLE
            elif self._state == self.TAP_WAIT:
                # Second tap within the window (the timer would have moved
                # us to IDLE otherwise): lock hands-free.
                self._cancel_timer()
                self._state = self.LOCKED
            elif self._state == self.LOCKED:
                self._state = self.IDLE
                self._on_finish()
            # HELD + press cannot happen (hook filters auto-repeat).

    def release(self):
        with self._lock:
            if self._state != self.HELD:
                return  # releases in IDLE/TAP_WAIT/LOCKED carry no meaning
            if time.monotonic() - self._press_time < self._short_tap_s:
                # Maybe the first half of a double-tap: keep recording,
                # measure the gap from THIS release.
                self._state = self.TAP_WAIT
                self._timer = threading.Timer(self._double_tap_s,
                                              self._tap_expired)
                self._timer.daemon = True
                self._timer.start()
            else:
                self._state = self.IDLE
                self._on_finish()

    def toggle(self):
        """Dedicated start/stop key: one press starts locked, next stops."""
        with self._lock:
            if self._state == self.IDLE:
                self._press_time = time.monotonic()
                self._state = self.LOCKED if self._on_start() else self.IDLE
            else:
                self._cancel_timer()
                self._state = self.IDLE
                self._on_finish()

    def _tap_expired(self):
        with self._lock:
            if self._state != self.TAP_WAIT:
                return  # a second tap won the race; Timer.cancel missed it
            self._state = self.IDLE
            self._on_discard()

    def _cancel_timer(self):
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None
