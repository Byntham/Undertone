"""Visual smoke demo for canvasui.py.

Run with: .venv\Scripts\python.exe tests\demo_canvasui.py OUTPUT_DIR
"""

import os
import pathlib
import sys
import tkinter as tk

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PIL import ImageGrab  # noqa: E402

import canvasui  # noqa: E402
import theme  # noqa: E402


def _draw_sidebar(canvas):
    canvas.create_text(
        theme.sc(18), theme.sc(28), anchor="w", text="Undertone",
        fill=theme.TEXT, font=("Segoe UI Semibold", 12))
    names = ("General", "Dictionary", "History", "Providers", "About")
    top = theme.sc(76)
    row_h = theme.sc(40)
    canvas.create_rectangle(
        0, top, theme.sc(190), top + row_h, width=0, fill=theme.NAV_HOVER)
    canvas.create_rectangle(
        0, top, theme.sc(3), top + row_h, width=0, fill=theme.ACCENT)
    for index, name in enumerate(names):
        canvas.create_text(
            theme.sc(22), top + index * row_h + row_h / 2,
            anchor="w", text=name,
            fill=theme.TEXT if index == 0 else theme.SUBTEXT,
            font=("Segoe UI Semibold", 10) if index == 0 else ("Segoe UI", 10))


def build_demo_pane(root):
    """Build the same 12-card pane used by the perf gate."""
    root.title("Undertone — Canvas UI")
    root.configure(bg=theme.BASE)
    root.minsize(theme.sc(660), theme.sc(560))

    sidebar = tk.Canvas(
        root, width=theme.sc(190), bg=theme.MANTLE,
        highlightthickness=0, bd=0)
    sidebar.pack(side="left", fill="y")
    sidebar.pack_propagate(False)
    _draw_sidebar(sidebar)

    content = tk.Canvas(root, bg=theme.BASE, highlightthickness=0, bd=0)
    content.pack(side="left", fill="both", expand=True)

    values = {
        "name": "F13",
        "language": "English",
        "microphone": "System default",
        "key": "",
    }

    def getter(key):
        return lambda: values[key]

    def setter(key):
        return lambda value: values.__setitem__(key, value)

    button = canvasui.PillButton("Test microphone", "neutral", lambda: None)
    field = canvasui.EntryField(getter("name"), setter("name"), "Press a shortcut")
    language = canvasui.DropdownButton(
        ("English", "Spanish", "French", "German"),
        getter("language"), setter("language"))
    microphone = canvasui.DropdownButton(
        ("System default", "USB microphone", "Webcam microphone"),
        getter("microphone"), setter("microphone"))
    api_key = canvasui.EntryField(
        getter("key"), setter("key"), "Paste API key", secret=True)

    rows = (
        canvasui.Row(
            "Push-to-talk shortcut",
            "Hold this global shortcut while speaking, then release to paste.",
            field),
        canvasui.Row(
            "Hands-free mode",
            "Double-tap the shortcut to keep recording until the next tap.",
            canvasui.Toggle(True, lambda _on: None)),
        canvasui.Row(
            "Spoken language",
            "Choose the language sent to the transcription provider.",
            language),
        canvasui.Row(
            "Microphone",
            "Stored by device name so Windows host API indexes may change safely.",
            microphone),
        canvasui.Row(
            "Microphone check",
            "Listen for a short sample before starting a dictation.",
            button),
        canvasui.Row(
            "Smart formatting",
            "Use caret context to decide spacing and sentence capitalization.",
            canvasui.Toggle(True, lambda _on: None)),
        canvasui.Row(
            "AI cleanup",
            "Remove fillers and false starts; nearby context may be sent to the provider.",
            canvasui.Toggle(False, lambda _on: None)),
        canvasui.Row(
            "Launch at sign in",
            "Start Undertone automatically for the current Windows account.",
            canvasui.Toggle(True, lambda _on: None)),
        canvasui.Row(
            "Transcription provider",
            "Select the speech-to-text service independently from cleanup.",
            canvasui.DropdownButton(
                ("xAI", "OpenAI", "OpenRouter"), lambda: "xAI", lambda _value: None)),
        canvasui.Row(
            "xAI API key",
            "Keys remain in your local Undertone configuration file.",
            api_key),
        canvasui.Row(
            "Re-paste shortcut",
            "Paste the newest history entry when focus restoration was blocked.",
            canvasui.EntryField(lambda: "Ctrl + Alt + V", lambda _value: None)),
        canvasui.Row(
            "Clear local history",
            "Remove saved transcript previews and failed-audio recovery entries.",
            canvasui.PillButton("Clear history", "danger", lambda: None)),
    )
    cards = [canvasui.Card(row) for row in rows]
    pane = canvasui.VStack([
        canvasui.TextBlock("General", ("Segoe UI Semibold", 15), wrap=False),
        canvasui.TextBlock(
            "Dictation behavior, shortcuts, and startup settings.",
            ("Segoe UI", 9), theme.SUBTEXT),
        canvasui.Spacer(4),
        *cards,
    ], gap=9)
    scene = canvasui.Scene(content, pane, padding=22)
    return {
        "scene": scene,
        "content": content,
        "button": button,
        "field": field,
        "values": values,
    }


def _capture(root, path):
    root.update_idletasks()
    root.update()
    x, y = root.winfo_rootx(), root.winfo_rooty()
    bbox = (x, y, x + root.winfo_width(), y + root.winfo_height())
    try:
        image = ImageGrab.grab(bbox=bbox)
    except OSError:
        # Windows.Graphics.Capture sandboxes can deny desktop-wide grabs while
        # still allowing the same ImageGrab backend to capture our own HWND.
        image = ImageGrab.grab(window=root.winfo_id())
    image.save(path)


def main(output_dir):
    theme.init_dpi()
    output = pathlib.Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    root = tk.Tk()
    root.geometry(
        f"{theme.sc(780)}x{theme.sc(724)}+{theme.sc(80)}+{theme.sc(60)}")
    demo = build_demo_pane(root)
    root.update()
    canvasui.style_toplevel(
        root, pathlib.Path(__file__).resolve().parent.parent / "assets" / "icon.ico")

    _capture(root, output / "default.png")
    demo["button"].hover(True)
    _capture(root, output / "hover.png")
    demo["button"].hover(False)
    demo["field"].activate()
    _capture(root, output / "editing.png")
    demo["scene"].scroll_to(0.65)
    _capture(root, output / "scrolled.png")

    root.after(2000, root.destroy)
    root.mainloop()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: demo_canvasui.py OUTPUT_DIR")
    main(sys.argv[1])
