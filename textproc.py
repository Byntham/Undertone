"""Smart formatting of transcripts before they are pasted at the caret.

Given the raw STT text plus bounded text on either side of the caret, this
joins both insertion seams and adjusts the first word's capitalization so
dictation reads as if it were typed in place. It is deliberately conservative:
when context on a side is unknown (None), nothing risky is done on that side,
and mid-sentence casing is only lowered for a closed set of English function
words.

Both pipeline branches (AI cleanup and the deterministic fallback) funnel
through finalize(), so the dictionary and the boundary rules behave the same
regardless of whether the cleanup call succeeded.
"""

import re

# --- Character classes ------------------------------------------------------

# After one of these at the end of ctx, new text hugs the delimiter. Straight
# quotes are ambiguous and get direction checks (_quote_is_closing/_opening).
_OPENING_DELIMS = set("([{\"'“‘")  # ( [ { " ' “ ‘
# When text starts with one of these it hugs the preceding word.
_CLOSING_PUNCT = set(",.!?;:)]}…'\"”’")  # , . ! ? ; : ) ] } … ' " ” ’
_STRAIGHT_QUOTES = "\"'"
# Invisible markers some accessibility providers expose at an otherwise empty
# text boundary. They affect neither visible spacing nor sentence casing.
_CARET_ARTIFACTS = "\u200b\ufeff"

# Abbreviations whose trailing period does not end a sentence.
_ABBREVIATIONS = {
    "i.e", "e.g", "etc", "vs", "dr", "mr", "mrs", "ms", "prof", "st", "approx",
}

# Conservative closed set of function words that may be lowercased when they
# appear capitalized mid-sentence. Never includes "i" (see _should_lowercase).
_FUNCTION_WORDS = {
    "the", "a", "an", "and", "but", "or", "so", "to", "of", "in", "on", "at",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "it", "its", "this", "that", "these", "those", "there",
    "then", "than", "they", "them", "their", "we", "our", "you", "your", "he",
    "she", "his", "her", "him", "has", "have", "had", "do", "does", "did",
    "will", "would", "can", "could", "should", "shall", "may", "might", "must",
    "not", "no", "if", "when", "while", "because", "about", "into", "over",
    "under", "after", "before", "between", "through", "during", "against",
    "also", "just", "only", "some", "any", "all", "more", "most", "other",
    "such", "what", "which", "who", "how", "where", "why", "up", "down", "out",
    "off",
}

# Chat/messenger apps where a lone trailing period reads as stiff punctuation.
CHAT_APPS: frozenset = frozenset({
    "slack.exe", "discord.exe", "telegram.exe", "whatsapp.exe", "ms-teams.exe",
    "teams.exe", "signal.exe", "messenger.exe",
})

# The word (letters/dots) ending at a trailing period, for abbreviation checks.
_TRAILING_WORD = re.compile(r"([A-Za-z][A-Za-z.]*)\.$")
# First word of the new text, seen through any leading punctuation. The letter
# class is unicode-aware so accented first words still get capitalized.
_FIRST_WORD = re.compile(r"[^\w]*([^\W\d_][\w']*)")


def apply_corrections(text: str, corrections: dict) -> str:
    """Replace each `wrong` key with its `right` value at word boundaries.

    All keys are matched in ONE pass (longest key first), so one entry's
    replacement can never be re-matched by another entry. Matching is
    case-insensitive; keys may be multi-word phrases or carry symbols (c++).
    An ALL-CAPS match upper-cases the replacement; a Capitalized match
    capitalizes it only when the replacement was authored in lowercase —
    deliberate casing like "iPhone" is authoritative.
    """
    entries = [(w, r) for w, r in corrections.items() if w]
    if not entries:
        return text
    entries.sort(key=lambda e: len(e[0]), reverse=True)
    # One capturing group per key: the winning entry is identified by
    # m.lastindex, never by re-lowercasing the matched text (case-insensitive
    # matching and str.lower() disagree on characters like Turkish İ).
    # (?<!\w)/(?!\w) instead of \b: \b has no anchor next to a symbol, so a
    # key like "c++" would otherwise also match inside "C++17".
    parts = [r"((?<!\w)" + re.escape(w) + r"(?!\w))" for w, _ in entries]
    pattern = re.compile("|".join(parts), re.IGNORECASE)
    return pattern.sub(
        lambda m: _match_case(m.group(0), entries[m.lastindex - 1][1]), text)


def _match_case(matched: str, right: str) -> str:
    if matched.isupper() and len(matched) > 1:
        return right.upper()
    if matched[:1].isupper() and right == right.lower():
        return right[:1].upper() + right[1:]
    return right


def finalize(text: str, ctx: "str | None", corrections: dict,
             smart: bool = True, model_cased: bool = False,
             after_ctx: "str | None" = None) -> str:
    """The one dictionary + boundary pass both pipeline branches share.

    Corrections are (re-)applied here so the dictionary stays authoritative
    even when the cleanup model rewrote a term. model_cased=True means an AI
    cleanup pass owns the body casing: the first word may still be capitalized
    at a sentence start, but is never lowercased. Unknown context (None) means
    do nothing risky on that side of the insertion.
    """
    # Providers normally trim already, but boundary formatting must be robust
    # to model overrides and retry inputs too. Outer whitespace is never
    # meaningful dictated content; leaving it here creates double seams.
    text = apply_corrections(text, corrections).strip()
    if not smart or not text:
        return text

    if ctx is not None:
        seam_ctx = ctx.rstrip(_CARET_ARTIFACTS)
        seam_after = (after_ctx.lstrip(_CARET_ARTIFACTS)
                      if after_ctx is not None else None)
        mid_token = _in_url_like(seam_ctx)
        if not mid_token:
            text = _adjust_capitalization(seam_ctx, text,
                                          allow_lower=not model_cased)
        if _needs_leading_space(seam_ctx, text, mid_token):
            text = " " + text
        text = _dedupe_right_punctuation(text, seam_after)
        text = _drop_mid_sentence_period(
            text, seam_ctx, seam_after, mid_token)
        return _add_right_seam(text, seam_ctx, seam_after)
    return _add_right_seam(text, None, after_ctx)


def format_transcript(
    text: str, ctx: "str | None", corrections: dict, smart: bool = True,
    after_ctx: "str | None" = None,
) -> str:
    """Deterministic-path formatting (no AI cleanup): the full pass."""
    return finalize(text, ctx, corrections, smart=smart, after_ctx=after_ctx)


def seam(text: str, ctx: "str | None",
         after_ctx: "str | None" = None) -> str:
    """Boundary-only pass for AI-cleaned text.

    The cleanup model handles the transcript body (including mid-sentence
    lowercasing, which needs proper-noun judgment); this fixes only the
    mechanical seams, which rules get right more reliably than the model.
    """
    return finalize(text, ctx, {}, model_cased=True, after_ctx=after_ctx)


def _add_right_seam(text: str, ctx: "str | None",
                    after_ctx: "str | None") -> str:
    """Add a separator between inserted text and known text to its right."""
    if (after_ctx is None or not after_ctx or not text
            or after_ctx[0].isspace()):
        return text
    combined_left = (ctx or "") + text
    mid_token = _in_url_like(combined_left)
    if _needs_leading_space(combined_left, after_ctx, mid_token):
        return text + " "
    return text


def _drop_mid_sentence_period(text: str, ctx: str,
                              after_ctx: "str | None",
                              mid_token: bool) -> str:
    """Drop STT's final period when known text continues the sentence."""
    if (after_ctx is None or mid_token or _is_sentence_start(ctx)
            or not _right_continues_sentence(after_ctx)):
        return text
    stripped = text.rstrip()
    if (not stripped.endswith(".") or stripped.endswith("..")
            or _abbrev_period(stripped)):
        return text
    return stripped[:-1] + text[len(stripped):]


def _dedupe_right_punctuation(text: str,
                              after_ctx: "str | None") -> str:
    """Let an identical punctuation mark already on the right win once."""
    if after_ctx is None:
        return text
    right = after_ctx.lstrip()
    stripped = text.rstrip()
    if (not stripped or not right or stripped[-1] != right[0]
            or stripped[-1] not in ",.!?;:"
            or (len(stripped) >= 2 and stripped[-2] == stripped[-1])):
        return text
    return stripped[:-1] + text[len(stripped):]


def _right_continues_sentence(after_ctx: str) -> bool:
    """Strong local evidence that right-side text resumes this sentence."""
    right = after_ctx.lstrip()
    if not right:
        return False
    first = right[0]
    return (first.islower() or first.isdigit()
            or first in ",.!?;:)]}\u2026'\u2019\u201d")


def _needs_leading_space(ctx: str, text: str, mid_token: bool) -> bool:
    if not ctx:
        return False
    if ctx[-1].isspace():
        return False
    if ctx[-1] in _OPENING_DELIMS and not _quote_is_closing(ctx):
        return False
    if text[:1] in _CLOSING_PUNCT and not _quote_is_opening(text):
        return False
    if mid_token:
        return False
    return True


def _quote_is_closing(ctx: str) -> bool:
    """ctx ends with a straight quote: closing (possessive or end-quote) when
    it hugs a word or terminator on its left ("James'", 'said "hi."'), opening
    when it follows a space or another opener."""
    if ctx[-1] not in _STRAIGHT_QUOTES:
        return False
    return (len(ctx) > 1 and not ctx[-2].isspace()
            and ctx[-2] not in _OPENING_DELIMS)


def _quote_is_opening(text: str) -> bool:
    """text starts with a double quote glued to a letter: an opening quote,
    which still needs a space before it ('he said' + '"hello"'). Apostrophes
    are exempt — a leading '...'s/'re/'ll is a contraction that must hug."""
    return (text[0] in "\"“" and len(text) > 1
            and (text[1].isalnum() or text[1] in "\"'“‘"))


def _in_url_like(ctx: str) -> bool:
    """True when ctx's trailing token looks like a URL, email, or path.

    In that case the new text continues the same token, so we neither add a
    space nor touch capitalization. Requires real evidence — a scheme, www.,
    an @-domain, a lettered path, or host:port — so that times (12:30),
    ratios (3:1), dates (9/11), and trailing colons ("Agenda:") stay prose.
    """
    if not ctx or ctx[-1].isspace():
        return False
    tail = ctx.rsplit(None, 1)[-1]
    if "://" in tail or tail.lower().startswith("www."):
        return True
    # An email even mid-domain ("me@exa" + "mple.com"), but not a bare
    # @mention ("ping @graham" reads as prose).
    if re.search(r"\S@\S", tail):
        return True
    if re.fullmatch(r"[A-Za-z]:", tail):             # drive letter (C:)
        return True
    if re.search(r"[A-Za-z][\w.+-]*:\d", tail):      # host:port
        return True
    if re.search(r"[/\\]", tail) and re.search(r"[A-Za-z]", tail):  # path
        return True
    return False


def _is_sentence_start(ctx: "str | None") -> bool:
    if ctx is None or ctx.strip() == "":
        return True
    # A trailing newline means a fresh line/paragraph.
    if ctx.rstrip(" \t").endswith("\n"):
        return True
    # Ignore closing quotes/brackets sitting after the real terminator
    # (e.g.  he said "hello." )  so we still see the "." .
    trimmed = ctx.rstrip().rstrip("\"'”’)]}").rstrip()
    if not trimmed:
        return True
    if trimmed.endswith(("...", "…")):
        return False  # an ellipsis trails off; the thought continues
    last = trimmed[-1]
    if last in "!?":
        return True
    if last == ".":
        return not _abbrev_period(trimmed)
    return False


def _abbrev_period(trimmed: str) -> bool:
    """Whether the trailing period of `trimmed` is an abbreviation, not a
    sentence end.

    True for known abbreviations (etc., Dr.), dotted forms (U.S., a.m.,
    Ph.D.), and a single capital following a capitalized word (a name
    initial: "John F."). A trailing digit or any other lone letter ends the
    sentence ("There are 3.", "I got an A.").
    """
    m = _TRAILING_WORD.search(trimmed)
    if not m:
        return False
    word = m.group(1)
    if "." in word:
        return True
    if word.lower() in _ABBREVIATIONS:
        return True
    if len(word) == 1 and word.isupper():
        prev = trimmed[: m.start(1)].rstrip()
        prev_word = prev.rsplit(None, 1)[-1] if prev else ""
        return prev_word[:1].isupper()
    return False


def _adjust_capitalization(ctx: "str | None", text: str,
                           allow_lower: bool = True) -> str:
    m = _FIRST_WORD.match(text)
    if not m:
        return text
    word = m.group(1)
    start = m.start(1)
    rest = text[start + len(word):]
    if _is_sentence_start(ctx):
        # Leave deliberately-cased words (iPhone, camelCase) alone.
        if word[:1].islower() and not any(c.isupper() for c in word[1:]):
            word = word[0].upper() + word[1:]
    elif allow_lower and word[:1].isupper() and _should_lowercase(word):
        word = word[0].lower() + word[1:]
    return text[:start] + word + rest


def _should_lowercase(word: str) -> bool:
    lw = word.lower()
    if lw == "i" or lw.startswith("i'"):  # never lowercase I, I'm, I'll, ...
        return False
    return lw in _FUNCTION_WORDS


def strip_chat_period(text: str) -> str:
    """Drop a lone trailing period from a short (<=2 sentence) chat message.

    Leaves "...", "?.", and longer multi-sentence text untouched.
    """
    stripped = text.rstrip()
    if not stripped.endswith(".") or stripped.endswith(".."):
        return text
    if len(stripped) >= 2 and stripped[-2] in "!?":
        return text
    if _abbrev_period(stripped):
        return text  # the period belongs to "etc.", "Dr.", an initial, ...
    if _count_sentences(stripped) > 2:
        return text
    return stripped[:-1] + text[len(stripped):]


def _count_sentences(text: str) -> int:
    n = 0
    for m in re.finditer(r"[.!?]+", text):
        run = m.group(0)
        if set(run) <= {"."}:
            if text[m.end(): m.end() + 1].isdigit():
                continue  # a decimal point (3.5), not an end
            if _abbrev_period(text[: m.end()]):
                continue
        n += 1
    return n


def tail_context(last_paste: str, n: int = 120) -> str:
    """Last n characters of a previous paste, usable as pseudo-ctx."""
    return last_paste[-n:] if last_paste else ""
