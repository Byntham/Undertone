"""Speech-to-text transcription for Undertone.

Currently targets the xAI STT API. transcribe() dispatches to a provider
function so additional providers can be added later.
"""

import requests


class TranscriptionError(Exception):
    """Carries a user-friendly message describing what went wrong."""


def transcribe_xai(wav_bytes: bytes, api_key: str, language: str = "en") -> str:
    """Transcribe WAV audio using the xAI STT API. Returns the text."""
    url = "https://api.x.ai/v1/stt"
    headers = {"Authorization": f"Bearer {api_key}"}
    data = [("language", language), ("format", "true")]
    files = {"file": ("audio.wav", wav_bytes, "audio/wav")}

    try:
        resp = requests.post(
            url,
            headers=headers,
            data=data,
            files=files,
            timeout=(10, 120),
        )
    except requests.RequestException as exc:
        raise TranscriptionError(
            "Could not reach xAI API. Check your internet connection and try again."
        ) from exc

    if resp.status_code in (401, 403) or (
        resp.status_code == 400 and "Incorrect API key" in resp.text
    ):
        raise TranscriptionError("Invalid API key. Check your xAI API key in Settings.")
    if resp.status_code == 429:
        raise TranscriptionError("Rate limited by xAI — wait a moment and try again.")
    if resp.status_code == 413:
        raise TranscriptionError("Recording too large for the xAI API (500 MB max).")
    if resp.status_code != 200:
        snippet = resp.text[:200]
        raise TranscriptionError(
            f"xAI API error (HTTP {resp.status_code}): {snippet}"
        )

    try:
        payload = resp.json()
    except ValueError as exc:
        raise TranscriptionError(
            "xAI API returned an unexpected (non-JSON) response."
        ) from exc

    return payload.get("text", "").strip()


PROVIDERS = {
    "xai": transcribe_xai,
}


def transcribe(wav_bytes: bytes, api_key: str, language: str = "en") -> str:
    """Transcribe WAV audio bytes, returning the recognized text.

    Raises TranscriptionError with a friendly message on any failure.
    """
    api_key = api_key.strip()
    if not api_key:
        raise TranscriptionError(
            "No API key configured. Open Settings and enter your xAI API key."
        )
    return transcribe_xai(wav_bytes, api_key, language)
