/**
 * The app's two languages: English, and Kannada for staff who read it more
 * easily.
 *
 * Text is written in English in the code and looked up in Kannada at render
 * time: `t('Save changes')`. Anything without a Kannada entry shows in English,
 * so a missing translation never leaves a blank. Values go in braces:
 * `t('{count} items', { count })`, so each language can put them where its
 * grammar wants them.
 *
 * The language is a choice made on each device (the counter, a phone) and
 * remembered there. App re-renders the whole screen when it changes, so `t`
 * can be called anywhere during render without a hook.
 *
 * Printed and shared bills stay in English: they go to buyers and onto GST
 * records. Item names are typed and searched in English; their Kannada names
 * come from the server (see itemLabel).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { kn } from './kn';
import { UNIT_OPTIONS } from '../lib/units';

export type Language = 'en' | 'kn';

export const LANGUAGES: Array<{ id: Language; label: string; short: string }> = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'kn', label: 'ಕನ್ನಡ', short: 'ಕ' },
];

interface LanguageState {
  lang: Language;
  setLang: (lang: Language) => void;
  toggle: () => void;
}

export const useLanguageStore = create<LanguageState>()(
  persist(
    (set, get) => ({
      lang: 'en',
      setLang: (lang) => set({ lang }),
      toggle: () => set({ lang: get().lang === 'kn' ? 'en' : 'kn' }),
    }),
    { name: 'language' }
  )
);

export type TranslationVars = Record<string, string | number | null | undefined>;

const fill = (text: string, vars?: TranslationVars) =>
  vars ? text.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key] ?? '') : match)) : text;

/** The text in the language in use, with any {values} filled in. */
export const t = (text: string, vars?: TranslationVars): string =>
  fill(currentLanguage() === 'kn' ? kn[text] ?? text : text, vars);

/**
 * A count with its noun: `tn(n, '1 item', '{count} items')`. Kannada keeps one
 * form for both, so each form has its own entry.
 */
export const tn = (count: number, one: string, many: string, vars?: TranslationVars) =>
  t(count === 1 ? one : many, { count, ...vars });

/** The text in English, whatever the language in use: for bills and records. */
export const inEnglish = (text: string, vars?: TranslationVars) => fill(text, vars);

let englishScopes = 0;

/**
 * Run `build` with everything in English: t(), item names and dates. For
 * spreadsheet exports, which go to an accountant and must read the same
 * whoever pressed the button. Synchronous code only.
 */
export const withEnglish = <T,>(build: () => T): T => {
  englishScopes += 1;
  try {
    return build();
  } finally {
    englishScopes -= 1;
  }
};

export const currentLanguage = (): Language => (englishScopes > 0 ? 'en' : useLanguageStore.getState().lang);

/** For Intl date and number formatting. */
export const currentLocale = () => (currentLanguage() === 'kn' ? 'kn-IN' : 'en-GB');

/** A unit as shown on screen: "KG", or "ಕೆಜಿ" in Kannada. Stored values stay English. */
export const unitLabel = (metric: string | null | undefined): string => {
  const unit = UNIT_OPTIONS.find((option) => option.value === (metric ?? '').toLowerCase());
  return unit ? t(unit.label) : metric ?? '';
};

const PAYMENT_LABELS: Record<string, string> = { cash: 'Cash', upi: 'UPI', credit: 'Credit', split: 'Split' };

/** A payment method as shown on screen. */
export const paymentLabel = (method: string | null | undefined): string => {
  const label = PAYMENT_LABELS[(method ?? '').toLowerCase()];
  return label ? t(label) : method ?? '';
};

/** An open bill's tab name: the till numbers them "Bill 1", "Bill 2"; a renamed one shows as typed. */
export const billTabName = (name: string): string => {
  const numbered = /^Bill (\d+)$/.exec(name);
  return numbered ? t('Bill {number}', { number: numbered[1] }) : name;
};

// --- Item names ------------------------------------------------------------

/**
 * Kannada names of items, by English name, as the server last sent them.
 * Filled by useItemNames; empty until then, and names without a Kannada
 * version are simply absent.
 */
interface ItemNamesState {
  names: Record<string, string>;
  setNames: (names: Record<string, string>) => void;
}

export const useItemNamesStore = create<ItemNamesState>()((set) => ({
  names: {},
  setNames: (names) => set({ names }),
}));

/** An item's Kannada name, on a Kannada screen when it has one; otherwise null. */
export const itemKannada = (name: string | null | undefined): string | null => {
  const english = name ?? '';
  if (currentLanguage() !== 'kn') return null;
  const kannada = useItemNamesStore.getState().names[english];
  return kannada && kannada !== english ? kannada : null;
};

/**
 * An item's name as one line of text: "ಸಕ್ಕರೆ 1 ಕೆಜಿ (Sugar 1kg)" on a Kannada
 * screen, so it reads either way, otherwise the name as typed. For messages,
 * labels and charts; lists and tables show both on two lines (ItemName).
 * Search still matches the English name.
 */
export const itemLabel = (name: string | null | undefined): string => {
  const english = name ?? '';
  const kannada = itemKannada(english);
  return kannada ? `${kannada} (${english})` : english;
};
