"""Canvas-rendered settings window for Undertone.

Part 1 implements the window shell, navigation, General, and Get started.
The remaining sections are intentionally lightweight placeholders until part 2.
"""

import io
import queue
import re
import threading
import time
import tkinter as tk
import wave
from typing import Callable, List, Optional

import keyboard
from PIL import ImageTk

import autostart
import canvasui
import theme
from config import KEY_FIELDS
from ui import (ICON_ICO, LANGUAGES, PROVIDERS_UI, PROVIDER_BY_ID, SECTIONS,
                _nav_glyph, load_app_image, pretty_combo)


WIN_W, WIN_H = 780, 724
SIDEBAR_W = 200
HEADER_FONT = ("Segoe UI Semibold", 15)
CARD_TITLE_FONT = ("Segoe UI Semibold", 10)
HINT_FONT = ("Segoe UI", 9)
GROUP_FONT = ("Segoe UI Semibold", 9)
NAV_FONT = ("Segoe UI", 10)
NAV_ACTIVE_FONT = ("Segoe UI Semibold", 10)
TITLE_FONT = ("Segoe UI Semibold", 12)


def _ellipsize(text, limit=24):
    return text if len(text) <= limit else text[:limit - 1] + "…"


class _Inline(canvasui.Widget):
    """Natural-width horizontal controls without HStack's equal sharing."""

    def __init__(self, children, gap=6):
        super().__init__()
        self.children = list(children)
        self.gap = theme.sc(gap)

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        for child in self.children:
            child._attach(scene, self)

    def measure(self, avail_w):
        sizes = [child._measure(avail_w) for child in self.children]
        width = sum(size[0] for size in sizes) + self.gap * max(0, len(sizes) - 1)
        return min(avail_w, width), max((size[1] for size in sizes), default=0)

    def layout(self, x, y, w):
        sizes = [child._measure(w) for child in self.children]
        height = max((size[1] for size in sizes), default=0)
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        left = x
        for child, (child_w, child_h) in zip(self.children, sizes):
            child.layout(left, y + (height - child_h) // 2, child_w)
            left += child_w + self.gap

    def destroy(self):
        for child in self.children:
            child.destroy()
        super().destroy()


class _StaticPill(canvasui.PillButton):
    focusable = False

    def hover(self, _state):
        pass

    def press(self, _state):
        pass

    def activate(self):
        pass


class _DynamicDropdown(canvasui.DropdownButton):
    def __init__(self, options_getter, get, set, width=180):
        self.options_getter = options_getter
        super().__init__(options_getter(), get, set, width)

    def open_popup(self):
        self.options = list(self.options_getter())
        super().open_popup()


class _Meter(canvasui.Widget):
    def __init__(self, width=200):
        super().__init__()
        self.width = theme.sc(width)
        self.height = theme.sc(10)
        self.level = 0.0
        self._track = []
        self._fill = []

    def measure(self, avail_w):
        return min(avail_w, self.width), self.height

    def _ensure(self):
        if self._track:
            return
        for color, target in ((theme.SURFACE0, self._track),
                              (theme.ACCENT, self._fill)):
            target.extend((
                self.canvas.create_oval(0, 0, 0, 0, width=0, fill=color,
                                        tags=(self.tag,)),
                self.canvas.create_rectangle(0, 0, 0, 0, width=0, fill=color,
                                             tags=(self.tag,)),
                self.canvas.create_oval(0, 0, 0, 0, width=0, fill=color,
                                        tags=(self.tag,)),
            ))
        self._items.extend(self._track + self._fill)

    def layout(self, x, y, w):
        self._ensure()
        width = min(w, self.width)
        geometry = (round(x), round(y), round(width), self.height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self._draw()

    def set_level(self, level):
        level = max(0.0, min(1.0, float(level)))
        if level == self.level:
            return
        self.level = level
        if self._geometry:
            self._draw()

    def _draw(self):
        x, y, width, height = self._geometry
        radius = height / 2
        track = (
            (x, y, x + height, y + height),
            (x + radius, y, x + width - radius, y + height),
            (x + width - height, y, x + width, y + height),
        )
        for item, coords in zip(self._track, track):
            self.scene._coords(item, *coords)
        filled = round(width * self.level)
        if filled <= 0:
            for item in self._fill:
                self.scene._itemconfigure(item, state="hidden")
            return
        for item in self._fill:
            self.scene._itemconfigure(item, state="normal")
        cap = min(height, filled)
        fill = (
            (x, y, x + cap, y + height),
            (x + radius, y, x + max(radius, filled), y + height),
            (x + max(0, filled - height), y, x + filled, y + height),
        )
        for item, coords in zip(self._fill, fill):
            self.scene._coords(item, *coords)


class _Reveal(canvasui.Widget):
    def __init__(self, child, visible=False):
        super().__init__()
        self.child = child
        self.visible = bool(visible)

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.child._attach(scene, self)

    def measure(self, avail_w):
        return self.child._measure(avail_w) if self.visible else (avail_w, 0)

    def layout(self, x, y, w):
        geometry = (x, y, w, self._measure(w)[1])
        if geometry == self._geometry:
            return
        self._geometry = geometry
        if self.visible:
            self.child.layout(x, y, w)

    def show(self):
        self.set_visible(True)

    def set_visible(self, visible):
        visible = bool(visible)
        if self.visible == visible:
            return
        self.visible = visible
        state = "normal" if visible else "hidden"
        if self.child.canvas is not None:
            for item in self.child._items:
                self.child.canvas.itemconfigure(item, state=state)
        self._invalidate_measure()
        self.scene.relayout()

    def destroy(self):
        self.child.destroy()
        super().destroy()


class SettingsWindow:
    """A single reusable canvas settings Toplevel, callable from any thread."""

    def __init__(
        self,
        root: tk.Tk,
        cfg: dict,
        on_save: Callable[[dict], None],
        on_capture_start: Optional[Callable[[], None]] = None,
        on_capture_end: Optional[Callable[[], None]] = None,
        history_getter: Optional[Callable[[], List[dict]]] = None,
        on_repaste: Optional[Callable[[str], None]] = None,
        on_retry: Optional[Callable[[bytes], None]] = None,
        config_getter: Optional[Callable[[], dict]] = None,
    ):
        self._root = root
        self._config = dict(cfg)
        self._on_save = on_save
        self._on_capture_start = on_capture_start
        self._on_capture_end = on_capture_end
        self._history_getter = history_getter
        self._on_repaste = on_repaste
        self._on_retry = on_retry
        self._config_getter = config_getter
        self._win = None
        self._scene = None
        self._active_section = None
        self._queue = queue.Queue()
        self._capturing = False
        self._testing = False
        self._mic_testing = False
        self._mic_recorder = None
        self._saved_after_id = None
        self._practice_after_id = None
        self._shortcut_rows = {}
        self._root.after(50, self._drain)

    def open(self):
        self._queue.put(("open", None))

    def _drain(self):
        try:
            while True:
                command, payload = self._queue.get_nowait()
                if command == "open":
                    self._open()
                elif command == "captured":
                    self._on_captured(payload)
                elif command == "tested":
                    self._on_tested(payload)
        except queue.Empty:
            pass
        finally:
            self._root.after(50, self._drain)

    def _open(self):
        if self._config_getter is not None:
            self._config = dict(self._config_getter())
        if self._win is not None and self._win.winfo_exists():
            self._raise()
            return

        win = tk.Toplevel(self._root)
        self._win = win
        win.withdraw()
        win.title("Undertone")
        win.configure(bg=theme.BASE)
        win.resizable(True, True)
        win.minsize(theme.sc(660), theme.sc(560))
        win.protocol("WM_DELETE_WINDOW", self._close)
        win.bind("<Escape>", self._on_escape)
        try:
            win.iconbitmap(str(ICON_ICO))
        except tk.TclError:
            pass

        self._sidebar = tk.Canvas(
            win, width=theme.sc(SIDEBAR_W), bg=theme.MANTLE,
            highlightthickness=0, bd=0)
        self._sidebar.pack(side="left", fill="y")
        self._sidebar.bind("<Configure>", self._layout_sidebar, add="+")
        self._content = tk.Canvas(
            win, bg=theme.BASE, highlightthickness=0, bd=0)
        self._content.pack(side="left", fill="both", expand=True)
        self._scene = canvasui.Scene(self._content, padding=28)
        self._scene._scroll_callback = lambda _first, _last: self._position_saved()
        self._saved_item = self._content.create_text(
            0, 0, anchor="se", text="", fill=theme.GREEN,
            font=HINT_FONT, tags=("saved_toast",))
        self._content.bind("<Configure>", self._position_saved, add="+")

        self._build_sidebar()
        first = "Get started" if self._setup_incomplete() else "General"
        self._select_section(first)
        self._restore_geometry()
        canvasui.style_toplevel(win, ICON_ICO)
        self._raise()

    def _build_sidebar(self, hide_get_started=False):
        canvas = self._sidebar
        canvas.delete("all")
        self._version_item = None
        self._brand_photo = ImageTk.PhotoImage(
            load_app_image(theme.sc(30)))
        canvas.create_image(theme.sc(18), theme.sc(20), anchor="nw",
                            image=self._brand_photo)
        canvas.create_text(theme.sc(57), theme.sc(35), anchor="w",
                           text="Undertone", fill=theme.TEXT, font=TITLE_FONT)
        sections = [name for name in SECTIONS
                    if name != "Get started"
                    or (self._setup_incomplete() and not hide_get_started)]
        self._nav_items = {}
        self._nav_photos = {}
        top = theme.sc(76)
        row_h = theme.sc(40)
        width = theme.sc(SIDEBAR_W)
        for index, section in enumerate(sections):
            y = top + index * row_h
            tag = "nav_" + section.replace(" ", "_")
            background = canvas.create_rectangle(
                0, y, width, y + row_h, width=0, fill=theme.MANTLE,
                tags=(tag,))
            bar = canvas.create_rectangle(
                0, y, theme.sc(3), y + row_h, width=0, fill=theme.MANTLE,
                tags=(tag,))
            photos = {}
            for color in (theme.SUBTEXT, theme.ACCENT):
                photos[color] = ImageTk.PhotoImage(
                    _nav_glyph(section, color, theme.sc(17)))
            self._nav_photos[section] = photos
            icon = canvas.create_image(
                theme.sc(18), y + row_h / 2, anchor="w",
                image=photos[theme.SUBTEXT], tags=(tag,))
            label = canvas.create_text(
                theme.sc(46), y + row_h / 2, anchor="w", text=section,
                fill=theme.SUBTEXT, font=NAV_FONT, tags=(tag,))
            self._nav_items[section] = {
                "tag": tag, "background": background, "bar": bar,
                "icon": icon, "label": label,
            }
            canvas.tag_bind(tag, "<Enter>",
                            lambda _e, name=section: self._nav_hover(name, True))
            canvas.tag_bind(tag, "<Leave>",
                            lambda _e, name=section: self._nav_hover(name, False))
            canvas.tag_bind(tag, "<Button-1>",
                            lambda _e, name=section: self._select_section(name))
        self._layout_sidebar()
        self._paint_nav()

    def _layout_sidebar(self, _event=None):
        if self._win is None or not hasattr(self, "_sidebar"):
            return
        height = max(1, self._sidebar.winfo_height())
        version = getattr(self, "_version_item", None)
        if version is None:
            from config import APP_VERSION
            self._version_item = self._sidebar.create_text(
                theme.sc(18), height - theme.sc(14), anchor="sw",
                text=f"Version {APP_VERSION}", fill=theme.MUTED,
                font=("Segoe UI", 8))
        else:
            self._sidebar.coords(version, theme.sc(18), height - theme.sc(14))

    def _nav_hover(self, section, inside):
        if section == self._active_section:
            return
        item = self._nav_items.get(section)
        if item:
            self._sidebar.itemconfigure(
                item["background"], fill=theme.NAV_HOVER if inside else theme.MANTLE)

    def _paint_nav(self):
        if not hasattr(self, "_nav_items"):
            return
        for name, item in self._nav_items.items():
            active = name == self._active_section
            bg = theme.SURFACE0 if active else theme.MANTLE
            self._sidebar.itemconfigure(item["background"], fill=bg)
            self._sidebar.itemconfigure(
                item["bar"], fill=theme.ACCENT if active else bg)
            self._sidebar.itemconfigure(
                item["icon"], image=self._nav_photos[name][
                    theme.ACCENT if active else theme.SUBTEXT])
            self._sidebar.itemconfigure(
                item["label"], fill=theme.TEXT if active else theme.SUBTEXT,
                font=NAV_ACTIVE_FONT if active else NAV_FONT)

    def _select_section(self, section):
        if self._scene is None:
            return
        self._cancel_section_tasks()
        self._active_section = section
        self._paint_nav()
        self._content.yview_moveto(0)
        builders = {
            "Get started": self._build_get_started,
            "General": self._build_general,
        }
        root = builders.get(section, lambda: self._build_placeholder(section))()
        self._scene.set_root(root)
        self._content.yview_moveto(0)
        self._position_saved()

    def _heading(self, text):
        return canvasui.TextBlock(text, HEADER_FONT, wrap=False)

    def _group(self, text):
        return canvasui.TextBlock(text, GROUP_FONT, theme.SUBTEXT, wrap=False)

    def _card(self, title, hint, control=None):
        return canvasui.Card(canvasui.Row(title, hint, control))

    def _build_placeholder(self, section):
        return canvasui.VStack([
            self._heading(section),
            canvasui.TextBlock("coming in part 2", HINT_FONT, theme.MUTED),
        ], gap=10)

    def _build_general(self):
        children = [self._heading("General")]
        if not self._provider_key("provider"):
            target = "Get started" if "Get started" in self._nav_items else "Providers"
            children.append(canvasui.Card(canvasui.Row(
                "Finish setting up Undertone",
                "Add an API key for your transcription provider to start dictating.",
                canvasui.PillButton(
                    f"Open {target}", "accent",
                    lambda name=target: self._select_section(name), small=True)),
                fill=theme.BANNER_BG, border=theme.BANNER_BORDER))

        self._shortcut_rows = {}
        children.extend((self._group("Shortcuts"), self._shortcut_card(
            "Push-to-talk", "hotkey",
            "Hold to dictate, release to transcribe. Double-tap to lock "
            "hands-free; tap again to finish."), self._shortcut_card(
            "Re-paste last dictation", "repaste_hotkey",
            "Pastes your most recent dictation again, wherever your cursor is now.")))

        children.append(self._group("Dictation"))
        language = canvasui.DropdownButton(
            LANGUAGES, lambda: self._config.get("language", "en"),
            lambda value: self._apply(language=value), width=170)
        children.append(self._card(
            "Spoken language", "The language you dictate in.", language))

        microphone = _DynamicDropdown(
            self._input_devices, lambda: self._config.get("input_device", ""),
            lambda value: self._apply(input_device=value), width=190)
        children.append(self._card(
            "Microphone", "Where Undertone listens.", microphone))
        children.append(self._toggle_card(
            "Smart formatting", "smart_formatting",
            "Match spacing and capitalization to where you're typing."))

        cleanup_hint = (
            "Clean up fillers and false starts with a fast grok model. Sends "
            "the text near your cursor to your cleanup provider.")
        warning_text = self._cleanup_warning()
        warning = canvasui.TextBlock(warning_text, HINT_FONT, theme.AMBER)
        warning_reveal = _Reveal(warning, visible=bool(warning_text))
        title = canvasui.VStack([
            canvasui.TextBlock("AI cleanup", CARD_TITLE_FONT, wrap=False),
            canvasui.TextBlock(cleanup_hint, HINT_FONT, theme.MUTED),
            warning_reveal,
        ], gap=2)

        def toggle_cleanup(on):
            self._apply(ai_cleanup=on)
            text = self._cleanup_warning()
            warning.set_text(text)
            warning_reveal.set_visible(bool(text))

        toggle = canvasui.Toggle(
            self._config.get("ai_cleanup", True), toggle_cleanup)
        children.append(canvasui.Card(canvasui.Row(title, control=toggle)))
        children.append(self._toggle_card(
            "Sound cues", "sound_cues",
            "Play a soft tick when recording starts and stops."))

        children.extend((self._group("System"), self._autostart_card()))
        return canvasui.VStack(children, gap=9)

    def _shortcut_card(self, title, config_key, hint):
        combo = self._config.get(config_key, "")
        hint_block = canvasui.TextBlock(hint, HINT_FONT, theme.MUTED)
        error = canvasui.TextBlock("", HINT_FONT, theme.RED)
        error_reveal = _Reveal(error)
        info = canvasui.VStack([
            canvasui.TextBlock(title, CARD_TITLE_FONT, wrap=False),
            hint_block,
            error_reveal,
        ], gap=2)
        chip = _StaticPill(pretty_combo(combo) or "None", "neutral", small=True)
        button = canvasui.PillButton(
            "Change", "neutral", lambda key=config_key: self._start_capture(key),
            small=True)
        control = _Inline((chip, button), gap=8)
        self._shortcut_rows[config_key] = {
            "button": button, "chip": chip,
            "error": error, "error_reveal": error_reveal, "combo": combo,
        }
        return canvasui.Card(canvasui.Row(info, control=control))

    def _toggle_card(self, title, key, hint):
        toggle = canvasui.Toggle(
            self._config.get(key, True),
            lambda on, name=key: self._toggle_config(name, on))
        return self._card(title, hint, toggle)

    def _toggle_config(self, key, on):
        self._apply(**{key: on})

    def _autostart_card(self):
        try:
            initial = autostart.is_enabled()
        except Exception:
            initial = False
        toggle = canvasui.Toggle(initial)

        def change(on):
            try:
                autostart.set_enabled(on)
                self._flash_saved()
            except Exception:
                toggle.set(not on)

        toggle.on_change = change
        return self._card(
            "Start with Windows", "Launch quietly in the tray when you sign in.",
            toggle)

    def _build_get_started(self):
        self._gs_provider = self._config.get("provider", "xai")
        self._gs_key_field = KEY_FIELDS.get(self._gs_provider, "api_key")
        self._gs_key_value = self._config.get(self._gs_key_field, "")
        self._test_status = canvasui.TextBlock("", HINT_FONT, theme.MUTED)
        provider = canvasui.DropdownButton(
            PROVIDERS_UI, lambda: self._gs_provider,
            self._gs_pick_provider, width=150)
        self._gs_key_entry = canvasui.EntryField(
            lambda: self._gs_key_value, self._set_gs_key,
            "Paste API key", secret=True, width=1000,
            on_enter=self._gs_save_key)
        save = canvasui.PillButton(
            "Save", "accent", self._gs_save_key, small=True)
        self._test_button = canvasui.PillButton(
            "Test", "neutral", self._test_transcription, small=True)
        self._gs_key_label = canvasui.TextBlock(
            f"{PROVIDER_BY_ID.get(self._gs_provider, self._gs_provider)} API key",
            HINT_FONT, theme.SUBTEXT, wrap=False)
        step1 = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock(
                "1.  Choose your transcription provider", CARD_TITLE_FONT,
                wrap=False),
            canvasui.Row("Provider", control=provider),
            self._gs_key_label,
            self._gs_key_entry,
            _Inline((save, self._test_button)),
            self._test_status,
        ], gap=7))

        microphone = _DynamicDropdown(
            self._input_devices, lambda: self._config.get("input_device", ""),
            lambda value: self._apply(input_device=value), width=190)
        self._mic_meter = _Meter()
        self._mic_button = canvasui.PillButton(
            "Test microphone", "neutral", self._start_mic_test, small=True)
        self._mic_status = canvasui.TextBlock("", HINT_FONT, theme.RED)
        step2 = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock("2.  Try your microphone", CARD_TITLE_FONT,
                               wrap=False),
            canvasui.Row("Microphone", control=microphone),
            _Inline((self._mic_button, self._mic_meter), gap=12),
            self._mic_status,
        ], gap=7))

        combo = pretty_combo(self._config.get("hotkey", "")) or "your shortcut"
        self._practice_value = ""
        self._practice_field = canvasui.EntryField(
            lambda: self._practice_value, self._set_practice,
            "Practice dictation", multiline=True, width=1000)
        finish = canvasui.PillButton(
            "Finish", "accent", self._finish_onboarding, small=True)
        self._finish_reveal = _Reveal(_Inline((
            canvasui.TextBlock("✓ That's it — you're set up.", HINT_FONT,
                               theme.GREEN, wrap=False),
            finish,
        ), gap=12))
        step3 = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock("3.  Say something", CARD_TITLE_FONT,
                               wrap=False),
            canvasui.TextBlock(
                f"Click into the box below, hold {combo} and read: “Testing, "
                "one two three — it works.”", HINT_FONT, theme.MUTED),
            self._practice_field,
            self._finish_reveal,
        ], gap=7))

        self._practice_after_id = self._root.after(500, self._poll_practice)
        return canvasui.VStack([
            self._heading("Get started"), step1, step2, step3,
            self._autostart_card(),
        ], gap=9)

    def _set_gs_key(self, value):
        self._gs_key_value = value

    def _gs_pick_provider(self, provider):
        self._gs_provider = provider
        self._apply(provider=provider)
        self._gs_key_field = KEY_FIELDS.get(provider, "api_key")
        self._gs_key_value = self._config.get(self._gs_key_field, "")
        self._gs_key_label.set_text(
            f"{PROVIDER_BY_ID.get(provider, provider)} API key")
        self._gs_key_entry.refresh()
        self._set_status(self._test_status, "", theme.MUTED)

    def _gs_save_key(self):
        self._scene.end_edit(commit=True)
        self._apply(**{self._gs_key_field: self._gs_key_value.strip()})

    def _set_practice(self, value):
        self._practice_value = value

    def _practice_text(self):
        if (self._scene.editing is self._practice_field
                and self._scene._text is not None):
            return self._scene._text.get("1.0", "end-1c")
        return self._practice_value

    def _poll_practice(self):
        self._practice_after_id = None
        if self._active_section != "Get started" or self._win is None:
            return
        if len(self._practice_text().strip()) > 10:
            self._finish_reveal.show()
            return
        self._practice_after_id = self._root.after(500, self._poll_practice)

    def _finish_onboarding(self):
        self._apply(onboarded=True)
        self._build_sidebar(hide_get_started=True)
        self._select_section("General")

    def _input_devices(self):
        options = [("System default", "")]
        try:
            from recorder import list_input_devices
            options.extend((_ellipsize(name), name)
                           for _index, name in list_input_devices())
        except Exception:
            pass
        current = self._config.get("input_device", "")
        if current and all(value != current for _label, value in options):
            options.append((_ellipsize(current), current))
        return options

    def _start_mic_test(self):
        if self._mic_testing:
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
        self._mic_testing = True
        self._mic_recorder = recorder
        self._mic_button.set_text("Listening…")
        self._mic_button.disable()
        self._mic_tick(60)

    def _mic_tick(self, remaining):
        alive = (self._active_section == "Get started"
                 and self._mic_meter.scene is self._scene)
        if not alive or remaining <= 0:
            self._stop_mic_test()
            return
        self._mic_meter.set_level(self._mic_recorder.level)
        self._root.after(50, lambda: self._mic_tick(remaining - 1))

    def _stop_mic_test(self):
        recorder, self._mic_recorder = self._mic_recorder, None
        if recorder is not None:
            try:
                recorder.stop()
            except Exception:
                pass
        self._mic_testing = False
        meter = getattr(self, "_mic_meter", None)
        if meter is not None and meter.scene is self._scene:
            meter.set_level(0.0)
        button = getattr(self, "_mic_button", None)
        if button is not None and button.scene is self._scene:
            button.set_text("Test microphone")
            button.enable()

    def _test_transcription(self):
        if self._testing:
            return
        self._scene.end_edit(commit=True)
        provider = self._gs_provider
        field = KEY_FIELDS.get(provider, "api_key")
        key = self._gs_key_value.strip()
        if not key:
            name = PROVIDER_BY_ID.get(provider, provider)
            self._set_status(
                self._test_status, f"Enter your {name} API key below first.",
                theme.RED)
            return
        self._testing = True
        self._test_button.disable()
        self._set_status(self._test_status, "Testing…", theme.MUTED)
        cfg = dict(self._config)
        threading.Thread(
            target=self._test_stt_worker,
            args=(key, provider, cfg), daemon=True).start()

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
            result = (True, f"Transcription works ({name}).")
        except Exception as exc:
            result = (False, str(exc))
        self._queue.put(("tested", result))

    def _on_tested(self, result):
        self._testing = False
        button = getattr(self, "_test_button", None)
        status = getattr(self, "_test_status", None)
        if button is None or button.scene is not self._scene or status is None:
            return
        button.enable()
        ok, message = result
        self._set_status(
            status, ("✓ " if ok else "") + message,
            theme.GREEN if ok else theme.RED)

    def _set_status(self, block, text, color):
        block.fill = color
        block.set_text(text)
        if block._item is not None:
            block.canvas.itemconfigure(block._item, fill=color)

    def _start_capture(self, config_key):
        if self._capturing:
            return
        row = self._shortcut_rows[config_key]
        self._capturing = True
        self._capture_target = config_key
        row["error"].set_text("")
        row["error_reveal"].set_visible(False)
        row["button"].disable()
        row["chip"].set_text("Press keys…")
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
        self._queue.put(("captured", combo))

    def _on_captured(self, combo):
        if not self._capturing:
            return
        self._capturing = False
        target = self._capture_target
        row = self._shortcut_rows.get(target, {})
        alive = bool(row and row["button"].scene is self._scene)
        cancelled = combo is None or combo.strip().lower() in ("esc", "escape")
        new_hotkey = None
        if not cancelled:
            try:
                from hotkey import validate_hotkey
                new_hotkey = validate_hotkey(combo)
            except ValueError as exc:
                if alive:
                    row["error"].set_text(str(exc))
                    row["error_reveal"].set_visible(True)
                cancelled = True
            except ImportError:
                new_hotkey = combo.strip().lower()
        if not cancelled:
            for key, label in (("hotkey", "Push-to-talk"),
                               ("repaste_hotkey", "Re-paste"),
                               ("toggle_hotkey", "the toggle key")):
                if key != target and self._config.get(key, "") == new_hotkey:
                    if alive:
                        row["error"].set_text(f"Already used by {label}.")
                        row["error_reveal"].set_visible(True)
                    cancelled = True
                    break
        if alive:
            shown = row["combo"] if cancelled else new_hotkey
            row["chip"].set_text(pretty_combo(shown) or "None")
            row["button"].enable()
            if not cancelled:
                row["combo"] = new_hotkey
        if self._on_capture_end is not None:
            try:
                self._on_capture_end()
            except Exception:
                pass
        if not cancelled:
            self._apply(**{target: new_hotkey})

    def _provider_key(self, provider_config_key):
        provider = self._config.get(provider_config_key, "xai")
        return self._config.get(KEY_FIELDS.get(provider, "api_key"), "")

    def _setup_incomplete(self):
        return (not self._config.get("onboarded", False)
                or not self._provider_key("provider"))

    def _cleanup_warning(self):
        if (self._config.get("ai_cleanup", True)
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
        if self._win is None or not self._win.winfo_exists():
            return
        self._content.itemconfigure(self._saved_item, text="✓ Saved")
        self._content.tag_raise(self._saved_item)
        self._position_saved()
        if self._saved_after_id is not None:
            self._root.after_cancel(self._saved_after_id)
        self._saved_after_id = self._root.after(1500, self._clear_saved)

    def _clear_saved(self):
        self._saved_after_id = None
        if self._win is not None and self._win.winfo_exists():
            self._content.itemconfigure(self._saved_item, text="")

    def _position_saved(self, _event=None):
        if self._win is None or not hasattr(self, "_saved_item"):
            return
        x = self._content.winfo_width() - theme.sc(18)
        y = self._content.canvasy(self._content.winfo_height() - theme.sc(12))
        self._content.coords(self._saved_item, x, y)
        self._content.tag_raise(self._saved_item)

    def _cancel_section_tasks(self):
        if self._practice_after_id is not None:
            try:
                self._root.after_cancel(self._practice_after_id)
            except tk.TclError:
                pass
            self._practice_after_id = None
        if self._mic_recorder is not None:
            self._stop_mic_test()

    def _screen_bounds(self):
        try:
            import ctypes
            user32 = ctypes.WinDLL("user32")
            x = user32.GetSystemMetrics(76)
            y = user32.GetSystemMetrics(77)
            width = user32.GetSystemMetrics(78)
            height = user32.GetSystemMetrics(79)
            if width > 0 and height > 0:
                return x, y, x + width, y + height
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
        width, height, x, y = map(int, match.groups())
        if width < theme.sc(660) or height < theme.sc(560):
            return None
        left, top, right, bottom = self._screen_bounds()
        visible = theme.sc(40)
        if (x + width < left + visible or x > right - visible
                or y + height < top + visible or y > bottom - visible):
            return None
        return f"{width}x{height}{x:+d}{y:+d}"

    def _restore_geometry(self):
        geometry = self._valid_geometry(self._config.get("window_geometry"))
        if geometry is None:
            width, height = theme.sc(WIN_W), theme.sc(WIN_H)
            x = (self._win.winfo_screenwidth() - width) // 2
            y = (self._win.winfo_screenheight() - height) // 2 - theme.sc(30)
            geometry = f"{width}x{height}+{x}+{y}"
        self._win.geometry(geometry)

    def _raise(self):
        win = self._win
        win.deiconify()
        win.attributes("-topmost", True)
        win.lift()
        win.focus_force()
        win.after(200, lambda: win.winfo_exists()
                  and win.attributes("-topmost", False))

    def _on_escape(self, _event=None):
        if not self._capturing:
            self._close()

    def _close(self):
        self._cancel_section_tasks()
        if self._saved_after_id is not None:
            try:
                self._root.after_cancel(self._saved_after_id)
            except tk.TclError:
                pass
            self._saved_after_id = None
        if self._capturing:
            self._capturing = False
            if self._on_capture_end is not None:
                try:
                    self._on_capture_end()
                except Exception:
                    pass
        if self._win is not None and self._win.winfo_exists():
            self._scene.end_edit(commit=True)
            self._win.update_idletasks()
            self._config = {
                **self._config, "window_geometry": self._win.winfo_geometry()}
            self._on_save(self._config)
            self._scene.destroy()
            self._win.destroy()
        self._scene = None
        self._win = None
