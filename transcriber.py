"""Speech-to-text transcription for Undertone.

Providers: xAI (native /v1/stt with keyterm biasing), OpenAI (multipart
/v1/audio/transcriptions with a vocabulary prompt), and OpenRouter (JSON
base64 path so vocabulary can ride provider-specific options — its
multipart path accepts but ignores `prompt`). transcribe() dispatches via
PROVIDERS; an empty model means the provider's default.
"""

import base64
import json

import requests

# Empty model = the provider decides (xAI's endpoint has no model field).
DEFAULT_STT_MODELS = {
    "xai": "",
    "openai": "gpt-4o-mini-transcribe",
    # Not whisper-large-v3-turbo: it has no no-speech rejection and
    # hallucinates fragments on silent audio (field-tested 2026-07).
    "openrouter": "openai/gpt-4o-mini-transcribe",
}

_TIMEOUT = (10, 120)


class TranscriptionError(Exception):
    """Carries a user-friendly message describing what went wrong."""


def _vocab_prompt(vocabulary: list) -> "str | None":
    terms = [str(t).strip() for t in (vocabulary or []) if str(t).strip()]
    return ("Vocabulary: " + ", ".join(terms[:100])) if terms else None


def _looks_like_prompt_echo(text: str, vocabulary: list) -> bool:
    """True when the model returned our vocabulary prompt instead of speech.

    Whisper-family models handed near-silence tend to continue the biasing
    prompt ("Context: Vocabulary: term1, term2, ..."). Dictating a single
    vocabulary term must NOT match — the scaffold word plus at least two
    configured terms are required.
    """
    lowered = " ".join(text.lower().split())
    if "vocabulary" not in lowered:
        return False
    terms = [str(t).strip().lower() for t in (vocabulary or [])
             if str(t).strip()]
    hits = sum(1 for t in terms if t in lowered)
    return hits >= 2


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
    prompt = _vocab_prompt(vocabulary)
    if prompt:
        data["prompt"] = prompt
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
    """OpenRouter /api/v1/audio/transcriptions via the base64 JSON path.

    The JSON path is used (not multipart) because vocabulary biasing only
    works through provider-specific options there — the multipart path
    accepts `prompt` but ignores it. Options are keyed by provider slug and
    forwarded only to whichever provider serves the request.
    """
    body = {
        "model": model or DEFAULT_STT_MODELS["openrouter"],
        "input_audio": {
            "data": base64.b64encode(wav_bytes).decode("ascii"),
            "format": "wav",
        },
        "language": language,
    }
    prompt = _vocab_prompt(vocabulary)
    if prompt:
        body["provider"] = {"options": {
            "openai": {"prompt": prompt},
            "groq": {"prompt": prompt},
        }}
    payload = _post(
        "https://openrouter.ai/api/v1/audio/transcriptions", "OpenRouter",
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": "application/json"},
        data=json.dumps(body),
    )
    return payload.get("text", "").strip()


PROVIDERS = {
    "xai": transcribe_xai,
    "openai": transcribe_openai,
    "openrouter": transcribe_openrouter,
}


def transcribe(wav_bytes: bytes, api_key: str, language: str = "en",
               vocabulary: list = None, provider: str = "xai",
               model: str = "") -> str:
    """Transcribe WAV audio bytes, returning the recognized text.

    vocabulary is an optional list of terms the model should recognize;
    each provider translates it into its own biasing mechanism.
    Raises TranscriptionError with a friendly message on any failure.
    """
    api_key = api_key.strip()
    if not api_key:
        raise TranscriptionError(
            "No API key configured for the transcription provider. Open "
            "Settings → Providers and enter one.")
    fn = PROVIDERS.get(provider, transcribe_xai)
    text = fn(wav_bytes, api_key, language, vocabulary, model)
    if text and _looks_like_prompt_echo(text, vocabulary):
        # Loud on purpose: an echo means the STT model returned our
        # vocabulary hint instead of speech — a prompt/model-handling
        # problem worth investigating, not a silent no-op. Raising also
        # keeps the WAV in history (retry against another model).
        raise TranscriptionError(
            "STT echoed the vocabulary hint instead of transcribing — "
            "likely silence + a model without no-speech rejection.")
    return text
