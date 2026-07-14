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


# --- _speech_windows gate --------------------------------------------------

def gated(wav):
    hot, _ = main_mod._speech_windows(wav)
    return hot < main_mod.SPEECH_MIN_WINDOWS

# pure silence and steady room noise (owner's floor: window RMS <= 120)
assert gated(make_wav([0] * 16000))
assert gated(make_wav([(-1) ** i * 120 for i in range(16000)]))

# sustained quiet speech (1s tone, RMS ~1770) passes
tone = [int(2500 * math.sin(i * 2 * math.pi * 220 / 16000))
        for i in range(16000)]
assert not gated(make_wav(tone))

# a lone key clack (45ms burst) in otherwise silent audio stays gated
clack = [0] * 16000
for i in range(8000, 8720):
    clack[i] = int(4000 * math.sin(i * 1.1))
assert gated(make_wav(clack))

# a short word (240ms burst mid-recording) passes
word = [0] * 16000
for i in range(6000, 9840):
    word[i] = int(1500 * math.sin(i * 2 * math.pi * 180 / 16000))
assert not gated(make_wav(word))

# energy only inside the trimmed press/release edges stays gated
edges = [0] * 16000
for i in range(0, 1600):          # first 100ms (key press clack)
    edges[i] = 5000
for i in range(14400, 16000):     # last 100ms (key release clack)
    edges[i] = 5000
assert gated(make_wav(edges))

# odd trailing byte must not crash
odd_payload = make_wav([0] * 3)
main_mod._speech_windows(odd_payload[:-1])

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
