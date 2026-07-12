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
                result = _query_before_caret(UIA, automation, job.n)
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


def text_before_caret(n: int = 120, timeout: float = 0.15) -> "str | None":
    """Up to n characters immediately before the caret in the focused control.

    Tries UIA TextPattern first, then the Win32 Edit-control protocol
    (EM_GETSEL/WM_GETTEXT — covers Notepad-class apps whose edit controls
    predate UIA). Returns None if unavailable (no text pattern, timeout, or
    any error). Callable from any thread, never raises, never blocks beyond
    ~timeout.
    """
    result = None
    try:
        if _ensure_worker():
            job = _Job(n)
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
        result = _win32_before_caret(n)
    return result


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


_SendMessageTimeoutW = ctypes.windll.user32.SendMessageTimeoutW
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


def _win32_before_caret(n: int) -> "str | None":
    """Caret context from a classic Edit/RichEdit control, or None.

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
        caret = min(sel & 0xFFFF, length)

        buf = ctypes.create_unicode_buffer(length + 1)
        if _send(hwnd, _WM_GETTEXT, length + 1,
                 ctypes.addressof(buf)) is None:
            return None
        return buf.value[max(0, caret - n):caret]
    except Exception:
        return None


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
