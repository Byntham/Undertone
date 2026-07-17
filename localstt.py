"""On-device STT: a whisper.cpp server child process, installed on demand.

Everything lives under %LOCALAPPDATA%\\Undertone (never roaming APPDATA —
the runtime + model total ~2.8 GB on GPU machines): a pinned whisper.cpp
release (the CUDA build when an NVIDIA driver is present, the tiny CPU
build always, as the fallback), the ggml Whisper model, and a Silero VAD
model. VAD is what makes local Whisper safe here: without it the model
hallucinates fragments on silence (the same reason whisper-large-v3-turbo
is banned from the cloud defaults); with --vad the server returns empty
text for no-speech audio.

The server is spawned hidden on a loopback port and kept resident so
dictation costs no model-load latency; transcriber.transcribe_local POSTs
WAV bytes to it. Residency is user-controlled (Load/Eject in Settings) —
there is deliberately no idle timeout. A kill-on-close job object ties the
child's lifetime to ours even through a Task Manager kill.

Thread-safety: the settings worker thread (install/load/eject) and the
pipeline worker (ensure_ready) both call in; every state transition holds
_LOCK. Downloads verify a pinned sha256 and land via atomic rename.
The engine-agnostic mechanics (download, extraction, job objects, spawn)
are shared with localllm via localproc.
"""

import logging
import os
import shutil
import threading
import time
from pathlib import Path

import localproc

ROOT = Path(os.environ["LOCALAPPDATA"]) / "Undertone"
RUNTIME_DIR = ROOT / "runtime"
MODELS_DIR = ROOT / "models"
_STATE_PATH = RUNTIME_DIR / "runtime.json"
_SERVER_LOG = RUNTIME_DIR / "server.log"

# Full-precision ggml conversion of OpenAI's official whisper-large-v3-turbo
# (the safetensors on huggingface.co/openai can't be loaded by whisper.cpp).
MODEL_FILENAME = "ggml-large-v3-turbo.bin"
VAD_FILENAME = "ggml-silero-v6.2.0.bin"

_RELEASE = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1"
_HF = "https://huggingface.co"

# Pinned whisper.cpp v1.9.1 artifacts (sha256/size verified 2026-07-16).
MANIFEST = {
    "cpu_runtime": {
        "url": f"{_RELEASE}/whisper-bin-x64.zip",
        "sha256": "7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539",
        "size": 7_982_101,
    },
    "cuda_runtime": {
        "url": f"{_RELEASE}/whisper-cublas-12.4.0-bin-x64.zip",
        "sha256": "106a2030eff8998e4ef320fe72e263a78449e9040386ee27c41ea80b001b601b",
        "size": 677_887_125,
    },
    "model": {
        "url": f"{_HF}/ggerganov/whisper.cpp/resolve/main/{MODEL_FILENAME}",
        "sha256": "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
        "size": 1_624_555_275,
    },
    # ggml-org/whisper-vad is whisper.cpp's own artifact repo — it's where
    # the project's models/download-vad-model.sh downloads from.
    "vad_model": {
        "url": f"{_HF}/ggml-org/whisper-vad/resolve/main/{VAD_FILENAME}",
        "sha256": "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987",
        "size": 885_098,
    },
}

# The server runs from this file subset (verified); SDL2.dll and the
# demo/test exes in the release zips are dead weight.
_SUBSET = {
    "cpu": ["whisper-server.exe", "whisper.dll", "ggml.dll",
            "ggml-base.dll", "ggml-cpu-*.dll"],
    "cuda": ["whisper-server.exe", "whisper.dll", "ggml.dll",
             "ggml-base.dll", "ggml-cpu-*.dll", "ggml-cuda.dll",
             "cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll",
             "nvrtc64_120_0.dll", "nvrtc-builtins64_124.dll"],
}

_READY_TIMEOUT_S = 20


class LocalSTTError(Exception):
    """Carries a user-friendly message describing what went wrong."""


def model_path(name: str = MODEL_FILENAME) -> Path:
    return MODELS_DIR / name


def _build_dir(build: str) -> Path:
    return RUNTIME_DIR / build


def _server_exe(build: str) -> Path:
    return _build_dir(build) / "whisper-server.exe"


def _load_state() -> dict:
    return localproc.load_state(_STATE_PATH)


def _save_state(**changes) -> None:
    localproc.save_state(_STATE_PATH, **changes)


have_nvidia_gpu = localproc.have_nvidia_gpu


# --- install -----------------------------------------------------------------

def _download(key: str, dest: Path, progress_cb) -> None:
    localproc.download(MANIFEST[key], dest, progress_cb, LocalSTTError)


def _extract_subset(zip_path: Path, build: str, progress_cb) -> None:
    """Extract just the server + DLLs into runtime/<build> (flat)."""
    localproc.extract_subset([zip_path], _SUBSET[build], _build_dir(build),
                             progress_cb)


def is_installed(model_name: str = MODEL_FILENAME) -> bool:
    return (_server_exe("cpu").is_file() and model_path(model_name).is_file()
            and model_path(VAD_FILENAME).is_file())


def _pending() -> list:
    """Manifest keys install() still needs to download on this machine."""
    keys = []
    if not _server_exe("cpu").is_file():
        keys.append("cpu_runtime")
    if have_nvidia_gpu() and not _server_exe("cuda").is_file():
        keys.append("cuda_runtime")
    if not model_path().is_file():
        keys.append("model")
    if not model_path(VAD_FILENAME).is_file():
        keys.append("vad_model")
    return keys


def install_size() -> int:
    """Bytes install() would still download (only what's missing)."""
    return sum(MANIFEST[k]["size"] for k in _pending())


def install(progress_cb) -> None:
    """Download + extract everything this machine needs (idempotent).

    progress_cb(phase_label, fraction) is called from the caller's thread;
    fraction is per-phase 0..1. Raises LocalSTTError on failure.
    """
    ROOT.mkdir(parents=True, exist_ok=True)
    want_cuda = have_nvidia_gpu()
    # Extraction roughly doubles the CUDA zip on disk; demand headroom for
    # the worst moment (zip + extracted copy + model) plus margin.
    need = install_size() + (MANIFEST["cuda_runtime"]["size"]
                             if "cuda_runtime" in _pending()
                             else 0) + (200 << 20)
    if shutil.disk_usage(ROOT).free < need:
        raise LocalSTTError(
            f"Not enough disk space — needs about {need / (1 << 30):.1f} "
            "GB free.")

    # The CPU runtime is always installed: it is tiny and doubles as the
    # fallback when the CUDA build fails to start.
    builds = [("cpu", "cpu_runtime")]
    if want_cuda:
        builds.append(("cuda", "cuda_runtime"))
    for build, key in builds:
        if _server_exe(build).is_file():
            continue
        zip_path = RUNTIME_DIR / f"{build}.zip"
        _download(key, zip_path,
                  lambda f: progress_cb("Downloading engine", f))
        _extract_subset(zip_path, build,
                        lambda f: progress_cb("Installing engine", f))
        zip_path.unlink(missing_ok=True)

    if not model_path().is_file():
        _download("model", model_path(),
                  lambda f: progress_cb("Downloading model", f))
    if not model_path(VAD_FILENAME).is_file():
        _download("vad_model", model_path(VAD_FILENAME),
                  lambda f: progress_cb("Downloading model", f))
    _save_state(cuda_installed=want_cuda, cuda_disabled=False)


# --- server lifecycle --------------------------------------------------------

_LOCK = threading.RLock()
_proc = None
_port = None
_build = None
_model_name = None
_job = None
_idle_seconds = 0    # auto-eject after this much inactivity; 0 = never
_idle_timer = None
_last_used = 0.0


def _spawn(build: str, model_name: str) -> None:
    """Start the server and wait until it answers HTTP. Caller holds _LOCK
    and handles failure (raises LocalSTTError)."""
    global _proc, _port, _build, _model_name, _job
    port = localproc.pick_port()
    cmd = [str(_server_exe(build)), "-m", str(model_path(model_name)),
           "--vad", "--vad-model", str(model_path(VAD_FILENAME)),
           "--host", "127.0.0.1", "--port", str(port)]
    if build == "cpu":
        cmd += ["-t", str(min(8, os.cpu_count() or 4))]
    proc, job = localproc.spawn_server(
        cmd, _SERVER_LOG, f"http://127.0.0.1:{port}/", LocalSTTError,
        "Could not start the local transcription engine — "
        "try re-downloading it in Settings → Providers.",
        "The local transcription engine failed to start — see server.log "
        "in the Undertone data folder.",
        timeout_s=_READY_TIMEOUT_S)
    _proc, _port, _build, _model_name, _job = (
        proc, port, build, model_name, job)
    logging.info("local STT server ready (%s, %s, port %d)",
                 build, model_name, port)


# Optional UI hook for degraded-but-working outcomes (set by the app,
# called from worker threads — the target must be thread-safe).
on_notice = None


def ensure_ready(model_name: str = "") -> str:
    """Return the running server's base URL, starting it if needed.

    This is the auto-load path for dictation-while-ejected: the caller's
    "Transcribing…" pill covers the ~2 s model load. Raises LocalSTTError.
    """
    model_name = model_name or MODEL_FILENAME
    with _LOCK:
        if _proc is not None and _proc.poll() is None \
                and _model_name == model_name:
            _touch()
            return f"http://127.0.0.1:{_port}"
        if not is_installed(model_name):
            raise LocalSTTError(
                "The local model isn't installed — download it in "
                "Settings → Providers.")
        eject()
        state = _load_state()
        builds = ["cpu"]
        if state.get("cuda_installed") and not state.get("cuda_disabled") \
                and _server_exe("cuda").is_file():
            builds.insert(0, "cuda")
        for build in builds:
            try:
                _spawn(build, model_name)
                _touch()
                return f"http://127.0.0.1:{_port}"
            except LocalSTTError:
                if build != "cuda":
                    raise
                # GPU path is broken (driver change, OOM…): remember and
                # fall back to CPU so dictation keeps working.
                logging.warning(
                    "local STT CUDA build failed to start; falling back "
                    "to CPU (re-enable by deleting runtime.json)")
                _save_state(cuda_disabled=True)
                if on_notice:
                    on_notice("GPU transcription failed — using CPU "
                              "(slower). See the log for details.")


def set_idle_timeout(seconds: int) -> None:
    """Auto-eject after this much inactivity (0 = never)."""
    global _idle_seconds
    with _LOCK:
        _idle_seconds = max(0, int(seconds))
        if not _idle_seconds:
            _cancel_idle_timer()
        elif is_loaded():
            remaining = _idle_seconds - (time.monotonic() - _last_used)
            _arm_idle_timer(max(0.05, remaining))


def _cancel_idle_timer() -> None:
    global _idle_timer
    if _idle_timer is not None:
        _idle_timer.cancel()
        _idle_timer = None


def _arm_idle_timer(delay: float) -> None:
    global _idle_timer
    _cancel_idle_timer()
    _idle_timer = threading.Timer(delay, _idle_check)
    _idle_timer.daemon = True
    _idle_timer.start()


def _idle_check() -> None:
    # Re-check under the lock — a dictation may have raced the timer, and
    # a cancel() that loses the race must stay harmless.
    with _LOCK:
        if not _idle_seconds or not is_loaded():
            return
        idle = time.monotonic() - _last_used
        if idle >= _idle_seconds:
            logging.info("local STT idle for %.0fs — ejecting", idle)
            eject()
        else:
            _arm_idle_timer(_idle_seconds - idle)


def _touch() -> None:
    """Record activity; caller holds _LOCK and the server is running."""
    global _last_used
    _last_used = time.monotonic()
    if _idle_seconds:
        _arm_idle_timer(_idle_seconds)


def load(model_name: str = "") -> None:
    """Warm the server without transcribing (Settings 'Load model')."""
    ensure_ready(model_name)


def is_loaded() -> bool:
    # Non-blocking: ensure_ready holds _LOCK for the whole model load, and
    # the settings poll calls this from the Qt main thread — a contended
    # lock must read as "not loaded yet", not freeze the UI.
    if not _LOCK.acquire(blocking=False):
        return False
    try:
        return _proc is not None and _proc.poll() is None
    finally:
        _LOCK.release()


def active_build() -> str:
    """'cuda'/'cpu' of the running server ('' when not loaded)."""
    if not _LOCK.acquire(blocking=False):
        return ""
    try:
        if _proc is not None and _proc.poll() is None:
            return _build
        return ""
    finally:
        _LOCK.release()


def eject() -> None:
    """Stop the server and free its memory (Settings 'Eject model')."""
    global _proc, _port, _build, _model_name, _job
    with _LOCK:
        _cancel_idle_timer()
        if _proc is not None:
            try:
                _proc.kill()
                _proc.wait(timeout=5)
            except OSError:
                pass
        localproc.close_job(_job)
        _proc = _port = _build = _model_name = _job = None


def shutdown() -> None:
    """App exit: same as eject (the job object backstops hard kills)."""
    eject()
