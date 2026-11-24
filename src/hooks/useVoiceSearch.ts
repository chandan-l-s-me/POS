import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { setFieldValue } from '../lib/fieldValue';
import type { SearchFields } from '../lib/fuzzy';
import { getSpeechEngine, listen, type ListenOutcome, type ListenSession, type SpeechErrorCode } from '../lib/speech';
import { cleanSpokenText, pickTranscript } from '../lib/voiceQuery';

/**
 * Search by voice into one search box: the words appear in the box as they
 * are spoken, and the search box's own list of matches follows them. When the
 * cashier stops speaking, the recogniser's best guess for this list is kept
 * (src/lib/voiceQuery.ts) and the cursor is left in the box, so Enter picks
 * the first match as it does after typing. Voice never picks for them.
 *
 * While listening:
 *  - Esc cancels and puts the box back as it was;
 *  - Enter stops listening and searches for what was said so far;
 *  - typing (or a barcode scan) cancels, and the keys go into the box.
 *
 * Anything that goes wrong comes back as `message`, for the button to show
 * for a few seconds; the box is put back as it was.
 */

export interface VoiceSearchOptions<T> {
  /** The box's current text, put back if the search is cancelled. */
  value: string;
  /** Put text in the box, as typing it would. */
  onChange: (text: string) => void;
  /** What the box searches, to choose between the recogniser's guesses. */
  list?: readonly T[];
  fields?: SearchFields<NoInfer<T>>;
  /** The box itself. */
  getInput: () => HTMLInputElement | null;
  /**
   * Keep the cursor in the box (the counter, so Enter picks a match). False
   * on a phone, where focus would bring up the keyboard over the matches.
   */
  keepFocus?: boolean;
}

/** What to tell the cashier about each problem, in the language on screen. */
export const voiceErrorMessage = (code: SpeechErrorCode) => {
  switch (code) {
    case 'not-allowed': return t('The microphone is not allowed. Allow it for this app or site, then try again.');
    case 'no-speech': return t('Did not catch that. Tap the microphone and say the name again.');
    case 'network': return t('Voice search needs the internet. Type the name instead.');
    case 'no-microphone': return t('No microphone found. Connect one and try again.');
    case 'busy': return t('The microphone is in use by another app. Try again.');
    case 'unavailable': return t('Voice search is not available on this device.');
    default: return t('Voice search stopped. Try again.');
  }
};

/** How long a problem stays on screen. */
const MESSAGE_MS = 4000;

const focusAtEnd = (input: HTMLInputElement | null) => {
  if (!input) return;
  input.focus();
  // After React has put the new text in the box.
  setTimeout(() => {
    const end = input.value.length;
    try {
      input.setSelectionRange(end, end);
    } catch {
      /* a box type without a cursor */
    }
  }, 0);
};

export const useVoiceSearch = <T,>(options: VoiceSearchOptions<T>) => {
  const [supported] = useState(() => getSpeechEngine() !== null);
  const [listening, setListening] = useState(false);
  /** Words have been heard in this search. */
  const [heard, setHeard] = useState(false);
  const [level, setLevel] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const latest = useRef(options);
  latest.current = options;
  const session = useRef<ListenSession | null>(null);
  const before = useRef('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      // Leaving the page or closing the sheet: stop, and touch nothing.
      mounted.current = false;
      session.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (!message) return;
    const handle = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(handle);
  }, [message]);

  const finish = useCallback((outcome: ListenOutcome) => {
    session.current = null;
    if (!mounted.current) return;
    setListening(false);
    setHeard(false);
    setLevel(0);
    const { onChange, list, fields, getInput, keepFocus = true } = latest.current;
    if (outcome.type === 'result') {
      const text = list && fields
        ? pickTranscript(outcome.alternatives, list, fields)
        : cleanSpokenText(outcome.alternatives[0] ?? '');
      onChange(text);
      if (keepFocus) focusAtEnd(getInput());
      return;
    }
    onChange(before.current);
    if (outcome.type === 'error') setMessage(voiceErrorMessage(outcome.code));
  }, []);

  const start = useCallback(() => {
    const engine = getSpeechEngine();
    if (!engine || session.current) return;
    const { value, getInput, keepFocus = true } = latest.current;
    before.current = value;
    setMessage(null);
    const input = getInput();
    if (keepFocus) input?.focus();
    else input?.blur();
    setListening(true);
    let ended = false;
    const started = listen(engine, {
      onPartial: (text) => {
        if (!mounted.current) return;
        setHeard(true);
        latest.current.onChange(cleanSpokenText(text));
      },
      onLevel: (value) => {
        if (mounted.current) setLevel(value);
      },
      onDone: (outcome) => {
        ended = true;
        finish(outcome);
      },
    });
    if (!ended) session.current = started;
  }, [finish]);

  const stop = useCallback(() => session.current?.stop(), []);
  const cancel = useCallback(() => session.current?.cancel(), []);
  const toggle = useCallback(() => (session.current ? session.current.stop() : start()), [start]);

  // The keyboard while listening (see the top of this file). In the capture
  // phase, before the box's own Enter and Esc handling.
  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        session.current?.cancel();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        session.current?.stop();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        // Put the box back now, before the key lands in it after the words
        // heard so far.
        const input = latest.current.getInput();
        if (event.target === input) setFieldValue(input, before.current);
        session.current?.cancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [listening]);

  return { supported, listening, heard, level, message, start, stop, cancel, toggle };
};
