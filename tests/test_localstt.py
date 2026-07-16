"""Offline tests for localstt: manifest, extraction subset, download
verification, and the not-installed guard. No network, no server."""

import hashlib
import os
import sys
import tempfile
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

    localstt.requests.get = lambda *a, **k: FakeResponse()
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
    assert localstt.install_size() > localstt.MANIFEST["model"]["size"]


def main():
    with tempfile.TemporaryDirectory() as tmp:
        test_manifest_shape()
        test_extract_subset(Path(tmp) / "a")
        test_download_verifies_sha256(Path(tmp) / "b")
        test_not_installed_guard(Path(tmp) / "c")
        test_nvidia_probe_is_safe()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
