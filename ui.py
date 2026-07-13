"""Tray icon and settings window for Undertone.

The settings window is a dark two-pane panel: an icon sidebar with General /
Dictionary / History / Providers / About sections (plus a guided "Get
started" section until setup is complete) and a content pane of setting
cards. All changes apply immediately (no Save/Cancel); a transient
"Saved" hint confirms each change. Styled by hand with plain tk widgets plus
Pillow-rendered imagery (tray icon, toggles, pill buttons, nav glyphs)
supersampled 4x for crisp edges. All pixel measures go through theme.sc()
so the window renders correctly on high-DPI displays.

Thread-safety: open() may be called from the pystray thread; work is
marshalled onto the Tk main loop via a queue drained by root.after().
"""

import pathlib
import queue
import re
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
import webbrowser
from typing import Callable, List, Optional

import keyboard
import pyperclip
import pystray
from PIL import Image, ImageDraw, ImageTk

import autostart
from config import APP_VERSION

from theme import (ACCENT, ACCENT_DOWN, ACCENT_HOVER, AMBER, BANNER_BG,
                   BANNER_BORDER, BASE, CARD, CARD_BORDER, CARD_HOVER, GREEN,
                   INK, MANTLE, MUTED, NAV_HOVER, RED, ROW_HOVER, SUBTEXT,
                   SURFACE0, SURFACE1, TEXT, sc, scale)

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

# "Get started" is only offered while setup is incomplete (see _open).
SECTIONS = ["Get started", "General", "Dictionary", "History", "Providers",
            "About"]


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _lerp_rgb(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def pretty_combo(combo: str) -> str:
    """'ctrl+alt+v' -> 'Ctrl + Alt + V', 'right ctrl' -> 'Right Ctrl'."""
    parts = [p.strip() for p in combo.split("+") if p.strip()]
    return " + ".join(p.title() for p in parts)


def _ellipsize(text: str, limit: int = 24) -> str:
    return text if len(text) <= limit else text[:limit - 1] + "…"


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


def make_recording_tray_image(size: int = 64) -> Image.Image:
    """The app icon tinted toward red — shown in the tray while recording."""
    base = load_app_image(size)
    tint = Image.new("RGBA", base.size, _rgb(RED) + (0,))
    # ~35% red, masked by the icon's own alpha so the corners stay clear.
    tint.putalpha(base.getchannel("A").point(lambda a: a * 90 // 255))
    return Image.alpha_composite(base, tint)


def _toggle_images(bg=BASE):
    """Five switch PhotoImages from off ([0]) to on ([-1]).

    The intermediate frames drive the toggle tween; initial renders index
    the end frames directly ([0] / [-1])."""
    size = (sc(40), sc(22))
    out = []
    w, h = size[0] * 4, size[1] * 4
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        img = Image.new("RGB", (w, h), _rgb(bg))
        d = ImageDraw.Draw(img)
        track = _lerp_rgb(_rgb(SURFACE1), _rgb(ACCENT), t)
        d.rounded_rectangle((0, 0, w - 1, h - 1), radius=h // 2, fill=track)
        knob_r = h // 2 - 8
        cx = round((h // 2) + ((w - h // 2) - (h // 2)) * t)
        knob = _lerp_rgb(_rgb(TEXT), _rgb(INK), t)
        d.ellipse((cx - knob_r, h // 2 - knob_r, cx + knob_r, h // 2 + knob_r),
                  fill=knob)
        out.append(ImageTk.PhotoImage(img.resize(size, Image.LANCZOS)))
    return out


def _round_img(w, h, radius, fill, outline=None, bg=BASE, outline_w=None):
    """A rounded rectangle rendered on a solid background, 4x supersampled."""
    ss = 4
    img = Image.new("RGB", (w * ss, h * ss), _rgb(bg))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=radius * ss,
                        fill=_rgb(fill),
                        outline=_rgb(outline) if outline else None,
                        width=ss * (outline_w if outline_w is not None
                                    else max(1, round(scale()))))
    return img.resize((w, h), Image.LANCZOS)


_ROUND_MASTER_CACHE = {}
_ROUND_MASTER_CACHE_LIMIT = 64


def _round_master(radius, fill, outline, outline_w):
    """Return one small antialiased master used for rounded 9-slices."""
    key = (radius, fill, outline, outline_w)
    master = _ROUND_MASTER_CACHE.pop(key, None)
    if master is not None:
        _ROUND_MASTER_CACHE[key] = master
        return master

    side = 2 * radius + 4
    ss = 4
    # Bleed the edge colour through transparent pixels so LANCZOS cannot
    # introduce a dark fringe around the antialiased outer edge.
    bleed = _rgb(outline or fill)
    master = Image.new("RGBA", (side * ss, side * ss), bleed + (0,))
    ImageDraw.Draw(master).rounded_rectangle(
        (0, 0, side * ss - 1, side * ss - 1),
        radius=radius * ss,
        fill=_rgb(fill) + (255,),
        outline=_rgb(outline) + (255,) if outline else None,
        width=outline_w * ss,
    )
    master = master.resize((side, side), Image.LANCZOS)
    _ROUND_MASTER_CACHE[key] = master
    if len(_ROUND_MASTER_CACHE) > _ROUND_MASTER_CACHE_LIMIT:
        del _ROUND_MASTER_CACHE[next(iter(_ROUND_MASTER_CACHE))]
    return master


def _round_underlay_img(w, h, radius, fill, outline=None, bg=BASE,
                        outline_w=1):
    """Build a rounded container image cheaply from a cached 9-slice."""
    img = Image.new("RGB", (w, h), _rgb(bg))
    master = _round_master(radius, fill, outline, outline_w)
    side = master.width
    corner = side // 2
    draw = ImageDraw.Draw(img)

    # Rounded containers are always larger than their corner master. Keep a
    # cheap, non-antialiased fallback for a transient 1x1-ish geometry only.
    if w < side or h < side:
        draw.rounded_rectangle(
            (0, 0, w - 1, h - 1), radius=min(radius, w // 2, h // 2),
            fill=_rgb(fill), outline=_rgb(outline) if outline else None,
            width=outline_w,
        )
        return img

    fill_rgb = _rgb(fill)
    draw.rectangle((corner, 0, w - corner - 1, h - 1), fill=fill_rgb)
    draw.rectangle((0, corner, w - 1, h - corner - 1), fill=fill_rgb)
    if outline:
        outline_rgb = _rgb(outline)
        draw.rectangle((corner, 0, w - corner - 1, outline_w - 1),
                       fill=outline_rgb)
        draw.rectangle((corner, h - outline_w, w - corner - 1, h - 1),
                       fill=outline_rgb)
        draw.rectangle((0, corner, outline_w - 1, h - corner - 1),
                       fill=outline_rgb)
        draw.rectangle((w - outline_w, corner, w - 1, h - corner - 1),
                       fill=outline_rgb)

    corners = (
        ((0, 0, corner, corner), (0, 0)),
        ((corner, 0, side, corner), (w - corner, 0)),
        ((0, corner, corner, side), (0, h - corner)),
        ((corner, corner, side, side), (w - corner, h - corner)),
    )
    for crop, dest in corners:
        piece = master.crop(crop)
        img.paste(piece, dest, piece)
    return img


def _nav_glyph(name: str, color: str, size: int) -> Image.Image:
    """A simple 4x-supersampled line glyph for the sidebar."""
    s = size * 4
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    c = _rgb(color) + (255,)
    lw = max(2, int(0.085 * s))

    def x(f):
        return f * s

    if name == "Get started":    # spark: filled dot with three rays
        r = 0.16 * s
        d.ellipse((x(0.5) - r, x(0.62) - r, x(0.5) + r, x(0.62) + r), fill=c)
        d.line((x(0.5), x(0.36), x(0.5), x(0.14)), fill=c, width=lw)
        d.line((x(0.30), x(0.46), x(0.14), x(0.30)), fill=c, width=lw)
        d.line((x(0.70), x(0.46), x(0.86), x(0.30)), fill=c, width=lw)
    elif name == "General":      # slider rails with knobs
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
        win.deiconify()
        win.update_idletasks()
        win.update()
        # Private WinDLL — never set argtypes on ctypes.windll's shared cache.
        get_ancestor = ctypes.WinDLL("user32").GetAncestor
        get_ancestor.argtypes = (wintypes.HWND, wintypes.UINT)
        get_ancestor.restype = wintypes.HWND
        hwnd = get_ancestor(wintypes.HWND(win.winfo_id()), 2)  # GA_ROOT
        value = ctypes.c_int(1)
        for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE
            if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                wintypes.HWND(hwnd), attr,
                ctypes.byref(value), ctypes.sizeof(value),
            ) == 0:
                break
        win.withdraw()   # DWM repaints the frame on remap
        win.update_idletasks()
        win.deiconify()
    except Exception:
        pass


# --- Tray ---------------------------------------------------------------------

def create_tray(
    on_settings: Callable[[], None],
    on_quit: Callable[[], None],
    on_toggle_pause: Optional[Callable[[], None]] = None,
    is_paused: Optional[Callable[[], bool]] = None,
) -> pystray.Icon:
    """Build (but do not run) the system tray icon."""
    items = [pystray.MenuItem("Settings…", lambda icon, item: on_settings(),
                              default=True)]
    if on_toggle_pause is not None and is_paused is not None:
        items.append(pystray.MenuItem(
            "Pause dictation", lambda icon, item: on_toggle_pause(),
            checked=lambda item: is_paused()))
    items += [pystray.Menu.SEPARATOR,
              pystray.MenuItem("Quit", lambda icon, item: on_quit())]
    menu = pystray.Menu(*items)
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
        self._focused = False
        super().__init__(parent, text=text, compound="center",
                         font=self._font, bd=0, bg=bg, cursor="hand2",
                         takefocus=1)
        self._render(text)
        self._apply_state("normal")
        self.bind("<Enter>", lambda _e: self._hover(True))
        self.bind("<Leave>", lambda _e: self._hover(False))
        self.bind("<Button-1>", self._press)
        self.bind("<ButtonRelease-1>", self._release)
        self.bind("<FocusIn>", lambda _e: self._set_focus(True))
        self.bind("<FocusOut>", lambda _e: self._set_focus(False))
        self.bind("<Return>", self._key_activate)
        self.bind("<space>", self._key_activate)

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
        # Keep the old PhotoImages alive until the new one is swapped in:
        # freeing them first deletes the image the label still displays,
        # and any config() call then fails with "pyimageN doesn't exist".
        old_imgs = getattr(self, "_imgs", None)
        old_focus_imgs = getattr(self, "_focus_imgs", None)
        self._imgs, self._focus_imgs, self._fgs = {}, {}, {}
        # Keyboard-focus ring; on accent fills the accent ring would vanish,
        # so those get an INK ring instead.
        ring = INK if self._kind == "accent" else ACCENT
        for state, (fill, outline, fg) in spec.items():
            self._imgs[state] = ImageTk.PhotoImage(
                _round_img(w, self._h, self._h // 2, fill, outline, bg=self._bg))
            self._focus_imgs[state] = ImageTk.PhotoImage(
                _round_img(w, self._h, self._h // 2, fill, ring, bg=self._bg,
                           outline_w=HAIR + 1))
            self._fgs[state] = fg
        imgs = self._focus_imgs if self._focused else self._imgs
        self.config(text=text, image=imgs[self._state])
        del old_imgs, old_focus_imgs

    def _apply_state(self, state):
        self._state = state
        imgs = self._focus_imgs if self._focused else self._imgs
        self.config(image=imgs[state], fg=self._fgs[state],
                    cursor="hand2" if self._enabled else "")

    def _set_focus(self, focused):
        self._focused = focused
        self._apply_state(self._state)

    def _hover(self, inside):
        if self._enabled:
            self._apply_state("hover" if inside else "normal")

    def _key_activate(self, _e):
        if not self._enabled or self._command is None:
            return
        self._apply_state("down")
        self.after(100, lambda: self.winfo_exists()
                   and self._apply_state("normal"))
        self._command()

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

    def set_bg(self, bg):
        """Re-render on a new background (the parent row hovered)."""
        if bg == self._bg:
            return
        self._bg = bg
        self.config(bg=bg)
        self._render(self.cget("text"))
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
        history_getter: Optional[Callable[[], List[dict]]] = None,
        on_repaste: Optional[Callable[[str], None]] = None,
        on_retry: Optional[Callable[[bytes], None]] = None,
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
        self._on_retry = on_retry
        self._win = None
        self._queue: "queue.Queue" = queue.Queue()
        self._capturing = False
        self._testing = False
        self._mic_testing = False
        self._saved_after_id = None
        self._hist_poll_id = None
        self._menu_closed_at = float("-inf")
        self._wrap_labels = []
        self._wrap_after_id = None
        self._wrap_widths = {}
        self._round_containers = []
        self._redraw_depth = 0
        self._resize_after_id = None
        self._size_move_active = False
        self._freeze_enter_after_id = None
        self._freeze_exit_after_id = None
        self._freeze_start_size = None
        self._resize_snapshot_label = None
        self._resize_snapshot_photo = None
        self._client_hwnd = None
        self._last_client_size = None
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
        win.withdraw()
        win.title("Undertone")
        try:
            win.iconbitmap(str(ICON_ICO))
        except tk.TclError:
            pass
        win.configure(bg=BASE)
        win.resizable(True, True)
        win.minsize(sc(660), sc(560))
        win.protocol("WM_DELETE_WINDOW", self._close)
        win.bind("<Escape>", self._on_escape)

        # Keep the packed widget tree under one fixed-size child.  During a
        # native resize only the toplevel changes; this host stays frozen so
        # Tk does not synchronously re-lay out every descendant on WM_SIZE.
        self._host = tk.Frame(win, bg=BASE)

        # Sidebar ------------------------------------------------------------
        side = tk.Frame(self._host, bg=MANTLE, width=sc(SIDEBAR_W))
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
        self._content = tk.Frame(self._host, bg=BASE)
        self._content.pack(side="left", fill="both", expand=True)

        show_get_started = self._setup_incomplete()
        for section in SECTIONS:
            if section == "Get started" and not show_get_started:
                continue
            self._nav_items[section] = self._make_nav_item(side, section)

        geometry = self._restore_geometry()
        match = re.match(r"(\d+)x(\d+)", geometry)
        initial_w, initial_h = map(int, match.groups())
        self._host.place(x=0, y=0, width=initial_w, height=initial_h)

        initial_section = "Get started" if show_get_started else "General"
        self._paint_atomically(lambda: self._select_section(initial_section))

        apply_dark_titlebar(self._win)
        self._set_window_icons()
        # Snapshot-freeze needs the Tk client HWND for PrintWindow.
        try:
            self._client_hwnd = int(win.winfo_id())
        except Exception:
            self._client_hwnd = None
        # Seed with the initial size so the first map's Configure events
        # don't read as a resize and trigger a freeze of a half-built window.
        self._last_client_size = (initial_w, initial_h)
        win.bind("<Configure>", self._schedule_resize_settle)
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
                    w.configure(bg=NAV_HOVER)

        def leave(_):
            if getattr(self, "_active_section", None) != section:
                for w in (row, lbl, icon):
                    w.configure(bg=MANTLE)
        for w in (row, lbl, bar, icon):
            w.bind("<Enter>", enter)
            w.bind("<Leave>", leave)
            w.bind("<Button-1>", lambda _e, s=section: self._select_section(s))
        return {"row": row, "bar": bar, "label": lbl, "icon": icon}

    def _set_window_redraw(self, enabled):
        """Toggle native painting, tolerating unavailable Windows APIs."""
        try:
            import ctypes
            from ctypes import wintypes
            # Private WinDLL: setting argtypes on ctypes.windll's cached
            # functions poisons every other module's calls process-wide
            # (it broke the overlay's CreateDIBSection once).
            user32 = ctypes.WinDLL("user32")
            get_ancestor = user32.GetAncestor
            get_ancestor.argtypes = (wintypes.HWND, wintypes.UINT)
            get_ancestor.restype = wintypes.HWND
            send_message = user32.SendMessageW
            send_message.argtypes = (wintypes.HWND, wintypes.UINT,
                                     wintypes.WPARAM, wintypes.LPARAM)
            send_message.restype = wintypes.LPARAM
            redraw_window = user32.RedrawWindow
            redraw_window.argtypes = (wintypes.HWND, ctypes.c_void_p,
                                      ctypes.c_void_p, wintypes.UINT)
            redraw_window.restype = wintypes.BOOL
            hwnd = get_ancestor(
                wintypes.HWND(self._win.winfo_id()), 2)  # GA_ROOT
            if not hwnd:
                return
            send_message(hwnd, 0x000B, int(enabled), 0)  # WM_SETREDRAW
            if enabled:
                flags = 0x0001 | 0x0004 | 0x0400 | 0x0080
                redraw_window(hwnd, None, None, flags)
        except Exception:
            pass

    def _paint_atomically(self, rebuild, finalize=None, flush=True):
        """Run a rebuild with painting frozen, then flush its final layout."""
        outermost = self._redraw_depth == 0
        if outermost:
            self._set_window_redraw(False)
        self._redraw_depth += 1
        try:
            try:
                result = rebuild()
                if (flush and outermost and self._win is not None
                        and self._win.winfo_exists()):
                    self._win.update_idletasks()
                    self._render_pending_now()
                return result
            finally:
                if finalize is not None:
                    finalize()
        finally:
            self._redraw_depth -= 1
            if outermost:
                self._set_window_redraw(True)

    def _select_section(self, section):
        return self._paint_atomically(
            lambda: self._rebuild_section(section))

    def _schedule_resize_settle(self, event=None):
        """Edge-triggered snapshot freeze around resize storms.

        The first size change of a storm swaps the HWND-heavy widget tree
        for one stale bitmap (the native frame then tracks the cursor
        smoothly, Steam-style); 150ms without another Configure ends the
        storm and settles the real content once, atomically. Bound on the
        toplevel, so it also fires for descendants via bindtags — those
        are filtered out, as are pure moves.
        """
        win = self._win
        if win is None or event is None or str(event.widget) != str(win):
            return
        size = (win.winfo_width(), win.winfo_height())
        if size == self._last_client_size and not self._size_move_active:
            return  # pure move or spurious Configure
        self._last_client_size = size
        if not self._size_move_active:
            self._queue_freeze_enter()
        if self._resize_after_id is not None:
            try:
                win.after_cancel(self._resize_after_id)
            except tk.TclError:
                pass
        self._resize_after_id = win.after(150, self._end_resize_storm)

    def _end_resize_storm(self):
        """Trailing edge of a resize storm: unfreeze and settle."""
        self._resize_after_id = None
        if self._size_move_active:
            self._queue_freeze_exit()

    def _settle_resize(self, finalize=None):
        """Snap the packed content tree to the final client size atomically."""
        self._resize_after_id = None
        if self._win is None or not self._win.winfo_exists():
            return
        width = self._win.winfo_width()
        height = self._win.winfo_height()
        self._paint_atomically(
            lambda: self._host.place_configure(width=width, height=height),
            finalize=finalize)

    def _queue_freeze_enter(self):
        """Mark the native drag immediately; defer all widget work."""
        if self._size_move_active or self._win is None:
            return
        self._size_move_active = True
        self._freeze_enter_after_id = self._win.after_idle(self._freeze_enter)

    def _queue_freeze_exit(self):
        """Defer restoration until Tk finishes dispatching the native event."""
        if not self._size_move_active or self._win is None:
            return
        if self._freeze_exit_after_id is None:
            self._freeze_exit_after_id = self._win.after_idle(self._freeze_exit)

    def _capture_resize_snapshot(self):
        """Return a Pillow image of the Tk client HWND via PrintWindow."""
        if not self._client_hwnd:
            return None
        try:
            import ctypes
            from ctypes import wintypes

            class BITMAPINFOHEADER(ctypes.Structure):
                _fields_ = [
                    ("biSize", wintypes.DWORD),
                    ("biWidth", wintypes.LONG),
                    ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD),
                    ("biBitCount", wintypes.WORD),
                    ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD),
                    ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG),
                    ("biClrUsed", wintypes.DWORD),
                    ("biClrImportant", wintypes.DWORD),
                ]

            class BITMAPINFO(ctypes.Structure):
                _fields_ = [("bmiHeader", BITMAPINFOHEADER),
                            ("bmiColors", wintypes.DWORD * 3)]

            # Private WinDLLs — never set argtypes on ctypes.windll's shared
            # cache (overlay.py calls the same GDI functions with its own
            # struct types and would fail the poisoned type checks).
            user32 = ctypes.WinDLL("user32")
            gdi32 = ctypes.WinDLL("gdi32")
            hwnd = wintypes.HWND(self._client_hwnd)
            user32.GetClientRect.argtypes = (wintypes.HWND,
                                             ctypes.POINTER(wintypes.RECT))
            user32.GetClientRect.restype = wintypes.BOOL
            user32.PrintWindow.argtypes = (wintypes.HWND, wintypes.HDC,
                                           wintypes.UINT)
            user32.PrintWindow.restype = wintypes.BOOL
            gdi32.CreateCompatibleDC.argtypes = (wintypes.HDC,)
            gdi32.CreateCompatibleDC.restype = wintypes.HDC
            gdi32.CreateDIBSection.argtypes = (
                wintypes.HDC, ctypes.POINTER(BITMAPINFO), wintypes.UINT,
                ctypes.POINTER(ctypes.c_void_p), wintypes.HANDLE,
                wintypes.DWORD)
            gdi32.CreateDIBSection.restype = wintypes.HBITMAP
            gdi32.SelectObject.argtypes = (wintypes.HDC, wintypes.HGDIOBJ)
            gdi32.SelectObject.restype = wintypes.HGDIOBJ
            gdi32.DeleteObject.argtypes = (wintypes.HGDIOBJ,)
            gdi32.DeleteObject.restype = wintypes.BOOL
            gdi32.DeleteDC.argtypes = (wintypes.HDC,)
            gdi32.DeleteDC.restype = wintypes.BOOL
            rect = wintypes.RECT()
            if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
                return None
            width, height = rect.right - rect.left, rect.bottom - rect.top
            if width <= 0 or height <= 0:
                return None

            info = BITMAPINFO()
            info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
            info.bmiHeader.biWidth = width
            info.bmiHeader.biHeight = -height  # top-down DIB
            info.bmiHeader.biPlanes = 1
            info.bmiHeader.biBitCount = 32
            bits = ctypes.c_void_p()
            dc = gdi32.CreateCompatibleDC(None)
            if not dc:
                return None
            bitmap = None
            old_bitmap = None
            try:
                bitmap = gdi32.CreateDIBSection(
                    dc, ctypes.byref(info), 0, ctypes.byref(bits), None, 0)
                if not bitmap or not bits:
                    return None
                old_bitmap = gdi32.SelectObject(dc, bitmap)
                if not user32.PrintWindow(hwnd, dc, 2):  # PW_RENDERFULLCONTENT
                    return None
                pixels = ctypes.string_at(bits, width * height * 4)
                return Image.frombytes(
                    "RGB", (width, height), pixels, "raw", "BGRX")
            finally:
                if old_bitmap:
                    gdi32.SelectObject(dc, old_bitmap)
                if bitmap:
                    gdi32.DeleteObject(bitmap)
                gdi32.DeleteDC(dc)
        except Exception:
            return None

    def _freeze_enter(self):
        """Replace the HWND-heavy widget tree with one stale bitmap."""
        self._freeze_enter_after_id = None
        if (not self._size_move_active or self._win is None
                or not self._win.winfo_exists()):
            return
        # NOTE: the trailing _resize_after_id timer stays alive — it is the
        # only thing that ends the storm now that freezing is edge-triggered.
        self._render_pending_now()
        self._freeze_start_size = (self._win.winfo_width(),
                                   self._win.winfo_height())
        snapshot = self._capture_resize_snapshot()
        if snapshot is not None:
            self._resize_snapshot_photo = ImageTk.PhotoImage(snapshot)
            self._resize_snapshot_label = tk.Label(
                self._win, image=self._resize_snapshot_photo, bg=BASE,
                bd=0, highlightthickness=0)
            self._resize_snapshot_label.place(x=0, y=0, anchor="nw")
        self._host.place_forget()

    def _finish_freeze(self):
        label = self._resize_snapshot_label
        if label is not None and label.winfo_exists():
            label.destroy()
        self._resize_snapshot_label = None
        self._resize_snapshot_photo = None
        self._freeze_start_size = None
        self._size_move_active = False

    def _freeze_exit(self):
        """Restore and settle the host once at the native drag's final size."""
        self._freeze_exit_after_id = None
        if (not self._size_move_active or self._win is None
                or not self._win.winfo_exists()):
            return
        final_size = (self._win.winfo_width(), self._win.winfo_height())
        if final_size != self._freeze_start_size:
            self._settle_resize(finalize=self._finish_freeze)
        else:
            width, height = final_size
            self._paint_atomically(
                lambda: self._host.place_configure(
                    width=width, height=height),
                finalize=self._finish_freeze, flush=False)

    def _rebuild_section(self, section):
        self._cancel_history_poll()
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
        if self._wrap_after_id is not None:
            try:
                self._root.after_cancel(self._wrap_after_id)
            except tk.TclError:
                pass
        self._wrap_labels = []
        self._wrap_after_id = None
        self._wrap_widths = {}
        self._round_containers = []
        pane.bind("<Configure>", self._schedule_wraps)
        if section == "Get started":
            self._build_get_started(pane)
        elif section == "General":
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
        self._register_wrap(lbl, parent)
        return lbl

    def _register_wrap(self, label, host, subtract=0):
        """Keep a wrapped label matched to the width of its text column."""
        self._wrap_labels.append((label, host, sc(subtract)))
        host.bind("<Configure>", self._schedule_wraps, add="+")
        self._schedule_wraps()

    def _schedule_wraps(self, _event=None):
        if _event is not None:
            previous = self._wrap_widths.get(_event.widget)
            if previous is not None and abs(_event.width - previous) < 3:
                return
            self._wrap_widths[_event.widget] = _event.width
        if self._wrap_after_id is not None:
            try:
                self._root.after_cancel(self._wrap_after_id)
            except tk.TclError:
                pass
        self._wrap_after_id = self._root.after(100, self._refresh_wraps)

    def _refresh_wraps(self, settle_underlays=True):
        self._wrap_after_id = None
        alive = []
        changed = False
        for label, host, subtract in self._wrap_labels:
            if label.winfo_exists() and host.winfo_exists():
                width = max(sc(120), host.winfo_width() - subtract)
                if abs(int(label.cget("wraplength")) - width) >= 3:
                    label.configure(wraplength=width)
                    changed = True
                alive.append((label, host, subtract))
        self._wrap_labels = alive
        if (changed and settle_underlays and self._win is not None
                and self._win.winfo_exists()):
            self._win.update_idletasks()
            for container in self._round_containers:
                if container.winfo_exists():
                    container._round_render_now()

    def _render_pending_now(self):
        """Synchronously settle wraps and rounded underlays for atomic paint."""
        if self._wrap_after_id is not None:
            try:
                self._root.after_cancel(self._wrap_after_id)
            except tk.TclError:
                pass
            self._wrap_after_id = None
        self._refresh_wraps(settle_underlays=False)
        self._win.update_idletasks()
        alive = []
        for container in self._round_containers:
            if container.winfo_exists():
                container._round_render_now()
                alive.append(container)
        self._round_containers = alive
        self._win.update_idletasks()

    def _rounded_container(self, container, radius, fill, outline,
                           bg=None, outline_w=HAIR):
        """Put a trailing-settled 9-slice rounded image behind content."""
        corner_bg = bg or container.master.cget("bg")
        container.configure(bg=corner_bg, highlightthickness=0, bd=0)
        backdrop = tk.Label(container, bg=corner_bg, bd=0,
                            highlightthickness=0, anchor="nw")
        backdrop.place(x=0, y=0)
        state = {"fill": fill, "outline": outline, "after": None,
                 "last": None, "pending_size": None}

        def render():
            state["after"] = None
            if not container.winfo_exists():
                return
            w, h = container.winfo_width(), container.winfo_height()
            if w <= 1 or h <= 1:
                return
            key = (w, h, state["fill"], state["outline"])
            if key == state["last"]:
                return
            width = HAIR + 1 if state["outline"] == ACCENT else outline_w
            photo = ImageTk.PhotoImage(_round_underlay_img(
                w, h, radius, state["fill"], state["outline"],
                bg=corner_bg, outline_w=width))
            backdrop.configure(image=photo)
            backdrop.image = photo
            state["last"] = key
            state["pending_size"] = None

        def schedule(_event=None, delay=100):
            if _event is not None:
                state["pending_size"] = (_event.width, _event.height)
            if state["after"] is not None:
                try:
                    container.after_cancel(state["after"])
                except tk.TclError:
                    pass
            state["after"] = container.after(delay, render)

        def render_now():
            if state["after"] is not None:
                try:
                    container.after_cancel(state["after"])
                except tk.TclError:
                    pass
                state["after"] = None
            render()

        def set_colors(fill=None, outline=None):
            if fill is not None:
                state["fill"] = fill
            if outline is not None:
                state["outline"] = outline
            state["last"] = None
            schedule(delay=0)

        container.bind("<Configure>", schedule, add="+")
        container._round_set = set_colors
        container._round_backdrop = backdrop
        container._round_render_now = render_now
        self._round_containers.append(container)
        schedule()
        return backdrop

    def _card(self, parent, pady=(0, 8)):
        """A bordered, elevated card; returns the padded inner frame."""
        outer = tk.Frame(parent, bg=parent.cget("bg"), highlightthickness=0)
        outer.pack(fill="x", pady=(sc(pady[0]), sc(pady[1])))
        self._rounded_container(outer, sc(8), CARD, CARD_BORDER)
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
            self._register_wrap(h, left)
            widgets.append(h)
        return right, widgets

    def _toggle_card(self, parent, title, hint, initial, on_change):
        """A setting card with a switch; the whole card toggles.

        The knob tweens through the intermediate _toggle_images frames
        (~130 ms, ease-out); state["set"] jumps without animating (used by
        the autostart snap-back). The whole card lifts to CARD_HOVER on
        hover, and the switch is keyboard-reachable (Tab, then Space)."""
        right, widgets = self._row_card(parent, title, hint)
        state = {"on": bool(initial), "frame": 4 if initial else 0,
                 "hover": False, "anim": None}
        # tk draws this frame's highlight ring while it holds focus.
        ring = tk.Frame(right, bg=CARD, takefocus=1,
                        highlightthickness=HAIR + 1, highlightcolor=ACCENT,
                        highlightbackground=CARD)
        ring.pack()

        def imgs():
            return (self._toggle_imgs_hover if state["hover"]
                    else self._toggle_imgs)

        sw = tk.Label(ring, image=imgs()[state["frame"]], bg=CARD,
                      cursor="hand2")
        sw.pack()

        def show(frame):
            state["frame"] = frame
            sw.config(image=imgs()[frame])

        def stop_anim():
            if state["anim"] is not None:
                self._root.after_cancel(state["anim"])
                state["anim"] = None

        def step(frames, delays):
            state["anim"] = None
            if not sw.winfo_exists():
                return   # card destroyed mid-tween (section switch/close)
            show(frames[0])
            if len(frames) > 1:
                state["anim"] = self._root.after(
                    delays[0], lambda: step(frames[1:], delays[1:]))

        def set_on(on):
            """Jump the switch display (no animation, no on_change)."""
            stop_anim()
            state["on"] = bool(on)
            show(4 if on else 0)
        state["set"] = set_on

        def toggle(_e=None):
            stop_anim()   # rapid clicks: drop the pending chain and restart
            state["on"] = not state["on"]
            step([1, 2, 3, 4] if state["on"] else [3, 2, 1, 0],
                 [30, 30, 35, 40])
            on_change(state["on"])

        outer = widgets[0].master   # the bordered card frame
        hover_set = [outer] + widgets + [right, ring, sw]

        def hover(inside):
            def fn(_e):
                state["hover"] = inside
                bg = CARD_HOVER if inside else CARD
                for w in hover_set:
                    if w is not outer:
                        w.configure(bg=bg)
                outer._round_set(fill=bg)
                for w in widgets[1].winfo_children():   # e.g. cleanup warn
                    w.configure(bg=bg)
                ring.configure(highlightbackground=bg)
                sw.config(image=imgs()[state["frame"]])
            return fn

        for w in widgets + [sw, right, ring]:
            w.bind("<Button-1>", toggle)
            w.configure(cursor="hand2")
        for w in hover_set:
            w.bind("<Enter>", hover(True))
            w.bind("<Leave>", hover(False))
        for seq in ("<space>", "<Return>"):
            ring.bind(seq, toggle)
        return state, sw, widgets[1]   # widgets[1] = left text column

    def _dropdown(self, parent, text, on_open, width=170):
        """A fixed-width dark dropdown control; returns its value label."""
        ctrl = tk.Frame(parent, bg=parent.cget("bg"), cursor="hand2",
                        takefocus=1, highlightthickness=0,
                        width=sc(width), height=sc(30))
        ctrl.pack_propagate(False)
        ctrl.pack()
        self._rounded_container(ctrl, sc(6), SURFACE0, SURFACE1,
                                bg=parent.cget("bg"))
        body = tk.Frame(ctrl, bg=SURFACE0, cursor="hand2")
        body.place(x=sc(5), y=sc(2), relwidth=1, relheight=1,
                   width=-sc(10), height=-sc(4))
        lbl = tk.Label(body, text=text, bg=SURFACE0, fg=TEXT, font=FONT,
                       anchor="w", padx=sc(6), cursor="hand2")
        lbl.pack(side="left", fill="both", expand=True)
        caret = tk.Label(body, text="⌄", bg=SURFACE0, fg=SUBTEXT, font=FONT,
                         padx=sc(5), cursor="hand2")
        caret.pack(side="right", fill="y")

        state = {"hover": False, "focus": False}

        def paint():
            bg = SURFACE1 if state["hover"] else SURFACE0
            outline = ACCENT if state["focus"] else SURFACE1
            ctrl._round_set(fill=bg, outline=outline)
            for w in (body, lbl, caret):
                w.configure(bg=bg)

        def hover(inside):
            def fn(_e):
                state["hover"] = inside
                paint()
            return fn

        def activate(_event=None):
            ctrl.focus_set()
            on_open(ctrl)

        def focus(focused):
            def fn(_e):
                state["focus"] = focused
                paint()
            return fn

        for w in (ctrl, body, lbl, caret):
            w.bind("<Button-1>", activate)
            w.bind("<Enter>", hover(True))
            w.bind("<Leave>", hover(False))
        ctrl.bind("<FocusIn>", focus(True))
        ctrl.bind("<FocusOut>", focus(False))
        for seq in ("<Return>", "<space>", "<Down>"):
            ctrl.bind(seq, activate)
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
        if time.monotonic() - self._menu_closed_at < 0.35:
            return
        menu.bind(
            "<Unmap>",
            lambda _event: setattr(self, "_menu_closed_at", time.monotonic()),
        )
        x = ctrl.winfo_rootx()
        y = ctrl.winfo_rooty() + ctrl.winfo_height() + sc(2)
        menu.tk_popup(x, y)

    def _entry(self, parent, var, show=None, bg=SURFACE0):
        """Return (rounded wrapper, borderless Entry)."""
        wrap = tk.Frame(parent, bg=parent.cget("bg"), highlightthickness=0)
        self._rounded_container(wrap, sc(6), bg, SURFACE1,
                                bg=parent.cget("bg"))
        entry = tk.Entry(
            wrap, textvariable=var, font=FONT, show=show or "", bg=bg,
            fg=TEXT, insertbackground=TEXT, relief="flat",
            highlightthickness=0, bd=0)
        entry.pack(fill="both", expand=True, padx=sc(8), pady=sc(5))
        entry.bind("<FocusIn>", lambda _e: wrap._round_set(outline=ACCENT))
        entry.bind("<FocusOut>", lambda _e: wrap._round_set(outline=SURFACE1))
        return wrap, entry

    # --- Get started (guided first-run setup) --------------------------------------

    def _build_get_started(self, pane):
        pane = self._scroll_pane(pane)
        self._header(pane, "Get started")
        self._toggle_imgs = _toggle_images(bg=CARD)
        self._toggle_imgs_hover = _toggle_images(bg=CARD_HOVER)

        # Step 1 — provider + API key + test.
        card = self._card(pane)
        tk.Label(card, text="1.  Choose your transcription provider",
                 bg=CARD, fg=TEXT, font=CARD_TITLE_FONT,
                 anchor="w").pack(fill="x")
        row = tk.Frame(card, bg=CARD)
        row.pack(fill="x", pady=(sc(8), 0))
        dd_wrap = tk.Frame(row, bg=CARD)
        dd_wrap.pack(side="left")
        cur = self._config.get("provider", "xai")
        name = PROVIDER_BY_ID.get(cur, cur)
        self._gs_dd = self._dropdown(dd_wrap, name,
                                     self._gs_open_provider_menu, width=150)

        self._gs_key_field = KEY_FIELD_BY_PROVIDER.get(cur, "api_key")
        self._gs_key_var = tk.StringVar(
            value=self._config.get(self._gs_key_field, ""))
        # _start_test reads the key from _key_vars; point it at this entry.
        self._key_vars = {self._gs_key_field: self._gs_key_var}
        self._gs_key_lbl = tk.Label(card, text=f"{name} API key", bg=CARD,
                                    fg=SUBTEXT, font=HINT_FONT, anchor="w")
        self._gs_key_lbl.pack(fill="x", pady=(sc(8), sc(2)))
        krow = tk.Frame(card, bg=CARD)
        krow.pack(fill="x")
        entry_wrap, entry = self._entry(krow, self._gs_key_var, show="•")
        entry_wrap.pack(side="left", fill="x", expand=True)
        entry.bind("<Return>", lambda _e: self._gs_save_key())
        RoundButton(krow, "Save", self._gs_save_key, kind="accent",
                    small=True, bg=CARD).pack(side="left", padx=(sc(6), 0))
        self._test_stt_btn = RoundButton(krow, "Test",
                                         self._test_transcription,
                                         small=True, bg=CARD)
        self._test_stt_btn.pack(side="left", padx=(sc(6), 0))
        self._test_status = tk.Label(card, text="", bg=CARD, fg=MUTED,
                                     font=HINT_FONT, anchor="w",
                                     justify="left", wraplength=sc(430))
        self._test_status.pack(fill="x", pady=(sc(4), 0))
        self._register_wrap(self._test_status, card)

        # Step 2 — microphone check with a live level meter.
        card2 = self._card(pane)
        tk.Label(card2, text="2.  Try your microphone", bg=CARD, fg=TEXT,
                 font=CARD_TITLE_FONT, anchor="w").pack(fill="x")
        mrow = tk.Frame(card2, bg=CARD)
        mrow.pack(fill="x", pady=(sc(8), 0))
        self._mic_btn = RoundButton(mrow, "Test microphone",
                                    self._gs_test_mic, small=True, bg=CARD)
        self._mic_btn.pack(side="left")
        self._mic_meter = tk.Canvas(mrow, width=sc(200), height=sc(10),
                                    bg=CARD, highlightthickness=0, bd=0)
        self._mic_meter.pack(side="left", padx=(sc(12), 0))
        self._draw_mic_meter(0.0)
        self._mic_err = tk.Label(card2, text="", bg=CARD, fg=RED,
                                 font=HINT_FONT, anchor="w", justify="left",
                                 wraplength=sc(430))
        self._mic_err.pack(fill="x")
        self._register_wrap(self._mic_err, card2)

        # Step 3 — dictate into a real text box.
        card3 = self._card(pane)
        tk.Label(card3, text="3.  Say something", bg=CARD, fg=TEXT,
                 font=CARD_TITLE_FONT, anchor="w").pack(fill="x")
        combo = pretty_combo(self._config.get("hotkey", "")) or "your shortcut"
        self._hint(card3, f"Click into the box below, hold {combo} and "
                          "read: “Testing, one two three — it "
                          "works.”", pady=(sc(2), sc(8)), bg=CARD,
                   wrap=440)
        self._gs_dict_var = tk.StringVar()
        practice_wrap, _practice = self._entry(card3, self._gs_dict_var)
        practice_wrap.pack(fill="x")
        self._gs_done_row = tk.Frame(card3, bg=CARD)
        self._gs_done_lbl = tk.Label(self._gs_done_row,
                                     text="✓ That's it — you're set up.",
                                     bg=CARD, fg=GREEN, font=HINT_FONT,
                                     anchor="w")
        self._gs_finish_btn = RoundButton(self._gs_done_row, "Finish",
                                          self._gs_finish, kind="accent",
                                          small=True, bg=CARD)
        self._gs_done = False
        self._root.after(500, self._gs_poll_entry)

        self._autostart_card(pane)
        self._bind_wheel(pane)

    def _gs_open_provider_menu(self, ctrl):
        menu = self._menu([
            (name, lambda n=name, p=pid: self._gs_pick_provider(n, p))
            for name, pid in PROVIDERS_UI])
        self._popup_under(menu, ctrl)

    def _gs_pick_provider(self, name, pid):
        self._gs_dd.config(text=name)
        self._apply(provider=pid)
        # Retarget the key entry at the new provider's key field.
        self._gs_key_field = KEY_FIELD_BY_PROVIDER.get(pid, "api_key")
        self._gs_key_var.set(self._config.get(self._gs_key_field, ""))
        self._key_vars = {self._gs_key_field: self._gs_key_var}
        self._gs_key_lbl.config(text=f"{name} API key")
        self._test_status.config(text="")

    def _gs_save_key(self):
        self._apply(**{self._gs_key_field: self._gs_key_var.get().strip()})

    def _gs_test_mic(self):
        if self._mic_testing:
            return
        from recorder import Recorder, RecorderError
        self._mic_err.config(text="")
        rec = Recorder(sample_rate=self._config.get("sample_rate", 16000),
                       device=self._config.get("input_device") or None)
        try:
            rec.start()
        except RecorderError as exc:
            self._mic_err.config(text=str(exc))
            return
        self._mic_testing = True
        self._mic_btn.set_text("Listening…")
        self._mic_btn.disable()
        self._gs_mic_tick(rec, 60)   # 60 ticks x 50 ms = 3 s

    def _gs_mic_tick(self, rec, remaining):
        alive = (self._win is not None and self._win.winfo_exists()
                 and self._mic_meter.winfo_exists())
        if not alive or remaining <= 0:
            try:
                rec.stop()
            except Exception:
                pass
            self._mic_testing = False
            if alive:
                self._draw_mic_meter(0.0)
                self._mic_btn.set_text("Test microphone")
                self._mic_btn.enable()
            return
        self._draw_mic_meter(rec.level)
        self._root.after(50, lambda: self._gs_mic_tick(rec, remaining - 1))

    def _draw_mic_meter(self, level):
        """Draw the microphone track and fill with rounded canvas shapes."""
        c = self._mic_meter
        c.delete("meter")
        w = max(sc(200), c.winfo_width())
        h = sc(10)
        r = h // 2
        c.create_oval(0, 0, h, h, fill=SURFACE0, outline="", tags="meter")
        c.create_oval(w - h, 0, w, h, fill=SURFACE0, outline="", tags="meter")
        c.create_rectangle(r, 0, w - r, h, fill=SURFACE0, outline="",
                           tags="meter")
        filled = max(0, min(w, int(level * w)))
        if filled:
            cap = min(filled, h)
            c.create_oval(0, 0, cap, h, fill=ACCENT, outline="", tags="meter")
            if filled > r:
                c.create_rectangle(r, 0, filled, h, fill=ACCENT, outline="",
                                   tags="meter")
            if filled >= w - r:
                c.create_oval(w - h, 0, w, h, fill=ACCENT, outline="",
                              tags="meter")

    def _gs_poll_entry(self):
        lbl = getattr(self, "_gs_done_lbl", None)
        if (self._win is None or not self._win.winfo_exists()
                or lbl is None or not lbl.winfo_exists()):
            return   # window closed or section switched — stop polling
        if len(self._gs_dict_var.get().strip()) > 10:
            self._gs_done = True
            self._gs_done_row.pack(fill="x", pady=(sc(8), 0))
            self._gs_done_lbl.pack(side="left")
            self._gs_finish_btn.pack(side="right")
            return
        self._root.after(500, self._gs_poll_entry)

    def _gs_finish(self):
        self._apply(onboarded=True)
        item = self._nav_items.pop("Get started", None)
        if item is not None:
            item["row"].destroy()
        self._select_section("General")

    # --- General -----------------------------------------------------------------

    def _build_general(self, pane):
        pane = self._scroll_pane(pane)
        self._header(pane, "General")

        if not self._provider_key("provider"):
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
        self._toggle_imgs_hover = _toggle_images(bg=CARD_HOVER)

        right, _ = self._row_card(pane, "Spoken language",
                                  "The language you dictate in.")
        code = self._config.get("language", "en")
        self._lang_lbl = self._dropdown(
            right, LANG_BY_CODE.get(code, code), self._open_lang_menu)

        right, _ = self._row_card(pane, "Microphone",
                                  "Where Undertone listens.")
        cur_dev = self._config.get("input_device", "")
        self._mic_dd = self._dropdown(
            right, _ellipsize(cur_dev) if cur_dev else "System default",
            self._open_mic_menu, width=190)

        self._config_toggle_card(
            pane, "Smart formatting", "smart_formatting",
            "Match spacing and capitalization to where you're typing.")
        left = self._config_toggle_card(
            pane, "AI cleanup", "ai_cleanup",
            "Clean up fillers and false starts with a fast grok model. Sends "
            "the text near your cursor to your cleanup provider.")
        self._cleanup_warn = tk.Label(left, text="", bg=CARD, fg=AMBER,
                                      font=HINT_FONT, anchor="w",
                                      justify="left", wraplength=sc(310))
        self._register_wrap(self._cleanup_warn, left)
        self._refresh_cleanup_hint()
        self._config_toggle_card(
            pane, "Sound cues", "sound_cues",
            "Play a soft tick when recording starts and stops.")

        self._group(pane, "System")
        self._autostart_card(pane)

        self._bind_wheel(pane)

    def _autostart_card(self, pane):
        """The Start-with-Windows toggle (shared by General and Get started)."""
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
                auto["state"]["set"](not on)
        state, sw, _left = self._toggle_card(
            pane, "Start with Windows",
            "Launch quietly in the tray when you sign in.",
            auto_on, set_autostart)
        auto.update(state=state, sw=sw)

    def _provider_key(self, provider_cfg_key):
        """The stored API key for the provider named by a config key."""
        provider = self._config.get(provider_cfg_key, "xai")
        field = KEY_FIELD_BY_PROVIDER.get(provider, "api_key")
        return self._config.get(field, "")

    def _setup_incomplete(self):
        """True until onboarding finished and the STT provider has a key."""
        return (not self._config.get("onboarded", False)
                or not self._provider_key("provider"))

    def _refresh_cleanup_hint(self):
        """Amber truth line inside the AI-cleanup card: the toggle is on but
        the cleanup provider has no key, so cleanup silently can't run."""
        lbl = getattr(self, "_cleanup_warn", None)
        if lbl is None or not lbl.winfo_exists():
            return
        if (self._config.get("ai_cleanup", True)
                and not self._provider_key("cleanup_provider")):
            cp = self._config.get("cleanup_provider", "xai")
            name = PROVIDER_BY_ID.get(cp, cp)
            article = "an" if name[:1].lower() in "aeioux" else "a"
            lbl.config(text=f"Needs {article} {name} API key — add one in "
                            "Providers.")
            lbl.pack(fill="x", pady=(sc(3), 0))
        else:
            lbl.pack_forget()

    def _open_mic_menu(self, ctrl):
        from recorder import list_input_devices
        entries = [("System default", lambda: self._pick_mic(""))]
        for _idx, name in list_input_devices():
            entries.append((name, lambda n=name: self._pick_mic(n)))
        self._popup_under(self._menu(entries), ctrl)

    def _pick_mic(self, name):
        self._mic_dd.config(text=_ellipsize(name) if name else "System default")
        self._apply(input_device=name)

    def _setup_banner(self, pane):
        outer = tk.Frame(pane, bg=pane.cget("bg"), highlightthickness=0)
        outer.pack(fill="x", pady=(0, sc(12)))
        self._rounded_container(outer, sc(8), BANNER_BG, BANNER_BORDER)
        inner = tk.Frame(outer, bg=BANNER_BG)
        inner.pack(fill="x", padx=sc(14), pady=sc(12))
        target = ("Get started" if "Get started" in self._nav_items
                  else "Providers")
        RoundButton(inner, f"Open {target}",
                    lambda: self._select_section(target),
                    kind="accent", small=True,
                    bg=BANNER_BG).pack(side="right", padx=(sc(14), 0))
        left = tk.Frame(inner, bg=BANNER_BG)
        left.pack(side="left", fill="x", expand=True)
        tk.Label(left, text="Finish setting up Undertone", bg=BANNER_BG,
                 fg=TEXT, font=CARD_TITLE_FONT, anchor="w").pack(fill="x")
        hint = tk.Label(left,
                        text="Add an API key for your transcription provider "
                             "to start dictating.",
                        bg=BANNER_BG, fg=SUBTEXT, font=HINT_FONT, anchor="w",
                        justify="left", wraplength=sc(330))
        hint.pack(fill="x", pady=(sc(2), 0))
        self._register_wrap(hint, left)

    def _config_toggle_card(self, pane, title, key, hint):
        def change(on):
            self._apply(**{key: on})
            self._refresh_cleanup_hint()   # no-op unless the card shows it
        _state, _sw, left = self._toggle_card(
            pane, title, hint, self._config.get(key, True), change)
        return left

    def _shortcut_card(self, pane, title, config_key, hint):
        right, widgets = self._row_card(pane, title, hint, wrap=270)
        left = widgets[1]
        combo = self._config.get(config_key, "")
        box = tk.Frame(right, bg=CARD, highlightthickness=0)
        box.pack(side="left")
        self._rounded_container(box, sc(6), SURFACE0, SURFACE1, bg=CARD)
        lbl = tk.Label(box, text=pretty_combo(combo) or "None", bg=SURFACE0,
                       fg=TEXT, font=KEY_FONT, padx=sc(12), pady=sc(3))
        lbl.pack(padx=sc(2), pady=sc(2))
        btn = RoundButton(right, "Change",
                          lambda k=config_key: self._start_capture(k),
                          small=True, bg=CARD)
        btn.pack(side="left", padx=(sc(8), 0))
        # Lives inside the card's text column so it shows up next to the
        # shortcut it belongs to; packed only when a capture fails.
        error = tk.Label(left, text="", bg=CARD, fg=RED, font=HINT_FONT,
                         anchor="w", justify="left", wraplength=sc(270))
        self._register_wrap(error, left)
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
        entry_wrap, entry = self._entry(row, self._vocab_var)
        entry_wrap.pack(side="left", fill="x", expand=True)
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
        e1_wrap, e1 = self._entry(row2, self._corr_heard)
        e1_wrap.pack(side="left", fill="x", expand=True)
        tk.Label(row2, text="→", bg=CARD, fg=SUBTEXT, font=FONT,
                 padx=sc(8)).pack(side="left")
        e2_wrap, e2 = self._entry(row2, self._corr_right)
        e2_wrap.pack(side="left", fill="x", expand=True)
        e1.bind("<Return>", lambda _e: self._add_correction())
        e2.bind("<Return>", lambda _e: self._add_correction())
        self._corr_heard_entry = e1   # History's "Add correction…" focuses it
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

        self._hist_expanded_ts = None
        self._hist_fp = None
        self._hist_list = self._scroll_list(pane, height=None, expand=True)
        self._render_history()
        self._hist_poll_id = self._root.after(2000, self._hist_poll)

    def _hist_snapshot(self):
        if self._history_getter is None:
            return []
        try:
            return self._history_getter() or []
        except Exception:
            return []

    @staticmethod
    def _hist_fingerprint(items):
        return tuple((e.get("ts"), e.get("ok", True)) for e in items)

    def _hist_poll(self):
        """While History is showing, re-render every 2 s — but only when the
        entries actually changed, so an expanded row isn't fought with."""
        self._hist_poll_id = None
        if (self._win is None or not self._win.winfo_exists()
                or not self._hist_list.winfo_exists()):
            return
        items = self._hist_snapshot()
        if self._hist_fingerprint(items) != self._hist_fp:
            self._render_history(items)
        self._hist_poll_id = self._root.after(2000, self._hist_poll)

    def _cancel_history_poll(self):
        if self._hist_poll_id is not None:
            self._root.after_cancel(self._hist_poll_id)
            self._hist_poll_id = None

    def _render_history(self, items=None):
        if items is None:
            items = self._hist_snapshot()
        self._hist_fp = self._hist_fingerprint(items)
        inner = self._hist_list
        for w in inner.winfo_children():
            w.destroy()
        if not items:
            self._empty_row(inner, "Nothing dictated yet this session. Hold "
                                   "your shortcut and speak — dictations "
                                   "appear here.")
            return
        if not any(e.get("ts") == self._hist_expanded_ts for e in items):
            self._hist_expanded_ts = None   # the expanded entry is gone
        for entry in items:
            if entry.get("ok", True):
                self._hist_ok_row(inner, entry)
            else:
                self._hist_fail_row(inner, entry)

    def _hist_wheel(self, *widgets):
        """Route wheel events over history widgets to the list scroll."""
        wheel = getattr(self._hist_list, "_wheel", None)
        if wheel is not None:
            for w in widgets:
                w.bind("<MouseWheel>", wheel)

    def _hist_ok_row(self, inner, entry):
        ts, text = entry["ts"], entry["text"]
        row = tk.Frame(inner, bg=MANTLE, cursor="hand2")
        row.pack(fill="x", pady=1)
        when = time.strftime("%H:%M", time.localtime(ts))
        when_lbl = tk.Label(row, text=when, bg=MANTLE, fg=MUTED,
                            font=HINT_FONT, width=6, anchor="w",
                            padx=sc(10), cursor="hand2")
        when_lbl.pack(side="left")
        paste_btn = RoundButton(row, "Paste", lambda t=text: self._repaste(t),
                                small=True, bg=MANTLE)
        paste_btn.pack(side="right", padx=(0, sc(8)), pady=sc(3))
        copy_btn = RoundButton(row, "Copy", lambda t=text: self._copy(t),
                               small=True, bg=MANTLE)
        copy_btn.pack(side="right", padx=(0, sc(6)), pady=sc(3))
        preview = text.replace("\n", " ").strip()
        if len(preview) > 46:
            preview = preview[:45] + "…"
        prev_lbl = tk.Label(row, text=preview, bg=MANTLE, fg=TEXT,
                            font=FONT, anchor="w", cursor="hand2")
        prev_lbl.pack(side="left", fill="x", expand=True,
                      padx=(sc(4), sc(8)))
        self._hover_row(row, [when_lbl, prev_lbl], (copy_btn, paste_btn))
        # Clicking the row text expands/collapses the inline detail panel.
        for w in (row, when_lbl, prev_lbl):
            w.bind("<Button-1>", lambda _e, t=ts: self._hist_toggle(t))
        self._hist_wheel(row, when_lbl, prev_lbl, copy_btn, paste_btn)
        if self._hist_expanded_ts == ts:
            self._hist_detail(inner, entry)

    def _hist_detail(self, inner, entry):
        """The inline expansion under a successful row: full text, what was
        heard (when different), and quick actions."""
        panel = tk.Frame(inner, bg=MANTLE)
        panel.pack(fill="x", pady=(0, sc(6)))
        pad = sc(66)   # align under the preview column
        widgets = [panel]
        full = tk.Label(panel, text=entry["text"], bg=MANTLE, fg=TEXT,
                        font=FONT, anchor="w", justify="left",
                        wraplength=sc(420))
        full.pack(fill="x", padx=(pad, sc(10)))
        self._register_wrap(full, panel, subtract=76)
        widgets.append(full)
        raw = entry.get("raw")
        if raw and raw != entry["text"]:
            heard = tk.Label(panel, text=f"Heard: {raw}", bg=MANTLE, fg=MUTED,
                             font=HINT_FONT, anchor="w", justify="left",
                             wraplength=sc(420))
            heard.pack(fill="x", padx=(pad, sc(10)), pady=(sc(4), 0))
            self._register_wrap(heard, panel, subtract=76)
            widgets.append(heard)
        btns = tk.Frame(panel, bg=MANTLE)
        btns.pack(fill="x", padx=(pad, sc(10)), pady=(sc(7), sc(4)))
        widgets.append(btns)
        if raw:
            b = RoundButton(btns, "Copy raw", lambda r=raw: self._copy(r),
                            small=True, bg=MANTLE)
            b.pack(side="left", padx=(0, sc(6)))
            widgets.append(b)
        corr = RoundButton(
            btns, "Add correction…",
            lambda: self._hist_add_correction(raw or entry["text"]),
            small=True, bg=MANTLE)
        corr.pack(side="left")
        widgets.append(corr)
        self._hist_wheel(*widgets)

    def _hist_toggle(self, ts):
        self._hist_expanded_ts = None if self._hist_expanded_ts == ts else ts
        self._render_history()

    def _hist_add_correction(self, heard):
        """Jump to Dictionary with the misheard text staged for a correction."""
        self._select_section("Dictionary")
        self._corr_heard.set(heard)
        self._corr_heard_entry.focus_set()
        self._corr_heard_entry.icursor("end")

    def _hist_fail_row(self, inner, entry):
        row = tk.Frame(inner, bg=MANTLE)
        row.pack(fill="x", pady=1)
        when = time.strftime("%H:%M", time.localtime(entry["ts"]))
        when_lbl = tk.Label(row, text=f"✕ {when}", bg=MANTLE, fg=AMBER,
                            font=HINT_FONT, width=8, anchor="w", padx=sc(10))
        when_lbl.pack(side="left")
        labels = [when_lbl]
        buttons = []
        if "wav" in entry:
            retry = RoundButton(row, "Retry",
                                lambda w=entry["wav"]: self._retry(w),
                                kind="accent", small=True, bg=MANTLE)
            retry.pack(side="right", padx=(0, sc(8)), pady=sc(3))
            buttons.append(retry)
        err = " ".join(entry.get("error", "").split())
        if len(err) > 60:
            err = err[:59].rstrip() + "…"
        err_lbl = tk.Label(row, text=err, bg=MANTLE, fg=SUBTEXT, font=FONT,
                           anchor="w")
        err_lbl.pack(side="left", fill="x", expand=True, padx=(sc(4), sc(8)))
        labels.append(err_lbl)
        self._hover_row(row, labels, tuple(buttons))
        self._hist_wheel(row, *labels, *buttons)

    def _retry(self, wav):
        """Retry a failed dictation. Minimize first so focus returns to the
        previous app (same pattern as _repaste), then hand the audio back."""
        if self._on_retry is None:
            return
        if self._win is not None and self._win.winfo_exists():
            self._win.iconify()
        self._root.after(600, lambda: self._on_retry(wav))

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
        self._register_wrap(self._test_status, body)

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
        entry_wrap, entry = self._entry(row, var, show="•")
        entry_wrap.pack(side="left", fill="x", expand=True)
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
        entry_wrap, entry = self._entry(row, var)
        entry_wrap.pack(side="left", fill="x", expand=True)
        entry.bind("<Return>", lambda _e: self._save_model(kind, var))
        RoundButton(row, "Save", lambda: self._save_model(kind, var),
                    kind="accent", small=True,
                    bg=CARD).pack(side="right", padx=(sc(6), 0))
        hint = tk.Label(parent, text="", bg=CARD, fg=MUTED, font=HINT_FONT,
                        anchor="w", justify="left", wraplength=sc(440))
        hint.pack(fill="x", pady=(sc(3), 0))
        self._register_wrap(hint, parent)
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
        box.pack(fill="x", expand=True)
        self._about_icon = ImageTk.PhotoImage(load_app_image(sc(64)))
        tk.Label(box, image=self._about_icon, bg=BASE).pack(pady=(sc(30), sc(12)))
        tk.Label(box, text="Undertone", bg=BASE, fg=TEXT,
                 font=("Segoe UI Semibold", 16)).pack()
        tk.Label(box, text=f"Version {APP_VERSION}", bg=BASE, fg=MUTED,
                 font=HINT_FONT).pack(pady=(sc(2), sc(14)))
        tk.Label(box, text="Push-to-talk dictation for Windows.", bg=BASE,
                 fg=SUBTEXT, font=FONT).pack()
        about_hint = tk.Label(
            box,
            text="Hold your shortcut, speak, release — the transcript "
                 "is typed into whatever text box has focus. Audio is "
                 "sent only to your chosen provider, only while you "
                 "dictate. Your API keys and settings stay on this "
                 "computer.",
            bg=BASE, fg=MUTED, font=HINT_FONT, wraplength=sc(400),
            justify="center")
        about_hint.pack(padx=sc(45), pady=(sc(10), sc(20)))
        self._register_wrap(about_hint, box, subtract=90)

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

    def _scroll_list(self, parent, height, expand=False):
        """A dark, scrollable list region; returns its inner Frame.

        The scrollbar is a hand-drawn thumb (native tk.Scrollbar ignores
        colours on Windows) that auto-hides when the content fits.
        """
        wrap = tk.Frame(parent, bg=parent.cget("bg"), highlightthickness=0)
        wrap._own_wheel = True   # keep _bind_wheel out of this subtree
        wrap.pack(fill="both" if expand else "x", expand=expand)
        self._rounded_container(wrap, sc(8), MANTLE, CARD_BORDER,
                                bg=parent.cget("bg"))
        body = tk.Frame(wrap, bg=MANTLE)
        body.pack(fill="both", expand=True, padx=sc(6), pady=HAIR)
        canvas_opts = {"bg": MANTLE, "highlightthickness": 0, "bd": 0}
        if height is not None:
            canvas_opts["height"] = height
        canvas = tk.Canvas(body, **canvas_opts)
        canvas.pack(side="left", fill="both", expand=True)
        bar_opts = {"bg": MANTLE, "width": sc(8),
                    "highlightthickness": 0, "bd": 0}
        if height is not None:
            bar_opts["height"] = height
        bar = tk.Canvas(body, **bar_opts)
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
        label = tk.Label(parent, text=text, bg=MANTLE, fg=MUTED,
                         font=HINT_FONT, anchor="w", justify="left",
                         padx=sc(10), pady=sc(8), wraplength=sc(420))
        label.pack(fill="x")
        self._register_wrap(label, parent, subtract=20)

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
        self._hover_row(row, [lbl, x])
        wheel = getattr(parent, "_wheel", None)
        if wheel is not None:
            for w in (row, lbl, x):
                w.bind("<MouseWheel>", wheel)

    def _hover_row(self, row, labels, buttons=()):
        """Lift a MANTLE list row to ROW_HOVER while the pointer is over it."""
        def paint(inside):
            def fn(_e):
                bg = ROW_HOVER if inside else MANTLE
                for w in (row, *labels):
                    w.configure(bg=bg)
                for b in buttons:
                    b.set_bg(bg)
            return fn
        # add="+": buttons and the ✕ keep their own Enter/Leave behaviors.
        for w in (row, *labels, *buttons):
            w.bind("<Enter>", paint(True), add="+")
            w.bind("<Leave>", paint(False), add="+")

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
            # suppress: captured keystrokes must not leak into whatever
            # app happens to hold keyboard focus.
            combo = keyboard.read_hotkey(suppress=True)
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

        if not cancelled:
            # A combo can serve only one shortcut at a time.
            for key, label in (("hotkey", "Push-to-talk"),
                               ("repaste_hotkey", "Re-paste"),
                               ("toggle_hotkey", "the toggle key")):
                if (key != self._capture_target
                        and self._config.get(key, "") == new_hotkey):
                    if alive:
                        row["error"].config(text=f"Already used by {label}.")
                        row["error"].pack(fill="x", pady=(sc(3), 0))
                    cancelled = True
                    break

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

    def _screen_bounds(self):
        """Return the Windows virtual-desktop bounds (left, top, right, bottom)."""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            x = user32.GetSystemMetrics(76)   # SM_XVIRTUALSCREEN
            y = user32.GetSystemMetrics(77)   # SM_YVIRTUALSCREEN
            w = user32.GetSystemMetrics(78)   # SM_CXVIRTUALSCREEN
            h = user32.GetSystemMetrics(79)   # SM_CYVIRTUALSCREEN
            if w > 0 and h > 0:
                return x, y, x + w, y + h
        except Exception:
            pass
        return (0, 0, self._win.winfo_screenwidth(),
                self._win.winfo_screenheight())

    def _valid_geometry(self, value):
        if not isinstance(value, str):
            return None
        match = re.fullmatch(r"(\d+)x(\d+)([+-]\d+)([+-]\d+)", value)
        if match is None:
            return None
        w, h, x, y = map(int, match.groups())
        if w < sc(660) or h < sc(560):
            return None
        left, top, right, bottom = self._screen_bounds()
        visible = sc(40)
        if (x + w < left + visible or x > right - visible
                or y + h < top + visible or y > bottom - visible):
            return None
        return f"{w}x{h}{x:+d}{y:+d}"

    def _restore_geometry(self):
        geometry = self._valid_geometry(self._config.get("window_geometry"))
        if geometry is None:
            geometry = self._center()
        else:
            self._win.geometry(geometry)
        return geometry

    def _center(self):
        self._win.update_idletasks()
        w, h = sc(WIN_W), sc(WIN_H)
        x = (self._win.winfo_screenwidth() - w) // 2
        y = (self._win.winfo_screenheight() - h) // 2 - sc(30)
        geometry = f"{w}x{h}+{x}+{y}"
        self._win.geometry(geometry)
        return geometry

    def _raise(self):
        win = self._win
        win.deiconify()
        win.attributes("-topmost", True)
        win.lift()
        win.focus_force()
        win.after(200, lambda: win.winfo_exists()
                  and win.attributes("-topmost", False))

    def _on_escape(self, _e=None):
        if not self._capturing:   # during capture, Esc cancels the capture
            self._close()

    def _close(self):
        self._cancel_history_poll()
        for attr in ("_freeze_enter_after_id", "_freeze_exit_after_id"):
            after_id = getattr(self, attr)
            if after_id is not None:
                try:
                    self._win.after_cancel(after_id)
                except tk.TclError:
                    pass
                setattr(self, attr, None)
        if self._resize_after_id is not None:
            try:
                self._win.after_cancel(self._resize_after_id)
            except tk.TclError:
                pass
            self._resize_after_id = None
        if self._capturing:
            self._capturing = False
            if self._on_capture_end is not None:
                try:
                    self._on_capture_end()
                except Exception:
                    pass
        if self._win is not None and self._win.winfo_exists():
            self._win.update_idletasks()
            geometry = self._win.winfo_geometry()
            self._config = {**self._config, "window_geometry": geometry}
            self._on_save(self._config)
            self._win.destroy()
        self._size_move_active = False
        self._freeze_start_size = None
        self._resize_snapshot_label = None
        self._resize_snapshot_photo = None
        self._client_hwnd = None
        self._last_client_size = None
        self._win = None
