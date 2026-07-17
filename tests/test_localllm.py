"""Offline tests for localllm: manifest, split-zip extraction subset, the
not-installed / never-block guards, and idle auto-eject. No network, no
server. (Download sha256 verification is covered by test_localstt — the
machinery is shared localproc code.)"""

import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import localllm
import localproc


def test_manifest_shape():
    for key in ("cpu_runtime", "cuda_runtime", "cudart", "model"):
        spec = localllm.MANIFEST[key]
        assert spec["url"].startswith("https://")
        assert len(spec["sha256"]) == 64
        assert spec["size"] > 0
    assert localllm.MANIFEST["model"]["url"].endswith(localllm.MODEL_FILENAME)
    # The model must come from Unsloth's GGUF conversion (the pinned repo).
    assert "/unsloth/" in localllm.MANIFEST["model"]["url"]
    # llama.cpp ships the CUDA runtime DLLs as a separate zip.
    assert "cudart" in localllm.MANIFEST["cudart"]["url"]


def test_extract_subset_merges_zips(tmp: Path):
    # The release zip and the cudart zip must merge flat into one build
    # dir; the cli/bench tools and their impl DLLs must be left behind.
    tmp.mkdir(parents=True, exist_ok=True)
    release = tmp / "release.zip"
    with zipfile.ZipFile(release, "w") as zf:
        for name in ["llama-server.exe", "llama-server-impl.dll",
                     "llama-common.dll", "llama.dll", "mtmd.dll",
                     "ggml.dll", "ggml-base.dll", "ggml-cpu-haswell.dll",
                     "libomp140.x86_64.dll", "ggml-cuda.dll",
                     "llama-cli.exe", "llama-cli-impl.dll",
                     "llama-bench.exe", "ggml-rpc.dll",
                     "ggml-rpc-server.exe", "llama-tts.exe"]:
            zf.writestr(name, b"x" * 10)
    cudart = tmp / "cudart.zip"
    with zipfile.ZipFile(cudart, "w") as zf:
        for name in ["cublas64_12.dll", "cublasLt64_12.dll",
                     "cudart64_12.dll"]:
            zf.writestr(name, b"y" * 10)

    target = tmp / "runtime" / "llm-cuda"
    fractions = []
    localproc.extract_subset([release, cudart], localllm._SUBSET["cuda"],
                             target, fractions.append)
    out = {p.name for p in target.iterdir()}
    assert out == {"llama-server.exe", "llama-server-impl.dll",
                   "llama-common.dll", "llama.dll", "mtmd.dll",
                   "ggml.dll", "ggml-base.dll", "ggml-cpu-haswell.dll",
                   "libomp140.x86_64.dll", "ggml-cuda.dll",
                   "cublas64_12.dll", "cublasLt64_12.dll",
                   "cudart64_12.dll"}
    assert fractions and fractions[-1] == 1.0


def test_not_installed_guards(tmp: Path):
    old_models, old_runtime = localllm.MODELS_DIR, localllm.RUNTIME_DIR
    localllm.MODELS_DIR = tmp / "models"
    localllm.RUNTIME_DIR = tmp / "runtime"
    try:
        assert not localllm.is_installed()
        try:
            localllm.ensure_ready()
            raise AssertionError("should have raised")
        except localllm.LocalLLMError as e:
            assert "Providers" in str(e)
        # The pipeline-facing paths must never load or raise: base_url
        # reports None and load_async silently declines.
        assert localllm.base_url() is None
        localllm.load_async()
        assert not localllm._loading
    finally:
        localllm.MODELS_DIR, localllm.RUNTIME_DIR = old_models, old_runtime


def test_base_url_reports_running_model_only():
    class _Proc:
        def poll(self):
            return None

    localllm._proc, localllm._port = _Proc(), 4321
    localllm._model_name = localllm.MODEL_FILENAME
    try:
        assert localllm.base_url() == "http://127.0.0.1:4321"
        # A different model override means the resident server is the
        # wrong one — report not-loaded rather than answer from it.
        assert localllm.base_url("other.gguf") is None
    finally:
        localllm._proc = localllm._port = localllm._model_name = None


def test_accessors_never_block():
    # ensure_ready holds _LOCK for the whole model load; the pipeline- and
    # UI-facing accessors must report "not ready" instead of waiting.
    import threading
    held = threading.Event()
    release = threading.Event()

    def holder():
        with localllm._LOCK:
            held.set()
            release.wait(timeout=10)

    t = threading.Thread(target=holder, daemon=True)
    t.start()
    held.wait(timeout=10)
    try:
        assert localllm.base_url() is None
        assert localllm.is_loaded() is False
        assert localllm.active_build() == ""
        localllm.load_async()  # must return immediately, not deadlock
        assert not localllm._loading
    finally:
        release.set()
        t.join(timeout=10)


def test_install_size_counts_missing_only(tmp: Path):
    old_models, old_runtime = localllm.MODELS_DIR, localllm.RUNTIME_DIR
    localllm.MODELS_DIR = tmp / "models"
    localllm.RUNTIME_DIR = tmp / "runtime"
    try:
        full = localllm.install_size()
        assert full > localllm.MANIFEST["model"]["size"]
        localllm.MODELS_DIR.mkdir(parents=True)
        localllm.model_path().write_bytes(b"x")
        assert (localllm.install_size()
                == full - localllm.MANIFEST["model"]["size"])
    finally:
        localllm.MODELS_DIR, localllm.RUNTIME_DIR = old_models, old_runtime


class _FakeProc:
    def poll(self):
        return None

    def kill(self):
        pass

    def wait(self, timeout=None):
        pass


def test_idle_autoeject():
    # A fresh timer must not fire early…
    localllm._proc = _FakeProc()
    localllm._last_used = time.monotonic()
    localllm.set_idle_timeout(60)
    time.sleep(0.3)
    assert localllm.is_loaded(), "ejected before the idle timeout"
    # …and once the idle window has truly elapsed, it ejects.
    with localllm._LOCK:
        localllm._last_used = time.monotonic() - 61
        localllm.set_idle_timeout(60)  # re-arms with ~0.05s remaining
    for _ in range(100):
        if not localllm.is_loaded():
            break
        time.sleep(0.05)
    assert not localllm.is_loaded(), "idle eject never fired"
    assert localllm._idle_timer is None
    # 0 = never: cancels any pending timer.
    localllm._proc = _FakeProc()
    localllm.set_idle_timeout(60)
    assert localllm._idle_timer is not None
    localllm.set_idle_timeout(0)
    assert localllm._idle_timer is None
    localllm._proc = None


def main():
    with tempfile.TemporaryDirectory() as tmp:
        test_manifest_shape()
        test_extract_subset_merges_zips(Path(tmp) / "a")
        test_not_installed_guards(Path(tmp) / "b")
        test_base_url_reports_running_model_only()
        test_accessors_never_block()
        test_install_size_counts_missing_only(Path(tmp) / "c")
        test_idle_autoeject()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
