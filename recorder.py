"""Microphone recording for Undertone.

Captures raw int16 mono frames via a sounddevice RawInputStream and packages
them into an in-memory WAV file on stop. No numpy: frames are raw bytes.
"""

import io
import threading
import warnings
import wave

with warnings.catch_warnings():
    warnings.simplefilter("ignore", DeprecationWarning)
    import audioop

import sounddevice as sd


class RecorderError(Exception):
    """Raised when the audio device cannot be opened or fails."""


def list_input_devices() -> list:
    """(index, name) for each input device on the default host API.

    Windows exposes every mic once per host API (MME, DirectSound, WASAPI…);
    restricting to the default API avoids listing each device three times.
    Returns [] if the audio subsystem can't be queried.
    """
    try:
        api = sd.query_hostapis(sd.default.hostapi)
        out = []
        for idx in api["devices"]:
            dev = sd.query_devices(idx)
            if dev.get("max_input_channels", 0) > 0:
                out.append((idx, dev["name"]))
        return out
    except Exception:
        return []


def _resolve_device(device):
    """Map a stored device NAME to its default-host-API index.

    Names are stored (indices shift across replugs), but sounddevice
    matches a bare name across every host API — ambiguous on Windows where
    each mic appears once per API. Resolve against the default API only;
    an unplugged/renamed device falls back to the system default (None).
    """
    if not isinstance(device, str) or not device:
        return device
    for idx, name in list_input_devices():
        if name == device:
            return idx
    return None


class Recorder:
    def __init__(self, sample_rate: int = 16000, device=None):
        self.sample_rate = sample_rate
        self.device = device            # index or name; None = system default
        self._stream = None
        self._frames = []
        self._recording = False
        self._lock = threading.Lock()
        self._level = 0.0

    def _callback(self, indata, _frames, _time_info, _status):
        # indata is a buffer of raw int16 bytes; copy it into our frame list.
        chunk = bytes(indata)
        self._frames.append(chunk)
        # Live level meter: RMS of the int16 chunk mapped through a power
        # curve so quiet speech still moves the bars, smoothed with a
        # fast-attack/slow-decay envelope.
        rms = audioop.rms(chunk, 2)
        norm = min(1.0, (rms / 4000.0) ** 0.6)
        self._level = norm if norm > self._level else self._level * 0.82

    def start(self) -> None:
        """Open the input stream and begin accumulating frames.

        Idempotent while already recording. Raises RecorderError on failure.
        """
        with self._lock:
            if self._recording:
                return
            self._frames = []
            self._level = 0.0
            try:
                self._stream = sd.RawInputStream(
                    samplerate=self.sample_rate,
                    channels=1,
                    dtype="int16",
                    device=_resolve_device(self.device or None),
                    callback=self._callback,
                )
                self._stream.start()
            except Exception as exc:
                self._stream = None
                raise RecorderError(
                    "Could not start recording. Check that a microphone is "
                    "connected and not in use by another app."
                ) from exc
            self._recording = True

    def set_device(self, device) -> None:
        """Change the input device; takes effect on the next start()."""
        self.device = device

    def stop(self) -> bytes:
        """Stop the stream and return a complete WAV file as bytes.

        Returns b"" if recording was never started or no audio was captured.
        """
        with self._lock:
            if not self._recording:
                return b""
            self._recording = False
            self._level = 0.0
            stream = self._stream
            self._stream = None
            frames = self._frames
            self._frames = []

        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

        audio = b"".join(frames)
        if not audio:
            return b""

        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(self.sample_rate)
            wav.writeframes(audio)
        return buffer.getvalue()

    @property
    def level(self) -> float:
        """Current smoothed microphone level in [0.0, 1.0] while recording."""
        if not self._recording:
            return 0.0
        return self._level
