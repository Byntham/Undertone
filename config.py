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
    "api_key": "",              # xAI key (name kept for config back-compat)
    "openai_api_key": "",
    "openrouter_api_key": "",
    "hotkey": "right ctrl",
    "language": "en",
    "restore_clipboard": True,
    "sample_rate": 16000,
    "input_device": "",         # microphone NAME ("" = system default);
                                # stored by name — indices shift across replugs
    "onboarded": False,         # guided first-run setup completed
    "provider": "xai",          # STT provider: xai | openai | openrouter | local
    "stt_models": {},           # per-provider overrides; missing = default
    "smart_formatting": True,
    "ai_cleanup": True,
    "cleanup_provider": "xai",
    "cleanup_models": {},       # per-provider overrides; missing = default
    "sound_cues": True,
    "vocabulary": [],       # terms sent to the STT API as recognition hints
    "corrections": {},      # {"heard": "replacement"} applied after transcription
    "toggle_hotkey": "",    # optional dedicated start/stop key ("" = disabled)
    "repaste_hotkey": "ctrl+alt+v",
    "local_stt_loaded": False,  # Load/Eject intent for the local model —
                                # only the Settings buttons flip this
}


# Which config field holds each provider's API key.
KEY_FIELDS = {
    "xai": "api_key",
    "openai": "openai_api_key",
    "openrouter": "openrouter_api_key",
}


def provider_key(cfg: dict, provider: str) -> str:
    """The stored API key for a provider ("" if none)."""
    return cfg.get(KEY_FIELDS.get(provider, "api_key"), "")


def model_override(cfg: dict, kind: str, provider: str) -> str:
    """The user's model override for kind "stt"/"cleanup" ("" = default)."""
    return (cfg.get(kind + "_models") or {}).get(provider, "")


# The cleanup model that used to ship as a literal default — finding it in a
# legacy flat field means "no override", not a user choice.
_LEGACY_XAI_CLEANUP = "grok-4.20-0309-non-reasoning"


def _fold_legacy_models(cfg: dict) -> None:
    """Fold pre-multi-provider flat stt_model/cleanup_model into the
    per-provider dicts and drop the flat keys.

    A single global model field broke as soon as the provider changed (an
    xAI model id would be sent to OpenAI verbatim), hence the dicts.
    """
    stt = cfg.pop("stt_model", "")
    cleanup = cfg.pop("cleanup_model", "")
    if stt:
        cfg["stt_models"].setdefault(cfg.get("provider", "xai"), stt)
    if cleanup and cleanup != _LEGACY_XAI_CLEANUP:
        cfg["cleanup_models"].setdefault(
            cfg.get("cleanup_provider", "xai"), cleanup)


def _migrate_legacy_dir() -> None:
    """One-time move of old PushToTalkSTT settings into the Undertone dir.

    The Undertone dir may already exist without a config (logging creates
    it first), so a lone legacy config.json is moved over individually.
    """
    old_dir = pathlib.Path(os.environ["APPDATA"]) / LEGACY_APP_NAME
    if not old_dir.is_dir():
        return
    try:
        if not CONFIG_PATH.parent.exists():
            old_dir.rename(CONFIG_PATH.parent)
        elif not CONFIG_PATH.exists() and (old_dir / "config.json").is_file():
            (old_dir / "config.json").rename(CONFIG_PATH)
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
    # Never hand out DEFAULT_CONFIG's own container objects (a shallow copy
    # shares them; in-place mutation would pollute the defaults).
    for key, value in cfg.items():
        if isinstance(value, (dict, list)):
            cfg[key] = type(value)(value)
    _fold_legacy_models(cfg)
    return cfg


def save_config(cfg: dict) -> None:
    """Write cfg as pretty-printed JSON, creating the directory if needed."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, sort_keys=True)
