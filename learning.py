"""Learns correction pairs from the "fix last dictation" flow.

When the user edits a just-pasted transcript, observe() diffs the original
against the correction at the word level and tallies each (wrong -> right)
substitution in a small JSON file. Once a pair has been seen `threshold`
times it is promoted (returned and cleared) so the caller can add it to the
persistent corrections list. A guard skips common English words, which are far
more likely mis-transcribed from context than a real vocabulary term the user
keeps having to fix -- except case-only changes ("graham" -> "Graham"), which
are always learnable.
"""

import difflib
import json
import pathlib
import string

# Common words the STT may plausibly mis-hear from context; not worth learning
# as vocabulary. Function words plus frequent everyday words (~200).
_COMMON_WORDS = {
    "the", "a", "an", "and", "but", "or", "so", "to", "of", "in", "on", "at",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be",
    "been", "being", "am", "it", "its", "this", "that", "these", "those",
    "there", "then", "than", "they", "them", "their", "we", "our", "us", "you",
    "your", "yours", "he", "she", "his", "her", "hers", "him", "i", "me", "my",
    "mine", "has", "have", "had", "having", "do", "does", "did", "doing",
    "done", "will", "would", "can", "could", "should", "shall", "may", "might",
    "must", "not", "no", "yes", "if", "when", "while", "because", "about",
    "into", "onto", "over", "under", "after", "before", "between", "through",
    "during", "against", "also", "just", "only", "some", "any", "all", "none",
    "more", "most", "less", "least", "much", "many", "few", "other", "another",
    "such", "same", "own", "what", "which", "who", "whom", "whose", "how",
    "where", "why", "here", "up", "down", "out", "off", "again", "once",
    "very", "too", "now", "new", "old", "good", "bad", "great", "little",
    "big", "small", "long", "high", "right", "left", "next", "last", "first",
    "get", "got", "go", "going", "went", "come", "came", "make", "made",
    "take", "took", "see", "saw", "look", "want", "need", "know", "knew",
    "think", "thought", "say", "said", "tell", "told", "give", "gave", "find",
    "found", "use", "used", "work", "call", "try", "ask", "feel", "seem",
    "let", "keep", "put", "mean", "show", "turn", "start", "end", "day",
    "time", "year", "way", "man", "woman", "people", "thing", "life", "world",
    "hand", "part", "place", "week", "case", "point", "number", "group",
    "problem", "fact", "back", "even", "still", "well", "like", "one", "two",
    "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "hello", "hi", "hey", "okay", "ok", "please", "thanks", "thank", "sorry",
}

_PUNCT = string.punctuation + " "


class CorrectionLearner:
    def __init__(self, path, threshold: int = 2):
        self.path = pathlib.Path(path)
        self.threshold = threshold
        self._counts = self._load()

    def observe(self, original: str, corrected: str) -> list:
        """Tally the substitutions turning `original` into `corrected`.

        Returns the list of (wrong, right) pairs that reached the threshold on
        this call (and are now cleared). The caller deduplicates against any
        pairs it already knows.
        """
        promoted = []
        for wrong, right in self._diff_pairs(original, corrected):
            if self._skip(wrong, right):
                continue
            key = wrong + "\t" + right
            self._counts[key] = self._counts.get(key, 0) + 1
            if self._counts[key] >= self.threshold:
                promoted.append((wrong, right))
                del self._counts[key]
        self._save()
        return promoted

    def _diff_pairs(self, original: str, corrected: str) -> list:
        a = original.split()
        b = corrected.split()
        matcher = difflib.SequenceMatcher(a=a, b=b, autojunk=False)
        pairs = []
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag != "replace":
                continue
            wrong = " ".join(a[i1:i2])
            right = " ".join(b[j1:j2])
            # Ignore pure whitespace/punctuation-only differences.
            if _has_word(wrong) and _has_word(right):
                pairs.append((wrong.lower(), right))
        return pairs

    def _skip(self, wrong: str, right: str) -> bool:
        w = wrong.strip(_PUNCT).lower()
        r = right.strip(_PUNCT).lower()
        if w == r:  # case-only change -- always learnable
            return False
        if " " in w:  # multi-word phrases are treated as vocabulary
            return False
        return w in _COMMON_WORDS

    def _load(self) -> dict:
        try:
            with open(self.path, "r", encoding="utf-8-sig") as f:
                data = json.load(f)
            if isinstance(data, dict):
                return {k: int(v) for k, v in data.items()}
        except (FileNotFoundError, ValueError, OSError, TypeError):
            pass
        return {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._counts, f, indent=2, sort_keys=True)


def _has_word(text: str) -> bool:
    """True when text contains at least one alphanumeric character."""
    return any(ch.isalnum() for ch in text)
