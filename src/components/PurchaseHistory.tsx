import { useEffect, useState } from 'react';
import { ChevronRight, Search, X } from 'lucide-react';
import { api } from '../api';
import { DateFilterButton, DateFilterPanel } from './DateFilter';
import type { Purchase } from '../types';
import { cn, formatDateTimeInIST } from '../lib/utils';
import { formatDay, formatRupees, paymentMethodLabel } from '../lib/supplierPayments';

const PAGE_SIZE = 50;

/**
 * Every purchase entered, newest first: History → Purchases. Search, date range
 * and paging run on the server, as they do for sales.
 */
export const PurchaseHistory = () => {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Purchase | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => { setPage(0); }, [startDate, endDate]);

  useEffect(() => {
    setLoading(true);
    api.getPurchasesPage({
      from: startDate || undefined,
      to: endDate || undefined,
      search: appliedSearch || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((res) => {
        setPurchases(res?.data ?? []);
        setTotal(res?.total ?? 0);
        setError('');
      })
      .catch((err: any) => setError(err?.message || 'Could not load purchases.'))
      .finally(() => setLoading(false));
  }, [startDate, endDate, appliedSearch, page]);

  const open = async (id: number) => {
    try {
      setSelected(await api.getPurchase(id));
    } catch (err: any) {
      alert(err.message);
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by purchase no., supplier, invoice or item..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <DateFilterButton from={startDate} to={endDate} open={showDateFilter} onClick={() => setShowDateFilter((current) => !current)} />
      </div>

      {showDateFilter && (
        <DateFilterPanel from={startDate} to={endDate} onFromChange={setStartDate} onToChange={setEndDate} />
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Purchases table">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-100">
                {['Purchase No.', 'Date & Time', 'Supplier', 'Invoice', 'Entered By', 'Amount', 'Payment', ''].map((heading, index) => (
                  <th key={index} className={cn('px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider', index >= 5 && 'text-right')}>
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-gray-400">Loading purchases...</td></tr>
              ) : error ? (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-red-600">{error}</td></tr>
              ) : purchases.length === 0 ? (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-gray-400">No purchases found</td></tr>
              ) : (
                purchases.map((purchase) => (
                  <tr key={purchase.id} onClick={() => open(purchase.id)} className="cursor-pointer hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-mono font-bold text-gray-900 whitespace-nowrap">{purchase.purchase_number}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 whitespace-nowrap">{formatDateTimeInIST(purchase.created_at)}</td>
                    <td className="px-6 py-4">
                      <p className="font-bold text-gray-900">{purchase.supplier_name}</p>
                      {purchase.supplier_gstin && <p className="text-xs text-gray-500">{purchase.supplier_gstin}</p>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {purchase.invoice_number || '—'}
                      {purchase.invoice_date && <p className="text-xs text-gray-400">{formatDay(purchase.invoice_date)}</p>}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500">{purchase.user_name}</td>
                    <td className="px-6 py-4 text-right font-black text-gray-900 whitespace-nowrap">{formatRupees(purchase.total_amount)}</td>
                    <td className="px-6 py-4 text-right">
                      {(purchase.balance_due ?? 0) > 0 ? (
                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-amber-50 text-amber-700 whitespace-nowrap">
                          Due {formatRupees(purchase.balance_due ?? 0)}
                        </span>
                      ) : (
                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">Paid</span>
                      )}
                    </td>
                    <td className="px-4 py-4 text-right text-gray-400"><ChevronRight size={20} className="inline" /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-sm text-gray-500">
            {total === 0
              ? 'No purchases match this filter'
              : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">Page {page + 1} of {pageCount.toLocaleString('en-IN')}</span>
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

      {selected && <PurchaseDetail purchase={selected} onClose={() => setSelected(null)} />}
    </div>
  );
};

const PurchaseDetail = ({ purchase, onClose }: { purchase: Purchase; onClose: () => void }) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const due = purchase.balance_due ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm sm:p-6" onClick={onClose}>
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 sm:px-8 sm:py-6">
          <div className="min-w-0">
            <p className="font-mono text-sm font-bold text-gray-500">{purchase.purchase_number}</p>
            <h3 className="mt-0.5 truncate text-xl font-bold text-gray-900 sm:text-2xl">{purchase.supplier_name}</h3>
            <p className="mt-1 text-sm text-gray-500">
              {formatDateTimeInIST(purchase.created_at)} · entered by {purchase.user_name}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-2 hover:bg-gray-100">
            <X size={24} />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto px-5 py-5 sm:px-8 sm:py-6">
          <div className="grid gap-3 text-sm sm:grid-cols-3">
            <div className="rounded-2xl bg-gray-50 p-4">
              <p className="text-xs font-bold uppercase text-gray-400">Supplier invoice</p>
              <p className="mt-1 font-semibold text-gray-900">{purchase.invoice_number || '—'}</p>
              {purchase.invoice_date && <p className="text-gray-500">{formatDay(purchase.invoice_date)}</p>}
            </div>
            <div className="rounded-2xl bg-gray-50 p-4">
              <p className="text-xs font-bold uppercase text-gray-400">Supplier</p>
              <p className="mt-1 text-gray-700">{purchase.supplier_gstin || 'No GSTIN'}</p>
              {purchase.supplier_phone && <p className="text-gray-500">{purchase.supplier_phone}</p>}
            </div>
            <div className={cn('rounded-2xl p-4', due > 0 ? 'bg-amber-50' : 'bg-emerald-50')}>
              <p className="text-xs font-bold uppercase text-gray-400">Payment</p>
              <p className={cn('mt-1 font-bold', due > 0 ? 'text-amber-700' : 'text-emerald-700')}>
                {due > 0 ? `${formatRupees(due)} still due` : 'Paid in full'}
              </p>
              <p className="text-gray-500">Paid {formatRupees(purchase.amount_paid ?? 0)}</p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-gray-100">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50 text-xs font-bold uppercase text-gray-400">
                <tr>
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3 text-right">Qty</th>
                  <th className="px-4 py-3 text-right">Cost / unit</th>
                  <th className="px-4 py-3 text-right">GST</th>
                  <th className="px-4 py-3 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(purchase.items || []).map((line) => {
                  const rate = line.igst_rate > 0 ? `IGST ${line.igst_rate}%` : line.sgst_rate + line.cgst_rate > 0 ? `${line.sgst_rate + line.cgst_rate}%` : '—';
                  return (
                    <tr key={line.id}>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">{line.item_name}</p>
                        {line.hsn_code && <p className="text-xs text-gray-400">HSN {line.hsn_code}</p>}
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">{line.quantity} {line.metric}</td>
                      <td className="px-4 py-3 text-right tabular-nums">{formatRupees(line.unit_cost)}</td>
                      <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                        {formatRupees(line.sgst_amount + line.cgst_amount + line.igst_amount)}
                        <p className="text-xs text-gray-400">{rate}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-bold tabular-nums">{formatRupees(line.total_amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="border-t border-gray-200 bg-gray-50 text-sm">
                <tr><td colSpan={4} className="px-4 py-2 text-right text-gray-500">Taxable value</td><td className="px-4 py-2 text-right tabular-nums">{formatRupees(purchase.subtotal_amount)}</td></tr>
                <tr><td colSpan={4} className="px-4 py-2 text-right text-gray-500">GST</td><td className="px-4 py-2 text-right tabular-nums">{formatRupees(purchase.tax_amount)}</td></tr>
                <tr><td colSpan={4} className="px-4 py-2 text-right font-bold text-gray-900">Total</td><td className="px-4 py-2 text-right font-black tabular-nums text-gray-900">{formatRupees(purchase.total_amount)}</td></tr>
              </tfoot>
            </table>
          </div>

          {(purchase.payments || []).length > 0 && (
            <div>
              <p className="mb-2 text-sm font-bold text-gray-900">Payments</p>
              <ul className="divide-y divide-gray-100 rounded-2xl border border-gray-100 text-sm">
                {(purchase.payments || []).map((payment) => (
                  <li key={payment.payment_id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <span className="text-gray-700">
                      {formatDay(payment.paid_on)} · {paymentMethodLabel(payment.method)}
                      {payment.reference && <span className="text-gray-400"> · {payment.reference}</span>}
                    </span>
                    <span className="font-bold tabular-nums">{formatRupees(payment.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {purchase.notes && <p className="rounded-2xl bg-gray-50 p-4 text-sm text-gray-600">{purchase.notes}</p>}
        </div>
      </div>
    </div>
  );
};
