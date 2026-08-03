"""Configuration loading and saving for Undertone.

Stores a JSON config under %APPDATA%/Undertone/config.json, merging any
on-disk values over a set of defaults so new keys always have a value.
"""

import base64
import ctypes
import json
import os
import pathlib
from ctypes import wintypes

APP_NAME = "Undertone"
LEGACY_APP_NAME = "PushToTalkSTT"
APP_VERSION = "1.4.0"

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
    "stt_vocab_hints": True,  # send dictionary terms to the STT model at all
    "toggle_hotkey": "",    # optional dedicated start/stop key ("" = disabled)
    "repaste_hotkey": "ctrl+alt+v",
    "local_loaded": False,       # load selected local models on startup
    "local_idle_minutes": 0,     # auto-eject after idle; 0 = never
                                 # (both keys drive STT and cleanup alike)
    "cleanup_timeout": 2.5,  # seconds before cleanup falls back (dev knob)
    "cleanup_prompt": "",    # cleanup system prompt override (dev knob;
                             # "" = the built-in cleanup.SYSTEM_PROMPT)
    "cleanup_prompts": {},   # named saves of the prompt (dev): {name: text}
    "dev_mode": False,   # About toggle: mirror log warnings/errors on the pill
}


# Which config field holds each provider's API key.
KEY_FIELDS = {
    "xai": "api_key",
    "openai": "openai_api_key",
    "openrouter": "openrouter_api_key",
}


# --- API keys are DPAPI-encrypted at rest ------------------------------------
# The config is plain JSON; keys alone are stored as "dpapi:<b64>" blobs
# bound to this Windows user (a key once leaked into a pushed commit).
# In memory they stay plaintext. Legacy plaintext values still load and
# are encrypted on the next save.

_DPAPI_PREFIX = "dpapi:"
_CRYPTPROTECT_UI_FORBIDDEN = 0x01

# Private DLL instances: prototypes/structures must never touch the shared
# ctypes.windll cache (see AGENTS.md).
_crypt32 = ctypes.WinDLL("crypt32")
_kernel32 = ctypes.WinDLL("kernel32")


class _DataBlob(ctypes.Structure):
    _fields_ = (("cbData", wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_byte)))


def _blob_take(blob: "_DataBlob") -> bytes:
    data = ctypes.string_at(blob.pbData, blob.cbData)
    _kernel32.LocalFree(blob.pbData)
    return data


def _as_blob(raw: bytes) -> "_DataBlob":
    buf = ctypes.create_string_buffer(raw, len(raw))
    return _DataBlob(len(raw), ctypes.cast(buf, ctypes.POINTER(ctypes.c_byte)))


def _protect_key(value: str) -> str:
    data_out = _DataBlob()
    ok = _crypt32.CryptProtectData(
        ctypes.byref(_as_blob(value.encode("utf-8"))), None, None, None,
        None, _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(data_out))
    if not ok:
        return value  # availability over secrecy: never lose the key
    return _DPAPI_PREFIX + base64.b64encode(_blob_take(data_out)).decode()


def _unprotect_key(value: str) -> str:
    if not value.startswith(_DPAPI_PREFIX):
        return value  # legacy plaintext; encrypted on the next save
    try:
        raw = base64.b64decode(value[len(_DPAPI_PREFIX):])
    except ValueError:
        return ""
    data_out = _DataBlob()
    ok = _crypt32.CryptUnprotectData(
        ctypes.byref(_as_blob(raw)), None, None, None, None,
        _CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(data_out))
    if not ok:
        return ""  # different user/machine: treat as no key
    return _blob_take(data_out).decode("utf-8", "replace")


def provider_key(cfg: dict, provider: str) -> str:
    """The stored API key for a provider ("" if none or keyless)."""
    field = KEY_FIELDS.get(provider)
    return cfg.get(field, "") if field else ""


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


def _fold_legacy_local(cfg: dict) -> None:
    """Fold the per-engine residency keys (local_stt_*/local_llm_*) into
    the unified local_loaded/local_idle_minutes pair (2026-07).

    Either engine warming on startup keeps warming; the STT idle window
    wins over the cleanup one when both were set (it predates)."""
    loaded = bool(cfg.pop("local_stt_loaded", False))
    loaded = bool(cfg.pop("local_llm_loaded", False)) or loaded
    stt_idle = cfg.pop("local_stt_idle_minutes", 0)
    llm_idle = cfg.pop("local_llm_idle_minutes", 0)
    if loaded and not cfg.get("local_loaded"):
        cfg["local_loaded"] = True
    if (stt_idle or llm_idle) and not cfg.get("local_idle_minutes"):
        cfg["local_idle_minutes"] = stt_idle or llm_idle


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
    _fold_legacy_local(cfg)
    for field in KEY_FIELDS.values():
        if isinstance(cfg.get(field), str):
            cfg[field] = _unprotect_key(cfg[field])
    return cfg


def save_config(cfg: dict) -> None:
    """Write cfg as pretty-printed JSON, creating the directory if needed.

    The JSON lands in a temp file and is swapped in with os.replace, so an
    interrupted save can't destroy the existing config."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    on_disk = dict(cfg)
    for field in KEY_FIELDS.values():
        value = on_disk.get(field)
        if isinstance(value, str) and value:
            on_disk[field] = _protect_key(value)
    tmp = CONFIG_PATH.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(on_disk, f, indent=2, sort_keys=True)
    os.replace(tmp, CONFIG_PATH)
