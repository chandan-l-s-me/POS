import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowDownUp,
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronRight,
  MapPin,
  Phone,
  User,
  Wallet,
} from 'lucide-react';
import { api } from '../api';
import { Bill, Customer, PassbookEntry, PassbookSummary } from '../types';
import { cn, formatDateTimeInIST, getISTDateKey } from '../lib/utils';
import { customerContactName, customerDisplayName } from '../lib/customer';

/**
 * A customer's passbook: every transaction with them, in one place.
 *
 * Every bill — cash, UPI, credit or split — plus every repayment and balance
 * correction, each showing what was billed, what was received, and the
 * balance due afterwards. The figures come from GET /api/customers/:id/passbook;
 * see the comment there for how a bill and its credit entry are kept from
 * being counted twice.
 */

const PAGE_SIZE = 100;

type Preset = '30d' | '90d' | 'year' | 'all' | 'custom';

const PRESETS: Array<{ id: Preset; label: string }> = [
  { id: '30d', label: 'Last 30 days' },
  { id: '90d', label: 'Last 3 months' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
];

/** Move a YYYY-MM-DD key by whole days, without any timezone drift. */
const shiftDateKey = (key: string, days: number) => {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** Date range for a preset, as IST calendar days — the shop's days. */
const rangeFor = (preset: Exclude<Preset, 'custom'>) => {
  const today = getISTDateKey(new Date());
  switch (preset) {
    case '30d': return { from: shiftDateKey(today, -29), to: today };
    case '90d': return { from: shiftDateKey(today, -89), to: today };
    case 'year': return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case 'all': return { from: '', to: '' };
  }
};

const money = (value: number | null | undefined) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** How a bill was settled, in words. */
const billSettlement = (entry: PassbookEntry) => {
  switch (entry.payment_method) {
    case 'cash': return 'Paid in cash';
    case 'upi': return 'Paid by UPI';
    case 'credit': return 'On credit';
    case 'split': {
      const parts = [
        entry.cash_amount ? `Cash ${money(entry.cash_amount)}` : null,
        entry.upi_amount ? `UPI ${money(entry.upi_amount)}` : null,
        entry.credit_amount ? `Credit ${money(entry.credit_amount)}` : null,
      ].filter(Boolean);
      return `Split — ${parts.join(' · ')}`;
    }
    default: return '';
  }
};

const KIND_LABEL: Record<PassbookEntry['kind'], string> = {
  bill: 'Bill',
  payment: 'Payment received',
  adjustment: 'Balance adjustment',
  opening: 'Opening balance',
};

const KIND_BADGE: Record<PassbookEntry['kind'], string> = {
  bill: 'bg-orange-100 text-orange-600',
  payment: 'bg-green-100 text-green-600',
  adjustment: 'bg-gray-100 text-gray-600',
  opening: 'bg-gray-100 text-gray-600',
};

type ExpandedBill = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; bill: Bill };

export const CustomerPassbook = () => {
  const { id } = useParams();
  const customerId = Number(id);

  const [customer, setCustomer] = useState<(Customer & { credit_balance: number }) | null>(null);
  const [entries, setEntries] = useState<PassbookEntry[]>([]);
  const [summary, setSummary] = useState<PassbookSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notFound, setNotFound] = useState(false);

  const [preset, setPreset] = useState<Preset>('90d');
  const [from, setFrom] = useState(() => rangeFor('90d').from);
  const [to, setTo] = useState(() => rangeFor('90d').to);
  const [order, setOrder] = useState<'desc' | 'asc'>('desc');
  const [page, setPage] = useState(0);

  const [expanded, setExpanded] = useState<Record<number, ExpandedBill>>({});

  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentNote, setPaymentNote] = useState('');
  const [recordingPayment, setRecordingPayment] = useState(false);
  const [paymentMessage, setPaymentMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!Number.isInteger(customerId) || customerId <= 0) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = await api.getCustomerPassbook(customerId, {
        from: from || undefined,
        to: to || undefined,
        order,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setCustomer(res.customer);
      setEntries(res.data ?? []);
      setSummary(res.summary);
      setTotal(res.total ?? 0);
      setError('');
      setNotFound(false);
    } catch (err: any) {
      if (/not found/i.test(err?.message || '')) setNotFound(true);
      else setError(err?.message || 'Could not load the passbook.');
    } finally {
      setLoading(false);
    }
  }, [customerId, from, to, order, page]);

  useEffect(() => { void load(); }, [load]);

  const choosePreset = (next: Preset) => {
    setPreset(next);
    setPage(0);
    if (next !== 'custom') {
      const range = rangeFor(next);
      setFrom(range.from);
      setTo(range.to);
    }
  };

  const toggleBill = async (billId: number) => {
    if (expanded[billId]) {
      setExpanded((current) => {
        const next = { ...current };
        delete next[billId];
        return next;
      });
      return;
    }
    setExpanded((current) => ({ ...current, [billId]: { status: 'loading' } }));
    try {
      const bill = await api.getBill(billId);
      setExpanded((current) => ({ ...current, [billId]: { status: 'ready', bill } }));
    } catch (err: any) {
      setExpanded((current) => ({
        ...current,
        [billId]: { status: 'error', message: err?.message || 'Could not load this bill.' },
      }));
    }
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(paymentAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setPaymentMessage({ kind: 'error', text: 'Enter the amount received.' });
      return;
    }
    setRecordingPayment(true);
    try {
      const result = await api.recordCreditPayment(customerId, { amount, note: paymentNote.trim() || undefined });
      setPaymentAmount('');
      setPaymentNote('');
      setPaymentMessage({
        kind: 'ok',
        text: `Recorded ${money(result.amount)}. Balance due is now ${money(result.balance_after)}.`,
      });
      // Jump to where the new line is visible: the newest page.
      setPage(0);
      await load();
    } catch (err: any) {
      setPaymentMessage({ kind: 'error', text: err?.message || 'Could not record the payment.' });
    } finally {
      setRecordingPayment(false);
    }
  };

  if (notFound) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24 text-gray-400">
        <User size={40} />
        <p className="font-medium">This customer does not exist.</p>
        <Link to="/customers" className="font-bold text-orange-600 hover:underline">Back to customers</Link>
      </div>
    );
  }

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const balanceDue = customer?.credit_balance ?? 0;
  const contact = customerContactName(customer);
  // The balance brought forward only means something when the period starts
  // part-way through the customer's history. It belongs at the chronological
  // start of the period: top of the first page oldest-first, bottom of the
  // last page newest-first.
  const showBroughtForward = Boolean(from) && summary !== null &&
    (order === 'asc' ? page === 0 : page >= pageCount - 1);
  const broughtForwardRow = showBroughtForward ? (
    <tr className="bg-gray-50">
      <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{from}</td>
      <td className="px-4 py-3 text-sm font-semibold text-gray-700" colSpan={3}>
        Balance brought forward
      </td>
      <td className="px-4 py-3 text-right text-sm font-bold text-gray-900 whitespace-nowrap">
        {money(summary!.opening_balance)}
      </td>
    </tr>
  ) : null;

  return (
    <div className="space-y-6">
      <Link to="/customers" className="inline-flex items-center gap-2 text-sm font-semibold text-gray-500 hover:text-gray-900">
        <ArrowLeft size={16} />
        All customers
      </Link>

      {/* Who, and what they owe now. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-gray-400">
            <BookOpen size={14} />
            Passbook
          </p>
          <h1 className="mt-2 text-3xl font-bold text-gray-900">
            {customer ? customerDisplayName(customer) : ' '}
          </h1>
          {contact && (
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-orange-600">
              <User size={14} />
              {contact}
            </p>
          )}
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-sm text-gray-500">
            {customer?.phone && (
              <span className="flex items-center gap-2"><Phone size={14} />{customer.phone}</span>
            )}
            {customer?.gstin && (
              <span className="flex items-center gap-2">
                <span className="font-bold text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">GST</span>
                {customer.gstin}
              </span>
            )}
            {customer?.address && (
              <span className="flex items-center gap-2"><MapPin size={14} />{customer.address}</span>
            )}
          </div>
        </div>

        <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-gray-400">
            <Wallet size={14} />
            Balance due today
          </p>
          <p className={cn('mt-2 text-3xl font-black', balanceDue > 0 ? 'text-red-500' : 'text-green-500')}>
            {money(balanceDue)}
          </p>

          {balanceDue > 0 ? (
            <form onSubmit={handleRecordPayment} className="mt-4 space-y-3">
              <div className="flex gap-2">
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  max={balanceDue}
                  value={paymentAmount}
                  onChange={(e) => { setPaymentAmount(e.target.value); setPaymentMessage(null); }}
                  placeholder={`Amount received (max ${balanceDue.toFixed(2)})`}
                  className="min-w-0 flex-1 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                />
                <button
                  type="submit"
                  disabled={recordingPayment}
                  className="shrink-0 rounded-2xl bg-orange-600 px-5 py-3 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700 disabled:opacity-50 disabled:pointer-events-none"
                >
                  {recordingPayment ? 'Saving…' : 'Record Payment'}
                </button>
              </div>
              <input
                type="text"
                value={paymentNote}
                onChange={(e) => setPaymentNote(e.target.value)}
                placeholder="Note (optional), e.g. cash received at counter"
                className="w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-orange-500"
              />
            </form>
          ) : (
            <p className="mt-2 text-sm text-gray-500">Nothing outstanding.</p>
          )}
          {paymentMessage && (
            <p className={cn('mt-3 text-sm font-medium', paymentMessage.kind === 'ok' ? 'text-green-600' : 'text-red-600')}>
              {paymentMessage.text}
            </p>
          )}
        </div>
      </div>

      {/* Period. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((option) => (
            <button
              key={option.id}
              onClick={() => choosePreset(option.id)}
              className={cn(
                'rounded-2xl border px-4 py-2 text-sm font-bold transition-all',
                preset === option.id
                  ? 'border-orange-300 bg-orange-50 text-orange-700'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {preset === 'custom' && (
            <>
              <label className="space-y-1">
                <span className="block text-xs font-semibold text-gray-500">From</span>
                <input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => { setFrom(e.target.value); setPage(0); }}
                  className="rounded-2xl border border-gray-200 bg-white px-4 py-2 outline-none focus:ring-2 focus:ring-orange-500"
                />
              </label>
              <label className="space-y-1">
                <span className="block text-xs font-semibold text-gray-500">To</span>
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => { setTo(e.target.value); setPage(0); }}
                  className="rounded-2xl border border-gray-200 bg-white px-4 py-2 outline-none focus:ring-2 focus:ring-orange-500"
                />
              </label>
            </>
          )}
          <button
            onClick={() => { setOrder((current) => (current === 'desc' ? 'asc' : 'desc')); setPage(0); }}
            className="flex items-center gap-2 rounded-2xl border border-gray-200 bg-white px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50"
            title="Change the order of the entries"
          >
            <ArrowDownUp size={16} />
            {order === 'desc' ? 'Newest first' : 'Oldest first'}
          </button>
        </div>
      </div>

      {/* The period at a glance. Opening + billed − received = closing. */}
      {summary && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            { label: from ? 'Opening balance' : 'Opening balance (start)', value: summary.opening_balance, tone: 'text-gray-900' },
            { label: `Billed · ${summary.bill_count} bill${summary.bill_count === 1 ? '' : 's'}`, value: summary.total_billed, tone: 'text-gray-900' },
            { label: 'Received', value: summary.total_received, tone: 'text-green-600' },
            { label: to ? 'Closing balance' : 'Closing balance (today)', value: summary.closing_balance, tone: summary.closing_balance > 0 ? 'text-red-500' : 'text-green-600' },
          ].map((card) => (
            <div key={card.label} className="bg-white p-5 rounded-3xl shadow-sm border border-gray-100">
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">{card.label}</p>
              <p className={cn('mt-2 text-xl font-black', card.tone)}>{money(card.value)}</p>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-100 bg-red-50 px-6 py-4">
          <p className="font-medium text-red-600">{error}</p>
          <button onClick={() => void load()} className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100">
            Retry
          </button>
        </div>
      )}

      {/* The entries. */}
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-4 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Date</th>
              <th className="px-4 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Particulars</th>
              <th className="px-4 py-4 text-right text-xs font-bold text-gray-400 uppercase tracking-wider">Billed</th>
              <th className="px-4 py-4 text-right text-xs font-bold text-gray-400 uppercase tracking-wider">Received</th>
              <th className="px-4 py-4 text-right text-xs font-bold text-gray-400 uppercase tracking-wider">Balance due</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {order === 'asc' && broughtForwardRow}

            {loading ? (
              <tr><td colSpan={5} className="px-4 py-12 text-center text-gray-400">Loading passbook…</td></tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center text-gray-400">
                  No transactions {from || to ? 'in this period' : 'yet'}.
                </td>
              </tr>
            ) : (
              entries.map((entry) => {
                const isBill = entry.kind === 'bill';
                const detail = isBill ? expanded[entry.ref_id] : undefined;
                return (
                  <React.Fragment key={`${entry.kind}-${entry.ref_id}`}>
                    <tr
                      className={cn('align-top', isBill && 'cursor-pointer hover:bg-gray-50 transition-colors')}
                      onClick={isBill ? () => void toggleBill(entry.ref_id) : undefined}
                    >
                      <td className="px-4 py-4 text-sm text-gray-500 whitespace-nowrap">
                        {formatDateTimeInIST(entry.created_at)}
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          {isBill && (detail ? <ChevronDown size={16} className="text-gray-400" /> : <ChevronRight size={16} className="text-gray-400" />)}
                          <span className={cn('text-[10px] font-black uppercase px-2 py-1 rounded-full', KIND_BADGE[entry.kind])}>
                            {KIND_LABEL[entry.kind]}
                          </span>
                          {entry.bill_number && (
                            <span className="font-mono text-sm font-bold text-gray-900">{entry.bill_number}</span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-gray-500">
                          {isBill
                            ? [
                                billSettlement(entry),
                                entry.item_count ? `${entry.item_count} item${entry.item_count === 1 ? '' : 's'}` : null,
                                `by ${entry.user_name}`,
                              ].filter(Boolean).join(' · ')
                            : [entry.note, `by ${entry.user_name}`].filter(Boolean).join(' · ')}
                        </p>
                      </td>
                      <td className="px-4 py-4 text-right font-semibold text-gray-900 whitespace-nowrap">
                        {entry.amount_billed ? money(entry.amount_billed) : '—'}
                      </td>
                      <td className="px-4 py-4 text-right font-semibold text-green-600 whitespace-nowrap">
                        {entry.amount_received ? money(entry.amount_received) : '—'}
                      </td>
                      <td className={cn(
                        'px-4 py-4 text-right font-bold whitespace-nowrap',
                        entry.balance > 0 ? 'text-gray-900' : 'text-green-600'
                      )}>
                        {money(entry.balance)}
                      </td>
                    </tr>

                    {isBill && detail && (
                      <tr className="bg-gray-50">
                        <td />
                        <td colSpan={4} className="px-4 pb-5 pt-1">
                          {detail.status === 'loading' && <p className="text-sm text-gray-400">Loading bill…</p>}
                          {detail.status === 'error' && <p className="text-sm text-red-600">{detail.message}</p>}
                          {detail.status === 'ready' && (
                            <div className="rounded-2xl border border-gray-100 bg-white p-4">
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-xs uppercase tracking-wider text-gray-400">
                                    <th className="pb-2 text-left font-bold">Item</th>
                                    <th className="pb-2 text-left font-bold">HSN</th>
                                    <th className="pb-2 text-right font-bold">Qty</th>
                                    <th className="pb-2 text-right font-bold">Amount</th>
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-gray-50">
                                  {(detail.bill.items || []).map((line) => (
                                    <tr key={line.id}>
                                      <td className="py-2 font-semibold text-gray-900">{line.item_name}</td>
                                      <td className="py-2 text-gray-500">{line.hsn_code || '-'}</td>
                                      <td className="py-2 text-right text-gray-700">{line.quantity} {line.metric}</td>
                                      <td className="py-2 text-right font-semibold text-gray-900">{money(line.total_amount)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                              <div className="mt-3 flex flex-wrap justify-end gap-x-6 gap-y-1 border-t border-gray-100 pt-3 text-xs text-gray-500">
                                <span>Subtotal {money(detail.bill.subtotal_amount)}</span>
                                <span>GST {money(detail.bill.tax_amount)}</span>
                                {detail.bill.discount_amount > 0 && <span>Discount −{money(detail.bill.discount_amount)}</span>}
                                <span>
                                  Round off {money(round2(
                                    detail.bill.total_amount -
                                    (detail.bill.subtotal_amount + detail.bill.tax_amount - detail.bill.discount_amount)
                                  ))}
                                </span>
                                <span className="font-bold text-gray-900">Total {money(detail.bill.total_amount)}</span>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}

            {order === 'desc' && broughtForwardRow}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-sm text-gray-500">
            {total === 0
              ? 'No entries'
              : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')} entries`}
            <span className="ml-2 text-gray-400">· Click a bill to see its items</span>
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              Page {page + 1} of {pageCount.toLocaleString('en-IN')}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
