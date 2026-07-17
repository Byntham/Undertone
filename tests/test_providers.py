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
# Vocabulary biasing is xAI-only (keyterm fields). The other providers
# must NOT receive the terms in any form — prompt biasing echoed term
# lists into transcripts and was removed 2026-07-17.


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
    assert "prompt" not in kw["data"]  # vocabulary must not reach OpenAI
    assert kw["data"]["language"] == "en"
    assert "files" in kw
    # Explicit model override wins.
    transcriber.transcribe(WAV, "k", "en", None, "openai", "whisper-1")
    assert calls[1][1]["data"]["model"] == "whisper-1"


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
    assert "provider" not in body  # vocabulary must not reach OpenRouter


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
    assert "prompt" not in kw["data"]  # vocabulary must not reach local
    assert "files" in kw


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
    # The dev-mode prompt override replaces the system message; "" = default.
    assert (calls[-1][1]["json"]["messages"][0]["content"]
            == cleanup.SYSTEM_PROMPT)
    cleanup.cleanup("some words", None, "", {}, "k", "", "xai",
                    system_prompt="Be terse.")
    assert calls[-1][1]["json"]["messages"][0]["content"] == "Be terse."


def test_cleanup_local_shape():
    reply = {"choices": [{"message": {"content": json.dumps({"text": "ok"})}}]}
    calls = capture(cleanup, reply)
    old_base_url = cleanup.localllm.base_url
    old_load_async = cleanup.localllm.load_async
    warmed = []
    try:
        cleanup.localllm.base_url = lambda name="": "http://127.0.0.1:9"
        cleanup.localllm.load_async = warmed.append
        # Empty key must work — local is keyless and sends no auth header.
        out = cleanup.cleanup("some words", None, "", {}, "", "", "local")
        assert out == "ok"
        url, kw = calls[0]
        assert url == "http://127.0.0.1:9/v1/chat/completions"
        assert kw["headers"] == {}
        assert kw["json"]["model"] == cleanup.DEFAULT_CLEANUP_MODELS["local"]
        assert kw["json"]["temperature"] == 0
        assert kw["json"]["response_format"]["type"] == "json_schema"
        assert not warmed  # resident server: no warm-up needed
        # Ejected model: the pass is skipped without any request (cleanup
        # must never block a dictation on a model load) and the model is
        # warmed in the background for the next dictation.
        cleanup.localllm.base_url = lambda name="": None
        assert cleanup.cleanup("some words", None, "", {},
                               "", "my.gguf", "local") is None
        assert len(calls) == 1
        assert warmed == ["my.gguf"]
    finally:
        cleanup.localllm.base_url = old_base_url
        cleanup.localllm.load_async = old_load_async


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


def test_legacy_local_fold():
    # Per-engine residency keys fold into the unified pair: either engine
    # warming on startup keeps warming; STT's idle window wins when both
    # were set (it predates); the legacy keys vanish.
    cfg = {**config.DEFAULT_CONFIG, "local_stt_loaded": False,
           "local_llm_loaded": True, "local_stt_idle_minutes": 60,
           "local_llm_idle_minutes": 15}
    config._fold_legacy_local(cfg)
    assert cfg["local_loaded"] is True
    assert cfg["local_idle_minutes"] == 60
    for key in ("local_stt_loaded", "local_llm_loaded",
                "local_stt_idle_minutes", "local_llm_idle_minutes"):
        assert key not in cfg

    # STT "never" + a cleanup window: the nonzero window carries over.
    cfg = {**config.DEFAULT_CONFIG, "local_stt_idle_minutes": 0,
           "local_llm_idle_minutes": 30}
    config._fold_legacy_local(cfg)
    assert cfg["local_idle_minutes"] == 30

    # Already-unified values win over stragglers; no legacy keys = no-op.
    cfg = {**config.DEFAULT_CONFIG, "local_loaded": True,
           "local_idle_minutes": 5, "local_stt_idle_minutes": 60}
    config._fold_legacy_local(cfg)
    assert cfg["local_loaded"] is True and cfg["local_idle_minutes"] == 5
    cfg = dict(config.DEFAULT_CONFIG)
    config._fold_legacy_local(cfg)
    assert cfg["local_loaded"] is False and cfg["local_idle_minutes"] == 0


def main():
    test_xai_shape()
    test_openai_shape()
    test_openrouter_shape()
    test_local_shape()
    test_missing_key_message()
    test_cleanup_endpoints()
    test_cleanup_local_shape()
    test_provider_key_mapping()
    test_unknown_provider_fails_loudly()
    test_key_encryption_roundtrip()
    test_legacy_model_fold()
    test_legacy_local_fold()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
