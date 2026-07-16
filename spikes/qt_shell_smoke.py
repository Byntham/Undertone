"""Smoke test for the Qt shell (Phase 2): boots the real App with a
neutralized config (f13 hotkey, no extra hotkeys — must not collide with
a live Undertone instance), drives the overlay through its states, and
quits. Prints SMOKE OK on a clean run.

Run: .venv\\Scripts\\python.exe spikes\\qt_shell_smoke.py
"""

import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
logging.basicConfig(level=logging.INFO)

import config

_cfg = config.load_config()
_cfg.update({"hotkey": "f13", "toggle_hotkey": "", "repaste_hotkey": "",
             "sound_cues": False, "local_stt_loaded": False,
             "onboarded": True})
config.load_config = lambda: dict(_cfg)
config.save_config = lambda cfg: None   # never touch the real config

import main
from PySide6.QtCore import QTimer

app = main.App()
errors = []
sys.excepthook = lambda et, e, tb: (errors.append(e), logging.error(
    "Uncaught", exc_info=(et, e, tb)))

QTimer.singleShot(1000, lambda: app.overlay.show_recording())
QTimer.singleShot(1800, lambda: app.overlay.show_recording(locked=True))
QTimer.singleShot(2600, lambda: app.overlay.show_transcribing())
QTimer.singleShot(3400, lambda: app.overlay.show_message("Smoke · pill OK"))
QTimer.singleShot(4200, lambda: app.overlay.hide())
QTimer.singleShot(4600, lambda: app._set_tray_icon(app._tray_img_recording))
QTimer.singleShot(5000, lambda: app._set_tray_icon(app._tray_img))
QTimer.singleShot(5600, app._quit)
app.run()

print("SMOKE FAILED:" if errors else "SMOKE OK",
      *[repr(e) for e in errors])
sys.exit(1 if errors else 0)
