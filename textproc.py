"""Smart formatting of transcripts before they are pasted at the caret.

Given the raw STT text plus the text immediately before the caret (`ctx`, from
caretctx), this decides whether to prepend a leading space and whether to
adjust the first word's capitalization, so dictation reads as if it were typed
in place. It is deliberately conservative: when the context is unknown (None)
nothing risky is done, and mid-sentence casing is only lowered for a closed set
of English function words.
"""

import re

# --- Character classes ------------------------------------------------------

# After one of these at the end of ctx, new text hugs the delimiter.
_OPENING_DELIMS = set("([{\"'“‘")  # ( [ { " ' “ ‘
# When text starts with one of these it hugs the preceding word.
_CLOSING_PUNCT = set(",.!?;:)]}…'\"")  # , . ! ? ; : ) ] } … ' "

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

# A trailing run that contains a : / or @ (URL, email, or path fragment).
_URL_TAIL = re.compile(r"[\w.:/@#~-]*[:/@][\w.:/@#~-]*$")
# The word (letters/dots) ending at a trailing period, for abbreviation checks.
_TRAILING_WORD = re.compile(r"([A-Za-z][A-Za-z.]*)\.$")


def apply_corrections(text: str, corrections: dict) -> str:
    """Replace each `wrong` key with its `right` value at word boundaries.

    Matching is case-insensitive; keys may be multi-word phrases. The casing of
    the matched text is carried onto the replacement: an ALL-CAPS match yields
    an upper-cased replacement, a Capitalized match a capitalized one, and any
    other match the replacement exactly as authored.
    """
    for wrong, right in corrections.items():
        if not wrong:
            continue
        pattern = re.compile(r"\b" + re.escape(wrong) + r"\b", re.IGNORECASE)
        text = pattern.sub(lambda m, r=right: _match_case(m.group(0), r), text)
    return text


def _match_case(matched: str, right: str) -> str:
    if matched.isupper():
        return right.upper()
    if matched[:1].isupper():
        return right[:1].upper() + right[1:]
    return right


def format_transcript(
    text: str, ctx: "str | None", corrections: dict, smart: bool = True
) -> str:
    """Return the final string to paste, including any leading space.

    Corrections are always applied first. When `smart` is False that is all;
    otherwise spacing and capitalization are adjusted against `ctx` (the text
    just before the caret, or None when unknown). Unknown context means do
    nothing risky: no leading space and no capitalization change.
    """
    text = apply_corrections(text, corrections)
    if not smart or ctx is None or not text:
        return text

    mid_token = _in_url_like(ctx)
    space = _needs_leading_space(ctx, text, mid_token)
    if not mid_token:
        text = _adjust_capitalization(ctx, text)
    return (" " if space else "") + text


def _needs_leading_space(ctx: str, text: str, mid_token: bool) -> bool:
    if not ctx:
        return False
    if ctx[-1].isspace():
        return False
    if ctx[-1] in _OPENING_DELIMS:
        return False
    if text[:1] in _CLOSING_PUNCT:
        return False
    if mid_token:
        return False
    if ctx[-1].isdigit() and text[:1].isdigit():
        return False
    return True


def _in_url_like(ctx: str) -> bool:
    """True when ctx's trailing token looks like a URL, email, or path.

    In that case the new text continues the same token, so we neither add a
    space nor touch capitalization.
    """
    if not ctx or ctx[-1].isspace():
        return False
    if _URL_TAIL.search(ctx):
        return True
    tail = ctx.rsplit(None, 1)[-1].lower()
    return tail.startswith(("www.", "http://", "https://"))


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
    last = trimmed[-1]
    if last in "!?":
        return True
    if last == ".":
        return not _abbrev_period(trimmed)
    return False


def _abbrev_period(trimmed: str) -> bool:
    """Whether the trailing period of `trimmed` is an abbreviation/decimal.

    True for known abbreviations (etc., Dr., ...) and for a period following a
    single letter or a digit ("e.g" -> the "g.", "3.") -- none of which ends a
    sentence.
    """
    m = _TRAILING_WORD.search(trimmed)
    if not m:
        # Period follows a non-letter: treat a preceding digit as a decimal.
        return len(trimmed) >= 2 and trimmed[-2].isdigit()
    word = m.group(1).rstrip(".").lower()
    return len(word) == 1 or word in _ABBREVIATIONS


def _adjust_capitalization(ctx: "str | None", text: str) -> str:
    m = re.match(r"[^\w]*([A-Za-z']+)", text)
    if not m:
        return text
    word = m.group(1)
    start = m.start(1)
    rest = text[start + len(word):]
    if _is_sentence_start(ctx):
        if word[:1].islower():
            word = word[0].upper() + word[1:]
    elif word[:1].isupper() and _should_lowercase(word):
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
        return text  # the period belongs to "etc.", "Dr.", a decimal, ...
    if _count_sentences(stripped) > 2:
        return text
    return stripped[:-1]


def _count_sentences(text: str) -> int:
    n = 0
    for m in re.finditer(r"[.!?]+", text):
        run = m.group(0)
        # A run of only periods might be an abbreviation/decimal, not an end.
        if set(run) <= {"."} and _abbrev_period(text[: m.end()]):
            continue
        n += 1
    return n


def seam(text: str, ctx: "str | None") -> str:
    """Boundary-only pass for AI-cleaned text: leading space + sentence cap.

    The cleanup model handles the transcript body (including mid-sentence
    lowercasing, which needs proper-noun judgment); this fixes only the
    mechanical seam against ctx, which rules get right more reliably than
    the model does.
    """
    if not text:
        return text
    text = text.lstrip()
    if not text or ctx is None:
        return text
    mid_token = _in_url_like(ctx)
    if not mid_token and _is_sentence_start(ctx) and text[:1].islower():
        text = text[0].upper() + text[1:]
    space = _needs_leading_space(ctx, text, mid_token)
    return (" " if space else "") + text


def tail_context(last_paste: str, n: int = 120) -> str:
    """Last n characters of a previous paste, usable as pseudo-ctx."""
    return last_paste[-n:] if last_paste else ""
