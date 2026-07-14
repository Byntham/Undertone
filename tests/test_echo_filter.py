"""Vocabulary-prompt-echo filter (offline, no keys).

Whisper-family STT handed near-silence tends to continue the biasing
prompt. The server-side fix is choosing default models with no-speech
rejection (see DEFAULT_STT_MODELS); this filter is the client-side
backstop for the prompt-echo case specifically.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from transcriber import _looks_like_prompt_echo

VOCAB = ["Claude", "Claude.md", "Codex", "subagent", "sol", "5.6-sol"]

# the exact failure the owner reported (OpenAI, silent recording)
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
# model choice is the defense for those — see DEFAULT_STT_MODELS)
assert not _looks_like_prompt_echo("Of the", VOCAB)
assert not _looks_like_prompt_echo(".", VOCAB)
# no vocabulary configured -> nothing to echo
assert not _looks_like_prompt_echo("Vocabulary: whatever", [])

print("ALL TESTS PASSED")
