"""Always-on-top status pill for Undertone.

A small dark capsule at the bottom-center of the screen with four states:
recording (live microphone level bars), transcribing (spinner), success
(check + transcript preview) and error (alert icon + message).

Rendering: each frame is composed with Pillow (capsule at 4x supersampling,
text at 1x) and pushed to a Windows per-pixel-alpha layered window via
UpdateLayeredWindow, so the anti-aliased edges blend into whatever is behind
the pill — no colour-key fringe. The window is click-through and never takes
focus. Fading is done with the layered window's constant-alpha channel.

Thread-safety: public methods only enqueue commands onto a queue.Queue that
is drained on the Tk main loop via root.after(); the window is never touched
from other threads.
"""

import ctypes
import math
import queue
import time
import tkinter as tk
from ctypes import wintypes
from typing import Callable, Optional

from PIL import Image, ImageDraw, ImageFont

# Palette (Catppuccin Mocha).
BASE = "#1e1e2e"
SURFACE1 = "#45475a"
TEXT = "#cdd6f4"
SUBTEXT = "#a6adc8"
ACCENT = "#89b4fa"
RED = "#f38ba8"
AMBER = "#f9e2af"
GREEN = "#a6e3a1"

PILL_H = 44
PAD_X = 16
GAP = 10
ICON = 20               # icon box size (px)
BARS_W = 32             # width of the level-bars block
BAR_W = 4
BAR_GAP = 3
BAR_MIN = 5
BAR_MAX = 22

S = 4                   # supersampling factor for Pillow rendering
POLL_MS = 50
BAR_TICK_MS = 33
SPIN_TICK_MS = 60
SPIN_FRAMES = 12
FADE_STEPS = 4
FADE_MS = 25
TARGET_ALPHA = 0.96

FONT_SIZE = 15          # px; ~11pt Segoe UI at 96 dpi

# --- Win32 layered-window plumbing -------------------------------------------

_user32 = ctypes.windll.user32
_gdi32 = ctypes.windll.gdi32

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_NOACTIVATE = 0x08000000
WS_EX_TRANSPARENT = 0x00000020
ULW_ALPHA = 0x00000002
AC_SRC_OVER = 0x00
AC_SRC_ALPHA = 0x01
GA_ROOT = 2


class _BLENDFUNCTION(ctypes.Structure):
    _fields_ = [("BlendOp", ctypes.c_ubyte), ("BlendFlags", ctypes.c_ubyte),
                ("SourceConstantAlpha", ctypes.c_ubyte),
                ("AlphaFormat", ctypes.c_ubyte)]


class _SIZE(ctypes.Structure):
    _fields_ = [("cx", ctypes.c_long), ("cy", ctypes.c_long)]


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long),
                ("biHeight", ctypes.c_long), ("biPlanes", wintypes.WORD),
                ("biBitCount", wintypes.WORD),
                ("biCompression", wintypes.DWORD),
                ("biSizeImage", wintypes.DWORD),
                ("biXPelsPerMeter", ctypes.c_long),
                ("biYPelsPerMeter", ctypes.c_long),
                ("biClrUsed", wintypes.DWORD),
                ("biClrImportant", wintypes.DWORD)]


class _BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", _BITMAPINFOHEADER),
                ("bmiColors", wintypes.DWORD * 3)]


def _hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _load_font():
    for name in ("segoeui.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, FONT_SIZE)
        except OSError:
            continue
    return ImageFont.load_default()


class Overlay:
    """A withdrawn, focus-less, click-through status pill."""

    def __init__(self, root: tk.Tk,
                 level_getter: Optional[Callable[[], float]] = None):
        self._root = root
        self._level = level_getter or (lambda: 0.0)
        self._queue: "queue.Queue" = queue.Queue()
        self._generation = 0
        self._hide_after_id = None
        self._anim_after_id = None
        self._fade_after_id = None
        self._state = None
        self._hwnd = None
        self._alpha = int(255 * TARGET_ALPHA)
        self._x = self._y = 0

        self._win = tk.Toplevel(root)
        self._win.withdraw()
        self._win.overrideredirect(True)
        self._win.attributes("-topmost", True)

        self._font = _load_font()
        self._bg_cache = {}      # width -> 4x RGBA capsule background
        self._spin_index = 0
        self._bar_heights = [BAR_MIN] * 5
        self._t0 = time.monotonic()

        # Current layout, re-composed each animation tick.
        self._text = ""
        self._text_color = TEXT
        self._mode = "none"      # "bars" | "spinner" | "check" | "alert"
        self._pill_width = 0

        self._root.after(POLL_MS, self._drain)

    # --- Public, thread-safe API ------------------------------------------

    def show_recording(self):
        """Show the pill with live microphone level bars."""
        self._queue.put(("recording", None))

    def show_transcribing(self):
        """Show the pill with a spinner."""
        self._queue.put(("transcribing", None))

    def show_message(self, text: str, duration_ms: int = 2500, error: bool = False):
        """Show a transient message that auto-hides after duration_ms."""
        self._queue.put(("message", (text, duration_ms, error)))

    def hide(self):
        """Withdraw the pill."""
        self._queue.put(("hide", None))

    # --- Frame composition (all Pillow) -------------------------------------

    def _capsule_bg(self, width):
        """4x supersampled RGBA capsule on a transparent field, cached."""
        if width not in self._bg_cache:
            w, h = width * S, PILL_H * S
            img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
            d = ImageDraw.Draw(img)
            d.rounded_rectangle(
                (0, 0, w - 1, h - 1), radius=h // 2,
                fill=_hex_to_rgb(BASE) + (255,),
                outline=_hex_to_rgb(SURFACE1) + (255,), width=S,
            )
            self._bg_cache[width] = img
        return self._bg_cache[width]

    def _compose(self):
        """Render the current pill state as a 1x RGBA frame."""
        width = self._pill_width
        img = self._capsule_bg(width).copy()
        d = ImageDraw.Draw(img)
        cy = PILL_H * S // 2

        if self._mode == "bars":
            for i, bh in enumerate(self._bar_heights):
                x = (PAD_X + i * (BAR_W + BAR_GAP)) * S
                hh = bh * S / 2
                d.rounded_rectangle(
                    (x, cy - hh, x + BAR_W * S, cy + hh),
                    radius=BAR_W * S // 2, fill=_hex_to_rgb(RED) + (255,))
        elif self._mode == "spinner":
            self._draw_spinner(d, self._spin_index / SPIN_FRAMES)
        elif self._mode == "check":
            self._draw_check(d)
        elif self._mode == "alert":
            self._draw_alert(d)

        frame = img.resize((width, PILL_H), Image.LANCZOS)
        if self._text:
            lead = BARS_W if self._mode == "bars" else ICON
            ImageDraw.Draw(frame).text(
                (PAD_X + lead + GAP, PILL_H / 2), self._text,
                font=self._font, fill=_hex_to_rgb(self._text_color) + (255,),
                anchor="lm")
        return frame

    # Icon painters draw into the 20px icon box at 4x scale.

    def _icon_box(self):
        x0 = PAD_X * S
        y0 = (PILL_H - ICON) * S // 2
        return x0, y0, ICON * S

    def _draw_spinner(self, d, fraction):
        x0, y0, px = self._icon_box()
        m = int(0.10 * px)
        start = fraction * 360.0
        d.arc((x0 + m, y0 + m, x0 + px - m, y0 + px - m), start=start,
              end=start + 270, fill=_hex_to_rgb(ACCENT) + (255,),
              width=int(0.12 * px))

    def _draw_check(self, d):
        x0, y0, px = self._icon_box()
        pts = [(x0 + 0.18 * px, y0 + 0.55 * px),
               (x0 + 0.42 * px, y0 + 0.78 * px),
               (x0 + 0.84 * px, y0 + 0.26 * px)]
        d.line(pts, fill=_hex_to_rgb(GREEN) + (255,), width=int(0.13 * px),
               joint="curve")

    def _draw_alert(self, d):
        x0, y0, px = self._icon_box()
        base = _hex_to_rgb(BASE) + (255,)
        d.ellipse((x0, y0, x0 + px - 1, y0 + px - 1),
                  fill=_hex_to_rgb(RED) + (255,))
        bar_w = int(0.10 * px)
        cx = x0 + px // 2
        d.rounded_rectangle(
            (cx - bar_w, y0 + int(0.22 * px), cx + bar_w, y0 + int(0.58 * px)),
            radius=bar_w, fill=base)
        r = int(0.07 * px)
        d.ellipse((cx - r, y0 + int(0.70 * px), cx + r,
                   y0 + int(0.70 * px) + 2 * r), fill=base)

    # --- Layered-window presentation -----------------------------------------

    def _ensure_layered(self):
        self._win.update_idletasks()
        hwnd = _user32.GetAncestor(self._win.winfo_id(), GA_ROOT)
        if hwnd != self._hwnd:
            self._hwnd = hwnd
        ex = _user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        ex |= (WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
               | WS_EX_TRANSPARENT)
        _user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)

    def _push(self, frame):
        """Blit an RGBA frame to the layered window with per-pixel alpha."""
        if self._hwnd is None:
            return
        w, h = frame.size
        data = frame.tobytes("raw", "BGRa")  # premultiplied BGRA

        screen_dc = _user32.GetDC(None)
        mem_dc = _gdi32.CreateCompatibleDC(screen_dc)
        bmi = _BITMAPINFO()
        bmi.bmiHeader.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        bmi.bmiHeader.biWidth = w
        bmi.bmiHeader.biHeight = -h  # top-down
        bmi.bmiHeader.biPlanes = 1
        bmi.bmiHeader.biBitCount = 32
        bits = ctypes.c_void_p()
        dib = _gdi32.CreateDIBSection(screen_dc, ctypes.byref(bmi), 0,
                                      ctypes.byref(bits), None, 0)
        if not dib:
            _gdi32.DeleteDC(mem_dc)
            _user32.ReleaseDC(None, screen_dc)
            return
        ctypes.memmove(bits, data, len(data))
        old = _gdi32.SelectObject(mem_dc, dib)

        blend = _BLENDFUNCTION(AC_SRC_OVER, 0, self._alpha, AC_SRC_ALPHA)
        pos = wintypes.POINT(self._x, self._y)
        size = _SIZE(w, h)
        src = wintypes.POINT(0, 0)
        _user32.UpdateLayeredWindow(
            self._hwnd, screen_dc, ctypes.byref(pos), ctypes.byref(size),
            mem_dc, ctypes.byref(src), 0, ctypes.byref(blend), ULW_ALPHA)

        _gdi32.SelectObject(mem_dc, old)
        _gdi32.DeleteObject(dib)
        _gdi32.DeleteDC(mem_dc)
        _user32.ReleaseDC(None, screen_dc)

    def _present(self):
        self._push(self._compose())

    # --- Tk-thread internals ----------------------------------------------

    def _drain(self):
        try:
            while True:
                cmd, payload = self._queue.get_nowait()
                self._handle(cmd, payload)
        except queue.Empty:
            pass
        finally:
            self._root.after(POLL_MS, self._drain)

    def _handle(self, cmd, payload):
        self._generation += 1
        self._cancel_hide()
        self._stop_anim()

        if cmd == "recording":
            self._state = "recording"
            self._layout("Listening…", TEXT, mode="bars")
            self._show()
            self._tick_bars()
        elif cmd == "transcribing":
            self._state = "transcribing"
            self._layout("Transcribing…", TEXT, mode="spinner")
            self._show()
            self._tick_spinner()
        elif cmd == "message":
            text, duration_ms, error = payload
            self._state = "message"
            self._layout(text, (RED if error else TEXT),
                         mode=("alert" if error else "check"))
            self._show()
            gen = self._generation
            self._hide_after_id = self._root.after(
                duration_ms, lambda: self._auto_hide(gen))
        elif cmd == "hide":
            self._state = None
            self._win.withdraw()

    def _layout(self, text, text_color, mode):
        text = self._ellipsize(text)
        text_w = int(math.ceil(self._font.getlength(text)))
        lead = BARS_W if mode == "bars" else ICON
        width = PAD_X + lead + GAP + text_w + PAD_X
        width = int(math.ceil(width / 8.0)) * 8

        self._text = text
        self._text_color = text_color
        self._mode = mode
        self._pill_width = width

    def _ellipsize(self, text):
        text = " ".join(text.split())  # collapse newlines/runs of whitespace
        max_text = int(self._win.winfo_screenwidth() * 0.6) - (
            PAD_X + ICON + GAP + PAD_X)
        if self._font.getlength(text) <= max_text:
            return text
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._font.getlength(text[:mid] + "…") <= max_text:
                lo = mid
            else:
                hi = mid - 1
        return (text[:lo].rstrip() + "…") if lo > 0 else "…"

    # --- Animation ----------------------------------------------------------

    def _tick_bars(self):
        level = 0.0
        try:
            level = max(0.0, min(1.0, float(self._level())))
        except Exception:
            pass
        t = time.monotonic() - self._t0
        for i in range(5):
            # Idle wobble plus level-driven growth, per-bar phase offset.
            wobble = 0.5 + 0.5 * math.sin(t * 7.0 + i * 1.9)
            frac = 0.10 + 0.90 * min(1.0, level * 1.25) * (0.5 + 0.5 * wobble)
            self._bar_heights[i] = BAR_MIN + (BAR_MAX - BAR_MIN) * frac
        self._present()
        self._anim_after_id = self._root.after(BAR_TICK_MS, self._tick_bars)

    def _tick_spinner(self):
        self._spin_index = (self._spin_index + 1) % SPIN_FRAMES
        self._present()
        self._anim_after_id = self._root.after(SPIN_TICK_MS, self._tick_spinner)

    def _stop_anim(self):
        if self._anim_after_id is not None:
            self._root.after_cancel(self._anim_after_id)
            self._anim_after_id = None
        if self._fade_after_id is not None:
            self._root.after_cancel(self._fade_after_id)
            self._fade_after_id = None

    # --- Show / hide ----------------------------------------------------------

    def _show(self):
        w = self._pill_width
        sw = self._win.winfo_screenwidth()
        sh = self._win.winfo_screenheight()
        self._x = (sw - w) // 2
        self._y = sh - PILL_H - 80
        self._win.geometry(f"{int(w)}x{PILL_H}+{self._x}+{self._y}")

        was_hidden = self._win.state() == "withdrawn"
        self._win.deiconify()
        self._ensure_layered()
        if was_hidden:
            self._alpha = 0
            self._present()
            self._fade(1)
        else:
            self._alpha = int(255 * TARGET_ALPHA)
            self._present()
        self._win.lift()

    def _fade(self, step):
        self._alpha = int(255 * TARGET_ALPHA * min(1.0, step / FADE_STEPS))
        self._push(self._compose())
        if step < FADE_STEPS:
            self._fade_after_id = self._root.after(
                FADE_MS, lambda: self._fade(step + 1))
        else:
            self._fade_after_id = None

    def _auto_hide(self, gen):
        if gen == self._generation:
            self._state = None
            self._win.withdraw()

    def _cancel_hide(self):
        if self._hide_after_id is not None:
            self._root.after_cancel(self._hide_after_id)
            self._hide_after_id = None
