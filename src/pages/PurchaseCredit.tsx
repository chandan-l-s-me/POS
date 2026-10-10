import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Download, Phone, Search, Wallet } from 'lucide-react';
import { api } from '../api';
import type { CreditPurchase, SupplierCredit } from '../types';
import { SupplierPaymentModal } from '../components/SupplierPaymentModal';
import { ageLabel, formatDay, formatRupees } from '../lib/supplierPayments';
import { cn, formatDateInIST, getISTTimestampForFileName } from '../lib/utils';

/** Unpaid this long is worth a second look. */
const AGE_WARN_DAYS = 30;
const AGE_ALERT_DAYS = 60;

const ageClass = (days: number) =>
  days >= AGE_ALERT_DAYS ? 'bg-red-50 text-red-700' : days >= AGE_WARN_DAYS ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-600';

const csvCell = (value: string | number | null | undefined) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Purchase Credit: what the shop owes its suppliers, supplier by supplier,
 * oldest invoice first. The owner records a payment here when they pay one;
 * a purchase paid off moves to Payments Done.
 */
export const PurchaseCredit = () => {
  const [suppliers, setSuppliers] = useState<SupplierCredit[]>([]);
  const [totalDue, setTotalDue] = useState(0);
  const [purchaseCount, setPurchaseCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [paying, setPaying] = useState<{ supplier: SupplierCredit; purchase: CreditPurchase | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getPurchaseCredit()
      .then((res) => {
        setSuppliers(res?.suppliers ?? []);
        setTotalDue(res?.total_due ?? 0);
        setPurchaseCount(res?.purchase_count ?? 0);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return suppliers;
    return suppliers.filter((supplier) =>
      supplier.name.toLowerCase().includes(query) ||
      (supplier.phone || '').includes(query) ||
      supplier.purchases.some((p) =>
        p.purchase_number.toLowerCase().includes(query) || (p.invoice_number || '').toLowerCase().includes(query)
      )
    );
  }, [suppliers, search]);

  const oldestDays = suppliers.reduce((acc, supplier) => Math.max(acc, supplier.oldest_age_days), 0);

  const handleExport = () => {
    const header = ['Supplier', 'Supplier GSTIN', 'Purchase No.', 'Invoice No.', 'Invoice Date', 'Entered On', 'Total', 'Paid', 'Balance Due', 'Days Unpaid'];
    const rows = suppliers.flatMap((supplier) =>
      supplier.purchases.map((p) => [
        supplier.name, supplier.gstin || '', p.purchase_number, p.invoice_number || '', p.invoice_date || '',
        formatDateInIST(p.created_at), p.total_amount.toFixed(2), p.amount_paid.toFixed(2), p.balance_due.toFixed(2), p.age_days,
      ])
    );
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `purchase-credit-${getISTTimestampForFileName()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const summary = [
    { label: 'Total owed to suppliers', value: formatRupees(totalDue), accent: true },
    { label: 'Suppliers owed', value: suppliers.length.toLocaleString('en-IN') },
    { label: 'Unpaid purchases', value: purchaseCount.toLocaleString('en-IN') },
    { label: 'Oldest unpaid', value: purchaseCount ? ageLabel(oldestDays) : '—' },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-amber-50">
          <h1 className="text-2xl font-bold text-gray-900">Purchase Credit</h1>
          <p className="text-sm text-gray-600 mt-1">
            What the shop owes its suppliers. When the owner pays a supplier, record it here — it clears their oldest
            invoices first. Fully paid purchases move to Payments Done.
          </p>
        </div>
        <div className="grid gap-4 p-6 2xl:px-8 sm:grid-cols-2 xl:grid-cols-4">
          {summary.map((card) => (
            <div
              key={card.label}
              className={cn('rounded-2xl p-4 border', card.accent ? 'bg-orange-50 border-orange-100' : 'bg-gray-50 border-gray-100')}
            >
              <p className={cn('text-xs font-bold uppercase', card.accent ? 'text-orange-600' : 'text-gray-500')}>{card.label}</p>
              <p className={cn('text-2xl font-black mt-1 tabular-nums', card.accent ? 'text-orange-700' : 'text-gray-900')}>{card.value}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search supplier, purchase or invoice no."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <button
          onClick={handleExport}
          disabled={purchaseCount === 0}
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
        <p className="py-12 text-center text-gray-400">Loading purchase credit…</p>
      ) : suppliers.length === 0 ? (
        <div className="bg-white rounded-3xl border border-gray-100 py-16 text-center">
          <p className="text-lg font-bold text-gray-900">Nothing owed to suppliers</p>
          <p className="text-sm text-gray-500 mt-1">Every purchase is paid. Purchases bought on credit will show up here.</p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-12 text-center text-gray-400">No supplier matches “{search}”.</p>
      ) : (
        filtered.map((supplier) => (
          <div key={supplier.supplier_id} className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-5 border-b border-gray-100">
              <div className="flex items-center gap-4 min-w-0">
                <div className="w-12 h-12 shrink-0 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center font-bold text-lg">
                  {supplier.name[0]?.toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="font-bold text-lg text-gray-900 truncate">{supplier.name}</p>
                  <p className="text-xs text-gray-500 flex flex-wrap items-center gap-x-3">
                    {supplier.phone && (<span className="inline-flex items-center gap-1"><Phone size={12} />{supplier.phone}</span>)}
                    {supplier.gstin && <span>GSTIN {supplier.gstin}</span>}
                    <span>{supplier.purchases.length} unpaid purchase{supplier.purchases.length === 1 ? '' : 's'}</span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-xs font-bold uppercase text-gray-400">Owed</p>
                  <p className="text-2xl font-black text-orange-600 tabular-nums">{formatRupees(supplier.total_due)}</p>
                </div>
                <button
                  onClick={() => { setNotice(null); setPaying({ supplier, purchase: null }); }}
                  className="inline-flex items-center gap-2 px-5 py-3 rounded-2xl bg-orange-600 text-white font-bold shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
                >
                  <Wallet size={18} />
                  Record Payment
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Purchase No.</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Invoice</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Total</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Paid</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase text-right">Balance Due</th>
                    <th className="px-6 py-3 text-xs font-bold text-gray-500 uppercase">Unpaid For</th>
                    <th className="px-6 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {supplier.purchases.map((purchase) => (
                    <tr key={purchase.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-3">
                        <p className="font-mono font-bold text-gray-900">{purchase.purchase_number}</p>
                        <p className="text-xs text-gray-400">Entered {formatDateInIST(purchase.created_at)}</p>
                      </td>
                      <td className="px-6 py-3 text-sm text-gray-600">
                        <p>{purchase.invoice_number || 'No invoice no.'}</p>
                        <p className="text-xs text-gray-400">{formatDay(purchase.invoice_date)}</p>
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums text-gray-700">{formatRupees(purchase.total_amount)}</td>
                      <td className="px-6 py-3 text-right tabular-nums text-gray-500">
                        {purchase.amount_paid > 0 ? formatRupees(purchase.amount_paid) : '—'}
                      </td>
                      <td className="px-6 py-3 text-right tabular-nums font-bold text-gray-900">{formatRupees(purchase.balance_due)}</td>
                      <td className="px-6 py-3">
                        <span className={cn('text-xs font-bold px-2 py-1 rounded-full', ageClass(purchase.age_days))}>
                          {ageLabel(purchase.age_days)}
                        </span>
                      </td>
                      <td className="px-6 py-3 text-right">
                        <button
                          onClick={() => { setNotice(null); setPaying({ supplier, purchase }); }}
                          className="px-3 py-2 text-sm font-bold text-orange-600 border border-orange-200 rounded-xl hover:bg-orange-50 transition-all whitespace-nowrap"
                        >
                          Pay this
                        </button>
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
          <SupplierPaymentModal
            supplier={paying.supplier}
            purchases={paying.supplier.purchases}
            purchase={paying.purchase}
            onClose={() => setPaying(null)}
            onSaved={() => {
              setNotice(`Payment to ${paying.supplier.name} saved.`);
              setPaying(null);
              load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
};
