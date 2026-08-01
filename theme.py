"""Undertone's One-Dark-derived slate palette — the single source of
truth, shared by ui.py, overlay.py, and settingsui.py so the rendering
stacks can never drift apart. (Qt handles DPI on its own; all design
measures elsewhere are logical pixels.)
"""

BASE = "#282c34"
MANTLE = "#21252c"
CARD = "#333842"         # +5 lightness points from BASE
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
