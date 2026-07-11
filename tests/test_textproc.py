"""Manual assert-based tests for textproc and learning (no pytest).

Run with the venv python:
    .venv\\Scripts\\python.exe tests\\test_textproc.py

Pure logic only -- no Windows desktop or network needed.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import textproc  # noqa: E402
import learning  # noqa: E402


def fmt(text, ctx, corrections=None, smart=True):
    return textproc.format_transcript(text, ctx, corrections or {}, smart)


def test_spacing():
    assert fmt("world", "hello") == " world"          # after word -> space
    assert fmt("nested", "(") == "nested"             # after "(" -> none
    assert fmt("hi", "") == "Hi"                       # empty ctx -> no space
    assert fmt("keep this", None) == "keep this"       # None ctx -> unchanged
    assert fmt("line", "para\n") == "Line"             # after newline -> no space
    assert fmt(", yes", "hello") == ", yes"            # leading closing punct
    assert fmt("4 apples", "I have 3") == "4 apples"   # digit + digit -> none
    # URL tail: no space and no capitalization change (mid-token).
    assert fmt("mple.com", "check https://exa") == "mple.com"


def test_caps():
    assert fmt("The cat", "I saw") == " the cat"          # mid-sentence -> the
    assert fmt("Graham left", "I saw") == " Graham left"  # proper noun stays
    assert fmt("I think so", "yes and") == " I think so"  # never lower "I"
    assert fmt("hello", "") == "Hello"                    # sentence start caps
    # Abbreviations do not start a new sentence.
    assert fmt("things", "for e.g.") == " things"
    assert fmt("smith", "spoke to Dr.") == " smith"
    # A real full stop does start a sentence.
    assert fmt("hello", "Done.") == " Hello"


def test_corrections():
    corr = {"under tone": "Undertone", "asap": "ASAP"}
    assert textproc.apply_corrections("the under tone app", corr) == "the Undertone app"
    assert textproc.apply_corrections("UNDER TONE", corr) == "UNDERTONE"   # allcaps
    assert textproc.apply_corrections("do it asap", corr) == "do it ASAP"
    # Word boundary: must not match inside another word.
    assert textproc.apply_corrections("thunderstorm", {"under": "over"}) == "thunderstorm"
    # Case-insensitive multi-word phrase.
    assert textproc.apply_corrections("Under Tone", corr) == "Undertone"


def test_strip_chat_period():
    assert textproc.strip_chat_period("See you soon.") == "See you soon"
    assert textproc.strip_chat_period("One. Two. Three.") == "One. Two. Three."
    assert textproc.strip_chat_period("Wait...") == "Wait..."


def test_learner():
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "sub", "learning.json")

        # Same fix observed twice promotes exactly once (threshold 2).
        learner = learning.CorrectionLearner(path)
        assert learner.observe("open the undertone app", "open the Undertone app") == []
        promoted = learner.observe("run undertone now", "run Undertone now")
        assert promoted == [("undertone", "Undertone")], promoted

        # Common-word guard: "there" -> "their" is never learned.
        guard = learning.CorrectionLearner(os.path.join(d, "guard.json"), threshold=1)
        assert guard.observe("go there now", "go their now") == []

        # Case-only change is learnable.
        caseonly = learning.CorrectionLearner(os.path.join(d, "case.json"), threshold=1)
        assert caseonly.observe("hi graham", "hi Graham") == [("graham", "Graham")]

    # Corrupt JSON is tolerated (starts empty).
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "bad.json")
        with open(path, "w", encoding="utf-8") as f:
            f.write("{not valid json")
        learner = learning.CorrectionLearner(path, threshold=1)
        assert learner.observe("say foo", "say bar") == [("foo", "bar")]


def main():
    test_spacing()
    test_caps()
    test_corrections()
    test_strip_chat_period()
    test_learner()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
