const OPENING_DELIMITERS = new Set(Array.from("([{\"'“‘"));
const CLOSING_PUNCTUATION = new Set(Array.from(",.!?;:)]}…'\"”’"));
const STRAIGHT_QUOTES = new Set(["\"", "'"]);
const CARET_ARTIFACTS = new Set(["\u200b", "\ufeff"]);

const ABBREVIATIONS = new Set([
  "i.e", "e.g", "etc", "vs", "dr", "mr", "mrs", "ms", "prof", "st", "approx",
]);

const FUNCTION_WORDS = new Set([
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
]);

export const CHAT_APPS = new Set([
  "slack.exe", "discord.exe", "telegram.exe", "whatsapp.exe", "ms-teams.exe",
  "teams.exe", "signal.exe", "messenger.exe",
]);

const TRAILING_WORD = /([A-Za-z][A-Za-z.]*)\.$/u;
const FIRST_WORD = /^[^\p{L}\p{M}\p{N}_]*(\p{L}[\p{L}\p{M}\p{N}_']*)/u;
const WORD_CHARACTER = "[\\p{L}\\p{M}\\p{N}_]";

export type Corrections = Readonly<Record<string, string>>;

export interface FinalizeOptions {
  smart?: boolean;
  modelCased?: boolean;
  afterContext?: string | null;
}

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

export function finalize(
  rawText: string,
  context: string | null,
  corrections: Corrections,
  options: FinalizeOptions = {},
): string {
  const smart = options.smart ?? true;
  const modelCased = options.modelCased ?? false;
  const afterContext = options.afterContext ?? null;
  let text = applyCorrections(rawText, corrections).trim();
  if (!smart || text.length === 0) return text;

  if (context !== null) {
    const seamContext = trimEndSet(context, CARET_ARTIFACTS);
    const seamAfter = afterContext === null
      ? null
      : trimStartSet(afterContext, CARET_ARTIFACTS);
    const midToken = inUrlLike(seamContext);
    if (!midToken) {
      text = adjustCapitalization(seamContext, text, !modelCased);
    }
    if (needsLeadingSpace(seamContext, text, midToken)) text = ` ${text}`;
    text = dedupeRightPunctuation(text, seamAfter);
    text = dropMidSentencePeriod(text, seamContext, seamAfter, midToken);
    return addRightSeam(text, seamContext, seamAfter);
  }
  return addRightSeam(text, null, afterContext);
}

export function formatTranscript(
  text: string,
  context: string | null,
  corrections: Corrections = {},
  smart = true,
  afterContext: string | null = null,
): string {
  return finalize(text, context, corrections, { smart, afterContext });
}

export function seam(
  text: string,
  context: string | null,
  afterContext: string | null = null,
): string {
  return finalize(text, context, {}, { modelCased: true, afterContext });
}

export function stripChatPeriod(text: string): string {
  const stripped = text.trimEnd();
  if (!stripped.endsWith(".") || stripped.endsWith("..")) return text;
  if (stripped.length >= 2 && "!?".includes(stripped.at(-2)!)) return text;
  if (abbreviationPeriod(stripped) || countSentences(stripped) > 2) return text;
  return `${stripped.slice(0, -1)}${text.slice(stripped.length)}`;
}

export function tailContext(lastPaste: string, count = 120): string {
  return lastPaste.length === 0 ? "" : lastPaste.slice(-count);
}

function addRightSeam(
  text: string,
  context: string | null,
  afterContext: string | null,
): string {
  if (afterContext === null || afterContext.length === 0 || text.length === 0
    || isWhitespace(afterContext[0]!)) return text;
  const combinedLeft = `${context ?? ""}${text}`;
  const midToken = inUrlLike(combinedLeft);
  return needsLeadingSpace(combinedLeft, afterContext, midToken) ? `${text} ` : text;
}

function dropMidSentencePeriod(
  text: string,
  context: string,
  afterContext: string | null,
  midToken: boolean,
): string {
  if (afterContext === null || midToken || isSentenceStart(context)
    || !rightContinuesSentence(afterContext)) return text;
  const stripped = text.trimEnd();
  if (!stripped.endsWith(".") || stripped.endsWith("..")
    || abbreviationPeriod(stripped)) return text;
  return `${stripped.slice(0, -1)}${text.slice(stripped.length)}`;
}

function dedupeRightPunctuation(text: string, afterContext: string | null): string {
  if (afterContext === null) return text;
  const right = afterContext.trimStart();
  const stripped = text.trimEnd();
  const last = stripped.at(-1);
  if (last === undefined || right.length === 0 || last !== right[0]
    || !",.!?;:".includes(last)
    || (stripped.length >= 2 && stripped.at(-2) === last)) return text;
  return `${stripped.slice(0, -1)}${text.slice(stripped.length)}`;
}

function rightContinuesSentence(afterContext: string): boolean {
  const right = afterContext.trimStart();
  if (right.length === 0) return false;
  const first = right[0]!;
  return isLower(first) || /\p{N}/u.test(first) || ",.!?;:)]}…'’”".includes(first);
}

function needsLeadingSpace(context: string, text: string, midToken: boolean): boolean {
  if (context.length === 0 || isWhitespace(context.at(-1)!)) return false;
  if (OPENING_DELIMITERS.has(context.at(-1)!) && !quoteIsClosing(context)) return false;
  if (CLOSING_PUNCTUATION.has(text[0]!) && !quoteIsOpening(text)) return false;
  return !midToken;
}

function quoteIsClosing(context: string): boolean {
  const last = context.at(-1)!;
  if (!STRAIGHT_QUOTES.has(last)) return false;
  const previous = context.at(-2);
  return previous !== undefined && !isWhitespace(previous)
    && !OPENING_DELIMITERS.has(previous);
}

function quoteIsOpening(text: string): boolean {
  if (!(text[0] === "\"" || text[0] === "“") || text.length < 2) return false;
  return /[\p{L}\p{N}]/u.test(text[1]!) || "\"'“‘".includes(text[1]!);
}

function inUrlLike(context: string): boolean {
  if (context.length === 0 || isWhitespace(context.at(-1)!)) return false;
  const tail = context.split(/\s+/u).at(-1)!;
  if (tail.includes("://") || tail.toLowerCase().startsWith("www.")) return true;
  if (/\S@\S/u.test(tail)) return true;
  if (/^[A-Za-z]:$/u.test(tail)) return true;
  if (/[A-Za-z][\p{L}\p{M}\p{N}_.+-]*:\d/u.test(tail)) return true;
  return /[/\\]/u.test(tail) && /[A-Za-z]/u.test(tail);
}

function isSentenceStart(context: string | null): boolean {
  if (context === null || context.trim().length === 0) return true;
  if (context.replace(/[ \t]+$/u, "").endsWith("\n")) return true;
  const trimmed = context.trimEnd().replace(/["'”’)\]}]+$/u, "").trimEnd();
  if (trimmed.length === 0) return true;
  if (trimmed.endsWith("...") || trimmed.endsWith("…")) return false;
  const last = trimmed.at(-1)!;
  if (last === "!" || last === "?") return true;
  return last === "." ? !abbreviationPeriod(trimmed) : false;
}

function abbreviationPeriod(trimmed: string): boolean {
  const match = TRAILING_WORD.exec(trimmed);
  if (match === null) return false;
  const word = match[1]!;
  if (word.includes(".") || ABBREVIATIONS.has(word.toLowerCase())) return true;
  if (Array.from(word).length === 1 && isUpper(word)) {
    const prefix = trimmed.slice(0, match.index).trimEnd();
    const previous = prefix.split(/\s+/u).at(-1) ?? "";
    return previous.length > 0 && isUpper(previous[0]!);
  }
  return false;
}

function adjustCapitalization(context: string | null, text: string, allowLower: boolean): string {
  const match = FIRST_WORD.exec(text);
  if (match === null || match.index === undefined) return text;
  let word = match[1]!;
  const start = match[0].length - word.length;
  if (isSentenceStart(context)) {
    const characters = Array.from(word);
    if (isLower(characters[0]!) && !characters.slice(1).some(isUpper)) {
      word = `${characters[0]!.toUpperCase()}${characters.slice(1).join("")}`;
    }
  } else if (allowLower && isUpper(Array.from(word)[0]!) && shouldLowercase(word)) {
    const characters = Array.from(word);
    word = `${characters[0]!.toLowerCase()}${characters.slice(1).join("")}`;
  }
  return `${text.slice(0, start)}${word}${text.slice(start + match[1]!.length)}`;
}

function shouldLowercase(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower === "i" || lower.startsWith("i'")) return false;
  return FUNCTION_WORDS.has(lower);
}

function countSentences(text: string): number {
  let count = 0;
  for (const match of text.matchAll(/[.!?]+/gu)) {
    const index = match.index;
    if (index === undefined) continue;
    const run = match[0];
    if (/^\.+$/u.test(run)) {
      if (/\p{N}/u.test(text[index + run.length] ?? "")) continue;
      if (abbreviationPeriod(text.slice(0, index + run.length))) continue;
    }
    count += 1;
  }
  return count;
}

function matchCase(matched: string, replacement: string): string {
  if (Array.from(matched).length > 1 && isAllUpper(matched)) {
    return replacement.toUpperCase();
  }
  const first = Array.from(matched)[0];
  if (first !== undefined && isUpper(first) && replacement === replacement.toLowerCase()) {
    const characters = Array.from(replacement);
    return `${characters[0]?.toUpperCase() ?? ""}${characters.slice(1).join("")}`;
  }
  return replacement;
}

function isAllUpper(value: string): boolean {
  return value === value.toUpperCase() && value !== value.toLowerCase();
}

function isUpper(value: string): boolean {
  return /\p{Lu}/u.test(value);
}

function isLower(value: string): boolean {
  return /\p{Ll}/u.test(value);
}

function isWhitespace(value: string): boolean {
  return /\s/u.test(value);
}

function trimEndSet(value: string, characters: ReadonlySet<string>): string {
  let end = value.length;
  while (end > 0 && characters.has(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

function trimStartSet(value: string, characters: ReadonlySet<string>): string {
  let start = 0;
  while (start < value.length && characters.has(value[start]!)) start += 1;
  return value.slice(start);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
