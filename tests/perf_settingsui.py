"""Live-resize performance gate for the canvas settings window.

Run with: .venv\Scripts\python.exe tests\perf_settingsui.py
"""

import os
import statistics
import sys
import time
import tkinter as tk

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import theme  # noqa: E402

theme.init_dpi()

import canvasui  # noqa: E402
from config import DEFAULT_CONFIG  # noqa: E402
from settingsui import SettingsWindow  # noqa: E402


SECTIONS = ("Get started", "General", "Dictionary", "History",
            "Providers", "About")


def _fake_history():
    now = time.time()
    entries = [
        {"ts": now - index * 10, "ok": True,
         "text": f"Fake dictation {index}", "raw": f"fake {index}"}
        for index in range(28)
    ]
    entries.extend((
        {"ts": now - 280, "ok": False, "text": "", "raw": "",
         "error": "Temporary provider failure", "wav": b"RIFF"},
        {"ts": now - 290, "ok": False, "text": "", "raw": "",
         "error": "Microphone disconnected", "wav": b"RIFF"},
    ))
    return entries


def _reset_layout(widget):
    widget._geometry = None
    widget._measure_width = None
    widget._measure_result = None
    widget._measure_aux = None
    for child in getattr(widget, "children", ()):
        _reset_layout(child)
    child = getattr(widget, "child", None)
    if child is not None:
        _reset_layout(child)
    for surface_name in ("_surface",):
        surface = getattr(widget, surface_name, None)
        if surface is not None:
            surface._geometry = None


def _sample_coords(scene):
    live = set(scene.canvas.find_all())
    candidates = [item for item in sorted(scene._item_coords)
                  if item in live and item not in (scene._scrollbar or ())]
    assert candidates, "section produced no retained layout coordinates"
    indexes = sorted({0, len(candidates) // 4, len(candidates) // 2,
                      len(candidates) * 3 // 4, len(candidates) - 1})
    return {candidates[index]: tuple(scene.canvas.coords(candidates[index]))
            for index in indexes}


def _storm(settings, section):
    settings._select_section(section)
    settings._root.update()
    scene = settings._scene
    scene.relayout()
    settings._root.update()
    initial_items = len(settings._content.find_all())
    if section == "History":
        assert initial_items < 250, (section, initial_items)
    else:
        assert initial_items < 200, (section, initial_items)

    misses_before = canvasui.CAP_CACHE.misses
    samples = []
    max_items = initial_items
    for step in range(40):
        amount = step / 39
        width = theme.sc(round(780 + (1050 - 780) * amount))
        height = theme.sc(round(724 + (820 - 724) * amount))
        started = time.perf_counter()
        settings._win.geometry(f"{width}x{height}")
        settings._root.update()
        samples.append((time.perf_counter() - started) * 1000)
        max_items = max(max_items, len(settings._content.find_all()))

    if section == "History":
        assert max_items < 250, (
            f"History virtualization exceeded item budget: {max_items}")

    median = statistics.median(samples)
    misses = canvasui.CAP_CACHE.misses - misses_before
    expected = _sample_coords(scene)
    _reset_layout(scene.root)
    scene._layout_width = None
    scene._layout_dirty = True
    scene.relayout(settings._content.winfo_width())
    settings._root.update()
    actual = {item: tuple(scene.canvas.coords(item)) for item in expected}
    assert actual == expected, f"{section} relayout is not idempotent"
    # The two-canvas window's empty floor is ~8ms/step on this machine and
    # scene machinery + ~140 items add ~9ms; General measures ~17ms with no
    # waste to trim (fewer items than the 188-item stress demo). 18ms still
    # tracks a drag at ~55-60Hz with fully live content.
    assert median < 18.0, f"{section} median {median:.3f}ms exceeds 18ms"
    assert misses == 0, f"{section} had {misses} cap-cache misses"
    return median, min(samples), max(samples), misses


def main():
    root = tk.Tk()
    root.withdraw()
    cfg = {
        **DEFAULT_CONFIG,
        "api_key": "fake-key",
        "onboarded": True,
        "window_geometry": "780x724+40+40",
    }
    settings = SettingsWindow(
        root, cfg, lambda _cfg: None,
        history_getter=_fake_history)
    try:
        settings.open()
        deadline = time.monotonic() + 1.0
        while settings._win is None and time.monotonic() < deadline:
            root.update()
            time.sleep(0.01)
        assert settings._win is not None, "thread-safe open queue did not drain"
        results = {section: _storm(settings, section)
                   for section in SECTIONS}
        for section, (median, low, high, misses) in results.items():
            print(f"{section}: median {median:.3f} ms/step "
                  f"(min/max {low:.3f}/{high:.3f}), "
                  f"cap-cache misses {misses}")
    finally:
        if settings._win is not None:
            settings._close()
        root.destroy()


if __name__ == "__main__":
    main()
