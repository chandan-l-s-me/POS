/**
 * Search by voice: the conversation with the speech recogniser
 * (src/lib/speech/listen.ts), the browser's recogniser (webSpeech.ts), and
 * the server letting the page use the microphone.
 *
 * The recognisers here are fakes that misbehave the ways real ones do: ending
 * with no result, sending an error after the result, never stopping. What is
 * not covered: a real microphone and a real recogniser, which need a device
 * (see README → Search by voice for the checks to do by hand).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { listen, isListening, type ListenOutcome, type RecognitionHandlers, type SpeechEngine } from '../src/lib/speech/listen.ts';
import { browserRecognition, createWebSpeechEngine, type BrowserRecognition } from '../src/lib/speech/webSpeech.ts';
import { isVoiceShortcut } from '../src/lib/voiceShortcut.ts';
import { startServer } from './helpers.ts';

/** A recogniser the test speaks for. */
const fakeEngine = (options: { throwOnStart?: boolean } = {}) => {
  const calls: string[] = [];
  let handlers: RecognitionHandlers | null = null;
  let language = '';
  const engine: SpeechEngine = {
    name: 'web',
    start: (lang, h) => {
      if (options.throwOnStart) throw new Error('InvalidStateError');
      language = lang;
      handlers = h;
      calls.push('start');
      return { stop: () => calls.push('stop'), abort: () => calls.push('abort') };
    },
  };
  return { engine, calls, say: () => handlers!, language: () => language };
};

/** listen(), recording every outcome. */
const run = (engine: SpeechEngine, options: Partial<Parameters<typeof listen>[1]> = {}) => {
  const outcomes: ListenOutcome[] = [];
  const partials: string[] = [];
  const session = listen(engine, {
    onPartial: (text) => partials.push(text),
    onDone: (outcome) => outcomes.push(outcome),
    ...options,
  });
  return { session, outcomes, partials };
};

describe('listen: one dependable conversation with any recogniser', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setTimeout'] }));
  afterEach(() => mock.timers.reset());

  it('listens in Indian English, passes on the words so far, and ends with the guesses', () => {
    const fake = fakeEngine();
    const { outcomes, partials } = run(fake.engine);
    assert.equal(fake.language(), 'en-IN');
    assert.equal(isListening(), true);
    fake.say().onPartial('sugar');
    fake.say().onPartial('sugar one');
    fake.say().onResult([' sugar one kilo ', 'sugar one kilo', '', 'shugar one kilo']);
    fake.say().onEnd();
    assert.deepEqual(partials, ['sugar', 'sugar one']);
    assert.deepEqual(outcomes, [{ type: 'result', alternatives: ['sugar one kilo', 'shugar one kilo'] }]);
    assert.equal(isListening(), false);
  });

  it('ends exactly once, whatever the recogniser sends after', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine);
    fake.say().onResult(['yeast']);
    fake.say().onError('network');
    fake.say().onPartial('late words');
    fake.say().onEnd();
    mock.timers.tick(60_000);
    assert.equal(outcomes.length, 1);
    assert.deepEqual(outcomes[0], { type: 'result', alternatives: ['yeast'] });
  });

  it('searches for the words heard when the recogniser ends without a final answer', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine);
    fake.say().onPartial('maida');
    fake.say().onEnd();
    assert.deepEqual(outcomes, [{ type: 'result', alternatives: ['maida'] }]);
  });

  it('searches for the words heard when the recogniser then says it heard nothing', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine);
    fake.say().onPartial('rava');
    fake.say().onError('no-speech');
    assert.deepEqual(outcomes, [{ type: 'result', alternatives: ['rava'] }]);
  });

  it('says nothing was heard when the recogniser ends with nothing', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine);
    fake.say().onEnd();
    assert.deepEqual(outcomes, [{ type: 'error', code: 'no-speech' }]);
  });

  it('passes on the recogniser\'s problems', () => {
    for (const code of ['not-allowed', 'network', 'no-microphone', 'busy', 'unavailable'] as const) {
      const fake = fakeEngine();
      const { outcomes } = run(fake.engine);
      fake.say().onError(code);
      assert.deepEqual(outcomes, [{ type: 'error', code }]);
    }
  });

  it('gives up when nobody speaks, and closes the microphone', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine, { noSpeechMs: 7000 });
    mock.timers.tick(6999);
    assert.equal(outcomes.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(outcomes, [{ type: 'error', code: 'no-speech' }]);
    assert.deepEqual(fake.calls, ['start', 'abort']);
  });

  it('keeps listening past the no-speech limit once words have been heard', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine, { noSpeechMs: 7000 });
    fake.say().onPartial('butter');
    mock.timers.tick(8000);
    assert.equal(outcomes.length, 0);
    fake.say().onResult(['butter']);
  });

  it('stops after the longest time allowed, in a shop too noisy to hear a pause', () => {
    const fake = fakeEngine();
    const { outcomes } = run(fake.engine, { maxMs: 15_000, settleMs: 2500 });
    fake.say().onPartial('cocoa powder and');
    mock.timers.tick(15_000);
    assert.deepEqual(fake.calls, ['start', 'stop']);
    fake.say().onResult(['cocoa powder']);
    assert.deepEqual(outcomes, [{ type: 'result', alternatives: ['cocoa powder'] }]);
  });

  it('ends with the words heard if the recogniser never answers a stop', () => {
    const fake = fakeEngine();
    const { session, outcomes } = run(fake.engine, { settleMs: 2500 });
    fake.say().onPartial('cocoa');
    session.stop();
    mock.timers.tick(2499);
    assert.equal(outcomes.length, 0);
    mock.timers.tick(1);
    assert.deepEqual(fake.calls, ['start', 'stop', 'abort']);
    assert.deepEqual(outcomes, [{ type: 'result', alternatives: ['cocoa'] }]);
  });

  it('treats stopping before saying anything as changing one\'s mind, not a problem', () => {
    const fake = fakeEngine();
    const { session, outcomes } = run(fake.engine);
    session.stop();
    fake.say().onEnd();
    assert.deepEqual(outcomes, [{ type: 'cancelled' }]);
  });

  it('cancels at once, and ignores the recogniser after', () => {
    const fake = fakeEngine();
    const { session, outcomes } = run(fake.engine);
    fake.say().onPartial('sugar');
    session.cancel();
    fake.say().onResult(['sugar']);
    assert.deepEqual(outcomes, [{ type: 'cancelled' }]);
    assert.deepEqual(fake.calls, ['start', 'abort']);
  });

  it('uses one microphone at a time: starting another search cancels the first', () => {
    const first = fakeEngine();
    const second = fakeEngine();
    const a = run(first.engine);
    const b = run(second.engine);
    assert.deepEqual(a.outcomes, [{ type: 'cancelled' }]);
    assert.deepEqual(first.calls, ['start', 'abort']);
    second.say().onResult(['maida']);
    assert.deepEqual(b.outcomes, [{ type: 'result', alternatives: ['maida'] }]);
  });

  it('reports a recogniser that will not start, after listen() has returned', () => {
    const fake = fakeEngine({ throwOnStart: true });
    const { outcomes } = run(fake.engine);
    assert.equal(outcomes.length, 0);
    mock.timers.tick(1); // a 0 ms timeout runs after 1 ms
    assert.deepEqual(outcomes, [{ type: 'error', code: 'failed' }]);
  });

  it('keeps the voice level between 0 and 1', () => {
    const fake = fakeEngine();
    const levels: number[] = [];
    run(fake.engine, { onLevel: (level) => levels.push(level) });
    fake.say().onLevel?.(-0.5);
    fake.say().onLevel?.(0.4);
    fake.say().onLevel?.(3);
    assert.deepEqual(levels, [0, 0.4, 1]);
  });
});

// --- The browser's recogniser --------------------------------------------------

/** A stand-in for Chrome's webkitSpeechRecognition. */
class FakeRecognition implements BrowserRecognition {
  static last: FakeRecognition;
  lang = '';
  continuous = true;
  interimResults = false;
  maxAlternatives = 1;
  onresult: BrowserRecognition['onresult'] = null;
  onerror: BrowserRecognition['onerror'] = null;
  onend: BrowserRecognition['onend'] = null;
  calls: string[] = [];
  constructor() {
    FakeRecognition.last = this;
  }
  start() { this.calls.push('start'); }
  stop() { this.calls.push('stop'); }
  abort() { this.calls.push('abort'); }

  /** Results as the browser sends them: each a list of guesses, final or not. */
  emit(results: Array<{ isFinal: boolean; guesses: string[] }>) {
    const list = results.map(({ isFinal, guesses }) =>
      Object.assign(guesses.map((transcript) => ({ transcript })), { isFinal })
    );
    this.onresult?.({ results: list as any });
  }
}

const recording = () => {
  const events: string[] = [];
  const handlers: RecognitionHandlers = {
    onPartial: (text) => events.push(`partial:${text}`),
    onResult: (guesses) => events.push(`result:${guesses.join('|')}`),
    onError: (code) => events.push(`error:${code}`),
    onEnd: () => events.push('end'),
  };
  return { events, handlers };
};

describe('the browser\'s speech recogniser', () => {
  it('is found under either name, and is absent where the browser has none', () => {
    assert.equal(browserRecognition({ webkitSpeechRecognition: FakeRecognition }), FakeRecognition);
    assert.equal(browserRecognition({ SpeechRecognition: FakeRecognition }), FakeRecognition);
    assert.equal(browserRecognition({}), null);
    assert.equal(browserRecognition(undefined), null);
  });

  it('asks for one short phrase in the language given, with words as they come and five guesses', () => {
    const engine = createWebSpeechEngine(FakeRecognition);
    engine.start('en-IN', recording().handlers);
    const recognizer = FakeRecognition.last;
    assert.equal(recognizer.lang, 'en-IN');
    assert.equal(recognizer.continuous, false);
    assert.equal(recognizer.interimResults, true);
    assert.equal(recognizer.maxAlternatives, 5);
    assert.deepEqual(recognizer.calls, ['start']);
  });

  it('passes on the words so far, then every guess for the final words', () => {
    const { events, handlers } = recording();
    createWebSpeechEngine(FakeRecognition).start('en-IN', handlers);
    const recognizer = FakeRecognition.last;
    recognizer.emit([{ isFinal: false, guesses: ['east'] }]);
    recognizer.emit([{ isFinal: true, guesses: ['yeast', 'east', 'yeast'] }]);
    recognizer.onend?.();
    assert.deepEqual(events, ['partial:east', 'result:yeast|east|yeast', 'end']);
  });

  it('puts phrases the browser split up back together', () => {
    const { events, handlers } = recording();
    createWebSpeechEngine(FakeRecognition).start('en-IN', handlers);
    const recognizer = FakeRecognition.last;
    recognizer.emit([{ isFinal: true, guesses: ['dark'] }, { isFinal: false, guesses: ['chocolate'] }]);
    recognizer.emit([{ isFinal: true, guesses: ['dark'] }, { isFinal: true, guesses: ['chocolate', 'chocolates'] }]);
    assert.deepEqual(events, ['partial:dark chocolate', 'result:dark chocolate|dark chocolates']);
  });

  it('names the browser\'s errors as the app does, and keeps quiet about its own abort', () => {
    const cases: Array<[string, string | null]> = [
      ['not-allowed', 'not-allowed'],
      ['service-not-allowed', 'not-allowed'],
      ['no-speech', 'no-speech'],
      ['audio-capture', 'no-microphone'],
      ['network', 'network'],
      ['language-not-supported', 'unavailable'],
      ['bad-grammar', 'failed'],
      ['aborted', null],
    ];
    for (const [browserError, expected] of cases) {
      const { events, handlers } = recording();
      createWebSpeechEngine(FakeRecognition).start('en-IN', handlers);
      FakeRecognition.last.onerror?.({ error: browserError });
      assert.deepEqual(events, expected ? [`error:${expected}`] : [], browserError);
    }
  });

  it('stops and aborts the browser\'s recogniser', () => {
    const recognition = createWebSpeechEngine(FakeRecognition).start('en-IN', recording().handlers);
    recognition.stop();
    recognition.abort();
    assert.deepEqual(FakeRecognition.last.calls, ['start', 'stop', 'abort']);
  });
});

// --- The keyboard ---------------------------------------------------------------

describe('the key that starts search by voice', () => {
  const press = (key: string, held: Partial<Record<'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'repeat', boolean>> = {}) =>
    isVoiceShortcut({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...held });

  it('is F2 on its own, or Ctrl+M', () => {
    assert.equal(press('F2'), true);
    assert.equal(press('m', { ctrlKey: true }), true);
    assert.equal(press('M', { ctrlKey: true }), true);
  });

  it('is not F2 with another key held, nor any other key', () => {
    assert.equal(press('F2', { ctrlKey: true }), false);
    assert.equal(press('F2', { shiftKey: true }), false);
    assert.equal(press('F2', { altKey: true }), false);
    assert.equal(press('F2', { metaKey: true }), false);
    assert.equal(press('m', { ctrlKey: true, shiftKey: true }), false); // Chrome's profile menu
    assert.equal(press('m'), false);
    for (const key of ['F1', 'F3', 'F5', 'F11', 'Enter', 'Escape', '2']) assert.equal(press(key), false, key);
  });

  it('does not start and stop over and over while the key is held down', () => {
    assert.equal(press('F2', { repeat: true }), false);
    assert.equal(press('m', { ctrlKey: true, repeat: true }), false);
  });
});

// --- The server --------------------------------------------------------------

describe('the server lets the app\'s pages use the microphone', () => {
  it('allows the microphone for the app itself only, and still nothing else', async () => {
    const server = await startServer();
    try {
      // Every response carries it; a refused API call is the quickest to get.
      const response = await fetch(`${server.baseUrl}/api/items`);
      const policy = response.headers.get('permissions-policy') ?? '';
      assert.match(policy, /microphone=\(self\)/);
      assert.match(policy, /camera=\(\)/);
      assert.match(policy, /geolocation=\(\)/);
      assert.match(policy, /payment=\(\)/);
    } finally {
      await server.stop();
    }
  });
});
