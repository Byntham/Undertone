"""Undertone's palette (Catppuccin Mocha) and display scaling — the single
source of truth, shared by ui.py and overlay.py so the rendering stacks can
never drift apart.

DPI: main.py calls init_dpi() before the Tk root exists; after that sc()
converts 96-dpi design pixels to real screen pixels (point-sized Tk fonts
scale on their own once the process is DPI-aware).
"""

import ctypes

BASE = "#1e1e2e"
MANTLE = "#181825"
SURFACE0 = "#313244"
SURFACE1 = "#45475a"
CARD = "#272839"         # elevated setting-card surface (between BASE and SURFACE0)
CARD_BORDER = "#333449"
BANNER_BG = "#2f364f"    # accent-tinted callout panel
BANNER_BORDER = "#495a80"
TEXT = "#cdd6f4"
SUBTEXT = "#a6adc8"
MUTED = "#7f849c"
ACCENT = "#89b4fa"
ACCENT_HOVER = "#9dc0fc"
ACCENT_DOWN = "#74a0e8"
RED = "#f38ba8"
AMBER = "#f9e2af"
GREEN = "#a6e3a1"
INK = "#11111b"          # dark ink used on accent-filled surfaces

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
