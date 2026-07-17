"""Offline tests for localstt: manifest, extraction subset, download
verification, and the not-installed guard. No network, no server."""

import hashlib
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import localstt


def test_manifest_shape():
    for key in ("cpu_runtime", "cuda_runtime", "model", "vad_model"):
        spec = localstt.MANIFEST[key]
        assert spec["url"].startswith("https://")
        assert len(spec["sha256"]) == 64
        assert spec["size"] > 0
    assert localstt.MANIFEST["model"]["url"].endswith(localstt.MODEL_FILENAME)
    assert localstt.MANIFEST["vad_model"]["url"].endswith(
        localstt.VAD_FILENAME)
    # The VAD must come from whisper.cpp's own artifact repo (what the
    # project's models/download-vad-model.sh uses).
    assert "/ggml-org/whisper-vad/" in localstt.MANIFEST["vad_model"]["url"]


def test_extract_subset(tmp: Path):
    # A synthetic release zip: the server + DLLs must land flat in the
    # build dir; SDL2 and the demo exes must be left behind.
    tmp.mkdir(parents=True, exist_ok=True)
    zip_path = tmp / "release.zip"
    names = ["Release/whisper-server.exe", "Release/whisper.dll",
             "Release/ggml.dll", "Release/ggml-base.dll",
             "Release/ggml-cpu-haswell.dll", "Release/ggml-cpu-x64.dll",
             "Release/SDL2.dll", "Release/whisper-talk-llama.exe",
             "Release/main.exe"]
    with zipfile.ZipFile(zip_path, "w") as zf:
        for name in names:
            zf.writestr(name, b"x" * 10)

    old_runtime = localstt.RUNTIME_DIR
    localstt.RUNTIME_DIR = tmp / "runtime"
    try:
        fractions = []
        localstt._extract_subset(zip_path, "cpu", fractions.append)
        out = {p.name for p in (tmp / "runtime" / "cpu").iterdir()}
    finally:
        localstt.RUNTIME_DIR = old_runtime
    assert out == {"whisper-server.exe", "whisper.dll", "ggml.dll",
                   "ggml-base.dll", "ggml-cpu-haswell.dll",
                   "ggml-cpu-x64.dll"}
    assert fractions and fractions[-1] == 1.0


def test_download_verifies_sha256(tmp: Path):
    # Serve wrong bytes for a pinned artifact: the .part must be removed
    # and a LocalSTTError raised instead of installing a bad file.
    body = b"not the real model"

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def raise_for_status(self):
            pass

        def iter_content(self, chunk_size):
            yield body

    # The download machinery lives in localproc (shared with localllm).
    import localproc
    localproc.requests.get = lambda *a, **k: FakeResponse()
    dest = tmp / "model.bin"
    try:
        localstt._download("vad_model", dest, lambda f: None)
        raise AssertionError("should have raised")
    except localstt.LocalSTTError as e:
        assert "verification" in str(e)
    assert not dest.exists()
    assert not list(tmp.glob("*.part"))

    # And a correct digest passes: rewrite the pin to match the fake body.
    spec = dict(localstt.MANIFEST["vad_model"])
    spec["sha256"] = hashlib.sha256(body).hexdigest()
    spec["size"] = len(body)
    localstt.MANIFEST["fake"] = spec
    fractions = []
    localstt._download("fake", dest, fractions.append)
    assert dest.read_bytes() == body
    assert fractions[-1] == 1.0


def test_not_installed_guard(tmp: Path):
    old_models, old_runtime = localstt.MODELS_DIR, localstt.RUNTIME_DIR
    localstt.MODELS_DIR = tmp / "models"
    localstt.RUNTIME_DIR = tmp / "runtime"
    try:
        assert not localstt.is_installed()
        try:
            localstt.ensure_ready()
            raise AssertionError("should have raised")
        except localstt.LocalSTTError as e:
            assert "Providers" in str(e)
    finally:
        localstt.MODELS_DIR, localstt.RUNTIME_DIR = old_models, old_runtime


def test_nvidia_probe_is_safe():
    assert localstt.have_nvidia_gpu() in (True, False)


def test_install_size_counts_missing_only(tmp: Path):
    old_models, old_runtime = localstt.MODELS_DIR, localstt.RUNTIME_DIR
    localstt.MODELS_DIR = tmp / "models"
    localstt.RUNTIME_DIR = tmp / "runtime"
    try:
        full = localstt.install_size()
        assert full > localstt.MANIFEST["model"]["size"]
        localstt.MODELS_DIR.mkdir(parents=True)
        localstt.model_path().write_bytes(b"x")
        assert (localstt.install_size()
                == full - localstt.MANIFEST["model"]["size"])
        localstt.model_path(localstt.VAD_FILENAME).write_bytes(b"x")
        assert (localstt.install_size()
                == full - localstt.MANIFEST["model"]["size"]
                - localstt.MANIFEST["vad_model"]["size"])
    finally:
        localstt.MODELS_DIR, localstt.RUNTIME_DIR = old_models, old_runtime


class _FakeProc:
    def poll(self):
        return None

    def kill(self):
        pass

    def wait(self, timeout=None):
        pass


def test_idle_autoeject():
    # A fresh timer must not fire early…
    localstt._proc = _FakeProc()
    localstt._last_used = time.monotonic()
    localstt.set_idle_timeout(60)
    time.sleep(0.3)
    assert localstt.is_loaded(), "ejected before the idle timeout"
    # …and once the idle window has truly elapsed, it ejects.
    with localstt._LOCK:
        localstt._last_used = time.monotonic() - 61
        localstt.set_idle_timeout(60)  # re-arms with ~0.05s remaining
    for _ in range(100):
        if not localstt.is_loaded():
            break
        time.sleep(0.05)
    assert not localstt.is_loaded(), "idle eject never fired"
    assert localstt._idle_timer is None
    # 0 = never: cancels any pending timer.
    localstt._proc = _FakeProc()
    localstt.set_idle_timeout(60)
    assert localstt._idle_timer is not None
    localstt.set_idle_timeout(0)
    assert localstt._idle_timer is None
    localstt._proc = None


def main():
    with tempfile.TemporaryDirectory() as tmp:
        test_manifest_shape()
        test_extract_subset(Path(tmp) / "a")
        test_download_verifies_sha256(Path(tmp) / "b")
        test_not_installed_guard(Path(tmp) / "c")
        test_nvidia_probe_is_safe()
        test_install_size_counts_missing_only(Path(tmp) / "d")
        test_idle_autoeject()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
