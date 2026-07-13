"""Undertone's One-Dark-derived slate palette and display scaling — the
single source of truth, shared by ui.py and overlay.py so the rendering
stacks can never drift apart.

DPI: main.py calls init_dpi() before the Tk root exists; after that sc()
converts 96-dpi design pixels to real screen pixels (point-sized Tk fonts
scale on their own once the process is DPI-aware).
"""

import ctypes

BASE = "#282c34"
MANTLE = "#21252c"
CARD = "#333842"         # +5 lightness points from BASE
CARD_HOVER = "#373d48"
SURFACE0 = "#3b414d"     # +8 lightness points from BASE
SURFACE1 = "#49515f"     # +14 lightness points from BASE
CARD_BORDER = "#3f4652"
ROW_HOVER = "#252a32"    # one elevation step above MANTLE
NAV_HOVER = "#252931"    # between MANTLE and BASE
BANNER_BG = "#263b4d"    # accent-tinted callout panel
BANNER_BORDER = "#3c6688"
TEXT = "#d7dae0"
SUBTEXT = "#9da5b4"
MUTED = "#798294"
ACCENT = "#61afef"
ACCENT_HOVER = "#74b9f1"
ACCENT_DOWN = "#4b9ddd"
RED = "#e06c75"
AMBER = "#e5c07b"
GREEN = "#98c379"
INK = "#17212b"          # dark slate ink used on accent-filled surfaces

_scale = None


def init_dpi():
    """Opt into system-DPI awareness (crisp text on scaled displays).

    Must run before the Tk root is created and before the first sc() call.
    """
    global _scale
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(1)  # system DPI aware
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    _scale = None  # recompute now that the process sees the real DPI


def scale() -> float:
    """Screen DPI / 96, computed once (1.0 when the process isn't DPI-aware)."""
    global _scale
    if _scale is None:
        try:
            hdc = ctypes.windll.user32.GetDC(0)
            _scale = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88) / 96.0  # LOGPIXELSX
            ctypes.windll.user32.ReleaseDC(0, hdc)
        except Exception:
            _scale = 1.0
    return _scale


def sc(px: float) -> int:
    """Scale a 96-dpi design pixel measure to actual screen pixels."""
    return int(round(px * scale()))
