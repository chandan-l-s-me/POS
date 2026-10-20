/**
 * The Android back button's step stack (src/lib/backButton.ts).
 *
 * What this does NOT cover: that MainActivity calls window.vyaparaBack() and
 * sends the app to the background on false. That needs a phone.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createBackStack } from '../src/lib/backButton.ts';

describe('back button stack', () => {
  it('reports nothing handled when no step is open, so the app goes to the background', () => {
    const stack = createBackStack();
    assert.equal(stack.back(), false);
  });

  it('closes the step opened last first: the number pad before the item list', () => {
    const stack = createBackStack();
    const closed: string[] = [];
    const removeList = stack.push(() => { closed.push('items'); removeList(); });
    const removePad = stack.push(() => { closed.push('keypad'); removePad(); });

    assert.equal(stack.back(), true);
    assert.deepEqual(closed, ['keypad']);
    assert.equal(stack.back(), true);
    assert.deepEqual(closed, ['keypad', 'items']);
    assert.equal(stack.back(), false);
  });

  it('forgets a step closed with its own button, so back does not close it twice', () => {
    const stack = createBackStack();
    const closed: string[] = [];
    stack.push(() => closed.push('items'));
    const removePad = stack.push(() => closed.push('keypad'));

    removePad(); // tapped ✕ on the number pad
    stack.back();
    assert.deepEqual(closed, ['items']);
  });

  it('removes only its own entry when the same handler is open twice', () => {
    const stack = createBackStack();
    const onBack = () => undefined;
    const removeFirst = stack.push(onBack);
    stack.push(onBack);
    removeFirst();
    removeFirst(); // a second cleanup must not remove the other entry
    assert.equal(stack.size(), 1);
  });
});
