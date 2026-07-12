"""Request-shape tests for the provider adapters (no network, no keys).

Monkeypatches requests.post in transcriber/cleanup and asserts each
provider sends the right URL, fields, and vocabulary-biasing mechanism.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import cleanup
import config
import transcriber


class FakeResponse:
    status_code = 200

    def __init__(self, payload):
        self._payload = payload
        self.text = json.dumps(payload)

    def json(self):
        return self._payload


def capture(module, payload):
    calls = []

    def fake_post(url, **kwargs):
        calls.append((url, kwargs))
        return FakeResponse(payload)

    module.requests.post = fake_post
    return calls


WAV = b"RIFF" + b"\x00" * 64
VOCAB = ["Undertone", "Kubernetes"]


def test_xai_shape():
    calls = capture(transcriber, {"text": "hi"})
    out = transcriber.transcribe(WAV, "k", "en", VOCAB, "xai")
    assert out == "hi"
    url, kw = calls[0]
    assert url == "https://api.x.ai/v1/stt"
    data = kw["data"]
    assert ("keyterm", "Undertone") in data and ("keyterm", "Kubernetes") in data
    assert ("format", "true") in data
    assert "files" in kw


def test_openai_shape():
    calls = capture(transcriber, {"text": "hi"})
    transcriber.transcribe(WAV, "k", "en", VOCAB, "openai")
    url, kw = calls[0]
    assert url == "https://api.openai.com/v1/audio/transcriptions"
    assert kw["data"]["model"] == transcriber.DEFAULT_STT_MODELS["openai"]
    assert kw["data"]["prompt"] == "Vocabulary: Undertone, Kubernetes"
    assert kw["data"]["language"] == "en"
    assert "files" in kw
    # Explicit model override wins.
    transcriber.transcribe(WAV, "k", "en", None, "openai", "whisper-1")
    assert calls[1][1]["data"]["model"] == "whisper-1"
    assert "prompt" not in calls[1][1]["data"]


def test_openrouter_shape():
    calls = capture(transcriber, {"text": "hi"})
    transcriber.transcribe(WAV, "k", "en", VOCAB, "openrouter")
    url, kw = calls[0]
    assert url == "https://openrouter.ai/api/v1/audio/transcriptions"
    body = json.loads(kw["data"])
    assert body["model"] == transcriber.DEFAULT_STT_MODELS["openrouter"]
    assert body["input_audio"]["format"] == "wav"
    import base64
    assert base64.b64decode(body["input_audio"]["data"]) == WAV
    # Vocabulary rides provider options (multipart `prompt` is ignored there).
    opts = body["provider"]["options"]
    assert opts["groq"]["prompt"] == "Vocabulary: Undertone, Kubernetes"
    assert opts["openai"]["prompt"] == "Vocabulary: Undertone, Kubernetes"


def test_missing_key_message():
    try:
        transcriber.transcribe(WAV, "  ", "en", None, "openai")
        raise AssertionError("should have raised")
    except transcriber.TranscriptionError as e:
        assert "Providers" in str(e)


def test_cleanup_endpoints():
    reply = {"choices": [{"message": {"content": json.dumps({"text": "ok"})}}]}
    calls = capture(cleanup, reply)
    for provider, url in cleanup.API_URLS.items():
        out = cleanup.cleanup("some words", None, "", {}, "k", "", provider)
        assert out == "ok"
        got_url, kw = calls[-1]
        assert got_url == url
        assert kw["json"]["model"] == cleanup.DEFAULT_CLEANUP_MODELS[provider]
    # Explicit model override wins.
    cleanup.cleanup("some words", None, "", {}, "k", "my-model", "openrouter")
    assert calls[-1][1]["json"]["model"] == "my-model"


def test_provider_key_mapping():
    cfg = {"api_key": "X", "openai_api_key": "O", "openrouter_api_key": "R"}
    assert config.provider_key(cfg, "xai") == "X"
    assert config.provider_key(cfg, "openai") == "O"
    assert config.provider_key(cfg, "openrouter") == "R"
    assert config.provider_key(cfg, "unknown") == "X"  # safe fallback


def main():
    test_xai_shape()
    test_openai_shape()
    test_openrouter_shape()
    test_missing_key_message()
    test_cleanup_endpoints()
    test_provider_key_mapping()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
