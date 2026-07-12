"""Tray icon and settings window for Undertone.

The settings window is a dark two-pane panel: a sidebar with General /
Providers / About sections and a content pane. All changes apply immediately
(no Save/Cancel); a transient "Saved" hint confirms each change. Styled by
hand with plain tk widgets plus Pillow-rendered imagery (tray icon, toggle
switches) supersampled 4x for crisp edges.

Thread-safety: open() may be called from the pystray thread; work is
marshalled onto the Tk main loop via a queue drained by root.after().
"""

import pathlib
import queue
import threading
import time
import tkinter as tk
import tkinter.font  # noqa: F401  (ensures font submodule is loaded)
import webbrowser
from typing import Callable, List, Optional, Tuple

import keyboard
import pyperclip
import pystray
from PIL import Image, ImageDraw, ImageTk

import autostart
from config import APP_VERSION

from theme import (ACCENT, ACCENT_DOWN, ACCENT_HOVER, BASE, GREEN, INK, MANTLE,
                   MUTED, RED, SUBTEXT, SURFACE0, SURFACE1, TEXT)

FONT = ("Segoe UI", 10)
HEADER_FONT = ("Segoe UI Semibold", 14)
LABEL_FONT = ("Segoe UI", 10)
HINT_FONT = ("Segoe UI", 9)
BTN_FONT = ("Segoe UI Semibold", 10)
NAV_FONT = ("Segoe UI", 10)
TITLE_FONT = ("Segoe UI Semibold", 11)

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


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def _pretty_combo(combo: str) -> str:
    """'ctrl+alt+v' -> 'Ctrl+Alt+V' for display in hints."""
    return "+".join(p.strip().title() for p in combo.split("+") if p.strip())


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


def _toggle_images(size=(40, 22)):
    """(off, on) PhotoImages for a switch, rendered on the BASE background."""
    out = []
    w, h = size[0] * 4, size[1] * 4
    for on in (False, True):
        img = Image.new("RGB", (w, h), _rgb(BASE))
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
        win.geometry("640x584")

        # Sidebar ------------------------------------------------------------
        side = tk.Frame(win, bg=MANTLE, width=180)
        side.pack(side="left", fill="y")
        side.pack_propagate(False)

        brand = tk.Frame(side, bg=MANTLE)
        brand.pack(fill="x", padx=16, pady=(18, 14))
        self._brand_icon = ImageTk.PhotoImage(load_app_image(28))
        tk.Label(brand, image=self._brand_icon, bg=MANTLE).pack(side="left")
        name = tk.Frame(brand, bg=MANTLE)
        name.pack(side="left", padx=(8, 0))
        tk.Label(name, text="Undertone", bg=MANTLE, fg=TEXT,
                 font=TITLE_FONT, anchor="w").pack(fill="x")
        tk.Label(name, text=f"v{APP_VERSION}", bg=MANTLE, fg=MUTED,
                 font=("Segoe UI", 8), anchor="w").pack(fill="x")

        self._nav_items = {}
        self._content = tk.Frame(win, bg=BASE)
        self._content.pack(side="left", fill="both", expand=True)

        for section in ("General", "Dictionary", "History", "Providers", "About"):
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

    def _make_nav_item(self, parent, section):
        row = tk.Frame(parent, bg=MANTLE, cursor="hand2")
        row.pack(fill="x", pady=1)
        bar = tk.Frame(row, bg=MANTLE, width=3)
        bar.pack(side="left", fill="y")
        lbl = tk.Label(row, text=section, bg=MANTLE, fg=SUBTEXT,
                       font=NAV_FONT, anchor="w", padx=14, pady=7)
        lbl.pack(side="left", fill="x", expand=True)

        def enter(_):
            if getattr(self, "_active_section", None) != section:
                for w in (row, lbl):
                    w.configure(bg="#1f1f30")
        def leave(_):
            if getattr(self, "_active_section", None) != section:
                for w in (row, lbl):
                    w.configure(bg=MANTLE)
        for w in (row, lbl, bar):
            w.bind("<Enter>", enter)
            w.bind("<Leave>", leave)
            w.bind("<Button-1>", lambda _e, s=section: self._select_section(s))
        return {"row": row, "bar": bar, "label": lbl}

    def _select_section(self, section):
        self._active_section = section
        for name, item in self._nav_items.items():
            active = name == section
            bg = SURFACE0 if active else MANTLE
            item["row"].configure(bg=bg)
            item["label"].configure(bg=bg, fg=TEXT if active else SUBTEXT)
            item["bar"].configure(bg=ACCENT if active else bg)
        for child in self._content.winfo_children():
            child.destroy()
        pane = tk.Frame(self._content, bg=BASE)
        pane.pack(fill="both", expand=True, padx=28, pady=(22, 16))
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
        self._saved_lbl.place(relx=1.0, rely=1.0, x=-18, y=-12, anchor="se")

    # --- Sections -------------------------------------------------------------

    def _header(self, parent, text):
        tk.Label(parent, text=text, bg=BASE, fg=TEXT, font=HEADER_FONT,
                 anchor="w").pack(fill="x", pady=(0, 16))

    def _label(self, parent, text, pady=(0, 5)):
        tk.Label(parent, text=text, bg=BASE, fg=SUBTEXT, font=LABEL_FONT,
                 anchor="w").pack(fill="x", pady=pady)

    def _hint(self, parent, text, pady=(5, 0)):
        lbl = tk.Label(parent, text=text, bg=BASE, fg=MUTED, font=HINT_FONT,
                       anchor="w", justify="left", wraplength=390)
        lbl.pack(fill="x", pady=pady)
        return lbl

    def _build_general(self, pane):
        # Two shortcut rows plus four toggles overflow the window, so the
        # whole pane scrolls like Providers does.
        pane = self._scroll_pane(pane)
        self._header(pane, "General")

        # Shortcuts ------------------------------------------------------------
        self._shortcut_rows = {}
        self._shortcut_row(
            pane, "Push-to-talk shortcut", "hotkey",
            "Hold this key (or combination) to dictate; release to "
            "transcribe. Esc cancels a capture.")
        self._shortcut_row(
            pane, "Re-paste shortcut", "repaste_hotkey",
            "Pastes your most recent dictation again, wherever your "
            "cursor is now.")

        tk.Frame(pane, bg=BASE, height=14).pack()

        # Language -------------------------------------------------------------
        self._label(pane, "Spoken language")
        code = self._config.get("language", "en")
        ctrl = tk.Frame(pane, bg=SURFACE0, cursor="hand2",
                        highlightthickness=1, highlightbackground=SURFACE1)
        ctrl.pack(fill="x")
        self._lang_ctrl = ctrl
        self._lang_lbl = tk.Label(
            ctrl, text=LANG_BY_CODE.get(code, code), bg=SURFACE0, fg=TEXT,
            font=FONT, anchor="w", padx=12, pady=7)
        self._lang_lbl.pack(side="left", fill="x", expand=True)
        caret = tk.Label(ctrl, text="⌄", bg=SURFACE0, fg=SUBTEXT,
                         font=FONT, padx=12)
        caret.pack(side="right")

        def lang_hover(bg):
            def fn(_e):
                for w in (ctrl, self._lang_lbl, caret):
                    w.configure(bg=bg)
            return fn
        for w in (ctrl, self._lang_lbl, caret):
            w.bind("<Button-1>", lambda _e: self._open_lang_menu())
            w.bind("<Enter>", lang_hover(SURFACE1))
            w.bind("<Leave>", lang_hover(SURFACE0))

        tk.Frame(pane, bg=BASE, height=18).pack()

        # Start with Windows -----------------------------------------------------
        row2 = tk.Frame(pane, bg=BASE)
        row2.pack(fill="x")
        tk.Label(row2, text="Start with Windows", bg=BASE, fg=SUBTEXT,
                 font=LABEL_FONT).pack(side="left")
        self._toggle_imgs = _toggle_images()
        self._autostart_on = False
        try:
            self._autostart_on = autostart.is_enabled()
        except Exception:
            pass
        self._autostart_lbl = tk.Label(
            row2, image=self._toggle_imgs[int(self._autostart_on)], bg=BASE,
            cursor="hand2")
        self._autostart_lbl.pack(side="right")
        self._autostart_lbl.bind("<Button-1>", self._toggle_autostart)
        self._hint(pane, "Launch quietly in the tray when you sign in.")

        tk.Frame(pane, bg=BASE, height=14).pack()
        self._make_toggle(
            pane, "Smart formatting", "smart_formatting",
            "Adds spaces and fixes capitalization to match where you're typing.")

        tk.Frame(pane, bg=BASE, height=14).pack()
        self._make_toggle(
            pane, "AI cleanup", "ai_cleanup",
            "A fast grok model removes fillers and false starts and fits the "
            "wording in place. Sends the text near your cursor to xAI along "
            "with the audio.")

        tk.Frame(pane, bg=BASE, height=14).pack()
        self._make_toggle(
            pane, "Sound cues", "sound_cues",
            "Soft tick when recording starts and stops.")

    def _make_toggle(self, pane, label, key, hint):
        """A label + switch row bound to a boolean config key (immediate-apply)."""
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        tk.Label(row, text=label, bg=BASE, fg=SUBTEXT,
                 font=LABEL_FONT).pack(side="left")
        state = {"on": bool(self._config.get(key, True))}
        sw = tk.Label(row, image=self._toggle_imgs[int(state["on"])], bg=BASE,
                      cursor="hand2")
        sw.pack(side="right")

        def toggle(_e=None):
            state["on"] = not state["on"]
            sw.config(image=self._toggle_imgs[int(state["on"])])
            self._apply(**{key: state["on"]})
        sw.bind("<Button-1>", toggle)
        self._hint(pane, hint)

    def _build_providers(self, pane):
        # The pane's content exceeds the window once Advanced is expanded, so
        # everything lives in a borderless BASE-coloured scroll region (thumb
        # auto-hides while it all fits).
        body = self._scroll_pane(pane)

        self._header(body, "Providers")

        # Provider dropdowns (styled like the General "Spoken language" one) ---
        self._provider_row(body, "Transcription", "provider")
        tk.Frame(body, bg=BASE, height=8).pack()
        self._provider_row(body, "AI cleanup", "cleanup_provider")
        self._hint(body,
                   "Transcription converts your speech; AI cleanup polishes "
                   "it. Model overrides live under Advanced below.")

        tk.Frame(body, bg=BASE, height=12).pack()

        # Per-provider API keys ------------------------------------------------
        self._key_vars = {}
        self._key_status_lbls = {}
        self._key_block(body, "xAI API key", "api_key")
        self._key_block(body, "OpenAI API key", "openai_api_key")
        self._key_block(body, "OpenRouter API key", "openrouter_api_key")

        # Test buttons + shared status -----------------------------------------
        tests = tk.Frame(body, bg=BASE)
        tests.pack(fill="x", pady=(2, 0))
        self._test_stt_btn = self._make_button(
            tests, "Test transcription", self._test_transcription, small=True)
        self._test_stt_btn.pack(side="left")
        self._test_cleanup_btn = self._make_button(
            tests, "Test cleanup", self._test_cleanup, small=True)
        self._test_cleanup_btn.pack(side="left", padx=(8, 0))
        self._test_status = tk.Label(body, text="", bg=BASE, fg=MUTED,
                                     font=HINT_FONT, anchor="w",
                                     justify="left", wraplength=390)
        self._test_status.pack(fill="x", pady=(6, 0))

        # Advanced disclosure: model overrides (collapsed by default) ----------
        adv_toggle = tk.Label(body, text="Advanced ▸", bg=BASE, fg=SUBTEXT,
                              font=LABEL_FONT, anchor="w", cursor="hand2")
        adv_toggle.pack(fill="x", pady=(12, 0))
        adv = tk.Frame(body, bg=BASE)
        self._adv_open = False

        def toggle_adv(_e=None):
            self._adv_open = not self._adv_open
            adv_toggle.config(text="Advanced ▾" if self._adv_open
                              else "Advanced ▸")
            if self._adv_open:
                adv.pack(fill="x", pady=(4, 0), after=adv_toggle)
            else:
                adv.pack_forget()
        adv_toggle.bind("<Button-1>", toggle_adv)

        self._model_vars = {}
        self._stt_model_hint = self._model_row(
            adv, "Transcription model", "stt")
        self._cleanup_model_hint = self._model_row(
            adv, "Cleanup model", "cleanup")
        self._refresh_model_hints()

        # Links -----------------------------------------------------------------
        links = tk.Frame(body, bg=BASE)
        links.pack(fill="x", pady=(14, 0))
        for i, (text, url) in enumerate(PROVIDER_LINKS):
            if i:
                tk.Label(links, text="·", bg=BASE, fg=MUTED,
                         font=HINT_FONT).pack(side="left", padx=5)
            lk = tk.Label(links, text=text, bg=BASE, fg=ACCENT, font=HINT_FONT,
                          cursor="hand2")
            lk.pack(side="left")
            lk.bind("<Button-1>", lambda _e, u=url: webbrowser.open(u))

        self._bind_wheel(body)

    def _bind_wheel(self, widget):
        """Recursively route mouse-wheel events to the scroll pane."""
        widget.bind("<MouseWheel>", self._scroll_wheel)
        for child in widget.winfo_children():
            self._bind_wheel(child)

    def _scroll_pane(self, parent):
        """A borderless, BASE-coloured vertical scroll region filling parent.

        Mirrors _scroll_list but blends into the pane (no border/MANTLE box)
        and grows with its parent so the Providers content can overflow the
        window; the hand-drawn thumb hides itself when everything fits.
        """
        canvas = tk.Canvas(parent, bg=BASE, highlightthickness=0, bd=0)
        canvas.pack(side="left", fill="both", expand=True)
        bar = tk.Canvas(parent, bg=BASE, width=8, highlightthickness=0, bd=0)
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
                bar.coords(thumb, 2, first * bh + 1, 7, last * bh - 1)

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
        # Wheel anywhere over the pane scrolls it.
        for w in (canvas, inner, bar):
            w.bind("<MouseWheel>", wheel)
        self._scroll_wheel = wheel
        bar.bind("<Button-1>", drag)
        bar.bind("<B1-Motion>", drag)
        return inner

    def _provider_row(self, pane, label, config_key):
        """A provider dropdown styled exactly like the language dropdown."""
        self._label(pane, label)
        cur = self._config.get(config_key, "xai")
        ctrl = tk.Frame(pane, bg=SURFACE0, cursor="hand2",
                        highlightthickness=1, highlightbackground=SURFACE1)
        ctrl.pack(fill="x")
        lbl = tk.Label(ctrl, text=PROVIDER_BY_ID.get(cur, cur), bg=SURFACE0,
                       fg=TEXT, font=FONT, anchor="w", padx=12, pady=7)
        lbl.pack(side="left", fill="x", expand=True)
        caret = tk.Label(ctrl, text="⌄", bg=SURFACE0, fg=SUBTEXT, font=FONT,
                         padx=12)
        caret.pack(side="right")

        def hover(bg):
            def fn(_e):
                for w in (ctrl, lbl, caret):
                    w.configure(bg=bg)
            return fn
        for w in (ctrl, lbl, caret):
            w.bind("<Button-1>",
                   lambda _e: self._open_provider_menu(ctrl, lbl, config_key))
            w.bind("<Enter>", hover(SURFACE1))
            w.bind("<Leave>", hover(SURFACE0))

    def _open_provider_menu(self, ctrl, lbl, config_key):
        menu = tk.Menu(
            self._win, tearoff=0, bg=SURFACE0, fg=TEXT,
            activebackground=ACCENT, activeforeground=INK,
            relief="flat", bd=0, font=FONT,
        )
        for name, pid in PROVIDERS_UI:
            menu.add_command(
                label=f"  {name}",
                command=lambda n=name, p=pid: self._pick_provider(
                    lbl, config_key, n, p))
        x = ctrl.winfo_rootx()
        y = ctrl.winfo_rooty() + ctrl.winfo_height() + 2
        menu.tk_popup(x, y)

    def _pick_provider(self, lbl, config_key, name, pid):
        lbl.config(text=name)
        self._apply(**{config_key: pid})
        # Advanced fields show the newly selected provider's own override.
        for kind, var in getattr(self, "_model_vars", {}).items():
            var.set(self._model_override(kind))
        self._refresh_model_hints()

    def _key_block(self, pane, label, field):
        """A labelled API-key entry with Show/Save buttons and a status line."""
        self._label(pane, label, pady=(0, 3))
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        var = tk.StringVar(value=self._config.get(field, ""))
        entry = tk.Entry(
            row, textvariable=var, font=FONT, show="•", bg=SURFACE0, fg=TEXT,
            insertbackground=TEXT, relief="flat", highlightthickness=1,
            highlightbackground=SURFACE1, highlightcolor=ACCENT)
        entry.pack(side="left", fill="x", expand=True, ipady=5)
        save_btn = self._make_button(
            row, "Save", lambda f=field: self._save_key(f), kind="accent",
            small=True)
        save_btn.pack(side="right", padx=(6, 0))
        show_btn = self._make_button(row, "Show", lambda: None, small=True)
        show_btn.config(command=lambda: self._toggle_show(entry, show_btn))
        show_btn.pack(side="right", padx=(6, 0))
        status = tk.Label(pane, text=self._key_status_text(field), bg=BASE,
                          fg=MUTED, font=HINT_FONT, anchor="w")
        status.pack(fill="x", pady=(3, 8))
        self._key_vars[field] = var
        self._key_status_lbls[field] = status

    def _model_row(self, parent, label, kind):
        """A model-override entry (per-provider) with Save and a live hint."""
        self._label(parent, label, pady=(6, 3))
        row = tk.Frame(parent, bg=BASE)
        row.pack(fill="x")
        var = tk.StringVar(value=self._model_override(kind))
        entry = tk.Entry(
            row, textvariable=var, font=FONT, bg=SURFACE0, fg=TEXT,
            insertbackground=TEXT, relief="flat", highlightthickness=1,
            highlightbackground=SURFACE1, highlightcolor=ACCENT)
        entry.pack(side="left", fill="x", expand=True, ipady=5)
        self._make_button(
            row, "Save", lambda: self._save_model(kind, var),
            kind="accent", small=True).pack(side="right", padx=(6, 0))
        hint = tk.Label(parent, text="", bg=BASE, fg=MUTED, font=HINT_FONT,
                        anchor="w", justify="left", wraplength=390)
        hint.pack(fill="x", pady=(3, 0))
        self._model_vars[kind] = var
        return hint

    def _model_provider(self, kind):
        pkey = "provider" if kind == "stt" else "cleanup_provider"
        return self._config.get(pkey, "xai")

    def _model_override(self, kind):
        models = self._config.get(kind + "_models") or {}
        return models.get(self._model_provider(kind), "")

    def _build_about(self, pane):
        self._header(pane, "About")
        tk.Label(pane, text=f"Undertone  ·  version {APP_VERSION}",
                 bg=BASE, fg=TEXT, font=FONT, anchor="w").pack(fill="x")
        self._hint(pane,
                   "Hold your shortcut, speak, release — the transcript is "
                   "typed into whatever text box has focus. Transcription "
                   "runs on your configured provider (xAI, OpenAI, or "
                   "OpenRouter); audio is sent only while you dictate.",
                   pady=(10, 0))
        self._hint(pane, "Your API key and settings are stored locally in "
                         "your user profile.", pady=(8, 0))
        link = tk.Label(pane, text="Open settings folder", bg=BASE, fg=ACCENT,
                        font=HINT_FONT, anchor="w", cursor="hand2")
        link.pack(fill="x", pady=(14, 0))

        def open_folder(_e):
            import os
            from config import CONFIG_PATH
            os.startfile(CONFIG_PATH.parent)
        link.bind("<Button-1>", open_folder)

    # Dictionary ----------------------------------------------------------------

    def _scroll_list(self, parent, height):
        """A dark, scrollable region; returns its inner Frame.

        The scrollbar is a hand-drawn thumb (native tk.Scrollbar ignores colours
        on Windows) that auto-hides when the content fits.
        """
        wrap = tk.Frame(parent, bg=MANTLE, highlightthickness=1,
                        highlightbackground=SURFACE1)
        wrap.pack(fill="x")
        canvas = tk.Canvas(wrap, bg=MANTLE, height=height, highlightthickness=0,
                           bd=0)
        canvas.pack(side="left", fill="both", expand=True)
        bar = tk.Canvas(wrap, bg=MANTLE, width=8, height=height,
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
                bar.coords(thumb, 2, first * bh + 1, 7, last * bh - 1)

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
        bar.bind("<Button-1>", drag)
        bar.bind("<B1-Motion>", drag)
        return inner

    def _list_row(self, parent, text, on_remove):
        """One term/pair row: text on the left, a ✕ remove label on the right."""
        row = tk.Frame(parent, bg=MANTLE)
        row.pack(fill="x")
        tk.Label(row, text=text, bg=MANTLE, fg=TEXT, font=FONT, anchor="w",
                 padx=10, pady=4).pack(side="left", fill="x", expand=True)
        x = tk.Label(row, text="✕", bg=MANTLE, fg=MUTED, font=FONT,
                     cursor="hand2", padx=10)
        x.pack(side="right")
        x.bind("<Enter>", lambda _e: x.config(fg=RED))
        x.bind("<Leave>", lambda _e: x.config(fg=MUTED))
        x.bind("<Button-1>", lambda _e: on_remove())

    def _build_dictionary(self, pane):
        self._header(pane, "Dictionary")

        # Vocabulary ---------------------------------------------------------
        self._label(pane, "Vocabulary")
        self._hint(pane, "Words and names the transcriber should recognize "
                         "(sent as hints with every request).", pady=(0, 6))
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        self._vocab_var = tk.StringVar()
        entry = tk.Entry(
            row, textvariable=self._vocab_var, font=FONT, bg=SURFACE0, fg=TEXT,
            insertbackground=TEXT, relief="flat", highlightthickness=1,
            highlightbackground=SURFACE1, highlightcolor=ACCENT)
        entry.pack(side="left", fill="x", expand=True, ipady=6)
        entry.bind("<Return>", lambda _e: self._add_vocab())
        self._make_button(row, "Add", self._add_vocab,
                          kind="accent").pack(side="left", padx=(8, 0))
        tk.Frame(pane, bg=BASE, height=8).pack()
        self._vocab_inner = self._scroll_list(pane, height=76)
        self._render_vocab()

        tk.Frame(pane, bg=BASE, height=16).pack()

        # Corrections --------------------------------------------------------
        self._label(pane, "Corrections")
        self._hint(pane, "Always replace a misheard phrase with the right one.",
                   pady=(0, 6))
        row2 = tk.Frame(pane, bg=BASE)
        row2.pack(fill="x")
        self._corr_heard = tk.StringVar()
        self._corr_right = tk.StringVar()
        e1 = tk.Entry(
            row2, textvariable=self._corr_heard, font=FONT, bg=SURFACE0, fg=TEXT,
            insertbackground=TEXT, relief="flat", highlightthickness=1,
            highlightbackground=SURFACE1, highlightcolor=ACCENT)
        e1.pack(side="left", fill="x", expand=True, ipady=6)
        tk.Label(row2, text="→", bg=BASE, fg=SUBTEXT, font=FONT,
                 padx=8).pack(side="left")
        e2 = tk.Entry(
            row2, textvariable=self._corr_right, font=FONT, bg=SURFACE0, fg=TEXT,
            insertbackground=TEXT, relief="flat", highlightthickness=1,
            highlightbackground=SURFACE1, highlightcolor=ACCENT)
        e2.pack(side="left", fill="x", expand=True, ipady=6)
        e1.bind("<Return>", lambda _e: self._add_correction())
        e2.bind("<Return>", lambda _e: self._add_correction())
        self._make_button(row2, "Add", self._add_correction,
                          kind="accent").pack(side="left", padx=(8, 0))
        tk.Frame(pane, bg=BASE, height=8).pack()
        self._corr_inner = self._scroll_list(pane, height=76)
        self._render_corrections()

    def _render_vocab(self):
        for w in self._vocab_inner.winfo_children():
            w.destroy()
        terms = self._config.get("vocabulary", [])
        if not terms:
            tk.Label(self._vocab_inner, text="No terms yet.", bg=MANTLE,
                     fg=MUTED, font=HINT_FONT, anchor="w", padx=10,
                     pady=6).pack(fill="x")
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
            tk.Label(self._corr_inner, text="No corrections yet.", bg=MANTLE,
                     fg=MUTED, font=HINT_FONT, anchor="w", padx=10,
                     pady=6).pack(fill="x")
            return
        for heard, right in pairs.items():
            self._list_row(self._corr_inner, f"{heard}  →  {right}",
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

    # History -------------------------------------------------------------------

    def _build_history(self, pane):
        self._header(pane, "History")
        combo = _pretty_combo(self._config.get("repaste_hotkey", ""))
        if combo:
            self._hint(pane, f"Dictations from this session. Press {combo} "
                             "anywhere to re-paste the newest one.",
                       pady=(0, 4))
            self._hint(pane, "Tip: click into the target app first, then "
                             f"use {combo}.", pady=(0, 10))
        else:
            self._hint(pane, "Dictations from this session. Set a re-paste "
                             "shortcut in General to paste the newest one "
                             "anywhere.", pady=(0, 10))

        items = []
        if self._history_getter is not None:
            try:
                items = self._history_getter() or []
            except Exception:
                items = []

        inner = self._scroll_list(pane, height=280)
        if not items:
            tk.Label(inner, text="Nothing dictated yet this session.",
                     bg=MANTLE, fg=MUTED, font=HINT_FONT, anchor="w", padx=10,
                     pady=8).pack(fill="x")
            return

        for ts, text in items:
            row = tk.Frame(inner, bg=MANTLE)
            row.pack(fill="x", pady=1)
            when = time.strftime("%H:%M", time.localtime(ts))
            tk.Label(row, text=when, bg=MANTLE, fg=MUTED, font=HINT_FONT,
                     width=6, anchor="w", padx=10).pack(side="left")
            self._make_button(row, "Paste",
                              lambda t=text: self._repaste(t),
                              small=True).pack(side="right", padx=(0, 8))
            self._make_button(row, "Copy",
                              lambda t=text: self._copy(t),
                              small=True).pack(side="right", padx=(0, 6))
            preview = text.replace("\n", " ").strip()
            if len(preview) > 42:
                preview = preview[:41] + "…"
            tk.Label(row, text=preview, bg=MANTLE, fg=TEXT, font=FONT,
                     anchor="w").pack(side="left", fill="x", expand=True,
                                      padx=(4, 8))

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

    # --- Widgets ---------------------------------------------------------------

    def _make_button(self, parent, text, command, kind="surface", small=False):
        if kind == "accent":
            base_bg, hover_bg, fg = ACCENT, ACCENT_HOVER, INK
        else:
            base_bg, hover_bg, fg = SURFACE0, SURFACE1, TEXT
        btn = tk.Button(
            parent, text=text, command=command,
            font=("Segoe UI Semibold", 9) if small else BTN_FONT,
            bg=base_bg, fg=fg, activebackground=ACCENT_DOWN if kind == "accent"
            else SURFACE1, activeforeground=fg,
            relief="flat", bd=0, padx=10 if small else 16, pady=2 if small else 6,
            cursor="hand2", highlightthickness=0,
        )
        btn._base_bg, btn._hover_bg = base_bg, hover_bg
        btn.bind("<Enter>", lambda e: e.widget.config(bg=e.widget._hover_bg)
                 if str(e.widget["state"]) != "disabled" else None)
        btn.bind("<Leave>", lambda e: e.widget.config(bg=e.widget._base_bg)
                 if str(e.widget["state"]) != "disabled" else None)
        return btn

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

    def _open_lang_menu(self):
        menu = tk.Menu(
            self._win, tearoff=0, bg=SURFACE0, fg=TEXT,
            activebackground=ACCENT, activeforeground=INK,
            relief="flat", bd=0, font=FONT,
        )
        for name, code in LANGUAGES:
            menu.add_command(
                label=f"  {name}", command=lambda n=name, c=code: self._pick_lang(n, c))
        x = self._lang_ctrl.winfo_rootx()
        y = self._lang_ctrl.winfo_rooty() + self._lang_ctrl.winfo_height() + 2
        menu.tk_popup(x, y)

    def _pick_lang(self, name, code):
        self._lang_lbl.config(text=name)
        self._apply(language=code)

    # Autostart ------------------------------------------------------------------

    def _toggle_autostart(self, _e=None):
        try:
            self._autostart_on = not self._autostart_on
            autostart.set_enabled(self._autostart_on)
            self._autostart_lbl.config(
                image=self._toggle_imgs[int(self._autostart_on)])
            self._flash_saved()
        except Exception:
            self._autostart_on = not self._autostart_on

    # Provider keys & model overrides ---------------------------------------------

    def _key_status_text(self, field):
        key = self._config.get(field, "")
        if not key:
            return "No key set."
        return f"Key saved · ends in ····{key[-4:]}"

    def _toggle_show(self, entry, btn):
        showing = entry["show"] == ""
        entry.config(show="•" if showing else "")
        btn.config(text="Show" if showing else "Hide")

    def _save_key(self, field):
        self._apply(**{field: self._key_vars[field].get().strip()})
        self._key_status_lbls[field].config(text=self._key_status_text(field))

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
            self._test_status.config(text="Enter a key first.", fg=RED)
            return
        self._testing = True
        btn.config(state="disabled")
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
            btn.config(state="normal", bg=btn._base_bg)
        if self._test_status is not None and self._test_status.winfo_exists():
            self._test_status.config(text=("✓ " if ok else "") + message,
                                     fg=GREEN if ok else RED)

    # Hotkey capture ------------------------------------------------------------

    def _shortcut_row(self, pane, label, config_key, hint):
        """A readonly shortcut display + capture-by-pressing Change button."""
        self._label(pane, label)
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        var = tk.StringVar(value=self._config.get(config_key, ""))
        display = tk.Entry(
            row, textvariable=var, font=FONT, state="readonly",
            readonlybackground=SURFACE0, fg=TEXT, relief="flat",
            highlightthickness=1, highlightbackground=SURFACE1,
            highlightcolor=ACCENT, insertbackground=TEXT, justify="center",
        )
        display.pack(side="left", fill="x", expand=True, ipady=6)
        btn = self._make_button(
            row, "Change", lambda k=config_key: self._start_capture(k))
        btn.pack(side="left", padx=(8, 0))
        self._hint(pane, hint)
        error = tk.Label(pane, text="", bg=BASE, fg=RED, font=HINT_FONT,
                         anchor="w")
        error.pack(fill="x", pady=(2, 0))
        self._shortcut_rows[config_key] = {
            "var": var, "display": display, "btn": btn, "error": error,
        }

    def _start_capture(self, config_key="hotkey"):
        if self._capturing:
            return
        row = self._shortcut_rows[config_key]
        self._capturing = True
        self._capture_target = config_key
        self._prev_hotkey = row["var"].get()
        row["error"].config(text="")
        row["btn"].config(state="disabled", text="Press keys…", cursor="")
        row["display"].config(fg=ACCENT)
        row["var"].set("Listening…")
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
        alive = (row and row["display"].winfo_exists())

        cancelled = combo is None or combo.strip().lower() in ("esc", "escape")
        if not cancelled:
            try:
                from hotkey import validate_hotkey
                new_hotkey = validate_hotkey(combo)
            except ValueError as exc:
                if alive:
                    row["error"].config(text=str(exc))
                cancelled = True
            except ImportError:
                new_hotkey = combo.strip().lower()

        if alive:
            row["var"].set(self._prev_hotkey if cancelled else new_hotkey)
            row["display"].config(fg=TEXT)
            row["btn"].config(state="normal", text="Change", cursor="hand2")

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
        w, h = 640, 584
        x = (self._win.winfo_screenwidth() - w) // 2
        y = (self._win.winfo_screenheight() - h) // 2 - 30
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
