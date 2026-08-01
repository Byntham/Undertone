"""Deterministic formatting-pipeline tests with no desktop interaction."""

import os
import sys
import time
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


def test_insertion_memory_is_left_only():
    app = object.__new__(main_mod.App)
    app._last_paste = (42, "Previous words", time.monotonic())
    app._typed_since_paste = False
    old_context = main_mod.caretctx.text_around_caret
    old_hwnd = main_mod._foreground_hwnd
    try:
        main_mod.caretctx.text_around_caret = lambda *args, **kwargs: None
        main_mod._foreground_hwnd = lambda: 42
        assert app._acquire_context() == ("Previous words", None)
        app._typed_since_paste = True
        assert app._acquire_context() == (None, None)
    finally:
        main_mod.caretctx.text_around_caret = old_context
        main_mod._foreground_hwnd = old_hwnd


def main():
    test_middle_insertion()
    test_cleanup_gets_only_left_context()
    test_insertion_memory_is_left_only()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
