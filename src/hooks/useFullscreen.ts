import { useCallback, useEffect, useState } from 'react';
import {
  armFullscreenRestore,
  cancelFullscreenRestore,
  exitFullscreen,
  getFullscreenElement,
  isFullscreenSupported,
  noteFullscreenChange,
  readFullscreenPreference,
  requestFullscreen,
  writeFullscreenPreference,
  type FullscreenDocument,
} from '../lib/fullscreen';

/**
 * Fullscreen toggle for the till.
 *
 * A shop counter runs one application all day, and the browser's address bar,
 * tabs and bookmarks are wasted vertical space as well as an invitation to
 * navigate away mid-sale. This puts the app edge to edge.
 *
 * The browser only grants fullscreen from a real user gesture, so there is no
 * way to start fullscreen from JavaScript on load — `restoreOnNextGesture`
 * below is the closest honest approximation, and the README documents real
 * kiosk mode for a permanent setup. Printing is handled separately, by
 * usePrint, because the browser's print dialog also takes fullscreen away.
 *
 * The API mechanics live in src/lib/fullscreen.ts; this is the React glue.
 */

export interface UseFullscreenOptions {
  /**
   * After a reload, re-enter fullscreen on the next click or key press, if the
   * user was fullscreen when the page went away. A till reloads — an update, a
   * crash, a restarted machine — and making the cashier re-enable this each
   * time is the sort of small friction that gets a feature abandoned. It never
   * swallows the event that triggered it.
   */
  restoreOnNextGesture?: boolean;
}

export const useFullscreen = ({ restoreOnNextGesture = false }: UseFullscreenOptions = {}) => {
  const doc = typeof document === 'undefined' ? null : (document as FullscreenDocument);

  const [isSupported] = useState(() => (doc ? isFullscreenSupported(doc) : false));
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(doc && getFullscreenElement(doc)));
  const [error, setError] = useState<string | null>(null);

  // The document is the source of truth, because Esc and F11 leave fullscreen
  // without going through us.
  useEffect(() => {
    if (!doc) return;
    const sync = () => {
      setIsFullscreen(Boolean(getFullscreenElement(doc)));
      // Leaving by Esc is a choice; leaving because a print dialog opened is
      // not. Only the first should stop the app restoring fullscreen later.
      noteFullscreenChange(doc);
    };
    doc.addEventListener('fullscreenchange', sync);
    doc.addEventListener('webkitfullscreenchange', sync);
    return () => {
      doc.removeEventListener('fullscreenchange', sync);
      doc.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [doc]);

  // An explicit enter or exit overrides any restore waiting on the next click.
  const enter = useCallback(async () => {
    if (!doc) return false;
    cancelFullscreenRestore();
    const failure = await requestFullscreen(doc);
    setError(failure);
    return failure === null;
  }, [doc]);

  const exit = useCallback(async () => {
    if (!doc) return false;
    cancelFullscreenRestore();
    const failure = await exitFullscreen(doc);
    setError(failure);
    return failure === null;
  }, [doc]);

  const toggle = useCallback(async () => {
    if (!doc) return false;
    const goingFullscreen = !getFullscreenElement(doc);
    const ok = goingFullscreen ? await enter() : await exit();
    // Only remember an intent the browser actually honoured.
    if (ok) writeFullscreenPreference(goingFullscreen);
    return ok;
  }, [doc, enter, exit]);

  useEffect(() => {
    if (!doc || !restoreOnNextGesture || !isSupported) return;
    if (!readFullscreenPreference() || getFullscreenElement(doc)) return;
    // Disarm only what this mount armed, so a restore set up by a print is not
    // cancelled just because the page changed.
    const disarm = armFullscreenRestore(doc);
    return () => { disarm?.(); };
  }, [doc, restoreOnNextGesture, isSupported]);

  return { isSupported, isFullscreen, toggle, enter, exit, error };
};
