"""On-device AI cleanup: a llama.cpp llama-server child, installed on
demand. The sibling of localstt.py (whisper.cpp), built on the same
localproc machinery.

llama-server speaks the OpenAI chat-completions dialect natively —
including json_schema response_format, enforced by grammar-constrained
decoding — so cleanup.py POSTs the exact body it sends to the cloud
providers, just to a loopback URL with no auth header.

Everything lives under %LOCALAPPDATA%\\Undertone alongside the STT
runtime: pinned llama.cpp release zips (the CUDA build when an NVIDIA
driver is present, the small CPU build always, as the fallback — plus
llama.cpp's separate CUDA-runtime-DLLs zip) and a GGUF chat model.

Residency mirrors localstt (Load/Eject, idle auto-eject, kill-on-close
job object) with one extra rule: cleanup must never stall a dictation, so
nothing here blocks the pipeline. base_url() only reports a running
server, and load_async() warms it in the background — a dictation that
finds the model ejected falls back to rule-based formatting once while
the model loads for the next one.

Thread-safety matches localstt: every state transition holds _LOCK. The
read-only accessors (base_url, is_loaded, active_build, load_async's
guard) take it NON-blocking — ensure_ready holds the lock across the
whole model load, and a contended read must mean "not ready", not a
stalled pipeline or a frozen settings poll.
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
MODELS_DIR = ROOT / "models"          # shared with localstt
_STATE_PATH = RUNTIME_DIR / "llm-runtime.json"
_SERVER_LOG = RUNTIME_DIR / "llm-server.log"

# Unsloth's GGUF conversion of Qwen3-4B-Instruct-2507 (a non-reasoning
# instruct model — a thinking model would blow the cleanup latency budget).
MODEL_FILENAME = "Qwen3-4B-Instruct-2507-Q4_K_M.gguf"

_RELEASE = "https://github.com/ggml-org/llama.cpp/releases/download/b10064"

# Pinned llama.cpp b10064 artifacts (sha256 = GitHub's published digests,
# re-verified against local downloads 2026-07-17; model digest from the
# Hugging Face LFS metadata, same verification).
MANIFEST = {
    "cpu_runtime": {
        "url": f"{_RELEASE}/llama-b10064-bin-win-cpu-x64.zip",
        "sha256": "c9b770b584a007a1aeea1b729e0e4724fb79a2cb136ece46be92704aaee5099e",
        "size": 18_007_056,
    },
    "cuda_runtime": {
        "url": f"{_RELEASE}/llama-b10064-bin-win-cuda-12.4-x64.zip",
        "sha256": "d3df8c73874d9bf00cb3631a902a6afea556d57f11cb226e165689be9aa9e34b",
        "size": 249_038_000,
    },
    # llama.cpp ships the CUDA runtime DLLs (cudart/cublas) separately.
    "cudart": {
        "url": f"{_RELEASE}/cudart-llama-bin-win-cuda-12.4-x64.zip",
        "sha256": "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
        "size": 391_443_627,
    },
    "model": {
        "url": "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF"
               f"/resolve/main/{MODEL_FILENAME}",
        "sha256": "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
        "size": 2_497_281_120,
    },
}

# llama-server runs from this file subset (verified by booting the server
# from a subset-only directory); the cli/bench/tts exes, their impl DLLs,
# and the .pdbs in the release zips are dead weight. The split cudart zip
# merges into the cuda build dir.
_SUBSET = {
    "cpu": ["llama-server.exe", "llama-server-impl.dll", "llama-common.dll",
            "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll",
            "ggml-cpu-*.dll", "libomp140*.dll"],
    "cuda": ["llama-server.exe", "llama-server-impl.dll", "llama-common.dll",
             "llama.dll", "mtmd.dll", "ggml.dll", "ggml-base.dll",
             "ggml-cpu-*.dll", "libomp140*.dll", "ggml-cuda.dll",
             "cublas64_12.dll", "cublasLt64_12.dll", "cudart64_12.dll"],
}

# Model load is a 2.5 GB read; allow for a cold HDD, not just a warm SSD.
_READY_TIMEOUT_S = 120


class LocalLLMError(Exception):
    """Carries a user-friendly message describing what went wrong."""


def model_path(name: str = MODEL_FILENAME) -> Path:
    return MODELS_DIR / name


def _build_dir(build: str) -> Path:
    return RUNTIME_DIR / f"llm-{build}"


def _server_exe(build: str) -> Path:
    return _build_dir(build) / "llama-server.exe"


def _load_state() -> dict:
    return localproc.load_state(_STATE_PATH)


def _save_state(**changes) -> None:
    localproc.save_state(_STATE_PATH, **changes)


have_nvidia_gpu = localproc.have_nvidia_gpu


# --- install -----------------------------------------------------------------

def is_installed(model_name: str = MODEL_FILENAME) -> bool:
    return _server_exe("cpu").is_file() and model_path(model_name).is_file()


def _pending() -> list:
    """Manifest keys install() still needs to download on this machine."""
    keys = []
    if not _server_exe("cpu").is_file():
        keys.append("cpu_runtime")
    if have_nvidia_gpu() and not _server_exe("cuda").is_file():
        keys += ["cuda_runtime", "cudart"]
    if not model_path().is_file():
        keys.append("model")
    return keys


def install_size() -> int:
    """Bytes install() would still download (only what's missing)."""
    return sum(MANIFEST[k]["size"] for k in _pending())


def install(progress_cb) -> None:
    """Download + extract everything this machine needs (idempotent).

    progress_cb(phase_label, fraction) is called from the caller's thread;
    fraction is per-phase 0..1. Raises LocalLLMError on failure.
    """
    ROOT.mkdir(parents=True, exist_ok=True)
    pending = _pending()
    # Extraction roughly doubles the CUDA zips on disk; demand headroom for
    # the worst moment (zips + extracted copies + model) plus margin.
    need = install_size() + sum(
        MANIFEST[k]["size"] for k in ("cuda_runtime", "cudart")
        if k in pending) + (200 << 20)
    if shutil.disk_usage(ROOT).free < need:
        raise LocalLLMError(
            f"Not enough disk space — needs about {need / (1 << 30):.1f} "
            "GB free.")

    # The CPU runtime is always installed: it is small and doubles as the
    # fallback when the CUDA build fails to start.
    builds = [("cpu", ["cpu_runtime"])]
    if have_nvidia_gpu():
        builds.append(("cuda", ["cuda_runtime", "cudart"]))
    for build, keys in builds:
        if _server_exe(build).is_file():
            continue
        zips = []
        for key in keys:
            zip_path = RUNTIME_DIR / f"llm-{key}.zip"
            localproc.download(
                MANIFEST[key], zip_path,
                lambda f: progress_cb("Downloading engine", f),
                LocalLLMError)
            zips.append(zip_path)
        localproc.extract_subset(
            zips, _SUBSET[build], _build_dir(build),
            lambda f: progress_cb("Installing engine", f))
        for zip_path in zips:
            zip_path.unlink(missing_ok=True)

    if not model_path().is_file():
        localproc.download(
            MANIFEST["model"], model_path(),
            lambda f: progress_cb("Downloading model", f), LocalLLMError)
    _save_state(cuda_installed=have_nvidia_gpu(), cuda_disabled=False)


# --- server lifecycle --------------------------------------------------------

_LOCK = threading.RLock()
_proc = None
_port = None
_build = None
_model_name = None
_job = None
_loading = False     # a load_async worker is running
_idle_seconds = 0    # auto-eject after this much inactivity; 0 = never
_idle_timer = None
_last_used = 0.0


def _spawn(build: str, model_name: str) -> None:
    """Start the server and wait until /health says the model is loaded.
    Caller holds _LOCK and handles failure (raises LocalLLMError)."""
    global _proc, _port, _build, _model_name, _job
    port = localproc.pick_port()
    # -c 8192 caps the context (the cleanup prompt is tiny; the model's
    # native window would waste memory on KV cache); --jinja applies the
    # model's own chat template exactly.
    cmd = [str(_server_exe(build)), "-m", str(model_path(model_name)),
           "--host", "127.0.0.1", "--port", str(port),
           "-c", "8192", "--jinja"]
    if build == "cuda":
        cmd += ["-ngl", "99"]
    else:
        cmd += ["-t", str(min(8, os.cpu_count() or 4))]
    proc, job = localproc.spawn_server(
        cmd, _SERVER_LOG, f"http://127.0.0.1:{port}/health", LocalLLMError,
        "Could not start the local cleanup engine — "
        "try re-downloading it in Settings → Providers.",
        "The local cleanup engine failed to start — see llm-server.log "
        "in the Undertone data folder.",
        # /health serves 503 until the model finishes loading.
        ready_ok=lambda resp: resp.status_code == 200,
        timeout_s=_READY_TIMEOUT_S)
    _proc, _port, _build, _model_name, _job = (
        proc, port, build, model_name, job)
    logging.info("local LLM server ready (%s, %s, port %d)",
                 build, model_name, port)


# Optional UI hook for degraded-but-working outcomes (set by the app,
# called from worker threads — the target must be thread-safe).
on_notice = None


def ensure_ready(model_name: str = "") -> str:
    """Return the running server's base URL, starting it if needed.

    Blocks for the model load; only Settings workers and load_async call
    this — the dictation pipeline goes through base_url(). Raises
    LocalLLMError.
    """
    model_name = model_name or MODEL_FILENAME
    with _LOCK:
        if _proc is not None and _proc.poll() is None \
                and _model_name == model_name:
            _touch()
            return f"http://127.0.0.1:{_port}"
        if not is_installed(model_name):
            raise LocalLLMError(
                "The local cleanup model isn't installed — download it in "
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
            except LocalLLMError:
                if build != "cuda":
                    raise
                # GPU path is broken (driver change, OOM…): remember and
                # fall back to CPU so cleanup keeps working.
                logging.warning(
                    "local LLM CUDA build failed to start; falling back "
                    "to CPU (re-enable by deleting llm-runtime.json)")
                _save_state(cuda_disabled=True)
                if on_notice:
                    on_notice("GPU cleanup failed — using CPU (slower). "
                              "See the log for details.")


def base_url(model_name: str = "") -> "str | None":
    """The running server's base URL, or None — never loads, never blocks.

    The cleanup pass must not stall a dictation, so a contended lock (an
    ensure_ready holding it across a model load) also reports None; callers
    that get None warm the server via load_async() instead."""
    model_name = model_name or MODEL_FILENAME
    if not _LOCK.acquire(blocking=False):
        return None
    try:
        if _proc is not None and _proc.poll() is None \
                and _model_name == model_name:
            _touch()
            return f"http://127.0.0.1:{_port}"
        return None
    finally:
        _LOCK.release()


def load_async(model_name: str = "") -> None:
    """Warm the server on a background thread (single-flight, non-blocking).

    Used when a dictation finds local cleanup ejected: that dictation
    falls back to rules, the next one gets the model."""
    global _loading
    if not _LOCK.acquire(blocking=False):
        return  # a load/eject is already in flight
    try:
        if _loading or (_proc is not None and _proc.poll() is None):
            return
        if not is_installed(model_name or MODEL_FILENAME):
            return  # nothing to warm; Settings owns the install story
        _loading = True
    finally:
        _LOCK.release()

    def work():
        global _loading
        try:
            ensure_ready(model_name)
        except LocalLLMError as e:
            logging.warning("local cleanup model load failed: %s", e)
        finally:
            with _LOCK:
                _loading = False

    threading.Thread(target=work, daemon=True).start()


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
            logging.info("local LLM idle for %.0fs — ejecting", idle)
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
    """Warm the server without a dictation (Settings 'Load model')."""
    ensure_ready(model_name)


def is_loaded() -> bool:
    # Non-blocking: a lock held across a model load must read as "not
    # loaded yet", not freeze the caller (the settings poll runs on the
    # Qt main thread).
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
