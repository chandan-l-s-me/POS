import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bluetooth, Check, ChevronDown, Delete, LogOut, MessageCircle, Minus, Plus, Printer, RotateCcw, Search, Settings2, Trash2, X,
} from 'lucide-react';
import { api, type ApiError } from '../api';
import type { CartItem, Customer, Item } from '../types';
import { useAuthStore } from '../store/useAuthStore';
import { useCartStore } from '../store/useCartStore';
import { useDataStore } from '../store/useDataStore';
import { useNoticeStore } from '../store/useNoticeStore';
import { addItemToCart, refreshCartBatches } from '../lib/cartActions';
import { customerContactName, customerDisplayName } from '../lib/customer';
import { receiptBytes } from '../lib/escpos';
import { billShareText, whatsappLink, whatsappNumber } from '../lib/billShare';
import { makeBillPdf } from '../lib/billPdf';
import { hasNativePdfShare, sharePdfNative } from '../lib/nativeShare';
import { Capacitor } from '@capacitor/core';
import {
  hasBluetoothPrinting, listPairedPrinters, loadPrinterSettings, printToBluetooth, savePrinterSettings,
  type PrinterSettings,
} from '../lib/nativePrinter';
import { isLooseUnit } from '../lib/units';
import { useBackButton } from '../lib/backButton';
import { round2 } from '../lib/billMath';
import { cn, formatDateInIST } from '../lib/utils';

/**
 * Quick Bill: billing on a phone, for cashiers walking the shop floor.
 *
 * The same cart, prices and save as the counter's Billing screen (the shared
 * cart store and src/lib/cartActions), laid out for one hand: the customer's
 * usual items and last order to start from, big +/- buttons, a number pad,
 * and the total and payment always at the bottom. Printing goes to the
 * counter's printer (through the print queue) or, in the Android app, to a
 * Bluetooth printer the cashier carries.
 */

const rupees = (value: number) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (value: number) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

type Sheet = null | 'customer' | 'search' | 'settings' | { keypad: number };
type QuickItem = Item & { times_bought?: number; ordered_quantity?: number };
type PrintState = { kind: 'idle' } | { kind: 'working'; text: string } | { kind: 'done'; text: string } | { kind: 'error'; text: string };

const vibrate = () => {
  try { navigator.vibrate?.(15); } catch { /* not supported */ }
};

export const QuickBill = () => {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const { items: catalogue, itemsComplete, settings, refreshItems } = useDataStore();
  const notice = useNoticeStore();

  const { carts, activeCartId, setCustomer, setPaymentMethod, setPaymentAmount, updateQuantity, removeItem, clearCart } = useCartStore();
  const cart = useMemo(() => carts.find((entry) => entry.id === activeCartId) || carts[0], [carts, activeCartId]);
  const customer = cart.customer;
  const lines = cart.items;
  const total = cart.totals.total;

  const [sheet, setSheet] = useState<Sheet>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [usual, setUsual] = useState<QuickItem[]>([]);
  const [popular, setPopular] = useState<QuickItem[]>([]);
  const [lastOrder, setLastOrder] = useState<{ bill: { bill_number: string; created_at: string } | null; items: QuickItem[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{
    billId: number; billNumber: string; total: number; customer: string; paid: string;
    customerId: number | null; phone: string | null;
  } | null>(null);
  const [sharing, setSharing] = useState(false);

  // Part payment: some paid now in cash and/or UPI, the rest on the bakery's
  // credit. The cart's 'split' payment, which the server checks adds up to the
  // bill total exactly.
  const isPart = cart.paymentMethod === 'split';
  const [partCash, setPartCash] = useState('');
  const [partUpi, setPartUpi] = useState('');
  const paidNow = round2((Number(partCash) || 0) + (Number(partUpi) || 0));
  const onCredit = round2(total - paidNow);
  const [printState, setPrintState] = useState<PrintState>({ kind: 'idle' });
  const [printer, setPrinter] = useState<PrinterSettings>(loadPrinterSettings);
  const canBluetooth = hasBluetoothPrinting();
  const printMode = printer.mode === 'bluetooth' && !canBluetooth ? 'counter' : printer.mode;

  useEffect(() => {
    api.getCustomers({ limit: 1000 }).then(setCustomers).catch(() => notice.show('Could not load customers.', 'error'));
  }, []);

  // Suggestions follow the customer: their usual items and last order.
  useEffect(() => {
    api.getQuickItems(customer?.id).then((res) => {
      setUsual(res?.usual ?? []);
      setPopular(res?.popular ?? []);
    }).catch(() => undefined);
    setLastOrder(null);
    if (customer) api.getLastOrder(customer.id).then(setLastOrder).catch(() => undefined);
  }, [customer?.id]);

  // A notice disappears on its own after a few seconds.
  useEffect(() => {
    if (!notice.message) return;
    const handle = setTimeout(notice.clear, 3500);
    return () => clearTimeout(handle);
  }, [notice.message, notice.id]);

  const add = async (item: Item, quantity = 1) => {
    if (await addItemToCart(item, quantity)) vibrate();
  };

  const changeBy = (lineId: number, current: number, step: number) => {
    const next = Math.round((current + step) * 1000) / 1000;
    if (next <= 0) removeItem(lineId);
    else updateQuantity(lineId, next);
    vibrate();
  };

  const repeatLastOrder = async () => {
    if (!lastOrder?.items.length) return;
    let short = 0;
    for (const item of lastOrder.items) {
      const inBill = lines.find((line) => line.id === item.id)?.quantity ?? 0;
      const wanted = Math.max(0, (item.ordered_quantity ?? 1) - inBill);
      const quantity = Math.min(wanted, Math.max(0, item.stock_quantity - inBill));
      if (quantity < wanted) short += 1;
      if (quantity > 0) await addItemToCart(item, quantity);
    }
    vibrate();
    notice.show(short ? `Last order added; ${short} item${short === 1 ? ' is' : 's are'} short of stock.` : 'Last order added — check the quantities.', short ? 'warning' : 'info');
  };

  // --- Printing ---------------------------------------------------------------

  const watchCounterPrint = useCallback((jobId: number) => {
    setPrintState({ kind: 'working', text: 'Sent to the counter printer…' });
    let tries = 0;
    const poll = async () => {
      tries += 1;
      try {
        const job = await api.getPrintJob(jobId);
        if (job?.status === 'printed') {
          setPrintState({ kind: 'done', text: 'Printed at the counter' });
          return;
        }
      } catch { /* keep trying */ }
      if (tries < 20) setTimeout(poll, 3000);
      else setPrintState({ kind: 'error', text: 'Not printed yet — is the counter computer on, with “Print bills from phones” turned on?' });
    };
    setTimeout(poll, 2000);
  }, []);

  const printBluetooth = useCallback(async (billId: number) => {
    if (!printer.address) {
      setPrintState({ kind: 'error', text: 'Choose your Bluetooth printer in ⚙ first.' });
      return;
    }
    setPrintState({ kind: 'working', text: `Printing on ${printer.name || 'Bluetooth printer'}…` });
    try {
      const bill = await api.getBill(billId);
      await printToBluetooth(printer.address, receiptBytes(bill, settings, printer.paper));
      setPrintState({ kind: 'done', text: `Printed on ${printer.name || 'Bluetooth printer'}` });
    } catch (err: any) {
      setPrintState({ kind: 'error', text: `Could not print: ${err?.message || 'printer not reachable'}. Is it on and nearby?` });
    }
  }, [printer, settings]);

  const printAgain = async () => {
    if (!done) return;
    if (printMode === 'bluetooth') return printBluetooth(done.billId);
    try {
      const job = await api.requestCounterPrint(done.billId);
      watchCounterPrint(job.id);
    } catch (err: any) {
      setPrintState({ kind: 'error', text: err?.message || 'Could not send to the counter.' });
    }
  };

  // Keep the part payment adding up as items change: cash and UPI as typed,
  // credit whatever is left.
  useEffect(() => {
    if (!isPart) return;
    const cash = round2(Number(partCash) || 0);
    const upi = round2(Number(partUpi) || 0);
    const credit = Math.max(0, round2(total - cash - upi));
    const amounts = cart.paymentAmounts;
    if (amounts.cash !== cash) setPaymentAmount('cash', cash);
    if (amounts.upi !== upi) setPaymentAmount('upi', upi);
    if (amounts.credit !== credit) setPaymentAmount('credit', credit);
  }, [isPart, partCash, partUpi, total, cart.paymentAmounts]);

  const choosePart = () => {
    setPartCash('');
    setPartUpi('');
    setPaymentAmount('cash', 0);
    setPaymentAmount('upi', 0);
    setPaymentAmount('credit', total);
  };

  // --- Share on WhatsApp --------------------------------------------------------

  /**
   * Open WhatsApp with the bill typed into the customer's chat. The bill is
   * read back from the server, so the message shows exactly what was saved.
   * Nothing is sent until the cashier presses send in WhatsApp.
   */
  /**
   * Send the bill's PDF — the same receipt the printer prints — on WhatsApp.
   * In the Android app WhatsApp opens in the customer's chat with the PDF
   * attached; in Chrome on a phone, Android's share sheet opens with it; on a
   * computer the PDF downloads. The cashier presses send.
   */
  const sharePdfOnWhatsApp = async () => {
    if (!done || sharing) return;
    setSharing(true);
    try {
      const pdf = await makeBillPdf(done.billId, done.billNumber, settings.bill_format === 'standard' ? 'standard' : 'thermal');
      const caption = `${settings.shop_name} — Bill ${done.billNumber}, total ${rupees(done.total)}`;
      if (hasNativePdfShare()) {
        await sharePdfNative({ data: pdf.base64, fileName: pdf.fileName, phone: whatsappNumber(done.phone), caption });
        return;
      }
      const file = new File([pdf.blob], pdf.fileName, { type: 'application/pdf' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text: caption }).catch((err) => {
          if (err?.name !== 'AbortError') throw err; // closing the share sheet is not an error
        });
        return;
      }
      // A computer: save the PDF so it can be attached in WhatsApp.
      const url = URL.createObjectURL(pdf.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = pdf.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      notice.show('Bill PDF downloaded — attach it in WhatsApp.', 'info');
    } catch (err: any) {
      notice.show(err?.message || 'Could not make the bill PDF.', 'error');
    } finally {
      setSharing(false);
    }
  };

  /** The bill as a WhatsApp text message instead of a PDF. */
  const shareOnWhatsApp = async () => {
    if (!done || sharing) return;
    setSharing(true);
    try {
      const bill = await api.getBill(done.billId);
      const balance = done.customerId ? customers.find((c) => c.id === done.customerId)?.credit_balance ?? null : null;
      const link = whatsappLink(billShareText(bill, settings, balance), done.phone);
      // In the Android app, leaving the page for another site hands the link
      // to Android, which opens WhatsApp; in a browser, use a new tab so the
      // bill screen stays put.
      if (Capacitor.isNativePlatform()) window.location.href = link;
      else window.open(link, '_blank', 'noopener');
    } catch (err: any) {
      notice.show(err?.message || 'Could not prepare the bill for WhatsApp.', 'error');
    } finally {
      setSharing(false);
    }
  };

  // --- Save -------------------------------------------------------------------

  const save = async () => {
    if (!lines.length || saving) return;
    if (cart.paymentMethod === 'credit' && !customer) {
      notice.show('Credit is only for a registered customer. Choose the bakery first.', 'warning');
      return;
    }
    if (isPart) {
      if (paidNow <= 0) {
        notice.show('Enter how much is paid now in cash or UPI.', 'warning');
        return;
      }
      if (onCredit < 0) {
        notice.show(`Paid now (${rupees(paidNow)}) is more than the bill (${rupees(total)}).`, 'warning');
        return;
      }
      if (onCredit > 0 && !customer) {
        notice.show('The balance goes on credit, which needs a registered customer. Choose the bakery first.', 'warning');
        return;
      }
    }
    const paidSummary = (() => {
      const { cash, upi, credit } = cart.paymentAmounts;
      if (!isPart) return cart.paymentMethod === 'credit' ? 'On credit' : `Paid by ${cart.paymentMethod === 'upi' ? 'UPI' : 'cash'}`;
      return [cash > 0 && `Cash ${rupees(cash)}`, upi > 0 && `UPI ${rupees(upi)}`, credit > 0 && `${rupees(credit)} on credit`]
        .filter(Boolean).join(' · ');
    })();
    setSaving(true);
    try {
      const result = await api.createBill({
        customer_id: customer?.id || null,
        items: lines.map((line) => ({ id: line.id, quantity: line.quantity })),
        expected_total: total,
        payment_method: cart.paymentMethod,
        cash_amount: cart.paymentAmounts.cash,
        upi_amount: cart.paymentAmounts.upi,
        credit_amount: cart.paymentAmounts.credit,
        print_at_counter: printMode === 'counter',
      });
      setDone({
        billId: result.bill_id,
        billNumber: result.bill_number,
        total: result.total_amount,
        customer: customer ? customerDisplayName(customer) : 'Walk-in customer',
        paid: paidSummary,
        customerId: customer?.id ?? null,
        phone: customer?.phone ?? null,
      });
      clearCart();
      setPartCash('');
      setPartUpi('');
      setPrintState({ kind: 'idle' });
      if (printMode === 'counter' && result.print_job_id) watchCounterPrint(result.print_job_id);
      if (printMode === 'bluetooth') void printBluetooth(result.bill_id);
      void refreshItems();
      // Balances moved; the picker's figures should too.
      api.getCustomers({ limit: 1000 }).then(setCustomers).catch(() => undefined);
    } catch (err: unknown) {
      const error = err as ApiError;
      if (error.code === 'PRICE_CHANGED') {
        await refreshCartBatches().catch(() => undefined);
        notice.show(error.message, 'warning');
      } else {
        notice.show(error.message || 'Could not save the bill.', 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const newBill = () => { setDone(null); setPrintState({ kind: 'idle' }); };
  // Back on the "Bill saved" screen starts the next bill, as New bill does.
  useBackButton(done !== null, newBill);

  const saveLabel = saving
    ? 'Saving…'
    : printMode === 'counter' ? 'Save & print at counter' : printMode === 'bluetooth' ? 'Save & print' : 'Save bill';

  // --- Suggestions ------------------------------------------------------------

  const inBill = new Set(lines.map((line) => line.id));
  const suggestions = [...usual, ...popular.filter((item) => !usual.some((u) => u.id === item.id))].slice(0, 12);

  return (
    <div className="qb fixed inset-0 flex flex-col bg-gray-50 text-gray-900 select-none">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 bg-white px-4 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))] border-b border-gray-100">
        <div className="min-w-0">
          <p className="text-lg font-black leading-tight">Quick Bill</p>
          <p className="text-xs text-gray-500 truncate">{user?.name}</p>
        </div>
        <div className="flex items-center gap-1">
          {lines.length > 0 && (
            <button onClick={() => { clearCart(); vibrate(); }} className="flex h-11 items-center gap-1 rounded-xl px-3 text-sm font-bold text-gray-500 active:bg-gray-100">
              <Trash2 size={18} /> Clear
            </button>
          )}
          <button onClick={() => setSheet('settings')} aria-label="Settings" className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-600 active:bg-gray-100">
            <Settings2 size={22} />
          </button>
        </div>
      </header>

      {/* Customer */}
      <div className="bg-white px-4 py-3 border-b border-gray-100">
        <button onClick={() => setSheet('customer')} className="flex w-full items-center justify-between gap-3 rounded-2xl border border-gray-200 px-4 py-3 text-left active:bg-gray-50">
          <span className="min-w-0">
            <span className="block truncate font-bold">{customer ? customerDisplayName(customer) : 'Walk-in customer'}</span>
            <span className="block truncate text-xs text-gray-500">
              {customer
                ? [customerContactName(customer), customer.credit_balance > 0 ? `owes ${rupees(customer.credit_balance)}` : null].filter(Boolean).join(' · ') || customer.phone
                : 'Tap to choose a bakery'}
            </span>
          </span>
          <ChevronDown size={20} className="shrink-0 text-gray-400" />
        </button>
        {customer && lastOrder?.bill && lastOrder.items.length > 0 && (
          <button onClick={repeatLastOrder} className="mt-2 flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-50 px-4 py-3 text-sm font-bold text-orange-700 active:bg-orange-100">
            <RotateCcw size={16} />
            Repeat last order · {formatDateInIST(lastOrder.bill.created_at, { year: undefined })} · {lastOrder.items.length} item{lastOrder.items.length === 1 ? '' : 's'}
          </button>
        )}
      </div>

      {/* Bill */}
      <main className="flex-1 overflow-y-auto overscroll-contain">
        <div className="px-4 pt-3">
          <button onClick={() => setSheet('search')} className="flex w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3.5 text-left text-gray-400 active:bg-gray-50">
            <Search size={20} /> Search items…
          </button>
        </div>

        {suggestions.length > 0 && (
          <div className="px-4 pt-3">
            <p className="mb-2 text-xs font-bold uppercase text-gray-400">{usual.length && customer ? `Usual for ${customerDisplayName(customer)}` : 'Best sellers'}</p>
            {/* One row, swiped sideways, so the bill below stays in view. */}
            <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
              {suggestions.map((item) => {
                const out = item.stock_quantity <= 0;
                return (
                  <button
                    key={item.id}
                    disabled={out}
                    onClick={() => add(item)}
                    className={cn(
                      'max-w-[14rem] shrink-0 rounded-full border px-3 py-2 text-sm font-semibold active:scale-95 transition',
                      out ? 'border-gray-100 text-gray-300 line-through' : inBill.has(item.id) ? 'border-orange-300 bg-orange-50 text-orange-800' : 'border-gray-200 bg-white text-gray-800'
                    )}
                  >
                    <span className="block truncate">{item.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <ul className="mt-3 space-y-2 px-4 pb-4">
          {lines.length === 0 && (
            <li className="rounded-2xl border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400">
              No items yet. Tap an item above or search.
            </li>
          )}
          {lines.map((line) => {
            const step = isLooseUnit(line.metric) ? 0.5 : 1;
            const short = line.quantity > line.available;
            return (
              <li key={line.id} className={cn('rounded-2xl border bg-white p-3', short ? 'border-red-200' : 'border-gray-100')}>
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 font-bold leading-snug">{line.name}</p>
                  <p className="shrink-0 font-black tabular-nums">{rupees(line.total_amount)}</p>
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <p className="text-xs text-gray-500">
                    {line.segments.map((segment) => `${qty(segment.quantity)} × ${rupees(segment.unit_price)}`).join(' + ')} / {line.metric}
                    {short && <span className="block font-bold text-red-600">Only {qty(line.available)} in stock</span>}
                  </p>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <button onClick={() => changeBy(line.id, line.quantity, -step)} aria-label="Less" className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-100 active:bg-gray-200">
                      <Minus size={14} />
                    </button>
                    <button onClick={() => setSheet({ keypad: line.id })} className="h-8 min-w-[2.25rem] rounded-lg border border-gray-200 px-1.5 text-sm font-black tabular-nums active:bg-gray-50">
                      {qty(line.quantity)}
                    </button>
                    <button onClick={() => changeBy(line.id, line.quantity, step)} aria-label="More" className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-white active:bg-gray-700">
                      <Plus size={14} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </main>

      {/* Total, payment, save */}
      <footer className="border-t border-gray-100 bg-white px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_rgba(0,0,0,0.05)]">
        <div className="flex items-end justify-between">
          <p className="text-sm text-gray-500">
            {lines.length} item{lines.length === 1 ? '' : 's'}
            {cart.totals.tax > 0 && <span className="block text-xs">incl. GST {rupees(cart.totals.tax)}</span>}
          </p>
          <p className="text-3xl font-black tabular-nums">{rupees(total)}</p>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {(['cash', 'upi', 'credit', 'split'] as const).map((method) => (
            <button
              key={method}
              disabled={method === 'credit' && !customer}
              onClick={() => (method === 'split' ? (isPart || choosePart()) : setPaymentMethod(method))}
              className={cn(
                'h-11 rounded-xl text-sm font-bold uppercase transition',
                cart.paymentMethod === method ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700',
                method === 'credit' && !customer && 'opacity-40'
              )}
            >
              {method === 'split' ? 'Part' : method}
            </button>
          ))}
        </div>
        {isPart && (
          <div className="mt-2 rounded-2xl bg-gray-50 p-2">
            <div className="grid grid-cols-2 gap-2">
              {([['Cash now', partCash, setPartCash], ['UPI now', partUpi, setPartUpi]] as const).map(([label, value, setValue]) => (
                <label key={label} className="block">
                  <span className="block px-1 text-[11px] font-bold uppercase text-gray-500">{label}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={value}
                    placeholder="0"
                    onChange={(event) => setValue(event.target.value)}
                    className="h-11 w-full rounded-xl border border-gray-200 bg-white px-3 text-lg font-bold tabular-nums outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </label>
              ))}
            </div>
            <p className={cn(
              'px-1 pt-2 text-sm font-semibold',
              onCredit < 0 || (onCredit > 0 && !customer) ? 'text-red-600' : 'text-gray-700'
            )}>
              {onCredit < 0
                ? `${rupees(-onCredit)} more than the bill`
                : onCredit === 0
                  ? 'Paid in full'
                  : customer
                    ? `${rupees(onCredit)} on ${customerDisplayName(customer)}’s credit`
                    : `${rupees(onCredit)} left — choose the bakery to put it on credit`}
            </p>
          </div>
        )}
        <button
          onClick={save}
          disabled={!lines.length || saving}
          className="mt-2 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-orange-600 text-lg font-black text-white shadow-lg shadow-orange-200 active:bg-orange-700 disabled:opacity-40 disabled:shadow-none"
        >
          {printMode === 'bluetooth' ? <Bluetooth size={20} /> : <Printer size={20} />}
          {saveLabel}
        </button>
      </footer>

      {/* Notice */}
      {notice.message && (
        <div className="pointer-events-none fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-50">
          <p className={cn(
            'rounded-2xl px-4 py-3 text-sm font-semibold shadow-lg',
            notice.tone === 'error' ? 'bg-red-600 text-white' : notice.tone === 'warning' ? 'bg-amber-500 text-white' : 'bg-gray-900 text-white'
          )}>
            {notice.message}
          </p>
        </div>
      )}

      {/* Sheets */}
      {sheet === 'customer' && (
        <CustomerSheet
          customers={customers}
          selectedId={customer?.id ?? null}
          onPick={(picked) => { setCustomer(picked); setSheet(null); vibrate(); }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === 'search' && (
        <SearchSheet
          catalogue={catalogue}
          complete={itemsComplete}
          lines={lines}
          onAdd={add}
          onStep={changeBy}
          onSet={(lineId, value) => { if (value <= 0) removeItem(lineId); else updateQuantity(lineId, value); vibrate(); }}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet && typeof sheet === 'object' && 'keypad' in sheet && (() => {
        const line = lines.find((entry) => entry.id === sheet.keypad);
        if (!line) return null;
        return (
          <KeypadSheet
            title={line.name}
            unit={line.metric}
            initial={line.quantity}
            allowDecimal={isLooseUnit(line.metric)}
            max={line.available}
            onDone={(value) => { if (value <= 0) removeItem(line.id); else updateQuantity(line.id, value); setSheet(null); vibrate(); }}
            onClose={() => setSheet(null)}
          />
        );
      })()}
      {sheet === 'settings' && (
        <SettingsSheet
          printer={printer}
          canBluetooth={canBluetooth}
          onChange={(next) => { setPrinter(next); savePrinterSettings(next); }}
          onLogout={() => { logout(); navigate('/login'); }}
          onClose={() => setSheet(null)}
        />
      )}

      {done && (
        <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-white px-6 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <Check size={44} strokeWidth={3} />
          </div>
          <p className="mt-5 text-sm font-bold uppercase text-gray-400">Bill saved</p>
          <p className="mt-1 text-4xl font-black tabular-nums">{rupees(done.total)}</p>
          <p className="mt-2 font-mono font-bold text-gray-700">{done.billNumber}</p>
          <p className="text-gray-500">{done.customer}</p>
          <p className="mt-1 text-sm font-semibold text-gray-700">{done.paid}</p>
          {printState.kind !== 'idle' && (
            <p className={cn(
              'mt-6 rounded-2xl px-4 py-3 text-sm font-semibold',
              printState.kind === 'done' ? 'bg-emerald-50 text-emerald-700' : printState.kind === 'error' ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-700'
            )}>
              {printState.kind === 'done' && '✓ '}{printState.text}
            </p>
          )}
          <div className="mt-8 w-full max-w-sm space-y-2">
            <button onClick={newBill} className="h-14 w-full rounded-2xl bg-orange-600 text-lg font-black text-white active:bg-orange-700">
              New bill
            </button>
            <button
              onClick={sharePdfOnWhatsApp}
              disabled={sharing}
              className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-[#25D366] font-bold text-white active:bg-[#1ebe5b] disabled:opacity-60"
            >
              <MessageCircle size={20} />
              {sharing ? 'Preparing bill PDF…' : 'Send bill PDF on WhatsApp'}
            </button>
            <button
              onClick={shareOnWhatsApp}
              disabled={sharing}
              className="w-full py-1 text-sm font-semibold text-gray-500 underline-offset-2 active:underline disabled:opacity-50"
            >
              or send as a text message
            </button>
            {printMode !== 'none' && (
              <button onClick={printAgain} disabled={printState.kind === 'working'} className="h-12 w-full rounded-2xl border border-gray-200 font-bold text-gray-700 active:bg-gray-50 disabled:opacity-50">
                Print again
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// --- Sheets -------------------------------------------------------------------

const SheetFrame = ({ title, onClose, children, tall }: { title: string; onClose: () => void; children: React.ReactNode; tall?: boolean }) => {
  useBackButton(true, onClose);
  return (
    <div className="fixed inset-0 z-30 flex flex-col justify-end bg-black/30" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className={cn('flex flex-col rounded-t-3xl bg-white pb-[max(1rem,env(safe-area-inset-bottom))]', tall ? 'h-[92vh]' : 'max-h-[92vh]')}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
          <p className="text-lg font-black">{title}</p>
          <button onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-xl active:bg-gray-100">
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

const SearchBox = ({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) => (
  <div className="relative px-4 pt-3">
    <Search size={20} className="absolute left-8 top-1/2 mt-1.5 -translate-y-1/2 text-gray-400" />
    <input
      autoFocus
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="h-12 w-full rounded-2xl border border-gray-200 bg-gray-50 pl-11 pr-4 text-base outline-none focus:ring-2 focus:ring-orange-500"
    />
  </div>
);

const CustomerSheet = ({ customers, selectedId, onPick, onClose }: {
  customers: Customer[];
  selectedId: number | null;
  onPick: (customer: Customer | null) => void;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState('');
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? customers.filter((c) => [c.shop_name, c.name, c.phone].some((v) => (v || '').toLowerCase().includes(q)))
      : customers;
    return list.slice(0, 60);
  }, [customers, query]);

  return (
    <SheetFrame title="Customer" onClose={onClose} tall>
      <SearchBox value={query} onChange={setQuery} placeholder="Bakery, name or phone" />
      <ul className="mt-2 flex-1 overflow-y-auto px-2">
        <li>
          <button onClick={() => onPick(null)} className={cn('w-full rounded-xl px-3 py-3 text-left active:bg-gray-100', selectedId === null && 'bg-orange-50')}>
            <span className="font-bold">Walk-in customer</span>
            <span className="block text-xs text-gray-500">Cash or UPI only</span>
          </button>
        </li>
        {matches.map((c) => (
          <li key={c.id}>
            <button onClick={() => onPick(c)} className={cn('w-full rounded-xl px-3 py-3 text-left active:bg-gray-100', selectedId === c.id && 'bg-orange-50')}>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-bold">{customerDisplayName(c)}</span>
                {c.credit_balance > 0 && <span className="shrink-0 text-xs font-bold text-red-600">owes {rupees(c.credit_balance)}</span>}
              </span>
              <span className="block truncate text-xs text-gray-500">{[customerContactName(c), c.phone].filter(Boolean).join(' · ')}</span>
            </button>
          </li>
        ))}
      </ul>
    </SheetFrame>
  );
};

const SearchSheet = ({ catalogue, complete, lines, onAdd, onStep, onSet, onClose }: {
  catalogue: Item[];
  complete: boolean;
  /** The bill's lines, so each item shows the quantity already in it. */
  lines: CartItem[];
  onAdd: (item: Item, quantity?: number) => Promise<void>;
  onStep: (lineId: number, current: number, step: number) => void;
  onSet: (lineId: number, quantity: number) => void;
  onClose: () => void;
}) => {
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<Item[] | null>(null);
  // The number pad, for an item in the list: typing a quantity adds it, or
  // changes it if it is already in the bill.
  const [keypadFor, setKeypadFor] = useState<Item | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // The phone holds the first 1000 items; a bigger shop is searched on the server.
  useEffect(() => {
    if (complete || query.trim().length < 2) { setRemote(null); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api.getItems({ search: query.trim(), limit: 40 }).then(setRemote).catch(() => setRemote(null));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query, complete]);

  const matches = useMemo(() => {
    if (remote) return remote;
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return catalogue.slice(0, 40);
    return catalogue
      .filter((item) => words.every((word) => `${item.name} ${item.hsn_code || ''}`.toLowerCase().includes(word)))
      .slice(0, 40);
  }, [catalogue, query, remote]);

  const lineFor = (itemId: number) => lines.find((line) => line.id === itemId);
  const keypadLine = keypadFor ? lineFor(keypadFor.id) : undefined;

  return (
    <SheetFrame title="Add items" onClose={onClose} tall>
      <SearchBox value={query} onChange={setQuery} placeholder="Type part of the item name" />
      <p className="px-4 pt-2 text-xs text-gray-400">Tap + to add one, or tap an item to type the quantity.</p>
      <ul className="mt-1 flex-1 overflow-y-auto px-2">
        {matches.length === 0 && <li className="py-10 text-center text-sm text-gray-400">No item matches “{query}”.</li>}
        {matches.map((item) => {
          const out = item.stock_quantity <= 0;
          const line = lineFor(item.id);
          const step = isLooseUnit(item.metric) ? 0.5 : 1;
          return (
            <li key={item.id} className={cn('flex items-center gap-2 rounded-xl px-1', line && 'bg-orange-50/60')}>
              <button
                disabled={out}
                onClick={() => setKeypadFor(item)}
                className="min-w-0 flex-1 rounded-xl px-2 py-3 text-left active:bg-gray-100 disabled:opacity-40"
              >
                <span className="block truncate font-bold">{item.name}</span>
                <span className="block text-xs text-gray-500">
                  {rupees(item.price)} / {item.metric} · {out ? 'out of stock' : `${qty(item.stock_quantity)} in stock`}
                </span>
              </button>
              {line ? (
                <div className="flex shrink-0 items-center gap-0.5">
                  <button onClick={() => onStep(line.id, line.quantity, -step)} aria-label={`Less ${item.name}`} className="flex h-8 w-8 items-center justify-center rounded-lg bg-white border border-gray-200 active:bg-gray-100">
                    <Minus size={14} />
                  </button>
                  <button onClick={() => setKeypadFor(item)} className="h-8 min-w-[2.25rem] rounded-lg border border-orange-300 bg-white px-1.5 text-sm font-black tabular-nums text-orange-800 active:bg-orange-50">
                    {qty(line.quantity)}
                  </button>
                  <button onClick={() => onStep(line.id, line.quantity, step)} aria-label={`More ${item.name}`} className="flex h-8 w-8 items-center justify-center rounded-lg bg-gray-900 text-white active:bg-gray-700">
                    <Plus size={14} />
                  </button>
                </div>
              ) : (
                <button
                  disabled={out}
                  onClick={() => onAdd(item, 1)}
                  aria-label={`Add ${item.name}`}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gray-900 text-white active:bg-gray-700 disabled:opacity-30"
                >
                  <Plus size={14} />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="px-4 pt-2">
        <button onClick={onClose} className="h-12 w-full rounded-2xl bg-orange-600 font-black text-white active:bg-orange-700">
          Done{lines.length ? ` · ${lines.length} item${lines.length === 1 ? '' : 's'} in bill` : ''}
        </button>
      </div>

      {keypadFor && (
        <KeypadSheet
          title={keypadFor.name}
          unit={keypadFor.metric}
          initial={keypadLine?.quantity ?? 1}
          allowDecimal={isLooseUnit(keypadFor.metric)}
          max={keypadLine?.available ?? keypadFor.stock_quantity}
          verb={keypadLine ? 'Set' : 'Add'}
          onDone={async (value) => {
            const item = keypadFor;
            setKeypadFor(null);
            if (keypadLine) onSet(keypadLine.id, value);
            else if (value > 0) await onAdd(item, value);
          }}
          onClose={() => setKeypadFor(null)}
        />
      )}
    </SheetFrame>
  );
};

const KeypadSheet = ({ title, unit, initial, allowDecimal, max, onDone, onClose, verb = 'Set' }: {
  title: string;
  /** "Add" for an item not yet in the bill, "Set" to change one that is. */
  verb?: 'Add' | 'Set';
  unit: string;
  initial: number;
  allowDecimal: boolean;
  max: number;
  onDone: (value: number) => void;
  onClose: () => void;
}) => {
  // Starts empty, so typing replaces the quantity instead of appending to it.
  const [entry, setEntry] = useState('');
  const value = entry === '' ? initial : Number(entry);
  const tooMany = value > max;

  const press = (key: string) => {
    vibrate();
    setEntry((current) => {
      if (key === 'del') return current.slice(0, -1);
      if (key === '.') return !allowDecimal || current.includes('.') ? current : (current || '0') + '.';
      const next = current + key;
      const [, decimals] = next.split('.');
      if (decimals && decimals.length > 3) return current;
      return next.length > 7 ? current : next;
    });
  };

  return (
    <SheetFrame title={title} onClose={onClose}>
      <div className="px-4 pt-4 text-center">
        <p className={cn('text-5xl font-black tabular-nums', entry === '' && 'text-gray-300', tooMany && 'text-red-600')}>
          {entry === '' ? qty(initial) : entry} <span className="text-lg font-bold text-gray-400">{unit}</span>
        </p>
        <p className={cn('mt-1 text-sm', tooMany ? 'font-bold text-red-600' : 'text-gray-400')}>
          {qty(max)} in stock
        </p>
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 pt-4">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : '', '0', 'del'].map((key, index) =>
          key === '' ? <span key={index} /> : (
            <button
              key={key}
              onClick={() => press(key)}
              className="flex h-14 items-center justify-center rounded-2xl bg-gray-100 text-2xl font-bold active:bg-gray-200"
              aria-label={key === 'del' ? 'Delete' : key}
            >
              {key === 'del' ? <Delete size={24} /> : key}
            </button>
          )
        )}
      </div>
      <div className="px-4 pt-3">
        <button
          onClick={() => onDone(value)}
          disabled={tooMany || Number.isNaN(value)}
          className="h-14 w-full rounded-2xl bg-orange-600 text-lg font-black text-white active:bg-orange-700 disabled:opacity-40"
        >
          {value > 0 ? `${verb} ${qty(value)} ${unit}` : verb === 'Add' ? 'Cancel' : 'Remove item'}
        </button>
      </div>
    </SheetFrame>
  );
};

const SettingsSheet = ({ printer, canBluetooth, onChange, onLogout, onClose }: {
  printer: PrinterSettings;
  canBluetooth: boolean;
  onChange: (next: PrinterSettings) => void;
  onLogout: () => void;
  onClose: () => void;
}) => {
  const [devices, setDevices] = useState<Array<{ name: string; address: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const findPrinters = async () => {
    setError(null);
    try {
      setDevices(await listPairedPrinters());
    } catch (err: any) {
      setError(err?.message || 'Could not read Bluetooth devices. Allow the Nearby devices permission and try again.');
    }
  };

  useEffect(() => {
    if (canBluetooth && printer.mode === 'bluetooth') void findPrinters();
  }, []);

  const option = (mode: PrinterSettings['mode'], label: string, hint: string, disabled = false) => (
    <button
      disabled={disabled}
      onClick={() => { onChange({ ...printer, mode }); if (mode === 'bluetooth') void findPrinters(); }}
      className={cn('w-full rounded-2xl border px-4 py-3 text-left disabled:opacity-40', printer.mode === mode ? 'border-orange-400 bg-orange-50' : 'border-gray-200')}
    >
      <span className="font-bold">{label}</span>
      <span className="block text-xs text-gray-500">{hint}</span>
    </button>
  );

  return (
    <SheetFrame title="Settings" onClose={onClose}>
      <div className="space-y-2 overflow-y-auto px-4 pt-4">
        <p className="text-xs font-bold uppercase text-gray-400">Print bills on</p>
        {option('counter', 'Counter printer', 'The counter computer prints each bill automatically')}
        {option('bluetooth', 'My Bluetooth printer', canBluetooth ? 'A thermal printer paired with this phone' : 'Available in the Android app', !canBluetooth)}
        {option('none', 'Don’t print', 'Reprint later from History if needed')}

        {printer.mode === 'bluetooth' && canBluetooth && (
          <div className="rounded-2xl bg-gray-50 p-3">
            <p className="text-xs font-bold uppercase text-gray-400">Printer</p>
            {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
            {devices && devices.length === 0 && (
              <p className="mt-1 text-sm text-gray-600">No paired devices. Pair the printer in Android’s Bluetooth settings first, then come back.</p>
            )}
            <div className="mt-2 space-y-1">
              {(devices ?? []).map((device) => (
                <button
                  key={device.address}
                  onClick={() => onChange({ ...printer, address: device.address, name: device.name })}
                  className={cn('flex w-full items-center justify-between rounded-xl px-3 py-2.5 text-left', printer.address === device.address ? 'bg-orange-100' : 'bg-white')}
                >
                  <span className="font-semibold">{device.name || device.address}</span>
                  {printer.address === device.address && <Check size={18} className="text-orange-600" />}
                </button>
              ))}
            </div>
            <button onClick={findPrinters} className="mt-2 text-sm font-bold text-orange-700">Refresh list</button>
            <p className="mt-3 text-xs font-bold uppercase text-gray-400">Paper</p>
            <div className="mt-1 grid grid-cols-2 gap-2">
              {([58, 80] as const).map((paper) => (
                <button
                  key={paper}
                  onClick={() => onChange({ ...printer, paper })}
                  className={cn('h-10 rounded-xl text-sm font-bold', printer.paper === paper ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200')}
                >
                  {paper} mm
                </button>
              ))}
            </div>
          </div>
        )}

        <button onClick={onLogout} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-gray-200 font-bold text-red-600 active:bg-red-50">
          <LogOut size={18} /> Sign out
        </button>
      </div>
    </SheetFrame>
  );
};
