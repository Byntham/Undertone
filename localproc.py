"""Shared machinery for on-device engine child processes.

localstt (whisper.cpp) and localllm (llama.cpp) both install a pinned
release on demand and run it as a hidden loopback HTTP server. The
engine-agnostic mechanics live here: sha256-verified downloads, release-zip
subset extraction, kill-on-close job objects, and spawn-until-HTTP-ready.
Each engine module keeps its own manifest, paths, lock, and residency
state.
"""

import ctypes
import fnmatch
import hashlib
import json
import os
import shutil
import socket
import subprocess
import time
import zipfile
from pathlib import Path

import requests

DOWNLOAD_TIMEOUT = (10, 60)   # read timeout applies per chunk

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


_HAVE_NVIDIA = None


def have_nvidia_gpu() -> bool:
    """True when an NVIDIA driver stack (what the CUDA builds need) is
    present. Probes nvcuda.dll via a private WinDLL instance."""
    global _HAVE_NVIDIA
    if _HAVE_NVIDIA is None:
        try:
            ctypes.WinDLL("nvcuda.dll")
            _HAVE_NVIDIA = True
        except OSError:
            _HAVE_NVIDIA = False
    return _HAVE_NVIDIA


def load_state(path: Path) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path: Path, **changes) -> None:
    state = {**load_state(path), **changes}
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)


def download(spec: dict, dest: Path, progress_cb, err_cls) -> None:
    """Download spec["url"] to dest, verifying the pinned sha256/size.

    Lands via atomic rename; raises err_cls with a user-friendly message
    on network failure or digest mismatch."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    digest = hashlib.sha256()
    done = 0
    try:
        with requests.get(spec["url"], stream=True,
                          timeout=DOWNLOAD_TIMEOUT) as resp:
            resp.raise_for_status()
            with open(part, "wb") as f:
                for chunk in resp.iter_content(chunk_size=1 << 20):
                    f.write(chunk)
                    digest.update(chunk)
                    done += len(chunk)
                    progress_cb(min(1.0, done / spec["size"]))
    except requests.RequestException as exc:
        part.unlink(missing_ok=True)
        raise err_cls(
            "Download failed — check your internet connection and retry."
        ) from exc
    if digest.hexdigest() != spec["sha256"]:
        part.unlink(missing_ok=True)
        raise err_cls(
            "A downloaded file failed verification — retry the download.")
    os.replace(part, dest)


def extract_subset(zip_paths, patterns, target: Path, progress_cb) -> None:
    """Extract members matching patterns from the zips into target (flat).

    Multiple zips merge into one directory (llama.cpp ships the CUDA
    runtime DLLs as a separate zip). Staged + atomic: target appears
    complete or not at all."""
    staging = target.with_name(target.name + ".tmp")
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    zfs = []
    try:
        for zip_path in zip_paths:
            zfs.append(zipfile.ZipFile(zip_path))
        plan = [(zf, m) for zf in zfs for m in zf.infolist() if any(
            fnmatch.fnmatch(Path(m.filename).name.lower(), pat)
            for pat in patterns)]
        total = sum(m.file_size for _zf, m in plan) or 1
        done = 0
        for zf, member in plan:
            with zf.open(member) as src, \
                    open(staging / Path(member.filename).name, "wb") as out:
                shutil.copyfileobj(src, out, 1 << 20)
            done += member.file_size
            progress_cb(done / total)
    finally:
        # Every opened handle closes even if a later zip fails to open —
        # a leaked handle would also block the caller's zip cleanup.
        for zf in zfs:
            zf.close()
    shutil.rmtree(target, ignore_errors=True)
    os.replace(staging, target)


def pick_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


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


def attach_job(proc) -> "int | None":
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


def close_job(job) -> None:
    if job:
        _kernel32.CloseHandle(job)


def spawn_server(cmd, log_path: Path, ready_url: str, err_cls,
                 start_msg: str, ready_msg: str,
                 ready_ok=lambda resp: True, timeout_s: float = 20):
    """Start a hidden server child and wait until ready_url answers HTTP
    (and ready_ok accepts the response — llama-server's /health serves 503
    while the model loads). Returns (proc, job); raises err_cls."""
    log = open(log_path, "wb")
    try:
        proc = subprocess.Popen(cmd, stdout=log, stderr=log,
                                creationflags=_CREATE_NO_WINDOW)
    except OSError as exc:
        raise err_cls(start_msg) from exc
    finally:
        # Popen duplicated the handle (or failed); ours can close either way.
        if not log.closed:
            log.close()
    job = attach_job(proc)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        try:
            if ready_ok(requests.get(ready_url, timeout=1)):
                return proc, job
        except requests.RequestException:
            pass
        time.sleep(0.25)
    proc.kill()
    close_job(job)
    raise err_cls(ready_msg)
