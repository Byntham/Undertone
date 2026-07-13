"""Retained single-canvas controls for Undertone's settings window.

Rounded images are created only when a style is first attached.  Relayout is
limited to Canvas coordinate and configuration changes; it never calls Pillow.
"""

import ctypes
import time
import tkinter as tk
import tkinter.font as tkfont
from ctypes import wintypes

from PIL import Image, ImageDraw, ImageTk

import theme


__all__ = [
    "CAP_CACHE", "Scene", "Widget", "VStack", "HStack", "Card", "Row",
    "TextBlock", "Icon", "PillButton", "Toggle", "EntryField",
    "DropdownButton", "Divider", "Spacer", "ListView", "style_toplevel",
]


FONT = ("Segoe UI", 10)
TITLE_FONT = ("Segoe UI Semibold", 10)
HINT_FONT = ("Segoe UI", 9)
BUTTON_FONT = ("Segoe UI Semibold", 10)
SMALL_BUTTON_FONT = ("Segoe UI Semibold", 9)
_UNSET = object()


def _rgb(color):
    color = color.lstrip("#")
    return tuple(int(color[i:i + 2], 16) for i in (0, 2, 4))


def _blend(a, b, amount):
    aa, bb = _rgb(a), _rgb(b)
    values = [round(aa[i] + (bb[i] - aa[i]) * amount) for i in range(3)]
    return "#{:02x}{:02x}{:02x}".format(*values)


def _bake_opaque(image, backdrop):
    """Composite antialiased RGBA artwork onto its known solid backdrop."""
    background = Image.new("RGBA", image.size, _rgb(backdrop) + (255,))
    return Image.alpha_composite(background, image.convert("RGBA")).convert("RGB")


class _CapCache:
    """Process-lifetime cache for fixed-size antialiased corner images."""

    def __init__(self):
        self._items = {}
        self.misses = 0

    def corners(self, radius, fill, border=None, border_width=1,
                backdrop=None):
        backdrop = backdrop or theme.BASE
        key = ("corners", radius, fill, border, border_width, backdrop)
        images = self._items.get(key)
        if images is not None:
            return images
        self.misses += 1
        ss = 4
        side = max(2, radius * 2)
        image = Image.new("RGBA", (side * ss, side * ss), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        draw.rounded_rectangle(
            (0, 0, side * ss - 1, side * ss - 1),
            radius=radius * ss,
            fill=_rgb(fill) + (255,) if fill else None,
            outline=_rgb(border) + (255,) if border else None,
            width=max(1, border_width * ss),
        )
        image = _bake_opaque(
            image.resize((side, side), Image.LANCZOS), backdrop)
        r = side // 2
        crops = (
            image.crop((0, 0, r, r)),
            image.crop((r, 0, side, r)),
            image.crop((0, r, r, side)),
            image.crop((r, r, side, side)),
        )
        images = tuple(ImageTk.PhotoImage(part) for part in crops)
        self._items[key] = images
        return images

    def pill(self, height, fill, border=None, border_width=1, backdrop=None):
        backdrop = backdrop or theme.BASE
        key = ("pill", height, fill, border, border_width, backdrop)
        images = self._items.get(key)
        if images is not None:
            return images
        self.misses += 1
        ss = 4
        image = Image.new("RGBA", (height * ss, height * ss), (0, 0, 0, 0))
        ImageDraw.Draw(image).ellipse(
            (0, 0, height * ss - 1, height * ss - 1),
            fill=_rgb(fill) + (255,),
            outline=_rgb(border) + (255,) if border else None,
            width=max(1, border_width * ss),
        )
        image = _bake_opaque(
            image.resize((height, height), Image.LANCZOS), backdrop)
        half = height // 2
        images = (
            ImageTk.PhotoImage(image.crop((0, 0, half, height))),
            ImageTk.PhotoImage(image.crop((height - half, 0, height, height))),
        )
        self._items[key] = images
        return images

    def side_caps(self, height, radius, fill, border=None, border_width=1,
                  backdrop=None):
        backdrop = backdrop or theme.BASE
        key = ("side_caps", height, radius, fill, border, border_width,
               backdrop)
        images = self._items.get(key)
        if images is not None:
            return images
        self.misses += 1
        ss = 4
        width = radius * 2
        image = Image.new("RGBA", (width * ss, height * ss), (0, 0, 0, 0))
        ImageDraw.Draw(image).rounded_rectangle(
            (0, 0, width * ss - 1, height * ss - 1),
            radius=radius * ss,
            fill=_rgb(fill) + (255,),
            outline=_rgb(border) + (255,) if border else None,
            width=max(1, border_width * ss),
        )
        image = _bake_opaque(
            image.resize((width, height), Image.LANCZOS), backdrop)
        images = (
            ImageTk.PhotoImage(image.crop((0, 0, radius, height))),
            ImageTk.PhotoImage(image.crop((radius, 0, width, height))),
        )
        self._items[key] = images
        return images

    def fixed_pill(self, width, height, fill, border=None, border_width=1,
                   backdrop=None):
        """One cached image for controls whose measured size never stretches."""
        backdrop = backdrop or theme.BASE
        key = ("fixed_pill", width, height, fill, border, border_width,
               backdrop)
        image = self._items.get(key)
        if image is not None:
            return image
        self.misses += 1
        ss = 4
        artwork = Image.new(
            "RGBA", (width * ss, height * ss), (0, 0, 0, 0))
        ImageDraw.Draw(artwork).rounded_rectangle(
            (0, 0, width * ss - 1, height * ss - 1),
            radius=height * ss // 2,
            fill=_rgb(fill) + (255,),
            outline=_rgb(border) + (255,) if border else None,
            width=max(1, border_width * ss),
        )
        artwork = _bake_opaque(
            artwork.resize((width, height), Image.LANCZOS), backdrop)
        image = ImageTk.PhotoImage(artwork)
        self._items[key] = image
        return image


CAP_CACHE = _CapCache()

# Escapes that turn any Python string into one literal Tcl word (see
# Scene._flush_layout's eval batching).
_TCL_WORD = str.maketrans({
    "\\": r"\\", "\n": r"\n", "\t": r"\t", "\r": r"\r",
    **{ch: "\\" + ch for ch in ' "$[]{};'},
})


class _RoundSurface:
    def __init__(self, widget, radius, fill, border=None, border_width=None,
                 backdrop=None):
        self.widget = widget
        self.canvas = widget.canvas
        self.scene = widget.scene
        self.radius = radius
        self.fill = fill
        self.border = border
        self.backdrop = backdrop or widget.backdrop
        self.border_width = border_width or max(1, theme.sc(1))
        self.items = []
        self._geometry = None
        self._style = None
        self._visible = True
        self._styles = {}
        self._mode = "outline" if fill is None else "border" if border else "fill"
        self._rect_count = 4 if self._mode != "fill" else 2
        self.prewarm(((fill, border),))

    def prewarm(self, styles):
        for fill, border in styles:
            key = (fill, border)
            if key not in self._styles:
                self._styles[key] = CAP_CACHE.corners(
                    self.radius, fill, border, self.border_width,
                    self.backdrop)

    def _create(self):
        if self.items:
            return
        tags = (self.widget.tag,)
        self.items = [self.canvas.create_rectangle(
            0, 0, 0, 0, width=0, tags=tags)
            for _ in range(self._rect_count)]
        self.items.extend(
            self.canvas.create_image(0, 0, anchor="nw", tags=tags)
            for _ in range(4)
        )
        self.set_style(self.fill, self.border)

    def set_style(self, fill, border=None):
        self.prewarm(((fill, border),))
        if self._style == (fill, border) and self.items:
            return
        self.fill, self.border = fill, border
        self._create()
        self._style = (fill, border)
        edge = border or fill or ""
        if self._mode == "border":
            colors = (edge, edge, fill, fill)
        elif self._mode == "outline":
            colors = (edge,) * 4
        else:
            colors = (fill, fill)
        for item, color in zip(self.items[:self._rect_count], colors):
            self.scene._itemconfigure(item, fill=color or "")
        for item, image in zip(
                self.items[self._rect_count:], self._styles[self._style]):
            self.scene._itemconfigure(item, image=image)

    def layout(self, x, y, w, h):
        self._create()
        geometry = (round(x), round(y), round(w), round(h))
        if geometry == self._geometry:
            return
        self._geometry = geometry
        x, y, w, h = geometry
        r = min(self.radius, w // 2, h // 2)
        bw = self.border_width
        if self._mode == "border":
            rects = (
                (x + r, y, x + w - r, y + h),
                (x, y + r, x + w, y + h - r),
                (x + r, y + bw, x + w - r, y + h - bw),
                (x + bw, y + r, x + w - bw, y + h - r),
            )
        elif self._mode == "outline":
            rects = (
                (x + r, y, x + w - r, y + bw),
                (x + r, y + h - bw, x + w - r, y + h),
                (x, y + r, x + bw, y + h - r),
                (x + w - bw, y + r, x + w, y + h - r),
            )
        else:
            rects = (
                (x + r, y, x + w - r, y + h),
                (x, y + r, x + w, y + h - r),
            )
        coords = rects + (
            (x, y),
            (x + w - self.radius, y),
            (x, y + h - self.radius),
            (x + w - self.radius, y + h - self.radius),
        )
        for item, value in zip(self.items, coords):
            self.scene._coords(item, *value)

    def set_visible(self, visible):
        if self._visible == bool(visible):
            return
        self._visible = bool(visible)
        state = "normal" if visible else "hidden"
        for item in self.items:
            self.scene._itemconfigure(item, state=state)

    def destroy(self):
        for item in self.items:
            self.canvas.delete(item)
        self.items = []


class _PillSurface:
    def __init__(self, widget, height, fill, border=None, border_width=None):
        self.widget = widget
        self.canvas = widget.canvas
        self.scene = widget.scene
        self.height = height
        self.border_width = border_width or max(1, theme.sc(1))
        self.fill = fill
        self.border = border
        self.backdrop = widget.backdrop
        self._styles = {}
        self._style = None
        self._geometry = None
        self.items = []
        self.prewarm(((fill, border),))

    def prewarm(self, styles):
        for fill, border in styles:
            key = (fill, border)
            if key not in self._styles:
                self._styles[key] = CAP_CACHE.pill(
                    self.height, fill, border, self.border_width,
                    self.backdrop)

    def _create(self):
        if self.items:
            return
        tags = (self.widget.tag,)
        self.items = [
            self.canvas.create_rectangle(0, 0, 0, 0, width=0, tags=tags),
            self.canvas.create_rectangle(0, 0, 0, 0, width=0, tags=tags),
            self.canvas.create_image(0, 0, anchor="nw", tags=tags),
            self.canvas.create_image(0, 0, anchor="nw", tags=tags),
        ]
        self.set_style(self.fill, self.border)

    def set_style(self, fill, border=None):
        self.prewarm(((fill, border),))
        if self._style == (fill, border) and self.items:
            return
        self._create()
        self._style = (fill, border)
        self.scene._itemconfigure(self.items[0], fill=border or fill)
        self.scene._itemconfigure(self.items[1], fill=fill)
        for item, image in zip(self.items[2:], self._styles[self._style]):
            self.scene._itemconfigure(item, image=image)

    def layout(self, x, y, w, h=None):
        self._create()
        h = self.height if h is None else h
        geometry = (round(x), round(y), round(w), round(h))
        if geometry == self._geometry:
            return
        self._geometry = geometry
        x, y, w, h = geometry
        half = self.height // 2
        bw = self.border_width if self._style[1] else 0
        coords = (
            (x + half, y, x + w - half, y + h),
            (x + half, y + bw, x + w - half, y + h - bw),
            (x, y),
            (x + w - half, y),
        )
        for item, value in zip(self.items, coords):
            self.scene._coords(item, *value)

    def destroy(self):
        for item in self.items:
            self.canvas.delete(item)
        self.items = []


class _FixedRoundSurface:
    """Two cached side caps plus center fills for fixed-height controls."""

    def __init__(self, widget, height, radius, fill, border=None, border_width=None):
        self.widget = widget
        self.canvas = widget.canvas
        self.scene = widget.scene
        self.height = height
        self.radius = radius
        self.border_width = border_width or max(1, theme.sc(1))
        self.fill = fill
        self.border = border
        self.backdrop = widget.backdrop
        self._styles = {}
        self._style = None
        self._geometry = None
        self.items = []
        self.prewarm(((fill, border),))

    def prewarm(self, styles):
        for fill, border in styles:
            key = (fill, border)
            if key not in self._styles:
                self._styles[key] = CAP_CACHE.side_caps(
                    self.height, self.radius, fill, border, self.border_width,
                    self.backdrop)

    def _create(self):
        if self.items:
            return
        tags = (self.widget.tag,)
        self.items = [
            self.canvas.create_rectangle(0, 0, 0, 0, width=0, tags=tags),
            self.canvas.create_rectangle(0, 0, 0, 0, width=0, tags=tags),
            self.canvas.create_image(0, 0, anchor="nw", tags=tags),
            self.canvas.create_image(0, 0, anchor="nw", tags=tags),
        ]
        self.set_style(self.fill, self.border)

    def set_style(self, fill, border=None):
        self.prewarm(((fill, border),))
        if self._style == (fill, border) and self.items:
            return
        self._create()
        self._style = (fill, border)
        self.scene._itemconfigure(self.items[0], fill=border or fill)
        self.scene._itemconfigure(self.items[1], fill=fill)
        for item, image in zip(self.items[2:], self._styles[self._style]):
            self.scene._itemconfigure(item, image=image)

    def layout(self, x, y, w, h=None):
        self._create()
        h = self.height if h is None else h
        geometry = (round(x), round(y), round(w), round(h))
        if geometry == self._geometry:
            return
        self._geometry = geometry
        x, y, w, h = geometry
        radius = self.radius
        inset = self.border_width if self._style[1] else 0
        coords = (
            (x + radius, y, x + w - radius, y + h),
            (x + radius, y + inset, x + w - radius, y + h - inset),
            (x, y),
            (x + w - radius, y),
        )
        for item, values in zip(self.items, coords):
            self.scene._coords(item, *values)

    def destroy(self):
        for item in self.items:
            self.canvas.delete(item)
        self.items = []


class Widget:
    """Base for retained canvas items; dimensions passed to layout are pixels."""

    focusable = False

    def __init__(self):
        self.scene = None
        self.canvas = None
        self.tag = None
        self.parent = None
        self.backdrop = theme.BASE
        self._items = []
        self._geometry = None
        self._measure_width = None
        self._measure_result = None
        self._measure_aux = None
        self._hovered = False
        self._pressed = False
        self._focused = False
        self._bindings_ready = False

    def _attach(self, scene, parent=None):
        if self.scene is scene:
            return
        self.scene = scene
        self.canvas = scene.canvas
        self.parent = parent
        self.backdrop = (
            parent._backdrop_for_child(self) if parent else scene.backdrop)
        self.tag = scene._new_tag()
        if self.focusable:
            scene._focusables.append(self)

    def measure(self, avail_w):
        return avail_w, 0

    def _measure(self, avail_w):
        if avail_w != self._measure_width or self._measure_result is None:
            self._measure_width = avail_w
            self._measure_result = self.measure(avail_w)
        return self._measure_result

    def _invalidate_measure(self):
        widget = self
        while widget is not None:
            widget._measure_width = None
            widget._measure_result = None
            widget._measure_aux = None
            widget = widget.parent
        if self.scene is not None:
            self.scene._layout_dirty = True

    def _backdrop_for_child(self, _child):
        return self.backdrop

    def layout(self, x, y, w):
        self._geometry = (x, y, w, self._measure(w)[1])

    def destroy(self):
        if self.scene is not None and self.scene.focused is self:
            if hasattr(self.scene, "_hide_focus_ring"):
                self.scene._hide_focus_ring(self)
            self.scene.focused = None
        for item in self._items:
            self.canvas.delete(item)
        self._items = []
        self.scene = None
        self.canvas = None
        self.parent = None

    def hover(self, state):
        self._hovered = bool(state)

    def press(self, state):
        self._pressed = bool(state)

    def focus(self, state):
        self._focused = bool(state)

    def activate(self):
        pass

    def key(self, keysym):
        if keysym in ("space", "Return", "KP_Enter"):
            self.activate()
            return True
        return False

    def _bind_clickable(self):
        if self._bindings_ready:
            return
        self._bindings_ready = True
        self.canvas.tag_bind(self.tag, "<Enter>", self._enter)
        self.canvas.tag_bind(self.tag, "<Leave>", self._leave)
        self.canvas.tag_bind(self.tag, "<Button-1>", self._down)
        self.canvas.tag_bind(self.tag, "<ButtonRelease-1>", self._up)

    def _enter(self, _event):
        self.canvas.configure(cursor="hand2")
        self.hover(True)

    def _leave(self, _event):
        self.canvas.configure(cursor="")
        self.press(False)
        self.hover(False)

    def _down(self, _event):
        self.canvas.focus_set()
        if self.focusable:
            self.scene.focus_widget(self)
        self.press(True)

    def _up(self, event):
        was_pressed = self._pressed
        self.press(False)
        current = self.canvas.find_withtag("current")
        if was_pressed and current and self.tag in self.canvas.gettags(current[0]):
            self.activate()


class VStack(Widget):
    def __init__(self, children=None, gap=10):
        super().__init__()
        self.children = list(children or [])
        self.gap = theme.sc(gap)

    def add(self, widget):
        self.children.append(widget)
        if self.scene is not None:
            widget._attach(self.scene, self)
        self._invalidate_measure()
        if self.scene is not None:
            self.scene.relayout()
        return widget

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        for child in self.children:
            child._attach(scene, self)

    def measure(self, avail_w):
        heights = [child._measure(avail_w)[1] for child in self.children]
        return avail_w, sum(heights) + self.gap * max(0, len(heights) - 1)

    def layout(self, x, y, w):
        geometry = (x, y, w, self._measure(w)[1])
        if geometry == self._geometry:
            return
        self._geometry = geometry
        top = y
        for child in self.children:
            height = child._measure(w)[1]
            child.layout(x, top, w)
            top += height + self.gap

    def destroy(self):
        for child in self.children:
            child.destroy()
        super().destroy()


class HStack(Widget):
    def __init__(self, children=None, gap=8, align="center"):
        super().__init__()
        self.children = list(children or [])
        self.gap = theme.sc(gap)
        self.align = align

    def add(self, widget):
        self.children.append(widget)
        if self.scene is not None:
            widget._attach(self.scene, self)
        self._invalidate_measure()
        if self.scene is not None:
            self.scene.relayout()
        return widget

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        for child in self.children:
            child._attach(scene, self)

    def measure(self, avail_w):
        if not self.children:
            return avail_w, 0
        inner = max(0, avail_w - self.gap * (len(self.children) - 1))
        share = inner // len(self.children)
        sizes = [child._measure(share) for child in self.children]
        return min(avail_w, sum(size[0] for size in sizes) + self.gap * (len(sizes) - 1)), max(size[1] for size in sizes)

    def layout(self, x, y, w):
        geometry = (x, y, w, self._measure(w)[1])
        if geometry == self._geometry:
            return
        self._geometry = geometry
        count = len(self.children)
        if not count:
            return
        share = max(0, (w - self.gap * (count - 1)) // count)
        height = self._measure(w)[1]
        left = x
        for child in self.children:
            _, child_h = child._measure(share)
            cy = y
            if self.align == "center":
                cy += (height - child_h) // 2
            elif self.align == "end":
                cy += height - child_h
            child.layout(left, cy, share)
            left += share + self.gap

    def destroy(self):
        for child in self.children:
            child.destroy()
        super().destroy()


def _padding(value):
    if isinstance(value, (tuple, list)):
        values = list(value)
        if len(values) == 2:
            vertical, horizontal = values
            values = [horizontal, vertical, horizontal, vertical]
        elif len(values) != 4:
            raise ValueError("padding must be a number, (vertical, horizontal), or four values")
    else:
        values = [value] * 4
    return tuple(theme.sc(item) for item in values)


class Card(Widget):
    def __init__(self, child, padding=(9, 14), radius=8, fill=None, border=None):
        super().__init__()
        self.child = child
        self.padding = _padding(padding)
        self.radius = theme.sc(radius)
        self.fill = fill or theme.CARD
        self.border = theme.CARD_BORDER if border is None else border
        self._surface = None

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.child._attach(scene, self)
        self._surface = _RoundSurface(self, self.radius, self.fill, self.border)
        self._surface.prewarm(((theme.CARD_HOVER, self.border),))

    def _backdrop_for_child(self, _child):
        return self.fill

    def measure(self, avail_w):
        left, top, right, bottom = self.padding
        inner = max(0, avail_w - left - right)
        return avail_w, top + self.child._measure(inner)[1] + bottom

    def layout(self, x, y, w):
        height = self._measure(w)[1]
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self._surface.layout(x, y, w, height)
        left, top, right, _bottom = self.padding
        self.child.layout(x + left, y + top, max(0, w - left - right))

    def hover(self, state):
        super().hover(state)
        self._surface.set_style(theme.CARD_HOVER if state else self.fill, self.border)

    def destroy(self):
        self.child.destroy()
        if self._surface:
            self._surface.destroy()
        super().destroy()


class TextBlock(Widget):
    def __init__(self, text, font=FONT, fill=None, wrap=True, justify="left"):
        super().__init__()
        self.text = text
        self.font = font
        self.fill = fill or theme.TEXT
        self.wrap = wrap
        self.justify = justify
        self._font = None
        self._measure_cache = {}
        self._wrap_cache = {}
        self._text_metrics = None
        self._item = None
        self._last_wrap = _UNSET
        self._position = None

    def _font_obj(self):
        if self._font is None:
            self._font = tkfont.Font(font=self.font)
        return self._font

    def _line_layout(self, width):
        if self._text_metrics is None:
            font = self._font_obj()
            paragraphs = []
            desired = 0
            for paragraph in self.text.split("\n"):
                words = paragraph.split()
                paragraphs.append([(word, font.measure(word)) for word in words])
                desired = max(desired, font.measure(paragraph))
            self._text_metrics = (
                paragraphs, font.measure(" "), desired,
                font.metrics("linespace"))
        paragraphs, space_width, _desired, _line_space = self._text_metrics
        lines = 0
        layout = []
        for words in paragraphs:
            if not self.wrap:
                lines += 1
                layout.append((len(words),))
                continue
            if not words:
                lines += 1
                layout.append((0,))
                continue
            current = words[0][1]
            count = 1
            line_words = 1
            paragraph_layout = []
            for _word, word_width in words[1:]:
                candidate = current + space_width + word_width
                if candidate <= width:
                    current = candidate
                    line_words += 1
                else:
                    paragraph_layout.append(line_words)
                    count += 1
                    current = word_width
                    line_words = 1
            paragraph_layout.append(line_words)
            layout.append(tuple(paragraph_layout))
            lines += count
        return max(1, lines), tuple(layout)

    def measure(self, avail_w):
        width = max(1, int(avail_w))
        cached = self._measure_cache.get(width)
        if cached is not None:
            return cached
        line_count, wrap_layout = self._line_layout(width)
        _paragraphs, _space, desired, line_space = self._text_metrics
        result = (width if self.wrap else min(width, desired), line_count * line_space)
        self._measure_cache[width] = result
        self._wrap_cache[width] = wrap_layout
        return result

    def layout(self, x, y, w):
        if self._item is None:
            self._item = self.canvas.create_text(
                x, y, anchor="nw", text=self.text, font=self.font,
                fill=self.fill, justify=self.justify, tags=(self.tag,))
            self._items.append(self._item)
        width = max(1, int(w))
        geometry = (round(x), round(y), width)
        if geometry == self._geometry:
            return
        _paragraphs, _space, desired, _line_space = self._text_metrics
        wrap_width = width if self.wrap and desired > width else 0
        wrap_layout = self._wrap_cache.get(width) if wrap_width else None
        if wrap_layout != self._last_wrap:
            self.scene._itemconfigure(self._item, width=wrap_width)
            self._last_wrap = wrap_layout
        position = geometry[:2]
        if position != self._position:
            self.scene._coords(self._item, *position)
            self._position = position
        self._geometry = geometry

    def set_text(self, text):
        if text == self.text:
            return
        self.text = text
        self._measure_cache.clear()
        self._wrap_cache.clear()
        self._text_metrics = None
        self._last_wrap = _UNSET
        if self._item is not None:
            self.canvas.itemconfigure(self._item, text=text)
        self._invalidate_measure()
        if self.scene:
            self.scene.relayout()


class Row(Widget):
    def __init__(self, title, hint=None, control=None, gap=18):
        super().__init__()
        self.title = title if isinstance(title, Widget) else TextBlock(title, TITLE_FONT)
        self.hint = hint if isinstance(hint, Widget) else (
            TextBlock(hint, HINT_FONT, theme.MUTED) if hint else None)
        self.control = control
        self.gap = theme.sc(gap)
        self.text_gap = theme.sc(2)

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self.title._attach(scene, self)
        if self.hint:
            self.hint._attach(scene, self)
        if self.control:
            self.control._attach(scene, self)

    def _sizes(self, avail_w):
        if self._measure_aux is not None and self._measure_aux[0] == avail_w:
            return self._measure_aux[1]
        control_w = control_h = 0
        if self.control:
            control_w, control_h = self.control._measure(avail_w)
        left_w = max(theme.sc(80), avail_w - control_w - (self.gap if self.control else 0))
        title_h = self.title._measure(left_w)[1]
        hint_h = self.hint._measure(left_w)[1] if self.hint else 0
        left_h = title_h + (self.text_gap + hint_h if self.hint else 0)
        result = (left_w, left_h, control_w, control_h, title_h)
        self._measure_aux = (avail_w, result)
        return result

    def measure(self, avail_w):
        sizes = self._sizes(avail_w)
        return avail_w, max(sizes[1], sizes[3])

    def layout(self, x, y, w):
        left_w, left_h, control_w, control_h, title_h = self._sizes(w)
        height = max(left_h, control_h)
        geometry = (x, y, w, height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self.title.layout(x, y, left_w)
        if self.hint:
            self.hint.layout(x, y + title_h + self.text_gap, left_w)
        if self.control:
            self.control.layout(x + w - control_w, y + (height - control_h) // 2, control_w)

    def destroy(self):
        self.title.destroy()
        if self.hint:
            self.hint.destroy()
        if self.control:
            self.control.destroy()
        super().destroy()


class _Control(Widget):
    focusable = True

    def __init__(self):
        super().__init__()
        self._focus_radius = None

    def _make_focus_surface(self, radius):
        self._focus_radius = radius
        CAP_CACHE.corners(
            radius, theme.ACCENT, None, max(1, theme.sc(1)), self.backdrop)

    def _layout_focus(self, x, y, w, h):
        if self._focused:
            self.scene._show_focus_ring(self)

    def focus(self, state):
        super().focus(state)
        if self.scene:
            if state:
                self.scene._show_focus_ring(self)
            else:
                self.scene._hide_focus_ring(self)


class PillButton(_Control):
    def __init__(self, text, kind="accent", on_click=None, small=False,
                 compact=False):
        super().__init__()
        self.text = text
        self.kind = kind
        self.on_click = on_click
        self.enabled = True
        self.compact = compact
        self.font = SMALL_BUTTON_FONT if small else BUTTON_FONT
        self.height = theme.sc(26 if small else 32)
        self.pad = theme.sc(13 if small else 17)
        self._font = None
        self._surface = None
        self._compact_item = None
        self._compact_images = None
        self._text_item = None
        self._measured_width = None

    def _states(self):
        if self.kind == "accent":
            return {
                "normal": (theme.ACCENT, None, theme.INK),
                "hover": (theme.ACCENT_HOVER, None, theme.INK),
                "down": (theme.ACCENT_DOWN, None, theme.INK),
                "disabled": (theme.SURFACE0, None, theme.MUTED),
            }
        if self.kind == "danger":
            return {
                "normal": (theme.RED, None, theme.INK),
                "hover": (_blend(theme.RED, theme.TEXT, 0.15), None, theme.INK),
                "down": (_blend(theme.RED, theme.BASE, 0.18), None, theme.INK),
                "disabled": (theme.SURFACE0, None, theme.MUTED),
            }
        return {
            "normal": (theme.SURFACE0, theme.SURFACE1, theme.TEXT),
            "hover": (theme.SURFACE1, theme.SURFACE1, theme.TEXT),
            "down": (theme.SURFACE1, theme.ACCENT, theme.TEXT),
            "disabled": (theme.SURFACE0, theme.SURFACE0, theme.MUTED),
        }

    def _ensure(self):
        if self._surface or self._compact_item:
            return
        states = self._states()
        fill, border, _fg = states["normal"]
        if self.compact:
            width = self._measured_width or self.measure(10000)[0]
            self._compact_images = {
                name: CAP_CACHE.fixed_pill(
                    width, self.height, state_fill, state_border,
                    max(1, theme.sc(1)), self.backdrop)
                for name, (state_fill, state_border, _state_fg)
                in states.items()
            }
            self._compact_item = self.canvas.create_image(
                0, 0, anchor="nw", image=self._compact_images["normal"],
                tags=(self.tag,))
            self._items.append(self._compact_item)
        else:
            self._surface = _PillSurface(self, self.height, fill, border)
            self._surface.prewarm((value[:2] for value in states.values()))
            self._surface._create()
        self._text_item = self.canvas.create_text(
            0, 0, text=self.text, font=self.font, fill=_fg,
            tags=(self.tag,))
        self._items.append(self._text_item)
        self._make_focus_surface(self.height // 2 + theme.sc(2))
        self._bind_clickable()
        if not self.enabled:
            self._apply()

    def measure(self, avail_w):
        if self._measured_width is None:
            self._font = tkfont.Font(font=self.font)
            self._measured_width = max(
                self.height * 2, self._font.measure(self.text) + self.pad * 2)
        return min(avail_w, self._measured_width), self.height

    def layout(self, x, y, w):
        self._ensure()
        height = self.height
        geometry = (round(x), round(y), round(w), height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        if self._surface:
            self._surface.layout(*geometry)
        else:
            self.scene._coords(self._compact_item, x, y)
        self.scene._coords(self._text_item, x + w / 2, y + height / 2)
        self._layout_focus(*geometry)

    def _apply(self):
        state = ("disabled" if not self.enabled else
                 "down" if self._pressed else
                 "hover" if self._hovered else "normal")
        fill, border, fg = self._states()[state]
        if self._surface:
            self._surface.set_style(fill, border)
        else:
            self.canvas.itemconfigure(
                self._compact_item, image=self._compact_images[state])
        self.canvas.itemconfigure(self._text_item, fill=fg)

    def hover(self, state):
        super().hover(state)
        self._apply()

    def press(self, state):
        super().press(state)
        self._apply()

    def activate(self):
        if self.enabled and self.on_click:
            self.on_click()

    def set_enabled(self, enabled):
        enabled = bool(enabled)
        if enabled == self.enabled:
            return
        self.enabled = enabled
        self._pressed = False
        if self._surface:
            self._apply()

    def enable(self):
        self.set_enabled(True)

    def disable(self):
        self.set_enabled(False)

    def set_text(self, text):
        if text == self.text:
            return
        self.text = text
        if self._text_item:
            self.canvas.itemconfigure(self._text_item, text=text)
        self._measured_width = None
        self._invalidate_measure()
        if self.scene:
            self.scene.relayout()

    def destroy(self):
        if self._surface:
            self._surface.destroy()
        super().destroy()


class Toggle(_Control):
    def __init__(self, on=False, on_change=None):
        super().__init__()
        self.on = bool(on)
        self.on_change = on_change
        self.width = theme.sc(40)
        self.height = theme.sc(22)
        self._surface = None
        self._knob = None
        self._frame = 4 if self.on else 0
        self._after = None
        self._fills = [_blend(theme.SURFACE1, theme.ACCENT, i / 4) for i in range(5)]

    def _ensure(self):
        if self._surface:
            return
        self._surface = _PillSurface(self, self.height, self._fills[self._frame])
        self._surface.prewarm((fill, None) for fill in self._fills)
        self._surface._create()
        self._knob = self.canvas.create_oval(
            0, 0, 0, 0, width=0, fill=theme.INK if self.on else theme.TEXT,
            tags=(self.tag,))
        self._items.append(self._knob)
        self._make_focus_surface(self.height // 2 + theme.sc(2))
        self._bind_clickable()

    def measure(self, avail_w):
        return min(avail_w, self.width), self.height

    def layout(self, x, y, w):
        self._ensure()
        geometry = (round(x), round(y), self.width, self.height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self._surface.layout(*geometry)
        self._layout_knob()
        self._layout_focus(*geometry)

    def _layout_knob(self):
        x, y, _w, h = self._geometry
        inset = theme.sc(3)
        diameter = h - inset * 2
        travel = self.width - h
        left = x + inset + round(travel * self._frame / 4)
        self.scene._coords(
            self._knob, left, y + inset, left + diameter, y + inset + diameter)
        self.scene._itemconfigure(
            self._knob, fill=_blend(theme.TEXT, theme.INK, self._frame / 4))
        self._surface.set_style(self._fills[self._frame])

    def _animate(self, target):
        if self._after is not None:
            self.canvas.after_cancel(self._after)
            self._after = None
        direction = 1 if target > self._frame else -1

        def step():
            if self._frame == target:
                self._after = None
                return
            self._frame += direction
            self._layout_knob()
            self._after = self.canvas.after(28, step)

        step()

    def set(self, on, notify=False):
        on = bool(on)
        if on == self.on:
            return
        self.on = on
        self._animate(4 if on else 0)
        if notify and self.on_change:
            self.on_change(on)

    def get(self):
        return self.on

    def activate(self):
        self.set(not self.on, notify=True)

    def key(self, keysym):
        if keysym in ("Left", "Down"):
            self.set(False, notify=True)
            return True
        if keysym in ("Right", "Up"):
            self.set(True, notify=True)
            return True
        return super().key(keysym)

    def destroy(self):
        if self._after is not None:
            self.canvas.after_cancel(self._after)
        if self._surface:
            self._surface.destroy()
        super().destroy()


class EntryField(_Control):
    def __init__(self, get, set, placeholder="", secret=False, multiline=False,
                 width=210, on_enter=None):
        super().__init__()
        self.getter = get
        self.setter = set
        self.on_enter = on_enter
        self.placeholder = placeholder
        self.secret = secret
        self.multiline = multiline
        self.width = theme.sc(width)
        self.height = theme.sc(64 if multiline else 34)
        self.radius = theme.sc(6)
        self._surface = None
        self._text_item = None
        self._last_text_width = None

    def _ensure(self):
        if self._surface:
            return
        self._surface = _FixedRoundSurface(
            self, self.height, self.radius, theme.SURFACE0, theme.SURFACE1)
        self._surface.prewarm(((theme.SURFACE0, theme.ACCENT),))
        self._surface._create()  # before the text item, or it stacks on top
        self._text_item = self.canvas.create_text(
            0, 0, anchor="nw" if self.multiline else "w",
            font=FONT, fill=theme.TEXT, tags=(self.tag,))
        self._items.append(self._text_item)
        self._make_focus_surface(self.radius + theme.sc(2))
        self._bind_clickable()
        self.refresh()

    def measure(self, avail_w):
        return min(avail_w, self.width), self.height

    def layout(self, x, y, w):
        self._ensure()
        width = min(w, self.width)
        geometry = (round(x), round(y), round(width), self.height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self._surface.layout(*geometry)
        anchor_y = y + theme.sc(13) if self.multiline else y + self.height / 2
        text_width = max(1, width - theme.sc(20))
        if text_width != self._last_text_width:
            self.scene._itemconfigure(self._text_item, width=text_width)
            self._last_text_width = text_width
        self.scene._coords(self._text_item, x + theme.sc(10), anchor_y)
        self._layout_focus(*geometry)
        if self.scene.editing is self:
            self.scene._position_editor()

    def display_value(self):
        value = str(self.getter() or "")
        return ("•" * len(value)) if self.secret and value else value

    def refresh(self):
        if self._text_item is None:
            return
        text = self.display_value()
        self.canvas.itemconfigure(
            self._text_item, text=text or self.placeholder,
            fill=theme.TEXT if text else theme.MUTED)

    def activate(self):
        self.scene.begin_edit(self)

    def focus(self, state):
        super().focus(state)
        if self._surface:
            self._surface.set_style(
                theme.SURFACE0, theme.ACCENT if state else theme.SURFACE1)

    def destroy(self):
        if self.scene and self.scene.editing is self:
            self.scene.end_edit(commit=True)
        if self._surface:
            self._surface.destroy()
        super().destroy()


class DropdownButton(_Control):
    def __init__(self, options, get, set, width=180):
        super().__init__()
        self.options = list(options)
        self.getter = get
        self.setter = set
        self.width = theme.sc(width)
        self.height = theme.sc(34)
        self.radius = theme.sc(6)
        self._surface = None
        self._text_item = None
        self._arrow = None
        self._popup = None
        self._menu_closed_at = float("-inf")

    def _pairs(self):
        return [item if isinstance(item, (tuple, list)) else (item, item) for item in self.options]

    def _label(self):
        value = self.getter()
        for label, option in self._pairs():
            if option == value:
                return label
        return str(value or "")

    def _ensure(self):
        if self._surface:
            return
        self._surface = _FixedRoundSurface(
            self, self.height, self.radius, theme.SURFACE0, theme.SURFACE1)
        self._surface.prewarm(((theme.SURFACE1, theme.SURFACE1), (theme.SURFACE0, theme.ACCENT)))
        self._surface._create()  # before the text item, or it stacks on top
        self._text_item = self.canvas.create_text(
            0, 0, anchor="w", font=FONT, fill=theme.TEXT, tags=(self.tag,))
        self._arrow = self.canvas.create_text(
            0, 0, text="⌄", font=FONT, fill=theme.SUBTEXT, tags=(self.tag,))
        self._items.extend((self._text_item, self._arrow))
        self._make_focus_surface(self.radius + theme.sc(2))
        self._bind_clickable()
        self.refresh()

    def measure(self, avail_w):
        return min(avail_w, self.width), self.height

    def layout(self, x, y, w):
        self._ensure()
        width = min(w, self.width)
        geometry = (round(x), round(y), round(width), self.height)
        if geometry == self._geometry:
            return
        self._geometry = geometry
        self._surface.layout(*geometry)
        self.scene._coords(
            self._text_item, x + theme.sc(11), y + self.height / 2)
        self.scene._coords(
            self._arrow, x + width - theme.sc(13), y + self.height / 2)
        self._layout_focus(*geometry)

    def refresh(self):
        if self._text_item:
            self.canvas.itemconfigure(self._text_item, text=self._label())

    def hover(self, state):
        super().hover(state)
        if self._surface and not self._focused:
            self._surface.set_style(
                theme.SURFACE1 if state else theme.SURFACE0, theme.SURFACE1)

    def focus(self, state):
        super().focus(state)
        if self._surface:
            self._surface.set_style(
                theme.SURFACE0, theme.ACCENT if state else theme.SURFACE1)

    def activate(self):
        if self._popup is not None:
            self.close_popup()
        else:
            self.open_popup()

    def open_popup(self):
        if (self._popup is not None or not self._geometry
                or time.monotonic() - self._menu_closed_at < 0.35):
            return
        self.scene.end_edit(commit=True)
        popup = tk.Toplevel(self.canvas)
        self._popup = popup
        self.scene.popup = self
        popup.withdraw()
        popup.overrideredirect(True)
        popup.transient(self.canvas.winfo_toplevel())
        popup.configure(bg=theme.CARD_BORDER)
        x, y, w, h = self._geometry
        screen_x = self.canvas.winfo_rootx() + x
        screen_y = self.canvas.winfo_rooty() + round(y - self.canvas.canvasy(0)) + h + theme.sc(3)
        row_h = theme.sc(30)
        popup.geometry(f"{w}x{row_h * len(self.options) + theme.sc(2)}+{screen_x}+{screen_y}")
        for index, (label, value) in enumerate(self._pairs()):
            item = tk.Label(
                popup, text=label, bg=theme.SURFACE0, fg=theme.TEXT,
                font=FONT, anchor="w", padx=theme.sc(10), cursor="hand2")
            item.place(x=theme.sc(1), y=theme.sc(1) + index * row_h,
                       width=w - theme.sc(2), height=row_h)
            item.bind("<Enter>", lambda _e, node=item: node.configure(bg=theme.SURFACE1))
            item.bind("<Leave>", lambda _e, node=item: node.configure(bg=theme.SURFACE0))
            item.bind("<Button-1>", lambda _e, selected=value: self._select(selected))
        popup.bind("<Escape>", lambda _e: self.close_popup())
        popup.bind("<FocusOut>", self._popup_focus_out)
        popup.deiconify()
        popup.focus_set()

    def _popup_focus_out(self, _event):
        popup = self._popup
        if popup:
            popup.after_idle(lambda: self._popup is popup and self.close_popup())

    def _select(self, value):
        self.setter(value)
        self.refresh()
        self.close_popup()

    def close_popup(self):
        popup, self._popup = self._popup, None
        if self.scene and self.scene.popup is self:
            self.scene.popup = None
        if popup is not None:
            self._menu_closed_at = time.monotonic()
            popup.destroy()
        self.canvas.focus_set()

    def key(self, keysym):
        pairs = self._pairs()
        if keysym in ("Left", "Up", "Right", "Down") and pairs:
            values = [value for _label, value in pairs]
            try:
                index = values.index(self.getter())
            except ValueError:
                index = 0
            index += -1 if keysym in ("Left", "Up") else 1
            self._select(values[index % len(values)])
            return True
        return super().key(keysym)

    def destroy(self):
        self.close_popup()
        if self._surface:
            self._surface.destroy()
        super().destroy()


class Icon(Widget):
    def __init__(self, pil_image=None, draw_fn=None, size=20):
        super().__init__()
        self.pil_image = pil_image
        self.draw_fn = draw_fn
        self.size = theme.sc(size)
        self._photo = None
        self._item = None

    def measure(self, avail_w):
        return min(avail_w, self.size), self.size

    def layout(self, x, y, w):
        if self._item is None:
            image = self.pil_image or self.draw_fn(self.size)
            if image.size != (self.size, self.size):
                image = image.resize((self.size, self.size), Image.LANCZOS)
            image = _bake_opaque(image, self.backdrop)
            self._photo = ImageTk.PhotoImage(image)
            self._item = self.canvas.create_image(x, y, anchor="nw", image=self._photo, tags=(self.tag,))
            self._items.append(self._item)
        geometry = (round(x), round(y))
        if geometry != self._geometry:
            self.scene._coords(self._item, *geometry)
            self._geometry = geometry


class Divider(Widget):
    def __init__(self, fill=None):
        super().__init__()
        self.fill = fill or theme.CARD_BORDER
        self.height = max(1, theme.sc(1))
        self._item = None

    def measure(self, avail_w):
        return avail_w, self.height

    def layout(self, x, y, w):
        if self._item is None:
            self._item = self.canvas.create_rectangle(
                x, y, x + w, y + self.height, width=0,
                fill=self.fill, tags=(self.tag,))
            self._items.append(self._item)
        geometry = (round(x), round(y), round(w))
        if geometry != self._geometry:
            self.scene._coords(self._item, x, y, x + w, y + self.height)
            self._geometry = geometry


class Spacer(Widget):
    def __init__(self, h):
        super().__init__()
        self.height = theme.sc(h)

    def measure(self, avail_w):
        return avail_w, self.height


class ListView(Widget):
    """Fixed-height virtual list; only intersecting rows own canvas items."""

    def __init__(self, rows=None, row_factory=None, height=108, gap=1,
                 max_height=None, reserve=150):
        super().__init__()
        self.rows = list(rows or [])
        self.row_factory = row_factory or (lambda row, _index: row)
        self.height = theme.sc(height) if height is not None else None
        self.max_height = theme.sc(max_height) if max_height else None
        self.reserve = theme.sc(reserve)
        self.gap = theme.sc(gap)
        self.padding = theme.sc(6)
        self._surface = None
        self._row_widgets = {}
        self._attached = set()
        self._row_layout = None
        self._scroll_y = 0
        self._scrollbar = None
        self._scrollbar_geometry = None
        self._drag_offset = 0

    def _attach(self, scene, parent=None):
        super()._attach(scene, parent)
        self._surface = _RoundSurface(
            self, theme.sc(8), theme.MANTLE, theme.CARD_BORDER)
        # Canvas tag_bind rejects <MouseWheel>; the Scene's canvas-level
        # wheel handler routes here when the pointer is over this list.
        scene._wheel_widgets.append(self)
        self.canvas.tag_bind(self.tag + "_scrollbar", "<Button-1>",
                             self._start_drag)
        self.canvas.tag_bind(self.tag + "_scrollbar", "<B1-Motion>",
                             self._drag)

    def _backdrop_for_child(self, _child):
        return theme.MANTLE

    def measure(self, avail_w):
        return avail_w, self._resolved_height()

    def _resolved_height(self):
        if self.height is not None:
            return self.height
        available = max(theme.sc(108), self.scene._viewport_height - self.reserve)
        return min(available, self.max_height or available)

    def _measure(self, avail_w):
        if (self.height is None and self._measure_result is not None
                and self._measure_result[1] != self._resolved_height()):
            self._measure_width = None
            self._measure_result = None
        return super()._measure(avail_w)

    def _row(self, index):
        row = self._row_widgets.get(index)
        if row is None:
            row = self.row_factory(self.rows[index], index)
            self._row_widgets[index] = row
        return row

    def _measure_rows(self, width):
        key = (width, len(self.rows))
        if self._row_layout is not None and self._row_layout[0] == key:
            return self._row_layout[1], self._row_layout[2]
        heights = [self._row(index)._measure(width)[1]
                   for index in range(len(self.rows))]
        offsets = []
        top = 0
        for height in heights:
            offsets.append(top)
            top += height + self.gap
        total = max(0, top - self.gap)
        self._row_layout = (key, (offsets, heights), total)
        return (offsets, heights), total

    def _ensure_scrollbar(self):
        if self._scrollbar:
            return
        tag = self.tag + "_scrollbar"
        self._scrollbar = (
            self.canvas.create_oval(
                0, 0, 0, 0, width=0, fill=theme.SURFACE1,
                tags=(self.tag, tag)),
            self.canvas.create_rectangle(
                0, 0, 0, 0, width=0, fill=theme.SURFACE1,
                tags=(self.tag, tag)),
            self.canvas.create_oval(
                0, 0, 0, 0, width=0, fill=theme.SURFACE1,
                tags=(self.tag, tag)),
        )
        self._items.extend(self._scrollbar)

    def layout(self, x, y, w):
        geometry = (round(x), round(y), round(w), self._resolved_height())
        geometry_changed = geometry != self._geometry
        self._geometry = geometry
        self._surface.layout(*geometry)
        self._layout_rows(geometry_changed)

    def _layout_rows(self, _geometry_changed=False):
        x, y, w, height = self._geometry
        inner_x = x + self.padding
        inner_y = y + max(1, theme.sc(1))
        inner_w = max(1, w - self.padding * 2 - theme.sc(8))
        viewport_h = max(1, height - max(2, theme.sc(2)))
        (offsets, heights), total = self._measure_rows(inner_w)
        maximum = max(0, total - viewport_h)
        self._scroll_y = max(0, min(self._scroll_y, maximum))
        visible = {
            index for index, (top, row_h) in enumerate(zip(offsets, heights))
            if ((top >= self._scroll_y
                 and top + row_h <= self._scroll_y + viewport_h)
                or (row_h > viewport_h
                    and top + row_h >= self._scroll_y
                    and top <= self._scroll_y + viewport_h))
        }
        for index in self._attached - visible:
            self._row_widgets.pop(index).destroy()
        self._attached.intersection_update(visible)
        if self.scene:
            self.scene._focusables = [widget for widget in self.scene._focusables
                                      if widget.scene is self.scene]
        for index in sorted(visible):
            row = self._row(index)
            if index not in self._attached:
                row._attach(self.scene, self)
                self._attached.add(index)
            row.layout(
                inner_x, inner_y + offsets[index] - self._scroll_y, inner_w)
            tags = row.list_tags() if hasattr(row, "list_tags") else (row.tag,)
            for tag in tags:
                self.canvas.addtag_withtag(self.tag, tag)
        self._layout_scrollbar(x, y, w, height, total, viewport_h)

    def _layout_scrollbar(self, x, y, w, height, total, viewport_h):
        self._ensure_scrollbar()
        if total <= viewport_h:
            for item in self._scrollbar:
                self.scene._itemconfigure(item, state="hidden")
            return
        for item in self._scrollbar:
            self.scene._itemconfigure(item, state="normal")
            self.canvas.tag_raise(item)
        width = theme.sc(5)
        inset = theme.sc(5)
        track = max(1, height - inset * 2)
        thumb_h = max(theme.sc(24), track * viewport_h / total)
        maximum = max(1, total - viewport_h)
        top = y + inset + (track - thumb_h) * self._scroll_y / maximum
        left = x + w - inset - width
        radius = width / 2
        geometry = (left, top, width, thumb_h)
        if geometry != self._scrollbar_geometry:
            self.scene._coords(
                self._scrollbar[0], left, top, left + width, top + width)
            self.scene._coords(
                self._scrollbar[1], left, top + radius,
                left + width, top + thumb_h - radius)
            self.scene._coords(
                self._scrollbar[2], left, top + thumb_h - width,
                left + width, top + thumb_h)
            self._scrollbar_geometry = geometry

    def _on_wheel(self, event):
        if not self._geometry:
            return "break"
        direction = -1 if event.delta > 0 else 1
        self._scroll_y += direction * theme.sc(72)
        self._layout_rows()
        return "break"

    def _start_drag(self, event):
        if not self._scrollbar_geometry:
            return "break"
        pointer = self.canvas.canvasy(event.y)
        self._drag_offset = pointer - self._scrollbar_geometry[1]
        return "break"

    def _drag(self, event):
        if not self._geometry or not self._scrollbar_geometry:
            return "break"
        x, y, w, height = self._geometry
        inner_w = max(1, w - self.padding * 2 - theme.sc(8))
        (_offsets, _heights), total = self._measure_rows(inner_w)
        viewport_h = max(1, height - max(2, theme.sc(2)))
        inset = theme.sc(5)
        track = max(1, height - inset * 2)
        thumb_h = self._scrollbar_geometry[3]
        travel = max(1, track - thumb_h)
        pointer = self.canvas.canvasy(event.y)
        fraction = (pointer - self._drag_offset - y - inset) / travel
        self._scroll_y = max(0, min(1, fraction)) * max(0, total - viewport_h)
        self._layout_rows()
        return "break"

    def set_rows(self, rows, row_factory=None, reset_scroll=True):
        for index in tuple(self._attached):
            self._row_widgets[index].destroy()
        self.rows = list(rows)
        if row_factory is not None:
            self.row_factory = row_factory
        self._row_widgets = {}
        self._attached.clear()
        self._row_layout = None
        if reset_scroll:
            self._scroll_y = 0
        if self.scene and self._geometry:
            self._layout_rows()

    def destroy(self):
        for index in tuple(self._attached):
            self._row_widgets[index].destroy()
        self._attached.clear()
        self._row_widgets.clear()
        if self._surface:
            self._surface.destroy()
        super().destroy()


class Scene:
    """Own one Canvas, its retained widget tree, focus, editing and scrolling."""

    def __init__(self, canvas, root=None, padding=22):
        self.canvas = canvas
        self.root = None
        self.backdrop = theme.BASE
        self.padding = theme.sc(padding)
        self._next_tag = 1
        self._focusables = []
        self.focused = None
        self.editing = None
        self.popup = None
        self._entry = None
        self._text = None
        self._editor_item = None
        self._cancel_edit = False
        self._layout_width = None
        self._layout_dirty = True
        self._measured_height = 0
        self._item_coords = {}
        self._item_options = {}
        self._content_height = 0
        self._viewport_height = 0
        self._scrollbar = None
        self._scrollbar_geometry = None
        self._scrollbar_visible = None
        self._scrollregion = None
        self._scroll_callback = None
        self._layout_commands = None
        self._focus_owner = type("_FocusOwner", (), {})()
        self._focus_owner.canvas = canvas
        self._focus_owner.tag = "focus_ring"
        self._focus_owner.scene = self
        self._focus_surfaces = {}
        self._shown_focus = None
        self._wheel_widgets = []
        self.canvas.configure(
            bg=theme.BASE, highlightthickness=0, bd=0,
            yscrollcommand=self._on_yview, takefocus=1)
        self.canvas.bind("<Configure>", self._on_configure, add="+")
        self.canvas.bind("<MouseWheel>", self._on_wheel, add="+")
        self.canvas.bind("<Tab>", self._tab, add="+")
        self.canvas.bind("<Shift-Tab>", self._shift_tab, add="+")
        self.canvas.bind("<Key>", self._key, add="+")
        if root is not None:
            self.set_root(root)

    def _new_tag(self):
        tag = f"w{self._next_tag}"
        self._next_tag += 1
        return tag

    def set_root(self, root):
        self.end_edit(commit=True)
        self.close_popup()
        if self.root is not None:
            self.root.destroy()
        self.root = root
        self._focusables = []
        self.focused = None
        self._wheel_widgets = []
        root._attach(self)
        self._layout_width = None
        self._layout_dirty = True
        self.relayout()

    def set_scroll_view(self, height_of_viewport):
        self._viewport_height = max(1, int(height_of_viewport))
        self._update_scrollregion()

    def relayout(self, width=None):
        if self.root is None:
            return 0
        self._layout_commands = []
        try:
            force = width is None
            width = int(width or self.canvas.winfo_width())
            viewport = max(1, self.canvas.winfo_height())
            viewport_changed = viewport != self._viewport_height
            self._viewport_height = viewport
            if viewport_changed and self.root is not None:
                self.root._measure_width = None
                self.root._measure_result = None
                # Height-sensitive widgets (ListView, About's centering)
                # must re-flow on pure vertical resizes too.
                self._layout_dirty = True
            content_changed = False
            if force or self._layout_dirty or width != self._layout_width:
                inner_w = max(1, width - self.padding * 2)
                measured_h = self.root._measure(inner_w)[1]
                self.root.layout(self.padding, self.padding, inner_w)
                self._content_height = measured_h + self.padding * 2
                self._measured_height = measured_h
                self._layout_width = width
                self._layout_dirty = False
                content_changed = True
            if viewport_changed or content_changed:
                self._update_scrollregion(width)
            if self.editing:
                self._position_editor()
        finally:
            self._flush_layout()
        return self._measured_height

    def _coords(self, item, *values):
        values = tuple(values)
        if self._item_coords.get(item) == values:
            return
        self._item_coords[item] = values
        if self._layout_commands is None:
            self.canvas.coords(item, *values)
        else:
            self._layout_commands.append(("coords", item, values))

    def _itemconfigure(self, item, **options):
        applied = self._item_options.setdefault(item, {})
        options = {name: value for name, value in options.items()
                   if applied.get(name) != value}
        if not options:
            return
        applied.update(options)
        if self._layout_commands is None:
            self.canvas.itemconfigure(item, **options)
        else:
            self._layout_commands.append(("configure", item, options))

    def _flush_layout(self):
        commands, self._layout_commands = self._layout_commands, None
        if not commands:
            return
        if not hasattr(self.canvas, "tk") or not hasattr(self.canvas, "_w"):
            for kind, item, values in commands:
                if kind == "coords":
                    self.canvas.coords(item, *values)
                else:
                    self.canvas.itemconfigure(item, **values)
            return
        path = self.canvas._w
        lines = []
        for kind, item, values in commands:
            if kind == "coords":
                numbers = " ".join(format(value, ".12g") for value in values)
                lines.append(f"{path} coords {item} {numbers}")
            else:
                words = []
                for name, value in values.items():
                    if isinstance(value, (int, float)):
                        word = format(value, ".12g")
                    else:
                        # Backslash-escape into a single Tcl word —
                        # arbitrary strings (user text) must survive
                        # the eval batching untouched.
                        word = str(value).translate(_TCL_WORD) or "{}"
                    words.append(f"-{name} {word}")
                lines.append(
                    f"{path} itemconfigure {item} {' '.join(words)}")
        self.canvas.tk.call("eval", "\n".join(lines))

    def _on_configure(self, event):
        self.relayout(event.width)

    def _update_scrollregion(self, width=None):
        height = max(self._viewport_height, self._content_height)
        width = max(1, int(width or self.canvas.winfo_width()))
        region = (0, 0, width, height)
        if region != self._scrollregion:
            self.canvas.configure(scrollregion=region)
            self._scrollregion = region
        self._update_scrollbar(canvas_width=width)

    def _on_wheel(self, event):
        self.end_edit(commit=True)
        self.close_popup()
        x = self.canvas.canvasx(event.x)
        y = self.canvas.canvasy(event.y)
        for widget in self._wheel_widgets:
            geometry = widget._geometry
            if geometry and geometry[0] <= x <= geometry[0] + geometry[2] \
                    and geometry[1] <= y <= geometry[1] + geometry[3]:
                return widget._on_wheel(event)
        amount = -1 if event.delta > 0 else 1
        self.canvas.yview_scroll(amount * 3, "units")
        return "break"

    def scroll_to(self, fraction):
        self.end_edit(commit=True)
        self.close_popup()
        self.canvas.yview_moveto(max(0.0, min(1.0, float(fraction))))

    def _on_yview(self, first, last):
        if self._scroll_callback:
            self._scroll_callback(first, last)
        self._update_scrollbar(float(first), float(last))

    def _ensure_scrollbar(self):
        if self._scrollbar:
            return
        self._scrollbar = (
            self.canvas.create_oval(0, 0, 0, 0, width=0, fill=theme.SURFACE1, tags=("scrollbar",)),
            self.canvas.create_rectangle(0, 0, 0, 0, width=0, fill=theme.SURFACE1, tags=("scrollbar",)),
            self.canvas.create_oval(0, 0, 0, 0, width=0, fill=theme.SURFACE1, tags=("scrollbar",)),
        )

    def _update_scrollbar(self, first=None, last=None, canvas_width=None):
        self._ensure_scrollbar()
        if first is None or last is None:
            values = self.canvas.yview()
            first, last = float(values[0]), float(values[1])
        if last - first >= 0.999:
            if self._scrollbar_visible is not False:
                for item in self._scrollbar:
                    self.canvas.itemconfigure(item, state="hidden")
                self._scrollbar_visible = False
            return
        if self._scrollbar_visible is not True:
            for item in self._scrollbar:
                self.canvas.itemconfigure(item, state="normal")
                self.canvas.tag_raise(item)
            self._scrollbar_visible = True
        width = theme.sc(5)
        radius = width / 2
        inset = theme.sc(5)
        viewport = max(1, self._viewport_height)
        top_view = self.canvas.canvasy(0)
        track = max(1, viewport - inset * 2)
        thumb_h = max(theme.sc(24), track * (last - first))
        travel = max(0, track - thumb_h)
        denominator = max(0.0001, 1 - (last - first))
        top = top_view + inset + travel * first / denominator
        canvas_width = canvas_width or self.canvas.winfo_width()
        left = canvas_width - inset - width
        geometry = (left, top, width, thumb_h)
        if geometry != self._scrollbar_geometry:
            self._coords(self._scrollbar[0], left, top, left + width, top + width)
            self._coords(self._scrollbar[1], left, top + radius,
                         left + width, top + thumb_h - radius)
            self._coords(self._scrollbar[2], left, top + thumb_h - width,
                         left + width, top + thumb_h)
            self._scrollbar_geometry = geometry

    def focus_widget(self, widget):
        if widget is self.focused:
            return
        if self.focused:
            self.focused.focus(False)
        self.focused = widget
        if widget:
            widget.focus(True)

    def _focus_surface(self, radius):
        backdrop = self.focused.backdrop if self.focused else self.backdrop
        key = (radius, backdrop)
        surface = self._focus_surfaces.get(key)
        if surface is None:
            surface = _RoundSurface(
                self._focus_owner, radius, theme.ACCENT, None,
                max(1, theme.sc(1)), backdrop)
            surface._create()
            surface.set_visible(False)
            self._focus_surfaces[key] = surface
        return surface

    def _show_focus_ring(self, widget):
        if not widget._geometry or widget._focus_radius is None:
            return
        if self._shown_focus is not None and self._shown_focus is not widget:
            old = self._focus_surfaces.get(
                (self._shown_focus._focus_radius,
                 self._shown_focus.backdrop))
            if old:
                old.set_visible(False)
        surface = self._focus_surface(widget._focus_radius)
        x, y, w, h = widget._geometry
        pad = theme.sc(2)
        surface.layout(x - pad, y - pad, w + pad * 2, h + pad * 2)
        surface.set_visible(True)
        for item in surface.items:
            self._itemconfigure(item, state="disabled")
            if self._shown_focus is not widget:
                self.canvas.tag_lower(item, widget.tag)
        self._shown_focus = widget

    def _hide_focus_ring(self, widget):
        if self._shown_focus is not widget:
            return
        surface = self._focus_surfaces.get(
            (widget._focus_radius, widget.backdrop))
        if surface:
            surface.set_visible(False)
        self._shown_focus = None

    def _tab(self, _event=None, reverse=False):
        if not self._focusables:
            return "break"
        try:
            index = self._focusables.index(self.focused)
        except ValueError:
            index = -1 if not reverse else 0
        index = (index + (-1 if reverse else 1)) % len(self._focusables)
        self.focus_widget(self._focusables[index])
        return "break"

    def _shift_tab(self, event=None):
        return self._tab(event, True)

    def _key(self, event):
        if event.keysym == "Escape":
            if self.popup:
                self.close_popup()
            elif self.editing:
                self.end_edit(commit=False)
            return "break"
        if self.focused and self.focused.key(event.keysym):
            return "break"
        return None

    def begin_edit(self, field):
        if self.editing is field:
            return
        self.end_edit(commit=True)
        self.close_popup()
        self.editing = field
        self.focus_widget(field)
        widget = self._shared_editor(field.multiline)
        value = str(field.getter() or "")
        if field.multiline:
            widget.delete("1.0", "end")
            widget.insert("1.0", value)
            widget.tag_add("sel", "1.0", "end-1c")
        else:
            widget.configure(show="•" if field.secret else "")
            widget.delete(0, "end")
            widget.insert(0, value)
            widget.select_range(0, "end")
        self._editor_item = self.canvas.create_window(
            0, 0, anchor="nw", window=widget, tags=("edit_overlay",))
        self._position_editor()
        widget.focus_set()

    def _shared_editor(self, multiline):
        if multiline:
            if self._text is None:
                self._text = tk.Text(
                    self.canvas, bg=theme.SURFACE0, fg=theme.TEXT,
                    insertbackground=theme.TEXT, selectbackground=theme.ACCENT,
                    selectforeground=theme.INK, font=FONT, relief="flat",
                    bd=0, highlightthickness=0, wrap="word")
                self._bind_editor(self._text, multiline=True)
            return self._text
        if self._entry is None:
            self._entry = tk.Entry(
                self.canvas, bg=theme.SURFACE0, fg=theme.TEXT,
                insertbackground=theme.TEXT, selectbackground=theme.ACCENT,
                selectforeground=theme.INK, font=FONT, relief="flat",
                bd=0, highlightthickness=0)
            self._bind_editor(self._entry, multiline=False)
        return self._entry

    def _bind_editor(self, widget, multiline):
        widget.bind("<FocusOut>", lambda _e: widget.after_idle(self._commit_if_editor))
        widget.bind("<Escape>", lambda _e: self._finish_editor(False))
        widget.bind("<Tab>", lambda _e: self._finish_editor_tab(False))
        widget.bind("<Shift-Tab>", lambda _e: self._finish_editor_tab(True))
        if not multiline:
            widget.bind("<Return>", lambda _e: self._finish_editor(True))

    def _finish_editor(self, commit):
        field = self.editing
        self.end_edit(commit=commit)
        if commit and field is not None and field.on_enter is not None:
            field.on_enter()
        return "break"

    def _finish_editor_tab(self, reverse):
        self.end_edit(commit=True)
        self._tab(reverse=reverse)
        return "break"

    def _commit_if_editor(self):
        if self.editing is not None:
            self.end_edit(commit=True)

    def _position_editor(self):
        if not self.editing or self._editor_item is None:
            return
        x, y, w, h = self.editing._geometry
        inset = max(1, theme.sc(1))
        self._coords(self._editor_item, x + inset, y + inset)
        self._itemconfigure(
            self._editor_item, width=max(1, w - inset * 2),
            height=max(1, h - inset * 2))

    def end_edit(self, commit=True):
        field = self.editing
        if field is None:
            return
        widget = self._text if field.multiline else self._entry
        self.editing = None
        if commit:
            value = widget.get("1.0", "end-1c") if field.multiline else widget.get()
            field.setter(value)
        if self._editor_item is not None:
            self.canvas.delete(self._editor_item)
            self._editor_item = None
        field.refresh()
        self.canvas.focus_set()

    def close_popup(self):
        popup = self.popup
        if popup:
            popup.close_popup()

    def destroy(self):
        self.end_edit(commit=True)
        self.close_popup()
        if self.root:
            self.root.destroy()
            self.root = None
        if self._entry:
            self._entry.destroy()
        if self._text:
            self._text.destroy()
        for surface in self._focus_surfaces.values():
            surface.destroy()
        self._focus_surfaces.clear()


def style_toplevel(win, icon_path=None):
    """Apply Undertone's dark frame and exact-size Windows icons."""
    try:
        win.update_idletasks()
        user32 = ctypes.WinDLL("user32")
        dwmapi = ctypes.WinDLL("dwmapi")
        get_ancestor = user32.GetAncestor
        get_ancestor.argtypes = (wintypes.HWND, wintypes.UINT)
        get_ancestor.restype = wintypes.HWND
        set_attribute = dwmapi.DwmSetWindowAttribute
        set_attribute.argtypes = (
            wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD)
        set_attribute.restype = ctypes.c_long
        hwnd = get_ancestor(wintypes.HWND(win.winfo_id()), 2)
        value = ctypes.c_int(1)
        for attribute in (20, 19):
            if set_attribute(
                    hwnd, attribute, ctypes.byref(value), ctypes.sizeof(value)) == 0:
                break
        if icon_path:
            IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON = 1, 0x10, 0x80
            get_metric = user32.GetSystemMetrics
            get_metric.argtypes = (ctypes.c_int,)
            get_metric.restype = ctypes.c_int
            load_image = user32.LoadImageW
            load_image.argtypes = (
                wintypes.HINSTANCE, wintypes.LPCWSTR, wintypes.UINT,
                ctypes.c_int, ctypes.c_int, wintypes.UINT)
            load_image.restype = wintypes.HANDLE
            send_message = user32.SendMessageW
            send_message.argtypes = (
                wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
            send_message.restype = ctypes.c_ssize_t
            for which, metric in ((0, 49), (1, 11)):
                size = get_metric(metric)
                handle = load_image(
                    None, str(icon_path), IMAGE_ICON, size, size, LR_LOADFROMFILE)
                if handle:
                    send_message(hwnd, WM_SETICON, which, handle)
    except Exception:
        pass
