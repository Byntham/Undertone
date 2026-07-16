"""Behavior checks for the Qt settings window (plain asserts, offscreen).

Covers the autosave contract (every change -> on_save with the merged
config + toast), dictionary add/remove, key save + status, history
expand and add-correction jump, onboarding gate, and geometry-on-close.
Run: .venv\\Scripts\\python.exe spikes\\qt_settings_behavior.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from PySide6.QtWidgets import QApplication

import config

app = QApplication(sys.argv); app.setStyle("Fusion")

saves = []
cfg = dict(config.DEFAULT_CONFIG)
cfg.update({"api_key": "sk-test-1234", "onboarded": True,
            "vocabulary": ["Undertone"], "corrections": {"grok": "Grok"}})

from settingsqt import SettingsWindow

window = SettingsWindow(
    cfg, saves.append,
    history_getter=lambda: [
        {"ts": time.time(), "ok": True, "text": "Hello world.",
         "raw": "hello world"},
        {"ts": time.time() - 60, "ok": False, "error": "boom", "wav": b"x"},
    ],
    on_retry=lambda _wav: None,
    config_getter=lambda: dict(cfg, **(saves[-1] if saves else {})))
window.open()
app.processEvents()

# Get started must be hidden: onboarded with a key.
assert "Get started" not in window._nav_items, "onboarded hides Get started"

# --- General: toggle autosaves the merged config -------------------------------
window._select_section("General")
app.processEvents()
window._apply(smart_formatting=False)
assert saves[-1]["smart_formatting"] is False
assert saves[-1]["api_key"] == "sk-test-1234", "merge keeps other keys"
assert window._saved_label.text() == "✓ Saved", "toast flashes"

# Shortcut chip shows the pretty combo.
assert window._shortcut_rows["hotkey"]["chip"].text() == "Right Ctrl"

# --- Dictionary: add + remove ---------------------------------------------------
window._select_section("Dictionary")
app.processEvents()
window._vocab_entry.setText("Kubernetes")
window._add_vocab()
assert saves[-1]["vocabulary"] == ["Undertone", "Kubernetes"]
window._remove_vocab("Undertone")
assert saves[-1]["vocabulary"] == ["Kubernetes"]
window._corr_heard_entry.setText("cloud code")
window._corr_right_entry.setText("Claude Code")
window._add_correction()
assert saves[-1]["corrections"] == {"grok": "Grok",
                                    "cloud code": "Claude Code"}

# --- History: rows render, expand toggles, add-correction jumps ---------------
window._select_section("History")
app.processEvents()
rows = window._hist_column.count() - 1  # minus stretch
assert rows == 2, f"two history rows, got {rows}"
ts = window._hist_snapshot()[0]["ts"]
window._hist_toggle(ts)
assert window._hist_expanded_ts == ts
window._hist_add_correction("hello world")
assert window._active_section == "Dictionary"
assert window._corr_heard_entry.text() == "hello world"

# --- Providers: key save + status, model override ------------------------------
window._select_section("Providers")
app.processEvents()
window._key_entries["openai_api_key"].setText("sk-new-key-5678")
window._save_provider_key("openai_api_key")
assert saves[-1]["openai_api_key"] == "sk-new-key-5678"
assert "5678" in window._key_status_blocks["openai_api_key"].text()
window._providers_advanced = True
window._select_section("Providers")
app.processEvents()
window._model_entries["stt"].setText("whisper-large")
window._save_model("stt")
assert saves[-1]["stt_models"] == {"xai": "whisper-large"}
assert "grok" in window._model_hints["stt"].text().lower() or \
    "default" in window._model_hints["stt"].text()

# --- Close: geometry persisted --------------------------------------------------
window._win.close()
app.processEvents()
assert "window_geometry" in saves[-1]
assert window._win is None

# --- Onboarding gate: fresh config shows Get started, Finish removes it -------
saves2 = []
fresh = dict(config.DEFAULT_CONFIG)
window2 = SettingsWindow(fresh, saves2.append)
window2.open()
app.processEvents()
assert "Get started" in window2._nav_items
assert window2._active_section == "Get started"
window2._finish_onboarding()
assert saves2[-1]["onboarded"] is True
assert "Get started" not in window2._nav_items
assert window2._active_section == "General"
window2._win.close()
app.processEvents()

print("ALL BEHAVIOR CHECKS PASSED")
