import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Search, Trash2, X } from 'lucide-react';
import { api } from '../api';
import type { PaidPurchase, PurchasePayment, SupplierPayment } from '../types';
import { formatDay, formatRupees, paymentMethodLabel, paymentMethodsLabel } from '../lib/supplierPayments';
import { cn, formatDateInIST, formatDateTimeInIST, getISTTimestampForFileName } from '../lib/utils';

const PAGE_SIZE = 50;
const EXPORT_CAP = 20000;
const EXPORT_CHUNK = 1000;

type Tab = 'purchases' | 'payments';

const csvCell = (value: string | number | null | undefined) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const downloadCsv = (name: string, header: string[], rows: Array<Array<string | number | null | undefined>>) => {
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}-${getISTTimestampForFileName()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

/** Pull every page of a list, up to the export cap. */
async function fetchAll<T>(fetchPage: (offset: number) => Promise<{ data: T[] }>) {
  let rows: T[] = [];
  for (let offset = 0; offset < EXPORT_CAP; offset += EXPORT_CHUNK) {
    const page = (await fetchPage(offset))?.data ?? [];
    rows = rows.concat(page);
    if (page.length < EXPORT_CHUNK) break;
  }
  return rows;
}

/**
 * Payments Done: purchases paid in full, and the register of every payment
 * made to suppliers. Both filter by date and download as CSV for the auditor.
 */
export const PaymentsDone = () => {
  const [tab, setTab] = useState<Tab>('purchases');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);

  const [purchases, setPurchases] = useState<PaidPurchase[]>([]);
  const [payments, setPayments] = useState<SupplierPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [totalAmount, setTotalAmount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [expanded, setExpanded] = useState<number | null>(null);
  const [history, setHistory] = useState<Record<number, PurchasePayment[]>>({});
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), 300);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => { setPage(0); }, [tab, from, to, appliedSearch]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    const range = { from: from || undefined, to: to || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    const request = tab === 'purchases'
      ? api.getPaidPurchases({ ...range, search: appliedSearch || undefined })
      : api.getSupplierPayments(range);
    request
      .then((res) => {
        if (tab === 'purchases') setPurchases(res?.data ?? []);
        else setPayments(res?.data ?? []);
        setTotal(res?.total ?? 0);
        setTotalAmount(res?.total_amount ?? 0);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [tab, from, to, appliedSearch, page, reloadKey]);

  const toggleHistory = async (id: number) => {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!history[id]) {
      try {
        const detail = await api.getPurchase(id);
        setHistory((current) => ({ ...current, [id]: detail?.payments ?? [] }));
      } catch (err: any) {
        setError(err.message);
      }
    }
  };

  const removePayment = async (id: number) => {
    setRemoving(true);
    try {
      await api.deleteSupplierPayment(id);
      setConfirmRemove(null);
      setHistory({});
      setReloadKey((key) => key + 1);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRemoving(false);
    }
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const range = { from: from || undefined, to: to || undefined, limit: EXPORT_CHUNK };
      if (tab === 'purchases') {
        const rows = await fetchAll<PaidPurchase>((offset) =>
          api.getPaidPurchases({ ...range, search: appliedSearch || undefined, offset }));
        downloadCsv('payments-done', [
          'Purchase No.', 'Supplier', 'Invoice No.', 'Invoice Date', 'Entered On', 'Total', 'Paid', 'Fully Paid On', 'Payments', 'Methods',
        ], rows.map((p) => [
          p.purchase_number, p.supplier_name, p.invoice_number, p.invoice_date, formatDateInIST(p.created_at),
          p.total_amount.toFixed(2), p.amount_paid.toFixed(2), p.paid_off_on, p.payment_count, paymentMethodsLabel(p.methods),
        ]));
      } else {
        const rows = await fetchAll<SupplierPayment>((offset) => api.getSupplierPayments({ ...range, offset }));
        downloadCsv('supplier-payments', [
          'Paid On', 'Supplier', 'Amount', 'Method', 'Reference', 'Purchases Settled', 'Note', 'Entered By', 'Entered At',
        ], rows.map((p) => [
          p.paid_on, p.supplier_name, p.amount.toFixed(2), paymentMethodLabel(p.method), p.reference,
          p.allocations.map((a) => `${a.purchase_number} (${a.amount.toFixed(2)})`).join('; '),
          p.note, p.user_name, formatDateTimeInIST(p.created_at),
        ]));
      }
    } catch (err: any) {
      setError(`Export failed: ${err.message}`);
    } finally {
      setExporting(false);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = Boolean(from || to || appliedSearch);

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-teal-50">
          <h1 className="text-2xl font-bold text-gray-900">Payments Done</h1>
          <p className="text-sm text-gray-600 mt-1">
            Purchases paid in full, and every payment made to suppliers — when, how much, how, and which invoices it settled.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-6 2xl:px-8 pt-5">
          {([['purchases', 'Paid Purchases'], ['payments', 'Payment Register']] as const).map(([value, label]) => (
            <button
              key={value}
              onClick={() => setTab(value)}
              className={cn(
                'px-4 py-2 rounded-2xl text-sm font-bold transition-all',
                tab === value ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid gap-4 p-6 2xl:px-8 md:grid-cols-[1fr_auto_auto_auto] md:items-end">
          {tab === 'purchases' ? (
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Search</span>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Supplier, purchase or invoice no."
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                />
              </div>
            </label>
          ) : <div />}
          <label className="space-y-2">
            <span className="text-sm font-semibold text-gray-700">{tab === 'purchases' ? 'Fully paid from' : 'Paid from'}</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none" />
          </label>
          <label className="space-y-2">
            <span className="text-sm font-semibold text-gray-700">To</span>
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)}
              className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none" />
          </label>
          <div className="flex gap-2">
            {hasFilter && (
              <button
                onClick={() => { setFrom(''); setTo(''); setSearch(''); }}
                className="inline-flex items-center gap-1 px-4 py-3 rounded-2xl bg-gray-100 text-gray-700 font-semibold hover:bg-gray-200"
              >
                <X size={16} /> Clear
              </button>
            )}
            <button
              onClick={handleExport}
              disabled={exporting || total === 0}
              className="inline-flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none"
            >
              <Download size={18} />
              {exporting ? 'Exporting…' : 'Export CSV'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 px-6 py-4 border-b border-gray-100">
          <p className="text-sm text-gray-500">
            {total.toLocaleString('en-IN')} {tab === 'purchases' ? 'paid purchase' : 'payment'}{total === 1 ? '' : 's'}
            {hasFilter ? ' matching the filter' : ''}
          </p>
          <p className="text-sm font-bold text-gray-900 tabular-nums">
            {tab === 'purchases' ? 'Purchases worth ' : 'Paid out '}{formatRupees(totalAmount)}
          </p>
        </div>

        <div className="overflow-x-auto">
          {tab === 'purchases' ? (
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 w-8" />
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Purchase No.</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Supplier</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Invoice</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Total</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Fully Paid On</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Method</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={7} className="px-6 py-12 text-center text-gray-400">Loading…</td></tr>
                ) : purchases.length === 0 ? (
                  <tr><td colSpan={7} className="px-6 py-12 text-center text-gray-400">No fully paid purchases{hasFilter ? ' match this filter' : ' yet'}.</td></tr>
                ) : purchases.map((purchase) => (
                  <React.Fragment key={purchase.id}>
                    <tr className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => toggleHistory(purchase.id)}>
                      <td className="px-6 py-3 text-gray-400">
                        {expanded === purchase.id ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </td>
                      <td className="px-6 py-3">
                        <p className="font-mono font-bold text-gray-900">{purchase.purchase_number}</p>
                        <p className="text-xs text-gray-400">Entered {formatDateInIST(purchase.created_at)}</p>
                      </td>
                      <td className="px-6 py-3 font-semibold text-gray-900">{purchase.supplier_name}</td>
                      <td className="px-6 py-3 text-sm text-gray-600">
                        <p>{purchase.invoice_number || 'No invoice no.'}</p>
                        <p className="text-xs text-gray-400">{formatDay(purchase.invoice_date)}</p>
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums font-bold text-gray-900">{formatRupees(purchase.total_amount)}</td>
                      <td className="px-6 py-3 text-sm text-gray-700">
                        <p>{formatDay(purchase.paid_off_on)}</p>
                        <p className="text-xs text-gray-400">
                          {purchase.payment_count} payment{purchase.payment_count === 1 ? '' : 's'}
                        </p>
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-600">{paymentMethodsLabel(purchase.methods)}</td>
                    </tr>
                    {expanded === purchase.id && (
                      <tr className="bg-gray-50/60">
                        <td />
                        <td colSpan={6} className="px-6 py-4">
                          {!history[purchase.id] ? (
                            <p className="text-sm text-gray-400">Loading payments…</p>
                          ) : (
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-xs uppercase text-gray-400">
                                  <th className="py-1 text-left font-bold">Paid On</th>
                                  <th className="py-1 text-right font-bold">Towards this purchase</th>
                                  <th className="py-1 pl-6 text-left font-bold">Method</th>
                                  <th className="py-1 text-left font-bold">Reference / Note</th>
                                  <th className="py-1 text-left font-bold">Entered By</th>
                                </tr>
                              </thead>
                              <tbody>
                                {history[purchase.id].map((payment) => (
                                  <tr key={payment.payment_id} className="border-t border-gray-100">
                                    <td className="py-2">{formatDay(payment.paid_on)}</td>
                                    <td className="py-2 text-right tabular-nums font-semibold">
                                      {formatRupees(payment.amount)}
                                      {payment.payment_amount > payment.amount && (
                                        <span className="block text-xs font-normal text-gray-400">
                                          of a {formatRupees(payment.payment_amount)} payment
                                        </span>
                                      )}
                                    </td>
                                    <td className="py-2 pl-6">{paymentMethodLabel(payment.method)}</td>
                                    <td className="py-2 text-gray-600">{[payment.reference, payment.note].filter(Boolean).join(' · ') || '—'}</td>
                                    <td className="py-2 text-gray-600">{payment.user_name}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Paid On</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Supplier</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Amount</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Method</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Purchases Settled</th>
                  <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Entered By</th>
                  <th className="px-6 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={7} className="px-6 py-12 text-center text-gray-400">Loading…</td></tr>
                ) : payments.length === 0 ? (
                  <tr><td colSpan={7} className="px-6 py-12 text-center text-gray-400">No payments{hasFilter ? ' in this period' : ' recorded yet'}.</td></tr>
                ) : payments.map((payment) => (
                  <tr key={payment.id} className="align-top hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-3 text-sm text-gray-700 whitespace-nowrap">{formatDay(payment.paid_on)}</td>
                    <td className="px-6 py-3">
                      <p className="font-semibold text-gray-900">{payment.supplier_name}</p>
                      {payment.note && <p className="text-xs text-gray-400">{payment.note}</p>}
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums font-bold text-gray-900">{formatRupees(payment.amount)}</td>
                    <td className="px-6 py-3 text-sm text-gray-600">
                      <p>{paymentMethodLabel(payment.method)}</p>
                      {payment.reference && <p className="text-xs text-gray-400">Ref {payment.reference}</p>}
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-600">
                      {payment.allocations.map((allocation) => (
                        <p key={allocation.purchase_id}>
                          <span className="font-mono">{allocation.purchase_number}</span>
                          <span className="text-gray-400"> · {formatRupees(allocation.amount)}</span>
                        </p>
                      ))}
                    </td>
                    <td className="px-6 py-3 text-sm text-gray-600">
                      <p>{payment.user_name}</p>
                      <p className="text-xs text-gray-400">{formatDateTimeInIST(payment.created_at)}</p>
                    </td>
                    <td className="px-6 py-3 text-right whitespace-nowrap">
                      {confirmRemove === payment.id ? (
                        <span className="inline-flex items-center gap-2">
                          <button
                            onClick={() => removePayment(payment.id)}
                            disabled={removing}
                            className="px-3 py-2 text-xs font-bold text-white bg-red-600 rounded-xl hover:bg-red-700 disabled:opacity-50"
                          >
                            {removing ? 'Removing…' : 'Remove payment'}
                          </button>
                          <button
                            onClick={() => setConfirmRemove(null)}
                            className="px-3 py-2 text-xs font-bold text-gray-600 border border-gray-200 rounded-xl hover:bg-gray-50"
                          >
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button
                          onClick={() => setConfirmRemove(payment.id)}
                          title="Entered by mistake? Remove it — the purchases it paid will be owed again."
                          className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-sm text-gray-500">
            {total === 0 ? '' : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">Page {page + 1} of {pageCount}</span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
