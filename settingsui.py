"""Qt settings window for Undertone.

Replaces the canvas-rendered settingsui.py: real widgets, QSS theming
from theme.py, live resize for free. Behavior contract is unchanged —
every field change autosaves through on_save (with the "✓ Saved" toast),
shortcut capture pauses the app's hooks via on_capture_start/end, and
worker threads (capture, key tests, local-STT actions) post back to the
main thread through signals.
"""

import io
import os
import re
import threading
import time
import wave
import webbrowser

import keyboard
import pyperclip

from PySide6.QtCore import (QEasingCurve, QObject, QRect, QRectF, Qt, QTimer,
                            QVariantAnimation, Signal)
from PySide6.QtGui import (QColor, QFontMetrics, QIcon, QPainter, QPixmap,
                           QGuiApplication)
from PySide6.QtWidgets import (
    QAbstractButton, QApplication, QComboBox, QFrame, QHBoxLayout, QLabel,
    QLineEdit, QPlainTextEdit, QPushButton, QScrollArea, QSizePolicy,
    QStackedWidget, QStyledItemDelegate, QVBoxLayout, QWidget)

import autostart
import localllm
import localstt
import theme
from config import APP_VERSION, CONFIG_PATH, DEFAULT_CONFIG, KEY_FIELDS
from ui import (ICON_ICO, LANGUAGES, PROVIDER_LINKS, PROVIDERS_UI,
                PROVIDER_BY_ID, SECTIONS, ALL_PROVIDERS_UI, _nav_glyph,
                load_app_image, pretty_combo)

WIN_W, WIN_H = 780, 724
MIN_W, MIN_H = 660, 560
SIDEBAR_W = 200

QSS = f"""
QWidget {{ font-family: "Segoe UI"; font-size: 10pt;
           color: {theme.TEXT}; }}
QWidget#settingsWindow {{ background: {theme.BASE}; }}
QLabel {{ background: transparent; }}
QLabel#heading {{ font-family: "Segoe UI Semibold"; font-size: 15pt; }}
QLabel#group {{ font-family: "Segoe UI Semibold"; font-size: 9pt;
                color: {theme.SUBTEXT}; }}
QLabel.cardTitle {{ font-family: "Segoe UI Semibold"; font-size: 10pt; }}
QLabel.hint {{ font-size: 9pt; color: {theme.MUTED}; }}
QFrame#card, QFrame#banner {{
    background: {theme.CARD}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 10px;
}}
QFrame#banner {{ background: {theme.BANNER_BG};
                 border-color: {theme.BANNER_BORDER}; }}
QFrame#card QLabel, QFrame#banner QLabel {{ background: transparent; }}
QFrame#listPanel {{ background: {theme.MANTLE};
                    border: 1px solid {theme.CARD_BORDER};
                    border-radius: 8px; }}
QWidget#listRow {{ background: transparent; border-radius: 6px; }}
QWidget#listRow[hover="true"] {{ background: {theme.ROW_HOVER}; }}
QLineEdit, QPlainTextEdit {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 6px; padding: 4px 8px;
    selection-background-color: {theme.ACCENT};
    selection-color: {theme.INK};
}}
QLineEdit:focus, QPlainTextEdit:focus {{ border-color: {theme.ACCENT}; }}
QComboBox {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 11px; padding: 4px 12px;
}}
QComboBox:focus {{ border-color: {theme.ACCENT}; }}
QComboBox::drop-down {{ border: none; width: 24px; }}
QComboBox::down-arrow {{ image: url(__CHEVRON__); width: 10px;
                         height: 6px; }}
QPushButton {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 11px; padding: 4px 14px; font-size: 9pt;
}}
QPushButton:hover {{ background: {theme.SURFACE1}; }}
QPushButton:disabled {{ color: {theme.MUTED}; }}
QPushButton[variant="accent"] {{
    background: {theme.ACCENT}; color: {theme.INK};
    border: 1px solid transparent;  /* same height as bordered neutrals —
        Qt DROPS a radius exceeding height/2 (24px tall borderless accents
        rendered square while 26px neutrals were pills) */
    border-radius: 11px;
    font-family: "Segoe UI Semibold";
}}
QPushButton[variant="accent"]:hover {{ background: {theme.ACCENT_HOVER}; }}
QPushButton[variant="accent"]:pressed {{ background: {theme.ACCENT_DOWN}; }}
QPushButton[variant="accent"]:disabled {{
    background: {theme.SURFACE1}; color: {theme.MUTED}; }}
QLabel#chip {{
    background: {theme.SURFACE0}; border: 1px solid {theme.CARD_BORDER};
    border-radius: 10px; padding: 3px 12px; font-size: 9pt;
}}
QScrollArea {{ border: none; background: {theme.BASE}; }}
QScrollArea > QWidget {{ background: {theme.BASE}; }}
QScrollArea#panelScroll,
QScrollArea#panelScroll > QWidget {{ background: transparent; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0; }}
QScrollBar::handle:vertical {{
    background: {theme.SURFACE1}; border-radius: 5px; min-height: 30px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
    background: transparent; }}
"""


def _chevron_url():
    """A theme-colored dropdown chevron QSS can point at (QSS image: needs
    a file; drawn once into %TEMP%)."""
    import tempfile
    path = os.path.join(tempfile.gettempdir(), "undertone_chevron.png")
    from PySide6.QtCore import QPoint
    from PySide6.QtGui import QImage, QPen
    img = QImage(20, 12, QImage.Format_ARGB32_Premultiplied)
    img.fill(0)
    p = QPainter(img)
    p.setRenderHint(QPainter.Antialiasing)
    p.setPen(QPen(QColor(theme.SUBTEXT), 2))
    p.drawPolyline([QPoint(3, 3), QPoint(10, 9), QPoint(17, 3)])
    p.end()
    img.save(path)
    return path.replace("\\", "/")


def _pil_pixmap(pil_img) -> QPixmap:
    buf = io.BytesIO()
    pil_img.save(buf, "PNG")
    pixmap = QPixmap()
    pixmap.loadFromData(buf.getvalue(), "PNG")
    return pixmap


def _dark_titlebar(widget):
    import ctypes
    dwm = ctypes.WinDLL("dwmapi")
    value = ctypes.c_int(1)
    dwm.DwmSetWindowAttribute(int(widget.winId()), 20,
                              ctypes.byref(value), ctypes.sizeof(value))


def _ellipsize(text, limit=24):
    return text if len(text) <= limit else text[:limit - 1] + "…"


# --- Small building blocks ---------------------------------------------------

class Toggle(QAbstractButton):
    """Painted on/off switch (accent track when on); the knob slides and
    the colors cross-fade along an animated 0..1 progress."""

    def __init__(self, on=False, on_change=None):
        super().__init__()
        self.setCheckable(True)
        self.setChecked(bool(on))
        self.setCursor(Qt.PointingHandCursor)
        self.setFixedSize(40, 22)
        self.on_change = on_change
        self._block = False
        self._pos = 1.0 if on else 0.0
        self._anim = QVariantAnimation(self)
        self._anim.setDuration(140)
        self._anim.setEasingCurve(QEasingCurve.OutCubic)
        self._anim.valueChanged.connect(self._step)
        self.toggled.connect(self._changed)

    def set(self, on):
        self._block = True
        self.setChecked(bool(on))
        self._block = False

    def _changed(self, on):
        self._anim.stop()
        self._anim.setStartValue(self._pos)
        self._anim.setEndValue(1.0 if on else 0.0)
        self._anim.start()
        if not self._block and self.on_change is not None:
            self.on_change(bool(on))

    def _step(self, value):
        self._pos = value
        self.update()

    @staticmethod
    def _blend(color_a, color_b, t):
        a, b = QColor(color_a), QColor(color_b)
        return QColor(round(a.red() + (b.red() - a.red()) * t),
                      round(a.green() + (b.green() - a.green()) * t),
                      round(a.blue() + (b.blue() - a.blue()) * t))

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        t = self._pos
        p.setPen(Qt.NoPen)
        p.setBrush(self._blend(theme.SURFACE1, theme.ACCENT, t))
        p.drawRoundedRect(0, 0, 40, 22, 11, 11)
        p.setBrush(self._blend(theme.TEXT, theme.INK, t))
        p.drawEllipse(QRectF(2 + 18 * t, 2, 18, 18))


# The popup is a top-level window, out of reach of the main QSS — the
# theme never made it there (it rendered unstyled Fusion gray). It is
# OPAQUE by design: a translucent popup left unpainted container strips
# showing whatever lay behind it. Rounding comes from DWM, not QSS.
POPUP_QSS = f"""
QWidget#comboPopup {{ background: {theme.SURFACE0};
                      border: 1px solid {theme.CARD_BORDER}; }}
QListView {{
    background: {theme.SURFACE0}; border: none; padding: 4px; outline: 0;
}}
QListView::item {{
    background: transparent; color: {theme.TEXT};
    padding: 3px 8px; border-radius: 4px; min-height: 20px;
}}
QListView::item:hover {{ background: {theme.SURFACE1}; }}
QListView::item:selected {{ background: {theme.ACCENT};
                            color: {theme.INK}; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 0;
                       border: none; }}
QScrollBar::handle:vertical {{ background: {theme.SURFACE1};
                               border-radius: 5px; min-height: 24px; }}
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{
    background: transparent; }}
"""


def _round_corners(widget):
    """Win11 DWM corner rounding for a top-level widget (no-op on Win10)."""
    import ctypes
    dwm = ctypes.WinDLL("dwmapi")   # private instance per AGENTS.md rule
    pref = ctypes.c_int(3)          # DWMWCP_ROUNDSMALL
    dwm.DwmSetWindowAttribute(int(widget.winId()), 33,   # CORNER_PREFERENCE
                              ctypes.byref(pref), ctypes.sizeof(pref))


class Combo(QComboBox):
    """Themed drop-down. Three things need code, not just QSS: wheel events
    are ignored (scrolling the page over a combo must not change the
    setting), ::item hover/selected styling requires a styled delegate,
    and the popup gets its theme from POPUP_QSS and its rounded corners
    from DWM."""

    def __init__(self):
        super().__init__()
        self.setCursor(Qt.PointingHandCursor)
        self.setItemDelegate(QStyledItemDelegate(self))
        # Stock combo popups ship ScrollBarAlwaysOff and hard-clip lists
        # taller than the screen; show the (themed) scrollbar instead.
        self.view().setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        popup = self.view().window()
        popup.setObjectName("comboPopup")
        popup.setStyleSheet(POPUP_QSS)
        self._popup_rounded = False

    def showPopup(self):
        super().showPopup()
        if not self._popup_rounded:
            self._popup_rounded = True
            try:
                _round_corners(self.view().window())
            except OSError:
                pass

    def wheelEvent(self, event):
        event.ignore()  # let the section scroll instead


def pill_button(text, variant="neutral", on_click=None):
    button = QPushButton(text)
    button.setProperty("variant", variant)
    button.setCursor(Qt.PointingHandCursor)
    if on_click is not None:
        button.clicked.connect(lambda _=False: on_click())
    return button


def hint_label(text, color=None, wrap=True):
    label = QLabel(text)
    label.setProperty("class", "hint")
    label.setWordWrap(wrap)
    if color:
        label.setStyleSheet(f"color: {color}; font-size: 9pt;")
    return label


def link_label(text, on_click):
    label = QLabel(f'<a href="#" style="color:{theme.ACCENT};'
                   f'text-decoration:none">{text}</a>')
    label.setProperty("class", "hint")
    label.setTextInteractionFlags(Qt.LinksAccessibleByMouse)
    label.linkActivated.connect(lambda _href: on_click())
    return label


def card(inner_margins=(16, 12, 16, 12), object_name="card"):
    frame = QFrame(objectName=object_name)
    lay = QVBoxLayout(frame)
    lay.setContentsMargins(*inner_margins)
    lay.setSpacing(2)
    return frame, lay


def row_card(title, hint, control=None, object_name="card"):
    """Card with title+hint on the left, a control on the right."""
    frame = QFrame(objectName=object_name)
    outer = QHBoxLayout(frame)
    outer.setContentsMargins(16, 12, 16, 12)
    text_col = QVBoxLayout()
    text_col.setSpacing(2)
    title_label = QLabel(title)
    title_label.setProperty("class", "cardTitle")
    text_col.addWidget(title_label)
    if hint:
        text_col.addWidget(hint_label(hint))
    outer.addLayout(text_col, 1)
    if control is not None:
        outer.addWidget(control, 0, Qt.AlignVCenter)
    return frame


class Meter(QWidget):
    """Rounded level meter (accent fill over a SURFACE0 track)."""

    def __init__(self, width=200):
        super().__init__()
        self.setFixedSize(width, 10)
        self.level = 0.0

    def set_level(self, level):
        level = max(0.0, min(1.0, float(level)))
        if level != self.level:
            self.level = level
            self.update()

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(theme.SURFACE0))
        p.drawRoundedRect(0, 0, self.width(), 10, 5, 5)
        filled = round(self.width() * self.level)
        if filled > 2:
            p.setBrush(QColor(theme.ACCENT))
            p.drawRoundedRect(0, 0, filled, 10, 5, 5)


class NavItem(QAbstractButton):
    """Sidebar entry: accent bar + glyph + label, hover/active states."""

    def __init__(self, section, on_select):
        super().__init__()
        self.section = section
        self.setFixedHeight(40)
        self.setCursor(Qt.PointingHandCursor)
        self.active = False
        self._hover = False
        self._pixmaps = {
            color: _pil_pixmap(_nav_glyph(section, color, 17))
            for color in (theme.SUBTEXT, theme.ACCENT)}
        self.clicked.connect(lambda _=False: on_select(section))

    def set_active(self, active):
        if self.active != active:
            self.active = active
            self.update()

    def enterEvent(self, event):
        self._hover = True
        self.update()

    def leaveEvent(self, event):
        self._hover = False
        self.update()

    def paintEvent(self, _event):
        p = QPainter(self)
        if self.active:
            p.fillRect(self.rect(), QColor(theme.SURFACE0))
            p.fillRect(0, 0, 3, self.height(), QColor(theme.ACCENT))
        elif self._hover:
            p.fillRect(self.rect(), QColor(theme.NAV_HOVER))
        else:
            p.fillRect(self.rect(), QColor(theme.MANTLE))
        pixmap = self._pixmaps[theme.ACCENT if self.active else theme.SUBTEXT]
        p.drawPixmap(18, (self.height() - 17) // 2, pixmap)
        font = self.font()
        font.setPointSize(10)
        font.setFamily("Segoe UI Semibold" if self.active else "Segoe UI")
        p.setFont(font)
        p.setPen(QColor(theme.TEXT if self.active else theme.SUBTEXT))
        p.drawText(self.rect().adjusted(46, 0, -4, 0),
                   Qt.AlignVCenter | Qt.AlignLeft, self.section)


class ListRow(QWidget):
    """Hoverable MANTLE row used by dictionary/history list panels."""

    def __init__(self):
        super().__init__(objectName="listRow")
        self.setAttribute(Qt.WA_StyledBackground, True)

    def _set_hover(self, on):
        self.setProperty("hover", "true" if on else "false")
        self.style().unpolish(self)
        self.style().polish(self)

    def enterEvent(self, event):
        self._set_hover(True)

    def leaveEvent(self, event):
        self._set_hover(False)


ROW_H = 32


def list_panel(rows_visible=None):
    """MANTLE-backed rounded panel holding a scrollable column of rows.

    rows_visible fixes the height to that many whole rows, so the panel
    never cuts a row in half at rest (the old ListView clipped partial
    rows for the same reason)."""
    panel = QFrame(objectName="listPanel")
    outer = QVBoxLayout(panel)
    outer.setContentsMargins(1, 2, 1, 2)
    # Everything inside the panel stays transparent so the panel's own
    # rounded MANTLE face is the only backdrop — a square-cornered child
    # would paint over the rounded border at the corners. Transparency
    # comes from the window QSS (#panelScroll; plain wrapper widgets are
    # unpainted since no generic background rule exists), NEVER a local
    # setStyleSheet: a local sheet on any ancestor silently disables
    # attribute-selector rules ([hover="true"], [variant="accent"]) for
    # every widget beneath it.
    scroll = QScrollArea(widgetResizable=True, objectName="panelScroll")
    scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
    inner = QWidget()
    column = QVBoxLayout(inner)
    column.setContentsMargins(0, 0, 0, 0)
    column.setSpacing(0)
    column.addStretch(1)
    scroll.setWidget(inner)
    inner.setAutoFillBackground(False)  # setWidget() flips it on
    outer.addWidget(scroll)
    if rows_visible:
        panel.setFixedHeight(ROW_H * rows_visible + 6)
    return panel, column


def clear_rows(column):
    while column.count() > 1:  # keep the trailing stretch
        item = column.takeAt(0)
        if item.widget() is not None:
            item.widget().deleteLater()


def empty_row(text):
    row = ListRow()
    lay = QHBoxLayout(row)
    lay.setContentsMargins(10, 8, 10, 8)
    lay.addWidget(hint_label(text))
    return row


class ElideLabel(QLabel):
    """Single-line label elided at paint time — never demands width, so
    it can't push its row's trailing buttons out of the panel."""

    def __init__(self, text, color):
        super().__init__()
        self._full = " ".join(text.split())
        self._color = QColor(color)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.setMinimumHeight(self.fontMetrics().height())

    def paintEvent(self, _event):
        p = QPainter(self)
        p.setPen(self._color)
        p.setFont(self.font())
        p.drawText(self.rect(), Qt.AlignVCenter | Qt.AlignLeft,
                   self.fontMetrics().elidedText(
                       self._full, Qt.ElideRight, self.width()))


# --- The window ----------------------------------------------------------------

class SettingsWindow(QObject):
    """The Qt settings window; construct once, open() to show."""

    _captured = Signal(object)
    _tested = Signal(object)
    _local_progress_sig = Signal(object)   # (engine, text)
    _local_done_sig = Signal(object)       # (engine, action, ok, message)

    # The two on-device engines share one card/worker implementation,
    # keyed "stt" (whisper.cpp) / "llm" (llama.cpp cleanup).
    _LOCAL_ENGINES = {"stt": localstt, "llm": localllm}

    def __init__(self, cfg, on_save, on_capture_start=None,
                 on_capture_end=None, history_getter=None, on_retry=None,
                 config_getter=None):
        super().__init__()
        self._config = dict(cfg)
        self._on_save = on_save
        self._on_capture_start = on_capture_start
        self._on_capture_end = on_capture_end
        self._history_getter = history_getter
        self._on_retry = on_retry
        self._config_getter = config_getter

        self._win = None
        self._active_section = None
        self._capturing = False
        self._capture_target = None
        self._testing = False
        self._mic_recorder = None
        self._hist_expanded_ts = None
        self._hist_fp = None
        self._providers_advanced = False
        # Per-engine card state: "install"/"load"/"eject" while working.
        self._local_busy = {"stt": None, "llm": None}
        self._local_progress = {"stt": "", "llm": ""}
        self._local_error = {"stt": "", "llm": ""}
        self._local_btn = {}
        self._local_status = {}

        self._captured.connect(self._on_captured)
        self._tested.connect(self._on_tested)
        self._local_progress_sig.connect(self._on_local_progress)
        self._local_done_sig.connect(self._on_local_done)

    # --- Window lifecycle -------------------------------------------------

    def open(self):
        if self._config_getter is not None:
            self._config = dict(self._config_getter())
        if self._win is not None:
            self._raise()
            return
        win = QWidget(None, Qt.Window)
        win.setObjectName("settingsWindow")
        self._win = win
        win.setWindowTitle("Undertone")
        win.setWindowIcon(QIcon(str(ICON_ICO)))
        win.setMinimumSize(MIN_W, MIN_H)
        win.setStyleSheet(QSS.replace("__CHEVRON__", _chevron_url()))
        win.closeEvent = self._close_event
        win.keyPressEvent = self._key_press

        outer = QHBoxLayout(win)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        outer.addWidget(self._build_sidebar())

        content_holder = QWidget()
        holder_lay = QVBoxLayout(content_holder)
        holder_lay.setContentsMargins(0, 0, 0, 0)
        self._stack = QStackedWidget()
        holder_lay.addWidget(self._stack)
        outer.addWidget(content_holder, 1)

        # "✓ Saved" toast pinned to the content's bottom-right corner.
        self._saved_label = QLabel("", content_holder)
        self._saved_label.setStyleSheet(
            f"color: {theme.GREEN}; font-size: 9pt; background: transparent;")
        self._saved_label.adjustSize()
        self._saved_timer = QTimer(win)
        self._saved_timer.setSingleShot(True)
        self._saved_timer.timeout.connect(
            lambda: self._saved_label.setText(""))
        content_holder.resizeEvent = self._position_saved
        self._content_holder = content_holder

        first = "Get started" if self._setup_incomplete() else "General"
        self._select_section(first)
        self._restore_geometry()
        win.show()
        _dark_titlebar(win)
        self._raise()

    def _raise(self):
        win = self._win
        win.show()
        win.setWindowState(win.windowState() & ~Qt.WindowMinimized)
        win.raise_()
        win.activateWindow()

    def _key_press(self, event):
        if event.key() == Qt.Key_Escape and not self._capturing:
            self._win.close()
        else:
            QWidget.keyPressEvent(self._win, event)

    def _close_event(self, event):
        if self._capturing:
            row = self._shortcut_rows.get(self._capture_target)
            if row:
                row["error"].setText(
                    "Finish the shortcut, or press Esc to cancel capture.")
                row["error"].show()
                row["chip"].setText("Press keys…")
            self._raise()
            event.ignore()
            return
        self._stop_mic_test()
        geo = self._win.geometry()
        self._config = {**self._config, "window_geometry":
                        f"{geo.width()}x{geo.height()}"
                        f"{geo.x():+d}{geo.y():+d}"}
        self._on_save(self._config)
        event.accept()
        self._win.deleteLater()
        self._win = None
        self._active_section = None

    # --- Sidebar / sections -------------------------------------------------

    def _build_sidebar(self):
        bar = QFrame()
        bar.setFixedWidth(SIDEBAR_W)
        bar.setStyleSheet(f"background: {theme.MANTLE};")
        lay = QVBoxLayout(bar)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(0)

        brand = QWidget()
        brand_lay = QHBoxLayout(brand)
        brand_lay.setContentsMargins(18, 16, 8, 16)
        icon = QLabel()
        icon.setPixmap(_pil_pixmap(load_app_image(30)))
        brand_lay.addWidget(icon)
        name = QLabel("Undertone")
        name.setStyleSheet('font-family: "Segoe UI Semibold";'
                           'font-size: 12pt; background: transparent;')
        brand_lay.addWidget(name, 1)
        lay.addWidget(brand)

        self._nav_items = {}
        for section in self._visible_sections():
            item = NavItem(section, self._select_section)
            self._nav_items[section] = item
            lay.addWidget(item)
        lay.addStretch(1)
        version = QLabel(f"Version {APP_VERSION}")
        version.setStyleSheet(f"color: {theme.MUTED}; font-size: 8pt;"
                              "background: transparent;")
        version.setContentsMargins(18, 0, 0, 12)
        lay.addWidget(version)
        self._sidebar = bar
        self._sidebar_lay = lay
        return bar

    def _visible_sections(self, hide_get_started=False):
        return [name for name in SECTIONS
                if name != "Get started"
                or (self._setup_incomplete() and not hide_get_started)]

    def _remove_get_started_nav(self):
        item = self._nav_items.pop("Get started", None)
        if item is not None:
            item.deleteLater()

    def _select_section(self, section):
        if self._win is None:
            return
        self._active_section = section
        for name, item in self._nav_items.items():
            item.set_active(name == section)
        builders = {
            "Get started": self._build_get_started,
            "General": self._build_general,
            "Dictionary": self._build_dictionary,
            "History": self._build_history,
            "Providers": self._build_providers,
            "About": self._build_about,
        }
        old = self._stack.currentWidget()
        page = self._wrap_scroll(builders[section](),
                                 fill=section == "About")
        self._stack.addWidget(page)
        self._stack.setCurrentWidget(page)
        if old is not None:
            self._stack.removeWidget(old)
            old.deleteLater()   # kills the old section's QTimers with it
        self._saved_label.raise_()

    def _wrap_scroll(self, inner, fill=False):
        scroll = QScrollArea(widgetResizable=True)
        holder = QWidget()
        lay = QVBoxLayout(holder)
        lay.setContentsMargins(28, 24, 28, 24)
        lay.setSpacing(9)
        # fill: the section expands to the viewport so its own stretches
        # can place content (About centers itself and pins its dev-mode
        # row to the bottom); otherwise content top-aligns over the slack.
        lay.addWidget(inner, 1 if fill else 0)
        if not fill:
            lay.addStretch(1)
        scroll.setWidget(holder)
        # setWidget() flips autoFillBackground on — that paints the Qt
        # dark-mode PALETTE color, not the theme, over the whole page.
        holder.setAutoFillBackground(False)
        return scroll

    def _section_column(self, heading):
        box = QWidget()
        col = QVBoxLayout(box)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(9)
        label = QLabel(heading, objectName="heading")
        col.addWidget(label)
        return box, col

    def _group_label(self, text):
        return QLabel(text, objectName="group")

    # --- General -----------------------------------------------------------

    def _build_general(self):
        box, col = self._section_column("General")
        if not self._stt_configured():
            target = ("Get started" if "Get started" in self._nav_items
                      else "Providers")
            col.addWidget(row_card(
                "Finish setting up Undertone",
                "Add an API key for your transcription provider to start "
                "dictating.",
                pill_button(f"Open {target}", "accent",
                            lambda name=target: self._select_section(name)),
                object_name="banner"))

        self._shortcut_rows = {}
        col.addWidget(self._group_label("Shortcuts"))
        col.addWidget(self._shortcut_card(
            "Push-to-talk", "hotkey",
            "Hold to dictate, release to transcribe. Double-tap to lock "
            "hands-free; tap again to finish."))
        col.addWidget(self._shortcut_card(
            "Re-paste last dictation", "repaste_hotkey",
            "Pastes your most recent dictation again, wherever your cursor "
            "is now."))

        col.addWidget(self._group_label("Dictation"))
        language = Combo()
        for label, code in LANGUAGES:
            language.addItem(label, code)
        language.setCurrentIndex(max(0, [code for _l, code in LANGUAGES]
                                     .index(self._config.get("language",
                                                             "en"))))
        language.currentIndexChanged.connect(
            lambda _i: self._apply(language=language.currentData()))
        language.setFixedWidth(170)
        col.addWidget(row_card("Spoken language",
                               "The language you dictate in.", language))

        mic = self._mic_combo()
        mic.setFixedWidth(190)
        col.addWidget(row_card("Microphone", "Where Undertone listens.", mic))
        col.addWidget(self._toggle_card(
            "Smart formatting", "smart_formatting",
            "Match spacing and capitalization to where you're typing."))
        col.addWidget(self._cleanup_card())
        col.addWidget(self._toggle_card(
            "Sound cues", "sound_cues",
            "Play a soft tick when recording starts and stops."))

        col.addWidget(self._group_label("System"))
        col.addWidget(self._autostart_card())
        return box

    def _mic_combo(self):
        window = self

        class MicCombo(Combo):
            def showPopup(self):
                window._fill_mic_options(self)
                super().showPopup()

        combo = MicCombo()
        self._fill_mic_options(combo)
        combo.currentIndexChanged.connect(
            lambda _i: self._apply(input_device=combo.currentData()))
        return combo

    def _fill_mic_options(self, combo):
        current = self._config.get("input_device", "")
        combo.blockSignals(True)
        combo.clear()
        options = [("System default", "")]
        try:
            from recorder import list_input_devices
            options.extend((_ellipsize(name), name)
                           for _index, name in list_input_devices())
        except Exception:
            pass
        if current and all(value != current for _label, value in options):
            options.append((_ellipsize(current), current))
        for label, value in options:
            combo.addItem(label, value)
        combo.setCurrentIndex(
            max(0, [v for _l, v in options].index(current)
                if current in [v for _l, v in options] else 0))
        combo.blockSignals(False)

    def _shortcut_card(self, title, config_key, hint):
        combo = self._config.get(config_key, "")
        chip = QLabel(pretty_combo(combo) or "None", objectName="chip")
        change = pill_button("Change", "neutral",
                             lambda key=config_key: self._start_capture(key))
        control = QWidget()
        control_lay = QHBoxLayout(control)
        control_lay.setContentsMargins(0, 0, 0, 0)
        control_lay.setSpacing(8)
        control_lay.addWidget(chip)
        control_lay.addWidget(change)

        frame = QFrame(objectName="card")
        outer = QHBoxLayout(frame)
        outer.setContentsMargins(16, 12, 16, 12)
        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        title_label = QLabel(title)
        title_label.setProperty("class", "cardTitle")
        text_col.addWidget(title_label)
        text_col.addWidget(hint_label(hint))
        error = hint_label("", theme.RED)
        error.hide()
        text_col.addWidget(error)
        outer.addLayout(text_col, 1)
        outer.addWidget(control, 0, Qt.AlignVCenter)

        self._shortcut_rows[config_key] = {
            "chip": chip, "button": change, "error": error, "combo": combo}
        return frame

    def _toggle_card(self, title, key, hint):
        toggle = Toggle(self._config.get(key, True),
                        lambda on, name=key: self._apply(**{name: on}))
        return row_card(title, hint, toggle)

    def _cleanup_card(self):
        frame = QFrame(objectName="card")
        outer = QHBoxLayout(frame)
        outer.setContentsMargins(16, 12, 16, 12)
        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        title = QLabel("AI cleanup")
        title.setProperty("class", "cardTitle")
        text_col.addWidget(title)
        text_col.addWidget(hint_label(
            "Clean up fillers and false starts with a fast grok model. "
            "Sends the text near your cursor to your cleanup provider."))
        warning = hint_label(self._cleanup_warning(), theme.AMBER)
        warning.setVisible(bool(self._cleanup_warning()))
        text_col.addWidget(warning)
        outer.addLayout(text_col, 1)

        def change(on):
            self._apply(ai_cleanup=on)
            text = self._cleanup_warning()
            warning.setText(text)
            warning.setVisible(bool(text))

        toggle = Toggle(self._config.get("ai_cleanup", True), change)
        outer.addWidget(toggle, 0, Qt.AlignVCenter)
        return frame

    def _autostart_card(self):
        try:
            initial = autostart.is_enabled()
        except Exception:
            initial = False
        toggle = Toggle(initial)

        def change(on):
            try:
                autostart.set_enabled(on)
                self._flash_saved()
            except Exception:
                toggle.set(not on)

        toggle.on_change = change
        return row_card(
            "Start with Windows",
            "Launch quietly in the tray when you sign in.", toggle)

    # --- Shortcut capture -----------------------------------------------------

    def _start_capture(self, config_key):
        if self._capturing:
            return
        row = self._shortcut_rows[config_key]
        self._capturing = True
        self._capture_target = config_key
        row["error"].hide()
        row["button"].setEnabled(False)
        row["chip"].setText("Press keys…")
        if self._on_capture_start is not None:
            try:
                self._on_capture_start()
            except Exception:
                pass
        threading.Thread(target=self._capture_worker, daemon=True).start()

    def _capture_worker(self):
        try:
            combo = keyboard.read_hotkey(suppress=True)
        except Exception:
            combo = None
        self._captured.emit(combo)

    def _on_captured(self, combo):
        if not self._capturing:
            return
        self._capturing = False
        target = self._capture_target
        row = self._shortcut_rows.get(target)
        alive = self._win is not None and row is not None
        cancelled = combo is None or combo.strip().lower() in ("esc",
                                                               "escape")
        new_hotkey = None
        if not cancelled:
            try:
                from hotkey import validate_hotkey
                new_hotkey = validate_hotkey(combo)
            except ValueError as exc:
                if alive:
                    row["error"].setText(str(exc))
                    row["error"].show()
                cancelled = True
            except ImportError:
                new_hotkey = combo.strip().lower()
        if not cancelled:
            for key, label in (("hotkey", "Push-to-talk"),
                               ("repaste_hotkey", "Re-paste"),
                               ("toggle_hotkey", "the toggle key")):
                if key != target and self._config.get(key, "") == new_hotkey:
                    if alive:
                        row["error"].setText(f"Already used by {label}.")
                        row["error"].show()
                    cancelled = True
                    break
        if alive:
            shown = row["combo"] if cancelled else new_hotkey
            row["chip"].setText(pretty_combo(shown) or "None")
            row["button"].setEnabled(True)
            if not cancelled:
                row["combo"] = new_hotkey
        if self._on_capture_end is not None:
            try:
                self._on_capture_end()
            except Exception:
                pass
        if not cancelled:
            self._apply(**{target: new_hotkey})

    # --- Get started -----------------------------------------------------------

    def _build_get_started(self):
        box, col = self._section_column("Get started")
        self._gs_provider = self._config.get("provider", "xai")
        if self._gs_provider not in KEY_FIELDS:
            self._gs_provider = "xai"  # guided setup covers cloud keys only
        self._gs_key_field = KEY_FIELDS[self._gs_provider]

        step1, lay1 = card()
        title1 = QLabel("1.  Choose your transcription provider")
        title1.setProperty("class", "cardTitle")
        lay1.addWidget(title1)
        lay1.addSpacing(8)
        provider = Combo()
        for label, pid in PROVIDERS_UI:
            provider.addItem(label, pid)
        provider.setCurrentIndex(
            [pid for _l, pid in PROVIDERS_UI].index(self._gs_provider))
        provider.setFixedWidth(150)
        provider.currentIndexChanged.connect(
            lambda _i: self._gs_pick_provider(provider.currentData()))
        lay1.addWidget(provider)
        lay1.addSpacing(8)
        self._gs_key_label = hint_label(
            f"{PROVIDER_BY_ID[self._gs_provider]} API key", theme.SUBTEXT)
        lay1.addWidget(self._gs_key_label)
        entry_row = QHBoxLayout()
        self._gs_key_entry = QLineEdit(self._config.get(self._gs_key_field,
                                                        ""))
        self._gs_key_entry.setEchoMode(QLineEdit.Password)
        self._gs_key_entry.setPlaceholderText("Paste API key")
        self._gs_key_entry.returnPressed.connect(self._gs_save_key)
        entry_row.addWidget(self._gs_key_entry, 1)
        entry_row.addWidget(pill_button("Save", "accent", self._gs_save_key))
        self._test_button = pill_button("Test", "neutral",
                                        self._gs_test_transcription)
        entry_row.addWidget(self._test_button)
        lay1.addLayout(entry_row)
        lay1.addSpacing(4)
        self._test_status = hint_label("", theme.MUTED, wrap=True)
        lay1.addWidget(self._test_status)
        col.addWidget(step1)

        step2, lay2 = card()
        title2 = QLabel("2.  Try your microphone")
        title2.setProperty("class", "cardTitle")
        lay2.addWidget(title2)
        lay2.addSpacing(8)
        mic_row = QHBoxLayout()
        self._mic_button = pill_button("Test microphone", "neutral",
                                       self._start_mic_test)
        self._mic_meter = Meter()
        mic_row.addWidget(self._mic_button)
        mic_row.addSpacing(12)
        mic_row.addWidget(self._mic_meter, 0, Qt.AlignVCenter)
        mic_row.addStretch(1)
        lay2.addLayout(mic_row)
        self._mic_status = hint_label("", theme.RED)
        lay2.addWidget(self._mic_status)
        col.addWidget(step2)

        step3, lay3 = card()
        title3 = QLabel("3.  Say something")
        title3.setProperty("class", "cardTitle")
        lay3.addWidget(title3)
        lay3.addSpacing(2)
        combo = pretty_combo(self._config.get("hotkey", "")) or "your shortcut"
        lay3.addWidget(hint_label(
            f"Click into the box below, hold {combo} and read: “Testing, "
            "one two three — it works.”"))
        lay3.addSpacing(8)
        self._practice_field = QLineEdit()
        lay3.addWidget(self._practice_field)
        lay3.addSpacing(8)
        finish_row = QWidget()
        finish_lay = QHBoxLayout(finish_row)
        finish_lay.setContentsMargins(0, 0, 0, 0)
        done = QLabel("✓ That's it — you're set up.")
        done.setStyleSheet(f"color: {theme.GREEN}; font-size: 9pt;"
                           "background: transparent;")
        finish_lay.addWidget(done)
        finish_lay.addSpacing(12)
        finish_lay.addWidget(pill_button("Finish", "accent",
                                         self._finish_onboarding))
        finish_lay.addStretch(1)
        finish_row.hide()
        lay3.addWidget(finish_row)
        col.addWidget(step3)

        practice_timer = QTimer(box)
        practice_timer.timeout.connect(
            lambda: (finish_row.show(), practice_timer.stop())
            if len(self._practice_field.text().strip()) > 10 else None)
        practice_timer.start(500)

        col.addWidget(self._autostart_card())
        return box

    def _gs_pick_provider(self, provider):
        self._gs_provider = provider
        self._apply(provider=provider)
        self._gs_key_field = KEY_FIELDS[provider]
        self._gs_key_entry.setText(self._config.get(self._gs_key_field, ""))
        self._gs_key_label.setText(f"{PROVIDER_BY_ID[provider]} API key")
        self._set_status(self._test_status, "", theme.MUTED)

    def _gs_save_key(self):
        self._apply(**{self._gs_key_field: self._gs_key_entry.text().strip()})

    def _gs_test_transcription(self):
        if self._testing:
            return
        provider = self._gs_provider
        key = self._gs_key_entry.text().strip()
        if not key:
            self._set_status(
                self._test_status,
                f"Enter your {PROVIDER_BY_ID[provider]} API key below first.",
                theme.RED)
            return
        self._testing = True
        self._test_context = "get_started"
        self._test_button.setEnabled(False)
        self._set_status(self._test_status, "Testing…", theme.MUTED)
        threading.Thread(target=self._test_stt_worker,
                         args=(key, provider, dict(self._config)),
                         daemon=True).start()

    def _finish_onboarding(self):
        self._apply(onboarded=True)
        self._remove_get_started_nav()
        self._select_section("General")

    # --- Mic test ---------------------------------------------------------------

    def _start_mic_test(self):
        if self._mic_recorder is not None:
            return
        from recorder import Recorder, RecorderError
        recorder = Recorder(
            sample_rate=self._config.get("sample_rate", 16000),
            device=self._config.get("input_device") or None)
        try:
            recorder.start()
        except RecorderError as exc:
            self._set_status(self._mic_status, str(exc), theme.RED)
            return
        self._mic_recorder = recorder
        self._mic_button.setText("Listening…")
        self._mic_button.setEnabled(False)
        meter, button = self._mic_meter, self._mic_button
        ticks = {"left": 60}
        timer = QTimer(meter)   # dies with the section widget

        def tick():
            ticks["left"] -= 1
            if ticks["left"] <= 0 or self._mic_recorder is not recorder:
                timer.stop()
                self._stop_mic_test(meter, button)
                return
            meter.set_level(recorder.level)

        timer.timeout.connect(tick)
        timer.start(50)

    def _stop_mic_test(self, meter=None, button=None):
        recorder, self._mic_recorder = self._mic_recorder, None
        if recorder is not None:
            try:
                recorder.stop()
            except Exception:
                pass
        try:
            if meter is not None:
                meter.set_level(0.0)
            if button is not None:
                button.setText("Test microphone")
                button.setEnabled(True)
        except RuntimeError:
            pass  # section widget already deleted

    # --- Providers tests ---------------------------------------------------------

    def _test_stt_worker(self, key, provider, cfg):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x00" * 8000)
        try:
            from transcriber import DEFAULT_STT_MODELS, transcribe
            model = ((cfg.get("stt_models") or {}).get(provider)
                     or DEFAULT_STT_MODELS[provider])
            transcribe(buf.getvalue(), key, provider=provider, model=model)
            name = PROVIDER_BY_ID.get(provider, provider)
            result = ("stt", True, f"Transcription works ({name}).")
        except Exception as exc:
            result = ("stt", False, str(exc))
        self._tested.emit(result)

    def _test_cleanup_worker(self, key, provider, cfg):
        try:
            from cleanup import DEFAULT_CLEANUP_MODELS, cleanup
            model = ((cfg.get("cleanup_models") or {}).get(provider)
                     or DEFAULT_CLEANUP_MODELS[provider])
            timeout = 2.5
            if provider == "local":
                # The test may load the model (we're on a worker thread)
                # and shouldn't fail a slow CPU box on the paste budget.
                localllm.ensure_ready(model)
                timeout = 30.0
            output = cleanup("testing one two three", None, "", {}, key,
                             model, provider=provider, timeout=timeout)
            if output is not None:
                name = PROVIDER_BY_ID.get(provider, provider)
                result = ("cleanup", True, f"Cleanup works ({name}).")
            else:
                result = ("cleanup", False,
                          "Cleanup failed — check the key, or see app.log.")
        except localllm.LocalLLMError as exc:
            result = ("cleanup", False, str(exc))
        except Exception:
            result = ("cleanup", False,
                      "Cleanup failed — check the key, or see app.log.")
        self._tested.emit(result)

    def _on_tested(self, result):
        self._testing = False
        which, ok, message = result
        if self._win is None:
            return
        try:
            if getattr(self, "_test_context", None) == "get_started":
                button, status = self._test_button, self._test_status
            else:
                button = (self._test_stt_btn if which == "stt"
                          else self._test_cleanup_btn)
                status = self._providers_status
            button.setEnabled(True)
            self._set_status(status, ("✓ " if ok else "") + message,
                             theme.GREEN if ok else theme.RED)
        except RuntimeError:
            pass  # the section that started the test was rebuilt

    def _set_status(self, label, text, color):
        label.setText(text)
        label.setStyleSheet(f"color: {color}; font-size: 9pt;"
                            "background: transparent;")

    # --- Dictionary -----------------------------------------------------------

    def _build_dictionary(self):
        box, col = self._section_column("Dictionary")

        col.addWidget(self._group_label("Vocabulary"))
        vocab_card, vlay = card()
        vlay.addWidget(hint_label(
            "Words and names the transcriber should recognize."))
        vlay.addSpacing(8)
        vocab_row = QHBoxLayout()
        self._vocab_entry = QLineEdit()
        self._vocab_entry.returnPressed.connect(self._add_vocab)
        vocab_row.addWidget(self._vocab_entry, 1)
        vocab_row.addWidget(pill_button("Add", "accent", self._add_vocab))
        vlay.addLayout(vocab_row)
        vlay.addSpacing(8)
        panel, self._vocab_column = list_panel(rows_visible=3)
        vlay.addWidget(panel)
        col.addWidget(vocab_card)
        self._render_vocab()

        col.addWidget(self._group_label("Corrections"))
        corr_card, clay = card()
        clay.addWidget(hint_label(
            "Always replace a misheard phrase with the right one."))
        clay.addSpacing(8)
        corr_row = QHBoxLayout()
        self._corr_heard_entry = QLineEdit()
        self._corr_heard_entry.returnPressed.connect(self._add_correction)
        arrow = QLabel("→")
        arrow.setStyleSheet(f"color: {theme.SUBTEXT};"
                            "background: transparent;")
        self._corr_right_entry = QLineEdit()
        self._corr_right_entry.returnPressed.connect(self._add_correction)
        corr_row.addWidget(self._corr_heard_entry, 1)
        corr_row.addWidget(arrow)
        corr_row.addWidget(self._corr_right_entry, 1)
        corr_row.addWidget(pill_button("Add", "accent", self._add_correction))
        clay.addLayout(corr_row)
        clay.addSpacing(8)
        panel2, self._corr_column = list_panel(rows_visible=3)
        clay.addWidget(panel2)
        col.addWidget(corr_card)
        self._render_corrections()

        col.addWidget(self._toggle_card(
            "Send terms to the transcription model", "stt_vocab_hints",
            "xAI receives your terms as key-term recognition hints; other "
            "providers never see them. Terms always apply through "
            "corrections and AI cleanup."))
        return box

    def _dict_row(self, text, on_remove):
        row = ListRow()
        lay = QHBoxLayout(row)
        lay.setContentsMargins(10, 6, 10, 6)
        label = QLabel(text)
        lay.addWidget(label, 1)
        row.setFixedHeight(ROW_H)
        remove = QPushButton("✕")
        remove.setCursor(Qt.PointingHandCursor)
        remove.setStyleSheet(
            f"QPushButton {{ color: {theme.MUTED}; background: transparent;"
            "border: none; padding: 0 4px; }"
            f"QPushButton:hover {{ color: {theme.RED}; }}")
        remove.clicked.connect(lambda _=False: on_remove())
        lay.addWidget(remove)
        return row

    def _render_vocab(self):
        clear_rows(self._vocab_column)
        terms = list(self._config.get("vocabulary", []))
        if not terms:
            self._vocab_column.insertWidget(0, empty_row(
                "No terms yet — add names and jargon the transcriber gets "
                "wrong."))
            return
        for index, term in enumerate(terms):
            self._vocab_column.insertWidget(index, self._dict_row(
                term, lambda value=term: self._remove_vocab(value)))

    def _render_corrections(self):
        clear_rows(self._corr_column)
        pairs = list((self._config.get("corrections") or {}).items())
        if not pairs:
            self._corr_column.insertWidget(0, empty_row(
                "No corrections yet."))
            return
        for index, (heard, right) in enumerate(pairs):
            self._corr_column.insertWidget(index, self._dict_row(
                f"{heard}   →   {right}",
                lambda value=heard: self._remove_correction(value)))

    def _add_vocab(self):
        term = self._vocab_entry.text().strip()
        terms = list(self._config.get("vocabulary", []))
        self._vocab_entry.clear()
        if not term or term in terms:
            return
        terms.append(term)
        self._apply(vocabulary=terms)
        self._render_vocab()

    def _remove_vocab(self, term):
        terms = [value for value in self._config.get("vocabulary", [])
                 if value != term]
        self._apply(vocabulary=terms)
        self._render_vocab()

    def _add_correction(self):
        heard = self._corr_heard_entry.text().strip()
        right = self._corr_right_entry.text().strip()
        if not heard or not right:
            return
        pairs = dict(self._config.get("corrections", {}))
        pairs[heard] = right
        self._corr_heard_entry.clear()
        self._corr_right_entry.clear()
        self._apply(corrections=pairs)
        self._render_corrections()

    def _remove_correction(self, heard):
        pairs = {key: value for key, value
                 in self._config.get("corrections", {}).items()
                 if key != heard}
        self._apply(corrections=pairs)
        self._render_corrections()

    # --- History -----------------------------------------------------------------

    def _build_history(self):
        box, col = self._section_column("History")
        combo = pretty_combo(self._config.get("repaste_hotkey", ""))
        if combo:
            hint = ("Dictations from this session, newest first. "
                    f"Press {combo} anywhere to re-paste the newest one — or "
                    "click into the target app first and use the buttons "
                    "here.")
        else:
            hint = ("Dictations from this session, newest first. Set a "
                    "re-paste shortcut in General to paste the newest one "
                    "anywhere.")
        col.addWidget(hint_label(hint))
        col.addSpacing(3)
        panel, self._hist_column = list_panel()
        panel.setMinimumHeight(300)
        panel.setSizePolicy(QSizePolicy.Preferred, QSizePolicy.Expanding)
        col.addWidget(panel, 1)
        items = self._hist_snapshot()
        self._hist_fp = self._hist_fingerprint(items)
        self._render_history(items)

        poll = QTimer(box)   # dies with the section

        def check():
            items = self._hist_snapshot()
            if self._hist_fingerprint(items) != self._hist_fp:
                self._render_history(items)

        poll.timeout.connect(check)
        poll.start(2000)
        return box

    def _hist_snapshot(self):
        if self._history_getter is None:
            return []
        try:
            return self._history_getter() or []
        except Exception:
            return []

    @staticmethod
    def _hist_fingerprint(items):
        return tuple((entry.get("ts"), entry.get("ok", True))
                     for entry in items)

    def _render_history(self, items=None):
        items = self._hist_snapshot() if items is None else items
        self._hist_fp = self._hist_fingerprint(items)
        if not any(entry.get("ts") == self._hist_expanded_ts
                   for entry in items):
            self._hist_expanded_ts = None
        clear_rows(self._hist_column)
        if not items:
            self._hist_column.insertWidget(0, empty_row(
                "Nothing dictated yet this session. Hold your shortcut and "
                "speak — dictations appear here."))
            return
        for index, entry in enumerate(items):
            self._hist_column.insertWidget(index, self._history_row(entry))

    def _history_row(self, entry):
        ok = entry.get("ok", True)
        expanded = ok and self._hist_expanded_ts == entry.get("ts")
        row = ListRow()
        outer = QVBoxLayout(row)
        outer.setContentsMargins(10, 0, 8, 0)
        outer.setSpacing(0)

        head = QWidget()
        head.setFixedHeight(34)
        head_lay = QHBoxLayout(head)
        head_lay.setContentsMargins(0, 0, 0, 0)
        head_lay.setSpacing(6)
        when = time.strftime("%H:%M", time.localtime(entry.get("ts", 0)))
        if ok:
            time_label = hint_label(when, theme.MUTED, wrap=False)
            preview = entry.get("text", "").replace("\n", " ").strip()
        else:
            time_label = hint_label(f"✕ {when}", theme.AMBER, wrap=False)
            preview = " ".join(entry.get("error", "").split())
        time_label.setFixedWidth(52)
        head_lay.addWidget(time_label)
        head_lay.addWidget(ElideLabel(
            preview, theme.TEXT if ok else theme.SUBTEXT), 1)
        if ok:
            text = entry.get("text", "")
            copy = pill_button("Copy", "neutral",
                               lambda value=text: self._copy(value))
            head_lay.addWidget(copy)
        elif entry.get("wav") is not None:
            wav = entry.get("wav")
            head_lay.addWidget(pill_button(
                "Retry", "accent", lambda value=wav: self._retry(value)))
        outer.addWidget(head)

        if expanded:
            detail = QWidget()
            detail_lay = QVBoxLayout(detail)
            detail_lay.setContentsMargins(52, 0, 0, 10)
            detail_lay.setSpacing(4)
            full = QLabel(entry.get("text", ""))
            full.setWordWrap(True)
            full.setTextInteractionFlags(Qt.TextSelectableByMouse)
            detail_lay.addWidget(full)
            raw = entry.get("raw")
            if raw and raw != entry.get("text"):
                detail_lay.addWidget(hint_label(f"Heard: {raw}", theme.MUTED))
            action_row = QHBoxLayout()
            if raw:
                action_row.addWidget(pill_button(
                    "Copy raw", "neutral",
                    lambda value=raw: self._copy(value)))
            action_row.addWidget(pill_button(
                "Add correction…", "neutral",
                lambda value=raw or entry.get("text", ""):
                self._hist_add_correction(value)))
            action_row.addStretch(1)
            detail_lay.addLayout(action_row)
            outer.addWidget(detail)

        if ok:
            ts = entry.get("ts")

            def toggle(_event, value=ts):
                self._hist_toggle(value)

            head.mousePressEvent = toggle
        return row

    def _hist_toggle(self, ts):
        self._hist_expanded_ts = None if self._hist_expanded_ts == ts else ts
        self._render_history()

    def _hist_add_correction(self, heard):
        self._select_section("Dictionary")
        self._corr_heard_entry.setText(heard)
        self._corr_heard_entry.setFocus()
        self._corr_heard_entry.deselect()
        self._corr_heard_entry.end(False)

    def _copy(self, text):
        try:
            pyperclip.copy(text)
        except Exception:
            pass
        self._flash_saved()

    def _retry(self, wav):
        if self._on_retry is None:
            return
        if self._win is not None:
            self._win.showMinimized()
        QTimer.singleShot(600, lambda: self._on_retry(wav))

    # --- Providers -------------------------------------------------------------

    def _build_providers(self):
        box, col = self._section_column("Providers")
        self._key_entries = {}
        self._key_status_blocks = {}
        self._model_entries = {}
        self._model_hints = {}

        col.addWidget(self._group_label("Services"))
        stt_combo = Combo()
        for label, pid in ALL_PROVIDERS_UI:
            stt_combo.addItem(label, pid)
        stt_combo.setCurrentIndex([pid for _l, pid in ALL_PROVIDERS_UI]
                                  .index(self._config.get("provider", "xai")))
        stt_combo.setFixedWidth(130)
        stt_combo.currentIndexChanged.connect(
            lambda _i: self._pick_provider("provider", stt_combo.currentData()))
        self._test_stt_btn = pill_button("Test", "neutral",
                                         self._test_stt_from_providers)
        col.addWidget(row_card("Transcription", "Turns your speech into text.",
                               self._inline(stt_combo, self._test_stt_btn)))

        cleanup_combo = Combo()
        for label, pid in ALL_PROVIDERS_UI:
            cleanup_combo.addItem(label, pid)
        cleanup_combo.setCurrentIndex(
            [pid for _l, pid in ALL_PROVIDERS_UI]
            .index(self._config.get("cleanup_provider", "xai")))
        cleanup_combo.setFixedWidth(130)
        cleanup_combo.currentIndexChanged.connect(
            lambda _i: self._pick_provider("cleanup_provider",
                                           cleanup_combo.currentData()))
        self._test_cleanup_btn = pill_button("Test", "neutral",
                                             self._test_cleanup)
        col.addWidget(row_card("AI cleanup",
                               "Polishes the wording before it's pasted.",
                               self._inline(cleanup_combo,
                                            self._test_cleanup_btn)))
        self._providers_status = hint_label("", theme.MUTED)
        col.addWidget(self._providers_status)

        col.addWidget(self._group_label("On-device"))
        col.addWidget(self._local_card(box, "stt"))
        col.addWidget(self._toggle_card(
            "Load model on startup", "local_stt_loaded",
            "Load the local model when Undertone starts, so the first "
            "dictation is instant."))
        col.addWidget(self._idle_card("local_stt_idle_minutes"))
        col.addWidget(self._local_card(box, "llm"))
        col.addWidget(self._toggle_card(
            "Load cleanup model on startup", "local_llm_loaded",
            "Load the local cleanup model when Undertone starts, so the "
            "first dictation gets AI cleanup."))
        col.addWidget(self._idle_card("local_llm_idle_minutes"))

        col.addWidget(self._group_label("API keys"))
        for provider, field in KEY_FIELDS.items():
            col.addWidget(self._provider_key_card(
                PROVIDER_BY_ID.get(provider, provider), field))

        links_row = QHBoxLayout()
        links_row.addWidget(hint_label("Get a key:", wrap=False))
        for index, (label, url) in enumerate(PROVIDER_LINKS):
            if index:
                links_row.addWidget(hint_label("·", wrap=False))
            links_row.addWidget(link_label(
                label, lambda target=url: webbrowser.open(target)))
        links_row.addStretch(1)
        links_holder = QWidget()
        links_holder.setLayout(links_row)
        col.addWidget(links_holder)

        disclosure = "Advanced  ▾" if self._providers_advanced else "Advanced  ▸"
        advanced_link = link_label(disclosure,
                                   self._toggle_providers_advanced)
        advanced_link.setStyleSheet(
            f'font-family: "Segoe UI Semibold"; font-size: 9pt;')
        col.addWidget(advanced_link)
        if self._providers_advanced:
            adv_card, adv_lay = card()
            adv_lay.addWidget(self._model_control("Transcription model",
                                                  "stt"))
            adv_lay.addSpacing(10)
            adv_lay.addWidget(self._model_control("Cleanup model", "cleanup"))
            if self._config.get("dev_mode"):
                adv_lay.addSpacing(10)
                adv_lay.addWidget(self._cleanup_timeout_control())
                adv_lay.addSpacing(10)
                adv_lay.addWidget(self._cleanup_prompt_control())
            col.addWidget(adv_card)
        return box

    def _idle_card(self, config_key):
        idle_combo = Combo()
        for label, minutes in [("Never", 0), ("After 5 min", 5),
                               ("After 15 min", 15), ("After 30 min", 30),
                               ("After 1 hour", 60)]:
            idle_combo.addItem(label, minutes)
        idle_combo.setFixedWidth(130)
        current_idle = int(self._config.get(config_key) or 0)
        idle_combo.setCurrentIndex(max(0, [0, 5, 15, 30, 60].index(
            current_idle) if current_idle in (0, 5, 15, 30, 60) else 0))
        idle_combo.currentIndexChanged.connect(
            lambda _i, key=config_key: self._apply(
                **{key: idle_combo.currentData()}))
        return row_card(
            "Auto-eject when idle",
            "Frees memory after inactivity; reloads on the next dictation.",
            idle_combo)

    def _cleanup_timeout_control(self):
        # Dev mode only: how long the cleanup pass may take before the
        # dictation falls back to rule-based formatting.
        holder = QWidget()
        lay = QVBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(3)
        name = QLabel("Cleanup timeout (dev)")
        name.setStyleSheet(f"color: {theme.SUBTEXT};"
                           "background: transparent;")
        lay.addWidget(name)
        default = DEFAULT_CONFIG["cleanup_timeout"]
        entry_row = QHBoxLayout()
        entry = QLineEdit(f"{self._config.get('cleanup_timeout', default):g}")
        entry.setFixedWidth(80)

        def save():
            try:
                value = float(entry.text().strip() or default)
            except ValueError:
                value = default
            value = min(30.0, max(0.5, value))
            entry.setText(f"{value:g}")
            self._apply(cleanup_timeout=value)

        entry.returnPressed.connect(save)
        entry_row.addWidget(entry)
        entry_row.addWidget(pill_button("Save", "accent", save))
        entry_row.addStretch(1)
        lay.addLayout(entry_row)
        lay.addWidget(hint_label(
            "Seconds before cleanup gives up and the dictation falls back "
            f"to standard formatting. Default {default:g}."))
        return holder

    @staticmethod
    def _inline(*widgets):
        holder = QWidget()
        lay = QHBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        for widget in widgets:
            lay.addWidget(widget)
        return holder

    def _provider_key_card(self, name, field):
        frame, lay = card()
        head = QHBoxLayout()
        title = QLabel(name)
        title.setProperty("class", "cardTitle")
        head.addWidget(title, 1)
        status = hint_label("", wrap=False)
        self._key_status_blocks[field] = status
        head.addWidget(status)
        lay.addLayout(head)
        lay.addSpacing(7)
        entry_row = QHBoxLayout()
        entry = QLineEdit(self._config.get(field, ""))
        entry.setEchoMode(QLineEdit.Password)
        entry.returnPressed.connect(
            lambda key=field: self._save_provider_key(key))
        self._key_entries[field] = entry
        entry_row.addWidget(entry, 1)
        show = QPushButton("Show")
        show.setProperty("variant", "neutral")
        show.setCursor(Qt.PointingHandCursor)
        show.clicked.connect(
            lambda _=False, node=entry, button=show:
            self._toggle_show(node, button))
        entry_row.addWidget(show)
        entry_row.addWidget(pill_button(
            "Save", "accent", lambda key=field: self._save_provider_key(key)))
        lay.addLayout(entry_row)
        self._refresh_key_status(field)
        return frame

    def _refresh_key_status(self, field):
        block = self._key_status_blocks.get(field)
        if block is None:
            return
        key = self._config.get(field, "")
        text = f"●  saved · ····{key[-4:]}" if key else "no key"
        self._set_status(block, text, theme.GREEN if key else theme.MUTED)

    def _toggle_show(self, entry, button):
        secret = entry.echoMode() == QLineEdit.Password
        entry.setEchoMode(QLineEdit.Normal if secret else QLineEdit.Password)
        button.setText("Hide" if secret else "Show")

    def _save_provider_key(self, field):
        self._apply(**{field: self._key_entries[field].text().strip()})
        self._refresh_key_status(field)

    def _pick_provider(self, config_key, provider):
        self._apply(**{config_key: provider})
        for kind, entry in self._model_entries.items():
            entry.setText(self._model_override(kind))
        self._refresh_model_hints()

    def _toggle_providers_advanced(self):
        self._providers_advanced = not self._providers_advanced
        self._select_section("Providers")

    def _model_control(self, label, kind):
        holder = QWidget()
        lay = QVBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(3)
        name = QLabel(label)
        name.setStyleSheet(f"color: {theme.SUBTEXT};"
                           "background: transparent;")
        lay.addWidget(name)
        entry_row = QHBoxLayout()
        entry = QLineEdit(self._model_override(kind))
        entry.returnPressed.connect(lambda key=kind: self._save_model(key))
        self._model_entries[kind] = entry
        entry_row.addWidget(entry, 1)
        entry_row.addWidget(pill_button(
            "Save", "accent", lambda key=kind: self._save_model(key)))
        lay.addLayout(entry_row)
        hint = hint_label("")
        self._model_hints[kind] = hint
        lay.addWidget(hint)
        self._refresh_model_hint(kind)
        return holder

    def _model_provider(self, kind):
        config_key = "provider" if kind == "stt" else "cleanup_provider"
        return self._config.get(config_key, "xai")

    def _model_override(self, kind):
        return (self._config.get(kind + "_models") or {}).get(
            self._model_provider(kind), "")

    def _save_model(self, kind):
        models = dict(self._config.get(kind + "_models") or {})
        provider = self._model_provider(kind)
        value = self._model_entries[kind].text().strip()
        if value:
            models[provider] = value
        else:
            models.pop(provider, None)
        self._apply(**{kind + "_models": models})
        self._refresh_model_hint(kind)

    def _default_model(self, kind, provider):
        try:
            if kind == "stt":
                from transcriber import DEFAULT_STT_MODELS
                return DEFAULT_STT_MODELS.get(provider, "")
            from cleanup import DEFAULT_CLEANUP_MODELS
            return DEFAULT_CLEANUP_MODELS.get(provider, "")
        except Exception:
            return ""

    def _refresh_model_hint(self, kind):
        block = self._model_hints.get(kind)
        if block is None:
            return
        default = self._default_model(kind, self._model_provider(kind))
        tail = f" ({default})" if default else ""
        block.setText(f"Empty = provider default{tail}.")

    def _refresh_model_hints(self):
        for kind in tuple(self._model_hints):
            self._refresh_model_hint(kind)

    def _test_stt_from_providers(self):
        provider = self._config.get("provider", "xai")
        field = KEY_FIELDS.get(provider, "api_key")
        self._start_provider_test("stt", provider, field, self._test_stt_btn,
                                  self._test_stt_worker)

    def _test_cleanup(self):
        provider = self._config.get("cleanup_provider", "xai")
        field = KEY_FIELDS.get(provider, "api_key")
        self._start_provider_test("cleanup", provider, field,
                                  self._test_cleanup_btn,
                                  self._test_cleanup_worker)

    def _start_provider_test(self, which, provider, field, button, worker):
        if self._testing:
            return
        entry = self._key_entries.get(field)
        key = entry.text().strip() if entry is not None else ""
        if provider == "local":
            key = ""  # keyless; the fallback field would be the xAI key
        elif not key:
            name = PROVIDER_BY_ID.get(provider, provider)
            self._set_status(self._providers_status,
                             f"Enter your {name} API key below first.",
                             theme.RED)
            return
        self._testing = True
        self._test_context = which
        button.setEnabled(False)
        self._set_status(self._providers_status, "Testing…", theme.MUTED)
        threading.Thread(target=worker,
                         args=(key, provider, dict(self._config)),
                         daemon=True).start()

    def _cleanup_prompt_control(self):
        # Dev mode only: the system prompt the cleanup model runs with.
        # The editor always shows the effective prompt (override or the
        # built-in default), so tweaks start from the real text.
        from cleanup import SYSTEM_PROMPT
        holder = QWidget()
        lay = QVBoxLayout(holder)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(3)
        name = QLabel("Cleanup system prompt (dev)")
        name.setStyleSheet(f"color: {theme.SUBTEXT};"
                           "background: transparent;")
        lay.addWidget(name)
        editor = QPlainTextEdit()
        editor.setPlainText(self._config.get("cleanup_prompt")
                            or SYSTEM_PROMPT)
        editor.setFixedHeight(190)
        lay.addWidget(editor)
        lay.addSpacing(4)
        status = hint_label("")

        def refresh():
            custom = bool(self._config.get("cleanup_prompt"))
            status.setText("Using a custom prompt."
                           if custom else "Using the default prompt.")

        def save():
            text = editor.toPlainText().strip()
            # Saving the default (or nothing) means "no override".
            override = text if text and text != SYSTEM_PROMPT.strip() else ""
            if not override:
                editor.setPlainText(SYSTEM_PROMPT)
            self._apply(cleanup_prompt=override)
            refresh()

        def reset():
            editor.setPlainText(SYSTEM_PROMPT)
            self._apply(cleanup_prompt="")
            refresh()

        btn_row = QHBoxLayout()
        btn_row.addWidget(pill_button("Save", "accent", save))
        btn_row.addWidget(pill_button("Reset to default", "neutral", reset))
        btn_row.addStretch(1)
        lay.addLayout(btn_row)
        lay.addWidget(status)
        refresh()
        return holder

    # --- Local engine cards (STT + cleanup share the implementation) -------------

    _LOCAL_CARD_TEXT = {
        "stt": ("Local transcription",
                "Whisper runs on this PC — audio never leaves your "
                "computer. Select the Local provider above to use it."),
        "llm": ("Local cleanup",
                "Qwen runs on this PC — transcripts never leave your "
                "computer. Works best with an NVIDIA GPU; without one, "
                "cleanup may not finish inside its time budget."),
    }

    def _local_card(self, section_box, engine):
        frame, lay = card()
        head = QHBoxLayout()
        text_col = QVBoxLayout()
        text_col.setSpacing(2)
        card_title, blurb = self._LOCAL_CARD_TEXT[engine]
        title = QLabel(card_title)
        title.setProperty("class", "cardTitle")
        text_col.addWidget(title)
        text_col.addWidget(hint_label(blurb))
        head.addLayout(text_col, 1)
        self._local_btn[engine] = pill_button(
            "", "accent", lambda eng=engine: self._on_local_action(eng))
        head.addWidget(self._local_btn[engine], 0, Qt.AlignVCenter)
        lay.addLayout(head)
        lay.addSpacing(7)
        self._local_status[engine] = hint_label("", wrap=False)
        lay.addWidget(self._local_status[engine])
        self._refresh_local_card(engine)

        # Dictating while ejected auto-loads the model on the pipeline
        # thread; poll so an open card flips to "Eject model" by itself.
        poll = QTimer(section_box)
        poll.timeout.connect(
            lambda eng=engine: (self._local_busy[eng]
                                or self._refresh_local_card(eng)))
        poll.start(1000)
        return frame

    def _local_model_name(self, engine):
        kind = {"stt": "stt", "llm": "cleanup"}[engine]
        return ((self._config.get(kind + "_models") or {}).get("local", "")
                or self._default_model(kind, "local"))

    def _refresh_local_card(self, engine):
        mod = self._LOCAL_ENGINES[engine]
        try:
            status = self._local_status[engine]
            button = self._local_btn[engine]
            if self._local_busy[engine]:
                label = {"install": "Downloading", "load": "Loading",
                         "eject": "Ejecting"}[self._local_busy[engine]]
                button.setText(label + "…")
                button.setEnabled(False)
                self._set_status(status,
                                 self._local_progress[engine] or label + "…",
                                 theme.MUTED)
                return
            button.setEnabled(True)
            if not mod.is_installed(self._local_model_name(engine)):
                gb = mod.install_size() / (1 << 30)
                size = f"{gb:.1f} GB" if gb >= 1 else f"{gb * 1024:.0f} MB"
                button.setText(f"Download ({size})")
                engine_kind = "GPU" if mod.have_nvidia_gpu() else "CPU"
                text, color = (f"Not installed · will use your {engine_kind}",
                               theme.MUTED)
            elif mod.is_loaded():
                button.setText("Eject model")
                build = "GPU" if mod.active_build() == "cuda" else "CPU"
                text, color = f"●  loaded · {build}", theme.GREEN
            else:
                button.setText("Load model")
                text, color = "Installed · model not loaded", theme.MUTED
            if self._local_error[engine]:
                text, color = self._local_error[engine], theme.RED
            self._set_status(status, text, color)
        except RuntimeError:
            pass  # the Providers section was rebuilt mid-refresh

    def _on_local_action(self, engine):
        mod = self._LOCAL_ENGINES[engine]
        if self._local_busy[engine]:
            return
        self._local_error[engine] = ""
        if not mod.is_installed(self._local_model_name(engine)):
            action = "install"
        elif mod.is_loaded():
            action = "eject"
        else:
            action = "load"
        self._local_busy[engine] = action
        self._local_progress[engine] = ""
        self._refresh_local_card(engine)
        threading.Thread(target=self._local_worker,
                         args=(engine, action,
                               self._local_model_name(engine)),
                         daemon=True).start()

    def _local_worker(self, engine, action, model_name):
        mod = self._LOCAL_ENGINES[engine]
        last_pct = -1

        def progress(phase, frac):
            nonlocal last_pct
            pct = int(frac * 100)
            if pct != last_pct:
                last_pct = pct
                self._local_progress_sig.emit((engine, f"{phase}… {pct}%"))

        try:
            if action == "install":
                mod.install(progress)
            elif action == "load":
                mod.load(model_name)
            else:
                mod.eject()
            result = (engine, action, True, "")
        except Exception as exc:
            result = (engine, action, False, str(exc))
        self._local_done_sig.emit(result)

    def _on_local_progress(self, payload):
        engine, text = payload
        self._local_progress[engine] = text
        self._refresh_local_card(engine)

    def _on_local_done(self, result):
        engine, action, ok, message = result
        self._local_busy[engine] = None
        self._local_progress[engine] = ""
        self._local_error[engine] = "" if ok else message
        # Load/Eject is a pure runtime action; startup behavior is owned
        # by the "Load model on startup" toggle alone.
        self._refresh_local_card(engine)

    # --- About -------------------------------------------------------------------

    def _build_about(self):
        box = QWidget()
        col = QVBoxLayout(box)
        col.setContentsMargins(0, 0, 0, 0)
        col.addStretch(1)
        icon = QLabel()
        icon.setPixmap(_pil_pixmap(load_app_image(64)))
        icon.setAlignment(Qt.AlignHCenter)
        col.addWidget(icon)
        col.addSpacing(3)
        name = QLabel("Undertone")
        name.setStyleSheet('font-family: "Segoe UI Semibold";'
                           'font-size: 16pt; background: transparent;')
        name.setAlignment(Qt.AlignHCenter)
        col.addWidget(name)
        version = hint_label(f"Version {APP_VERSION}")
        version.setAlignment(Qt.AlignHCenter)
        col.addWidget(version)
        col.addSpacing(5)
        tagline = QLabel("Push-to-talk dictation for Windows.")
        tagline.setStyleSheet(f"color: {theme.SUBTEXT};"
                              "background: transparent;")
        tagline.setAlignment(Qt.AlignHCenter)
        col.addWidget(tagline)
        col.addSpacing(10)
        description = hint_label(
            "Hold your shortcut, speak, release — the transcript is typed "
            "into whatever text box has focus. Audio is sent only to your "
            "chosen provider, only while you dictate. Your API keys and "
            "settings stay on this computer.")
        description.setAlignment(Qt.AlignHCenter)
        description.setMaximumWidth(400)
        holder = QWidget()
        holder_lay = QHBoxLayout(holder)
        holder_lay.setContentsMargins(0, 0, 0, 0)
        holder_lay.addStretch(1)
        holder_lay.addWidget(description)
        holder_lay.addStretch(1)
        col.addWidget(holder)
        col.addSpacing(10)
        links = QHBoxLayout()
        links.addStretch(1)
        links.addWidget(link_label("Open settings folder",
                                   self._open_config_folder))
        links.addWidget(hint_label("·", wrap=False))
        links.addWidget(link_label("View log", self._open_log))
        links.addStretch(1)
        links_holder = QWidget()
        links_holder.setLayout(links)
        col.addWidget(links_holder)
        col.addStretch(1)
        dev = QHBoxLayout()
        dev.setContentsMargins(0, 0, 0, 0)
        dev.setSpacing(8)
        dev.addStretch(1)
        dev.addWidget(hint_label("Dev mode", wrap=False))
        dev_toggle = Toggle(self._config.get("dev_mode", False),
                            lambda on: self._apply(dev_mode=on))
        dev_toggle.setToolTip(
            "Also show log warnings and errors on the status pill")
        dev.addWidget(dev_toggle)
        dev_holder = QWidget()
        dev_holder.setLayout(dev)
        col.addWidget(dev_holder)
        return box

    def _open_config_folder(self):
        os.startfile(CONFIG_PATH.parent)

    def _open_log(self):
        log = CONFIG_PATH.parent / "app.log"
        os.startfile(log if log.exists() else CONFIG_PATH.parent)

    # --- Shared state helpers ----------------------------------------------------

    def _provider_key(self, provider_config_key):
        provider = self._config.get(provider_config_key, "xai")
        return self._config.get(KEY_FIELDS.get(provider, "api_key"), "")

    def _stt_configured(self):
        """Local needs no key; cloud providers need theirs."""
        return (self._config.get("provider") == "local"
                or bool(self._provider_key("provider")))

    def _setup_incomplete(self):
        return (not self._config.get("onboarded", False)
                or not self._stt_configured())

    def _cleanup_warning(self):
        if (self._config.get("ai_cleanup", True)
                and self._config.get("cleanup_provider", "xai") != "local"
                and not self._provider_key("cleanup_provider")):
            provider = self._config.get("cleanup_provider", "xai")
            name = PROVIDER_BY_ID.get(provider, provider)
            article = "an" if name[:1].lower() in "aeioux" else "a"
            return f"Needs {article} {name} API key — add one in Providers."
        return ""

    def _apply(self, **changes):
        self._config = {**self._config, **changes}
        self._on_save(self._config)
        self._flash_saved()

    def _flash_saved(self):
        if self._win is None:
            return
        self._saved_label.setText("✓ Saved")
        self._saved_label.adjustSize()
        self._position_saved()
        self._saved_label.raise_()
        self._saved_timer.start(1500)

    def _position_saved(self, _event=None):
        if self._win is None:
            return
        holder = self._content_holder
        self._saved_label.move(
            holder.width() - self._saved_label.width() - 18,
            holder.height() - self._saved_label.height() - 10)

    # --- Geometry persistence ------------------------------------------------------

    def _valid_geometry(self, value):
        if not isinstance(value, str):
            return None
        match = re.fullmatch(r"(\d+)x(\d+)([+-]\d+)([+-]\d+)", value)
        if match is None:
            return None
        width, height, x, y = map(int, match.groups())
        if width < MIN_W or height < MIN_H:
            return None
        # The title bar must land visibly on some screen.
        for screen in QGuiApplication.screens():
            area = screen.availableGeometry()
            overlap = area.intersected(QRect(x, y, width, 40))
            if overlap.width() >= 120 and overlap.height() >= 30:
                return QRect(x, y, width, height)
        return None

    def _restore_geometry(self):
        rect = self._valid_geometry(self._config.get("window_geometry"))
        if rect is None:
            area = QGuiApplication.primaryScreen().availableGeometry()
            width = min(WIN_W, area.width())
            height = min(WIN_H, area.height())
            rect = QRect(area.x() + (area.width() - width) // 2,
                         max(area.y(), area.y()
                             + (area.height() - height) // 2 - 30),
                         width, height)
        self._win.setGeometry(rect)
