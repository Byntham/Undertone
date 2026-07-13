"""Start/stop sound cues for Undertone.

Two short, quiet ticks generated once into assets/ (see the repo's asset
notes) and played asynchronously via winsound so the caller never blocks.
Failures are silent — a missing file or busy audio device must never
break dictation.
"""

import pathlib
import winsound

ASSETS_DIR = pathlib.Path(__file__).resolve().parent / "assets"


def _play(name: str) -> None:
    try:
        winsound.PlaySound(
            str(ASSETS_DIR / name),
            winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT,
        )
    except Exception:
        pass


def play_start() -> None:
    """Soft rising tick when recording begins."""
    _play("sound_start.wav")


def play_stop() -> None:
    """Soft falling tick when recording ends."""
    _play("sound_stop.wav")


def play_lock() -> None:
    """Quick rising two-note tick when hands-free lock engages."""
    _play("sound_lock.wav")


def play_cancel() -> None:
    """Single short falling blip when a recording is canceled."""
    _play("sound_cancel.wav")
