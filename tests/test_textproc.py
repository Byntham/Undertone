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
    # A digit after a digit is a NEW number, not a continuation.
    assert fmt("4 apples", "I have 3") == " 4 apples"


def test_right_seam():
    # A caret after the existing space needs a trailing separator before the
    # following word; a caret before that space must not add another one.
    assert textproc.finalize(
        "red", "I like ", {}, after_ctx="apples."
    ) == "red "
    # STT's sentence-final period is inappropriate when known text resumes
    # the same sentence after the insertion.
    assert textproc.finalize(
        "red.", "I like ", {}, after_ctx="apples."
    ) == "red "
    assert textproc.finalize(
        "red.", "I like ", {}, after_ctx=" apples."
    ) == "red"
    assert textproc.finalize(
        "red", "I like", {}, after_ctx=" apples."
    ) == " red"
    # Closing punctuation and contractions hug the inserted text.
    assert textproc.finalize(
        "ripe", "They are ", {}, after_ctx=", but bruised."
    ) == "ripe"
    assert textproc.finalize(
        "it", "I think ", {}, after_ctx="'s ready."
    ) == "it"
    # Punctuation/openers at the end of the insertion control the right seam.
    assert textproc.finalize(
        "red,", "I like ", {}, after_ctx="green apples."
    ) == "red, "
    assert textproc.finalize(
        "(", "I like ", {}, after_ctx="red apples)"
    ) == "("
    # Preserve token continuation for paths assembled across the caret.
    assert textproc.finalize(
        "ers", "C:\\Us", {}, after_ctx="\\graham"
    ) == "ers"
    # Unknown or known-empty right context preserves end-of-document behavior.
    assert textproc.finalize("red", "I like ", {}, after_ctx=None) == "red"
    assert textproc.finalize("red", "I like ", {}, after_ctx="") == "red"
    assert textproc.finalize(
        "A new thought.", "Done. ", {}, after_ctx="Next thought."
    ) == "A new thought. "
    assert textproc.finalize(
        "Dr.", "I called ", {}, after_ctx="Smith."
    ) == "Dr. "


def test_url_detection():
    # Real URLs/emails/paths: no space and no capitalization (mid-token).
    assert fmt("mple.com", "check https://exa") == "mple.com"
    assert fmt("cache", "see src/main") == "cache"
    assert fmt("cache", "in C:\\Users\\g") == "cache"
    assert fmt("com", "mail me@site.") == "com"
    assert fmt("mple.com", "email me@exa") == "mple.com"   # mid-domain
    assert fmt("/api", "hit localhost:8080") == "/api"
    assert fmt("\\Users", "C:") == "\\Users"                # drive letter
    # A bare @mention is prose, not an email being continued.
    assert fmt("about this", "ping @graham") == " about this"
    # Times, ratios, dates, and trailing colons are prose, not URLs.
    assert fmt("in the afternoon", "the time is 12:30") == " in the afternoon"
    assert fmt("overall", "the ratio is 3:1") == " overall"
    assert fmt("happened", "on 9/11") == " happened"
    assert fmt("next step", "Agenda:") == " next step"


def test_caps():
    assert fmt("The cat", "I saw") == " the cat"          # mid-sentence -> the
    assert fmt("Graham left", "I saw") == " Graham left"  # proper noun stays
    assert fmt("I think so", "yes and") == " I think so"  # never lower "I"
    assert fmt("hello", "") == "Hello"                    # sentence start caps
    # Abbreviations do not start a new sentence.
    assert fmt("things", "for e.g.") == " things"
    assert fmt("smith", "spoke to Dr.") == " smith"
    # Dotted abbreviations do not either.
    assert fmt("economy is strong", "in the U.S.") == " economy is strong"
    assert fmt("tomorrow", "at 9 a.m.") == " tomorrow"
    # A real full stop does start a sentence.
    assert fmt("hello", "Done.") == " Hello"
    # A name initial is an abbreviation; a lone letter/number ending is not.
    assert fmt("kennedy spoke", "ask John F.") == " kennedy spoke"
    assert fmt("it was great", "I got an A.") == " It was great"
    assert fmt("then we left", "there are 3.") == " Then we left"
    # An ellipsis trails off: the thought continues, no capital.
    assert fmt("and then", "please wait...") == " and then"
    # Unicode first letters capitalize too.
    assert fmt("élan matters", "") == "Élan matters"
    # Deliberately-cased words are left alone at sentence starts.
    assert fmt("iPhone works", "") == "iPhone works"


def test_quotes():
    # An opening quote after a word needs a space before it.
    assert fmt('"hello" she said', "he said") == ' "hello" she said'
    # ...and the first word inside it still gets the sentence capital.
    assert fmt('"hello" she said', "Done.") == ' "Hello" she said'
    # A possessive apostrophe at the end of ctx is closing punctuation.
    assert fmt("car arrived", "James'") == " car arrived"
    # A quote opened in ctx hugs (and is not a sentence start).
    assert fmt("hello", 'he said "') == "hello"
    # A leading contraction is not an opening quote: it hugs.
    assert fmt("'s ready", "it") == "'s ready"
    # A closed quote in ctx still shows the terminator through it.
    assert fmt("next", 'he said "stop."') == " Next"


def test_corrections():
    corr = {"under tone": "Undertone", "asap": "ASAP"}
    assert textproc.apply_corrections("the under tone app", corr) == "the Undertone app"
    assert textproc.apply_corrections("UNDER TONE", corr) == "UNDERTONE"   # allcaps
    assert textproc.apply_corrections("do it asap", corr) == "do it ASAP"
    # Word boundary: must not match inside another word.
    assert textproc.apply_corrections("thunderstorm", {"under": "over"}) == "thunderstorm"
    # Case-insensitive multi-word phrase.
    assert textproc.apply_corrections("Under Tone", corr) == "Undertone"
    # Symbol-bearing keys match despite \b having no anchor there...
    assert textproc.apply_corrections("i like c++", {"c++": "C++"}) == "i like C++"
    # ...but never as a prefix of a larger token.
    assert textproc.apply_corrections(
        "C++17 is current", {"c++": "C Plus Plus"}) == "C++17 is current"
    # Unicode text survives case-insensitive matching (no lookup by .lower()).
    assert textproc.apply_corrections("İstanbul is big", {"i": "I"}) == \
        "İstanbul is big"
    # One pass: a replacement is never re-matched by another entry.
    assert textproc.apply_corrections(
        "under tone", {"under tone": "Undertone", "undertone": "Product"}
    ) == "Undertone"
    # Authored casing is authoritative; a Capitalized match must not mangle it.
    assert textproc.apply_corrections("Iphone", {"iphone": "iPhone"}) == "iPhone"


def test_strip_chat_period():
    assert textproc.strip_chat_period("See you soon.") == "See you soon"
    assert textproc.strip_chat_period("One. Two. Three.") == "One. Two. Three."
    assert textproc.strip_chat_period("Wait...") == "Wait..."
    # An abbreviation's own period is never stripped.
    assert textproc.strip_chat_period("I need milk, eggs, etc.") == \
        "I need milk, eggs, etc."
    assert textproc.strip_chat_period("Ask Dr.") == "Ask Dr."
    # A sentence ending in a number is a normal sentence.
    assert textproc.strip_chat_period("See you at 3.") == "See you at 3"
    # An interior decimal is not a sentence boundary.
    assert textproc.strip_chat_period("It is 3.5 now.") == "It is 3.5 now"
    # Removing the period must preserve a right-seam space.
    assert textproc.strip_chat_period("See you. ") == "See you "


def test_seam():
    # Boundary pass for AI-cleaned text: spacing plus sentence-start caps
    # only; mid-sentence casing is the model's job and is left alone.
    assert textproc.seam("the fix works", "I checked and") == " the fix works"
    assert textproc.seam("hello there", "Done.") == " Hello there"
    assert textproc.seam("  padded", "word") == " padded"   # model whitespace
    assert textproc.seam("anything", None) == "anything"
    assert textproc.seam("Kept As Is", "I saw") == " Kept As Is"
    # The seam capitalizes through a leading quote too.
    assert textproc.seam('"hello"', "Done.") == ' "Hello"'


def test_finalize():
    # The dictionary stays authoritative after AI cleanup: if the model
    # reverts a term, finalize re-corrects it.
    corr = {"under tone": "Undertone"}
    assert textproc.finalize("the under tone app", "Done.", corr,
                             model_cased=True) == " The Undertone app"
    # model_cased never lowercases the model's body casing.
    assert textproc.finalize("Kept As Is", "I saw", {},
                             model_cased=True) == " Kept As Is"


def main():
    test_spacing()
    test_right_seam()
    test_url_detection()
    test_caps()
    test_quotes()
    test_corrections()
    test_strip_chat_period()
    test_seam()
    test_finalize()
    print("ALL TESTS PASSED")


if __name__ == "__main__":
    main()
