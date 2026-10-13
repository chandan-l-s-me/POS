import { useCallback, useEffect, useRef, useState } from 'react';
import { Printer } from 'lucide-react';
import { api } from '../api';
import { usePrint } from '../hooks/usePrint';
import { Receipt } from './Receipt';

/**
 * The counter computer as a print station for bills saved on phones.
 *
 * Phones cannot reach the counter's receipt printer, so they queue their
 * bills (print_jobs on the server). A computer with "Print bills from phones"
 * turned on watches that queue and prints each bill with the same Receipt the
 * counter prints, whatever page it is showing. Claiming a job marks it printed
 * on the server in one step, so a bill never prints twice.
 *
 * For printing without a dialog each time, start Chrome with
 * --kiosk-printing (see the README); otherwise every bill opens the print
 * dialog.
 */
const STORAGE_KEY = 'print-station';
const CHANGE_EVENT = 'print-station-change';
const POLL_MS = 4000;

export const isPrintStation = () => {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
};

export const setPrintStation = (on: boolean) => {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* not available: stays as it was */ }
  window.dispatchEvent(new Event(CHANGE_EVENT));
};

export const PrintStation = () => {
  const [enabled, setEnabled] = useState(isPrintStation);
  const [current, setCurrent] = useState<{ jobId: number; billId: number; billNumber: string } | null>(null);
  const [printedCount, setPrintedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  useEffect(() => {
    const sync = () => setEnabled(isPrintStation());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const finish = useCallback(() => {
    setCurrent(null);
    setPrintedCount((count) => count + 1);
    busy.current = false;
  }, []);

  const print = usePrint({ contentRef: receiptRef, onAfterPrint: finish });
  // The latest print function, and which job it was last called for, so a
  // re-render can never print the same bill twice.
  const printRef = useRef(print);
  printRef.current = print;
  const printedJob = useRef<number | null>(null);

  // Take the next job when idle.
  useEffect(() => {
    if (!enabled) return;
    const tick = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const { data } = await api.getPrintJobs();
        for (const job of data ?? []) {
          try {
            await api.claimPrintJob(job.id);
          } catch {
            continue; // another print station took it
          }
          setError(null);
          setCurrent({ jobId: job.id, billId: job.bill_id, billNumber: job.bill_number });
          return; // stays busy until it has printed
        }
        busy.current = false;
      } catch {
        setError('Cannot reach the server');
        busy.current = false;
      }
    };
    void tick();
    const handle = setInterval(tick, POLL_MS);
    return () => clearInterval(handle);
  }, [enabled]);

  // Print once the receipt has its data; give the layout a moment to settle.
  const jobId = current?.jobId ?? null;
  const onReceiptReady = useCallback(() => {
    if (jobId == null || printedJob.current === jobId) return;
    printedJob.current = jobId;
    setTimeout(() => {
      try {
        printRef.current();
      } catch {
        setError('Printing failed');
        busy.current = false;
        setCurrent(null);
      }
    }, 300);
  }, [jobId]);

  if (!enabled) return null;

  return (
    <>
      <div
        className="fixed bottom-3 right-3 z-40 flex items-center gap-2 rounded-full border border-gray-200 bg-white/95 px-3 py-1.5 text-xs font-semibold text-gray-600 shadow-sm print:hidden"
        title="This computer prints bills saved on phones. Turn it off in Settings."
      >
        <Printer size={14} className={error ? 'text-red-500' : current ? 'text-orange-500' : 'text-emerald-600'} />
        {error ? error : current ? `Printing ${current.billNumber}…` : `Printing phone bills${printedCount ? ` · ${printedCount} printed` : ''}`}
      </div>
      {/* Off screen, not display:none, so it lays out exactly as when shown. */}
      {current && (
        <div aria-hidden className="fixed -left-[10000px] top-0">
          <div ref={receiptRef}>
            <Receipt billId={current.billId} onDataLoaded={onReceiptReady} />
          </div>
        </div>
      )}
    </>
  );
};
