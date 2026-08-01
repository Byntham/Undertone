"""Caret context via Windows UI Automation for Undertone.

Reads the text immediately before and after the caret in the focused control
so dictation can join cleanly with existing text. UIA lives on a single
long-lived daemon worker that keeps COM initialized; public calls hand it a
job and wait with a timeout, so they are safe to call from any thread and
never block longer than the timeout. Also exposes the foreground process name
via plain ctypes.
"""

import ctypes
import logging
import queue
import threading
import time
from ctypes import wintypes

# comtypes logs INFO-level cache housekeeping; keep it out of app.log.
logging.getLogger("comtypes").setLevel(logging.WARNING)

# --- UIA worker plumbing ----------------------------------------------------

_queue: "queue.Queue" = queue.Queue()
_worker_lock = threading.Lock()
_worker_started = False
_busy_since = 0.0       # monotonic time the worker entered a COM query; 0 = idle
_WEDGE_S = 3.0          # a query stuck this long means the provider is hung
_STOP = object()


class _Job:
    __slots__ = ("before_n", "after_n", "event", "result", "cancelled")

    def __init__(self, before_n: int, after_n: int):
        self.before_n = before_n
        self.after_n = after_n
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


def _query_caret_context(UIA, automation, before_n: int, after_n: int):
    """Return text around the UIA caret/selection. May raise."""
    element = automation.GetFocusedElement()
    if not element:
        return None

    # Never read a masked field: the left context may be sent to a cleanup
    # API, and neither side should expose a password. A property failure falls
    # through to the normal path rather than aborting the read.
    try:
        if element.CurrentIsPassword:
            return None
    except Exception:
        pass

    caret = None

    # Preferred: TextPattern2 -> GetCaretRange (a degenerate range at caret).
    try:
        raw = element.GetCurrentPattern(UIA.UIA_TextPattern2Id)
        if raw:
            tp2 = raw.QueryInterface(UIA.IUIAutomationTextPattern2)
            # GetCaretRange has one [out] isActive plus the retval range;
            # comtypes returns them as a tuple. isActive=False means the
            # range does NOT represent the live caret (it may sit in a
            # nested child element) — fall through to the TextPattern
            # selection path rather than trust a stale range.
            res = tp2.GetCaretRange()
            if isinstance(res, tuple) and len(res) >= 2:
                caret = res[-1] if res[0] else None
            else:
                caret = res[-1] if isinstance(res, tuple) else res
    except Exception:
        caret = None

    # A non-empty selection will be replaced by the paste, so its start and
    # end are the two insertion boundaries. A degenerate selection is also a
    # fallback caret when TextPattern2 is unavailable.
    left_edge = None
    right_edge = None
    try:
        raw = element.GetCurrentPattern(UIA.UIA_TextPatternId)
        if raw:
            tp = raw.QueryInterface(UIA.IUIAutomationTextPattern)
            selection = tp.GetSelection()
            if selection and selection.Length >= 1:
                selected = selection.GetElement(0)
                collapsed = selected.CompareEndpoints(
                    UIA.TextPatternRangeEndpoint_Start,
                    selected,
                    UIA.TextPatternRangeEndpoint_End,
                )
                if collapsed != 0:
                    left_edge = selected.Clone()
                    left_edge.MoveEndpointByRange(
                        UIA.TextPatternRangeEndpoint_End,
                        left_edge,
                        UIA.TextPatternRangeEndpoint_Start,
                    )
                    right_edge = selected.Clone()
                    right_edge.MoveEndpointByRange(
                        UIA.TextPatternRangeEndpoint_Start,
                        right_edge,
                        UIA.TextPatternRangeEndpoint_End,
                    )
                elif not caret:
                    caret = selected
    except Exception:
        pass

    if left_edge is None:
        if not caret:
            return None
        left_edge = caret
        right_edge = caret

    before_range = left_edge.Clone()
    before_range.MoveEndpointByUnit(
        UIA.TextPatternRangeEndpoint_Start,
        UIA.TextUnit_Character,
        -before_n,
    )
    before = before_range.GetText(-1)
    if before is None:
        return None

    # Preserve the established left context if a provider fails only while
    # expanding the range to the right.
    after = None
    try:
        after_range = right_edge.Clone()
        after_range.MoveEndpointByUnit(
            UIA.TextPatternRangeEndpoint_End,
            UIA.TextUnit_Character,
            after_n,
        )
        after = after_range.GetText(-1)
    except Exception:
        pass
    return before, after


def _worker_loop(jobs: "queue.Queue"):
    global _busy_since
    UIA, automation = _make_uia()
    while True:
        job = jobs.get()
        if job is _STOP:
            break
        if job.cancelled:
            continue
        result = None
        if automation is not None:
            _busy_since = time.monotonic()
            try:
                result = _query_caret_context(
                    UIA, automation, job.before_n, job.after_n)
            except Exception:
                result = None
            finally:
                _busy_since = 0.0
        job.result = result
        job.event.set()


def _spawn_worker() -> bool:
    """Start a worker bound to the CURRENT _queue. Caller holds _worker_lock."""
    global _worker_started, _busy_since
    try:
        t = threading.Thread(
            target=_worker_loop, args=(_queue,), name="caretctx-uia",
            daemon=True,
        )
        t.start()
        _worker_started = True
        _busy_since = 0.0
        return True
    except Exception:
        return False


def _ensure_worker() -> bool:
    global _queue
    with _worker_lock:
        if _worker_started:
            # Watchdog: a COM call can hang forever and there is no way to
            # abort it. Abandon the wedged worker (it keeps its old queue,
            # so it can never steal new jobs) and start a fresh one.
            if _busy_since and time.monotonic() - _busy_since > _WEDGE_S:
                logging.warning("caretctx: UIA worker wedged >%.0fs; "
                                "respawning", _WEDGE_S)
                _queue = queue.Queue()
                return _spawn_worker()
            return True
        return _spawn_worker()


# --- Public API -------------------------------------------------------------


def warm() -> None:
    """Pre-initialize COM/UIA on the background worker. Never raises."""
    try:
        _ensure_worker()
    except Exception:
        pass


def text_around_caret(before_n: int = 120, after_n: int = 120,
                      timeout: float = 0.15):
    """Bounded text immediately before and after the caret.

    Tries UIA TextPattern first, then the Win32 Edit-control protocol
    (EM_GETSEL/WM_GETTEXT — covers Notepad-class apps whose edit controls
    predate UIA). A selection is excluded because paste replaces it. Returns
    ``(before, after)`` or None if unavailable. ``after`` may be None if only
    the established left-side read succeeds. Callable from any thread, never
    raises, and never blocks beyond approximately timeout.
    """
    result = None
    try:
        if _ensure_worker():
            job = _Job(before_n, after_n)
            _queue.put(job)
            if job.event.wait(timeout):
                result = job.result
            else:
                # Timed out: tell the worker to skip this job if it hasn't
                # started. The unique per-call job means a late result can
                # never surface on a subsequent call.
                job.cancelled = True
    except Exception:
        result = None
    if result is None:
        result = _win32_caret_context(before_n, after_n)
    return result


def text_before_caret(n: int = 120, timeout: float = 0.15) -> "str | None":
    """Backward-compatible left-side-only caret context."""
    context = text_around_caret(n, 0, timeout)
    return context[0] if context is not None else None


# --- Win32 Edit-control fallback (pure ctypes) -------------------------------

_WM_GETTEXT = 0x000D
_WM_GETTEXTLENGTH = 0x000E
_EM_GETSEL = 0x00B0
_SMTO_ABORTIFHUNG = 0x0002


class _GUITHREADINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD), ("flags", wintypes.DWORD),
        ("hwndActive", wintypes.HWND), ("hwndFocus", wintypes.HWND),
        ("hwndCapture", wintypes.HWND), ("hwndMenuOwner", wintypes.HWND),
        ("hwndMoveSize", wintypes.HWND), ("hwndCaret", wintypes.HWND),
        ("rcCaret", wintypes.RECT),
    ]


# Private user32 instance: setting a prototype on ctypes.windll.user32 would
# poison the process-wide function cache other modules share (AGENTS.md rule).
_user32 = ctypes.WinDLL("user32", use_last_error=True)
_SendMessageTimeoutW = _user32.SendMessageTimeoutW
_SendMessageTimeoutW.argtypes = [
    wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM,
    wintypes.UINT, wintypes.UINT, ctypes.POINTER(ctypes.c_size_t),
]


def _send(hwnd, msg, wparam=0, lparam=0, timeout_ms=100):
    """SendMessageTimeout wrapper; returns the result or None on failure.

    ABORTIFHUNG + timeout so a frozen target app can never stall a paste.
    """
    out = ctypes.c_size_t(0)
    ok = _SendMessageTimeoutW(hwnd, msg, wparam, lparam,
                              _SMTO_ABORTIFHUNG, timeout_ms,
                              ctypes.byref(out))
    return out.value if ok else None


def _win32_caret_context(before_n: int, after_n: int):
    """Caret/selection context from a classic Edit/RichEdit control.

    EM_GETSEL packs the selection into LO/HIWORD of the return value, so
    only controls holding < 64k characters are trusted (plenty for text
    boxes; huge documents bail out).
    """
    try:
        user32 = ctypes.windll.user32
        info = _GUITHREADINFO()
        info.cbSize = ctypes.sizeof(_GUITHREADINFO)
        if not user32.GetGUIThreadInfo(0, ctypes.byref(info)):
            return None
        hwnd = info.hwndFocus
        if not hwnd:
            return None
        cls = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, cls, 64)
        if "edit" not in cls.value.lower():
            return None

        length = _send(hwnd, _WM_GETTEXTLENGTH)
        if length is None or length >= 0xFFFF:
            return None
        sel = _send(hwnd, _EM_GETSEL)
        if sel is None:
            return None
        start = min(sel & 0xFFFF, length)
        end = min((sel >> 16) & 0xFFFF, length)
        if start > end:
            start, end = end, start

        buf = ctypes.create_unicode_buffer(length + 1)
        if _send(hwnd, _WM_GETTEXT, length + 1,
                 ctypes.addressof(buf)) is None:
            return None
        text = buf.value
        return (text[max(0, start - before_n):start],
                text[end:min(length, end + after_n)])
    except Exception:
        return None


def focus_window(hwnd: int) -> bool:
    """Bring hwnd to the foreground (best effort); True if it got there.

    Windows blocks SetForegroundWindow from background processes; attaching
    to the current foreground window's input thread is the sanctioned
    workaround so a paste can return to the window it was dictated into.
    """
    try:
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        if not hwnd or not user32.IsWindow(hwnd):
            return False
        if user32.GetForegroundWindow() == hwnd:
            return True
        fg = user32.GetForegroundWindow()
        fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        my_tid = kernel32.GetCurrentThreadId()
        attached = fg_tid and fg_tid != my_tid and user32.AttachThreadInput(
            my_tid, fg_tid, True)
        try:
            user32.SetForegroundWindow(hwnd)
        finally:
            if attached:
                user32.AttachThreadInput(my_tid, fg_tid, False)
        for _ in range(10):
            if user32.GetForegroundWindow() == hwnd:
                return True
            time.sleep(0.02)
        return False
    except Exception:
        return False


def get_window_title() -> "str | None":
    """Title of the foreground window, or None."""
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
        if not hwnd:
            return None
        buf = ctypes.create_unicode_buffer(256)
        ctypes.windll.user32.GetWindowTextW(hwnd, buf, 256)
        return buf.value or None
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
