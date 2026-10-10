import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import { BookOpen, Download, HandCoins, Phone, Search, X } from 'lucide-react';
import { api } from '../api';
import type { AgeingKey, CustomerCredit, UnpaidCredit } from '../types';
import { ageLabel, formatRupees } from '../lib/supplierPayments';
import { round2 } from '../lib/billMath';
import { cn, formatDateInIST, getISTTimestampForFileName } from '../lib/utils';

const AGEING: Array<{ key: AgeingKey; label: string; tone: string; bar: string }> = [
  { key: 'd0_30', label: '0–30 days', tone: 'text-gray-900', bar: 'bg-emerald-500' },
  { key: 'd31_60', label: '31–60 days', tone: 'text-amber-700', bar: 'bg-amber-400' },
  { key: 'd61_90', label: '61–90 days', tone: 'text-orange-700', bar: 'bg-orange-500' },
  { key: 'd90_plus', label: 'Over 90 days', tone: 'text-red-700', bar: 'bg-red-500' },
];

const FILTERS = [
  { value: 0, label: 'All customers' },
  { value: 30, label: 'Owing over 30 days' },
  { value: 60, label: 'Owing over 60 days' },
  { value: 90, label: 'Owing over 90 days' },
];

const ageClass = (days: number) =>
  days > 90 ? 'bg-red-50 text-red-700'
    : days > 60 ? 'bg-orange-50 text-orange-700'
      : days > 30 ? 'bg-amber-50 text-amber-700'
        : 'bg-gray-100 text-gray-600';

const lineLabel = (line: UnpaidCredit) =>
  line.bill_number ?? (line.kind === 'opening' ? 'Opening balance' : line.note ? 'Balance correction' : 'Credit');

const csvCell = (value: string | number | null | undefined) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Sales Credit: what customers owe the shop. Each customer's unpaid credit
 * bills, oldest first, aged; and the shop-wide ageing an auditor asks for.
 * Repayments recorded here settle the oldest bills first.
 */
export const SalesCredit = () => {
  const [customers, setCustomers] = useState<CustomerCredit[]>([]);
  const [totalDue, setTotalDue] = useState(0);
  const [ageing, setAgeing] = useState<Record<AgeingKey, number>>({ d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [minAge, setMinAge] = useState(0);
  const [paying, setPaying] = useState<CustomerCredit | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getSalesCredit()
      .then((res) => {
        setCustomers(res?.customers ?? []);
        setTotalDue(res?.total_due ?? 0);
        const buckets = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 } as Record<AgeingKey, number>;
        for (const bucket of res?.ageing ?? []) buckets[bucket.key as AgeingKey] = bucket.amount;
        setAgeing(buckets);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return customers.filter((customer) =>
      (minAge === 0 || customer.oldest_age_days > minAge) &&
      (!query ||
        customer.display_name.toLowerCase().includes(query) ||
        (customer.name || '').toLowerCase().includes(query) ||
        (customer.phone || '').includes(query) ||
        customer.unpaid.some((line) => (line.bill_number || '').toLowerCase().includes(query)))
    );
  }, [customers, search, minAge]);

  const oldestDays = customers.reduce((acc, customer) => Math.max(acc, customer.oldest_age_days), 0);
  const overSixty = round2(ageing.d61_90 + ageing.d90_plus);

  const handleExport = () => {
    const header = ['Customer', 'Contact', 'Phone', 'Bill No.', 'Date', 'Credit Given', 'Still Owed', 'Days Unpaid', 'Customer Balance'];
    const rows = customers.flatMap((customer) =>
      customer.unpaid.map((line) => [
        customer.display_name, customer.shop_name ? customer.name : '', customer.phone, lineLabel(line),
        line.created_at ? formatDateInIST(line.created_at) : '', line.credit_amount.toFixed(2), line.outstanding.toFixed(2),
        line.age_days, customer.balance.toFixed(2),
      ])
    );
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `sales-credit-${getISTTimestampForFileName()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const summary = [
    { label: 'Total owed by customers', value: formatRupees(totalDue), accent: true },
    { label: 'Customers owing', value: customers.length.toLocaleString('en-IN') },
    { label: 'Owed over 60 days', value: formatRupees(overSixty), warn: overSixty > 0 },
    { label: 'Oldest unpaid', value: customers.length ? ageLabel(oldestDays) : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-sky-50 to-indigo-50">
          <h1 className="text-2xl font-bold text-gray-900">Sales Credit</h1>
          <p className="text-sm text-gray-600 mt-1">
            What customers owe the shop, bill by bill. A repayment settles the customer’s oldest bills first, so the bills
            listed are the ones still unpaid.
          </p>
        </div>
        <div className="grid gap-4 p-6 2xl:px-8 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map((card) => (
            <div
              key={card.label}
              className={cn(
                'rounded-2xl p-4 border',
                card.accent ? 'bg-sky-50 border-sky-100' : card.warn ? 'bg-red-50 border-red-100' : 'bg-gray-50 border-gray-100'
              )}
            >
              <p className={cn('text-xs font-bold uppercase', card.accent ? 'text-sky-700' : card.warn ? 'text-red-600' : 'text-gray-500')}>
                {card.label}
              </p>
              <p className={cn('text-2xl font-black mt-1 tabular-nums', card.accent ? 'text-sky-800' : card.warn ? 'text-red-700' : 'text-gray-900')}>
                {card.value}
              </p>
            </div>
          ))}
        </div>

        {totalDue > 0 && (
          <div className="px-6 2xl:px-8 pb-6">
            <p className="text-xs font-bold uppercase text-gray-500 mb-2">Ageing</p>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-gray-100">
              {AGEING.map((bucket) => ageing[bucket.key] > 0 && (
                <div
                  key={bucket.key}
                  className={bucket.bar}
                  style={{ width: `${(ageing[bucket.key] / totalDue) * 100}%` }}
                  title={`${bucket.label}: ${formatRupees(ageing[bucket.key])}`}
                />
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {AGEING.map((bucket) => (
                <div key={bucket.key} className="flex items-center gap-2 text-sm">
                  <span className={cn('h-2.5 w-2.5 rounded-full', bucket.bar)} />
                  <span className="text-gray-500">{bucket.label}</span>
                  <span className={cn('ml-auto font-bold tabular-nums', bucket.tone)}>{formatRupees(ageing[bucket.key])}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search bakery, contact, phone or bill no."
              className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
            />
          </div>
          <select
            value={minAge}
            onChange={(e) => setMinAge(Number(e.target.value))}
            className="px-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm font-semibold text-gray-700"
          >
            {FILTERS.map((filter) => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
          </select>
        </div>
        <button
          onClick={handleExport}
          disabled={customers.length === 0}
          className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:pointer-events-none"
        >
          <Download size={20} />
          Export CSV
        </button>
      </div>

      {notice && (
        <p className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</p>
      )}
      {error && (
        <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>
      )}

      {loading ? (
        <p className="py-12 text-center text-gray-400">Loading sales credit…</p>
      ) : customers.length === 0 ? (
        <div className="bg-white rounded-3xl border border-gray-100 py-16 text-center">
          <p className="text-lg font-bold text-gray-900">No customer owes anything</p>
          <p className="text-sm text-gray-500 mt-1">Bills sold on credit will show up here until they are paid.</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-gray-400">No customer matches this search or filter.</p>
      ) : (
        filtered.map((customer) => (
          <div key={customer.id} className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 border-b border-gray-100">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 shrink-0 bg-sky-100 text-sky-700 rounded-2xl flex items-center justify-center font-bold text-lg">
                  {customer.display_name[0]?.toUpperCase()}
                </div>
                <div className="min-w-0">
                  <Link to={`/customers/${customer.id}`} className="font-bold text-lg text-gray-900 truncate hover:underline block">
                    {customer.display_name}
                  </Link>
                  <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-3">
                    {customer.shop_name && customer.name && <span>{customer.name}</span>}
                    {customer.phone && (<span className="inline-flex items-center gap-1"><Phone size={12} />{customer.phone}</span>)}
                    <span>
                      {customer.last_payment_at
                        ? `Last paid ${formatRupees(Math.abs(customer.last_payment_amount ?? 0))} on ${formatDateInIST(customer.last_payment_at)}`
                        : 'No repayment recorded'}
                    </span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="text-xs font-bold uppercase text-gray-400">Owes</p>
                  <p className="text-2xl font-black text-sky-700 tabular-nums">{formatRupees(customer.balance)}</p>
                </div>
                <Link
                  to={`/customers/${customer.id}`}
                  className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl border border-gray-200 text-gray-700 font-bold hover:bg-gray-50 transition-all"
                >
                  <BookOpen size={18} />
                  Passbook
                </Link>
                <button
                  onClick={() => { setNotice(null); setPaying(customer); }}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-orange-600 text-white font-bold shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
                >
                  <HandCoins size={18} />
                  Record Payment
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Bill</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Date</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Credit Given</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Still Owed</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Unpaid For</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {customer.unpaid.map((line, index) => (
                    <tr key={line.entry_id ?? `x${index}`} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3">
                        <p className={cn('font-bold text-gray-900', line.bill_number && 'font-mono')}>{lineLabel(line)}</p>
                        {line.bill_total != null && line.bill_total > line.credit_amount && (
                          <p className="text-xs text-gray-400">Bill {formatRupees(line.bill_total)}, rest paid at the counter</p>
                        )}
                        {!line.bill_number && line.note && <p className="text-xs text-gray-400 line-clamp-1">{line.note}</p>}
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-600">{line.created_at ? formatDateInIST(line.created_at) : '—'}</td>
                      <td className="px-6 py-3 text-right tabular-nums text-gray-500">{formatRupees(line.credit_amount)}</td>
                      <td className="px-6 py-3 text-right tabular-nums font-bold text-gray-900">
                        {formatRupees(line.outstanding)}
                        {line.outstanding < line.credit_amount && (
                          <span className="block text-xs font-normal text-gray-400">part paid</span>
                        )}
                      </td>
                      <td className="px-6 py-3">
                        <span className={cn('text-xs font-bold px-2 py-1 rounded-full', ageClass(line.age_days))}>
                          {ageLabel(line.age_days)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))
      )}

      <AnimatePresence>
        {paying && (
          <CustomerPaymentModal
            customer={paying}
            onClose={() => setPaying(null)}
            onSaved={(amount) => {
              setNotice(`Received ${formatRupees(amount)} from ${paying.display_name}.`);
              setPaying(null);
              load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
};

/** Take a repayment from a customer; shows which bills it pays off, oldest first. */
const CustomerPaymentModal = ({ customer, onClose, onSaved }: {
  customer: CustomerCredit;
  onClose: () => void;
  onSaved: (amount: number) => void;
}) => {
  const [amount, setAmount] = useState(customer.balance.toFixed(2));
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = round2(Number(amount) || 0);
  const tooMuch = value > customer.balance;

  const preview = useMemo(() => {
    let left = value;
    const rows: Array<{ line: UnpaidCredit; amount: number; cleared: boolean }> = [];
    for (const line of customer.unpaid) {
      if (left <= 0) break;
      const take = round2(Math.min(left, line.outstanding));
      rows.push({ line, amount: take, cleared: take >= line.outstanding });
      left = round2(left - take);
    }
    return rows;
  }, [customer, value]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!(value > 0)) {
      setError('Enter the amount received.');
      return;
    }
    if (tooMuch) {
      setError(`That is more than the ${formatRupees(customer.balance)} owed.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.recordCreditPayment(customer.id, { amount: value, note: note.trim() || undefined });
      onSaved(value);
    } catch (err: any) {
      setError(err.message || 'Could not record the payment');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
      <motion.form
        onSubmit={handleSubmit}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
      >
        <div className="flex items-start justify-between gap-4 px-8 pt-8 pb-4">
          <div>
            <h3 className="font-bold text-2xl text-gray-900">Record Payment</h3>
            <p className="text-sm text-gray-500 mt-1">{customer.display_name} · owes {formatRupees(customer.balance)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X size={22} />
          </button>
        </div>

        <div className="px-8 pb-6 space-y-4 overflow-y-auto">
          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">Amount received (₹)</span>
            <input
              type="number"
              step="0.01"
              min="0.01"
              autoFocus
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={cn(
                'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none font-bold tabular-nums',
                tooMuch && 'border-red-300 text-red-600'
              )}
            />
          </label>
          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">
              Note <span className="font-normal text-gray-400">(optional — e.g. cash, UPI ref, cheque no.)</span>
            </span>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
            />
          </label>

          {preview.length > 0 && !tooMuch && (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-xs font-bold uppercase text-gray-500 mb-2">Pays off, oldest bill first</p>
              <ul className="space-y-1.5 text-sm">
                {preview.map(({ line, amount: share, cleared }, index) => (
                  <li key={line.entry_id ?? `x${index}`} className="flex justify-between gap-3">
                    <span className="text-gray-700">
                      <span className={cn('font-semibold', line.bill_number && 'font-mono')}>{lineLabel(line)}</span>
                      {line.created_at && <span className="text-gray-400"> · {formatDateInIST(line.created_at)}</span>}
                    </span>
                    <span className="tabular-nums font-semibold text-gray-900 whitespace-nowrap">
                      {formatRupees(share)}{' '}
                      <span className={cleared ? 'text-emerald-600' : 'text-amber-600'}>
                        {cleared ? '· paid in full' : `· ${formatRupees(round2(line.outstanding - share))} left`}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-100 px-8 py-5">
          <button
            type="button"
            onClick={onClose}
            className="px-5 py-3 text-sm font-bold text-gray-700 bg-white border border-gray-200 rounded-2xl hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-3 text-sm font-bold text-white bg-orange-600 rounded-2xl hover:bg-orange-700 disabled:opacity-60"
          >
            <HandCoins size={16} />
            {saving ? 'Saving…' : 'Save Payment'}
          </button>
        </div>
      </motion.form>
    </div>
  );
};
