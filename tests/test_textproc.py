"""Manual assert-based tests for textproc (no pytest).

Run with the venv python:
    .venv\\Scripts\\python.exe tests\\test_textproc.py

Pure logic only -- no Windows desktop or network needed.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import textproc  # noqa: E402


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
    # An abbreviation's own period is never stripped.
    assert textproc.strip_chat_period("I need milk, eggs, etc.") == \
        "I need milk, eggs, etc."
    assert textproc.strip_chat_period("Ask Dr.") == "Ask Dr."
    assert textproc.strip_chat_period("Pi is 3.") == "Pi is 3."


def test_seam():
    # Boundary pass for AI-cleaned text: spacing plus sentence-start caps
    # only; mid-sentence casing is the model's job and is left alone.
    assert textproc.seam("the fix works", "I checked and") == " the fix works"
    assert textproc.seam("hello there", "Done.") == " Hello there"
    assert textproc.seam("  padded", "word") == " padded"   # model whitespace
    assert textproc.seam("anything", None) == "anything"
    assert textproc.seam("Kept As Is", "I saw") == " Kept As Is"


def main():
    test_spacing()
    test_caps()
    test_corrections()
    test_strip_chat_period()
    test_seam()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
