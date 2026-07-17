"""Speech-to-text transcription for Undertone.

Providers: xAI (native /v1/stt with keyterm biasing), OpenAI (multipart
/v1/audio/transcriptions), OpenRouter (JSON base64 path), and Local
(keyless, POSTs to the on-device whisper.cpp server managed by
localstt.py). transcribe() dispatches via PROVIDERS; an empty model means
the provider's default.

Vocabulary biasing is xAI-only (structured `keyterm` fields). Prompt-based
biasing for the other providers was removed 2026-07-17: whisper-style
models condition on the prompt as prior transcript and echoed mangled term
lists into transcripts on marginal audio, regardless of prompt wording —
don't reintroduce. Those providers get dictionary support downstream
(corrections regex + AI cleanup).
"""

import base64
import json

import requests

import localstt

# Empty model = the provider decides (xAI's endpoint has no model field).
DEFAULT_STT_MODELS = {
    "xai": "",
    "openai": "gpt-4o-mini-transcribe",
    # Not whisper-large-v3-turbo: it has no no-speech rejection and
    # hallucinates fragments on silent audio (field-tested 2026-07).
    "openrouter": "openai/gpt-4o-mini-transcribe",
    # Local runs the same turbo model safely: whisper-server's Silero VAD
    # returns empty text on silence. The "model" is a ggml filename.
    "local": localstt.MODEL_FILENAME,
}

_TIMEOUT = (10, 120)


class TranscriptionError(Exception):
    """Carries a user-friendly message describing what went wrong."""


def _check_response(resp, provider: str) -> None:
    """Map HTTP failures to friendly TranscriptionErrors (raises)."""
    if resp.status_code == 200:
        return
    if resp.status_code in (401, 403):
        raise TranscriptionError(
            f"Invalid {provider} API key. Check it in Settings → Providers.")
    if resp.status_code == 429:
        raise TranscriptionError(
            f"Rate limited by {provider} — wait a moment and try again.")
    if resp.status_code == 413:
        raise TranscriptionError(
            f"Recording too large for the {provider} API.")
    snippet = resp.text[:200]
    raise TranscriptionError(
        f"{provider} API error (HTTP {resp.status_code}): {snippet}")


def _post(url: str, provider: str, **kwargs) -> dict:
    try:
        resp = requests.post(url, timeout=_TIMEOUT, **kwargs)
    except requests.RequestException as exc:
        raise TranscriptionError(
            f"Could not reach the {provider} API. Check your internet "
            "connection and try again.") from exc
    _check_response(resp, provider)
    try:
        return resp.json()
    except ValueError as exc:
        raise TranscriptionError(
            f"{provider} API returned an unexpected (non-JSON) response."
        ) from exc


def transcribe_xai(wav_bytes: bytes, api_key: str, language: str = "en",
                   vocabulary: list = None, model: str = "") -> str:
    """xAI /v1/stt; vocabulary terms become `keyterm` recognition hints."""
    data = [("language", language), ("format", "true")]
    for term in (vocabulary or [])[:100]:
        term = str(term).strip()[:50]
        if term:
            data.append(("keyterm", term))
    try:
        resp = requests.post(
            "https://api.x.ai/v1/stt",
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            timeout=_TIMEOUT,
        )
    except requests.RequestException as exc:
        raise TranscriptionError(
            "Could not reach the xAI API. Check your internet connection "
            "and try again.") from exc
    if resp.status_code == 400 and "Incorrect API key" in resp.text:
        raise TranscriptionError(
            "Invalid xAI API key. Check it in Settings → Providers.")
    _check_response(resp, "xAI")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise TranscriptionError(
            "xAI API returned an unexpected (non-JSON) response.") from exc
    return payload.get("text", "").strip()


def transcribe_openai(wav_bytes: bytes, api_key: str, language: str = "en",
                      vocabulary: list = None, model: str = "") -> str:
    """OpenAI /v1/audio/transcriptions (multipart, OpenAI-style)."""
    data = {"model": model or DEFAULT_STT_MODELS["openai"],
            "language": language}
    payload = _post(
        "https://api.openai.com/v1/audio/transcriptions", "OpenAI",
        headers={"Authorization": f"Bearer {api_key}"},
        data=data,
        files={"file": ("audio.wav", wav_bytes, "audio/wav")},
    )
    return payload.get("text", "").strip()


def transcribe_openrouter(wav_bytes: bytes, api_key: str,
                          language: str = "en", vocabulary: list = None,
                          model: str = "") -> str:
    """OpenRouter /api/v1/audio/transcriptions via the base64 JSON path."""
    body = {
        "model": model or DEFAULT_STT_MODELS["openrouter"],
        "input_audio": {
            "data": base64.b64encode(wav_bytes).decode("ascii"),
            "format": "wav",
        },
        "language": language,
    }
    payload = _post(
        "https://openrouter.ai/api/v1/audio/transcriptions", "OpenRouter",
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        data=json.dumps(body),
    )
    return payload.get("text", "").strip()


def transcribe_local(wav_bytes: bytes, api_key: str, language: str = "en",
                     vocabulary: list = None, model: str = "") -> str:
    """On-device whisper.cpp server (localstt.py); keyless."""
    try:
        base_url = localstt.ensure_ready(model)
    except localstt.LocalSTTError as exc:
        raise TranscriptionError(str(exc)) from exc
    data = {"response_format": "json", "language": language}
    try:
        resp = requests.post(
            f"{base_url}/inference",
            data=data,
            files={"file": ("audio.wav", wav_bytes, "audio/wav")},
            timeout=(3, 120),  # loopback; generous read for the CPU build
        )
    except requests.RequestException as exc:
        raise TranscriptionError(
            "The local transcription engine stopped responding — try "
            "Eject then Load in Settings → Providers.") from exc
    _check_response(resp, "Local")
    try:
        payload = resp.json()
    except ValueError as exc:
        raise TranscriptionError(
            "The local transcription engine returned an unexpected "
            "(non-JSON) response.") from exc
    # whisper-server embeds newlines mid-sentence; collapse to plain text.
    return " ".join(payload.get("text", "").split())


PROVIDERS = {
    "xai": transcribe_xai,
    "openai": transcribe_openai,
    "openrouter": transcribe_openrouter,
    "local": transcribe_local,
}


def transcribe(wav_bytes: bytes, api_key: str, language: str = "en",
               vocabulary: list = None, provider: str = "xai",
               model: str = "") -> str:
    """Transcribe WAV audio bytes, returning the recognized text.

    vocabulary is an optional list of terms the model should recognize —
    only xAI uses it (keyterm hints); other providers ignore it.
    Raises TranscriptionError with a friendly message on any failure.
    """
    fn = PROVIDERS.get(provider)
    if fn is None:
        # A corrupted/hand-edited config must fail loudly, not silently
        # send audio to a provider the user never chose.
        raise TranscriptionError(
            f"Unknown transcription provider {provider!r} in the config. "
            "Pick a provider in Settings → Providers.")
    if provider != "local":  # local runs on this machine, keyless
        api_key = (api_key or "").strip()
        if not api_key:
            raise TranscriptionError(
                "No API key configured for the transcription provider. "
                "Open Settings → Providers and enter one.")
    return fn(wav_bytes, api_key, language, vocabulary, model)
