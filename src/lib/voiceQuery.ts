/**
 * What the speech recogniser heard, turned into a search.
 *
 * A recogniser writes what it hears the way speech goes ("sugar one kilo",
 * "nine eight four five"), and it is not sure: it offers up to five guesses
 * ("east" / "yeast"). The catalogue is written the way a label goes ("Icing
 * Sugar (1 kg)", "Instant Dry Yeast (500 g)"). This closes that gap, in
 * three steps, each tried only when the one before found nothing:
 *
 *  1. Every guess is tidied (numbers to digits, units to their short form,
 *     "search for…" dropped) and looked for as typed. The most literal
 *     reading that finds anything is kept ("sugar 1 kg", not just "sugar");
 *     among the guesses, the one whose best match is best, so the catalogue
 *     decides between "east" and "yeast". Ties go to the recogniser's order.
 *  2. The same, forgiving a slip per word, as typing does (src/lib/fuzzy.ts).
 *  3. Words that sound alike: "myda" for Maida, "rawa" for Rava. A spoken word
 *     no name contains is swapped for the catalogue word it sounds like.
 *
 * Nothing found: the first guess, tidied, so the cashier sees what was heard.
 *
 * Pure functions with no browser in them, so tests/voice-query.test.ts can
 * run them against a catalogue.
 */
import { editDistance, foldText, rankList, type SearchFields } from './fuzzy';

/** The recogniser's guesses looked at, best first. */
export const MAX_ALTERNATIVES = 5;

const DIGITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** "double nine" is 99, as phone numbers are read out in India. */
const REPEATS: Record<string, number> = { double: 2, triple: 3 };

/** Spoken units, as the catalogue writes them ("Icing Sugar (1 kg)"). Only after a number: "gram flour" stays. */
const UNITS: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  g: 'g', gm: 'g', gms: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  ml: 'ml', mls: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
};
/** A number and unit run together: "1kg", "500gm". */
const GLUED_UNIT = /^(\d+)(kgs?|gms?|g|mls?|ltrs?|l)$/i;

/** Said before or after the thing wanted, and not part of it. Longest first. */
const LEADING_FILLERS = [
  ['search', 'for'], ['look', 'for'], ['show', 'me'], ['give', 'me'], ['get', 'me'], ['find', 'me'], ['i', 'want'], ['i', 'need'],
  ['search'], ['find'], ['show'], ['add'], ['get'],
];
const TRAILING_FILLERS = [['please']];

interface Token {
  text: string;
  kind: 'word' | 'number' | 'unit';
}

const isNumeral = (word: string) => /^\d+$/.test(word);
const isDigit = (word: string) => word in DIGITS || /^\d$/.test(word);
const digitOf = (word: string) => (word in DIGITS ? String(DIGITS[word]) : word);

/** Words, without the punctuation a recogniser adds ("Sugar." / "sugar?"). */
const wordsOf = (heard: string) =>
  heard
    .replace(/[.,!?;:"“”]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

const startsWith = (words: string[], phrase: string[], at: number) =>
  phrase.every((part, offset) => words[at + offset]?.toLowerCase() === part);

/** Drop "search for", "please" and the like, but never every word. */
const withoutFillers = (words: string[]) => {
  let start = 0;
  let end = words.length;
  const lead = LEADING_FILLERS.find((phrase) => startsWith(words, phrase, 0) && phrase.length < words.length);
  if (lead) start = lead.length;
  const trail = TRAILING_FILLERS.find((phrase) => startsWith(words, phrase, end - phrase.length) && end - phrase.length > start);
  if (trail) end -= trail.length;
  return words.slice(start, end);
};

const isNumberWord = (word: string, next: string | undefined) =>
  word in DIGITS || word in TEENS || word in TENS || word === 'hundred' || word === 'thousand' || isNumeral(word) ||
  // "double" is a number only before a digit: "double nine", not "double cream".
  (word in REPEATS && next !== undefined && isDigit(next));

/**
 * One run of spoken number words, as digits. Spelt digit by digit ("nine
 * eight four five", "zero four zero two") it is the digits run together, as
 * phone numbers and HSN codes are read; otherwise it is counted ("twenty
 * five", "five hundred", and "two fifty" for 250, as prices and weights are
 * said here). Words that do not make one number come out as several.
 */
const numbersOf = (run: string[]): string[] => {
  if (run.length > 1 && run.every((word, i) => isDigit(word) || (word in REPEATS && isDigit(run[i + 1] ?? '')))) {
    let digits = '';
    for (let i = 0; i < run.length; i++) {
      const word = run[i];
      if (word in REPEATS) {
        digits += digitOf(run[i + 1]).repeat(REPEATS[word]);
        i++;
      } else {
        digits += digitOf(word);
      }
    }
    return [digits];
  }

  const numbers: string[] = [];
  let total = 0;
  let current = 0;
  let last: 'unit' | 'teen' | 'tens' | 'hundred' | 'thousand' | null = null;
  const flush = () => {
    if (last !== null) numbers.push(String(total + current));
    total = 0;
    current = 0;
    last = null;
  };

  for (const word of run) {
    if (word in REPEATS) continue; // only before a digit, which is counted next
    if (word in DIGITS || isNumeral(word)) {
      const value = word in DIGITS ? DIGITS[word] : Number(word);
      if (last === 'unit' || last === 'teen') flush();
      current += value;
      last = 'unit';
    } else if (word in TEENS) {
      if (last === 'unit' && current > 0 && current < 10) current = current * 100 + TEENS[word]; // "two fifteen"
      else {
        if (last === 'unit' || last === 'teen' || last === 'tens') flush();
        current += TEENS[word];
      }
      last = 'teen';
    } else if (word in TENS) {
      if (last === 'unit' && current > 0 && current < 10) current = current * 100 + TENS[word]; // "two fifty"
      else {
        if (last === 'unit' || last === 'teen' || last === 'tens') flush();
        current += TENS[word];
      }
      last = 'tens';
    } else if (word === 'hundred') {
      current = (current || 1) * 100; // "five hundred", "twenty five hundred"
      last = 'hundred';
    } else if (word === 'thousand') {
      total += (current || 1) * 1000;
      current = 0;
      last = 'thousand';
    }
  }
  flush();
  return numbers;
};

/** The heard words as tokens: number words as digits, units short, fillers gone. */
const spokenTokens = (heard: string): Token[] => {
  const words = withoutFillers(wordsOf(heard)).flatMap((word) => {
    const glued = GLUED_UNIT.exec(word);
    return glued ? [glued[1], glued[2]] : [word];
  });
  const tokens: Token[] = [];
  for (let i = 0; i < words.length; ) {
    const lower = words[i].toLowerCase();
    if (isNumberWord(lower, words[i + 1]?.toLowerCase())) {
      const run: string[] = [];
      while (i < words.length && isNumberWord(words[i].toLowerCase(), words[i + 1]?.toLowerCase())) {
        run.push(words[i].toLowerCase());
        i++;
      }
      for (const number of numbersOf(run)) tokens.push({ text: number, kind: 'number' });
      continue;
    }
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === 'number' && lower in UNITS) tokens.push({ text: UNITS[lower], kind: 'unit' });
    else tokens.push({ text: words[i], kind: 'word' });
    i++;
  }
  return tokens;
};

const joinTokens = (tokens: Token[]) => tokens.map((token) => token.text).join(' ');

/**
 * What was heard, tidied for the search box: "search for sugar one kilo"
 * becomes "sugar 1 kg". Used for the words shown while the cashier is still
 * speaking, and when nothing in the list matches.
 */
export const cleanSpokenText = (heard: string): string => joinTokens(spokenTokens(heard));

/**
 * The ways one guess might be meant, most literal first: tidied; as said
 * (for "All in One Premix", where "one" is a word); without the quantity
 * (when the catalogue writes it differently); and with two words run
 * together ("my da" for Maida, "butter scotch").
 */
const readingsOf = (heard: string): string[] => {
  const tokens = spokenTokens(heard);
  const readings = [joinTokens(tokens), withoutFillers(wordsOf(heard)).join(' ')];
  const words = tokens.filter((token) => token.kind === 'word');
  if (words.length && words.length < tokens.length) readings.push(joinTokens(words));
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i].kind !== 'word' || tokens[i + 1].kind !== 'word') continue;
    const joined = { text: tokens[i].text + tokens[i + 1].text, kind: 'word' as const };
    readings.push(joinTokens([...tokens.slice(0, i), joined, ...tokens.slice(i + 2)]));
  }
  return [...new Set(readings.filter(Boolean))];
};

/**
 * A rough sound of a word, the way Indian English spells by ear: vowels and
 * h dropped after the first letter, w as v, z as j, ph as f, soft c as s,
 * doubled letters once. "maida" and "myda" are both "md"; "rava" and "rawa"
 * "rv". Null for anything too short to compare, or not in Latin letters.
 */
export const soundKey = (word: string): string | null => {
  let w = foldText(word).replace(/ /g, '');
  if (!/^[a-z]{3,}$/.test(w)) return null;
  w = w
    .replace(/ph/g, 'f')
    .replace(/([bdgkst])h/g, '$1')
    .replace(/ck/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k');
  const first = /[aeiouy]/.test(w[0]) ? 'a' : w[0];
  const key = (first + w.slice(1).replace(/[aeiouyh]/g, '')).replace(/(.)\1+/g, '$1');
  return key.length >= 2 ? key : null;
};

interface VocabularyWord {
  /** As the catalogue writes it, for the search box. */
  word: string;
  folded: string;
}

/** Every word in the list's names, by how it sounds. */
const vocabularyOf = <T>(list: readonly T[], fields: SearchFields<T>) => {
  const bySound = new Map<string, VocabularyWord[]>();
  const all: string[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    for (const name of fields.names(entry)) {
      for (const word of String(name ?? '').split(/[^\p{L}\p{M}\p{N}]+/u)) {
        const folded = foldText(word);
        if (!folded || seen.has(folded)) continue;
        seen.add(folded);
        all.push(folded);
        const key = soundKey(folded);
        if (!key) continue;
        if (!bySound.has(key)) bySound.set(key, []);
        bySound.get(key)!.push({ word, folded });
      }
    }
  }
  return { bySound, all };
};

/** A reading with each word that no name contains swapped for the catalogue word it sounds like. */
const soundAlike = (reading: string, vocabulary: ReturnType<typeof vocabularyOf>): string | null => {
  let changed = false;
  const words = reading.split(' ').map((word) => {
    const folded = foldText(word);
    if (!folded || vocabulary.all.some((known) => known.includes(folded))) return word;
    const key = soundKey(folded);
    const options = key ? vocabulary.bySound.get(key) : undefined;
    if (!options?.length) return word;
    const closest = options.reduce((best, option) =>
      editDistance(folded, option.folded) < editDistance(folded, best.folded) ? option : best
    );
    changed = true;
    return closest.word;
  });
  return changed ? words.join(' ') : null;
};

interface Reading {
  text: string;
  /** Which of the recogniser's guesses, 0 being its best. */
  guess: number;
  /** Which reading of that guess, 0 being the most literal. */
  reading: number;
}

/**
 * The reading that finds something, most literal first, so "sugar 1 kg" is
 * kept rather than just "sugar". Between the guesses read the same way, the
 * one whose best match is better ("yeast" over "east"), then the recogniser's
 * own order.
 */
const bestReading = <T>(readings: Reading[], list: readonly T[], fields: SearchFields<T>, allowSlips: boolean) => {
  let winner: { reading: Reading; score: number } | null = null;
  for (const reading of readings) {
    const top = rankList(list, reading.text, fields, allowSlips)[0];
    if (!top) continue;
    const better =
      !winner ||
      reading.reading < winner.reading.reading ||
      (reading.reading === winner.reading.reading &&
        (top.score < winner.score || (top.score === winner.score && reading.guess < winner.reading.guess)));
    if (better) winner = { reading, score: top.score };
  }
  return winner?.reading.text ?? null;
};

/**
 * What to put in the search box for what was heard, choosing among the
 * recogniser's guesses by what is in `list` (see the top of this file).
 */
export const pickTranscript = <T>(heard: readonly string[], list: readonly T[], fields: SearchFields<NoInfer<T>>): string => {
  const guesses = heard.map((text) => text.trim()).filter(Boolean).slice(0, MAX_ALTERNATIVES);
  if (!guesses.length) return '';
  const fallback = cleanSpokenText(guesses[0]);
  if (!list.length) return fallback;

  const readings: Reading[] = guesses.flatMap((text, guess) =>
    readingsOf(text).map((reading, index) => ({ text: reading, guess, reading: index }))
  );
  const direct = bestReading(readings, list, fields, false);
  if (direct) return direct;
  const close = bestReading(readings, list, fields, true);
  if (close) return close;

  const vocabulary = vocabularyOf(list, fields);
  const alike = readings.flatMap((reading) => {
    const text = soundAlike(reading.text, vocabulary);
    return text ? [{ ...reading, text }] : [];
  });
  return bestReading(alike, list, fields, true) ?? fallback;
};
