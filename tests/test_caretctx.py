"""Manual assert-based test for caretctx (no pytest).

Run with the venv python from the repo root:
    .venv\\Scripts\\python.exe tests\\test_caretctx.py

Needs an interactive Windows desktop session -- it launches real windows,
forces them to the foreground, and types into them.

This is a manual integration test for Windows' live UIA provider. Routine
verification belongs in test_caretctx_unit.py and never touches the desktop.
Set UNDERTONE_CARET_LIVE=1 and leave the desktop idle to run this script.
"""

import ctypes
import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import keyboard  # noqa: E402

import caretctx  # noqa: E402
import localproc  # noqa: E402

TYPED = "Hello caret world"
_user32 = ctypes.windll.user32

WPF_SCRIPT = r"""
Add-Type -AssemblyName PresentationFramework
$win = New-Object System.Windows.Window
$win.Title = "CaretCtxTarget"
$win.Width = 400; $win.Height = 200; $win.Topmost = $true
$tb = New-Object System.Windows.Controls.TextBox
$tb.AcceptsReturn = $true
$win.Content = $tb
$win.Add_ContentRendered({ $win.Activate() | Out-Null; $tb.Focus() | Out-Null })
[void]$win.ShowDialog()
"""

PWBOX_SCRIPT = r"""
Add-Type -AssemblyName PresentationFramework
$win = New-Object System.Windows.Window
$win.Title = "CaretCtxPassword"
$win.Width = 400; $win.Height = 200; $win.Topmost = $true
$pb = New-Object System.Windows.Controls.PasswordBox
$win.Content = $pb
$win.Add_ContentRendered({ $win.Activate() | Out-Null; $pb.Focus() | Out-Null })
[void]$win.ShowDialog()
"""


def force_foreground(title: str) -> int:
    """Find a top-level window by title and drag it to the foreground."""
    hwnd = _user32.FindWindowW(None, title)
    if not hwnd:
        return 0
    _user32.ShowWindow(hwnd, 9)  # SW_RESTORE
    keyboard.press_and_release("alt")  # unlock foreground stealing
    _user32.SetForegroundWindow(hwnd)
    _user32.BringWindowToTop(hwnd)
    return hwnd


def test_wpf_caret(script_path):
    proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden",
         "-ExecutionPolicy", "Bypass", "-File", script_path]
    )
    job = localproc.attach_job(proc)
    time.sleep(3.0)
    try:
        hwnd = force_foreground("CaretCtxTarget")
        assert hwnd, "WPF target window never appeared"
        assert caretctx.get_foreground_exe() == "powershell.exe"
        # Settle focus and clear any alt-menu activation state left by the
        # foreground-unlock tap, otherwise the first Shift+H can be swallowed.
        time.sleep(0.8)
        keyboard.send("esc")
        keyboard.send("ctrl+a")
        keyboard.send("delete")
        time.sleep(0.3)
        keyboard.write(TYPED, delay=0.03)
        keyboard.send("ctrl+left")  # before "world"
        time.sleep(0.5)

        got = caretctx.text_around_caret(50, 50)
        print("text_around_caret over WPF TextBox:", repr(got))
        assert got is not None, "text_around_caret returned None over WPF box"
        before, after = got
        assert before.endswith("Hello caret "), repr(before)
        assert after.startswith("world"), repr(after)
    finally:
        localproc.close_job(job)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        time.sleep(0.6)


def test_wpf_password(script_path):
    """A focused UIA password field must never leak context (IsPassword)."""
    proc = subprocess.Popen(
        ["powershell", "-NoProfile", "-WindowStyle", "Hidden",
         "-ExecutionPolicy", "Bypass", "-File", script_path]
    )
    job = localproc.attach_job(proc)
    time.sleep(3.0)
    try:
        hwnd = force_foreground("CaretCtxPassword")
        assert hwnd, "WPF password window never appeared"
        time.sleep(0.8)
        keyboard.send("esc")
        keyboard.write(TYPED, delay=0.03)
        time.sleep(0.5)

        got = caretctx.text_around_caret(50, 50)
        print("text_around_caret over WPF PasswordBox:", repr(got))
        assert got is None, f"password field leaked context: {got!r}"
    finally:
        localproc.close_job(job)
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)
        time.sleep(0.6)


def test_none_cases():
    # No text pattern under focus (desktop) -> None, not an exception.
    keyboard.send("windows+d")
    time.sleep(0.6)
    no_text = caretctx.text_around_caret(50, 50)
    print("text_around_caret over desktop:", repr(no_text))
    assert no_text is None, f"expected None over desktop, got {no_text!r}"

    # Tiny timeout returns None quickly instead of blocking.
    start = time.perf_counter()
    quick = caretctx.text_around_caret(50, 50, timeout=0.001)
    elapsed = time.perf_counter() - start
    print(f"tiny-timeout call: {quick!r} in {elapsed * 1000:.1f}ms")
    assert quick is None, f"expected None with tiny timeout, got {quick!r}"
    assert elapsed < 0.1, f"tiny-timeout call blocked for {elapsed:.3f}s"


def main():
    if os.environ.get("UNDERTONE_CARET_LIVE") != "1":
        print("SKIPPED: set UNDERTONE_CARET_LIVE=1 only on an idle desktop")
        return
    caretctx.warm()
    time.sleep(1.0)  # let the worker init COM/UIA

    fd, script_path = tempfile.mkstemp(suffix=".ps1", text=True)
    os.close(fd)
    with open(script_path, "w", encoding="utf-8") as fh:
        fh.write(WPF_SCRIPT)

    fd2, pw_script_path = tempfile.mkstemp(suffix=".ps1", text=True)
    os.close(fd2)
    with open(pw_script_path, "w", encoding="utf-8") as fh:
        fh.write(PWBOX_SCRIPT)

    try:
        test_wpf_caret(script_path)
        test_wpf_password(pw_script_path)
        test_none_cases()
    finally:
        for p in (script_path, pw_script_path):
            try:
                os.remove(p)
            except OSError:
                pass

    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
