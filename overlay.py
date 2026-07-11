"""Always-on-top status pill for Undertone.

A small dark capsule at the bottom-center of the screen with four states:
recording (live microphone level bars), transcribing (spinner), success
(check + transcript preview) and error (alert icon + message).

Rendering: the capsule background and all icons are pre-rendered with Pillow
at 4x supersampling and downscaled, so curves are anti-aliased instead of
showing the Tk canvas' jagged edges. The window uses a Windows transparency
color key; capsule edge pixels blend toward the near-black key colour, which
reads as a soft shadow.

Thread-safety: public methods only enqueue commands onto a queue.Queue that
is drained on the Tk main loop via root.after(); widgets are never touched
from other threads.
"""

import math
import queue
import time
import tkinter as tk
import tkinter.font as tkfont
from typing import Callable, Optional

from PIL import Image, ImageDraw, ImageTk

# Palette (Catppuccin Mocha).
BASE = "#1e1e2e"
SURFACE1 = "#45475a"
TEXT = "#cdd6f4"
SUBTEXT = "#a6adc8"
ACCENT = "#89b4fa"
RED = "#f38ba8"
AMBER = "#f9e2af"
GREEN = "#a6e3a1"

TRANSPARENT_KEY = "#010203"

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
BAR_TICK_MS = 50
SPIN_TICK_MS = 60
SPIN_FRAMES = 12
FADE_STEPS = 4
FADE_MS = 25
TARGET_ALPHA = 0.96

FONT_SPEC = ("Segoe UI", 11)


def _hex_to_rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


class Overlay:
    """A withdrawn, focus-less status pill controlled from any thread."""

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

        self._win = tk.Toplevel(root)
        self._win.withdraw()
        self._win.overrideredirect(True)
        self._win.attributes("-topmost", True)
        self._win.attributes("-alpha", TARGET_ALPHA)
        try:
            self._win.attributes("-toolwindow", True)
        except tk.TclError:
            pass
        self._win.configure(bg=TRANSPARENT_KEY)
        try:
            self._win.attributes("-transparentcolor", TRANSPARENT_KEY)
        except tk.TclError:
            pass

        self._font = tkfont.Font(family=FONT_SPEC[0], size=FONT_SPEC[1])
        self._canvas = tk.Canvas(
            self._win, bg=TRANSPARENT_KEY, highlightthickness=0, bd=0,
            height=PILL_H,
        )
        self._canvas.pack(fill="both", expand=True)

        # Image caches (PhotoImage references must stay alive).
        self._pill_cache = {}
        self._icons = {
            "check": self._render_check(),
            "alert": self._render_alert(),
        }
        self._spin_frames = [
            self._render_spinner(i / SPIN_FRAMES) for i in range(SPIN_FRAMES)
        ]
        self._spin_index = 0
        self._bar_items = []
        self._bars_x = 0
        self._t0 = time.monotonic()

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

    # --- Pillow rendering ---------------------------------------------------

    def _pill_photo(self, width):
        """Anti-aliased capsule background image, cached per width."""
        width = int(math.ceil(width / 8.0)) * 8
        if width not in self._pill_cache:
            w, h = width * S, PILL_H * S
            img = Image.new("RGB", (w, h), _hex_to_rgb(TRANSPARENT_KEY))
            d = ImageDraw.Draw(img)
            d.rounded_rectangle(
                (0, 0, w - 1, h - 1), radius=h // 2,
                fill=_hex_to_rgb(BASE), outline=_hex_to_rgb(SURFACE1), width=S,
            )
            small = img.resize((width, PILL_H), Image.LANCZOS)
            self._pill_cache[width] = ImageTk.PhotoImage(small)
        return self._pill_cache[width], width

    def _icon_photo(self, draw_fn):
        """Render a 20px icon anti-aliased against the pill background."""
        px = ICON * S
        img = Image.new("RGB", (px, px), _hex_to_rgb(BASE))
        draw_fn(ImageDraw.Draw(img), px)
        return ImageTk.PhotoImage(img.resize((ICON, ICON), Image.LANCZOS))

    def _render_check(self):
        def draw(d, px):
            pts = [(0.18 * px, 0.55 * px), (0.42 * px, 0.78 * px),
                   (0.84 * px, 0.26 * px)]
            d.line(pts, fill=_hex_to_rgb(GREEN), width=int(0.13 * px),
                   joint="curve")
        return self._icon_photo(draw)

    def _render_alert(self):
        def draw(d, px):
            d.ellipse((0, 0, px - 1, px - 1), fill=_hex_to_rgb(RED))
            bar_w = int(0.10 * px)
            cx = px // 2
            d.rounded_rectangle(
                (cx - bar_w, int(0.22 * px), cx + bar_w, int(0.58 * px)),
                radius=bar_w, fill=_hex_to_rgb(BASE))
            r = int(0.07 * px)
            d.ellipse((cx - r, int(0.70 * px), cx + r, int(0.70 * px) + 2 * r),
                      fill=_hex_to_rgb(BASE))
        return self._icon_photo(draw)

    def _render_spinner(self, fraction):
        def draw(d, px):
            m = int(0.10 * px)
            start = fraction * 360.0
            d.arc((m, m, px - m, px - m), start=start, end=start + 270,
                  fill=_hex_to_rgb(ACCENT), width=int(0.12 * px))
        return self._icon_photo(draw)

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
            self._layout("Listening…", TEXT, icon=None, bars=True)
            self._show()
            self._tick_bars()
        elif cmd == "transcribing":
            self._state = "transcribing"
            self._layout("Transcribing…", TEXT, icon=self._spin_frames[0])
            self._show()
            self._tick_spinner()
        elif cmd == "message":
            text, duration_ms, error = payload
            self._state = "message"
            self._layout(
                text, (RED if error else TEXT),
                icon=(self._icons["alert"] if error else self._icons["check"]),
            )
            self._show()
            gen = self._generation
            self._hide_after_id = self._root.after(
                duration_ms, lambda: self._auto_hide(gen))
        elif cmd == "hide":
            self._state = None
            self._win.withdraw()

    def _layout(self, text, text_color, icon=None, bars=False):
        """Rebuild the canvas: pill background, icon/bars slot, text."""
        text = self._ellipsize(text)
        text_w = self._font.measure(text)
        lead = BARS_W if bars else ICON
        width = PAD_X + lead + GAP + text_w + PAD_X

        pill, width = self._pill_photo(width)
        self._canvas.delete("all")
        self._canvas.configure(width=width, height=PILL_H)
        self._canvas.create_image(0, 0, image=pill, anchor="nw")

        cy = PILL_H / 2
        if bars:
            self._bar_items = []
            self._bars_x = PAD_X
            for i in range(5):
                x = PAD_X + i * (BAR_W + BAR_GAP)
                item = self._canvas.create_rectangle(
                    x, cy - BAR_MIN / 2, x + BAR_W, cy + BAR_MIN / 2,
                    fill=RED, outline="")
                self._bar_items.append(item)
        elif icon is not None:
            self._icon_item = self._canvas.create_image(
                PAD_X, cy - ICON / 2, image=icon, anchor="nw")

        self._canvas.create_text(
            PAD_X + lead + GAP, cy, text=text, anchor="w",
            fill=text_color, font=self._font)

        self._pill_width = width

    def _ellipsize(self, text):
        text = " ".join(text.split())  # collapse newlines/runs of whitespace
        max_text = int(self._win.winfo_screenwidth() * 0.6) - (
            PAD_X + ICON + GAP + PAD_X)
        if self._font.measure(text) <= max_text:
            return text
        lo, hi = 0, len(text)
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self._font.measure(text[:mid] + "…") <= max_text:
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
        cy = PILL_H / 2
        for i, item in enumerate(self._bar_items):
            # Idle wobble plus level-driven growth, per-bar phase offset.
            wobble = 0.5 + 0.5 * math.sin(t * 7.0 + i * 1.9)
            frac = 0.12 + 0.88 * min(1.0, level * 1.4) * (0.55 + 0.45 * wobble)
            h = BAR_MIN + (BAR_MAX - BAR_MIN) * frac
            x = self._bars_x + i * (BAR_W + BAR_GAP)
            self._canvas.coords(item, x, cy - h / 2, x + BAR_W, cy + h / 2)
        self._anim_after_id = self._root.after(BAR_TICK_MS, self._tick_bars)

    def _tick_spinner(self):
        self._spin_index = (self._spin_index + 1) % SPIN_FRAMES
        if getattr(self, "_icon_item", None) is not None:
            self._canvas.itemconfig(
                self._icon_item, image=self._spin_frames[self._spin_index])
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
        x = (sw - w) // 2
        y = sh - PILL_H - 80
        self._win.geometry(f"{int(w)}x{PILL_H}+{int(x)}+{int(y)}")

        was_hidden = self._win.state() == "withdrawn"
        self._win.deiconify()
        self._win.lift()
        if was_hidden:
            self._win.attributes("-alpha", 0.0)
            self._fade(1)

    def _fade(self, step):
        self._win.attributes(
            "-alpha", TARGET_ALPHA * min(1.0, step / FADE_STEPS))
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
