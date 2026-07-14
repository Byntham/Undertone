"""Silence gate + vocabulary-prompt-echo filter (offline, no keys)."""
import io
import math
import os
import struct
import sys
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main as main_mod
from transcriber import _looks_like_prompt_echo


def make_wav(samples):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    return buf.getvalue()


# --- _audio_peak / SILENCE_PEAK ------------------------------------------

silence = make_wav([0] * 16000)
assert main_mod._audio_peak(silence) == 0

room_noise = make_wav([(-1) ** i * 120 for i in range(16000)])
assert main_mod._audio_peak(room_noise) == 120
assert main_mod._audio_peak(room_noise) < main_mod.SILENCE_PEAK

quiet_speech = make_wav(
    [int(2500 * math.sin(i * 2 * math.pi * 220 / 16000)) for i in range(16000)])
assert main_mod._audio_peak(quiet_speech) >= main_mod.SILENCE_PEAK

odd_payload = make_wav([0] * 3)   # odd trailing byte must not crash
assert main_mod._audio_peak(odd_payload[:-1]) == 0

# --- _looks_like_prompt_echo ----------------------------------------------

VOCAB = ["Claude", "Claude.md", "Codex", "subagent", "sol", "5.6-sol"]

# the exact failure the owner reported
assert _looks_like_prompt_echo(
    "Context: Vocabulary: Claude, Claude.md, Codex, subagent, sol, 5.6-sol.",
    VOCAB)
assert _looks_like_prompt_echo("Vocabulary: Claude, Codex", VOCAB)

# dictating a single vocabulary term must pass through
assert not _looks_like_prompt_echo("Claude", VOCAB)
assert not _looks_like_prompt_echo("Open Claude.md in Codex please", VOCAB)
# the word vocabulary alone, without configured terms, is legit dictation
assert not _looks_like_prompt_echo("expand your vocabulary daily", VOCAB)
assert not _looks_like_prompt_echo("my vocabulary includes Claude", VOCAB)
# hallucinated fragments are NOT filtered (indistinguishable from speech;
# the client-side silence gate is the defense for those)
assert not _looks_like_prompt_echo("Of the", VOCAB)
assert not _looks_like_prompt_echo(".", VOCAB)
# no vocabulary configured -> nothing to echo
assert not _looks_like_prompt_echo("Vocabulary: whatever", [])

print("ALL TESTS PASSED")
