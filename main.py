"""Undertone — hold a key, speak, release, and the transcript is pasted.

Entry point: wires together the recorder, global hotkey, xAI transcriber,
status overlay, and system tray. Run with:  python main.py
"""

import ctypes
import logging
import queue
import sys
import threading
import tkinter as tk

import autostart
import config as config_mod
from hotkey import PushToTalk
from injector import paste_text
from overlay import Overlay
from recorder import Recorder, RecorderError
from transcriber import TranscriptionError, transcribe
from ui import SettingsWindow, create_tray

# Recordings shorter than this many bytes of PCM (~0.3 s at 16 kHz mono
# int16) are treated as an accidental tap and skipped.
MIN_AUDIO_BYTES = 16000 * 2 * 0.3

LOG_PATH = config_mod.CONFIG_PATH.parent / "app.log"


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
        )
        self.tray = create_tray(
            on_settings=lambda: self._post(self.settings.open),
            on_quit=lambda: self._post(self._quit),
        )

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
        try:
            self.recorder.start()
            self.overlay.show_recording()
        except RecorderError as e:
            self.overlay.show_message(str(e), duration_ms=4000, error=True)

    def _on_release(self):
        if not self.recorder.is_recording:
            return
        wav = self.recorder.stop()
        if len(wav) < MIN_AUDIO_BYTES:
            self.overlay.hide()
            return
        self.overlay.show_transcribing()
        threading.Thread(
            target=self._transcribe_and_paste, args=(wav,), daemon=True
        ).start()

    def _transcribe_and_paste(self, wav: bytes):
        try:
            text = transcribe(
                wav, self.cfg.get("api_key", ""), self.cfg.get("language", "en")
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

        paste_text(text, self.cfg.get("restore_clipboard", True))
        self.overlay.hide()

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

    def run(self):
        logging.info(
            "App started (hotkey %r, api_key length %d)",
            self.cfg.get("hotkey"),
            len(self.cfg.get("api_key", "")),
        )
        self.ptt.start()
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
