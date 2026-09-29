/**
 * Browser shim for the Fullscreen API.
 *
 * Kept apart from the React hook so the awkward parts — Safari's prefixed
 * spelling, and localStorage throwing — are plain functions that take the
 * document they act on, and can be tested against a fake one. See
 * `tests/fullscreen.test.ts`.
 */

/** The prefixed members the DOM lib does not type. */
export type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};

export type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

/**
 * The element currently filling the screen, or null.
 *
 * Always ask the document rather than tracking our own last call: the user can
 * leave fullscreen with Esc or F11 without going through the app, and a button
 * that disagrees with the actual state is worse than no button.
 */
export const getFullscreenElement = (doc: FullscreenDocument): Element | null =>
  doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

/**
 * Whether fullscreen can work here at all.
 *
 * iPhone Safari exposes no usable fullscreen for ordinary elements, and an
 * embedded frame can have it disabled by permissions policy. Callers hide the
 * control when this is false rather than offering a button that does nothing.
 */
export const isFullscreenSupported = (doc: FullscreenDocument): boolean => {
  const target = doc.documentElement as FullscreenElement | null;
  if (!target) return false;
  const enabled = doc.fullscreenEnabled || doc.webkitFullscreenEnabled;
  const canRequest = Boolean(target.requestFullscreen || target.webkitRequestFullscreen);
  return Boolean(enabled) && canRequest;
};

/** Enter fullscreen. Resolves to an error message, or null on success. */
export const requestFullscreen = async (doc: FullscreenDocument): Promise<string | null> => {
  const target = doc.documentElement as FullscreenElement | null;
  const request = target && (target.requestFullscreen ?? target.webkitRequestFullscreen);
  if (!target || !request) return 'Full screen is not available in this browser.';
  try {
    await request.call(target);
    return null;
  } catch (err: any) {
    // Usually "not initiated by a user gesture", or blocked by policy.
    return err?.message || 'Could not switch to full screen.';
  }
};

/** Leave fullscreen. Resolves to an error message, or null on success/no-op. */
export const exitFullscreen = async (doc: FullscreenDocument): Promise<string | null> => {
  if (!getFullscreenElement(doc)) return null;
  const release = doc.exitFullscreen ?? doc.webkitExitFullscreen;
  if (!release) return 'Could not leave full screen.';
  try {
    await release.call(doc);
    return null;
  } catch (err: any) {
    return err?.message || 'Could not leave full screen.';
  }
};

export const FULLSCREEN_PREFERENCE_KEY = 'vyapara:fullscreen';

/**
 * Remembered preference.
 *
 * localStorage throws in a private window and wherever site data is blocked,
 * and a till must not fail to load over a display preference — so both of
 * these swallow the failure and carry on.
 */
export const readFullscreenPreference = (storage?: Pick<Storage, 'getItem'>): boolean => {
  try {
    const store = storage ?? window.localStorage;
    return store.getItem(FULLSCREEN_PREFERENCE_KEY) === 'true';
  } catch {
    return false;
  }
};

export const writeFullscreenPreference = (
  value: boolean,
  storage?: Pick<Storage, 'setItem'>
): void => {
  try {
    const store = storage ?? window.localStorage;
    store.setItem(FULLSCREEN_PREFERENCE_KEY, String(value));
  } catch {
    /* a convenience, not something to fail over */
  }
};

// ---------------------------------------------------------------------------
// Getting fullscreen back after the browser takes it away
//
// Chrome leaves HTML fullscreen whenever it opens its print dialog, and no page
// can stop it. Printing a bill therefore dropped the till out of full screen
// every time. What a page *can* do is ask again afterwards — but only from a
// user gesture, so the restore below tries at once (the click that started the
// print may still count) and otherwise waits for the next click or key press.

type RestoreHandle = { attempt: () => Promise<void>; disarm: () => void };

/** At most one restore is ever pending, however many callers ask for one. */
let pendingRestore: RestoreHandle | null = null;

export const isFullscreenRestorePending = () => pendingRestore !== null;

/**
 * Re-enter fullscreen at the first moment the browser allows it.
 *
 * Retries on every click and key press until one is accepted. That matters:
 * the Escape key is not a user gesture as far as the browser is concerned, so
 * a one-shot listener could be used up by a refused attempt and never fire
 * again.
 *
 * Returns a function that disarms the restore this call set up, or null when
 * there was nothing to arm (already fullscreen, or a restore already pending).
 */
export const armFullscreenRestore = (doc: FullscreenDocument): (() => void) | null => {
  if (pendingRestore || getFullscreenElement(doc)) return null;

  let inFlight = false;
  const handle: RestoreHandle = {
    attempt: async () => {
      if (pendingRestore !== handle || inFlight) return;
      if (getFullscreenElement(doc)) {
        handle.disarm();
        return;
      }
      inFlight = true;
      const failure = await requestFullscreen(doc);
      inFlight = false;
      // On failure — normally just "no user gesture yet" — stay armed.
      if (failure === null) handle.disarm();
    },
    disarm: () => {
      doc.removeEventListener('click', onGesture);
      doc.removeEventListener('keydown', onGesture);
      doc.removeEventListener('fullscreenchange', onChange);
      doc.removeEventListener('webkitfullscreenchange', onChange);
      if (pendingRestore === handle) pendingRestore = null;
    },
  };
  function onGesture() { void handle.attempt(); }
  function onChange() { if (getFullscreenElement(doc)) handle.disarm(); }

  // Bubble phase, on the document, so a control's own handler runs first. That
  // matters for the fullscreen button: it cancels the pending restore before
  // this listener would fire, so the two can never fight over one click.
  // `click` rather than `pointerdown`: on a touchscreen till the gesture only
  // counts once the finger lifts.
  doc.addEventListener('click', onGesture);
  doc.addEventListener('keydown', onGesture);
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  pendingRestore = handle;
  return handle.disarm;
};

/** Try the pending restore now, if there is one. */
export const attemptFullscreenRestore = (): Promise<void> =>
  pendingRestore ? pendingRestore.attempt() : Promise.resolve();

/** The user made an explicit choice; stop waiting to restore. */
export const cancelFullscreenRestore = (): void => {
  pendingRestore?.disarm();
};

let activePrintWatches = 0;

/**
 * True while a print the app started may still have the browser's dialog open.
 * This is how a print-forced exit is told apart from the user pressing Esc.
 */
export const isPrintInProgress = () => activePrintWatches > 0;

const PRINT_WATCH_LIMIT_MS = 2 * 60 * 1000;
const PRINT_SETTLE_MS = 1500;

/**
 * Call as a print starts; call the function it returns once printing is over.
 *
 * If the page was fullscreen and the browser takes that away while printing,
 * this arms a restore, and tries it the moment printing is done. If the
 * browser keeps fullscreen through printing — Chrome in kiosk mode with
 * --kiosk-printing, for instance — it does nothing at all.
 *
 * The exit can be reported *after* printing is done: Chrome's print() blocks
 * the page while the dialog is open, so the fullscreenchange event is only
 * delivered once it returns. So listening carries on for a moment afterwards.
 */
export const watchFullscreenDuringPrint = (
  doc: FullscreenDocument,
  { limitMs = PRINT_WATCH_LIMIT_MS, settleMs = PRINT_SETTLE_MS } = {}
): (() => void) => {
  if (!getFullscreenElement(doc)) return () => {};

  let finished = false;
  let stopped = false;
  let settle: ReturnType<typeof setTimeout> | undefined;

  const onChange = () => {
    if (getFullscreenElement(doc)) {
      // Back in full screen after printing: the watch has done its job. Stop
      // now rather than at the end of the settle window, so an Esc straight
      // afterwards is correctly read as the user's own choice.
      if (finished) stop();
      return;
    }
    armFullscreenRestore(doc);
    // The dialog has already closed, so there is no reason to wait for a
    // gesture before the first try.
    if (finished) void attemptFullscreenRestore();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    activePrintWatches -= 1;
    clearTimeout(limit);
    clearTimeout(settle);
    doc.removeEventListener('fullscreenchange', onChange);
    doc.removeEventListener('webkitfullscreenchange', onChange);
  };

  activePrintWatches += 1;
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  // A print that never reports back must not leave the watch running forever.
  const limit = setTimeout(stop, limitMs);

  return () => {
    if (finished || stopped) return;
    finished = true;
    if (isFullscreenRestorePending()) void attemptFullscreenRestore();
    settle = setTimeout(stop, settleMs);
  };
};

/**
 * Keep the remembered preference honest when fullscreen changes by some route
 * other than the app's own button. Leaving by Esc or F11 is a choice, so the
 * app should not pull the user back in after a reload. Leaving because a print
 * dialog opened is not a choice, and must not count.
 */
export const noteFullscreenChange = (
  doc: FullscreenDocument,
  storage?: Pick<Storage, 'setItem'>
): void => {
  if (!getFullscreenElement(doc) && !isPrintInProgress()) {
    writeFullscreenPreference(false, storage);
  }
};
