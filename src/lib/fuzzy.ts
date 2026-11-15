/**
 * Search that forgives a slip of the finger.
 *
 * Every search box looks for what was typed inside the names first, as it
 * always has: "sug" finds "Sugar 1kg", "ganesh" finds "Sri Ganesh Bakery".
 * Only when nothing contains it does it look for the closest names instead,
 * allowing one wrong, missing, extra or swapped letter per word (two in a
 * word of seven letters or more): "suger", "chocolte", "ganseh". Typed
 * correctly, the results are exactly what they were; mistyped, there is still
 * something to pick rather than "No items found".
 *
 * Codes (HSN, barcode, phone, GSTIN) are matched only as typed: a phone number
 * one digit off is somebody else's.
 *
 * Shared by the screens and by server.ts, so the Items and Customers pages
 * (searched on the server) forgive the same slips as the billing screen.
 */

/** Lower case, accents and punctuation gone, single spaces. Kannada is kept as it is. */
export const foldText = (text: unknown): string =>
  String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/** Letters a word of this length may have wrong: none under 3, then 1, then 2 from 7. */
const allowedSlips = (length: number) => (length < 3 ? 0 : length < 7 ? 1 : 2);

/**
 * Edits (a letter wrong, missing, extra, or two swapped) to turn `a` into `b`,
 * or `max + 1` once it is clear there are more than `max`.
 */
export const editDistance = (a: string, b: string, max = Infinity): number => {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = new Array<number>(b.length + 1).fill(0);
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let rowBest = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      current.push(value);
      rowBest = Math.min(rowBest, value);
    }
    if (rowBest > max) return max + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
};

/**
 * How far a typed word is from the start of a word in a name: "choco" is 0
 * from "chocolate", "chcoo" 1. The typed word may be the whole word or the
 * start of it, as when someone is still typing.
 */
const slipsFromWordStart = (typed: string, word: string, max: number) => {
  let best = max + 1;
  for (let length = Math.max(1, typed.length - max); length <= Math.min(word.length, typed.length + max); length++) {
    best = Math.min(best, editDistance(typed, word.slice(0, length), max));
    if (best === 0) break;
  }
  return best;
};

export interface SearchFields<T> {
  /** Names: matched as typed, and forgiving of slips when nothing matches. */
  names: (entry: T) => Array<string | null | undefined>;
  /** Codes: matched only as typed (spaces and case ignored). */
  codes?: (entry: T) => Array<string | null | undefined>;
}

/**
 * How well `entry` matches what was typed, lower is better, or null for no
 * match. Below 10: it contains every typed word. 10 and up: a close match,
 * 10 plus the number of slips.
 */
const scoreEntry = <U>(entry: U, query: string, typedWords: string[], fields: SearchFields<U>, allowSlips: boolean): number | null => {
  const names = fields.names(entry).map(foldText).filter(Boolean);
  const codes = (fields.codes?.(entry) ?? []).map((code) => foldText(code).replace(/ /g, '')).filter(Boolean);
  const all = [...names, ...codes].join(' ');
  const compactQuery = query.replace(/ /g, '');

  if (typedWords.every((word) => all.includes(word)) || codes.some((code) => code.includes(compactQuery))) {
    if (names.some((name) => name.startsWith(query))) return 0;
    if (names.some((name) => ` ${name}`.includes(` ${typedWords[0]}`))) return 1;
    return 2;
  }
  if (!allowSlips) return null;

  const nameWords = names.flatMap((name) => name.split(' '));
  let slips = 0;
  for (const typed of typedWords) {
    const max = allowedSlips(typed.length);
    let best = max + 1;
    for (const word of nameWords) {
      if (word.startsWith(typed)) { best = 0; break; }
      if (max > 0) best = Math.min(best, slipsFromWordStart(typed, word, max));
    }
    if (best > max) return null;
    slips += best;
  }
  return slips === 0 ? 2 : 10 + slips;
};

/**
 * The entries matching what was typed, best first; ties keep the list's own
 * order. Close matches are offered only when nothing contains what was typed.
 */
// NoInfer: the entries decide T; shared fields for a wider type (ITEM_SEARCH) still fit.
export const searchList = <T>(list: readonly T[], query: string, fields: SearchFields<NoInfer<T>>): T[] => {
  const folded = foldText(query);
  if (!folded) return list.slice();
  const typedWords = folded.split(' ');

  const rank = (allowSlips: boolean) =>
    list
      .map((entry, index) => ({ entry, index, score: scoreEntry(entry, folded, typedWords, fields, allowSlips) }))
      .filter((hit): hit is { entry: T; index: number; score: number } => hit.score != null)
      .sort((a, b) => a.score - b.score || a.index - b.index)
      .map((hit) => hit.entry);

  const direct = rank(false);
  return direct.length ? direct : rank(true);
};
