"""Always-on-top status pill for Undertone (Qt).

A small dark capsule at the bottom-center of the screen with four states:
recording (live microphone level bars), transcribing (spinner), success
(check + transcript preview) and error (alert icon + message).

Rendering: a frameless, translucent, click-through QWidget painted with
QPainter — Qt composites the per-pixel-alpha surface, which replaces the
old Pillow + UpdateLayeredWindow path entirely. Fading goes through
windowOpacity (the SourceConstantAlpha analog).

Thread-safety: public methods only emit a signal; Qt delivers it on the
main thread (queued connection), so the widget is never touched from the
recorder, hook, or pipeline threads.
"""

import math
import time

from PySide6.QtCore import (QPointF, QPropertyAnimation, QRectF, Qt, QTimer,
                            Signal)
from PySide6.QtGui import (QColor, QFont, QFontMetrics, QImage, QPainter,
                           QPen)
from PySide6.QtWidgets import QApplication, QWidget

from theme import ACCENT, AMBER, BASE, GREEN, RED, SURFACE1, TEXT

# Design measures in logical pixels (Qt scales for DPI on its own).
PILL_H = 44
PAD_X = 16
GAP = 10
ICON = 20               # icon box size
BARS_W = 32             # width of the level-bars block
BAR_W = 4
BAR_GAP = 3
BAR_MIN = 5
BAR_MAX = 22
BOTTOM_MARGIN = 80

BAR_TICK_MS = 33
SPIN_TICK_MS = 60
SPIN_FRAMES = 12
FADE_MS = 100
TARGET_ALPHA = 0.96
FONT_PX = 15            # ~11pt Segoe UI at 96 dpi


class Overlay(QWidget):
    """A hidden-by-default, focus-less, click-through status pill."""

    _command = Signal(str, object)

    def __init__(self, level_getter=None):
        super().__init__(None, Qt.FramelessWindowHint | Qt.Tool
                         | Qt.WindowStaysOnTopHint
                         | Qt.WindowTransparentForInput
                         | Qt.WindowDoesNotAcceptFocus)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)

        self._level = level_getter or (lambda: 0.0)
        self._generation = 0
        self._state = None

        self._font = QFont("Segoe UI")
        self._font.setPixelSize(FONT_PX)
        # Grayscale AA, not ClearType: subpixel fringes assume an opaque
        # background, and this window composites over arbitrary content.
        self._font.setStyleStrategy(QFont.NoSubpixelAntialias)
        self._metrics = QFontMetrics(self._font)

        # Current layout, repainted each animation tick.
        self._text = ""
        self._text_img = None
        self._text_color = TEXT
        self._mode = "none"      # "bars" | "spinner" | "check" | "alert" | "warn"
        self._locked = False     # hands-free: accent bars + label
        self._spin_index = 0
        self._bar_heights = [BAR_MIN] * 5
        self._t0 = time.monotonic()

        self._anim = QTimer(self)          # bars/spinner ticks
        self._anim_slot = None             # currently connected tick slot
        self._fade = QPropertyAnimation(self, b"windowOpacity", self)
        self._fade.setDuration(FADE_MS)

        # Cross-thread funnel: emits arrive on the Qt main thread.
        self._command.connect(self._handle)

    # --- Public, thread-safe API ------------------------------------------

    def show_recording(self, locked: bool = False):
        """Show the pill with live microphone level bars.

        locked=True marks hands-free mode: accent bars plus a
        "tap to finish" label, so the double-tap visibly registered.
        """
        self._command.emit("recording", locked)

    def show_transcribing(self):
        """Show the pill with a spinner (escalates to text if it drags on)."""
        self._command.emit("transcribing", None)

    def show_message(self, text: str, duration_ms: int = 2500,
                     error: bool = False, warn: bool = False):
        """Show a transient message that auto-hides after duration_ms.

        error draws a red alert and red text; warn an amber one — for
        notices that aren't failures (too short, canceled, can't paste).
        """
        self._command.emit("message", (text, duration_ms, error, warn))

    def hide_pill(self):
        """Withdraw the pill."""
        self._command.emit("hide", None)

    # Back-compat alias: callers know the pill as overlay.hide().
    hide = hide_pill

    # --- Main-thread state machine ------------------------------------------

    def _handle(self, cmd, payload):
        # Bumping the generation orphans every pending single-shot (auto-hide,
        # escalation) — their gen guard makes a stale fire a no-op, so no
        # timer bookkeeping is needed.
        self._generation += 1
        self._anim.stop()
        if self._anim_slot is not None:
            self._anim.timeout.disconnect(self._anim_slot)
            self._anim_slot = None

        if cmd == "recording":
            self._state = "recording"
            self._locked = bool(payload)
            self._layout("Hands-free · tap to finish" if payload else None,
                         TEXT, mode="bars")
            self._present()
            self._start_anim(self._tick_bars, BAR_TICK_MS)
        elif cmd == "transcribing":
            self._state = "transcribing"
            self._layout(None, TEXT, mode="spinner")
            self._present()
            self._start_anim(self._tick_spinner, SPIN_TICK_MS)
            # If it drags on, say so — an unchanging spinner reads as hung.
            gen = self._generation
            QTimer.singleShot(4000, self, lambda: self._escalate(gen))
        elif cmd == "message":
            text, duration_ms, error, warn = payload
            self._state = "message"
            color = RED if error else (AMBER if warn else TEXT)
            mode = "alert" if error else ("warn" if warn else "check")
            self._layout(text, color, mode=mode)
            self._present()
            gen = self._generation
            QTimer.singleShot(duration_ms, self,
                              lambda: self._auto_hide(gen))
        elif cmd == "hide":
            self._state = None
            super().hide()

    def _start_anim(self, slot, interval_ms):
        self._anim_slot = slot
        self._anim.timeout.connect(slot)
        self._anim.start(interval_ms)

    def _layout(self, text, text_color, mode):
        """Size the pill; text=None gives a compact animation-only capsule."""
        lead = BARS_W if mode == "bars" else ICON
        if text:
            text = self._ellipsize(text)
            width = PAD_X + lead + GAP + self._metrics.horizontalAdvance(
                text) + PAD_X
            width = int(math.ceil(width / 8.0)) * 8
        else:
            text = ""
            width = PAD_X + lead + PAD_X  # symmetric: content stays centered

        self._text = text
        self._text_color = text_color
        self._mode = mode
        self._render_text()
        self.setFixedSize(width, PILL_H)

    def _render_text(self):
        """Pre-render the label into an alpha QImage, once per state change.

        Painting text straight onto the translucent window gets ClearType
        subpixel AA (colored fringes that assume an opaque background);
        Qt's raster engine on an alpha QImage antialiases in grayscale,
        matching the old Pillow rendering. Caching it also keeps the
        33 ms bar ticks from re-shaping glyphs.
        """
        if not self._text:
            self._text_img = None
            return
        ratio = self.devicePixelRatioF()
        w = self._metrics.horizontalAdvance(self._text) + 2
        h = self._metrics.height()
        img = QImage(int(w * ratio), int(h * ratio),
                     QImage.Format_ARGB32_Premultiplied)
        img.setDevicePixelRatio(ratio)
        img.fill(0)
        p = QPainter(img)
        p.setFont(self._font)
        p.setPen(QColor(self._text_color))
        p.drawText(0, self._metrics.ascent(), self._text)
        p.end()
        self._text_img = img

    def _ellipsize(self, text):
        text = " ".join(text.split())  # collapse newlines/runs of whitespace
        screen = self.screen() or QApplication.primaryScreen()
        max_text = int(screen.geometry().width() * 0.6) - (
            PAD_X + ICON + GAP + PAD_X)
        return self._metrics.elidedText(text, Qt.ElideRight, max_text)

    def _present(self):
        """Position bottom-center and show, fading in from hidden."""
        screen = QApplication.primaryScreen().geometry()
        self.move(screen.x() + (screen.width() - self.width()) // 2,
                  screen.y() + screen.height() - PILL_H - BOTTOM_MARGIN)
        self._fade.stop()
        if not self.isVisible():
            # Content is laid out before the window maps, so the first
            # visible frame is already the new state (no stale flash).
            self.setWindowOpacity(0.0)
            self.show()
            self._fade.setStartValue(0.0)
            self._fade.setEndValue(TARGET_ALPHA)
            self._fade.start()
        else:
            self.setWindowOpacity(TARGET_ALPHA)
            self.update()

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
        self.update()

    def _tick_spinner(self):
        self._spin_index = (self._spin_index + 1) % SPIN_FRAMES
        self.update()

    def _escalate(self, gen):
        """Add 'Still transcribing…' to a spinner that has run 4+ seconds."""
        if gen != self._generation or self._state != "transcribing":
            return
        self._layout("Still transcribing…", TEXT, mode="spinner")
        self._present()

    def _auto_hide(self, gen):
        if gen == self._generation:
            self._state = None
            super().hide()

    # --- Painting -------------------------------------------------------------

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)

        # Capsule: BASE fill, hairline SURFACE1 border.
        p.setBrush(QColor(BASE))
        p.setPen(QPen(QColor(SURFACE1), 1))
        r = self.rect().adjusted(0, 0, -1, -1)
        p.drawRoundedRect(r, r.height() / 2, r.height() / 2)

        cy = PILL_H / 2
        if self._mode == "bars":
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(ACCENT if self._locked else RED))
            for i, bh in enumerate(self._bar_heights):
                x = PAD_X + i * (BAR_W + BAR_GAP)
                p.drawRoundedRect(QRectF(x, cy - bh / 2, BAR_W, bh),
                                  BAR_W / 2, BAR_W / 2)
        elif self._mode == "spinner":
            self._draw_spinner(p)
        elif self._mode == "check":
            self._draw_check(p)
        elif self._mode == "alert":
            self._draw_alert(p, QColor(RED))
        elif self._mode == "warn":
            self._draw_alert(p, QColor(AMBER))

        if self._text and self._text_img is not None:
            lead = BARS_W if self._mode == "bars" else ICON
            y = (PILL_H - self._text_img.height()
                 / self._text_img.devicePixelRatio()) / 2
            p.drawImage(QPointF(PAD_X + lead + GAP, y), self._text_img)

    # Icon painters draw into the 20px icon box.

    def _icon_box(self):
        return PAD_X, (PILL_H - ICON) / 2, ICON

    def _draw_spinner(self, p):
        x0, y0, px = self._icon_box()
        m = 0.10 * px
        start = -(self._spin_index / SPIN_FRAMES) * 360.0
        p.setPen(QPen(QColor(ACCENT), 0.12 * px, Qt.SolidLine, Qt.RoundCap))
        p.setBrush(Qt.NoBrush)
        # Qt angles are in 1/16 degree, counterclockwise-positive.
        p.drawArc(QRectF(x0 + m, y0 + m, px - 2 * m, px - 2 * m),
                  int(start * 16), int(-270 * 16))

    def _draw_check(self, p):
        x0, y0, px = self._icon_box()
        p.setPen(QPen(QColor(GREEN), 0.13 * px, Qt.SolidLine, Qt.RoundCap,
                      Qt.RoundJoin))
        p.setBrush(Qt.NoBrush)
        p.drawPolyline([QPointF(x0 + fx * px, y0 + fy * px)
                        for fx, fy in ((0.18, 0.55), (0.42, 0.78),
                                       (0.84, 0.26))])

    def _draw_alert(self, p, color):
        x0, y0, px = self._icon_box()
        p.setPen(Qt.NoPen)
        p.setBrush(color)
        p.drawEllipse(QRectF(x0, y0, px, px))
        p.setBrush(QColor(BASE))
        bar_w = 0.10 * px
        cx = x0 + px / 2
        p.drawRoundedRect(QRectF(cx - bar_w, y0 + 0.22 * px,
                                 2 * bar_w, 0.36 * px), bar_w, bar_w)
        r = 0.07 * px
        p.drawEllipse(QRectF(cx - r, y0 + 0.70 * px, 2 * r, 2 * r))
