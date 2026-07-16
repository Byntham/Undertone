"""Canvas-rendered settings window for Undertone."""

import ctypes
import io
import os
import queue
import re
import threading
import time
import tkinter as tk
import tkinter.font as tkfont
import wave
import webbrowser
from ctypes import wintypes
from typing import Callable, List, Optional

import keyboard
import pyperclip
from PIL import ImageTk

import autostart
import canvasui
import localstt
import theme
from config import APP_VERSION, CONFIG_PATH, KEY_FIELDS
from ui import (ICON_ICO, LANGUAGES, PROVIDER_LINKS, PROVIDERS_UI,
                PROVIDER_BY_ID, SECTIONS, STT_PROVIDERS_UI, _nav_glyph,
                load_app_image, pretty_combo)


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


class _ActionRow(canvasui.Widget):
    """One flexible field followed by natural-width actions."""

    def __init__(self, field, actions, gap=6):
        super().__init__()
        self.field = field
        self.actions = list(actions)
        self.gap = theme.sc(gap)

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.field._attach(scene, self)
        for action in self.actions:
            action._attach(scene, self)

    def measure(self, avail_w):
        sizes = [action._measure(avail_w) for action in self.actions]
        reserved = sum(width for width, _height in sizes)
        reserved += self.gap * len(self.actions)
        field_size = self.field._measure(max(1, avail_w - reserved))
        return avail_w, max([field_size[1]] + [height for _width, height in sizes])

    def layout(self, x, y, w):
        sizes = [action._measure(w) for action in self.actions]
        reserved = sum(width for width, _height in sizes)
        reserved += self.gap * len(self.actions)
        field_w = max(1, w - reserved)
        field_h = self.field._measure(field_w)[1]
        height = max([field_h] + [item[1] for item in sizes])
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.field.layout(x, y + (height - field_h) // 2, field_w)
        left = x + field_w + self.gap
        for action, (action_w, action_h) in zip(self.actions, sizes):
            action.layout(left, y + (height - action_h) // 2, action_w)
            left += action_w + self.gap

    def destroy(self):
        self.field.destroy()
        for action in self.actions:
            action.destroy()
        super().destroy()


class _CorrectionRow(canvasui.Widget):
    def __init__(self, heard, arrow, right, add, gap=8):
        super().__init__()
        self.heard = heard
        self.arrow = arrow
        self.right = right
        self.add = add
        self.gap = theme.sc(gap)

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        for child in (self.heard, self.arrow, self.right, self.add):
            child._attach(scene, self)

    def measure(self, avail_w):
        return avail_w, max(
            child._measure(avail_w)[1]
            for child in (self.heard, self.arrow, self.right, self.add))

    def layout(self, x, y, w):
        arrow_w, arrow_h = self.arrow._measure(w)
        add_w, add_h = self.add._measure(w)
        field_w = max(1, (w - arrow_w - add_w - self.gap * 3) // 2)
        heard_h = self.heard._measure(field_w)[1]
        right_h = self.right._measure(field_w)[1]
        height = max(arrow_h, add_h, heard_h, right_h)
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        left = x
        self.heard.layout(left, y + (height - heard_h) // 2, field_w)
        left += field_w + self.gap
        self.arrow.layout(left, y + (height - arrow_h) // 2, arrow_w)
        left += arrow_w + self.gap
        self.right.layout(left, y + (height - right_h) // 2, field_w)
        left += field_w + self.gap
        self.add.layout(left, y + (height - add_h) // 2, add_w)

    def destroy(self):
        for child in (self.heard, self.arrow, self.right, self.add):
            child.destroy()
        super().destroy()


_PREVIEW_FONT = None


def _fit_line(text, avail):
    """Largest prefix of text (+ellipsis) that fits avail px, single line."""
    global _PREVIEW_FONT
    if _PREVIEW_FONT is None:
        _PREVIEW_FONT = tkfont.Font(font=("Segoe UI", 10))
    font = _PREVIEW_FONT
    if font.measure(text) <= avail:
        return text
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if font.measure(text[:mid].rstrip() + "…") <= avail:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + "…"


class _Centered(canvasui.Widget):
    def __init__(self, child, max_width=None):
        super().__init__()
        self.child = child
        self.max_width = theme.sc(max_width) if max_width else None

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.child._attach(scene, self)

    def measure(self, avail_w):
        child_w = min(avail_w, self.max_width or avail_w)
        return avail_w, self.child._measure(child_w)[1]

    def layout(self, x, y, w):
        limit = min(w, self.max_width or w)
        child_w, child_h = self.child._measure(limit)
        geometry = (x, y, w, child_h)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.child.layout(x + (w - child_w) // 2, y, child_w)

    def destroy(self):
        self.child.destroy()


class _VCenter(canvasui.Widget):
    """Centers its child in the scroll viewport (the old About pack(expand))."""

    def __init__(self, child):
        super().__init__()
        self.child = child

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.child._attach(scene, self)

    def _height(self, avail_w):
        child_h = self.child._measure(avail_w)[1]
        pad = self.scene.padding * 2 if self.scene else 0
        return max(child_h, self.scene._viewport_height - pad)

    def measure(self, avail_w):
        return avail_w, self._height(avail_w)

    def _measure(self, avail_w):
        # Viewport height changes must invalidate the cached measurement
        # (same pattern as ListView's responsive height).
        if (self._measure_result is not None
                and self._measure_result[1] != self._height(avail_w)):
            self._measure_width = None
            self._measure_result = None
        return super()._measure(avail_w)

    def layout(self, x, y, w):
        child_h = self.child._measure(w)[1]
        height = self._height(w)
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.child.layout(x, y + max(0, (height - child_h) // 2), w)

    def destroy(self):
        self.child.destroy()
        super().destroy()


class _ClickableText(canvasui.TextBlock):
    focusable = True

    def __init__(self, text, on_click, font=HINT_FONT, fill=None):
        super().__init__(text, font, fill or theme.ACCENT, wrap=False)
        self.on_click = on_click

    def layout(self, x, y, w):
        super().layout(x, y, w)
        self._bind_clickable()

    def hover(self, state):
        super().hover(state)
        if self._item is not None:
            self.canvas.itemconfigure(
                self._item, fill=theme.ACCENT_HOVER if state else self.fill)

    def activate(self):
        self.on_click()


class _DictionaryListRow(canvasui.Widget):
    def __init__(self, text, on_remove):
        super().__init__()
        self.text = text
        self.on_remove = on_remove
        self.height = theme.sc(32)
        self._background = None
        self._label = None
        self._remove = None

    def measure(self, avail_w):
        return avail_w, self.height

    def _ensure(self):
        if self._background is not None:
            return
        remove_tag = self.tag + "_remove"
        self._background = self.canvas.create_rectangle(
            0, 0, 0, 0, width=0, fill=theme.MANTLE, tags=(self.tag,))
        self._label = self.canvas.create_text(
            0, 0, anchor="w", text=self.text, fill=theme.TEXT,
            font=("Segoe UI", 10), tags=(self.tag,))
        self._remove = self.canvas.create_text(
            0, 0, text="✕", fill=theme.MUTED, font=("Segoe UI", 10),
            tags=(self.tag, remove_tag))
        self._items.extend((self._background, self._label, self._remove))
        self.canvas.tag_bind(self.tag, "<Enter>", lambda _e: self._hover(True))
        self.canvas.tag_bind(self.tag, "<Leave>", lambda _e: self._hover(False))
        self.canvas.tag_bind(remove_tag, "<Button-1>",
                             lambda _e: self.on_remove())
        self.canvas.tag_bind(remove_tag, "<Enter>", lambda _e: self.canvas.itemconfigure(
            self._remove, fill=theme.RED))
        self.canvas.tag_bind(remove_tag, "<Leave>", lambda _e: self.canvas.itemconfigure(
            self._remove, fill=theme.MUTED))

    def _hover(self, inside):
        self.canvas.itemconfigure(
            self._background, fill=theme.ROW_HOVER if inside else theme.MANTLE)

    def layout(self, x, y, w):
        self._ensure()
        geometry = (round(x), round(y), round(w), self.height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.scene._coords(self._background, x, y, x + w, y + self.height)
        self.scene._coords(self._label, x + theme.sc(10), y + self.height / 2)
        self.scene._coords(self._remove, x + w - theme.sc(14), y + self.height / 2)

    def clip(self, top, bottom):
        # Keep the row inside the list surface: clamp the background band and
        # drop the text once its centre nears the edge (a half-line would spill
        # otherwise). See ListView._layout_rows.
        if self._geometry is None:
            return
        x, y, w, _h = self._geometry
        lo, hi = max(top, y), min(bottom, y + self.height)
        if hi <= lo:
            for item in (self._background, self._label, self._remove):
                self.scene._itemconfigure(item, state="hidden")
            return
        self.scene._itemconfigure(self._background, state="normal")
        self.scene._coords(self._background, x, lo, x + w, hi)
        center = y + self.height / 2
        margin = theme.sc(9)
        shown = "normal" if top + margin <= center <= bottom - margin else "hidden"
        self.scene._itemconfigure(self._label, state=shown)
        self.scene._itemconfigure(self._remove, state=shown)


class _EmptyListRow(canvasui.TextBlock):
    def __init__(self, text):
        super().__init__(text, HINT_FONT, theme.MUTED)
        self.pad = theme.sc(10)

    def measure(self, avail_w):
        width, height = super().measure(max(1, avail_w - self.pad * 2))
        return avail_w, height + theme.sc(16)

    def layout(self, x, y, w):
        height = self._measure(w)[1]
        # TextBlock.layout overwrites self._geometry with its own 3-tuple, so
        # remember this row's band separately for clip().
        self._band = (y, height)
        canvasui.TextBlock.layout(
            self, x + self.pad, y + theme.sc(8), max(1, w - self.pad * 2))

    def clip(self, top, bottom):
        band = getattr(self, "_band", None)
        if self._item is None or band is None:
            return
        y, h = band
        inside = top <= y and y + h <= bottom
        self.scene._itemconfigure(
            self._item, state="normal" if inside else "hidden")


class _HistoryRow(canvasui.Widget):
    BASE_H = theme.sc(34)

    def __init__(self, owner, entry):
        super().__init__()
        self.owner = owner
        self.entry = entry
        self.ok = entry.get("ok", True)
        self.expanded = self.ok and owner._hist_expanded_ts == entry.get("ts")
        self._background = None
        self._time_item = None
        self._preview_item = None
        self._detail = []
        self._buttons = []
        if self.ok:
            text = entry.get("text", "")
            self._buttons = [
                canvasui.PillButton(
                    "Copy", "neutral", lambda value=text: owner._copy(value),
                    small=True, compact=True),
            ]
            if self.expanded:
                self._full = canvasui.TextBlock(text, ("Segoe UI", 10))
                raw = entry.get("raw")
                self._raw = (canvasui.TextBlock(
                    f"Heard: {raw}", HINT_FONT, theme.MUTED)
                    if raw and raw != text else None)
                self._detail = [self._full]
                if self._raw:
                    self._detail.append(self._raw)
                self._raw_button = (canvasui.PillButton(
                    "Copy raw", "neutral", lambda value=raw: owner._copy(value),
                    small=True, compact=True) if raw else None)
                self._correction_button = canvasui.PillButton(
                    "Add correction…", "neutral",
                    lambda value=raw or text: owner._hist_add_correction(value),
                    small=True, compact=True)
                if self._raw_button:
                    self._detail.append(self._raw_button)
                self._detail.append(self._correction_button)
        else:
            wav = entry.get("wav")
            if wav is not None:
                self._buttons = [canvasui.PillButton(
                    "Retry", "accent", lambda value=wav: owner._retry(value),
                    small=True, compact=True)]

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        for child in self._buttons + self._detail:
            child._attach(scene, self)

    def _backdrop_for_child(self, _child):
        return theme.MANTLE

    def _detail_metrics(self, avail_w):
        if not self.expanded:
            return 0, None
        detail_w = max(1, avail_w - theme.sc(76))
        full_h = self._full._measure(detail_w)[1]
        raw_h = self._raw._measure(detail_w)[1] if self._raw else 0
        button_h = self._correction_button._measure(detail_w)[1]
        height = full_h + theme.sc(7) + button_h + theme.sc(10)
        if self._raw:
            height += theme.sc(4) + raw_h
        return height, (detail_w, full_h, raw_h, button_h)

    def measure(self, avail_w):
        detail_h, _metrics = self._detail_metrics(avail_w)
        return avail_w, self.BASE_H + detail_h

    def _ensure(self):
        if self._background is not None:
            return
        self._background = self.canvas.create_rectangle(
            0, 0, 0, 0, width=0, fill=theme.MANTLE, tags=(self.tag,))
        when = time.strftime("%H:%M", time.localtime(self.entry.get("ts", 0)))
        if self.ok:
            shown_when = when
            color = theme.MUTED
            preview = self.entry.get("text", "").replace("\n", " ").strip()
            if len(preview) > 46:
                preview = preview[:45] + "…"
        else:
            shown_when = f"✕ {when}"
            color = theme.AMBER
            preview = " ".join(self.entry.get("error", "").split())
            if len(preview) > 60:
                preview = preview[:59].rstrip() + "…"
        self._time_item = self.canvas.create_text(
            0, 0, anchor="w", text=shown_when, fill=color,
            font=HINT_FONT, tags=(self.tag,))
        self._preview_text = preview
        self._preview_avail = None
        self._preview_item = self.canvas.create_text(
            0, 0, anchor="w", text=preview,
            fill=theme.TEXT if self.ok else theme.SUBTEXT,
            font=("Segoe UI", 10), tags=(self.tag,))
        self._items.extend(
            (self._background, self._time_item, self._preview_item))
        self.canvas.tag_bind(self.tag, "<Enter>", lambda _e: self.canvas.itemconfigure(
            self._background, fill=theme.ROW_HOVER))
        self.canvas.tag_bind(self.tag, "<Leave>", lambda _e: self.canvas.itemconfigure(
            self._background, fill=theme.MANTLE))
        if self.ok:
            self.canvas.tag_bind(
                self.tag, "<Button-1>",
                lambda _e: self.owner._hist_toggle(self.entry.get("ts")))

    def layout(self, x, y, w):
        self._ensure()
        height = self._measure(w)[1]
        geometry = (round(x), round(y), round(w), height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.scene._coords(self._background, x, y, x + w, y + self.BASE_H)
        self.scene._coords(
            self._time_item, x + theme.sc(10), y + self.BASE_H / 2)
        right = x + w - theme.sc(8)
        for button in reversed(self._buttons):
            button_w, button_h = button._measure(w)
            right -= button_w
            button.layout(right, y + (self.BASE_H - button_h) // 2, button_w)
            right -= theme.sc(6)
        self.scene._coords(
            self._preview_item, x + theme.sc(66), y + self.BASE_H / 2)
        # Single line with pixel-fit ellipsis — the old window truncated
        # previews rather than wrapping them (row height stays uniform).
        avail = max(1, int(right - x - theme.sc(70)))
        if avail != self._preview_avail:
            self._preview_avail = avail
            self.scene._itemconfigure(
                self._preview_item, text=_fit_line(self._preview_text, avail))
        if not self.expanded:
            return
        _detail_h, metrics = self._detail_metrics(w)
        detail_w, full_h, raw_h, button_h = metrics
        left = x + theme.sc(66)
        top = y + self.BASE_H
        self._full.layout(left, top, detail_w)
        top += full_h
        if self._raw:
            top += theme.sc(4)
            self._raw.layout(left, top, detail_w)
            top += raw_h
        top += theme.sc(7)
        action_left = left
        if self._raw_button:
            raw_w, _raw_button_h = self._raw_button._measure(detail_w)
            self._raw_button.layout(action_left, top, raw_w)
            action_left += raw_w + theme.sc(6)
        correction_w, _correction_h = self._correction_button._measure(detail_w)
        self._correction_button.layout(action_left, top, correction_w)

    def clip(self, top, bottom):
        # Contain the row within the list surface. The header band is clamped;
        # its text and every button/detail sub-widget hide once they fall
        # (partly) outside the viewport, so nothing spills past the surface.
        if self._geometry is None:
            return
        x, y, w, _h = self._geometry
        lo, hi = max(top, y), min(bottom, y + self.BASE_H)
        if hi <= lo:
            for item in (self._background, self._time_item, self._preview_item):
                self.scene._itemconfigure(item, state="hidden")
        else:
            self.scene._itemconfigure(self._background, state="normal")
            self.scene._coords(self._background, x, lo, x + w, hi)
            center = y + self.BASE_H / 2
            margin = theme.sc(9)
            shown = ("normal" if top + margin <= center <= bottom - margin
                     else "hidden")
            self.scene._itemconfigure(self._time_item, state=shown)
            self.scene._itemconfigure(self._preview_item, state=shown)
        for widget in self._buttons + self._detail:
            geo = widget._geometry
            if geo is None:
                continue
            wy = geo[1]
            wh = geo[3] if len(geo) >= 4 else widget._measure(geo[2])[1]
            state = "normal" if top <= wy and wy + wh <= bottom else "hidden"
            for item in widget._items:
                self.scene._itemconfigure(item, state=state)

    def list_tags(self):
        return [self.tag] + [child.tag for child in self._buttons + self._detail]

    def destroy(self):
        for child in self._buttons + self._detail:
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
        if self.visible:
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
        if visible and self.child.scene is None:
            self.child._attach(self.scene, self)
        state = "normal" if visible else "hidden"
        self._set_tree_state(self.child, state)
        if not visible:
            self.scene._focusables = [
                widget for widget in self.scene._focusables
                if not self._contains(widget)]
        self._invalidate_measure()
        self.scene.relayout()

    def _contains(self, target):
        node = target
        while node is not None:
            if node is self.child:
                return True
            node = node.parent
        return False

    @staticmethod
    def _set_tree_state(widget, state):
        if widget.canvas is None:
            return
        widget.canvas.itemconfigure(widget.tag, state=state)
        for child in getattr(widget, "children", ()):
            _Reveal._set_tree_state(child, state)
        child = getattr(widget, "child", None)
        if child is not None:
            _Reveal._set_tree_state(child, state)

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
        on_retry: Optional[Callable[[bytes], None]] = None,
        config_getter: Optional[Callable[[], dict]] = None,
    ):
        self._root = root
        self._config = dict(cfg)
        self._on_save = on_save
        self._on_capture_start = on_capture_start
        self._on_capture_end = on_capture_end
        self._history_getter = history_getter
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
        self._mic_after_id = None
        self._mic_generation = 0
        self._window_generation = 0
        self._test_window_generation = None
        self._saved_after_id = None
        self._practice_after_id = None
        self._hist_poll_id = None
        self._hist_expanded_ts = None
        self._hist_fp = None
        self._providers_advanced = False
        self._local_busy = None      # "install"/"load"/"eject" while working
        self._local_progress = ""
        self._local_error = ""
        self._local_poll_id = None
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
                elif command == "local_progress":
                    self._local_progress = payload
                    self._refresh_local_card()
                elif command == "local_done":
                    self._on_local_done(payload)
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
        self._window_generation += 1
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
            "Dictionary": self._build_dictionary,
            "History": self._build_history,
            "Providers": self._build_providers,
            "About": self._build_about,
        }
        root = builders[section]()
        self._scene.set_root(root)
        self._content.yview_moveto(0)
        self._position_saved()

    def _heading(self, text):
        return canvasui.TextBlock(text, HEADER_FONT, wrap=False)

    def _group(self, text):
        return canvasui.TextBlock(text, GROUP_FONT, theme.SUBTEXT, wrap=False)

    def _card(self, title, hint, control=None):
        return canvasui.Card(canvasui.Row(title, hint, control))

    def _build_general(self):
        children = [self._heading("General")]
        if not self._stt_configured():
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
        if self._gs_provider not in KEY_FIELDS:
            self._gs_provider = "xai"  # guided setup covers cloud keys only
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
            canvasui.Spacer(8),
            provider,
            canvasui.Spacer(8),
            self._gs_key_label,
            canvasui.Spacer(2),
            _ActionRow(self._gs_key_entry, (save, self._test_button)),
            canvasui.Spacer(4),
            self._test_status,
        ], gap=0))

        self._mic_meter = _Meter()
        self._mic_button = canvasui.PillButton(
            "Test microphone", "neutral", self._start_mic_test, small=True)
        self._mic_status = canvasui.TextBlock("", HINT_FONT, theme.RED)
        step2 = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock("2.  Try your microphone", CARD_TITLE_FONT,
                               wrap=False),
            canvasui.Spacer(8),
            _Inline((self._mic_button, self._mic_meter), gap=12),
            self._mic_status,
        ], gap=0))

        combo = pretty_combo(self._config.get("hotkey", "")) or "your shortcut"
        self._practice_value = ""
        self._practice_field = canvasui.EntryField(
            lambda: self._practice_value, self._set_practice,
            "", width=1000)
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
            canvasui.Spacer(2),
            canvasui.TextBlock(
                f"Click into the box below, hold {combo} and read: “Testing, "
                "one two three — it works.”", HINT_FONT, theme.MUTED),
            canvasui.Spacer(8),
            self._practice_field,
            canvasui.Spacer(8),
            self._finish_reveal,
        ], gap=0))

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
                and self._scene._entry is not None):
            return self._scene._entry.get()
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
        self._mic_generation += 1
        generation = self._mic_generation
        self._mic_button.set_text("Listening…")
        self._mic_button.disable()
        self._mic_tick(60, generation, recorder)

    def _mic_tick(self, remaining, generation, recorder):
        self._mic_after_id = None
        win = self._win
        alive = (generation == self._mic_generation
                 and recorder is self._mic_recorder
                 and self._scene is not None
                 and win is not None and win.winfo_exists()
                 and self._active_section == "Get started"
                 and self._mic_meter.scene is self._scene)
        if not alive or remaining <= 0:
            if generation == self._mic_generation:
                self._stop_mic_test()
            return
        self._mic_meter.set_level(recorder.level)
        self._mic_after_id = self._root.after(
            50, lambda: self._mic_tick(remaining - 1, generation, recorder))

    def _stop_mic_test(self):
        self._mic_generation += 1
        after_id, self._mic_after_id = self._mic_after_id, None
        if after_id is not None:
            try:
                self._root.after_cancel(after_id)
            except tk.TclError:
                pass
        recorder, self._mic_recorder = self._mic_recorder, None
        if recorder is not None:
            try:
                recorder.stop()
            except Exception:
                pass
        self._mic_testing = False
        win = self._win
        scene = self._scene
        controls_alive = (scene is not None and win is not None
                          and win.winfo_exists())
        meter = getattr(self, "_mic_meter", None)
        if controls_alive and meter is not None and meter.scene is scene:
            meter.set_level(0.0)
        button = getattr(self, "_mic_button", None)
        if controls_alive and button is not None and button.scene is scene:
            button.set_text("Test microphone")
            button.enable()

    def _test_transcription(self):
        if self._active_section == "Providers":
            provider = self._config.get("provider", "xai")
            field = KEY_FIELDS.get(provider, "api_key")
            self._start_provider_test(
                "stt", provider, field, self._test_stt_btn,
                self._test_stt_worker)
            return
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
        self._test_context = "get_started"
        self._test_window_generation = self._window_generation
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
            result = ("stt", True, f"Transcription works ({name}).")
        except Exception as exc:
            result = ("stt", False, str(exc))
        self._queue.put(("tested", result))

    def _on_tested(self, result):
        self._testing = False
        which, ok, message = result
        win = self._win
        if (self._scene is None or win is None or not win.winfo_exists()
                or self._test_window_generation != self._window_generation):
            return
        context = getattr(self, "_test_context", None)
        if context == "get_started":
            button = getattr(self, "_test_button", None)
            status = getattr(self, "_test_status", None)
        else:
            button = (getattr(self, "_test_stt_btn", None) if which == "stt"
                      else getattr(self, "_test_cleanup_btn", None))
            status = getattr(self, "_providers_status", None)
        if (button is None or button.scene is not self._scene
                or status is None or status.scene is not self._scene):
            return
        button.enable()
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
        try:
            threading.Thread(target=self._capture_worker, daemon=True).start()
        except Exception:
            self._on_captured(None)

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
        win = self._win
        alive = bool(self._scene is not None and win is not None
                     and win.winfo_exists() and row
                     and row["button"].scene is self._scene)
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

    def _build_dictionary(self):
        self._vocab_value = ""
        self._corr_heard_value = ""
        self._corr_right_value = ""
        self._vocab_entry = canvasui.EntryField(
            lambda: self._vocab_value,
            lambda value: setattr(self, "_vocab_value", value),
            "", width=1000, on_enter=self._add_vocab)
        vocab_add = canvasui.PillButton(
            "Add", "accent", self._add_vocab, small=True)
        terms = list(self._config.get("vocabulary", []))
        vocab_rows = terms or [None]
        self._vocab_list = canvasui.ListView(
            vocab_rows, self._vocab_row, height=108, gap=0)
        vocab_card = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock(
                "Words and names the transcriber should recognize — sent as "
                "hints with every request.", HINT_FONT, theme.MUTED),
            canvasui.Spacer(8),
            _ActionRow(self._vocab_entry, (vocab_add,), gap=8),
            canvasui.Spacer(8),
            self._vocab_list,
        ], gap=0))

        self._corr_heard_entry = canvasui.EntryField(
            lambda: self._corr_heard_value,
            lambda value: setattr(self, "_corr_heard_value", value),
            "", width=1000, on_enter=self._add_correction)
        self._corr_right_entry = canvasui.EntryField(
            lambda: self._corr_right_value,
            lambda value: setattr(self, "_corr_right_value", value),
            "", width=1000, on_enter=self._add_correction)
        arrow = canvasui.TextBlock("→", ("Segoe UI", 10), theme.SUBTEXT,
                                   wrap=False)
        correction_add = canvasui.PillButton(
            "Add", "accent", self._add_correction, small=True)
        pairs = list((self._config.get("corrections") or {}).items())
        correction_rows = pairs or [None]
        self._correction_list = canvasui.ListView(
            correction_rows, self._correction_row, height=108, gap=0)
        correction_card = canvasui.Card(canvasui.VStack([
            canvasui.TextBlock(
                "Always replace a misheard phrase with the right one.",
                HINT_FONT, theme.MUTED),
            canvasui.Spacer(8),
            _CorrectionRow(
                self._corr_heard_entry, arrow, self._corr_right_entry,
                correction_add),
            canvasui.Spacer(8),
            self._correction_list,
        ], gap=0))
        return canvasui.VStack([
            self._heading("Dictionary"),
            self._group("Vocabulary"),
            vocab_card,
            self._group("Corrections"),
            correction_card,
        ], gap=9)

    def _vocab_row(self, term, _index):
        if term is None:
            return _EmptyListRow(
                "No terms yet — add names and jargon the transcriber gets wrong.")
        return _DictionaryListRow(
            term, lambda value=term: self._remove_vocab(value))

    def _correction_row(self, pair, _index):
        if pair is None:
            return _EmptyListRow("No corrections yet.")
        heard, right = pair
        return _DictionaryListRow(
            f"{heard}   →   {right}",
            lambda value=heard: self._remove_correction(value))

    def _add_vocab(self):
        if self._scene.editing is self._vocab_entry:
            self._scene.end_edit(commit=True)
        term = self._vocab_value.strip()
        terms = list(self._config.get("vocabulary", []))
        if not term or term in terms:
            self._vocab_value = ""
            self._vocab_entry.refresh()
            return
        terms.append(term)
        self._vocab_value = ""
        self._vocab_entry.refresh()
        self._apply(vocabulary=terms)
        self._vocab_list.set_rows(terms, self._vocab_row)

    def _remove_vocab(self, term):
        terms = [value for value in self._config.get("vocabulary", [])
                 if value != term]
        self._apply(vocabulary=terms)
        self._vocab_list.set_rows(terms or [None], self._vocab_row)

    def _add_correction(self):
        if self._scene.editing in (self._corr_heard_entry,
                                   self._corr_right_entry):
            self._scene.end_edit(commit=True)
        heard = self._corr_heard_value.strip()
        right = self._corr_right_value.strip()
        if not heard or not right:
            return
        pairs = dict(self._config.get("corrections", {}))
        pairs[heard] = right
        self._corr_heard_value = ""
        self._corr_right_value = ""
        self._corr_heard_entry.refresh()
        self._corr_right_entry.refresh()
        self._apply(corrections=pairs)
        self._correction_list.set_rows(
            list(pairs.items()), self._correction_row)

    def _remove_correction(self, heard):
        pairs = {key: value for key, value
                 in self._config.get("corrections", {}).items()
                 if key != heard}
        self._apply(corrections=pairs)
        self._correction_list.set_rows(
            list(pairs.items()) or [None], self._correction_row)

    def _build_history(self):
        combo = pretty_combo(self._config.get("repaste_hotkey", ""))
        if combo:
            hint = (
                "Dictations from this session, newest first. "
                f"Press {combo} anywhere to re-paste the newest one — or "
                "click into the target app first and use the buttons here.")
        else:
            hint = (
                "Dictations from this session, newest first. Set a re-paste "
                "shortcut in General to paste the newest one anywhere.")
        items = self._hist_snapshot()
        self._hist_fp = self._hist_fingerprint(items)
        rows = items or [None]
        heading = self._heading("History")
        hint_block = canvasui.TextBlock(hint, HINT_FONT, theme.MUTED)
        gap = theme.sc(9)

        def reserve(avail_w):
            # The hint re-flows with width, so the list must reserve the
            # measured content above it, or the page grows past the viewport
            # at narrow widths. The default 150 stays as the floor so wide
            # windows keep their usual bottom margin.
            return max(theme.sc(150),
                       self._scene.padding * 2 + gap * 3 + theme.sc(3)
                       + heading._measure(avail_w)[1]
                       + hint_block._measure(avail_w)[1])

        self._hist_list = canvasui.ListView(
            rows, self._history_row, height=None, gap=1, reserve=reserve)
        self._hist_poll_id = self._root.after(2000, self._hist_poll)
        return canvasui.VStack([
            heading,
            hint_block,
            canvasui.Spacer(3),
            self._hist_list,
        ], gap=9)

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

    def _history_row(self, entry, _index):
        if entry is None:
            return _EmptyListRow(
                "Nothing dictated yet this session. Hold your shortcut and "
                "speak — dictations appear here.")
        return _HistoryRow(self, entry)

    def _hist_poll(self):
        self._hist_poll_id = None
        if (self._active_section != "History" or self._win is None
                or not self._win.winfo_exists()):
            return
        items = self._hist_snapshot()
        if self._hist_fingerprint(items) != self._hist_fp:
            self._render_history(items)
        self._hist_poll_id = self._root.after(2000, self._hist_poll)

    def _render_history(self, items=None):
        items = self._hist_snapshot() if items is None else items
        self._hist_fp = self._hist_fingerprint(items)
        if not any(entry.get("ts") == self._hist_expanded_ts
                   for entry in items):
            self._hist_expanded_ts = None
        self._hist_list.set_rows(
            items or [None], self._history_row, reset_scroll=False)

    def _hist_toggle(self, ts):
        self._hist_expanded_ts = None if self._hist_expanded_ts == ts else ts
        self._render_history()

    def _hist_add_correction(self, heard):
        self._select_section("Dictionary")
        self._corr_heard_value = heard
        self._corr_heard_entry.refresh()
        self._scene.begin_edit(self._corr_heard_entry)
        if self._scene._entry is not None:
            self._scene._entry.selection_clear()
            self._scene._entry.icursor("end")

    def _copy(self, text):
        try:
            pyperclip.copy(text)
        except Exception:
            pass
        self._flash_saved()

    def _retry(self, wav):
        if self._on_retry is None:
            return
        if self._win is not None and self._win.winfo_exists():
            self._win.iconify()
        self._root.after(600, lambda: self._on_retry(wav))

    def _build_providers(self):
        self._key_values = {
            field: self._config.get(field, "")
            for field in KEY_FIELDS.values()
        }
        self._key_entries = {}
        self._key_status_blocks = {}
        self._model_values = {
            "stt": self._model_override("stt"),
            "cleanup": self._model_override("cleanup"),
        }
        self._model_entries = {}
        self._model_hints = {}
        self._providers_status = canvasui.TextBlock(
            "", HINT_FONT, theme.MUTED)

        stt_dropdown = canvasui.DropdownButton(
            STT_PROVIDERS_UI, lambda: self._config.get("provider", "xai"),
            lambda value: self._pick_provider("provider", value), width=130)
        self._test_stt_btn = canvasui.PillButton(
            "Test", "neutral", self._test_transcription, small=True)
        cleanup_dropdown = canvasui.DropdownButton(
            PROVIDERS_UI,
            lambda: self._config.get("cleanup_provider", "xai"),
            lambda value: self._pick_provider("cleanup_provider", value),
            width=130)
        self._test_cleanup_btn = canvasui.PillButton(
            "Test", "neutral", self._test_cleanup, small=True)
        children = [
            self._heading("Providers"),
            self._group("Services"),
            self._card(
                "Transcription", "Turns your speech into text.",
                _Inline((stt_dropdown, self._test_stt_btn), gap=8)),
            self._card(
                "AI cleanup", "Polishes the wording before it's pasted.",
                _Inline((cleanup_dropdown, self._test_cleanup_btn), gap=8)),
            self._providers_status,
            self._group("On-device"),
            self._local_card(),
            self._group("API keys"),
        ]
        for provider, field in KEY_FIELDS.items():
            children.append(self._provider_key_card(
                PROVIDER_BY_ID.get(provider, provider), field))

        links = [canvasui.TextBlock(
            "Get a key:", HINT_FONT, theme.MUTED, wrap=False)]
        for index, (label, url) in enumerate(PROVIDER_LINKS):
            if index:
                links.append(canvasui.TextBlock(
                    "·", HINT_FONT, theme.MUTED, wrap=False))
            links.append(_ClickableText(
                label, lambda target=url: webbrowser.open(target)))
        children.append(_Inline(links, gap=6))

        disclosure = "Advanced  ▾" if self._providers_advanced else "Advanced  ▸"
        children.append(_ClickableText(
            disclosure, self._toggle_providers_advanced,
            font=GROUP_FONT, fill=theme.SUBTEXT))
        if self._providers_advanced:
            children.append(canvasui.Card(canvasui.VStack([
                self._model_control("Transcription model", "stt"),
                canvasui.Spacer(10),
                self._model_control("Cleanup model", "cleanup"),
            ], gap=0)))
        return canvasui.VStack(children, gap=9)

    def _provider_key_card(self, name, field):
        status = canvasui.TextBlock("", HINT_FONT, theme.MUTED, wrap=False)
        self._key_status_blocks[field] = status
        self._refresh_key_status(field)
        entry = canvasui.EntryField(
            lambda key=field: self._key_values[key],
            lambda value, key=field: self._key_values.__setitem__(key, value),
            "", secret=True, width=1000,
            on_enter=lambda key=field: self._save_provider_key(key))
        self._key_entries[field] = entry
        show = canvasui.PillButton("Show", "neutral", small=True)
        show.on_click = lambda node=entry, button=show: self._toggle_show(
            node, button)
        save = canvasui.PillButton(
            "Save", "accent", lambda key=field: self._save_provider_key(key),
            small=True)
        return canvasui.Card(canvasui.VStack([
            canvasui.Row(name, control=status),
            canvasui.Spacer(7),
            _ActionRow(entry, (show, save)),
        ], gap=0))

    def _local_card(self):
        self._local_status = canvasui.TextBlock("", HINT_FONT, theme.MUTED,
                                                wrap=False)
        self._local_btn = canvasui.PillButton(
            "", "accent", self._on_local_action, small=True)
        self._refresh_local_card()
        # Dictating while ejected auto-loads the model on the pipeline
        # thread; poll so an open card flips to "Eject model" by itself.
        self._local_poll_id = self._root.after(1000, self._local_poll)
        return canvasui.Card(canvasui.VStack([
            canvasui.Row(
                "Local engine",
                "Whisper runs on this PC — audio never leaves your "
                "computer. Select the Local provider above to use it.",
                self._local_btn),
            canvasui.Spacer(7),
            self._local_status,
        ], gap=0))

    def _local_poll(self):
        self._local_poll_id = None
        if (self._active_section != "Providers" or self._win is None
                or not self._win.winfo_exists()):
            return
        if not self._local_busy:  # busy updates arrive via _drain
            self._refresh_local_card()
        self._local_poll_id = self._root.after(1000, self._local_poll)

    def _local_model_name(self):
        return (self._model_override_for("stt", "local")
                or self._default_model("stt", "local"))

    def _model_override_for(self, kind, provider):
        return (self._config.get(kind + "_models") or {}).get(provider, "")

    def _refresh_local_card(self):
        status = getattr(self, "_local_status", None)
        button = getattr(self, "_local_btn", None)
        # scene is None while the card is being built (safe to configure);
        # a different scene means these widgets belong to a closed window.
        if (status is None or button is None
                or (status.scene is not None
                    and status.scene is not self._scene)):
            return
        if self._local_busy:
            label = {"install": "Downloading", "load": "Loading",
                     "eject": "Ejecting"}[self._local_busy]
            button.set_text(label + "…")
            button.disable()
            self._set_status(status, self._local_progress or label + "…",
                             theme.MUTED)
            return
        button.enable()
        if not localstt.is_installed(self._local_model_name()):
            gb = localstt.install_size() / (1 << 30)
            size = f"{gb:.1f} GB" if gb >= 1 else f"{gb * 1024:.0f} MB"
            button.set_text(f"Download ({size})")
            engine = "GPU" if localstt.have_nvidia_gpu() else "CPU"
            text, color = f"Not installed · will use your {engine}", theme.MUTED
        elif localstt.is_loaded():
            button.set_text("Eject model")
            build = "GPU" if localstt.active_build() == "cuda" else "CPU"
            text, color = f"●  loaded · {build}", theme.GREEN
        else:
            button.set_text("Load model")
            text, color = "Installed · model not loaded", theme.MUTED
        if self._local_error:
            text, color = self._local_error, theme.RED
        self._set_status(status, text, color)

    def _on_local_action(self):
        if self._local_busy:
            return
        self._local_error = ""
        if not localstt.is_installed(self._local_model_name()):
            action = "install"
        elif localstt.is_loaded():
            action = "eject"
        else:
            action = "load"
        self._local_busy = action
        self._local_progress = ""
        self._refresh_local_card()
        threading.Thread(target=self._local_worker,
                         args=(action, self._local_model_name()),
                         daemon=True).start()

    def _local_worker(self, action, model_name):
        last_pct = -1

        def progress(phase, frac):
            nonlocal last_pct
            pct = int(frac * 100)
            if pct != last_pct:
                last_pct = pct
                self._queue.put(("local_progress", f"{phase}… {pct}%"))

        try:
            if action == "install":
                localstt.install(progress)
            elif action == "load":
                localstt.load(model_name)
            else:
                localstt.eject()
            result = (action, True, "")
        except Exception as exc:
            result = (action, False, str(exc))
        self._queue.put(("local_done", result))

    def _on_local_done(self, result):
        action, ok, message = result
        self._local_busy = None
        self._local_progress = ""
        self._local_error = "" if ok else message
        if ok and action in ("load", "eject"):
            # Residency intent persists; only these buttons flip it.
            self._apply(local_stt_loaded=(action == "load"))
        self._refresh_local_card()

    def _refresh_key_status(self, field):
        block = self._key_status_blocks.get(field)
        if block is None:
            return
        key = self._config.get(field, "")
        text = f"●  saved · ····{key[-4:]}" if key else "no key"
        self._set_status(block, text, theme.GREEN if key else theme.MUTED)

    def _toggle_show(self, entry, button):
        entry.secret = not entry.secret
        button.set_text("Show" if entry.secret else "Hide")
        entry.refresh()
        if self._scene.editing is entry and self._scene._entry is not None:
            self._scene._entry.configure(show="•" if entry.secret else "")

    def _save_provider_key(self, field):
        if self._scene.editing is self._key_entries[field]:
            self._scene.end_edit(commit=True)
        self._apply(**{field: self._key_values[field].strip()})
        self._refresh_key_status(field)

    def _pick_provider(self, config_key, provider):
        self._apply(**{config_key: provider})
        for kind, entry in self._model_entries.items():
            self._model_values[kind] = self._model_override(kind)
            entry.refresh()
        self._refresh_model_hints()

    def _toggle_providers_advanced(self):
        self._providers_advanced = not self._providers_advanced
        self._select_section("Providers")

    def _model_control(self, label, kind):
        entry = canvasui.EntryField(
            lambda key=kind: self._model_values[key],
            lambda value, key=kind: self._model_values.__setitem__(key, value),
            "", width=1000,
            on_enter=lambda key=kind: self._save_model(key))
        self._model_entries[kind] = entry
        save = canvasui.PillButton(
            "Save", "accent", lambda key=kind: self._save_model(key),
            small=True)
        hint = canvasui.TextBlock("", HINT_FONT, theme.MUTED)
        self._model_hints[kind] = hint
        self._refresh_model_hint(kind)
        return canvasui.VStack([
            canvasui.TextBlock(label, ("Segoe UI", 10), theme.SUBTEXT,
                               wrap=False),
            canvasui.Spacer(3),
            _ActionRow(entry, (save,)),
            canvasui.Spacer(3),
            hint,
        ], gap=0)

    def _model_provider(self, kind):
        config_key = "provider" if kind == "stt" else "cleanup_provider"
        return self._config.get(config_key, "xai")

    def _model_override(self, kind):
        return (self._config.get(kind + "_models") or {}).get(
            self._model_provider(kind), "")

    def _save_model(self, kind):
        entry = self._model_entries[kind]
        if self._scene.editing is entry:
            self._scene.end_edit(commit=True)
        models = dict(self._config.get(kind + "_models") or {})
        provider = self._model_provider(kind)
        value = self._model_values[kind].strip()
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
        block.set_text(f"Empty = provider default{tail}.")

    def _refresh_model_hints(self):
        for kind in tuple(self._model_hints):
            self._refresh_model_hint(kind)

    def _test_cleanup(self):
        provider = self._config.get("cleanup_provider", "xai")
        field = KEY_FIELDS.get(provider, "api_key")
        self._start_provider_test(
            "cleanup", provider, field, self._test_cleanup_btn,
            self._test_cleanup_worker)

    def _start_provider_test(self, which, provider, field, button, worker):
        if self._testing:
            return
        entry = self._key_entries.get(field)
        if entry is not None and self._scene.editing is entry:
            self._scene.end_edit(commit=True)
        key = self._key_values.get(field, "").strip()
        if provider == "local":
            key = ""  # keyless; the fallback field would be the xAI key
        elif not key:
            name = PROVIDER_BY_ID.get(provider, provider)
            self._set_status(
                self._providers_status,
                f"Enter your {name} API key below first.", theme.RED)
            return
        self._testing = True
        self._test_context = which
        self._test_window_generation = self._window_generation
        button.disable()
        self._set_status(self._providers_status, "Testing…", theme.MUTED)
        cfg = dict(self._config)
        threading.Thread(
            target=worker, args=(key, provider, cfg), daemon=True).start()

    def _test_cleanup_worker(self, key, provider, cfg):
        try:
            from cleanup import DEFAULT_CLEANUP_MODELS, cleanup
            model = ((cfg.get("cleanup_models") or {}).get(provider)
                     or DEFAULT_CLEANUP_MODELS[provider])
            output = cleanup(
                "testing one two three", None, "", {}, key, model,
                provider=provider)
            if output is not None:
                name = PROVIDER_BY_ID.get(provider, provider)
                result = ("cleanup", True, f"Cleanup works ({name}).")
            else:
                result = (
                    "cleanup", False,
                    "Cleanup failed — check the key, or see app.log.")
        except Exception:
            result = (
                "cleanup", False,
                "Cleanup failed — check the key, or see app.log.")
        self._queue.put(("tested", result))

    def _build_about(self):
        icon = _Centered(canvasui.Icon(pil_image=load_app_image(theme.sc(64)),
                                       size=64))
        name = _Centered(canvasui.TextBlock(
            "Undertone", ("Segoe UI Semibold", 16), wrap=False))
        version = _Centered(canvasui.TextBlock(
            f"Version {APP_VERSION}", HINT_FONT, theme.MUTED, wrap=False))
        tagline = _Centered(canvasui.TextBlock(
            "Push-to-talk dictation for Windows.", ("Segoe UI", 10),
            theme.SUBTEXT, wrap=False))
        description = _Centered(canvasui.TextBlock(
            "Hold your shortcut, speak, release — the transcript is typed "
            "into whatever text box has focus. Audio is sent only to your "
            "chosen provider, only while you dictate. Your API keys and "
            "settings stay on this computer.", HINT_FONT, theme.MUTED,
            justify="center"), max_width=400)
        links = _Centered(_Inline((
            _ClickableText("Open settings folder", self._open_config_folder),
            canvasui.TextBlock("·", HINT_FONT, theme.MUTED, wrap=False),
            _ClickableText("View log", self._open_log),
        ), gap=8))
        return _VCenter(canvasui.VStack([
            icon, canvasui.Spacer(3), name,
            canvasui.Spacer(2), version, canvasui.Spacer(5), tagline,
            canvasui.Spacer(10), description, canvasui.Spacer(10), links,
        ], gap=0))

    def _open_config_folder(self):
        os.startfile(CONFIG_PATH.parent)

    def _open_log(self):
        log = CONFIG_PATH.parent / "app.log"
        os.startfile(log if log.exists() else CONFIG_PATH.parent)

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
        if self._hist_poll_id is not None:
            try:
                self._root.after_cancel(self._hist_poll_id)
            except tk.TclError:
                pass
            self._hist_poll_id = None
        if self._local_poll_id is not None:
            try:
                self._root.after_cancel(self._local_poll_id)
            except tk.TclError:
                pass
            self._local_poll_id = None
        if self._practice_after_id is not None:
            try:
                self._root.after_cancel(self._practice_after_id)
            except tk.TclError:
                pass
            self._practice_after_id = None
        if self._mic_recorder is not None or self._mic_after_id is not None:
            self._stop_mic_test()

    def _monitor_work_areas(self):
        areas = []
        try:
            user32 = ctypes.WinDLL("user32")
            monitor_proc = ctypes.WINFUNCTYPE(
                wintypes.BOOL, wintypes.HMONITOR, wintypes.HDC,
                ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)

            class MonitorInfo(ctypes.Structure):
                _fields_ = (
                    ("cbSize", wintypes.DWORD),
                    ("rcMonitor", wintypes.RECT),
                    ("rcWork", wintypes.RECT),
                    ("dwFlags", wintypes.DWORD),
                )

            get_monitor_info = user32.GetMonitorInfoW
            get_monitor_info.argtypes = (
                wintypes.HMONITOR, ctypes.POINTER(MonitorInfo))
            get_monitor_info.restype = wintypes.BOOL
            enum_monitors = user32.EnumDisplayMonitors
            enum_monitors.argtypes = (
                wintypes.HDC, ctypes.POINTER(wintypes.RECT), monitor_proc,
                wintypes.LPARAM)
            enum_monitors.restype = wintypes.BOOL

            def collect(monitor, _hdc, _rect, _data):
                info = MonitorInfo(cbSize=ctypes.sizeof(MonitorInfo))
                if get_monitor_info(monitor, ctypes.byref(info)):
                    work = info.rcWork
                    area = (work.left, work.top, work.right, work.bottom)
                    if info.dwFlags & 1:
                        areas.insert(0, area)
                    else:
                        areas.append(area)
                return True

            callback = monitor_proc(collect)
            if not enum_monitors(None, None, callback, 0):
                areas.clear()
        except Exception:
            areas.clear()
        return areas

    @staticmethod
    def _title_bar_visible(x, y, width, area):
        left, top, right, bottom = area
        title_h = theme.sc(40)
        required_w = theme.sc(120)
        overlap_w = max(0, min(x + width, right) - max(x, left))
        overlap_h = max(0, min(y + title_h, bottom) - max(y, top))
        return overlap_w >= required_w and overlap_h >= title_h

    def _clamp_to_work_area(self, width, height, x, y, areas):
        if not areas:
            return None
        for area in areas:
            if self._title_bar_visible(x, y, width, area):
                return x, y

        center_x = x + width / 2
        center_y = y + height / 2

        def distance(area):
            left, top, right, bottom = area
            dx = max(left - center_x, 0, center_x - right)
            dy = max(top - center_y, 0, center_y - bottom)
            return dx * dx + dy * dy

        area = min(areas, key=distance)
        left, top, right, bottom = area
        required_w = theme.sc(120)
        if (width < required_w or right - left < required_w
                or bottom - top < theme.sc(40)):
            return None
        x = max(left + required_w - width, min(x, right - required_w))
        y = max(top, min(y, max(top, bottom - theme.sc(40))))
        if not self._title_bar_visible(x, y, width, area):
            return None
        return x, y

    def _valid_geometry(self, value):
        if not isinstance(value, str):
            return None
        match = re.fullmatch(r"(\d+)x(\d+)([+-]\d+)([+-]\d+)", value)
        if match is None:
            return None
        width, height, x, y = map(int, match.groups())
        if width < theme.sc(660) or height < theme.sc(560):
            return None
        position = self._clamp_to_work_area(
            width, height, x, y, self._monitor_work_areas())
        if position is None:
            return None
        x, y = position
        return f"{width}x{height}{x:+d}{y:+d}"

    def _restore_geometry(self):
        geometry = self._valid_geometry(self._config.get("window_geometry"))
        if geometry is None:
            areas = self._monitor_work_areas()
            if areas:
                left, top, right, bottom = areas[0]
            else:
                left = top = 0
                right = self._win.winfo_screenwidth()
                bottom = self._win.winfo_screenheight()
            width = min(theme.sc(WIN_W), max(1, right - left))
            height = min(theme.sc(WIN_H), max(1, bottom - top))
            x = left + (right - left - width) // 2
            y = top + (bottom - top - height) // 2 - theme.sc(30)
            y = max(top, min(y, bottom - height))
            geometry = f"{width}x{height}{x:+d}{y:+d}"
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
        if self._capturing:
            row = self._shortcut_rows.get(self._capture_target, {})
            if row and row["button"].scene is self._scene:
                row["error"].set_text(
                    "Finish the shortcut, or press Esc to cancel capture.")
                row["error_reveal"].set_visible(True)
                row["chip"].set_text("Press keys…")
            self._raise()
            return
        self._cancel_section_tasks()
        if self._saved_after_id is not None:
            try:
                self._root.after_cancel(self._saved_after_id)
            except tk.TclError:
                pass
            self._saved_after_id = None
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
