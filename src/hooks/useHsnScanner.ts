import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useDataStore } from '../store/useDataStore';
import { useCartStore } from '../store/useCartStore';

/**
 * Barcode/HSN scanner capture.
 *
 * A hardware scanner is a keyboard: it types the code and presses Enter, far
 * faster than a person can. This listens for that burst and adds the matching
 * item to the active cart.
 *
 * Two things it must NOT do, both of which it used to:
 *
 *  - Fire while the cashier is typing in a field. The listener is on `window`,
 *    so every keystroke into the item search, the customer name, the quantity
 *    box or the Settings form was also fed to the scanner buffer. A fast
 *    typist who happened to land two keys inside the burst window and then
 *    pressed Enter could add an unrelated item to the bill.
 *  - Fire outside the billing screen. It was mounted in App, so a code scanned
 *    (or typed) on Settings, Customers or Reports silently added an item to a
 *    cart nobody was looking at, which then went out on the next sale.
 */

// A scanner emits its characters in a few milliseconds; a person does not.
// Anything slower than this starts a new buffer.
const SCANNER_KEY_INTERVAL_MS = 50;
// Shorter than this is far more likely to be a stray keypress than a code.
const MIN_CODE_LENGTH = 4;

const isTypingTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

export const useHsnScanner = () => {
  const items = useDataStore((state) => state.items);
  const addItem = useCartStore((state) => state.addItem);
  const location = useLocation();
  const hsnBuffer = useRef<string>('');
  const lastKeyTime = useRef<number>(0);

  const active = location.pathname === '/billing';

  useEffect(() => {
    if (!active) {
      hsnBuffer.current = '';
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // The focused field handles its own input; Billing's search box already
      // resolves an HSN on Enter.
      if (isTypingTarget(e.target)) {
        hsnBuffer.current = '';
        return;
      }

      // A scanner never holds a modifier. Ignoring these keeps application
      // shortcuts (Ctrl/Cmd+Shift+F for full screen, and anything added later)
      // from being read as part of a scanned code.
      if (e.ctrlKey || e.metaKey || e.altKey) {
        hsnBuffer.current = '';
        return;
      }

      const currentTime = Date.now();
      if (currentTime - lastKeyTime.current > SCANNER_KEY_INTERVAL_MS) {
        hsnBuffer.current = '';
      }

      if (e.key === 'Enter') {
        const code = hsnBuffer.current;
        hsnBuffer.current = '';
        if (code.length >= MIN_CODE_LENGTH) {
          const item = items.find((i) => i.hsn_code === code);
          if (item) addItem(item);
        }
      } else if (e.key.length === 1) {
        hsnBuffer.current += e.key;
      }

      lastKeyTime.current = currentTime;
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [items, addItem, active]);
};
