"""Undertone — hold a key, speak, release, and the transcript is pasted.

Entry point: wires together the recorder, global hotkey, xAI transcriber,
status overlay, and system tray. Run with:  python main.py
"""

import ctypes
import logging
import queue
import sys
import threading
import time
import tkinter as tk
from collections import deque

import keyboard

import autostart
import caretctx
import cleanup as cleanup_mod
import config as config_mod
import sounds
import textproc
from hotkey import PushToTalk
from injector import paste_text
from learning import CorrectionLearner
from overlay import Overlay
from recorder import Recorder, RecorderError
from transcriber import TranscriptionError, transcribe
from ui import FixWindow, SettingsWindow, create_tray

# Recordings shorter than this many bytes of PCM (~0.3 s at 16 kHz mono
# int16) are treated as an accidental tap and skipped.
MIN_AUDIO_BYTES = 16000 * 2 * 0.3

# A release this soon after its press may be the first half of a double-tap
# (hands-free lock); recording continues until the window below expires.
SHORT_TAP_S = 0.30
DOUBLE_TAP_S = 0.40

HISTORY_SIZE = 20

LOG_PATH = config_mod.CONFIG_PATH.parent / "app.log"


def _foreground_hwnd() -> int:
    return ctypes.windll.user32.GetForegroundWindow()


def _setup_logging():
    config_mod.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=str(LOG_PATH),
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )


def _ensure_single_instance():
    """Exit with a message box if another instance is already running.

    Returns the mutex handle, which must stay referenced for the app's
    lifetime.
    """
    handle = ctypes.windll.kernel32.CreateMutexW(
        None, False, "Undertone_SingleInstance"
    )
    if ctypes.windll.kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        ctypes.windll.user32.MessageBoxW(
            None,
            "Undertone is already running — look for its icon in the "
            "system tray.",
            "Undertone",
            0x40,  # MB_ICONINFORMATION
        )
        sys.exit(0)
    return handle


class App:
    def __init__(self):
        self.cfg = config_mod.load_config()

        self.root = tk.Tk()
        self.root.withdraw()
        # Under pythonw there is no console: route Tk callback errors to the
        # log file instead of losing them.
        self.root.report_callback_exception = lambda et, e, tb: logging.error(
            "Tk callback error", exc_info=(et, e, tb)
        )

        # Commands from non-Tk threads (pystray, keyboard hook) are queued
        # and executed on the Tk main loop.
        self._commands: queue.Queue = queue.Queue()
        self.root.after(50, self._drain_commands)

        self.recorder = Recorder(sample_rate=self.cfg.get("sample_rate", 16000))
        self.overlay = Overlay(self.root,
                               level_getter=lambda: self.recorder.level)
        self.ptt = PushToTalk(self.cfg["hotkey"], self._on_press, self._on_release)
        self.settings = SettingsWindow(
            self.root,
            self.cfg,
            self._on_save_settings,
            on_capture_start=self._pause_hotkey,
            on_capture_end=self._resume_hotkey,
            history_getter=lambda: list(reversed(self._history)),
            on_repaste=self._paste_from_history,
        )
        self.fixwin = FixWindow(self.root, self._on_fixed)
        self.tray = create_tray(
            on_settings=lambda: self._post(self.settings.open),
            on_quit=lambda: self._post(self._quit),
        )

        # Dictation history (session-only, in memory) and insertion memory
        # for smart formatting when the caret can't be read (terminals).
        self._history: deque = deque(maxlen=HISTORY_SIZE)
        self._last_paste = None          # (foreground hwnd, text, monotonic time)
        self._typed_since_paste = False
        self._learner = CorrectionLearner(
            config_mod.CONFIG_PATH.parent / "learning.json")

        # Hands-free toggle state (double-tap the hotkey, or dedicated key).
        self._locked = False
        self._press_time = 0.0
        self._tap_timer = None
        self._ignore_release = False

        caretctx.warm()
        # Any typing other than the hotkey invalidates insertion memory
        # (the caret has likely moved or text was edited).
        keyboard.hook(self._on_key_activity)

    # ---- thread marshaling -------------------------------------------------

    def _post(self, fn):
        self._commands.put(fn)

    def _drain_commands(self):
        try:
            while True:
                self._commands.get_nowait()()
        except queue.Empty:
            pass
        self.root.after(50, self._drain_commands)

    # ---- push-to-talk (called on the keyboard hook thread) -----------------

    def _on_press(self):
        now = time.monotonic()
        if self._locked:
            # A press while locked ends the hands-free dictation.
            self._locked = False
            self._ignore_release = True
            self._finish_recording()
            return
        double_tap = (now - self._press_time) < DOUBLE_TAP_S
        self._press_time = now
        self._cancel_tap_timer()
        if double_tap and self.recorder.is_recording:
            # Second tap: lock recording on, hands-free.
            self._locked = True
            return
        try:
            self.recorder.start()
            if self.cfg.get("sound_cues", True):
                sounds.play_start()
            self.overlay.show_recording()
        except RecorderError as e:
            self.overlay.show_message(str(e), duration_ms=4000, error=True)

    def _on_release(self):
        if self._ignore_release:
            self._ignore_release = False
            return
        if self._locked or not self.recorder.is_recording:
            return
        if time.monotonic() - self._press_time < SHORT_TAP_S:
            # Possible first half of a double-tap: keep recording until the
            # double-tap window closes, then discard as a stray tap.
            self._tap_timer = threading.Timer(DOUBLE_TAP_S, self._tap_expired)
            self._tap_timer.daemon = True
            self._tap_timer.start()
            return
        self._finish_recording()

    def _tap_expired(self):
        if self._locked or not self.recorder.is_recording:
            return
        if time.monotonic() - self._press_time < DOUBLE_TAP_S:
            return  # a second press arrived; not a stray tap
        self.recorder.stop()
        self.overlay.hide()

    def _cancel_tap_timer(self):
        if self._tap_timer is not None:
            self._tap_timer.cancel()
            self._tap_timer = None

    def _finish_recording(self):
        self._cancel_tap_timer()
        if self.cfg.get("sound_cues", True):
            sounds.play_stop()
        wav = self.recorder.stop()
        if len(wav) < MIN_AUDIO_BYTES:
            self.overlay.hide()
            return
        self.overlay.show_transcribing()
        threading.Thread(
            target=self._transcribe_and_paste, args=(wav,), daemon=True
        ).start()

    def _on_toggle_key(self):
        """Dedicated start/stop key (config "toggle_hotkey")."""
        if self.recorder.is_recording:
            self._locked = False
            self._finish_recording()
        else:
            self._locked = True
            try:
                self.recorder.start()
                if self.cfg.get("sound_cues", True):
                    sounds.play_start()
                self.overlay.show_recording()
            except RecorderError as e:
                self._locked = False
                self.overlay.show_message(str(e), duration_ms=4000, error=True)

    def _on_key_activity(self, event):
        if (event.event_type == "down" and event.scan_code
                and not self.ptt.matches(event.scan_code)):
            self._typed_since_paste = True

    # ---- transcription pipeline (worker thread) -----------------------------

    def _transcribe_and_paste(self, wav: bytes):
        vocabulary = list(self.cfg.get("vocabulary", []))
        vocabulary += [v for v in self.cfg.get("corrections", {}).values()
                       if v not in vocabulary]
        try:
            text = transcribe(
                wav, self.cfg.get("api_key", ""),
                self.cfg.get("language", "en"), vocabulary,
            )
        except TranscriptionError as e:
            logging.error("Transcription failed: %s", e)
            self.overlay.show_message(str(e), duration_ms=5000, error=True)
            return
        except Exception as e:  # pragma: no cover - safety net
            logging.exception("Unexpected transcription error")
            self.overlay.show_message(f"Unexpected error: {e}", 5000, error=True)
            return

        if not text:
            self.overlay.show_message("No speech detected", error=True)
            return

        final = self._prepare_text(text)
        paste_text(final, self.cfg.get("restore_clipboard", True))
        self._register_paste(final)
        self.overlay.hide()

    def _prepare_text(self, text: str) -> str:
        """Apply corrections, the optional AI cleanup pass, and
        context-aware spacing/capitalization."""
        smart = self.cfg.get("smart_formatting", True)
        corrections = self.cfg.get("corrections", {})
        ctx = self._acquire_context() if smart else None
        exe = caretctx.get_foreground_exe()

        final = None
        if self.cfg.get("ai_cleanup", True):
            app = exe or ""
            title = caretctx.get_window_title()
            if title:
                app = f"{app} ({title})" if app else title
            cleaned = cleanup_mod.cleanup(
                textproc.apply_corrections(text, corrections),
                ctx, app, corrections,
                self.cfg.get("api_key", ""),
                self.cfg.get("cleanup_model", ""),
            )
            if cleaned is not None:
                # The model handled the transcript body; rules handle the seam.
                final = textproc.seam(cleaned, ctx) if smart else cleaned
        if final is None:
            final = textproc.format_transcript(text, ctx, corrections,
                                               smart=smart)
        if smart and exe in textproc.CHAT_APPS:
            final = textproc.strip_chat_period(final)
        return final

    def _acquire_context(self) -> "str | None":
        """Text before the caret: UIA/Win32 read, else insertion memory."""
        ctx = caretctx.text_before_caret(300)
        if ctx is None:
            # Fall back to what we last pasted, but only while the same
            # window is focused and nothing was typed since.
            lp = self._last_paste
            if (lp and not self._typed_since_paste
                    and lp[0] == _foreground_hwnd()
                    and time.monotonic() - lp[2] < 300):
                ctx = textproc.tail_context(lp[1], 300)
        return ctx

    def _register_paste(self, text: str):
        self._history.append((time.time(), text))
        self._last_paste = (_foreground_hwnd(), text, time.monotonic())
        self._typed_since_paste = False

    # ---- history / re-paste / fix-last ---------------------------------------

    def _paste_from_history(self, text: str):
        """Paste a history entry (settings History pane; focus already
        returned to the target app by the caller)."""
        threading.Thread(target=self._paste_now, args=(text,),
                         daemon=True).start()

    def _paste_now(self, text: str):
        paste_text(text, self.cfg.get("restore_clipboard", True))
        self._register_paste(text)

    def _repaste_last(self):
        """Global re-paste hotkey: wait for its modifiers to lift, then paste."""
        if not self._history:
            self.overlay.show_message("Nothing to re-paste yet")
            return
        text = self._history[-1][1]

        def run():
            deadline = time.monotonic() + 1.0
            while time.monotonic() < deadline and any(
                    keyboard.is_pressed(k) for k in ("ctrl", "alt", "shift")):
                time.sleep(0.02)
            self._paste_now(text)
        threading.Thread(target=run, daemon=True).start()

    def _open_fix(self):
        if not self._history:
            self.overlay.show_message("Nothing to fix yet")
            return
        self.fixwin.open(self._history[-1][1])

    def _on_fixed(self, original: str, corrected: str):
        """FixWindow submitted (Tk thread, target app refocused)."""
        for wrong, right in self._learner.observe(original, corrected):
            merged = dict(self.cfg.get("corrections", {}))
            merged[wrong] = right
            self.cfg = {**self.cfg, "corrections": merged}
            config_mod.save_config(self.cfg)
            # Keep the settings window's private copy in sync.
            self.settings._config = dict(self.cfg)
            self.overlay.show_message(f'Learned: "{wrong}" → "{right}"')
        if self._history:
            self._history[-1] = (self._history[-1][0], corrected)
        threading.Thread(target=self._paste_now, args=(corrected,),
                         daemon=True).start()

    # ---- settings / lifecycle ----------------------------------------------

    def _pause_hotkey(self):
        """Suspend push-to-talk while the settings window captures a shortcut."""
        try:
            self.ptt.stop()
        except Exception:
            pass

    def _resume_hotkey(self):
        try:
            self.ptt.start()
        except ValueError as e:
            self.overlay.show_message(str(e), duration_ms=5000, error=True)

    def _on_save_settings(self, new_cfg: dict):
        old_hotkey = self.cfg.get("hotkey")
        self.cfg = new_cfg
        config_mod.save_config(new_cfg)
        logging.info(
            "Settings saved (api_key length %d, hotkey %r)",
            len(new_cfg.get("api_key", "")),
            new_cfg.get("hotkey"),
        )
        if new_cfg.get("hotkey") != old_hotkey:
            try:
                self.ptt.rebind(new_cfg["hotkey"])
                self.overlay.show_message(f"Hotkey set to: {new_cfg['hotkey']}")
            except ValueError as e:
                self.overlay.show_message(str(e), duration_ms=5000, error=True)

    def _quit(self):
        try:
            self.ptt.stop()
        except Exception:
            pass
        try:
            self.tray.stop()
        except Exception:
            pass
        self.root.destroy()

    def _register_extra_hotkeys(self):
        """Re-paste, fix-last, and optional dedicated toggle hotkeys."""
        for combo, callback in (
            (self.cfg.get("repaste_hotkey", ""), self._repaste_last),
            (self.cfg.get("fix_hotkey", ""), self._open_fix),
            (self.cfg.get("toggle_hotkey", ""), self._on_toggle_key),
        ):
            if not combo:
                continue
            try:
                keyboard.add_hotkey(combo, callback)
            except Exception:
                logging.exception("Could not register hotkey %r", combo)

    def run(self):
        logging.info(
            "App started (hotkey %r, api_key length %d)",
            self.cfg.get("hotkey"),
            len(self.cfg.get("api_key", "")),
        )
        self.ptt.start()
        self._register_extra_hotkeys()
        self.tray.run_detached()
        if not self.cfg.get("api_key"):
            self.settings.open()
            self.overlay.show_message(
                "Enter your xAI API key to get started", duration_ms=4000
            )
        else:
            self.overlay.show_message(
                f"Ready — hold '{self.cfg['hotkey']}' to dictate", duration_ms=2500
            )
        self.root.mainloop()


if __name__ == "__main__":
    _mutex = _ensure_single_instance()
    _setup_logging()
    autostart.migrate_legacy()
    try:
        App().run()
    except Exception:
        logging.exception("Fatal error")
        raise
