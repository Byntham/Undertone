const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";

export type Corrections = Readonly<Record<string, string>>;

export function applyCorrections(text: string, corrections: Corrections): string {
  const entries = Object.entries(corrections)
    .filter(([wrong]) => wrong.length > 0)
    .sort(([left], [right]) => right.length - left.length);
  if (entries.length === 0) return text;

  const alternatives = entries.map(([wrong]) => (
    `(?<!${WORD_CHARACTER})(${escapeRegExp(wrong)})(?!${WORD_CHARACTER})`
  ));
  const pattern = new RegExp(alternatives.join("|"), "giu");
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    const entryIndex = match.slice(1).findIndex((value) => value !== undefined);
    if (index === undefined || entryIndex < 0) continue;
    output += text.slice(cursor, index);
    output += matchCase(match[0], entries[entryIndex]![1]);
    cursor = index + match[0].length;
  }
  return output + text.slice(cursor);
}

export function finalizeTranscript(rawText: string, corrections: Corrections): string {
  return applyCorrections(rawText, corrections).trim();
}

function matchCase(matched: string, replacement: string): string {
  if (Array.from(matched).length > 1
    && matched === matched.toUpperCase()
    && matched !== matched.toLowerCase()) {
    return replacement.toUpperCase();
  }
  const first = Array.from(matched)[0];
  if (first !== undefined && isUpper(first) && replacement === replacement.toLowerCase()) {
    const characters = Array.from(replacement);
    return `${characters[0]?.toUpperCase() ?? ""}${characters.slice(1).join("")}`;
  }
  return replacement;
}

function isUpper(value: string): boolean {
  return /\p{Lu}/u.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
