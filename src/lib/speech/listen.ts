/**
 * One spoken search, from the microphone opening to what was heard.
 *
 * The recognisers underneath (the browser's, in webSpeech.ts, and Android's,
 * in androidSpeech.ts) each report in their own way: some end without a
 * result, some send an error after a result, some never stop if nobody
 * speaks. `listen` turns that into one dependable conversation:
 *
 *  - `onPartial` with the words so far while the cashier speaks;
 *  - `onDone` exactly once: what was heard (the recogniser's guesses, best
 *    first), an error, or cancelled;
 *  - only one microphone at a time: starting another search cancels this one;
 *  - it gives up if nobody speaks (`noSpeechMs`), and stops after `maxMs`
 *    even if the shop is too noisy for the recogniser to notice a pause;
 *  - it cancels when the app goes to the background.
 *
 * No React and no browser globals beyond `document`, so
 * tests/voice-engine.test.ts drives it with fake recognisers and timers.
 */

/** Why a search by voice did not hear anything usable. */
export type SpeechErrorCode =
  /** The microphone is not allowed for this site or app. */
  | 'not-allowed'
  /** Nothing was said, or nothing recognisable. */
  | 'no-speech'
  /** The recogniser needs the internet and could not reach it. */
  | 'network'
  /** No microphone, or it could not be opened. */
  | 'no-microphone'
  /** Another app is using the recogniser. */
  | 'busy'
  /** No speech recogniser for this language on this device. */
  | 'unavailable'
  | 'failed';

/** What a recogniser reports. It may call these in any order, and more than once. */
export interface RecognitionHandlers {
  /** Words so far, while the person is still speaking. */
  onPartial: (text: string) => void;
  /** The guesses for what was said, best first. */
  onResult: (alternatives: string[]) => void;
  /** How loud the voice is, 0 to 1, where the recogniser says. */
  onLevel?: (level: number) => void;
  onError: (code: SpeechErrorCode) => void;
  /** The microphone has closed. */
  onEnd: () => void;
}

export interface Recognition {
  /** Stop listening and give the result for what was said so far. */
  stop: () => void;
  /** Stop listening and give no result. */
  abort: () => void;
}

export interface SpeechEngine {
  readonly name: 'web' | 'android';
  start: (language: string, handlers: RecognitionHandlers) => Recognition;
}

export type ListenOutcome =
  | { type: 'result'; alternatives: string[] }
  | { type: 'error'; code: SpeechErrorCode }
  | { type: 'cancelled' };

export interface ListenOptions {
  /** BCP 47; the shop speaks Indian English. */
  language?: string;
  onPartial?: (text: string) => void;
  onLevel?: (level: number) => void;
  onDone: (outcome: ListenOutcome) => void;
  /** Give up if nothing has been heard after this long. */
  noSpeechMs?: number;
  /** Stop listening after this long, whatever is going on. */
  maxMs?: number;
  /** After asking the recogniser to stop, wait this long for its answer. */
  settleMs?: number;
}

export interface ListenSession {
  /** Finish now, with what was heard so far. */
  stop: () => void;
  /** Finish now, with nothing. */
  cancel: () => void;
}

export const DEFAULT_LANGUAGE = 'en-IN';

let active: { cancel: () => void } | null = null;

/** Whether a search by voice is listening anywhere on the page. */
export const isListening = () => active !== null;

export const listen = (engine: SpeechEngine, options: ListenOptions): ListenSession => {
  // One microphone at a time.
  active?.cancel();

  const { noSpeechMs = 7000, maxMs = 15000, settleMs = 2500 } = options;
  let done = false;
  let heard = '';
  let stopRequested = false;
  let recognition: Recognition | null = null;
  const timers: Array<ReturnType<typeof setTimeout>> = [];

  const onHidden = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') session.cancel();
  };

  const finish = (outcome: ListenOutcome) => {
    if (done) return;
    done = true;
    timers.forEach(clearTimeout);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHidden);
    if (active === handle) active = null;
    options.onDone(outcome);
  };

  /** What was said, or the words heard so far if the recogniser had no final answer. */
  const finishWithHeard = (alternatives: string[] = []) => {
    const guesses = [...new Set(alternatives.map((text) => text.trim()).filter(Boolean))];
    if (guesses.length) finish({ type: 'result', alternatives: guesses });
    else if (heard.trim()) finish({ type: 'result', alternatives: [heard.trim()] });
    else if (stopRequested) finish({ type: 'cancelled' });
    else finish({ type: 'error', code: 'no-speech' });
  };

  const requestStop = () => {
    if (done || stopRequested) return;
    stopRequested = true;
    try {
      recognition?.stop();
    } catch {
      /* already stopped */
    }
    // A recogniser that never answers a stop still ends the search.
    timers.push(setTimeout(() => {
      try { recognition?.abort(); } catch { /* already stopped */ }
      finishWithHeard();
    }, settleMs));
  };

  const session: ListenSession = {
    stop: requestStop,
    cancel: () => {
      if (done) return;
      try {
        recognition?.abort();
      } catch {
        /* already stopped */
      }
      finish({ type: 'cancelled' });
    },
  };
  const handle = { cancel: session.cancel };
  active = handle;

  timers.push(setTimeout(() => {
    if (!heard.trim()) {
      try { recognition?.abort(); } catch { /* already stopped */ }
      finish({ type: 'error', code: 'no-speech' });
    }
  }, noSpeechMs));
  timers.push(setTimeout(requestStop, maxMs));
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onHidden);

  try {
    recognition = engine.start(options.language ?? DEFAULT_LANGUAGE, {
      onPartial: (text) => {
        if (done || !text.trim()) return;
        heard = text;
        options.onPartial?.(text);
      },
      onLevel: (level) => {
        if (!done) options.onLevel?.(Math.max(0, Math.min(1, level)));
      },
      onResult: (alternatives) => {
        if (!done) finishWithHeard(alternatives);
      },
      onError: (code) => {
        if (done) return;
        // Words were heard before it went wrong: search for those.
        if (heard.trim() && code === 'no-speech') finishWithHeard();
        else finish({ type: 'error', code });
      },
      onEnd: () => {
        if (!done) finishWithHeard();
      },
    });
  } catch {
    // Reported after `listen` returns, as every other outcome is.
    timers.push(setTimeout(() => finish({ type: 'error', code: 'failed' }), 0));
  }

  return session;
};
