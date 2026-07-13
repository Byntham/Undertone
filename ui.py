"""Tray icon and settings window for Undertone.

The settings window is a dark two-pane panel: an icon sidebar with General /
Dictionary / History / Providers / About sections and a content pane of
setting cards. All changes apply immediately (no Save/Cancel); a transient
"Saved" hint confirms each change. Styled by hand with plain tk widgets plus
Pillow-rendered imagery (tray icon, toggles, pill buttons, nav glyphs)
supersampled 4x for crisp edges. All pixel measures go through theme.sc()
so the window renders correctly on high-DPI displays.

Thread-safety: open() may be called from the pystray thread; work is
marshalled onto the Tk main loop via a queue drained by root.after().
"""

import pathlib
import queue
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
import webbrowser
from typing import Callable, List, Optional, Tuple

import keyboard
import pyperclip
import pystray
from PIL import Image, ImageDraw, ImageTk

import autostart
from config import APP_VERSION

from theme import (ACCENT, ACCENT_DOWN, ACCENT_HOVER, BANNER_BG,
                   BANNER_BORDER, BASE, CARD, CARD_BORDER, GREEN, INK, MANTLE,
                   MUTED, RED, SUBTEXT, SURFACE0, SURFACE1, TEXT, sc, scale)

FONT = ("Segoe UI", 10)
HEADER_FONT = ("Segoe UI Semibold", 15)
CARD_TITLE_FONT = ("Segoe UI Semibold", 10)
LABEL_FONT = ("Segoe UI", 10)
HINT_FONT = ("Segoe UI", 9)
GROUP_FONT = ("Segoe UI Semibold", 9)
BTN_FONT = ("Segoe UI Semibold", 10)
SMALL_BTN_FONT = ("Segoe UI Semibold", 9)
NAV_FONT = ("Segoe UI", 10)
NAV_ACTIVE_FONT = ("Segoe UI Semibold", 10)
TITLE_FONT = ("Segoe UI Semibold", 12)
KEY_FONT = ("Segoe UI Semibold", 10)

WIN_W, WIN_H = 780, 724
SIDEBAR_W = 200
HAIR = max(1, sc(1))     # hairline border width in real pixels

LANGUAGES = [
    ("English", "en"), ("Arabic", "ar"), ("Chinese", "zh"), ("Danish", "da"),
    ("Dutch", "nl"), ("Finnish", "fi"), ("French", "fr"), ("German", "de"),
    ("Hindi", "hi"), ("Italian", "it"), ("Japanese", "ja"), ("Korean", "ko"),
    ("Norwegian", "no"), ("Polish", "pl"), ("Portuguese", "pt"),
    ("Russian", "ru"), ("Spanish", "es"), ("Swedish", "sv"),
    ("Turkish", "tr"), ("Ukrainian", "uk"),
]
LANG_BY_CODE = {code: name for name, code in LANGUAGES}

PROVIDERS_UI = [("xAI", "xai"), ("OpenAI", "openai"), ("OpenRouter", "openrouter")]
PROVIDER_BY_ID = {pid: name for name, pid in PROVIDERS_UI}
# provider id -> the config key holding that provider's API key.
KEY_FIELD_BY_PROVIDER = {
    "xai": "api_key", "openai": "openai_api_key", "openrouter": "openrouter_api_key",
}
PROVIDER_LINKS = [
    ("console.x.ai", "https://console.x.ai"),
    ("platform.openai.com", "https://platform.openai.com"),
    ("openrouter.ai", "https://openrouter.ai"),
]

SECTIONS = ["General", "Dictionary", "History", "Providers", "About"]


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def pretty_combo(combo: str) -> str:
    """'ctrl+alt+v' -> 'Ctrl + Alt + V', 'right ctrl' -> 'Right Ctrl'."""
    parts = [p.strip() for p in combo.split("+") if p.strip()]
    return " + ".join(p.title() for p in parts)


# --- Pillow-rendered imagery -------------------------------------------------

def _draw_mic(d: ImageDraw.ImageDraw, size: int, color, bg=None):
    """Microphone glyph within a size x size box (supersampled coords)."""
    def x(f):
        return f * size
    if bg is not None:
        d.rounded_rectangle((0, 0, size - 1, size - 1),
                            radius=int(0.22 * size), fill=bg)
    # Capsule body.
    d.rounded_rectangle((x(0.40), x(0.16), x(0.60), x(0.55)),
                        radius=int(0.10 * size), fill=color)
    # Cradle arc.
    d.arc((x(0.30), x(0.30), x(0.70), x(0.66)), start=0, end=180,
          fill=color, width=int(0.045 * size))
    # Stem and base.
    d.rounded_rectangle((x(0.485), x(0.66), x(0.515), x(0.78)),
                        radius=int(0.01 * size), fill=color)
    d.rounded_rectangle((x(0.38), x(0.78), x(0.62), x(0.82)),
                        radius=int(0.02 * size), fill=color)


def make_tray_image(size: int = 64) -> Image.Image:
    """Tray icon: dark rounded square with a light mic, 4x supersampled."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    _draw_mic(ImageDraw.Draw(img), s, _rgb(TEXT), bg=_rgb(BASE))
    return img.resize((size, size), Image.LANCZOS)


ASSETS_DIR = pathlib.Path(__file__).resolve().parent / "assets"
ICON_PNG = ASSETS_DIR / "icon.png"
ICON_ICO = ASSETS_DIR / "icon.ico"


def load_app_image(size: int = 64) -> Image.Image:
    """The Undertone app icon, falling back to the drawn mic glyph."""
    try:
        with Image.open(ICON_PNG) as img:
            return img.convert("RGBA").resize((size, size), Image.LANCZOS)
    except OSError:
        return make_tray_image(size)


def _toggle_images(bg=BASE):
    """(off, on) PhotoImages for a switch, rendered on the given background."""
    size = (sc(40), sc(22))
    out = []
    w, h = size[0] * 4, size[1] * 4
    for on in (False, True):
        img = Image.new("RGB", (w, h), _rgb(bg))
        d = ImageDraw.Draw(img)
        track = _rgb(ACCENT) if on else _rgb(SURFACE1)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=track)
        knob_r = h // 2 - 8
        cx = (w - h // 2) if on else (h // 2)
        knob = _rgb(INK) if on else _rgb(TEXT)
        d.ellipse((cx - knob_r, h // 2 - knob_r, cx + knob_r, h // 2 + knob_r),
                  fill=knob)
        out.append(ImageTk.PhotoImage(img.resize(size, Image.LANCZOS)))
    return out


def _round_img(w, h, radius, fill, outline=None, bg=BASE):
    """A rounded rectangle rendered on a solid background, 4x supersampled."""
    ss = 4
    img = Image.new("RGB", (w * ss, h * ss), _rgb(bg))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=radius * ss,
                        fill=_rgb(fill),
                        outline=_rgb(outline) if outline else None,
                        width=ss * max(1, round(scale())))
    return img.resize((w, h), Image.LANCZOS)


def _nav_glyph(name: str, color: str, size: int) -> Image.Image:
    """A simple 4x-supersampled line glyph for the sidebar."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = _rgb(color) + (255,)
    lw = max(2, int(0.085 * s))

    def x(f):
        return f * s

    if name == "General":        # slider rails with knobs
        for fy, fx in ((0.22, 0.64), (0.50, 0.34), (0.78, 0.70)):
            d.line((x(0.10), x(fy), x(0.90), x(fy)), fill=c, width=lw)
            r = 0.105 * s
            d.ellipse((x(fx) - r, x(fy) - r, x(fx) + r, x(fy) + r), fill=c)
    elif name == "Dictionary":   # book with a spine
        d.rounded_rectangle((x(0.16), x(0.10), x(0.84), x(0.90)),
                            radius=int(0.10 * s), outline=c, width=lw)
        d.line((x(0.34), x(0.10), x(0.34), x(0.90)), fill=c, width=lw)
    elif name == "History":      # clock
        m = 0.10 * s
        d.ellipse((m, m, s - m, s - m), outline=c, width=lw)
        d.line((x(0.5), x(0.52), x(0.5), x(0.26)), fill=c, width=lw)
        d.line((x(0.5), x(0.52), x(0.68), x(0.60)), fill=c, width=lw)
    elif name == "Providers":    # cloud silhouette
        d.ellipse((x(0.08), x(0.40), x(0.56), x(0.82)), fill=c)
        d.ellipse((x(0.30), x(0.20), x(0.80), x(0.70)), fill=c)
        d.ellipse((x(0.54), x(0.42), x(0.94), x(0.80)), fill=c)
        d.rectangle((x(0.26), x(0.58), x(0.76), x(0.82)), fill=c)
    else:                        # info
        m = 0.10 * s
        d.ellipse((m, m, s - m, s - m), outline=c, width=lw)
        r = 0.065 * s
        d.ellipse((x(0.5) - r, x(0.30) - r, x(0.5) + r, x(0.30) + r), fill=c)
        d.line((x(0.5), x(0.44), x(0.5), x(0.72)), fill=c, width=lw)
    return img.resize((size, size), Image.LANCZOS)


def apply_dark_titlebar(win):
    """Give a Toplevel a dark title bar via the DWM immersive-dark attribute."""
    try:
        import ctypes
        from ctypes import wintypes
        win.update_idletasks()
        hwnd = ctypes.windll.user32.GetParent(win.winfo_id())
        value = ctypes.c_int(1)
        for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE
            if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                wintypes.HWND(hwnd), attr,
                ctypes.byref(value), ctypes.sizeof(value),
            ) == 0:
                break
        win.withdraw()   # DWM repaints the frame on remap
        win.deiconify()
    except Exception:
        pass


# --- Tray ---------------------------------------------------------------------

def create_tray(on_settings: Callable[[], None], on_quit: Callable[[], None]) -> pystray.Icon:
    """Build (but do not run) the system tray icon."""
    menu = pystray.Menu(
        pystray.MenuItem("Settings…", lambda icon, item: on_settings(), default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda icon, item: on_quit()),
    )
    return pystray.Icon(
        "Undertone",
        icon=load_app_image(),
        title="Undertone",
        menu=menu,
    )


# --- Pill buttons --------------------------------------------------------------

class RoundButton(tk.Label):
    """A pill-shaped button: Pillow-rendered background + Tk-rendered text.

    Rendered as a Label with compound="center" so the text stays crisp while
    the rounded background gets 4x-supersampled anti-aliasing. Supports
    normal / hover / pressed / disabled states and set_text().
    """

    def __init__(self, parent, text, command=None, kind="surface",
                 small=False, bg=BASE, width=None):
        self._kind = kind
        self._command = command
        self._font = SMALL_BTN_FONT if small else BTN_FONT
        self._h = sc(26) if small else sc(32)
        self._pad = sc(13) if small else sc(17)
        self._bg = bg
        self._fixed_w = width
        self._enabled = True
        self._state = "normal"
        super().__init__(parent, text=text, compound="center",
                         font=self._font, bd=0, bg=bg, cursor="hand2")
        self._render(text)
        self._apply_state("normal")
        self.bind("<Enter>", lambda _e: self._hover(True))
        self.bind("<Leave>", lambda _e: self._hover(False))
        self.bind("<Button-1>", self._press)
        self.bind("<ButtonRelease-1>", self._release)

    def _render(self, text):
        f = tkfont.Font(font=self._font)
        w = self._fixed_w or max(f.measure(text) + 2 * self._pad, self._h * 2)
        if self._kind == "accent":
            spec = {"normal": (ACCENT, None, INK),
                    "hover": (ACCENT_HOVER, None, INK),
                    "down": (ACCENT_DOWN, None, INK),
                    "disabled": (SURFACE0, None, MUTED)}
        else:
            spec = {"normal": (SURFACE0, SURFACE1, TEXT),
                    "hover": (SURFACE1, SURFACE1, TEXT),
                    "down": (SURFACE1, SURFACE1, TEXT),
                    "disabled": (SURFACE0, SURFACE0, MUTED)}
        self._imgs, self._fgs = {}, {}
        for state, (fill, outline, fg) in spec.items():
            self._imgs[state] = ImageTk.PhotoImage(
                _round_img(w, self._h, self._h // 2, fill, outline, bg=self._bg))
            self._fgs[state] = fg
        self.config(text=text)

    def _apply_state(self, state):
        self._state = state
        self.config(image=self._imgs[state], fg=self._fgs[state],
                    cursor="hand2" if self._enabled else "")

    def _hover(self, inside):
        if self._enabled:
            self._apply_state("hover" if inside else "normal")

    def _press(self, _e):
        if self._enabled:
            self._apply_state("down")

    def _release(self, e):
        if not self._enabled:
            return
        inside = 0 <= e.x <= self.winfo_width() and 0 <= e.y <= self.winfo_height()
        self._apply_state("hover" if inside else "normal")
        if inside and self._command is not None:
            self._command()

    def set_text(self, text):
        self._render(text)
        self._apply_state(self._state if self._enabled else "disabled")

    def enable(self):
        self._enabled = True
        self._apply_state("normal")

    def disable(self):
        self._enabled = False
        self._apply_state("disabled")


# --- Settings window ------------------------------------------------------------

class SettingsWindow:
    """A single reusable settings Toplevel, editable from any thread."""

    def __init__(
        self,
        root: tk.Tk,
        config: dict,
        on_save: Callable[[dict], None],
        on_capture_start: Optional[Callable[[], None]] = None,
        on_capture_end: Optional[Callable[[], None]] = None,
        history_getter: Optional[Callable[[], List[Tuple[float, str]]]] = None,
        on_repaste: Optional[Callable[[str], None]] = None,
        config_getter: Optional[Callable[[], dict]] = None,
    ):
        self._root = root
        self._config = config
        self._config_getter = config_getter
        self._on_save = on_save
        self._on_capture_start = on_capture_start
        self._on_capture_end = on_capture_end
        self._history_getter = history_getter
        self._on_repaste = on_repaste
        self._win = None
        self._queue: "queue.Queue" = queue.Queue()
        self._capturing = False
        self._testing = False
        self._saved_after_id = None
        self._root.after(50, self._drain)

    # --- Public, thread-safe API ------------------------------------------

    def open(self):
        self._queue.put(("open", None))

    # --- Queue plumbing -----------------------------------------------------

    def _drain(self):
        try:
            while True:
                cmd, payload = self._queue.get_nowait()
                if cmd == "open":
                    self._open()
                elif cmd == "captured":
                    self._on_captured(payload)
                elif cmd == "tested":
                    self._on_tested(payload)
        except queue.Empty:
            pass
        finally:
            self._root.after(50, self._drain)

    # --- Window construction -------------------------------------------------

    def _open(self):
        # Re-read the authoritative config on every open: the app may have
        # changed it since (this window's copy is otherwise private).
        if self._config_getter is not None:
            self._config = dict(self._config_getter())
        if self._win is not None and self._win.winfo_exists():
            self._raise()
            return

        win = tk.Toplevel(self._root)
        self._win = win
        win.title("Undertone")
        try:
            win.iconbitmap(str(ICON_ICO))
        except tk.TclError:
            pass
        win.configure(bg=BASE)
        win.resizable(False, False)
        win.protocol("WM_DELETE_WINDOW", self._close)
        win.geometry(f"{sc(WIN_W)}x{sc(WIN_H)}")

        # Sidebar ------------------------------------------------------------
        side = tk.Frame(win, bg=MANTLE, width=sc(SIDEBAR_W))
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        brand = tk.Frame(side, bg=MANTLE)
        brand.pack(fill="x", padx=sc(18), pady=(sc(20), sc(16)))
        self._brand_icon = ImageTk.PhotoImage(load_app_image(sc(30)))
        tk.Label(brand, image=self._brand_icon, bg=MANTLE).pack(side="left")
        tk.Label(brand, text="Undertone", bg=MANTLE, fg=TEXT,
                 font=TITLE_FONT, anchor="w").pack(side="left", padx=(sc(9), 0))

        tk.Label(side, text=f"Version {APP_VERSION}", bg=MANTLE, fg=MUTED,
                 font=("Segoe UI", 8), anchor="w",
                 padx=sc(18)).pack(side="bottom", fill="x", pady=(0, sc(14)))

        self._nav_items = {}
        self._nav_glyphs = {}    # (section, state) -> PhotoImage
        self._content = tk.Frame(win, bg=BASE)
        self._content.pack(side="left", fill="both", expand=True)

        for section in SECTIONS:
            self._nav_items[section] = self._make_nav_item(side, section)

        self._select_section("General")

        apply_dark_titlebar(self._win)
        self._set_window_icons()
        self._center()
        self._raise()

    def _set_window_icons(self):
        """Set crisp small/big window icons via WM_SETICON.

        Tk's iconbitmap only registers the 16px frame, which Windows then
        scales up for the taskbar — blurry. Loading each size explicitly
        from the .ico lets the title bar and taskbar use exact frames.
        """
        try:
            import ctypes
            IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x10, 0x80
            SM_CXSMICON, SM_CXICON = 49, 11
            user32 = ctypes.windll.user32
            self._win.update_idletasks()
            hwnd = user32.GetParent(self._win.winfo_id())
            for which, metric in ((0, SM_CXSMICON), (1, SM_CXICON)):
                size = user32.GetSystemMetrics(metric)
                hicon = user32.LoadImageW(None, str(ICON_ICO), IMAGE_ICON,
                                          size, size, LR_LOADFROMFILE)
                if hicon:
                    user32.SendMessageW(hwnd, WM_SETICON, which, hicon)
        except Exception:
            pass

    def _glyph(self, section, color):
        key = (section, color)
        if key not in self._nav_glyphs:
            self._nav_glyphs[key] = ImageTk.PhotoImage(
                _nav_glyph(section, color, sc(17)))
        return self._nav_glyphs[key]

    def _make_nav_item(self, parent, section):
        row = tk.Frame(parent, bg=MANTLE, cursor="hand2")
        row.pack(fill="x", pady=1)
        bar = tk.Frame(row, bg=MANTLE, width=sc(3))
        bar.pack(side="left", fill="y")
        icon = tk.Label(row, image=self._glyph(section, SUBTEXT), bg=MANTLE,
                        padx=0)
        icon.pack(side="left", padx=(sc(15), 0), pady=sc(8))
        lbl = tk.Label(row, text=section, bg=MANTLE, fg=SUBTEXT,
                       font=NAV_FONT, anchor="w", padx=sc(10), pady=sc(8))
        lbl.pack(side="left", fill="x", expand=True)

        def enter(_):
            if getattr(self, "_active_section", None) != section:
                for w in (row, lbl, icon):
                    w.configure(bg="#1f1f30")

        def leave(_):
            if getattr(self, "_active_section", None) != section:
                for w in (row, lbl, icon):
                    w.configure(bg=MANTLE)
        for w in (row, lbl, bar, icon):
            w.bind("<Enter>", enter)
            w.bind("<Leave>", leave)
            w.bind("<Button-1>", lambda _e, s=section: self._select_section(s))
        return {"row": row, "bar": bar, "label": lbl, "icon": icon}

    def _select_section(self, section):
        self._active_section = section
        for name, item in self._nav_items.items():
            active = name == section
            bg = SURFACE0 if active else MANTLE
            item["row"].configure(bg=bg)
            item["label"].configure(bg=bg, fg=TEXT if active else SUBTEXT,
                                    font=NAV_ACTIVE_FONT if active else NAV_FONT)
            item["icon"].configure(
                bg=bg, image=self._glyph(name, ACCENT if active else SUBTEXT))
            item["bar"].configure(bg=ACCENT if active else bg)
        for child in self._content.winfo_children():
            child.destroy()
        pane = tk.Frame(self._content, bg=BASE)
        pane.pack(fill="both", expand=True, padx=sc(28), pady=(sc(20), sc(14)))
        if section == "General":
            self._build_general(pane)
        elif section == "Dictionary":
            self._build_dictionary(pane)
        elif section == "History":
            self._build_history(pane)
        elif section == "Providers":
            self._build_providers(pane)
        else:
            self._build_about(pane)
        # Saved hint anchored bottom-right of the content pane.
        self._saved_lbl = tk.Label(self._content, text="", bg=BASE, fg=GREEN,
                                   font=HINT_FONT)
        self._saved_lbl.place(relx=1.0, rely=1.0, x=-sc(18), y=-sc(12),
                              anchor="se")

    # --- Building blocks --------------------------------------------------------

    def _header(self, parent, text):
        tk.Label(parent, text=text, bg=BASE, fg=TEXT, font=HEADER_FONT,
                 anchor="w").pack(fill="x", pady=(0, sc(10)))

    def _group(self, parent, text, first=False):
        tk.Label(parent, text=text, bg=BASE, fg=SUBTEXT, font=GROUP_FONT,
                 anchor="w").pack(fill="x", pady=(0 if first else sc(10), sc(5)))

    def _hint(self, parent, text, pady=(5, 0), bg=BASE, wrap=470):
        lbl = tk.Label(parent, text=text, bg=bg, fg=MUTED, font=HINT_FONT,
                       anchor="w", justify="left", wraplength=sc(wrap))
        lbl.pack(fill="x", pady=pady)
        return lbl

    def _card(self, parent, pady=(0, 8)):
        """A bordered, elevated card; returns the padded inner frame."""
        outer = tk.Frame(parent, bg=CARD, highlightthickness=HAIR,
                         highlightbackground=CARD_BORDER)
        outer.pack(fill="x", pady=(sc(pady[0]), sc(pady[1])))
        inner = tk.Frame(outer, bg=CARD)
        inner.pack(fill="both", expand=True, padx=sc(14), pady=sc(9))
        return inner

    def _row_card(self, parent, title, hint=None, wrap=310):
        """A setting card: title + hint on the left, control slot on the right.

        Returns (right_frame, [text widgets]) so callers can add bindings.
        """
        inner = self._card(parent)
        right = tk.Frame(inner, bg=CARD)
        right.pack(side="right", padx=(sc(14), 0))
        left = tk.Frame(inner, bg=CARD)
        left.pack(side="left", fill="x", expand=True)
        widgets = [inner, left]
        t = tk.Label(left, text=title, bg=CARD, fg=TEXT, font=CARD_TITLE_FONT,
                     anchor="w")
        t.pack(fill="x")
        widgets.append(t)
        if hint:
            h = tk.Label(left, text=hint, bg=CARD, fg=MUTED, font=HINT_FONT,
                         anchor="w", justify="left", wraplength=sc(wrap))
            h.pack(fill="x", pady=(sc(2), 0))
            widgets.append(h)
        return right, widgets

    def _toggle_card(self, parent, title, hint, initial, on_change):
        """A setting card with a switch; the whole card toggles."""
        right, widgets = self._row_card(parent, title, hint)
        state = {"on": bool(initial)}
        sw = tk.Label(right, image=self._toggle_imgs[int(state["on"])],
                      bg=CARD, cursor="hand2")
        sw.pack()

        def toggle(_e=None):
            state["on"] = not state["on"]
            sw.config(image=self._toggle_imgs[int(state["on"])])
            on_change(state["on"])
        for w in widgets + [sw, right]:
            w.bind("<Button-1>", toggle)
            w.configure(cursor="hand2")
        return state, sw

    def _dropdown(self, parent, text, on_open, width=170):
        """A fixed-width dark dropdown control; returns its value label."""
        ctrl = tk.Frame(parent, bg=SURFACE0, cursor="hand2",
                        highlightthickness=HAIR, highlightbackground=SURFACE1,
                        width=sc(width), height=sc(30))
        ctrl.pack_propagate(False)
        ctrl.pack()
        lbl = tk.Label(ctrl, text=text, bg=SURFACE0, fg=TEXT, font=FONT,
                       anchor="w", padx=sc(11))
        lbl.pack(side="left", fill="both", expand=True)
        caret = tk.Label(ctrl, text="⌄", bg=SURFACE0, fg=SUBTEXT, font=FONT,
                         padx=sc(9))
        caret.pack(side="right", fill="y")

        def hover(bg):
            def fn(_e):
                for w in (ctrl, lbl, caret):
                    w.configure(bg=bg)
            return fn
        for w in (ctrl, lbl, caret):
            w.bind("<Button-1>", lambda _e: on_open(ctrl))
            w.bind("<Enter>", hover(SURFACE1))
            w.bind("<Leave>", hover(SURFACE0))
        return lbl

    def _menu(self, entries):
        """A styled popup menu; entries = [(label, command)]."""
        menu = tk.Menu(
            self._win, tearoff=0, bg=SURFACE0, fg=TEXT,
            activebackground=ACCENT, activeforeground=INK,
            relief="flat", bd=0, font=FONT,
        )
        for label, command in entries:
            menu.add_command(label=f"  {label}", command=command)
        return menu

    def _popup_under(self, menu, ctrl):
        x = ctrl.winfo_rootx()
        y = ctrl.winfo_rooty() + ctrl.winfo_height() + sc(2)
        menu.tk_popup(x, y)

    def _entry(self, parent, var, show=None, bg=SURFACE0):
        return tk.Entry(
            parent, textvariable=var, font=FONT, show=show or "", bg=bg,
            fg=TEXT, insertbackground=TEXT, relief="flat",
            highlightthickness=HAIR, highlightbackground=SURFACE1,
            highlightcolor=ACCENT)

    # --- General -----------------------------------------------------------------

    def _build_general(self, pane):
        pane = self._scroll_pane(pane)
        self._header(pane, "General")

        provider = self._config.get("provider", "xai")
        key_field = KEY_FIELD_BY_PROVIDER.get(provider, "api_key")
        if not self._config.get(key_field, ""):
            self._setup_banner(pane)

        self._shortcut_rows = {}
        self._group(pane, "Shortcuts", first=True)
        self._shortcut_card(
            pane, "Push-to-talk", "hotkey",
            "Hold to dictate, release to transcribe. Double-tap to lock "
            "hands-free; tap again to finish.")
        self._shortcut_card(
            pane, "Re-paste last dictation", "repaste_hotkey",
            "Pastes your most recent dictation again, wherever your "
            "cursor is now.")

        self._group(pane, "Dictation")
        self._toggle_imgs = _toggle_images(bg=CARD)

        right, _ = self._row_card(pane, "Spoken language",
                                  "The language you dictate in.")
        code = self._config.get("language", "en")
        self._lang_lbl = self._dropdown(
            right, LANG_BY_CODE.get(code, code), self._open_lang_menu)

        self._config_toggle_card(
            pane, "Smart formatting", "smart_formatting",
            "Match spacing and capitalization to where you're typing.")
        self._config_toggle_card(
            pane, "AI cleanup", "ai_cleanup",
            "Remove fillers and false starts with a fast grok model. Sends "
            "the text near your cursor to your cleanup provider.")
        self._config_toggle_card(
            pane, "Sound cues", "sound_cues",
            "Soft tick when recording starts and stops.")

        self._group(pane, "System")
        auto_on = False
        try:
            auto_on = autostart.is_enabled()
        except Exception:
            pass
        auto = {}

        def set_autostart(on):
            try:
                autostart.set_enabled(on)
                self._flash_saved()
            except Exception:
                # Registry write failed — snap the switch back to reality.
                auto["state"]["on"] = not on
                auto["sw"].config(image=self._toggle_imgs[int(not on)])
        state, sw = self._toggle_card(
            pane, "Start with Windows",
            "Launch quietly in the tray when you sign in.",
            auto_on, set_autostart)
        auto.update(state=state, sw=sw)

        self._bind_wheel(pane)

    def _setup_banner(self, pane):
        outer = tk.Frame(pane, bg=BANNER_BG, highlightthickness=HAIR,
                         highlightbackground=BANNER_BORDER)
        outer.pack(fill="x", pady=(0, sc(12)))
        inner = tk.Frame(outer, bg=BANNER_BG)
        inner.pack(fill="x", padx=sc(14), pady=sc(12))
        RoundButton(inner, "Open Providers",
                    lambda: self._select_section("Providers"),
                    kind="accent", small=True,
                    bg=BANNER_BG).pack(side="right", padx=(sc(14), 0))
        left = tk.Frame(inner, bg=BANNER_BG)
        left.pack(side="left", fill="x", expand=True)
        tk.Label(left, text="Finish setting up Undertone", bg=BANNER_BG,
                 fg=TEXT, font=CARD_TITLE_FONT, anchor="w").pack(fill="x")
        tk.Label(left, text="Add an API key for your transcription provider "
                            "to start dictating.",
                 bg=BANNER_BG, fg=SUBTEXT, font=HINT_FONT, anchor="w",
                 justify="left", wraplength=sc(330)).pack(
            fill="x", pady=(sc(2), 0))

    def _config_toggle_card(self, pane, title, key, hint):
        self._toggle_card(pane, title, hint,
                          self._config.get(key, True),
                          lambda on, k=key: self._apply(**{k: on}))

    def _shortcut_card(self, pane, title, config_key, hint):
        right, widgets = self._row_card(pane, title, hint, wrap=270)
        left = widgets[1]
        combo = self._config.get(config_key, "")
        box = tk.Frame(right, bg=SURFACE0, highlightthickness=HAIR,
                       highlightbackground=SURFACE1)
        box.pack(side="left")
        lbl = tk.Label(box, text=pretty_combo(combo) or "None", bg=SURFACE0,
                       fg=TEXT, font=KEY_FONT, padx=sc(14), pady=sc(5))
        lbl.pack()
        btn = RoundButton(right, "Change",
                          lambda k=config_key: self._start_capture(k),
                          small=True, bg=CARD)
        btn.pack(side="left", padx=(sc(8), 0))
        # Lives inside the card's text column so it shows up next to the
        # shortcut it belongs to; packed only when a capture fails.
        error = tk.Label(left, text="", bg=CARD, fg=RED, font=HINT_FONT,
                         anchor="w", justify="left", wraplength=sc(270))
        self._shortcut_rows[config_key] = {
            "lbl": lbl, "btn": btn, "error": error, "combo": combo,
        }

    # --- Dictionary ----------------------------------------------------------------

    def _build_dictionary(self, pane):
        pane = self._scroll_pane(pane)
        self._header(pane, "Dictionary")

        self._group(pane, "Vocabulary", first=True)
        card = self._card(pane)
        self._hint(card, "Words and names the transcriber should recognize — "
                         "sent as hints with every request.",
                   pady=(0, sc(8)), bg=CARD, wrap=470)
        row = tk.Frame(card, bg=CARD)
        row.pack(fill="x")
        self._vocab_var = tk.StringVar()
        entry = self._entry(row, self._vocab_var)
        entry.pack(side="left", fill="x", expand=True, ipady=sc(5))
        entry.bind("<Return>", lambda _e: self._add_vocab())
        RoundButton(row, "Add", self._add_vocab, kind="accent", small=True,
                    bg=CARD).pack(side="left", padx=(sc(8), 0))
        tk.Frame(card, bg=CARD, height=sc(8)).pack()
        self._vocab_inner = self._scroll_list(card, height=sc(108))
        self._render_vocab()

        self._group(pane, "Corrections")
        card2 = self._card(pane)
        self._hint(card2, "Always replace a misheard phrase with the right "
                          "one.", pady=(0, sc(8)), bg=CARD, wrap=470)
        row2 = tk.Frame(card2, bg=CARD)
        row2.pack(fill="x")
        self._corr_heard = tk.StringVar()
        self._corr_right = tk.StringVar()
        e1 = self._entry(row2, self._corr_heard)
        e1.pack(side="left", fill="x", expand=True, ipady=sc(5))
        tk.Label(row2, text="→", bg=CARD, fg=SUBTEXT, font=FONT,
                 padx=sc(8)).pack(side="left")
        e2 = self._entry(row2, self._corr_right)
        e2.pack(side="left", fill="x", expand=True, ipady=sc(5))
        e1.bind("<Return>", lambda _e: self._add_correction())
        e2.bind("<Return>", lambda _e: self._add_correction())
        RoundButton(row2, "Add", self._add_correction, kind="accent",
                    small=True, bg=CARD).pack(side="left", padx=(sc(8), 0))
        tk.Frame(card2, bg=CARD, height=sc(8)).pack()
        self._corr_inner = self._scroll_list(card2, height=sc(108))
        self._render_corrections()

        self._bind_wheel(pane)

    def _render_vocab(self):
        for w in self._vocab_inner.winfo_children():
            w.destroy()
        terms = self._config.get("vocabulary", [])
        if not terms:
            self._empty_row(self._vocab_inner, "No terms yet — add names and "
                                               "jargon the transcriber gets "
                                               "wrong.")
            return
        for term in terms:
            self._list_row(self._vocab_inner, term,
                           lambda t=term: self._remove_vocab(t))

    def _add_vocab(self):
        term = self._vocab_var.get().strip()
        terms = list(self._config.get("vocabulary", []))
        if not term or term in terms:
            self._vocab_var.set("")
            return
        terms.append(term)
        self._vocab_var.set("")
        self._apply(vocabulary=terms)
        self._render_vocab()

    def _remove_vocab(self, term):
        terms = [t for t in self._config.get("vocabulary", []) if t != term]
        self._apply(vocabulary=terms)
        self._render_vocab()

    def _render_corrections(self):
        for w in self._corr_inner.winfo_children():
            w.destroy()
        pairs = self._config.get("corrections", {})
        if not pairs:
            self._empty_row(self._corr_inner, "No corrections yet.")
            return
        for heard, right in pairs.items():
            self._list_row(self._corr_inner, f"{heard}   →   {right}",
                           lambda h=heard: self._remove_correction(h))

    def _add_correction(self):
        heard = self._corr_heard.get().strip()
        right = self._corr_right.get().strip()
        if not heard or not right:
            return
        pairs = dict(self._config.get("corrections", {}))
        pairs[heard] = right
        self._corr_heard.set("")
        self._corr_right.set("")
        self._apply(corrections=pairs)
        self._render_corrections()

    def _remove_correction(self, heard):
        pairs = {k: v for k, v in self._config.get("corrections", {}).items()
                 if k != heard}
        self._apply(corrections=pairs)
        self._render_corrections()

    # --- History -------------------------------------------------------------------

    def _build_history(self, pane):
        self._header(pane, "History")
        combo = pretty_combo(self._config.get("repaste_hotkey", ""))
        if combo:
            self._hint(pane, "Dictations from this session, newest first. "
                             f"Press {combo} anywhere to re-paste the newest "
                             "one — or click into the target app first and "
                             "use the buttons here.", pady=(0, sc(12)))
        else:
            self._hint(pane, "Dictations from this session, newest first. "
                             "Set a re-paste shortcut in General to paste "
                             "the newest one anywhere.", pady=(0, sc(12)))

        items = []
        if self._history_getter is not None:
            try:
                items = self._history_getter() or []
            except Exception:
                items = []

        inner = self._scroll_list(pane, height=sc(500))
        if not items:
            self._empty_row(inner, "Nothing dictated yet this session. Hold "
                                   "your shortcut and speak — dictations "
                                   "appear here.")
            return

        for ts, text in items:
            row = tk.Frame(inner, bg=MANTLE)
            row.pack(fill="x", pady=1)
            when = time.strftime("%H:%M", time.localtime(ts))
            tk.Label(row, text=when, bg=MANTLE, fg=MUTED, font=HINT_FONT,
                     width=6, anchor="w", padx=sc(10)).pack(side="left")
            RoundButton(row, "Paste", lambda t=text: self._repaste(t),
                        small=True, bg=MANTLE).pack(side="right",
                                                    padx=(0, sc(8)), pady=sc(3))
            RoundButton(row, "Copy", lambda t=text: self._copy(t),
                        small=True, bg=MANTLE).pack(side="right",
                                                    padx=(0, sc(6)), pady=sc(3))
            preview = text.replace("\n", " ").strip()
            if len(preview) > 46:
                preview = preview[:45] + "…"
            tk.Label(row, text=preview, bg=MANTLE, fg=TEXT, font=FONT,
                     anchor="w").pack(side="left", fill="x", expand=True,
                                      padx=(sc(4), sc(8)))

    def _copy(self, text):
        try:
            pyperclip.copy(text)
        except Exception:
            pass
        self._flash_saved()

    def _repaste(self, text):
        # Pasting while this window has focus would land in the window itself.
        # Minimize first so focus returns to the previous app, then paste.
        if self._on_repaste is None:
            return
        if self._win is not None and self._win.winfo_exists():
            self._win.iconify()
        self._root.after(600, lambda: self._on_repaste(text))

    # --- Providers -------------------------------------------------------------------

    def _build_providers(self, pane):
        body = self._scroll_pane(pane)
        self._header(body, "Providers")

        self._group(body, "Services", first=True)
        self._key_vars = {}
        self._key_status_lbls = {}
        self._model_vars = {}

        right, _ = self._row_card(body, "Transcription",
                                  "Turns your speech into text.", wrap=250)
        self._test_stt_btn = RoundButton(right, "Test",
                                         self._test_transcription,
                                         small=True, bg=CARD)
        self._test_stt_btn.pack(side="right", padx=(sc(8), 0))
        cur = self._config.get("provider", "xai")
        self._stt_dd = self._dropdown(
            right, PROVIDER_BY_ID.get(cur, cur),
            lambda c: self._open_provider_menu(c, "provider"), width=130)

        right, _ = self._row_card(body, "AI cleanup",
                                  "Polishes the wording before it's pasted.",
                                  wrap=250)
        self._test_cleanup_btn = RoundButton(right, "Test",
                                             self._test_cleanup,
                                             small=True, bg=CARD)
        self._test_cleanup_btn.pack(side="right", padx=(sc(8), 0))
        cur = self._config.get("cleanup_provider", "xai")
        self._cleanup_dd = self._dropdown(
            right, PROVIDER_BY_ID.get(cur, cur),
            lambda c: self._open_provider_menu(c, "cleanup_provider"),
            width=130)

        self._test_status = tk.Label(body, text="", bg=BASE, fg=MUTED,
                                     font=HINT_FONT, anchor="w",
                                     justify="left", wraplength=sc(470))
        self._test_status.pack(fill="x")

        self._group(body, "API keys")
        self._key_card(body, "xAI", "api_key")
        self._key_card(body, "OpenAI", "openai_api_key")
        self._key_card(body, "OpenRouter", "openrouter_api_key")

        links = tk.Frame(body, bg=BASE)
        links.pack(fill="x", pady=(sc(2), 0))
        tk.Label(links, text="Get a key:", bg=BASE, fg=MUTED,
                 font=HINT_FONT).pack(side="left", padx=(0, sc(6)))
        for i, (text, url) in enumerate(PROVIDER_LINKS):
            if i:
                tk.Label(links, text="·", bg=BASE, fg=MUTED,
                         font=HINT_FONT).pack(side="left", padx=sc(5))
            lk = tk.Label(links, text=text, bg=BASE, fg=ACCENT, font=HINT_FONT,
                          cursor="hand2")
            lk.pack(side="left")
            lk.bind("<Button-1>", lambda _e, u=url: webbrowser.open(u))

        # Advanced disclosure: model overrides (collapsed by default) ----------
        adv_toggle = tk.Label(body, text="Advanced  ▸", bg=BASE, fg=SUBTEXT,
                              font=GROUP_FONT, anchor="w", cursor="hand2")
        adv_toggle.pack(fill="x", pady=(sc(14), 0))
        adv = tk.Frame(body, bg=BASE)
        self._adv_open = False

        def toggle_adv(_e=None):
            self._adv_open = not self._adv_open
            adv_toggle.config(text="Advanced  ▾" if self._adv_open
                              else "Advanced  ▸")
            if self._adv_open:
                adv.pack(fill="x", pady=(sc(6), 0), after=adv_toggle)
            else:
                adv.pack_forget()
            self._bind_wheel(body)
        adv_toggle.bind("<Button-1>", toggle_adv)

        card = self._card(adv)
        self._stt_model_hint = self._model_row(card, "Transcription model",
                                               "stt")
        tk.Frame(card, bg=CARD, height=sc(10)).pack()
        self._cleanup_model_hint = self._model_row(card, "Cleanup model",
                                                   "cleanup")
        self._refresh_model_hints()

        self._bind_wheel(body)

    def _key_card(self, parent, name, field):
        """A provider card: name + key status, then entry / Show / Save."""
        inner = self._card(parent)
        head = tk.Frame(inner, bg=CARD)
        head.pack(fill="x")
        tk.Label(head, text=name, bg=CARD, fg=TEXT, font=CARD_TITLE_FONT,
                 anchor="w").pack(side="left")
        status = tk.Label(head, text="", bg=CARD, font=HINT_FONT, anchor="e")
        status.pack(side="right")

        row = tk.Frame(inner, bg=CARD)
        row.pack(fill="x", pady=(sc(7), 0))
        var = tk.StringVar(value=self._config.get(field, ""))
        entry = self._entry(row, var, show="•")
        entry.pack(side="left", fill="x", expand=True, ipady=sc(4))
        entry.bind("<Return>", lambda _e, f=field: self._save_key(f))
        save_btn = RoundButton(row, "Save",
                               lambda f=field: self._save_key(f),
                               kind="accent", small=True, bg=CARD)
        save_btn.pack(side="right", padx=(sc(6), 0))
        show_btn = RoundButton(row, "Show", None, small=True, bg=CARD)
        show_btn._command = lambda: self._toggle_show(entry, show_btn)
        show_btn.pack(side="right", padx=(sc(6), 0))

        self._key_vars[field] = var
        self._key_status_lbls[field] = status
        self._refresh_key_status(field)

    def _refresh_key_status(self, field):
        key = self._config.get(field, "")
        lbl = self._key_status_lbls[field]
        if key:
            lbl.config(text=f"●  saved · ····{key[-4:]}", fg=GREEN)
        else:
            lbl.config(text="no key", fg=MUTED)

    def _open_provider_menu(self, ctrl, config_key):
        lbl = self._stt_dd if config_key == "provider" else self._cleanup_dd
        menu = self._menu([
            (name, lambda n=name, p=pid: self._pick_provider(
                lbl, config_key, n, p))
            for name, pid in PROVIDERS_UI])
        self._popup_under(menu, ctrl)

    def _pick_provider(self, lbl, config_key, name, pid):
        lbl.config(text=name)
        self._apply(**{config_key: pid})
        # Advanced fields show the newly selected provider's own override.
        for kind, var in self._model_vars.items():
            var.set(self._model_override(kind))
        self._refresh_model_hints()

    def _model_row(self, parent, label, kind):
        """A model-override entry (per-provider) with Save and a live hint."""
        tk.Label(parent, text=label, bg=CARD, fg=SUBTEXT, font=LABEL_FONT,
                 anchor="w").pack(fill="x", pady=(0, sc(3)))
        row = tk.Frame(parent, bg=CARD)
        row.pack(fill="x")
        var = tk.StringVar(value=self._model_override(kind))
        entry = self._entry(row, var)
        entry.pack(side="left", fill="x", expand=True, ipady=sc(4))
        entry.bind("<Return>", lambda _e: self._save_model(kind, var))
        RoundButton(row, "Save", lambda: self._save_model(kind, var),
                    kind="accent", small=True,
                    bg=CARD).pack(side="right", padx=(sc(6), 0))
        hint = tk.Label(parent, text="", bg=CARD, fg=MUTED, font=HINT_FONT,
                        anchor="w", justify="left", wraplength=sc(440))
        hint.pack(fill="x", pady=(sc(3), 0))
        self._model_vars[kind] = var
        return hint

    def _model_provider(self, kind):
        pkey = "provider" if kind == "stt" else "cleanup_provider"
        return self._config.get(pkey, "xai")

    def _model_override(self, kind):
        models = self._config.get(kind + "_models") or {}
        return models.get(self._model_provider(kind), "")

    # --- About -----------------------------------------------------------------

    def _build_about(self, pane):
        box = tk.Frame(pane, bg=BASE)
        box.pack(expand=True)
        self._about_icon = ImageTk.PhotoImage(load_app_image(sc(64)))
        tk.Label(box, image=self._about_icon, bg=BASE).pack(pady=(sc(30), sc(12)))
        tk.Label(box, text="Undertone", bg=BASE, fg=TEXT,
                 font=("Segoe UI Semibold", 16)).pack()
        tk.Label(box, text=f"Version {APP_VERSION}", bg=BASE, fg=MUTED,
                 font=HINT_FONT).pack(pady=(sc(2), sc(14)))
        tk.Label(box, text="Push-to-talk dictation for Windows.", bg=BASE,
                 fg=SUBTEXT, font=FONT).pack()
        tk.Label(box,
                 text="Hold your shortcut, speak, release — the transcript "
                      "is typed into whatever text box has focus. Audio is "
                      "sent only to your chosen provider, only while you "
                      "dictate. Your API keys and settings stay on this "
                      "computer.",
                 bg=BASE, fg=MUTED, font=HINT_FONT, wraplength=sc(400),
                 justify="center").pack(pady=(sc(10), sc(20)))

        links = tk.Frame(box, bg=BASE)
        links.pack()
        for i, (text, cmd) in enumerate((
            ("Open settings folder", self._open_config_folder),
            ("View log", self._open_log),
        )):
            if i:
                tk.Label(links, text="·", bg=BASE, fg=MUTED,
                         font=HINT_FONT).pack(side="left", padx=sc(8))
            lk = tk.Label(links, text=text, bg=BASE, fg=ACCENT,
                          font=HINT_FONT, cursor="hand2")
            lk.pack(side="left")
            lk.bind("<Button-1>", lambda _e, c=cmd: c())

    def _open_config_folder(self):
        import os
        from config import CONFIG_PATH
        os.startfile(CONFIG_PATH.parent)

    def _open_log(self):
        import os
        from config import CONFIG_PATH
        log = CONFIG_PATH.parent / "app.log"
        if log.exists():
            os.startfile(log)
        else:
            os.startfile(CONFIG_PATH.parent)

    # --- Scroll panes -------------------------------------------------------------

    def _bind_wheel(self, widget):
        """Recursively route mouse-wheel events to the section scroll pane.

        Subtrees that own their wheel (inner _scroll_list regions) are
        skipped so their bindings aren't clobbered.
        """
        if getattr(widget, "_own_wheel", False):
            return
        widget.bind("<MouseWheel>", self._scroll_wheel)
        for child in widget.winfo_children():
            self._bind_wheel(child)

    def _scroll_pane(self, parent):
        """A borderless, BASE-coloured vertical scroll region filling parent.

        The hand-drawn thumb hides itself while everything fits, so sections
        that fit look like a plain pane.
        """
        canvas = tk.Canvas(parent, bg=BASE, highlightthickness=0, bd=0)
        canvas.pack(side="left", fill="both", expand=True)
        bar = tk.Canvas(parent, bg=BASE, width=sc(8), highlightthickness=0,
                        bd=0)
        bar.pack(side="right", fill="y")
        thumb = bar.create_rectangle(0, 0, 0, 0, fill=SURFACE1, outline="")
        inner = tk.Frame(canvas, bg=BASE)
        item = canvas.create_window((0, 0), window=inner, anchor="nw")

        def refresh(*_):
            canvas.configure(scrollregion=canvas.bbox("all"))
            first, last = canvas.yview()
            bh = bar.winfo_height()
            if last - first >= 0.999:
                bar.coords(thumb, 0, 0, 0, 0)
            else:
                bar.coords(thumb, sc(2), first * bh + 1, sc(7), last * bh - 1)

        def wheel(e):
            canvas.yview_scroll(-int(e.delta / 120), "units")
            refresh()

        def drag(e):
            bh = max(bar.winfo_height(), 1)
            canvas.yview_moveto(min(max(e.y / bh, 0.0), 1.0))
            refresh()

        inner.bind("<Configure>", refresh)
        canvas.bind("<Configure>",
                    lambda e: (canvas.itemconfig(item, width=e.width), refresh()))
        for w in (canvas, inner, bar):
            w.bind("<MouseWheel>", wheel)
        self._scroll_wheel = wheel
        bar.bind("<Button-1>", drag)
        bar.bind("<B1-Motion>", drag)
        return inner

    def _scroll_list(self, parent, height):
        """A dark, scrollable list region; returns its inner Frame.

        The scrollbar is a hand-drawn thumb (native tk.Scrollbar ignores
        colours on Windows) that auto-hides when the content fits.
        """
        wrap = tk.Frame(parent, bg=MANTLE, highlightthickness=HAIR,
                        highlightbackground=CARD_BORDER)
        wrap._own_wheel = True   # keep _bind_wheel out of this subtree
        wrap.pack(fill="x")
        canvas = tk.Canvas(wrap, bg=MANTLE, height=height,
                           highlightthickness=0, bd=0)
        canvas.pack(side="left", fill="both", expand=True)
        bar = tk.Canvas(wrap, bg=MANTLE, width=sc(8), height=height,
                        highlightthickness=0, bd=0)
        bar.pack(side="right", fill="y")
        thumb = bar.create_rectangle(0, 0, 0, 0, fill=SURFACE1, outline="")
        inner = tk.Frame(canvas, bg=MANTLE)
        item = canvas.create_window((0, 0), window=inner, anchor="nw")

        def refresh(*_):
            canvas.configure(scrollregion=canvas.bbox("all"))
            first, last = canvas.yview()
            bh = bar.winfo_height()
            if last - first >= 0.999:
                bar.coords(thumb, 0, 0, 0, 0)          # fits — hide thumb
            else:
                bar.coords(thumb, sc(2), first * bh + 1, sc(7), last * bh - 1)

        def wheel(e):
            canvas.yview_scroll(-int(e.delta / 120), "units")
            refresh()
            return "break"   # don't also scroll the section pane

        def drag(e):
            bh = max(bar.winfo_height(), 1)
            canvas.yview_moveto(min(max(e.y / bh, 0.0), 1.0))
            refresh()

        inner.bind("<Configure>", refresh)
        canvas.bind("<Configure>",
                    lambda e: (canvas.itemconfig(item, width=e.width), refresh()))
        for w in (canvas, inner, bar):
            w.bind("<MouseWheel>", wheel)
        bar.bind("<Button-1>", drag)
        bar.bind("<B1-Motion>", drag)
        inner._wheel = wheel
        return inner

    def _empty_row(self, parent, text):
        tk.Label(parent, text=text, bg=MANTLE, fg=MUTED, font=HINT_FONT,
                 anchor="w", justify="left", padx=sc(10), pady=sc(8),
                 wraplength=sc(420)).pack(fill="x")

    def _list_row(self, parent, text, on_remove):
        """One term/pair row: text on the left, a ✕ remove label on the right."""
        row = tk.Frame(parent, bg=MANTLE)
        row.pack(fill="x")
        lbl = tk.Label(row, text=text, bg=MANTLE, fg=TEXT, font=FONT,
                       anchor="w", padx=sc(10), pady=sc(4))
        lbl.pack(side="left", fill="x", expand=True)
        x = tk.Label(row, text="✕", bg=MANTLE, fg=MUTED, font=FONT,
                     cursor="hand2", padx=sc(10))
        x.pack(side="right")
        x.bind("<Enter>", lambda _e: x.config(fg=RED))
        x.bind("<Leave>", lambda _e: x.config(fg=MUTED))
        x.bind("<Button-1>", lambda _e: on_remove())
        wheel = getattr(parent, "_wheel", None)
        if wheel is not None:
            for w in (row, lbl, x):
                w.bind("<MouseWheel>", wheel)

    # --- Behaviors ---------------------------------------------------------------

    def _apply(self, **changes):
        """Merge changes into the config and persist immediately."""
        self._config = {**self._config, **changes}
        self._on_save(self._config)
        self._flash_saved()

    def _flash_saved(self):
        if self._win is None or not self._win.winfo_exists():
            return
        self._saved_lbl.config(text="✓ Saved")
        if self._saved_after_id is not None:
            self._root.after_cancel(self._saved_after_id)
        self._saved_after_id = self._root.after(
            1500, lambda: self._saved_lbl.winfo_exists()
            and self._saved_lbl.config(text=""))

    # Language ----------------------------------------------------------------

    def _open_lang_menu(self, ctrl):
        menu = self._menu([
            (name, lambda n=name, c=code: self._pick_lang(n, c))
            for name, code in LANGUAGES])
        self._popup_under(menu, ctrl)

    def _pick_lang(self, name, code):
        self._lang_lbl.config(text=name)
        self._apply(language=code)

    # Provider keys & model overrides ---------------------------------------------

    def _toggle_show(self, entry, btn):
        showing = entry["show"] == ""
        entry.config(show="•" if showing else "")
        btn.set_text("Show" if showing else "Hide")

    def _save_key(self, field):
        self._apply(**{field: self._key_vars[field].get().strip()})
        self._refresh_key_status(field)

    def _save_model(self, kind, var):
        """Store the override under the currently selected provider."""
        models = dict(self._config.get(kind + "_models") or {})
        value = var.get().strip()
        if value:
            models[self._model_provider(kind)] = value
        else:
            models.pop(self._model_provider(kind), None)
        self._apply(**{kind + "_models": models})
        self._refresh_model_hints()

    def _default_model(self, kind, provider):
        """The provider's built-in default model id ('' if none/unknown)."""
        try:
            if kind == "stt":
                from transcriber import DEFAULT_STT_MODELS
                return DEFAULT_STT_MODELS.get(provider, "")
            from cleanup import DEFAULT_CLEANUP_MODELS
            return DEFAULT_CLEANUP_MODELS.get(provider, "")
        except Exception:
            return ""

    def _refresh_model_hints(self):
        for attr, kind, pkey in (
            ("_stt_model_hint", "stt", "provider"),
            ("_cleanup_model_hint", "cleanup", "cleanup_provider"),
        ):
            lbl = getattr(self, attr, None)
            if lbl is None or not lbl.winfo_exists():
                continue
            default = self._default_model(kind, self._config.get(pkey, "xai"))
            tail = f" ({default})" if default else ""
            lbl.config(text=f"Empty = provider default{tail}.")

    def _test_transcription(self):
        provider = self._config.get("provider", "xai")
        field = KEY_FIELD_BY_PROVIDER.get(provider, "api_key")
        self._start_test("stt", provider, field, self._test_stt_btn,
                         self._test_stt_worker)

    def _test_cleanup(self):
        provider = self._config.get("cleanup_provider", "xai")
        field = KEY_FIELD_BY_PROVIDER.get(provider, "api_key")
        self._start_test("cleanup", provider, field, self._test_cleanup_btn,
                         self._test_cleanup_worker)

    def _start_test(self, which, provider, field, btn, worker):
        if self._testing:
            return
        var = self._key_vars.get(field)
        key = var.get().strip() if var is not None else ""
        if not key:
            name = PROVIDER_BY_ID.get(provider, provider)
            self._test_status.config(
                text=f"Enter your {name} API key below first.", fg=RED)
            return
        self._testing = True
        btn.disable()
        self._test_status.config(text="Testing…", fg=MUTED)
        threading.Thread(target=worker, args=(key, provider),
                         daemon=True).start()

    def _test_stt_worker(self, key, provider):
        import io
        import wave
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 8000)  # 0.5 s of silence
        try:
            from transcriber import DEFAULT_STT_MODELS, transcribe
            model = ((self._config.get("stt_models") or {}).get(provider)
                     or DEFAULT_STT_MODELS[provider])
            transcribe(buf.getvalue(), key, provider=provider, model=model)
            name = PROVIDER_BY_ID.get(provider, provider)
            result = ("stt", True, f"Transcription works ({name}).")
        except Exception as exc:
            result = ("stt", False, str(exc))
        self._queue.put(("tested", result))

    def _test_cleanup_worker(self, key, provider):
        try:
            from cleanup import DEFAULT_CLEANUP_MODELS, cleanup
            model = ((self._config.get("cleanup_models") or {}).get(provider)
                     or DEFAULT_CLEANUP_MODELS[provider])
            out = cleanup("testing one two three", None, "", {}, key, model,
                          provider=provider)
            if out is not None:
                name = PROVIDER_BY_ID.get(provider, provider)
                result = ("cleanup", True, f"Cleanup works ({name}).")
            else:
                result = ("cleanup", False,
                          "Cleanup failed — check the key, or see app.log.")
        except Exception:
            result = ("cleanup", False,
                      "Cleanup failed — check the key, or see app.log.")
        self._queue.put(("tested", result))

    def _on_tested(self, result):
        self._testing = False
        if self._win is None or not self._win.winfo_exists():
            return
        which, ok, message = result
        btn = (self._test_stt_btn if which == "stt"
               else self._test_cleanup_btn)
        if btn is not None and btn.winfo_exists():
            btn.enable()
        if self._test_status is not None and self._test_status.winfo_exists():
            self._test_status.config(text=("✓ " if ok else "") + message,
                                     fg=GREEN if ok else RED)

    # Hotkey capture ------------------------------------------------------------

    def _start_capture(self, config_key="hotkey"):
        if self._capturing:
            return
        row = self._shortcut_rows[config_key]
        self._capturing = True
        self._capture_target = config_key
        row["error"].config(text="")
        row["error"].pack_forget()
        row["btn"].disable()
        row["lbl"].config(text="Press keys…", fg=ACCENT)
        if self._on_capture_start is not None:
            try:
                self._on_capture_start()
            except Exception:
                pass
        threading.Thread(target=self._capture_worker, daemon=True).start()

    def _capture_worker(self):
        combo = None
        try:
            combo = keyboard.read_hotkey(suppress=False)
        except Exception:
            combo = None
        self._queue.put(("captured", combo))

    def _on_captured(self, combo):
        if not self._capturing:
            return
        self._capturing = False
        row = self._shortcut_rows.get(self._capture_target, {})
        # Switching sections mid-capture destroys the row's widgets.
        alive = (row and row["lbl"].winfo_exists())

        cancelled = combo is None or combo.strip().lower() in ("esc", "escape")
        if not cancelled:
            try:
                from hotkey import validate_hotkey
                new_hotkey = validate_hotkey(combo)
            except ValueError as exc:
                if alive:
                    row["error"].config(text=str(exc))
                    row["error"].pack(fill="x", pady=(sc(3), 0))
                cancelled = True
            except ImportError:
                new_hotkey = combo.strip().lower()

        if alive:
            shown = row["combo"] if cancelled else new_hotkey
            row["lbl"].config(text=pretty_combo(shown) or "None", fg=TEXT)
            row["btn"].enable()
            if not cancelled:
                row["combo"] = new_hotkey

        if self._on_capture_end is not None:
            try:
                self._on_capture_end()
            except Exception:
                pass

        if not cancelled:
            self._apply(**{self._capture_target: new_hotkey})

    # --- Window plumbing --------------------------------------------------------

    def _center(self):
        self._win.update_idletasks()
        w, h = sc(WIN_W), sc(WIN_H)
        x = (self._win.winfo_screenwidth() - w) // 2
        y = (self._win.winfo_screenheight() - h) // 2 - sc(30)
        self._win.geometry(f"{w}x{h}+{x}+{y}")

    def _raise(self):
        win = self._win
        win.deiconify()
        win.attributes("-topmost", True)
        win.lift()
        win.focus_force()
        win.after(200, lambda: win.winfo_exists()
                  and win.attributes("-topmost", False))

    def _close(self):
        if self._capturing:
            self._capturing = False
            if self._on_capture_end is not None:
                try:
                    self._on_capture_end()
                except Exception:
                    pass
        if self._win is not None and self._win.winfo_exists():
            self._win.destroy()
        self._win = None
