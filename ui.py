"""Imagery and constants shared by main.py and the settings window.

The settings window itself lives in settingsui.py (Qt); this module keeps
the Pillow-drawn icons and nav glyphs (supersampled 4x for crisp edges)
and the provider/language/section tables both consume.
"""

import pathlib

from PIL import Image, ImageDraw


from theme import BASE, RED, TEXT



LANGUAGES = [
    ("English", "en"), ("Arabic", "ar"), ("Chinese", "zh"), ("Danish", "da"),
    ("Dutch", "nl"), ("Finnish", "fi"), ("French", "fr"), ("German", "de"),
    ("Hindi", "hi"), ("Italian", "it"), ("Japanese", "ja"), ("Korean", "ko"),
    ("Norwegian", "no"), ("Polish", "pl"), ("Portuguese", "pt"),
    ("Russian", "ru"), ("Spanish", "es"), ("Swedish", "sv"),
    ("Turkish", "tr"), ("Ukrainian", "uk"),
]

PROVIDERS_UI = [("xAI", "xai"), ("OpenAI", "openai"), ("OpenRouter", "openrouter")]
# STT additionally offers the on-device engine; cleanup stays cloud-only
# (there is no local cleanup adapter), so the lists are separate.
STT_PROVIDERS_UI = PROVIDERS_UI + [("Local", "local")]
PROVIDER_BY_ID = {pid: name for name, pid in STT_PROVIDERS_UI}
# provider id -> the config key holding that provider's API key.
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


def make_recording_tray_image(size: int = 64) -> Image.Image:
    """The app icon tinted toward red — shown in the tray while recording."""
    base = load_app_image(size)
    tint = Image.new("RGBA", base.size, _rgb(RED) + (0,))
    # ~35% red, masked by the icon's own alpha so the corners stay clear.
    tint.putalpha(base.getchannel("A").point(lambda a: a * 90 // 255))
    return Image.alpha_composite(base, tint)












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

