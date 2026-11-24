/**
 * Search by voice: which recogniser this device has.
 *
 *  - The Android app: its own plugin (androidSpeech.ts). An app installed
 *    before voice search has no plugin, and so no microphone button, rather
 *    than the WebView's recogniser that does not work.
 *  - A browser with the Web Speech API (Chrome, Edge, Safari): that.
 *  - Anything else (Firefox): none, and the button is not shown.
 */
import { Capacitor } from '@capacitor/core';
import { androidSpeechEngine } from './androidSpeech';
import type { SpeechEngine } from './listen';
import { browserRecognition, createWebSpeechEngine } from './webSpeech';

export * from './listen';

let engine: SpeechEngine | null | undefined;

export const getSpeechEngine = (): SpeechEngine | null => {
  if (engine !== undefined) return engine;
  if (Capacitor.isNativePlatform()) {
    engine = Capacitor.isPluginAvailable('VoiceSearch') ? androidSpeechEngine : null;
  } else {
    const Recognizer = browserRecognition();
    engine = Recognizer ? createWebSpeechEngine(Recognizer) : null;
  }
  return engine;
};
