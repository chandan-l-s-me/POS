import { useEffect, useRef } from 'react';

/**
 * Hardware barcode scanner capture, for the page that mounts it.
 *
 * A USB or Bluetooth scanner is a keyboard: it types the code and presses
 * Enter, far faster than a person can. This listens for that burst and hands
 * the code to `onScan`.
 *
 *  - Fields marked `data-barcode-input` take scans themselves (the billing
 *    search box, the barcode boxes): keys typed there are left alone.
 *  - Scanned with no field focused, the code is simply read.
 *  - Scanned into any other field (the cursor left in a quantity box), the
 *    code is taken back out of that field and read as a scan, and its Enter
 *    does not reach the field. That needs a longer burst, so a person typing
 *    quickly in a field is never mistaken for a scanner.
 *
 * Mounted per page rather than for the whole app, so a code scanned on
 * Settings or Reports never adds an item to a bill nobody is looking at.
 */

// A scanner sends its characters a few milliseconds apart; a person does not.
// Anything slower than this starts again.
const SCANNER_KEY_INTERVAL_MS = 50;
// Shorter than this is far more likely to be a stray keypress than a code.
const MIN_CODE_LENGTH = 4;
// Inside a field, only a burst at least this long counts (EAN-8 and longer).
const MIN_CODE_LENGTH_IN_FIELD = 8;

const isTypingTarget = (target: EventTarget | null): target is HTMLElement =>
  target instanceof HTMLElement &&
  (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

const fieldValue = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : null;

/**
 * Put a field back as it was before the scanner typed into it. Restoring the
 * value from before the burst, rather than cutting the code off the end, also
 * undoes a scan that replaced selected text (a quantity box selects its
 * number when it gets the cursor).
 */
const restoreField = (target: EventTarget | null, before: string | null) => {
  if (before == null || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  if (target.value === before) return;
  const proto = target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  // Through the native setter and an input event, so React's state follows.
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(target, before);
  target.dispatchEvent(new Event('input', { bubbles: true }));
};

export const useBarcodeScanner = (onScan: (code: string) => void, enabled = true) => {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    if (!enabled) return;
    let buffer = '';
    let lastKeyTime = 0;
    let bufferTarget: EventTarget | null = null;
    // The focused field's value when the burst began.
    let valueBefore: string | null = null;

    const handleKeyDown = (e: KeyboardEvent) => {
      // A scanner never holds a modifier, which keeps shortcuts out of codes.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        buffer = '';
        return;
      }
      if (e.target instanceof Element && e.target.closest('[data-barcode-input]')) {
        buffer = '';
        return;
      }

      const now = Date.now();
      if (now - lastKeyTime > SCANNER_KEY_INTERVAL_MS || e.target !== bufferTarget) buffer = '';
      lastKeyTime = now;
      bufferTarget = e.target;

      if (e.key === 'Enter') {
        const code = buffer;
        buffer = '';
        const inField = isTypingTarget(e.target);
        if (code.length < (inField ? MIN_CODE_LENGTH_IN_FIELD : MIN_CODE_LENGTH)) return;
        if (inField) {
          // Before the field's own Enter handling (this listens in the
          // capture phase), so the code does not also move focus or submit.
          e.preventDefault();
          e.stopPropagation();
          restoreField(e.target, valueBefore);
        }
        onScanRef.current(code);
      } else if (e.key.length === 1) {
        // Read before the browser puts this character in the field.
        if (buffer === '') valueBefore = fieldValue(e.target);
        buffer += e.key;
      } else if (e.key !== 'Shift') {
        buffer = '';
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [enabled]);
};
