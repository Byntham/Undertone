"""Speech-to-text transcription for Undertone.

Providers: xAI (native /v1/stt with keyterm biasing), OpenAI (multipart
/v1/audio/transcriptions with a vocabulary prompt), OpenRouter (JSON
base64 path so vocabulary can ride provider-specific options — its
multipart path accepts but ignores `prompt`), and Local (keyless, POSTs
to the on-device whisper.cpp server managed by localstt.py). transcribe()
dispatches via PROVIDERS; an empty model means the provider's default.
"""

import base64
import json
import logging
import re

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


def _vocab_prompt(vocabulary: list) -> "str | None":
    # Prose, not a "Vocabulary:" list header: whisper-style models condition
    # on this as prior transcript, and a labeled list invited list-shaped
    # echo (mangled term runs) at the start of marginal-audio transcripts.
    terms = [str(t).strip() for t in (vocabulary or []) if str(t).strip()]
    return ("The following terms may be mentioned in the input: "
            + ", ".join(terms[:100])) if terms else None


def _strip_prompt_echo(text: str, vocabulary: list) -> "str | None":
    """Remove an echoed vocabulary prompt from a transcript.

    STT models handed silence sometimes leak the biasing prompt verbatim,
    wrapped in OpenAI's server-side template ("context: ###\\n<prompt>
    \\n###"). Detection requires the EXACT prompt text — dictating ABOUT
    the vocabulary feature ("add Claude
    and Codex to the vocabulary") must never match. Returns the transcript
    with the echo and its scaffolding removed (may be empty), or None when
    no echo is present.
    """
    prompt = _vocab_prompt(vocabulary)
    if not prompt or not text:
        return None
    pattern = re.sub(r"\\\s", r"\\s+", re.escape(prompt))
    match = re.search(pattern, text, re.IGNORECASE)
    if match is None:
        return None
    cleaned = text[:match.start()] + text[match.end():]
    cleaned = re.sub(r"context:\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("#", " ")
    cleaned = " ".join(cleaned.split())
    # Punctuation/whitespace-only residue (e.g. a trailing "." from the
    # template) is not surviving speech — collapse it to a pure echo so
    # transcribe() raises loudly instead of pasting a stray period.
    return cleaned if re.search(r"\w", cleaned) else ""


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


def transcribe_local(wav_bytes: bytes, api_key: str, language: str = "en",
                     vocabulary: list = None, model: str = "") -> str:
    """On-device whisper.cpp server (localstt.py); keyless."""
    try:
        base_url = localstt.ensure_ready(model)
    except localstt.LocalSTTError as exc:
        raise TranscriptionError(str(exc)) from exc
    data = {"response_format": "json", "language": language}
    prompt = _vocab_prompt(vocabulary)
    if prompt:
        data["prompt"] = prompt
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

    vocabulary is an optional list of terms the model should recognize;
    each provider translates it into its own biasing mechanism.
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
    text = fn(wav_bytes, api_key, language, vocabulary, model)
    stripped = _strip_prompt_echo(text, vocabulary)
    if stripped is not None:
        if stripped:
            # Real speech survived alongside the echo: keep it, note it.
            logging.warning("STT leaked the vocabulary prompt into a "
                            "transcript; echo stripped (%d chars kept)",
                            len(stripped))
            return stripped
        # Loud on purpose: a pure echo means the model returned our
        # vocabulary hint instead of speech — worth investigating, not a
        # silent no-op. Raising keeps the WAV in history for retries.
        raise TranscriptionError(
            "STT echoed the vocabulary hint instead of transcribing — "
            "likely silence + a model without no-speech rejection.")
    return text
