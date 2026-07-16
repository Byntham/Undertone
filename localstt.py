"""On-device STT: a whisper.cpp server child process, installed on demand.

Everything lives under %LOCALAPPDATA%\\Undertone (never roaming APPDATA —
the runtime + model total ~1.7 GB on GPU machines): a pinned whisper.cpp
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
"""

import ctypes
import fnmatch
import hashlib
import json
import logging
import os
import shutil
import socket
import subprocess
import threading
import time
import zipfile
from pathlib import Path

import requests

ROOT = Path(os.environ["LOCALAPPDATA"]) / "Undertone"
RUNTIME_DIR = ROOT / "runtime"
MODELS_DIR = ROOT / "models"
_STATE_PATH = RUNTIME_DIR / "runtime.json"
_SERVER_LOG = RUNTIME_DIR / "server.log"

MODEL_FILENAME = "ggml-large-v3-turbo-q5_0.bin"
VAD_FILENAME = "ggml-silero-v5.1.2.bin"

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
        "sha256": "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
        "size": 574_041_195,
    },
    "vad_model": {
        "url": f"{_HF}/ggml-org/whisper-vad/resolve/main/{VAD_FILENAME}",
        "sha256": "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
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

_DOWNLOAD_TIMEOUT = (10, 60)   # read timeout applies per chunk
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
    try:
        with open(_STATE_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(**changes) -> None:
    state = {**_load_state(), **changes}
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    with open(_STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


_HAVE_NVIDIA = None


def have_nvidia_gpu() -> bool:
    """True when an NVIDIA driver stack (what the CUDA build needs) is
    present. Probes nvcuda.dll via a private WinDLL instance — never
    ctypes.windll, whose shared prototype cache other modules rely on."""
    global _HAVE_NVIDIA
    if _HAVE_NVIDIA is None:
        try:
            ctypes.WinDLL("nvcuda.dll")
            _HAVE_NVIDIA = True
        except OSError:
            _HAVE_NVIDIA = False
    return _HAVE_NVIDIA


# --- install -----------------------------------------------------------------

def _download(key: str, dest: Path, progress_cb) -> None:
    spec = MANIFEST[key]
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    digest = hashlib.sha256()
    done = 0
    try:
        with requests.get(spec["url"], stream=True,
                          timeout=_DOWNLOAD_TIMEOUT) as resp:
            resp.raise_for_status()
            with open(part, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    done += len(chunk)
                    progress_cb(min(1.0, done / spec["size"]))
    except requests.RequestException as exc:
        part.unlink(missing_ok=True)
        raise LocalSTTError(
            "Download failed — check your internet connection and retry."
        ) from exc
    if digest.hexdigest() != spec["sha256"]:
        part.unlink(missing_ok=True)
        raise LocalSTTError(
            "A downloaded file failed verification — retry the download.")
    os.replace(part, dest)


def _extract_subset(zip_path: Path, build: str, progress_cb) -> None:
    """Extract just the server + DLLs into runtime/<build> (flat)."""
    wanted = _SUBSET[build]
    target = _build_dir(build)
    staging = target.with_name(target.name + ".tmp")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    with zipfile.ZipFile(zip_path) as zf:
        members = [m for m in zf.infolist() if any(
            fnmatch.fnmatch(Path(m.filename).name.lower(), pat)
            for pat in wanted)]
        total = sum(m.file_size for m in members) or 1
        done = 0
        for member in members:
            with zf.open(member) as src, \
                    open(staging / Path(member.filename).name, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            done += member.file_size
            progress_cb(done / total)
    shutil.rmtree(target, ignore_errors=True)
    os.replace(staging, target)


def is_installed(model_name: str = MODEL_FILENAME) -> bool:
    return (_server_exe("cpu").is_file() and model_path(model_name).is_file()
            and model_path(VAD_FILENAME).is_file())


def install_size() -> int:
    """Total bytes install() would download on this machine."""
    keys = ["cpu_runtime", "model", "vad_model"]
    if have_nvidia_gpu():
        keys.append("cuda_runtime")
    return sum(MANIFEST[k]["size"] for k in keys)


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
                             if want_cuda else 0) + (200 << 20)
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

_CREATE_NO_WINDOW = 0x08000000
_JOB_KILL_ON_CLOSE = 0x2000
_JobObjectExtendedLimitInformation = 9

# Private WinDLL instance: prototypes on ctypes.windll would poison the
# process-wide cache other modules share. HANDLEs must be c_void_p — the
# default c_int truncates them on 64-bit.
_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_kernel32.CreateJobObjectW.restype = ctypes.c_void_p
_kernel32.CreateJobObjectW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p)
_kernel32.SetInformationJobObject.restype = ctypes.c_int
_kernel32.SetInformationJobObject.argtypes = (
    ctypes.c_void_p, ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32)
_kernel32.AssignProcessToJobObject.restype = ctypes.c_int
_kernel32.AssignProcessToJobObject.argtypes = (
    ctypes.c_void_p, ctypes.c_void_p)
_kernel32.CloseHandle.restype = ctypes.c_int
_kernel32.CloseHandle.argtypes = (ctypes.c_void_p,)


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", ctypes.c_uint32),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", ctypes.c_uint32),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", ctypes.c_uint32),
                ("SchedulingClass", ctypes.c_uint32)]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_uint64) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [("BasicLimitInformation",
                 _JOBOBJECT_BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


def _attach_job(proc) -> "int | None":
    """Tie the child to a kill-on-close job so it dies with us, even via
    Task Manager (the OS closes our job handle on process teardown)."""
    job = _kernel32.CreateJobObjectW(None, None)
    if not job:
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = _JOB_KILL_ON_CLOSE
    ok = _kernel32.SetInformationJobObject(
        job, _JobObjectExtendedLimitInformation,
        ctypes.byref(info), ctypes.sizeof(info))
    if not ok or not _kernel32.AssignProcessToJobObject(
            job, int(proc._handle)):
        _kernel32.CloseHandle(job)
        return None
    return job


def _pick_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _spawn(build: str, model_name: str) -> None:
    """Start the server and wait until it answers HTTP. Caller holds _LOCK
    and handles failure (raises LocalSTTError)."""
    global _proc, _port, _build, _model_name, _job
    port = _pick_port()
    cmd = [str(_server_exe(build)), "-m", str(model_path(model_name)),
           "--vad", "--vad-model", str(model_path(VAD_FILENAME)),
           "--host", "127.0.0.1", "--port", str(port)]
    if build == "cpu":
        cmd += ["-t", str(min(8, os.cpu_count() or 4))]
    log = open(_SERVER_LOG, "wb")
    try:
        proc = subprocess.Popen(cmd, stdout=log, stderr=log,
                                creationflags=_CREATE_NO_WINDOW)
    except OSError as exc:
        log.close()
        raise LocalSTTError(
            "Could not start the local transcription engine — "
            "try re-downloading it in Settings → Providers.") from exc
    finally:
        # Popen duplicated the handle (or failed); ours can close either way.
        if not log.closed:
            log.close()
    job = _attach_job(proc)
    deadline = time.monotonic() + _READY_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        try:
            requests.get(f"http://127.0.0.1:{port}/", timeout=1)
            _proc, _port, _build, _model_name, _job = (
                proc, port, build, model_name, job)
            logging.info("local STT server ready (%s, %s, port %d)",
                         build, model_name, port)
            return
        except requests.RequestException:
            time.sleep(0.25)
    proc.kill()
    if job:
        _kernel32.CloseHandle(job)
    raise LocalSTTError(
        "The local transcription engine failed to start — see server.log "
        "in the Undertone data folder.")


def ensure_ready(model_name: str = "") -> str:
    """Return the running server's base URL, starting it if needed.

    This is the auto-load path for dictation-while-ejected: the caller's
    "Transcribing…" pill covers the ~2 s model load. Raises LocalSTTError.
    """
    model_name = model_name or MODEL_FILENAME
    with _LOCK:
        if _proc is not None and _proc.poll() is None \
                and _model_name == model_name:
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


def load(model_name: str = "") -> None:
    """Warm the server without transcribing (Settings 'Load model')."""
    ensure_ready(model_name)


def is_loaded() -> bool:
    with _LOCK:
        return _proc is not None and _proc.poll() is None


def active_build() -> str:
    """'cuda'/'cpu' of the running server ('' when not loaded)."""
    with _LOCK:
        return _build if is_loaded() else ""


def eject() -> None:
    """Stop the server and free its memory (Settings 'Eject model')."""
    global _proc, _port, _build, _model_name, _job
    with _LOCK:
        if _proc is not None:
            try:
                _proc.kill()
                _proc.wait(timeout=5)
            except OSError:
                pass
        if _job:
            _kernel32.CloseHandle(_job)
        _proc = _port = _build = _model_name = _job = None


def shutdown() -> None:
    """App exit: same as eject (the job object backstops hard kills)."""
    eject()
