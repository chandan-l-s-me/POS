/**
 * The Fullscreen API shim.
 *
 * These run against fake documents rather than a browser. The parts that
 * actually break in the field are browser-shaped, not logic-shaped: Safari's
 * prefixed spelling, a rejected request when there was no user gesture, and
 * localStorage throwing in a private window. Each is reproduced here.
 *
 * What this does NOT cover: that a real browser goes fullscreen when the
 * button is clicked. That needs a real browser and a real gesture.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  armFullscreenRestore,
  cancelFullscreenRestore,
  exitFullscreen,
  FULLSCREEN_PREFERENCE_KEY,
  getFullscreenElement,
  isFullscreenRestorePending,
  isFullscreenSupported,
  isPrintInProgress,
  noteFullscreenChange,
  readFullscreenPreference,
  requestFullscreen,
  watchFullscreenDuringPrint,
  writeFullscreenPreference,
  type FullscreenDocument,
} from '../src/lib/fullscreen.ts';

/** A document that speaks the standard spelling. */
const standardDoc = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const element = {
    requestFullscreen: async () => { calls.push('request'); doc.fullscreenElement = element as any; },
  };
  const doc: any = {
    fullscreenEnabled: true,
    fullscreenElement: null,
    documentElement: element,
    exitFullscreen: async () => { calls.push('exit'); doc.fullscreenElement = null; },
    ...overrides,
  };
  return { doc: doc as FullscreenDocument, calls };
};

/** A document that only speaks the webkit spelling, as Safari does. */
const webkitDoc = (overrides: Record<string, unknown> = {}) => {
  const calls: string[] = [];
  const element = {
    webkitRequestFullscreen: async () => { calls.push('request'); doc.webkitFullscreenElement = element as any; },
  };
  const doc: any = {
    webkitFullscreenEnabled: true,
    webkitFullscreenElement: null,
    documentElement: element,
    webkitExitFullscreen: async () => { calls.push('exit'); doc.webkitFullscreenElement = null; },
    ...overrides,
  };
  return { doc: doc as FullscreenDocument, calls };
};

describe('support detection', () => {
  it('recognises the standard spelling', () => {
    assert.equal(isFullscreenSupported(standardDoc().doc), true);
  });

  it('recognises the webkit spelling', () => {
    assert.equal(isFullscreenSupported(webkitDoc().doc), true);
  });

  it('reports unsupported when the browser has no request method', () => {
    // iPhone Safari: no usable fullscreen for ordinary elements.
    const doc = { fullscreenEnabled: true, documentElement: {} } as any;
    assert.equal(isFullscreenSupported(doc), false);
  });

  it('reports unsupported when fullscreen is disabled by policy', () => {
    // An embedded frame without allow="fullscreen".
    const { doc } = standardDoc({ fullscreenEnabled: false });
    assert.equal(isFullscreenSupported(doc), false);
  });

  it('does not throw on a document with no documentElement', () => {
    assert.equal(isFullscreenSupported({ documentElement: null } as any), false);
  });
});

describe('reading the current state', () => {
  it('reads the standard property', () => {
    const { doc } = standardDoc();
    assert.equal(getFullscreenElement(doc), null);
    (doc as any).fullscreenElement = { tag: 'html' };
    assert.deepEqual(getFullscreenElement(doc), { tag: 'html' });
  });

  it('falls back to the webkit property', () => {
    const { doc } = webkitDoc();
    assert.equal(getFullscreenElement(doc), null);
    (doc as any).webkitFullscreenElement = { tag: 'html' };
    assert.deepEqual(getFullscreenElement(doc), { tag: 'html' });
  });
});

describe('entering and leaving', () => {
  it('enters and leaves using the standard methods', async () => {
    const { doc, calls } = standardDoc();
    assert.equal(await requestFullscreen(doc), null);
    assert.ok(getFullscreenElement(doc), 'should now be fullscreen');
    assert.equal(await exitFullscreen(doc), null);
    assert.equal(getFullscreenElement(doc), null);
    assert.deepEqual(calls, ['request', 'exit']);
  });

  it('enters and leaves using the webkit methods', async () => {
    const { doc, calls } = webkitDoc();
    assert.equal(await requestFullscreen(doc), null);
    assert.ok(getFullscreenElement(doc));
    assert.equal(await exitFullscreen(doc), null);
    assert.equal(getFullscreenElement(doc), null);
    assert.deepEqual(calls, ['request', 'exit']);
  });

  it('returns the browser message when the request is refused', async () => {
    // What a browser does when there was no user gesture.
    const { doc } = standardDoc();
    (doc.documentElement as any).requestFullscreen = async () => {
      throw new Error('Permissions check failed');
    };
    assert.equal(await requestFullscreen(doc), 'Permissions check failed');
  });

  it('reports a refusal even when the error carries no message', async () => {
    const { doc } = standardDoc();
    (doc.documentElement as any).requestFullscreen = async () => { throw {}; };
    assert.equal(await requestFullscreen(doc), 'Could not switch to full screen.');
  });

  it('says so when the browser cannot do it at all', async () => {
    const doc = { documentElement: {} } as any;
    assert.match(String(await requestFullscreen(doc)), /not available/);
  });

  it('leaving when not fullscreen is a silent no-op', async () => {
    const { doc, calls } = standardDoc();
    assert.equal(await exitFullscreen(doc), null);
    assert.deepEqual(calls, [], 'must not call exitFullscreen when not fullscreen');
  });

  it('returns the browser message when leaving fails', async () => {
    const { doc } = standardDoc();
    await requestFullscreen(doc);
    (doc as any).exitFullscreen = async () => { throw new Error('Document not active'); };
    assert.equal(await exitFullscreen(doc), 'Document not active');
  });
});

describe('the remembered preference', () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => { map.set(k, v); },
    };
  };

  it('round-trips true and false', () => {
    const store = fakeStorage();
    assert.equal(readFullscreenPreference(store), false, 'defaults to off');

    writeFullscreenPreference(true, store);
    assert.equal(store.map.get(FULLSCREEN_PREFERENCE_KEY), 'true');
    assert.equal(readFullscreenPreference(store), true);

    writeFullscreenPreference(false, store);
    assert.equal(readFullscreenPreference(store), false);
  });

  it('treats anything other than "true" as off', () => {
    const store = fakeStorage();
    store.map.set(FULLSCREEN_PREFERENCE_KEY, 'yes');
    assert.equal(readFullscreenPreference(store), false);
  });

  it('survives storage that throws, as in a private window', () => {
    // A till must not fail to load over a display preference.
    const blocked = {
      getItem: () => { throw new Error('The operation is insecure.'); },
      setItem: () => { throw new Error('The operation is insecure.'); },
    };
    assert.equal(readFullscreenPreference(blocked), false);
    assert.doesNotThrow(() => writeFullscreenPreference(true, blocked));
  });
});

/**
 * A document that behaves like a browser for fullscreen purposes: it keeps
 * listeners, fires fullscreenchange, and can refuse a request the way Chrome
 * does when there is no fresh user gesture.
 */
class FakeBrowserDocument {
  fullscreenEnabled = true;
  fullscreenElement: unknown = null;
  /** When true, requestFullscreen is refused, as with no user gesture. */
  refuse = false;
  requests = 0;
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  documentElement = {
    requestFullscreen: async () => {
      this.requests += 1;
      if (this.refuse) throw new Error('Permissions check failed');
      this.fullscreenElement = this.documentElement;
      this.emit('fullscreenchange');
    },
  };

  exitFullscreen = async () => {
    this.fullscreenElement = null;
    this.emit('fullscreenchange');
  };

  addEventListener(type: string, fn: (event: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: (event: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }

  emit(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type });
  }

  listenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }

  /** What Chrome does when its print dialog opens. */
  browserTakesFullscreenAway() {
    this.fullscreenElement = null;
    this.emit('fullscreenchange');
  }

  asDocument() {
    return this as unknown as FullscreenDocument;
  }
}

/** A fake that starts in fullscreen, as the till would be. */
const fullscreenBrowser = () => {
  const browser = new FakeBrowserDocument();
  browser.fullscreenElement = browser.documentElement;
  return browser;
};

/** Let pending promises (the async requestFullscreen) settle. */
const flush = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('printing keeps the till in full screen', () => {
  // The restore and the print watch are module-level state. Two of these tests
  // once failed only because an earlier one's watch was still inside its
  // settle window, so make sure nothing carries over.
  afterEach(async () => {
    cancelFullscreenRestore();
    for (let i = 0; i < 50 && isPrintInProgress(); i++) await wait(10);
    assert.equal(isPrintInProgress(), false, 'a test left a print watch running');
  });

  it('goes straight back when the print is quick enough to still count as the click', async () => {
    const browser = fullscreenBrowser();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 5 });

    browser.browserTakesFullscreenAway();          // the print dialog opens
    assert.equal(getFullscreenElement(browser.asDocument()), null);
    assert.ok(isFullscreenRestorePending(), 'the exit during printing must arm a restore');

    done();                                         // the dialog closes
    await flush();
    assert.ok(getFullscreenElement(browser.asDocument()), 'back in full screen without another click');
    assert.equal(isFullscreenRestorePending(), false);
  });

  it('goes back on the next tap when the browser refuses straight after printing', async () => {
    const browser = fullscreenBrowser();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 5 });

    browser.browserTakesFullscreenAway();
    browser.refuse = true;                          // the click that printed has gone stale
    done();
    await flush();
    assert.equal(getFullscreenElement(browser.asDocument()), null);
    assert.ok(isFullscreenRestorePending(), 'still waiting for a gesture');

    browser.refuse = false;
    browser.emit('click');                          // the cashier taps anything
    await flush();
    assert.ok(getFullscreenElement(browser.asDocument()), 'back in full screen after the tap');
    assert.equal(isFullscreenRestorePending(), false);
    assert.equal(browser.listenerCount('click'), 0, 'no listener left behind');
    assert.equal(browser.listenerCount('keydown'), 0);
  });

  it('copes with the exit being reported only after print returns', async () => {
    // Chrome's print() blocks the page while the dialog is open, so the
    // fullscreenchange for the exit is delivered after printing is "done".
    const browser = fullscreenBrowser();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 50 });

    done();
    browser.browserTakesFullscreenAway();
    await flush();
    assert.ok(getFullscreenElement(browser.asDocument()), 'restored as soon as the late exit arrives');
  });

  it('does nothing when the browser keeps full screen through printing', async () => {
    // Chrome in kiosk mode with --kiosk-printing, for instance.
    const browser = fullscreenBrowser();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 5 });
    done();
    await wait(20);
    assert.equal(isFullscreenRestorePending(), false);
    assert.equal(browser.requests, 0, 'no pointless request');
    assert.equal(browser.listenerCount('fullscreenchange'), 0, 'the watch cleans up after itself');
    assert.equal(isPrintInProgress(), false);
  });

  it('does nothing when printing from outside full screen', async () => {
    const browser = new FakeBrowserDocument();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 5 });
    assert.equal(browser.listenerCount('fullscreenchange'), 0);
    assert.equal(isPrintInProgress(), false);
    done();
    browser.emit('click');
    await flush();
    assert.equal(browser.requests, 0, 'must not force full screen on someone who was not using it');
  });

  it('is not used up by a key the browser refuses to count, such as Esc', async () => {
    const browser = new FakeBrowserDocument();
    armFullscreenRestore(browser.asDocument());

    browser.refuse = true;
    browser.emit('keydown');                        // Esc: not a user gesture
    await flush();
    assert.ok(isFullscreenRestorePending(), 'a refused attempt must leave the restore armed');

    browser.refuse = false;
    browser.emit('click');
    await flush();
    assert.ok(getFullscreenElement(browser.asDocument()));
  });

  it('can be cancelled by an explicit choice', async () => {
    const browser = new FakeBrowserDocument();
    armFullscreenRestore(browser.asDocument());
    cancelFullscreenRestore();
    assert.equal(isFullscreenRestorePending(), false);

    browser.emit('click');
    await flush();
    assert.equal(browser.requests, 0);
    assert.equal(browser.listenerCount('click'), 0);
  });

  it('only ever has one restore pending', () => {
    const browser = new FakeBrowserDocument();
    const first = armFullscreenRestore(browser.asDocument());
    const second = armFullscreenRestore(browser.asDocument());
    assert.ok(first, 'the first call arms a restore');
    assert.equal(second, null, 'a second call must not stack another');
    assert.equal(browser.listenerCount('click'), 1);
  });

  it('stops listening when full screen comes back by some other route', async () => {
    const browser = new FakeBrowserDocument();
    armFullscreenRestore(browser.asDocument());
    await browser.documentElement.requestFullscreen(); // e.g. the toolbar button
    assert.equal(isFullscreenRestorePending(), false);
    assert.equal(browser.listenerCount('click'), 0);
  });

  it('stops treating the page as printing once full screen is back', async () => {
    // Otherwise an Esc pressed just after a print would be mistaken for the
    // print dialog's doing, and full screen would be forced back on reload.
    const browser = fullscreenBrowser();
    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 60_000 });
    browser.browserTakesFullscreenAway();
    done();
    await flush();
    assert.ok(getFullscreenElement(browser.asDocument()));
    assert.equal(isPrintInProgress(), false, 'must not wait out the settle window once restored');
  });

  it('gives up if a print never reports back', async () => {
    const browser = fullscreenBrowser();
    watchFullscreenDuringPrint(browser.asDocument(), { limitMs: 10 });
    assert.equal(isPrintInProgress(), true);
    await wait(30);
    assert.equal(isPrintInProgress(), false);
    assert.equal(browser.listenerCount('fullscreenchange'), 0);
  });
});

describe('remembering full screen across reloads', () => {
  afterEach(() => cancelFullscreenRestore());

  const store = () => {
    const map = new Map<string, string>();
    return { map, setItem: (k: string, v: string) => { map.set(k, v); } };
  };

  it('forgets it when the user leaves on purpose (Esc or F11)', () => {
    const browser = new FakeBrowserDocument();
    const s = store();
    s.setItem(FULLSCREEN_PREFERENCE_KEY, 'true');
    noteFullscreenChange(browser.asDocument(), s);
    assert.equal(s.map.get(FULLSCREEN_PREFERENCE_KEY), 'false');
  });

  it('keeps it when a print dialog forced the exit', async () => {
    const browser = fullscreenBrowser();
    const s = store();
    s.setItem(FULLSCREEN_PREFERENCE_KEY, 'true');

    const done = watchFullscreenDuringPrint(browser.asDocument(), { settleMs: 5 });
    browser.refuse = true;
    browser.browserTakesFullscreenAway();
    noteFullscreenChange(browser.asDocument(), s);
    assert.equal(s.map.get(FULLSCREEN_PREFERENCE_KEY), 'true', 'printing is not a choice to leave');
    done();
    await wait(20);
  });

  it('leaves it alone on entering full screen', () => {
    const browser = fullscreenBrowser();
    const s = store();
    s.setItem(FULLSCREEN_PREFERENCE_KEY, 'true');
    noteFullscreenChange(browser.asDocument(), s);
    assert.equal(s.map.get(FULLSCREEN_PREFERENCE_KEY), 'true');
  });
});
