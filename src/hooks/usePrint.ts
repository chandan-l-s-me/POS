import { useCallback, useMemo, useRef } from 'react';
import { useReactToPrint, type UseReactToPrintOptions } from 'react-to-print';
import { watchFullscreenDuringPrint, type FullscreenDocument } from '../lib/fullscreen';

/**
 * Every CSS rule this page has loaded, as text. Empty if none could be read,
 * in which case printing falls back to letting the frame load the stylesheets.
 */
const collectPageStyles = () => {
  let css = '';
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) css += `${rule.cssText}\n`;
    } catch {
      // A stylesheet from another origin cannot be read; the app has none.
    }
  }
  return css;
};

/**
 * `useReactToPrint`, keeping the till in full screen.
 *
 * Printing opens the browser's print dialog, and Chrome leaves full screen to
 * show it — so every bill printed used to drop the till out of full screen and
 * leave it there. This watches for that exit while the print is in flight and
 * puts full screen back afterwards: straight away if the browser still counts
 * the click that started the print, otherwise on the cashier's next tap or key
 * press. If the browser keeps full screen through printing, it does nothing.
 *
 * Use this instead of `useReactToPrint` anywhere the app prints.
 */
export const usePrint = (options: UseReactToPrintOptions) => {
  const finishWatch = useRef<(() => void) | null>(null);
  const pageStyles = useMemo(collectPageStyles, []);

  const finish = () => {
    finishWatch.current?.();
    finishWatch.current = null;
  };

  const print = useReactToPrint({
    ...options,
    // Hand the print frame the styles this page has already loaded, rather
    // than letting it download the stylesheet again. A tab left open across an
    // update asks for a stylesheet that the update deleted, and printed bills
    // with no layout at all.
    ...(pageStyles ? { ignoreGlobalStyles: true, pageStyle: `${pageStyles}\n${options.pageStyle ?? ''}` } : {}),
    // react-to-print calls this once the iframe's print() has returned — in
    // Chrome, after the dialog has closed.
    onAfterPrint: () => {
      finish();
      options.onAfterPrint?.();
    },
    onPrintError: (errorLocation, error) => {
      finish();
      options.onPrintError?.(errorLocation, error);
    },
  });

  return useCallback(() => {
    // A previous print that never reported back.
    finish();
    finishWatch.current = watchFullscreenDuringPrint(document as FullscreenDocument);
    print();
    // `finish` only touches the ref, so it is safe to leave out of the deps.
  }, [print]);
};
