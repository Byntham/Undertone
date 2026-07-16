"""Capture the Qt settings window's sections for parity judgment against
spikes/out/ref_settings (the canvas originals).

Mirrors the reference harness: real config with api keys redacted to
sk-test-1234, onboarded=True, fake history (2 ok + 1 failure), no-op
callbacks. Saves qt_<section>.png at 900x760 plus qt_general_min.png at
660x560. Run: .venv\\Scripts\\python.exe spikes\\qt_settings_capture.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

import config

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "out", "qt_settings")

cfg = config.load_config()
for field in ("api_key", "openai_api_key", "openrouter_api_key"):
    if cfg.get(field):
        cfg[field] = "sk-test-1234"
cfg["onboarded"] = True
cfg.pop("window_geometry", None)

HISTORY = [
    {"ts": time.time() - 60, "ok": True,
     "text": "This is a recent dictation with enough words to need "
             "truncation in the preview line of the history row.",
     "raw": "this is a recent dictation with enough words"},
    {"ts": time.time() - 300, "ok": True, "text": "Short one.", "raw": None},
    {"ts": time.time() - 600, "ok": False,
     "error": "The local transcription engine stopped responding."},
]


def main():
    os.makedirs(OUT, exist_ok=True)
    app = QApplication(sys.argv); app.setStyle("Fusion")
    from settingsqt import SettingsWindow
    window = SettingsWindow(
        cfg, lambda _cfg: None,
        on_capture_start=lambda: None, on_capture_end=lambda: None,
        history_getter=lambda: list(HISTORY), on_retry=lambda _wav: None,
        config_getter=lambda: cfg)
    window.open()
    window._win.resize(900, 760)

    sections = ["General", "Dictionary", "History", "Providers", "About"]
    remaining = list(sections)

    def step():
        if remaining:
            section = remaining.pop(0)
            window._select_section(section)
            QTimer.singleShot(350, lambda: grab(f"qt_{section.lower()}.png",
                                                step))
        else:
            window._select_section("General")
            window._win.resize(660, 560)
            QTimer.singleShot(350, lambda: grab("qt_general_min.png",
                                                app.quit))

    def grab(name, then):
        pixmap = window._win.grab()
        pixmap.save(os.path.join(OUT, name))
        print("captured", name, f"{pixmap.width()}x{pixmap.height()}")
        then()

    QTimer.singleShot(400, step)
    app.exec()


if __name__ == "__main__":
    main()
