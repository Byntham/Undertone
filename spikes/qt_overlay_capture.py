"""Capture the Qt overlay's six pill states for parity judgment against
spikes/out/ref_overlay (the Tk/layered-window originals).

Screen-grabs the pill's rect after DWM composites it, same as the
reference captures. Run: .venv\\Scripts\\python.exe spikes\\qt_overlay_capture.py
"""

import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import QApplication

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                   "out", "qt_overlay")

STATES = [
    ("qt_recording.png", lambda o: o.show_recording()),
    ("qt_locked.png", lambda o: o.show_recording(locked=True)),
    ("qt_transcribing.png", lambda o: o.show_transcribing()),
    ("qt_msg_plain.png", lambda o: o.show_message("Pasted · hello world…")),
    ("qt_msg_warn.png", lambda o: o.show_message(
        "Too short — hold the key while you speak", warn=True)),
    ("qt_msg_error.png", lambda o: o.show_message("No API key configured",
                                                  error=True)),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    app = QApplication(sys.argv)
    from overlay import Overlay
    overlay = Overlay(level_getter=lambda: 0.5 + 0.5 * math.sin(time.time() * 4))

    remaining = list(STATES)

    def step():
        if not remaining:
            app.quit()
            return
        name, action = remaining.pop(0)
        action(overlay)
        QTimer.singleShot(450, lambda: grab(name))  # fade + a few anim frames

    def grab(name):
        screen = QApplication.primaryScreen()
        g = overlay.frameGeometry()
        screen.grabWindow(0, g.x(), g.y(), g.width(), g.height()).save(
            os.path.join(OUT, name))
        print("captured", name, f"{g.width()}x{g.height()}")
        step()

    QTimer.singleShot(300, step)
    app.exec()


if __name__ == "__main__":
    main()
