import { useEffect, useRef } from 'react';

/**
 * The phone's back button in the Android app.
 *
 * Quick Bill's steps — the customer, item and settings sheets, the number pad,
 * the "Bill saved" screen — are drawn over one page rather than being pages of
 * their own, so there was no history for back to return through and Android
 * closed the app. MainActivity.java now asks the page first by calling
 * `window.vyaparaBack()`: back closes whatever was opened last, and only when
 * nothing is open does the app go to the background.
 *
 * The stack is plain functions so it can be tested without a browser. See
 * `tests/back-button.test.ts`.
 */

export type BackStack = {
  /** Add a step back should close. Returns a function that removes it again. */
  push: (onBack: () => void) => () => void;
  /** Close the step opened last. False when nothing is open. */
  back: () => boolean;
  size: () => number;
};

export const createBackStack = (): BackStack => {
  const steps: Array<() => void> = [];
  return {
    push: (onBack) => {
      const step = () => onBack();
      steps.push(step);
      return () => {
        const index = steps.lastIndexOf(step);
        if (index >= 0) steps.splice(index, 1);
      };
    },
    back: () => {
      const step = steps[steps.length - 1];
      if (!step) return false;
      step();
      return true;
    },
    size: () => steps.length,
  };
};

const backStack = createBackStack();

declare global {
  interface Window {
    /** Called by the Android app on back. True when the page handled it. */
    vyaparaBack?: () => boolean;
  }
}

if (typeof window !== 'undefined') window.vyaparaBack = backStack.back;

/**
 * While `open`, back calls `onBack` instead of leaving the app. Steps opened
 * later are closed first, so a number pad over the item list closes before
 * the list does.
 */
export const useBackButton = (open: boolean, onBack: () => void) => {
  // Always call the latest handler, without re-registering (and so losing the
  // step's place in the stack) every time the parent re-renders.
  const latest = useRef(onBack);
  latest.current = onBack;
  useEffect(() => {
    if (!open) return;
    return backStack.push(() => latest.current());
  }, [open]);
};
