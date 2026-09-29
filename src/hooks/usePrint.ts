import { useCallback, useRef } from 'react';
import { useReactToPrint, type UseReactToPrintOptions } from 'react-to-print';
import { watchFullscreenDuringPrint, type FullscreenDocument } from '../lib/fullscreen';

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

  const finish = () => {
    finishWatch.current?.();
    finishWatch.current = null;
  };

  const print = useReactToPrint({
    ...options,
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
