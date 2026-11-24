/**
 * The keys that start and stop search by voice at the counter.
 *
 * F2: one key, no other key held, and free in Chrome and Edge (F1 is help,
 * F3 find, F5 reload, F6 the address bar, F7 caret browsing, F11 full
 * screen, F12 developer tools). Ctrl+M as well, for keyboards whose F keys
 * need the Fn key held (most laptops). The Fn key itself never reaches a web
 * page, so it cannot be used.
 *
 * In a search box with a microphone, the key starts that box; anywhere else
 * on the page, the page's main search (see VoiceSearchButton).
 */

export const VOICE_KEY = 'F2';

interface KeyPress {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat?: boolean;
}

export const isVoiceShortcut = (event: KeyPress): boolean => {
  // Holding the key down would start and stop it over and over.
  if (event.repeat || event.altKey || event.metaKey || event.shiftKey) return false;
  if (event.key === VOICE_KEY) return !event.ctrlKey;
  return event.ctrlKey && event.key.toLowerCase() === 'm';
};
