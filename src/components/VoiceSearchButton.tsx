import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Mic } from 'lucide-react';
import { t } from '../i18n';
import { getSpeechEngine } from '../lib/speech';
import { cn } from '../lib/utils';
import { isVoiceShortcut } from '../lib/voiceShortcut';
import { useVoiceSearch, type VoiceSearchOptions } from '../hooks/useVoiceSearch';

/**
 * The microphone inside a search box (see src/hooks/useVoiceSearch.ts).
 *
 * Put it right after the box, inside the same `relative` wrapper: that is how
 * it finds the box, and it sits over the box's right edge, so give the box
 * room on the right. It does not appear where the device has no speech
 * recogniser (Firefox, or a phone app from before voice search).
 *
 * At the counter, F2 (or Ctrl+M, src/lib/voiceShortcut.ts) starts and stops
 * it: the box that is listening, else the box that has the cursor, else the
 * page's main search, marked `shortcut`.
 */

/** Whether this device can search by voice: for a microphone that is not in a search box. */
export const hasVoiceSearch = () => getSpeechEngine() !== null;

type Size = 'sm' | 'md' | 'lg';

interface VoiceSearchButtonProps<T> extends Omit<VoiceSearchOptions<T>, 'getInput'> {
  /** F2 starts this one when no search box with a microphone has the cursor. */
  shortcut?: boolean;
  /** Start listening as soon as it appears (a phone's "search by voice" tap). */
  autoStart?: boolean;
  /** sm: a table row's box; md: a form field; lg: a phone's search box. */
  size?: Size;
  className?: string;
}

const SIZES: Record<Size, { button: string; icon: number }> = {
  sm: { button: 'h-7 w-7 right-1', icon: 15 },
  md: { button: 'h-9 w-9 right-1.5', icon: 18 },
  lg: { button: 'h-10 w-10 right-1.5', icon: 20 },
};

// --- F2 / Ctrl+M ---------------------------------------------------------------

interface ShortcutTarget {
  input: () => HTMLInputElement | null;
  listening: () => boolean;
  toggle: () => void;
  fallback: boolean;
}

const shortcutTargets: ShortcutTarget[] = [];

const onShortcutKey = (event: KeyboardEvent) => {
  if (!isVoiceShortcut(event)) return;
  const target =
    shortcutTargets.find((entry) => entry.listening()) ??
    shortcutTargets.find((entry) => entry.input() !== null && entry.input() === document.activeElement) ??
    [...shortcutTargets].reverse().find((entry) => entry.fallback);
  if (!target) return;
  event.preventDefault();
  target.toggle();
};

const addShortcutTarget = (target: ShortcutTarget) => {
  if (!shortcutTargets.length) window.addEventListener('keydown', onShortcutKey);
  shortcutTargets.push(target);
  return () => {
    const index = shortcutTargets.indexOf(target);
    if (index >= 0) shortcutTargets.splice(index, 1);
    if (!shortcutTargets.length) window.removeEventListener('keydown', onShortcutKey);
  };
};

// --- A problem, shown under the button -----------------------------------------

/** Over everything (Quick Bill's sheets included), so a table's scroll box cannot hide it. */
const VoiceMessage = ({ anchor, message }: { anchor: HTMLElement | null; message: string }) => {
  const [place, setPlace] = useState<{ top: number; right: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const box = anchor.getBoundingClientRect();
    setPlace({ top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) });
  }, [anchor, message]);
  if (!place) return null;
  return createPortal(
    <p
      role="alert"
      style={{ top: place.top, right: place.right }}
      className="pointer-events-none fixed z-[70] max-w-[min(18rem,calc(100vw-1rem))] rounded-xl bg-gray-900 px-3 py-2 text-xs font-semibold text-white shadow-lg"
    >
      {message}
    </p>,
    document.body
  );
};

export const VoiceSearchButton = <T,>({ shortcut = false, autoStart = false, size = 'md', className, ...options }: VoiceSearchButtonProps<T>) => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const getInput = useCallback(() => buttonRef.current?.parentElement?.querySelector('input') ?? null, []);
  const voice = useVoiceSearch({ ...options, getInput });

  const latest = useRef(voice);
  latest.current = voice;
  useEffect(() => {
    if (!voice.supported) return;
    return addShortcutTarget({
      input: getInput,
      listening: () => latest.current.listening,
      toggle: () => latest.current.toggle(),
      fallback: shortcut,
    });
  }, [voice.supported, shortcut, getInput]);

  useEffect(() => {
    // Only on first appearing.
    if (autoStart) voice.start();
  }, []);

  if (!voice.supported) return null;
  const { button, icon } = SIZES[size];
  const label = voice.listening ? t('Stop listening (F2)') : t('Search by voice (F2)');

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        // Keep the cursor in the box, so its list of matches stays open.
        onMouseDown={(event) => event.preventDefault()}
        onClick={voice.toggle}
        aria-label={label}
        aria-pressed={voice.listening}
        title={label}
        className={cn(
          'absolute top-1/2 z-10 flex -translate-y-1/2 items-center justify-center rounded-full transition-colors',
          button,
          voice.listening ? 'bg-red-500 text-white' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-700',
          className
        )}
      >
        {voice.listening && (
          // A ring that breathes while listening, and swells with the voice
          // where the recogniser reports how loud it is (the phone app).
          <span
            aria-hidden
            style={{ transform: `scale(${1 + voice.level * 0.5})` }}
            className={cn('absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-100', !voice.heard && 'animate-ping')}
          />
        )}
        <Mic size={icon} className="relative" />
      </button>
      <span className="sr-only" aria-live="polite">{voice.listening ? t('Listening…') : ''}</span>
      {voice.message && <VoiceMessage anchor={buttonRef.current} message={voice.message} />}
    </>
  );
};
