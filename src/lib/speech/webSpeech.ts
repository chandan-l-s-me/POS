/**
 * The browser's own speech recogniser (the Web Speech API): Chrome and Edge
 * on the counter, Chrome on a phone, Safari on an iPhone. Chrome sends the
 * audio to Google to be recognised, so it needs the internet; nothing passes
 * through the shop's server.
 *
 * Not in the Android app: its WebView has the API's name but no recogniser
 * behind it. The app has its own (androidSpeech.ts).
 */
import type { Recognition, RecognitionHandlers, SpeechEngine, SpeechErrorCode } from './listen';
import { MAX_ALTERNATIVES } from '../voiceQuery';

/** The part of the Web Speech API used here; TypeScript's DOM types do not all have it. */
interface SpeechAlternativeLike {
  transcript: string;
}
interface SpeechResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechAlternativeLike;
}
interface SpeechResultEventLike {
  readonly results: { readonly length: number; [index: number]: SpeechResultLike };
}
export interface BrowserRecognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechResultEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
export type BrowserRecognitionConstructor = new () => BrowserRecognition;

/** The browser's recogniser, if it has one. */
export const browserRecognition = (scope: unknown = typeof window === 'undefined' ? undefined : window) => {
  const host = scope as { SpeechRecognition?: BrowserRecognitionConstructor; webkitSpeechRecognition?: BrowserRecognitionConstructor } | undefined;
  return host?.SpeechRecognition ?? host?.webkitSpeechRecognition ?? null;
};

const ERRORS: Record<string, SpeechErrorCode | null> = {
  'not-allowed': 'not-allowed',
  'service-not-allowed': 'not-allowed',
  'no-speech': 'no-speech',
  'audio-capture': 'no-microphone',
  network: 'network',
  'language-not-supported': 'unavailable',
  // Ours: `abort()` was called, and listen() has already moved on.
  aborted: null,
};

const transcriptOf = (result: SpeechResultLike, index = 0) => result[index]?.transcript?.trim() ?? '';

export const createWebSpeechEngine = (Recognizer: BrowserRecognitionConstructor): SpeechEngine => ({
  name: 'web',
  start: (language: string, handlers: RecognitionHandlers): Recognition => {
    const recognizer = new Recognizer();
    recognizer.lang = language;
    // One phrase: the browser stops by itself at the first pause.
    recognizer.continuous = false;
    recognizer.interimResults = true;
    recognizer.maxAlternatives = MAX_ALTERNATIVES;

    recognizer.onresult = (event) => {
      const results = Array.from({ length: event.results.length }, (_, i) => event.results[i]);
      const last = results[results.length - 1];
      if (!last) return;
      // Earlier phrases, if the browser split what was said, lead every guess.
      const before = results.slice(0, -1).map((result) => transcriptOf(result)).filter(Boolean).join(' ');
      if (results.every((result) => result.isFinal)) {
        const guesses = Array.from({ length: last.length }, (_, i) => transcriptOf(last, i)).filter(Boolean);
        handlers.onResult(guesses.map((guess) => (before ? `${before} ${guess}` : guess)));
      } else {
        handlers.onPartial(results.map((result) => transcriptOf(result)).filter(Boolean).join(' '));
      }
    };
    recognizer.onerror = (event) => {
      const code = event.error in ERRORS ? ERRORS[event.error] : 'failed';
      if (code) handlers.onError(code);
    };
    recognizer.onend = () => handlers.onEnd();
    recognizer.start();

    return { stop: () => recognizer.stop(), abort: () => recognizer.abort() };
  },
});
