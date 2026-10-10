import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { X, Wallet } from 'lucide-react';
import { api } from '../api';
import type { CreditPurchase } from '../types';
import { PAYMENT_METHOD_OPTIONS, formatDay, formatRupees, todayIST } from '../lib/supplierPayments';
import { round2 } from '../lib/billMath';

interface Props {
  supplier: { supplier_id: number; name: string; total_due: number };
  /** The supplier's unpaid purchases, oldest first, as the server will settle them. */
  purchases: CreditPurchase[];
  /** Pay this one purchase only, instead of the oldest first. */
  purchase?: CreditPurchase | null;
  onClose: () => void;
  onSaved: () => void;
}

const FIELD = 'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none';

/**
 * Record money handed to a supplier. Against one purchase, or — the usual case
 * — against the supplier, which clears their oldest invoices first; the
 * dialog shows which ones before it is saved.
 */
export const SupplierPaymentModal = ({ supplier, purchases, purchase, onClose, onSaved }: Props) => {
  const owed = purchase ? purchase.balance_due : supplier.total_due;
  const [amount, setAmount] = useState(String(owed.toFixed(2)));
  const [paidOn, setPaidOn] = useState(todayIST());
  const [method, setMethod] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = round2(Number(amount) || 0);

  // Which invoices this amount clears, worked out the way the server does.
  const preview = useMemo(() => {
    const queue = purchase ? [purchase] : purchases;
    let left = value;
    const rows: Array<{ purchase: CreditPurchase; amount: number; cleared: boolean }> = [];
    for (const row of queue) {
      if (left <= 0) break;
      const take = round2(Math.min(left, row.balance_due));
      rows.push({ purchase: row, amount: take, cleared: take >= row.balance_due });
      left = round2(left - take);
    }
    return rows;
  }, [purchase, purchases, value]);

  const tooMuch = value > owed;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!(value > 0)) {
      setError('Enter the amount paid.');
      return;
    }
    if (tooMuch) {
      setError(`That is more than the ${formatRupees(owed)} owed.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.recordSupplierPayment({
        ...(purchase ? { purchase_id: purchase.id } : { supplier_id: supplier.supplier_id }),
        amount: value,
        paid_on: paidOn,
        method: method || undefined,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      });
      onSaved();
    } catch (err: any) {
      setError(err.message || 'Could not save the payment');
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
            <p className="text-sm text-gray-500 mt-1">
              {supplier.name}
              {purchase ? ` · ${purchase.purchase_number}` : ''} · owed {formatRupees(owed)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-2 hover:bg-gray-100 rounded-full">
            <X size={22} />
          </button>
        </div>

        <div className="px-8 pb-6 space-y-4 overflow-y-auto">
          <div className="grid grid-cols-2 gap-4">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Amount paid (₹)</span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                autoFocus
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={`${FIELD} font-bold tabular-nums ${tooMuch ? 'border-red-300 text-red-600' : ''}`}
              />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Paid on</span>
              <input type="date" max={todayIST()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} className={FIELD} />
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">
                Method <span className="font-normal text-gray-400">(optional)</span>
              </span>
              <select value={method} onChange={(e) => setMethod(e.target.value)} className={FIELD}>
                <option value="">Not recorded</option>
                {PAYMENT_METHOD_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">
                Reference <span className="font-normal text-gray-400">(optional)</span>
              </span>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR / cheque no."
                className={FIELD}
              />
            </label>
          </div>
          <label className="space-y-2 block">
            <span className="text-sm font-semibold text-gray-700">
              Note <span className="font-normal text-gray-400">(optional)</span>
            </span>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} className={FIELD} />
          </label>

          {preview.length > 0 && !tooMuch && (
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-xs font-bold uppercase text-gray-500 mb-2">
                {purchase ? 'Settles' : 'Settles, oldest invoice first'}
              </p>
              <ul className="space-y-1.5 text-sm">
                {preview.map(({ purchase: row, amount: share, cleared }) => (
                  <li key={row.id} className="flex justify-between gap-3">
                    <span className="text-gray-700">
                      <span className="font-mono font-semibold">{row.purchase_number}</span>
                      {row.invoice_number ? ` · inv ${row.invoice_number}` : ''}
                      <span className="text-gray-400"> · {formatDay(row.invoice_date)}</span>
                    </span>
                    <span className="tabular-nums font-semibold text-gray-900 whitespace-nowrap">
                      {formatRupees(share)}{' '}
                      <span className={cleared ? 'text-emerald-600' : 'text-amber-600'}>
                        {cleared ? '· paid in full' : `· ${formatRupees(round2(row.balance_due - share))} left`}
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
            <Wallet size={16} />
            {saving ? 'Saving…' : 'Save Payment'}
          </button>
        </div>
      </motion.form>
    </div>
  );
};
