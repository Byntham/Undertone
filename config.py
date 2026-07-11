"""Configuration loading and saving for Undertone.

Stores a JSON config under %APPDATA%/Undertone/config.json, merging any
on-disk values over a set of defaults so new keys always have a value.
"""

import json
import os
import pathlib

APP_NAME = "Undertone"
LEGACY_APP_NAME = "PushToTalkSTT"
APP_VERSION = "1.0.0"

CONFIG_PATH: pathlib.Path = pathlib.Path(os.environ["APPDATA"]) / APP_NAME / "config.json"

DEFAULT_CONFIG = {
    "api_key": "",
    "hotkey": "right ctrl",
    "language": "en",
    "restore_clipboard": True,
    "sample_rate": 16000,
    "provider": "xai",
}


def _migrate_legacy_dir() -> None:
    """One-time rename of the old PushToTalkSTT config dir to Undertone."""
    old_dir = pathlib.Path(os.environ["APPDATA"]) / LEGACY_APP_NAME
    if old_dir.is_dir() and not CONFIG_PATH.parent.exists():
        try:
            old_dir.rename(CONFIG_PATH.parent)
        except OSError:
            pass


def load_config() -> dict:
    """Return DEFAULT_CONFIG merged with the on-disk config (file values win).

    Missing keys are filled from defaults. A missing or corrupt file yields
    the defaults. Ensures the config directory exists.
    """
    _migrate_legacy_dir()
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    cfg = dict(DEFAULT_CONFIG)
    try:
        # utf-8-sig tolerates a BOM (e.g. a config hand-edited in Notepad).
        with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            data = json.load(f)
        if isinstance(data, dict):
            cfg.update(data)
    except (FileNotFoundError, ValueError, OSError):
        pass
    return cfg


def save_config(cfg: dict) -> None:
    """Write cfg as pretty-printed JSON, creating the directory if needed."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
