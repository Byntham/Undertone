"""Tray icon and settings window for Undertone.

The settings window is a dark two-pane panel: a sidebar with General /
API Key / About sections and a content pane. All changes apply immediately
(no Save/Cancel); a transient "Saved" hint confirms each change. Styled by
hand with plain tk widgets plus Pillow-rendered imagery (tray icon, toggle
switches) supersampled 4x for crisp edges.

Thread-safety: open() may be called from the pystray thread; work is
marshalled onto the Tk main loop via a queue drained by root.after().
"""

import pathlib
import queue
import threading
import tkinter as tk
import tkinter.font  # noqa: F401  (ensures font submodule is loaded)
import webbrowser
from typing import Callable, Optional

import keyboard
import pystray
from PIL import Image, ImageDraw, ImageTk

import autostart
from config import APP_VERSION

# Palette (Catppuccin Mocha).
BASE = "#1e1e2e"
MANTLE = "#181825"
SURFACE0 = "#313244"
SURFACE1 = "#45475a"
TEXT = "#cdd6f4"
SUBTEXT = "#a6adc8"
MUTED = "#7f849c"
ACCENT = "#89b4fa"
ACCENT_HOVER = "#9dc0fc"
ACCENT_DOWN = "#74a0e8"
RED = "#f38ba8"
GREEN = "#a6e3a1"

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


def _rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


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
        knob = _rgb("#11111b") if on else _rgb(TEXT)
        d.ellipse((cx - knob_r, h // 2 - knob_r, cx + knob_r, h // 2 + knob_r),
                  fill=knob)
        out.append(ImageTk.PhotoImage(img.resize(size, Image.LANCZOS)))
    return out


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
    ):
        self._root = root
        self._config = config
        self._on_save = on_save
        self._on_capture_start = on_capture_start
        self._on_capture_end = on_capture_end
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
        win.geometry("640x430")

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

        for section in ("General", "API Key", "About"):
            self._nav_items[section] = self._make_nav_item(side, section)

        self._select_section("General")

        self._apply_dark_titlebar()
        self._center()
        self._raise()

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
        elif section == "API Key":
            self._build_api_key(pane)
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
        self._header(pane, "General")

        # Shortcut ------------------------------------------------------------
        self._label(pane, "Push-to-talk shortcut")
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        self._hotkey_var = tk.StringVar(value=self._config.get("hotkey", ""))
        display = tk.Entry(
            row, textvariable=self._hotkey_var, font=FONT, state="readonly",
            readonlybackground=SURFACE0, fg=TEXT, relief="flat",
            highlightthickness=1, highlightbackground=SURFACE1,
            highlightcolor=ACCENT, insertbackground=TEXT, justify="center",
        )
        display.pack(side="left", fill="x", expand=True, ipady=6)
        self._hotkey_display = display
        self._change_btn = self._make_button(row, "Change", self._start_capture)
        self._change_btn.pack(side="left", padx=(8, 0))
        self._hint(pane,
                   "Hold this key (or combination) to dictate; release to "
                   "transcribe. Esc cancels a capture.")
        self._hotkey_error = tk.Label(pane, text="", bg=BASE, fg=RED,
                                      font=HINT_FONT, anchor="w")
        self._hotkey_error.pack(fill="x", pady=(2, 0))

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

    def _build_api_key(self, pane):
        self._header(pane, "API Key")

        self._label(pane, "xAI API key")
        row = tk.Frame(pane, bg=BASE)
        row.pack(fill="x")
        self._api_var = tk.StringVar(value=self._config.get("api_key", ""))
        self._api_entry = tk.Entry(
            row, textvariable=self._api_var, font=FONT, show="•",
            bg=SURFACE0, fg=TEXT, insertbackground=TEXT, relief="flat",
            highlightthickness=1, highlightbackground=SURFACE1,
            highlightcolor=ACCENT,
        )
        self._api_entry.pack(side="left", fill="x", expand=True, ipady=6)
        self._show_btn = self._make_button(row, "Show", self._toggle_show)
        self._show_btn.pack(side="left", padx=(8, 0))

        self._key_status = tk.Label(pane, text=self._key_status_text(),
                                    bg=BASE, fg=MUTED, font=HINT_FONT,
                                    anchor="w")
        self._key_status.pack(fill="x", pady=(6, 0))

        tk.Frame(pane, bg=BASE, height=14).pack()
        btns = tk.Frame(pane, bg=BASE)
        btns.pack(fill="x")
        self._make_button(btns, "Save key", self._save_key,
                          kind="accent").pack(side="left")
        self._test_btn = self._make_button(btns, "Test key", self._test_key)
        self._test_btn.pack(side="left", padx=(8, 0))

        self._test_status = tk.Label(pane, text="", bg=BASE, fg=MUTED,
                                     font=HINT_FONT, anchor="w",
                                     justify="left", wraplength=390)
        self._test_status.pack(fill="x", pady=(10, 0))

        link = tk.Label(pane, text="Get a key at console.x.ai", bg=BASE,
                        fg=ACCENT, font=HINT_FONT, anchor="w", cursor="hand2")
        link.pack(fill="x", side="bottom", pady=(12, 0))
        link.bind("<Button-1>",
                  lambda _e: webbrowser.open("https://console.x.ai"))

    def _build_about(self, pane):
        self._header(pane, "About")
        tk.Label(pane, text=f"Undertone  ·  version {APP_VERSION}",
                 bg=BASE, fg=TEXT, font=FONT, anchor="w").pack(fill="x")
        self._hint(pane,
                   "Hold your shortcut, speak, release — the transcript is "
                   "typed into whatever text box has focus. Transcription "
                   "runs on the xAI speech-to-text API; audio is sent to "
                   "xAI only while you hold the key.", pady=(10, 0))
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

    # --- Widgets ---------------------------------------------------------------

    def _make_button(self, parent, text, command, kind="surface"):
        if kind == "accent":
            base_bg, hover_bg, fg = ACCENT, ACCENT_HOVER, "#11111b"
        else:
            base_bg, hover_bg, fg = SURFACE0, SURFACE1, TEXT
        btn = tk.Button(
            parent, text=text, command=command, font=BTN_FONT,
            bg=base_bg, fg=fg, activebackground=ACCENT_DOWN if kind == "accent"
            else SURFACE1, activeforeground=fg,
            relief="flat", bd=0, padx=16, pady=6, cursor="hand2",
            highlightthickness=0,
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
            activebackground=ACCENT, activeforeground="#11111b",
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

    # API key ---------------------------------------------------------------------

    def _key_status_text(self):
        key = self._config.get("api_key", "")
        if not key:
            return "No key set."
        return f"Key saved · ends in ····{key[-4:]}"

    def _toggle_show(self):
        showing = self._api_entry["show"] == ""
        self._api_entry.config(show="•" if showing else "")
        self._show_btn.config(text="Show" if showing else "Hide")

    def _save_key(self):
        self._apply(api_key=self._api_var.get().strip())
        self._key_status.config(text=self._key_status_text())

    def _test_key(self):
        if self._testing:
            return
        key = self._api_var.get().strip()
        if not key:
            self._test_status.config(text="Enter a key first.", fg=RED)
            return
        self._testing = True
        self._test_btn.config(state="disabled")
        self._test_status.config(text="Testing key…", fg=MUTED)
        threading.Thread(target=self._test_worker, args=(key,),
                         daemon=True).start()

    def _test_worker(self, key):
        import io
        import wave
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(16000)
            w.writeframes(b"\x00\x00" * 8000)  # 0.5 s of silence
        try:
            from transcriber import TranscriptionError, transcribe
            transcribe(buf.getvalue(), key)
            result = (True, "Key works — you're ready to dictate.")
        except Exception as exc:
            result = (False, str(exc))
        self._queue.put(("tested", result))

    def _on_tested(self, result):
        self._testing = False
        if self._win is None or not self._win.winfo_exists():
            return
        ok, message = result
        self._test_btn.config(state="normal", bg=self._test_btn._base_bg)
        self._test_status.config(text=("✓ " if ok else "") + message,
                                 fg=GREEN if ok else RED)

    # Hotkey capture ------------------------------------------------------------

    def _start_capture(self):
        if self._capturing:
            return
        self._capturing = True
        self._prev_hotkey = self._hotkey_var.get()
        self._hotkey_error.config(text="")
        self._change_btn.config(state="disabled", text="Press keys…", cursor="")
        self._hotkey_display.config(fg=ACCENT)
        self._hotkey_var.set("Listening…")
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

        cancelled = combo is None or combo.strip().lower() in ("esc", "escape")
        if not cancelled:
            try:
                from hotkey import validate_hotkey
                new_hotkey = validate_hotkey(combo)
            except ValueError as exc:
                self._hotkey_error.config(text=str(exc))
                cancelled = True
            except ImportError:
                new_hotkey = combo.strip().lower()

        if self._win is not None and self._win.winfo_exists():
            if cancelled:
                self._hotkey_var.set(self._prev_hotkey)
            else:
                self._hotkey_var.set(new_hotkey)
            self._hotkey_display.config(fg=TEXT)
            self._change_btn.config(state="normal", text="Change",
                                    cursor="hand2")

        if self._on_capture_end is not None:
            try:
                self._on_capture_end()
            except Exception:
                pass

        if not cancelled:
            self._apply(hotkey=new_hotkey)

    # --- Window plumbing --------------------------------------------------------

    def _apply_dark_titlebar(self):
        try:
            import ctypes
            from ctypes import wintypes
            self._win.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self._win.winfo_id())
            value = ctypes.c_int(1)
            for attr in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE
                if ctypes.windll.dwmapi.DwmSetWindowAttribute(
                    wintypes.HWND(hwnd), attr,
                    ctypes.byref(value), ctypes.sizeof(value),
                ) == 0:
                    break
            self._win.withdraw()   # DWM repaints the frame on remap
            self._win.deiconify()
        except Exception:
            pass

    def _center(self):
        self._win.update_idletasks()
        w, h = 640, 430
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
