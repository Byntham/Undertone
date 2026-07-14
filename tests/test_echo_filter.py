"""Vocabulary-prompt-echo stripping (offline, no keys).

STT models handed silence can leak the biasing prompt verbatim, wrapped in
OpenAI's server-side template. Detection requires the EXACT comma-joined
term sequence — keyword matching false-positived on the owner dictating
ABOUT the vocabulary feature. Echo shapes here were captured live from the
OpenAI and OpenRouter APIs on 2026-07-13.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import transcriber
from transcriber import (TranscriptionError, _strip_prompt_echo, transcribe)

VOCAB = ["Claude", "Claude.md", "Codex", "subagent", "sol", "5.6-sol"]

# the exact echo both providers returned for pure silence (live capture)
LIVE_ECHO = ("context: ###\nVocabulary: Claude, Claude.md, Codex, subagent, "
             "sol, 5.6-sol\n###")
assert _strip_prompt_echo(LIVE_ECHO, VOCAB) == ""

# the owner's original OpenAI report (echo with punctuation drift)
assert _strip_prompt_echo(
    "Context: Vocabulary: Claude, Claude.md, Codex, subagent, sol, 5.6-sol.",
    VOCAB) == "."

# echo leaked alongside real speech -> speech survives
assert _strip_prompt_echo(
    LIVE_ECHO + " Hello world, testing.", VOCAB) == "Hello world, testing."

# dictating ABOUT the vocabulary feature is NOT an echo (the live false
# positive that threw errors on the owner's real dictations)
assert _strip_prompt_echo(
    "Add Claude and Codex to the vocabulary list in the dictionary.",
    VOCAB) is None
assert _strip_prompt_echo("Claude", VOCAB) is None
assert _strip_prompt_echo("expand your vocabulary daily", VOCAB) is None
assert _strip_prompt_echo("Vocabulary: Claude, Codex", VOCAB) is None  # partial
assert _strip_prompt_echo("Of the", VOCAB) is None
assert _strip_prompt_echo("", VOCAB) is None
assert _strip_prompt_echo("Vocabulary: whatever", []) is None

# through transcribe(): pure echo raises loudly, echo+speech returns the
# speech, normal transcripts pass untouched
transcriber.PROVIDERS["_t"] = lambda *a: LIVE_ECHO
try:
    try:
        transcribe(b"RIFF", "key", "en", VOCAB, "_t")
    except TranscriptionError as e:
        assert "echoed the vocabulary hint" in str(e)
    else:
        raise AssertionError("pure echo did not raise")
    transcriber.PROVIDERS["_t"] = lambda *a: LIVE_ECHO + " real words here"
    assert transcribe(b"RIFF", "key", "en", VOCAB, "_t") == "real words here"
    transcriber.PROVIDERS["_t"] = lambda *a: "normal speech"
    assert transcribe(b"RIFF", "key", "en", VOCAB, "_t") == "normal speech"
finally:
    transcriber.PROVIDERS.pop("_t", None)

print("ALL TESTS PASSED")
