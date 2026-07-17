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
    assert kw["data"]["prompt"] == ("The following terms may be mentioned in the input: "
            "Undertone, Kubernetes")
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
    assert opts["groq"]["prompt"] == ("The following terms may be mentioned in the input: "
            "Undertone, Kubernetes")
    assert opts["openai"]["prompt"] == ("The following terms may be mentioned in the input: "
            "Undertone, Kubernetes")


def test_local_shape():
    calls = capture(transcriber, {"text": " hello\n world \n"})
    transcriber.localstt.ensure_ready = lambda name="": "http://127.0.0.1:9"
    # Empty key must NOT raise — local is keyless.
    out = transcriber.transcribe(WAV, "", "en", VOCAB, "local")
    assert out == "hello world"  # embedded newlines collapsed
    url, kw = calls[0]
    assert url == "http://127.0.0.1:9/inference"
    assert kw["data"]["response_format"] == "json"
    assert kw["data"]["language"] == "en"
    assert kw["data"]["prompt"] == ("The following terms may be mentioned in the input: "
            "Undertone, Kubernetes")
    assert "files" in kw
    # No vocabulary -> no prompt field.
    transcriber.transcribe(WAV, "", "en", None, "local")
    assert "prompt" not in calls[1][1]["data"]


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
    assert config.provider_key(cfg, "local") == ""    # keyless
    assert config.provider_key(cfg, "unknown") == ""  # no silent xAI fallback


def test_unknown_provider_fails_loudly():
    # STT: a corrupted provider id must raise, not silently call xAI.
    try:
        transcriber.transcribe(WAV, "k", "en", None, "grok9000")
        raise AssertionError("should have raised")
    except transcriber.TranscriptionError as e:
        assert "grok9000" in str(e)
    # Cleanup keeps its silent-fallback contract: skip without calling out.
    calls = capture(cleanup, {})
    assert cleanup.cleanup("words", None, "", {}, "k", "", "grok9000") is None
    assert not calls


def test_key_encryption_roundtrip():
    import pathlib
    import tempfile
    old_path = config.CONFIG_PATH
    with tempfile.TemporaryDirectory() as d:
        config.CONFIG_PATH = pathlib.Path(d) / "config.json"
        try:
            cfg = dict(config.DEFAULT_CONFIG)
            cfg["api_key"] = "sk-super-secret-123"
            config.save_config(cfg)
            text = config.CONFIG_PATH.read_text(encoding="utf-8")
            # The plaintext key must never touch the disk.
            assert "sk-super-secret-123" not in text
            assert "dpapi:" in text
            assert config.load_config()["api_key"] == "sk-super-secret-123"
            # In-memory cfg must stay plaintext (save must not mutate it).
            assert cfg["api_key"] == "sk-super-secret-123"
            # Legacy plaintext keys still load (encrypted on the next save).
            data = json.loads(text)
            data["api_key"] = "plain-legacy-key"
            config.CONFIG_PATH.write_text(json.dumps(data), encoding="utf-8")
            assert config.load_config()["api_key"] == "plain-legacy-key"
            # Garbage blobs mean "no key", not a crash or a garbage key.
            data["api_key"] = "dpapi:not-really-a-blob"
            config.CONFIG_PATH.write_text(json.dumps(data), encoding="utf-8")
            assert config.load_config()["api_key"] == ""
        finally:
            config.CONFIG_PATH = old_path


def test_legacy_model_fold():
    # The old shipped xAI default is NOT an override — it must vanish, or
    # switching cleanup provider sends a grok model id to OpenAI.
    cfg = {**config.DEFAULT_CONFIG, "stt_models": {}, "cleanup_models": {},
           "cleanup_model": config._LEGACY_XAI_CLEANUP, "stt_model": ""}
    config._fold_legacy_models(cfg)
    assert "cleanup_model" not in cfg and "stt_model" not in cfg
    assert cfg["cleanup_models"] == {}

    # A real user override folds under the provider it was set for.
    cfg = {**config.DEFAULT_CONFIG, "stt_models": {}, "cleanup_models": {},
           "provider": "openai", "stt_model": "whisper-1",
           "cleanup_provider": "openrouter", "cleanup_model": "meta/llama-x"}
    config._fold_legacy_models(cfg)
    assert cfg["stt_models"] == {"openai": "whisper-1"}
    assert cfg["cleanup_models"] == {"openrouter": "meta/llama-x"}

    assert config.model_override(cfg, "stt", "openai") == "whisper-1"
    assert config.model_override(cfg, "stt", "xai") == ""


def main():
    test_xai_shape()
    test_openai_shape()
    test_openrouter_shape()
    test_local_shape()
    test_missing_key_message()
    test_cleanup_endpoints()
    test_provider_key_mapping()
    test_unknown_provider_fails_loudly()
    test_key_encryption_roundtrip()
    test_legacy_model_fold()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
