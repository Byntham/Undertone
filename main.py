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
import pyperclip

import theme
theme.init_dpi()  # before overlay/ui compute pixel metrics or Tk starts

import autostart
import caretctx
import cleanup as cleanup_mod
import config as config_mod
import sounds
import textproc
from hotkey import PushToTalk, TapStateMachine
from injector import paste_text
from overlay import Overlay
from recorder import Recorder, RecorderError
from transcriber import TranscriptionError, transcribe
from ui import (SettingsWindow, create_tray, load_app_image,
                make_recording_tray_image, pretty_combo)

# Recordings shorter than this many bytes of PCM (~0.3 s at 16 kHz mono
# int16) are treated as an accidental tap and skipped.
MIN_AUDIO_BYTES = 16000 * 2 * 0.3

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

        # Scan codes of Undertone's own extra hotkeys — they must not count
        # as "typing" for insertion-memory invalidation. Filled at
        # registration time.
        self._extra_hotkey_scancodes: set = set()
        self._extra_hotkey_handles: list = []

        self.recorder = Recorder(
            sample_rate=self.cfg.get("sample_rate", 16000),
            device=self.cfg.get("input_device") or None)
        self.overlay = Overlay(self.root,
                               level_getter=lambda: self.recorder.level)
        self.ptt = PushToTalk(self.cfg["hotkey"], self._on_press,
                              self._on_release,
                              on_other_key=self._on_other_key)
        self.settings = SettingsWindow(
            self.root,
            self.cfg,
            self._on_save_settings,
            on_capture_start=self._pause_hotkey,
            on_capture_end=self._resume_hotkey,
            history_getter=self._history_snapshot,
            on_repaste=self._paste_from_history,
            on_retry=self._retry_failed,
            config_getter=lambda: self.cfg,
        )
        # Tray pause state and icons (normal / red-tinted while recording).
        # Built once; the recording swap happens on the hook thread.
        self._paused = False
        self._tray_img = load_app_image()
        self._tray_img_recording = make_recording_tray_image()
        self.tray = create_tray(
            on_settings=lambda: self._post(self.settings.open),
            on_quit=lambda: self._post(self._quit),
            on_toggle_pause=lambda: self._post(self._toggle_pause),
            is_paused=lambda: self._paused,
        )

        # Dictation history (session-only, in memory) and insertion memory
        # for smart formatting when the caret can't be read (terminals).
        self._history: deque = deque(maxlen=HISTORY_SIZE)
        self._history_lock = threading.Lock()
        self._last_paste = None          # (foreground hwnd, text, monotonic time)
        self._typed_since_paste = False

        # Everything that transcribes or pastes runs on this single worker,
        # strictly in order — the clipboard, insertion memory, and history
        # all assume one writer at a time.
        self._pipeline_q: queue.Queue = queue.Queue()
        threading.Thread(target=self._pipeline_loop, name="pipeline",
                         daemon=True).start()

        # Recording gestures (hold / double-tap lock / stray tap) live in a
        # locked state machine; App only supplies the recording actions.
        self.gestures = TapStateMachine(
            on_start=self._start_recording,
            on_finish=self._finish_recording,
            on_discard=self._discard_recording,
            on_lock=self._on_lock,
        )

        # Esc cancels an in-progress recording; resolve its scan codes once.
        try:
            self._esc_scancodes = frozenset(keyboard.key_to_scan_codes("esc"))
        except Exception:
            self._esc_scancodes = frozenset()

        caretctx.warm()

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

    # ---- recording actions (invoked by the gesture state machine) ------------

    def _on_press(self):
        self.gestures.press()

    def _on_release(self):
        self.gestures.release()

    def _on_toggle_key(self):
        """Dedicated start/stop key (config "toggle_hotkey")."""
        self.gestures.toggle()

    def _start_recording(self) -> bool:
        try:
            self.recorder.start()
        except RecorderError as e:
            self.overlay.show_message(str(e), duration_ms=4000, error=True)
            return False
        if self.cfg.get("sound_cues", True):
            sounds.play_start()
        self.overlay.show_recording()
        self._set_tray_icon(self._tray_img_recording)
        return True

    def _on_lock(self):
        """Hands-free lock engaged (double-tap or dedicated toggle key)."""
        if self.cfg.get("sound_cues", True):
            sounds.play_lock()
        self.overlay.show_recording(locked=True)

    def _finish_recording(self):
        if self.cfg.get("sound_cues", True):
            sounds.play_stop()
        self._set_tray_icon(self._tray_img)
        wav = self.recorder.stop()
        if len(wav) < MIN_AUDIO_BYTES:
            self.overlay.show_message(
                "Too short — hold the key while you speak", 2200, warn=True)
            return
        self.overlay.show_transcribing()
        # The paste belongs to the window being dictated into, captured now —
        # if focus moves (or is stolen) during transcription, it is restored
        # before pasting.
        target = (_foreground_hwnd(), caretctx.get_foreground_exe())
        self._pipeline_q.put(("dictate", (wav, target)))

    def _discard_recording(self):
        self.recorder.stop()
        self.overlay.hide()
        self._set_tray_icon(self._tray_img)

    def _set_tray_icon(self, img):
        """Swap the tray icon; called from the hook thread too, and pystray
        quirks must never crash the app."""
        try:
            self.tray.icon = img
        except Exception:
            pass

    def _on_other_key(self, scan_code: int):
        """Non-hotkey keydown (from the PushToTalk hook): the caret has
        likely moved or text was edited, so insertion memory is stale."""
        if (scan_code in self._esc_scancodes
                and self.gestures.state != TapStateMachine.IDLE
                and self.gestures.cancel()):
            if self.cfg.get("sound_cues", True):
                sounds.play_cancel()
            return  # a cancel is not typing; keep insertion memory
        if scan_code not in self._extra_hotkey_scancodes:
            self._typed_since_paste = True

    # ---- transcription pipeline (single worker thread) -----------------------

    def _pipeline_loop(self):
        while True:
            kind, payload = self._pipeline_q.get()
            try:
                if kind == "dictate":
                    self._transcribe_and_paste(*payload)
                elif kind == "retry":
                    # Re-run a failed dictation's audio; target=None means
                    # the paste goes to whatever is focused now.
                    self.overlay.show_transcribing()
                    self._transcribe_and_paste(payload, target=None)
                else:  # "paste" / "repaste"
                    if kind == "repaste":
                        self._wait_modifiers_lifted()
                    self._paste_now(payload)
            except Exception:
                logging.exception("Pipeline step failed")

    def _wait_modifiers_lifted(self, budget: float = 1.0):
        """Let the user release the hotkey's modifiers before sending Ctrl+V."""
        deadline = time.monotonic() + budget
        while time.monotonic() < deadline and any(
                keyboard.is_pressed(k) for k in ("ctrl", "alt", "shift")):
            time.sleep(0.02)

    def _transcribe_and_paste(self, wav: bytes, target=None):
        vocabulary = list(self.cfg.get("vocabulary", []))
        vocabulary += [v for v in self.cfg.get("corrections", {}).values()
                       if v not in vocabulary]
        provider = self.cfg.get("provider", "xai")
        try:
            text = transcribe(
                wav, config_mod.provider_key(self.cfg, provider),
                self.cfg.get("language", "en"), vocabulary,
                provider, config_mod.model_override(self.cfg, "stt", provider),
            )
        except TranscriptionError as e:
            logging.error("Transcription failed: %s", e)
            self._register_failure(str(e), wav)
            self.overlay.show_message(str(e), duration_ms=5000, error=True)
            return
        except Exception as e:  # pragma: no cover - safety net
            logging.exception("Unexpected transcription error")
            self._register_failure(f"Unexpected error: {e}", wav)
            self.overlay.show_message(f"Unexpected error: {e}", 5000, error=True)
            return

        if not text:
            self.overlay.show_message("No speech detected", error=True)
            return

        refocused = self._return_to_target(target)
        raw = textproc.apply_corrections(text, self.cfg.get("corrections", {}))
        final = self._prepare_text(text)
        if raw == final:
            raw = None   # cleanup/format changed nothing worth showing
        if not refocused:
            # The target window is gone/unreachable: pasting would land the
            # text in the wrong app. Park it on the clipboard instead.
            self._clipboard_fallback(final, raw)
            return
        try:
            paste_text(final, self.cfg.get("restore_clipboard", True))
        except Exception:
            logging.exception("Paste failed")
            self._clipboard_fallback(final, raw)
            return
        self._register_paste(final, raw)
        self._confirm_paste(final, 1600)

    def _confirm_paste(self, final: str, duration_ms: int):
        preview = " ".join(final.split())
        if len(preview) > 48:
            preview = preview[:47].rstrip() + "…"
        self.overlay.show_message(f"Pasted · {preview}", duration_ms)

    def _clipboard_fallback(self, final: str, raw=None):
        """Never lose dictated text: clipboard + history instead of a paste."""
        pyperclip.copy(final)
        self._register_paste(final, raw)
        combo = self.cfg.get("repaste_hotkey", "")
        msg = (f"Couldn't paste — press {pretty_combo(combo)} where you want it"
               if combo else "Couldn't paste — the text is on your clipboard")
        self.overlay.show_message(msg, 5000, warn=True)

    def _return_to_target(self, target) -> bool:
        """If focus left the dictation's window, put it back before the
        caret is read and the paste fires — and log who had taken it.
        Returns True if no refocus was needed or it succeeded, False if the
        refocus failed."""
        if not target:
            return True
        hwnd, exe = target
        if not hwnd or _foreground_hwnd() == hwnd:
            return True
        thief = caretctx.get_foreground_exe()
        title = caretctx.get_window_title()
        restored = caretctx.focus_window(hwnd)
        logging.warning(
            "Focus moved during transcription: %r (%r) took it from %r; "
            "refocus %s", thief, title, exe,
            "succeeded" if restored else "FAILED",
        )
        return bool(restored)

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
            cprov = self.cfg.get("cleanup_provider", "xai")
            cleaned = cleanup_mod.cleanup(
                textproc.apply_corrections(text, corrections),
                ctx, app, corrections,
                config_mod.provider_key(self.cfg, cprov),
                config_mod.model_override(self.cfg, "cleanup", cprov),
                cprov,
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

    def _register_paste(self, text: str, raw=None):
        """Record a successful dictation. raw is the pre-cleanup transcript
        (None when it matches the final text)."""
        with self._history_lock:
            self._history.append(
                {"ts": time.time(), "text": text, "raw": raw, "ok": True})
        self._last_paste = (_foreground_hwnd(), text, time.monotonic())
        self._typed_since_paste = False

    def _register_failure(self, error: str, wav: bytes):
        """Record a failed dictation, keeping its audio for a retry.

        Only the 3 most recent failures keep their wav bytes — older ones
        drop them so the deque can't pin ~20 recordings in memory."""
        with self._history_lock:
            self._history.append(
                {"ts": time.time(), "ok": False, "error": error, "wav": wav})
            kept = 0
            for entry in reversed(self._history):
                if entry.get("ok", True) or "wav" not in entry:
                    continue
                kept += 1
                if kept > 3:
                    del entry["wav"]

    def _history_snapshot(self):
        with self._history_lock:
            return list(reversed(self._history))

    # ---- history / re-paste ---------------------------------------------------

    def _retry_failed(self, wav: bytes):
        """Re-transcribe a failed dictation's audio (settings History pane).

        The failed entry is removed up front so it can't be retried twice;
        success/failure of the retry registers a fresh entry naturally."""
        with self._history_lock:
            for entry in self._history:
                if not entry.get("ok", True) and entry.get("wav") is wav:
                    self._history.remove(entry)
                    break
            else:
                return  # already retried (stale UI click)
        self._pipeline_q.put(("retry", wav))

    def _paste_from_history(self, text: str):
        """Paste a history entry (settings History pane; focus already
        returned to the target app by the caller)."""
        self._pipeline_q.put(("paste", text))

    def _paste_now(self, text: str):
        paste_text(text, self.cfg.get("restore_clipboard", True))
        self._register_paste(text)
        self._confirm_paste(text, 1200)

    def _repaste_last(self):
        """Global re-paste hotkey handler."""
        for entry in self._history_snapshot():
            if entry.get("ok"):
                self._pipeline_q.put(("repaste", entry["text"]))
                return
        self.overlay.show_message("Nothing to re-paste yet")

    # ---- settings / lifecycle ----------------------------------------------

    def _pause_hotkey(self):
        """Suspend all hotkeys while the settings window captures a shortcut
        (pressing the re-paste combo during capture must not paste)."""
        try:
            self.ptt.stop()
        except Exception:
            pass
        self._unregister_extra_hotkeys()

    def _resume_hotkey(self):
        if self._paused:
            return  # the tray pause owns the hotkeys until resumed
        try:
            self.ptt.start()
        except ValueError as e:
            self.overlay.show_message(str(e), duration_ms=5000, error=True)
        self._register_extra_hotkeys()

    def _toggle_pause(self):
        """Tray menu: suspend/resume dictation (all hotkeys)."""
        self._paused = not self._paused
        if self._paused:
            self.gestures.cancel()   # a live recording can't outlive its hooks
            try:
                self.ptt.stop()
            except Exception:
                pass
            self._unregister_extra_hotkeys()
            self.overlay.show_message("Dictation paused", 1500, warn=True)
        else:
            try:
                self.ptt.start()
            except ValueError as e:
                self.overlay.show_message(str(e), duration_ms=5000, error=True)
            else:
                self.overlay.show_message("Dictation resumed", 1200)
            self._register_extra_hotkeys()
        self._update_tray_title()
        try:
            self.tray.update_menu()
        except Exception:
            pass

    def _update_tray_title(self):
        """State-bearing tooltip; pystray quirks must never crash the app."""
        try:
            self.tray.title = (
                "Undertone — paused" if self._paused else
                f"Undertone — hold {pretty_combo(self.cfg.get('hotkey', ''))} "
                "to dictate")
        except Exception:
            pass

    def _on_save_settings(self, new_cfg: dict):
        old_cfg = self.cfg
        self.cfg = new_cfg
        config_mod.save_config(new_cfg)
        logging.info(
            "Settings saved (api_key length %d, hotkey %r)",
            len(new_cfg.get("api_key", "")),
            new_cfg.get("hotkey"),
        )
        if new_cfg.get("hotkey") != old_cfg.get("hotkey"):
            try:
                self.ptt.rebind(new_cfg["hotkey"])
                if self._paused:
                    self.ptt.stop()   # rebind must not resurrect a paused hook
                self.overlay.show_message(
                    f"Hotkey set to {pretty_combo(new_cfg['hotkey'])}")
            except ValueError as e:
                self.overlay.show_message(str(e), duration_ms=5000, error=True)
            self._update_tray_title()
        if new_cfg.get("input_device") != old_cfg.get("input_device"):
            self.recorder.set_device(new_cfg.get("input_device") or None)
        if any(new_cfg.get(k) != old_cfg.get(k)
               for k in ("repaste_hotkey", "toggle_hotkey")):
            self._unregister_extra_hotkeys()
            self._register_extra_hotkeys()
            combo = new_cfg.get("repaste_hotkey", "")
            if combo != old_cfg.get("repaste_hotkey"):
                self.overlay.show_message(
                    f"Re-paste shortcut set to {pretty_combo(combo)}")

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
        """Re-paste and optional dedicated toggle hotkeys."""
        if self._paused or self._extra_hotkey_handles:
            return  # paused, or already registered
        for combo, callback in (
            (self.cfg.get("repaste_hotkey", ""), self._repaste_last),
            (self.cfg.get("toggle_hotkey", ""), self._on_toggle_key),
        ):
            if not combo:
                continue
            try:
                self._extra_hotkey_handles.append(
                    keyboard.add_hotkey(combo, callback))
            except Exception:
                logging.exception("Could not register hotkey %r", combo)
                continue
            # These keys are Undertone's own — they must not count as
            # "typing" for insertion-memory invalidation.
            for part in combo.split("+"):
                try:
                    self._extra_hotkey_scancodes.update(
                        keyboard.key_to_scan_codes(part.strip()))
                except Exception:
                    pass

    def _unregister_extra_hotkeys(self):
        for handle in self._extra_hotkey_handles:
            try:
                keyboard.remove_hotkey(handle)
            except Exception:
                pass
        self._extra_hotkey_handles.clear()
        self._extra_hotkey_scancodes.clear()

    def run(self):
        logging.info(
            "App started (hotkey %r, api_key length %d)",
            self.cfg.get("hotkey"),
            len(self.cfg.get("api_key", "")),
        )
        self.ptt.start()
        self._register_extra_hotkeys()
        self.tray.run_detached()
        self._update_tray_title()
        if not config_mod.provider_key(self.cfg, self.cfg.get("provider", "xai")):
            self.settings.open()
            self.overlay.show_message(
                "Enter an API key for your provider to get started",
                duration_ms=4000,
            )
        else:
            self.overlay.show_message(
                f"Ready — hold {pretty_combo(self.cfg['hotkey'])} to dictate",
                duration_ms=2500,
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
