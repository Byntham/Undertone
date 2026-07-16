"""Perf gate for the Qt settings window: every section must relayout and
repaint under 18 ms/step (median) through a resize storm — the same
budget the canvas implementation was held to.

Run: .venv\\Scripts\\python.exe tests\\perf_settingsui.py
"""

import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication

import config

BUDGET_MS = 18.0

app = QApplication(sys.argv)
app.setStyle("Fusion")

cfg = dict(config.DEFAULT_CONFIG)
cfg.update({
    "api_key": "sk-test-1234", "onboarded": True,
    "vocabulary": [f"term {i}" for i in range(40)],
    "corrections": {f"heard {i}": f"right {i}" for i in range(40)},
})
HISTORY = [
    {"ts": time.time() - i * 60, "ok": i % 5 != 0,
     "text": f"History entry number {i} with a reasonably long preview "
             "line to exercise the elide path.",
     "raw": f"history entry number {i}",
     "error": "Transcription failed for this one.", "wav": b"x"}
    for i in range(20)
]

from settingsui import SettingsWindow

window = SettingsWindow(
    cfg, lambda _cfg: None,
    history_getter=lambda: list(HISTORY), on_retry=lambda _wav: None,
    config_getter=lambda: cfg)
window.open()
window._win.resize(780, 724)
app.processEvents()

failures = []
for section in ["General", "Dictionary", "History", "Providers", "About"]:
    window._select_section(section)
    app.processEvents()
    h = window._win.height()
    times = []
    widths = list(range(660, 1101, 20)) + list(range(1100, 659, -20))
    for w in widths:
        t0 = time.perf_counter()
        window._win.resize(w, h)
        window._win.repaint()
        app.processEvents()
        times.append((time.perf_counter() - t0) * 1000)
    median = statistics.median(times)
    worst = max(times)
    print(f"{section}: median {median:.3f} ms/step (max {worst:.3f})")
    if median >= BUDGET_MS:
        failures.append(f"{section}: median {median:.3f} >= {BUDGET_MS}")

window._win.close()
app.processEvents()

if failures:
    print("FAILED:", *failures, sep="\n  ")
    sys.exit(1)
print("ALL PERF GATES PASSED")
