"""Deterministic formatting-pipeline tests with no desktop interaction."""

import os
import sys
import threading
import time
from collections import deque
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as main_mod


BASE_CFG = {
    **main_mod.config_mod.DEFAULT_CONFIG,
    "ai_cleanup": False,
    "smart_formatting": True,
}


def test_middle_insertion():
    app = SimpleNamespace(_acquire_context=lambda: ("I like ", "apples."))
    old_exe = main_mod.caretctx.get_foreground_exe
    try:
        main_mod.caretctx.get_foreground_exe = lambda: "notepad.exe"
        assert main_mod.App._prepare_text(app, "red.", BASE_CFG) == "red "
    finally:
        main_mod.caretctx.get_foreground_exe = old_exe


def test_empty_context_beats_stale_memory():
    app = object.__new__(main_mod.App)
    app._last_paste = (42, "Previous words", time.monotonic(), 7)
    app._input_generation = 7
    old_context = main_mod.caretctx.text_around_caret
    old_hwnd = main_mod._foreground_hwnd
    old_exe = main_mod.caretctx.get_foreground_exe
    try:
        main_mod.caretctx.text_around_caret = lambda *args, **kwargs: ("", "")
        main_mod._foreground_hwnd = lambda: 42
        main_mod.caretctx.get_foreground_exe = lambda: "editor.exe"
        assert app._acquire_context() == ("", "")
        assert main_mod.App._prepare_text(
            app, "hello world.", BASE_CFG) == "Hello world."
    finally:
        main_mod.caretctx.text_around_caret = old_context
        main_mod._foreground_hwnd = old_hwnd
        main_mod.caretctx.get_foreground_exe = old_exe


def test_cleanup_gets_only_left_context():
    app = SimpleNamespace(
        _acquire_context=lambda: ("I already said ", "today."))
    captured = {}
    old_cleanup = main_mod.cleanup_mod.cleanup
    old_exe = main_mod.caretctx.get_foreground_exe
    old_title = main_mod.caretctx.get_window_title

    def fake_cleanup(transcript, ctx, app_name, corrections, *args, **kwargs):
        captured.update(transcript=transcript, ctx=ctx, app=app_name,
                        corrections=corrections)
        return "hello."

    try:
        main_mod.cleanup_mod.cleanup = fake_cleanup
        main_mod.caretctx.get_foreground_exe = lambda: "slack.exe"
        main_mod.caretctx.get_window_title = lambda: "Chat"
        cfg = {**BASE_CFG, "ai_cleanup": True}
        # Chat-period removal preserves the locally computed trailing seam.
        assert main_mod.App._prepare_text(app, "hello", cfg) == "hello "
        assert captured == {
            "transcript": "hello",
            "ctx": "I already said ",
            "app": "slack.exe (Chat)",
            "corrections": {},
        }
    finally:
        main_mod.cleanup_mod.cleanup = old_cleanup
        main_mod.caretctx.get_foreground_exe = old_exe
        main_mod.caretctx.get_window_title = old_title


def test_cleanup_fallback_and_disabled_smart_formatting():
    app = SimpleNamespace(_acquire_context=lambda: ("", ""))
    old_cleanup = main_mod.cleanup_mod.cleanup
    old_exe = main_mod.caretctx.get_foreground_exe
    old_title = main_mod.caretctx.get_window_title
    try:
        main_mod.cleanup_mod.cleanup = lambda *args, **kwargs: None
        main_mod.caretctx.get_foreground_exe = lambda: "editor.exe"
        main_mod.caretctx.get_window_title = lambda: "Document"
        cfg = {**BASE_CFG, "ai_cleanup": True}
        assert main_mod.App._prepare_text(
            app, "  hello world.  ", cfg) == "Hello world."

        # Smart formatting off must not query the caret. It still applies
        # exact corrections and removes transport whitespace.
        app._acquire_context = lambda: (_ for _ in ()).throw(
            AssertionError("caret context queried while smart formatting off"))
        cfg = {
            **BASE_CFG,
            "smart_formatting": False,
            "corrections": {"under tone": "Undertone"},
        }
        assert main_mod.App._prepare_text(
            app, "  under tone works.  ", cfg) == "Undertone works."
    finally:
        main_mod.cleanup_mod.cleanup = old_cleanup
        main_mod.caretctx.get_foreground_exe = old_exe
        main_mod.caretctx.get_window_title = old_title


def test_insertion_memory_is_left_only():
    app = object.__new__(main_mod.App)
    app._last_paste = (42, "Previous words", time.monotonic(), 7)
    app._input_generation = 7
    old_context = main_mod.caretctx.text_around_caret
    old_hwnd = main_mod._foreground_hwnd
    try:
        main_mod.caretctx.text_around_caret = lambda *args, **kwargs: None
        main_mod._foreground_hwnd = lambda: 42
        assert app._acquire_context() == ("Previous words", None)
        # A key/click after paste invalidates memory. A generation also catches
        # input that arrives during paste, before _register_paste runs.
        app._input_generation += 1
        assert app._acquire_context() == (None, None)
    finally:
        main_mod.caretctx.text_around_caret = old_context
        main_mod._foreground_hwnd = old_hwnd


def test_input_during_paste_cannot_be_reset():
    app = object.__new__(main_mod.App)
    app._history = deque()
    app._history_lock = threading.Lock()
    app._last_paste = None
    # Paste began at generation 7; immediate user input advanced it before
    # the pipeline registered the successful paste.
    app._input_generation = 8
    old_context = main_mod.caretctx.text_around_caret
    old_hwnd = main_mod._foreground_hwnd
    try:
        main_mod.caretctx.text_around_caret = lambda *args, **kwargs: None
        main_mod._foreground_hwnd = lambda: 42
        main_mod.App._register_paste(
            app, "Previous words", input_generation=7)
        assert app._last_paste[3] == 7
        assert app._acquire_context() == (None, None)
    finally:
        main_mod.caretctx.text_around_caret = old_context
        main_mod._foreground_hwnd = old_hwnd


def main():
    test_middle_insertion()
    test_empty_context_beats_stale_memory()
    test_cleanup_gets_only_left_context()
    test_cleanup_fallback_and_disabled_smart_formatting()
    test_insertion_memory_is_left_only()
    test_input_during_paste_cannot_be_reset()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
