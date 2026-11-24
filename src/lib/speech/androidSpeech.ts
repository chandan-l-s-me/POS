/**
 * The Android app's speech recogniser.
 *
 * The app's WebView has no working Web Speech API, so the app adds a plugin,
 * VoiceSearch (android/app/src/main/java/in/chandanls/pos/
 * VoiceSearchPlugin.java), around Android's own SpeechRecognizer. It listens
 * inside the app, with no Google pop-up, and works without the internet on
 * phones that have the English (India) speech pack downloaded.
 *
 * The plugin reports everything as one event, `voiceEvent`, carrying the
 * number of the search it belongs to, so a late event from a search already
 * cancelled is never taken for the next one.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { Recognition, RecognitionHandlers, SpeechEngine, SpeechErrorCode } from './listen';
import { MAX_ALTERNATIVES } from '../voiceQuery';

interface VoiceEvent {
  session: number;
  type: 'partial' | 'result' | 'level' | 'error' | 'end';
  text?: string;
  matches?: string[];
  level?: number;
  code?: string;
}

interface VoiceSearchPlugin {
  start(options: { language: string; maxResults: number; session: number }): Promise<void>;
  stop(options: { session: number }): Promise<void>;
  cancel(options: { session: number }): Promise<void>;
  addListener(eventName: 'voiceEvent', listener: (event: VoiceEvent) => void): Promise<PluginListenerHandle>;
}

const VoiceSearch = registerPlugin<VoiceSearchPlugin>('VoiceSearch');

const CODES: SpeechErrorCode[] = ['not-allowed', 'no-speech', 'network', 'no-microphone', 'busy', 'unavailable', 'failed'];
const errorCode = (code: unknown): SpeechErrorCode =>
  CODES.includes(code as SpeechErrorCode) ? (code as SpeechErrorCode) : 'failed';

let nextSession = 1;
let current: { session: number; handlers: RecognitionHandlers } | null = null;
let listening: Promise<PluginListenerHandle> | null = null;

const onVoiceEvent = (event: VoiceEvent) => {
  if (!current || event.session !== current.session) return;
  const { handlers } = current;
  switch (event.type) {
    case 'partial':
      if (event.text) handlers.onPartial(event.text);
      break;
    case 'result':
      handlers.onResult(event.matches ?? []);
      break;
    case 'level':
      handlers.onLevel?.(event.level ?? 0);
      break;
    case 'error':
      handlers.onError(errorCode(event.code));
      break;
    case 'end':
      current = null;
      handlers.onEnd();
      break;
  }
};

export const androidSpeechEngine: SpeechEngine = {
  name: 'android',
  start: (language: string, handlers: RecognitionHandlers): Recognition => {
    const session = nextSession++;
    current = { session, handlers };
    listening ??= VoiceSearch.addListener('voiceEvent', onVoiceEvent);
    void listening
      .then(() => VoiceSearch.start({ language, maxResults: MAX_ALTERNATIVES, session }))
      .catch((err: { code?: string }) => {
        // Refused before it began: the microphone not allowed, no recogniser.
        if (current?.session !== session) return;
        current = null;
        handlers.onError(errorCode(err?.code));
        handlers.onEnd();
      });
    return {
      stop: () => void VoiceSearch.stop({ session }).catch(() => undefined),
      abort: () => {
        if (current?.session === session) current = null;
        void VoiceSearch.cancel({ session }).catch(() => undefined);
      },
    };
  },
};
