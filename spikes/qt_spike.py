"""PySide6 spike for the Qt migration decision (throwaway, not wired in).

Builds a settings-shaped window in Undertone's One-Dark ladder — sidebar,
cards, a 200-row list — plus a translucent overlay pill and a tray icon,
then measures a resize storm the way tests/perf_settingsui.py does
(<18ms/step is the canvasui gate) and saves screenshots for judgment.

Run from the repo root with the Qt venv:
    .venv-qt\\Scripts\\python.exe spikes\\qt_spike.py
"""

import ctypes
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import theme

from PySide6 import __version__ as PYSIDE_VERSION
from PySide6.QtCore import Qt, QStringListModel, QTimer
from PySide6.QtGui import QColor, QFont, QIcon, QImage, QPainter, QPalette
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QComboBox, QFrame, QHBoxLayout, QLabel,
    QLineEdit, QListView, QPushButton, QScrollArea, QSystemTrayIcon,
    QVBoxLayout, QWidget,
)

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")

QSS = f"""
QWidget {{ font-family: "Segoe UI"; font-size: 10pt; color: {theme.TEXT}; }}
QFrame#sidebar {{ background: {theme.MANTLE}; }}
QLabel#navItem {{ color: {theme.SUBTEXT}; padding: 6px 14px; }}
QLabel#navActive {{
    color: {theme.TEXT}; padding: 6px 14px;
    background: {theme.NAV_HOVER}; border-radius: 6px;
}}
QScrollArea {{ background: {theme.BASE}; border: none; }}
QWidget#content {{ background: {theme.BASE}; }}
QFrame.card {{
    background: {theme.CARD};
    border: 1px solid {theme.CARD_BORDER};
    border-radius: 10px;
}}
QFrame#banner {{
    background: {theme.BANNER_BG};
    border: 1px solid {theme.BANNER_BORDER};
    border-radius: 10px;
}}
QLabel.cardTitle {{ font-size: 11pt; font-weight: 600; background: transparent; }}
QLabel.hint {{ color: {theme.SUBTEXT}; background: transparent; }}
QLineEdit, QComboBox {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 6px; padding: 5px 8px;
    selection-background-color: {theme.ACCENT}; selection-color: {theme.INK};
}}
QLineEdit:focus, QComboBox:focus {{ border-color: {theme.ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox QAbstractItemView {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    selection-background-color: {theme.ACCENT}; selection-color: {theme.INK};
}}
QPushButton {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 14px; padding: 5px 16px;
}}
QPushButton:hover {{ background: {theme.SURFACE1}; }}
QPushButton#primary {{
    background: {theme.ACCENT}; color: {theme.INK};
    border: none; font-weight: 600;
}}
QPushButton#primary:hover {{ background: {theme.ACCENT_HOVER}; }}
QCheckBox {{ background: transparent; spacing: 8px; }}
QListView {{
    background: {theme.MANTLE}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 8px; padding: 4px;
}}
QListView::item {{ padding: 5px 8px; border-radius: 4px; }}
QListView::item:hover {{ background: {theme.ROW_HOVER}; }}
QListView::item:selected {{ background: {theme.SURFACE0}; color: {theme.TEXT}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; }}
QScrollBar::handle:vertical {{
    background: {theme.SURFACE1}; border-radius: 5px; min-height: 30px;
}}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; }}
"""


def dark_palette() -> QPalette:
    p = QPalette()
    roles = {
        QPalette.Window: theme.BASE, QPalette.WindowText: theme.TEXT,
        QPalette.Base: theme.SURFACE0, QPalette.Text: theme.TEXT,
        QPalette.Button: theme.SURFACE0, QPalette.ButtonText: theme.TEXT,
        QPalette.Highlight: theme.ACCENT, QPalette.HighlightedText: theme.INK,
        QPalette.ToolTipBase: theme.CARD, QPalette.ToolTipText: theme.TEXT,
        QPalette.PlaceholderText: theme.MUTED,
    }
    for role, hexcolor in roles.items():
        p.setColor(role, QColor(hexcolor))
    return p


def dark_titlebar(widget):
    """DWMWA_USE_IMMERSIVE_DARK_MODE on a private WinDLL instance (never
    prototype the shared ctypes.windll cache — see AGENTS.md)."""
    dwm = ctypes.WinDLL("dwmapi")
    value = ctypes.c_int(1)
    dwm.DwmSetWindowAttribute(int(widget.winId()), 20,
                              ctypes.byref(value), ctypes.sizeof(value))


def card(title: str) -> "tuple[QFrame, QVBoxLayout]":
    frame = QFrame()
    frame.setProperty("class", "card")
    lay = QVBoxLayout(frame)
    lay.setContentsMargins(16, 12, 16, 14)
    lay.setSpacing(8)
    label = QLabel(title)
    label.setProperty("class", "cardTitle")
    lay.addWidget(label)
    return frame, lay


def row(label: str, control) -> QWidget:
    w = QWidget()
    w.setStyleSheet("background: transparent")
    lay = QHBoxLayout(w)
    lay.setContentsMargins(0, 0, 0, 0)
    lay.addWidget(QLabel(label))
    lay.addStretch(1)
    lay.addWidget(control)
    return w


def build_settings_window() -> QWidget:
    win = QWidget()
    win.setWindowTitle("Undertone — Qt spike")
    win.setWindowIcon(QIcon("assets/icon.ico"))
    outer = QHBoxLayout(win)
    outer.setContentsMargins(0, 0, 0, 0)
    outer.setSpacing(0)

    sidebar = QFrame(objectName="sidebar")
    sidebar.setFixedWidth(190)
    nav = QVBoxLayout(sidebar)
    nav.setContentsMargins(10, 14, 10, 14)
    nav.setSpacing(2)
    for i, name in enumerate(["General", "Providers", "Formatting",
                              "Dictionary", "History", "About"]):
        item = QLabel(name, objectName="navActive" if i == 0 else "navItem")
        nav.addWidget(item)
    nav.addStretch(1)
    outer.addWidget(sidebar)

    scroll = QScrollArea(widgetResizable=True)
    content = QWidget(objectName="content")
    col = QVBoxLayout(content)
    col.setContentsMargins(22, 18, 22, 18)
    col.setSpacing(14)

    banner = QFrame(objectName="banner")
    blay = QVBoxLayout(banner)
    blay.setContentsMargins(16, 10, 16, 10)
    hint = QLabel("Get started — pick a provider, add its API key, and "
                  "hold Right Ctrl to dictate.")
    hint.setProperty("class", "hint")
    hint.setWordWrap(True)
    blay.addWidget(hint)
    col.addWidget(banner)

    general, glay = card("General")
    combo = QComboBox()
    combo.addItems(["Right Ctrl", "Right Alt", "F13", "Pause"])
    glay.addWidget(row("Push-to-talk key", combo))
    edit = QLineEdit("ctrl+alt+v")
    edit.setFixedWidth(160)
    glay.addWidget(row("Re-paste shortcut", edit))
    for text, on in [("Smart formatting", True), ("AI cleanup", True),
                     ("Sound cues", False)]:
        box = QCheckBox(text)
        box.setChecked(on)
        glay.addWidget(box)
    col.addWidget(general)

    providers, play = card("Providers")
    prov = QComboBox()
    prov.addItems(["xAI", "OpenAI", "OpenRouter", "Local (on-device)"])
    play.addWidget(row("Transcription", prov))
    key = QLineEdit()
    key.setEchoMode(QLineEdit.Password)
    key.setPlaceholderText("API key")
    play.addWidget(row("xAI API key", key))
    buttons = QWidget()
    buttons.setStyleSheet("background: transparent")
    hb = QHBoxLayout(buttons)
    hb.setContentsMargins(0, 4, 0, 0)
    hb.addStretch(1)
    hb.addWidget(QPushButton("Test key"))
    hb.addWidget(QPushButton("Save", objectName="primary"))
    play.addWidget(buttons)
    col.addWidget(providers)

    dictionary, dlay = card("Dictionary — 200 rows (virtualized)")
    listview = QListView()
    listview.setModel(QStringListModel(
        [f"misheard phrase {i}  →  corrected term {i}" for i in range(200)]))
    listview.setMinimumHeight(220)
    dlay.addWidget(listview)
    col.addWidget(dictionary)

    col.addStretch(1)
    scroll.setWidget(content)
    outer.addWidget(scroll, 1)
    win.resize(860, 640)
    return win


class Pill(QWidget):
    """Frameless, per-pixel-alpha overlay pill — the layered-window analog."""

    def __init__(self):
        super().__init__(None, Qt.FramelessWindowHint | Qt.Tool
                         | Qt.WindowStaysOnTopHint)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setAttribute(Qt.WA_ShowWithoutActivating)
        self.resize(280, 48)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        bg = QColor(theme.MANTLE)
        bg.setAlpha(242)
        p.setBrush(bg)
        p.setPen(QColor(theme.CARD_BORDER))
        p.drawRoundedRect(self.rect().adjusted(1, 1, -2, -2), 23, 23)
        p.setPen(QColor(theme.ACCENT))
        for i in range(5):  # the recording-bars motif
            x, h = 18 + i * 7, (10, 18, 26, 16, 12)[i]
            p.fillRect(x, 24 - h // 2, 4, h, QColor(theme.ACCENT))
        p.setPen(QColor(theme.TEXT))
        p.setFont(QFont("Segoe UI", 10))
        p.drawText(self.rect().adjusted(62, 0, -14, 0),
                   Qt.AlignVCenter | Qt.AlignLeft, "Pasted · hello world…")


def resize_storm(win) -> dict:
    """Per-step resize cost, tests/perf_settingsui.py style: 20px steps
    across a 400px range and back, synchronous paint each step."""
    QApplication.processEvents()
    h, times = win.height(), []
    widths = list(range(760, 1161, 20)) + list(range(1160, 759, -20))
    for w in widths:
        t0 = time.perf_counter()
        win.resize(w, h)
        win.repaint()  # force the paint NOW; no async deferral flattery
        QApplication.processEvents()
        times.append((time.perf_counter() - t0) * 1000)
    times.sort()
    return {
        "steps": len(times),
        "median_ms": round(statistics.median(times), 2),
        "p95_ms": round(times[int(len(times) * 0.95)], 2),
        "max_ms": round(times[-1], 2),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    app = QApplication(sys.argv)
    app.setStyle("Fusion")
    app.setPalette(dark_palette())
    app.setStyleSheet(QSS)

    tray = QSystemTrayIcon(QIcon("assets/icon.ico"))
    tray.setToolTip("Undertone Qt spike")
    tray.show()

    win = build_settings_window()
    win.setAttribute(Qt.WA_ShowWithoutActivating)
    win.show()
    dark_titlebar(win)

    pill = Pill()
    pill.move(win.x() + 290, win.y() + win.height() + 40)
    pill.show()

    def run():
        stats = resize_storm(win)

        win.resize(760, 640)
        QApplication.processEvents()
        win.grab().save(os.path.join(OUT_DIR, "settings_min.png"))
        win.resize(1150, 700)
        QApplication.processEvents()
        win.grab().save(os.path.join(OUT_DIR, "settings_wide.png"))

        img = QImage(pill.size(), QImage.Format_ARGB32)
        img.fill(QColor(theme.BASE))  # pill composited over the app base
        pill.render(img)
        img.save(os.path.join(OUT_DIR, "pill.png"))

        print(json.dumps({
            "pyside": PYSIDE_VERSION,
            "device_pixel_ratio": win.devicePixelRatio(),
            "resize_storm": stats,
            "tray_available": QSystemTrayIcon.isSystemTrayAvailable(),
        }, indent=2))
        app.quit()

    QTimer.singleShot(600, run)  # let the first frame settle, then measure
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
