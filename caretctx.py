"""Caret context via Windows UI Automation for Undertone.

Reads the text immediately before the caret in the focused control so
dictation can be aware of what the user was already typing. UIA lives on a
single long-lived daemon worker that keeps COM initialized; public calls hand
it a job and wait with a timeout, so they are safe to call from any thread and
never block longer than the timeout. Also exposes the foreground process name
via plain ctypes.
"""

import ctypes
import logging
import queue
import threading
from ctypes import wintypes

# comtypes logs INFO-level cache housekeeping; keep it out of app.log.
logging.getLogger("comtypes").setLevel(logging.WARNING)

# --- UIA worker plumbing ----------------------------------------------------

_queue: "queue.Queue" = queue.Queue()
_worker_lock = threading.Lock()
_worker_started = False
_STOP = object()


class _Job:
    __slots__ = ("n", "event", "result", "cancelled")

    def __init__(self, n: int):
        self.n = n
        self.event = threading.Event()
        self.result = None
        self.cancelled = False


def _make_uia():
    """Create the root IUIAutomation object on the calling thread.

    Returns (UIA_module, automation) or (None, None) on any failure.
    """
    try:
        import comtypes
        import comtypes.client

        try:
            comtypes.CoInitializeEx(comtypes.COINIT_APARTMENTTHREADED)
        except Exception:
            # Already initialized on this thread, or coinit unavailable.
            pass

        comtypes.client.GetModule("UIAutomationCore.dll")
        from comtypes.gen import UIAutomationClient as UIA

        automation = comtypes.client.CreateObject(
            UIA.CUIAutomation, interface=UIA.IUIAutomation
        )
        return UIA, automation
    except Exception:
        return None, None


def _query_before_caret(UIA, automation, n: int):
    """Do the actual UIA caret walk. Returns str or None. May raise."""
    element = automation.GetFocusedElement()
    if not element:
        return None

    caret = None

    # Preferred: TextPattern2 -> GetCaretRange (a degenerate range at caret).
    try:
        raw = element.GetCurrentPattern(UIA.UIA_TextPattern2Id)
        if raw:
            tp2 = raw.QueryInterface(UIA.IUIAutomationTextPattern2)
            # GetCaretRange has one [out] isActive plus the retval range;
            # comtypes returns them as a tuple.
            res = tp2.GetCaretRange()
            caret = res[-1] if isinstance(res, tuple) else res
    except Exception:
        caret = None

    # Fallback: TextPattern -> GetSelection(); degenerate range == caret,
    # otherwise collapse the selection to its start.
    if not caret:
        raw = element.GetCurrentPattern(UIA.UIA_TextPatternId)
        if not raw:
            return None
        tp = raw.QueryInterface(UIA.IUIAutomationTextPattern)
        selection = tp.GetSelection()
        if not selection or selection.Length < 1:
            return None
        caret = selection.GetElement(0)
        collapsed = caret.CompareEndpoints(
            UIA.TextPatternRangeEndpoint_Start,
            caret,
            UIA.TextPatternRangeEndpoint_End,
        )
        if collapsed != 0:
            # Non-empty selection: pull the End endpoint back to Start.
            caret.MoveEndpointByRange(
                UIA.TextPatternRangeEndpoint_End,
                caret,
                UIA.TextPatternRangeEndpoint_Start,
            )

    if not caret:
        return None

    walk = caret.Clone()
    walk.MoveEndpointByUnit(
        UIA.TextPatternRangeEndpoint_Start, UIA.TextUnit_Character, -n
    )
    text = walk.GetText(-1)
    return text if text is not None else None


def _worker_loop():
    UIA, automation = _make_uia()
    while True:
        job = _queue.get()
        if job is _STOP:
            break
        if job.cancelled:
            continue
        result = None
        if automation is not None:
            try:
                result = _query_before_caret(UIA, automation, job.n)
            except Exception:
                result = None
        job.result = result
        job.event.set()


def _ensure_worker() -> bool:
    global _worker_started
    with _worker_lock:
        if _worker_started:
            return True
        try:
            t = threading.Thread(
                target=_worker_loop, name="caretctx-uia", daemon=True
            )
            t.start()
            _worker_started = True
            return True
        except Exception:
            return False


# --- Public API -------------------------------------------------------------


def warm() -> None:
    """Pre-initialize COM/UIA on the background worker. Never raises."""
    try:
        _ensure_worker()
    except Exception:
        pass


def text_before_caret(n: int = 120, timeout: float = 0.15) -> "str | None":
    """Up to n characters immediately before the caret in the focused control.

    Returns None if unavailable (no text pattern, timeout, or any error).
    Callable from any thread, never raises, never blocks beyond ~timeout.
    """
    try:
        if not _ensure_worker():
            return None
        job = _Job(n)
        _queue.put(job)
        if job.event.wait(timeout):
            return job.result
        # Timed out: tell the worker to skip this job if it hasn't started,
        # and return None. The unique per-call job means a late result can
        # never surface on a subsequent call.
        job.cancelled = True
        return None
    except Exception:
        return None


# --- Foreground process name (pure ctypes) ----------------------------------

_PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def get_foreground_exe() -> "str | None":
    """Lowercased basename of the foreground window's executable, or None."""
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        hwnd = user32.GetForegroundWindow()
        if not hwnd:
            return None

        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return None

        handle = kernel32.OpenProcess(
            _PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value
        )
        if not handle:
            return None
        try:
            size = wintypes.DWORD(260)
            buf = ctypes.create_unicode_buffer(size.value)
            if not kernel32.QueryFullProcessImageNameW(
                handle, 0, buf, ctypes.byref(size)
            ):
                return None
            path = buf.value
        finally:
            kernel32.CloseHandle(handle)

        if not path:
            return None
        return path.rsplit("\\", 1)[-1].lower()
    except Exception:
        return None
