import React, { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Layers, X } from 'lucide-react';
import { api } from '../api';
import type { Item, StockBatch } from '../types';
import { cn, formatDateTimeInIST } from '../lib/utils';
import { round3 } from '../lib/billMath';

/**
 * One item's stock, batch by batch, in the order it will be sold.
 *
 * Every purchase line is a batch with its own cost and selling price; billing
 * takes from the top of this list first. Admins can reprice what is left in a
 * batch and adjust stock with a reason — the only ways to change stock other
 * than buying or selling it. Cashiers see quantities and selling prices, not
 * costs. Profit % is not shown on screen anywhere; it is in the purchase
 * report download.
 */

interface StockPanelProps {
  item: Pick<Item, 'id' | 'name' | 'metric'>;
  isAdmin: boolean;
  onClose: () => void;
  /** Stock or price changed; the caller's list is stale. */
  onChanged: () => void;
}

const money = (value: number | null | undefined) =>
  value == null ? '—' : `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const sourceLabel = (batch: StockBatch) => {
  if (batch.source === 'purchase') {
    return [batch.purchase_number, batch.supplier_name].filter(Boolean).join(' · ') || 'Purchase';
  }
  if (batch.source === 'adjustment') return 'Added by hand';
  return 'Opening stock';
};

export const StockPanel: React.FC<StockPanelProps> = ({ item, isAdmin, onClose, onChanged }) => {
  const [batches, setBatches] = useState<StockBatch[]>([]);
  const [summary, setSummary] = useState<{ stock_quantity: number; price: number } | null>(null);
  const [showSoldOut, setShowSoldOut] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Repricing one batch at a time.
  const [repricingId, setRepricingId] = useState<number | null>(null);
  const [repriceValue, setRepriceValue] = useState('');

  // The adjustment form.
  const [mode, setMode] = useState<'remove' | 'add'>('remove');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [sellingPrice, setSellingPrice] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getItemBatches(item.id, { all: true });
      setBatches(res?.data ?? []);
      setSummary({ stock_quantity: res?.item?.stock_quantity ?? 0, price: res?.item?.price ?? 0 });
      setError('');
    } catch (err: any) {
      setError(err?.message || 'Could not load stock.');
    } finally {
      setLoading(false);
    }
  }, [item.id]);

  useEffect(() => { void load(); }, [load]);

  const inStock = batches.filter((batch) => batch.quantity_remaining > 0);
  const visible = showSoldOut ? batches : inStock;
  const nextToSell = inStock[0]?.id;
  const latest = batches[batches.length - 1];

  const saveReprice = async (batchId: number) => {
    const price = Number(repriceValue);
    if (!(price > 0)) {
      setError('Enter a selling price above zero.');
      return;
    }
    try {
      await api.repriceBatch(batchId, price);
      setRepricingId(null);
      setMessage('Price updated.');
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not update the price.');
    }
  };

  const submitAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = round3(Number(quantity));
    if (!(amount > 0)) {
      setError('Enter how much to add or remove.');
      return;
    }
    if (!reason.trim()) {
      setError('Enter a reason — it is kept in the activity log.');
      return;
    }
    setSaving(true);
    try {
      const result = await api.adjustStock(item.id, {
        quantity: mode === 'remove' ? -amount : amount,
        reason: reason.trim(),
        ...(mode === 'add' && unitCost !== '' ? { unit_cost: Number(unitCost) } : {}),
        ...(mode === 'add' && sellingPrice !== '' ? { selling_price: Number(sellingPrice) } : {}),
      });
      setQuantity('');
      setReason('');
      setUnitCost('');
      setSellingPrice('');
      setError('');
      setMessage(`Stock is now ${result.stock_quantity} ${item.metric}.`);
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not adjust stock.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-white w-full max-w-5xl rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh]"
      >
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-8">
          <div>
            <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-gray-400">
              <Layers size={14} />
              Stock &amp; prices
            </p>
            <h3 className="mt-1 text-2xl font-bold text-gray-900">{item.name}</h3>
            {summary && (
              <p className="mt-2 text-sm text-gray-500">
                <span className="font-bold text-gray-900">{summary.stock_quantity} {item.metric}</span> in stock ·
                selling next at <span className="font-bold text-gray-900">{money(summary.price)}</span>
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-full p-2 hover:bg-gray-100" aria-label="Close stock">
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-8 py-6 space-y-4">
          {error && (
            <p className="rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm font-medium text-red-600">{error}</p>
          )}
          {message && !error && (
            <p className="rounded-2xl border border-green-100 bg-green-50 px-4 py-3 text-sm font-medium text-green-600">{message}</p>
          )}

          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">Sold from the top down: the oldest stock goes first, at its own price.</p>
            <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer">
              <input type="checkbox" checked={showSoldOut} onChange={(e) => setShowSoldOut(e.target.checked)} className="accent-orange-600" />
              Show sold-out batches
            </label>
          </div>

          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs uppercase tracking-wider text-gray-400">
                <th className="pb-3 font-bold">Received</th>
                <th className="pb-3 font-bold">From</th>
                <th className="pb-3 text-right font-bold">Bought</th>
                <th className="pb-3 text-right font-bold">Left</th>
                {isAdmin && <th className="pb-3 text-right font-bold">Cost<span className="block font-normal normal-case">before GST</span></th>}
                <th className="pb-3 text-right font-bold">Selling price</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {loading ? (
                <tr><td colSpan={7} className="py-10 text-center text-gray-400">Loading stock…</td></tr>
              ) : visible.length === 0 ? (
                <tr><td colSpan={7} className="py-10 text-center text-gray-400">No stock. It arrives with a purchase.</td></tr>
              ) : (
                visible.map((batch) => (
                  <tr key={batch.id} className={cn('align-top', batch.quantity_remaining <= 0 && 'opacity-50')}>
                    <td className="py-3 pr-3 whitespace-nowrap text-gray-500">
                      {formatDateTimeInIST(batch.received_at)}
                      {batch.id === nextToSell && (
                        <span className="ml-2 rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-black uppercase text-orange-600">
                          Sells next
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-3 text-gray-700">{sourceLabel(batch)}</td>
                    <td className="py-3 pr-3 text-right text-gray-500">{batch.quantity_received}</td>
                    <td className="py-3 pr-3 text-right font-bold text-gray-900">{batch.quantity_remaining}</td>
                    {isAdmin && <td className="py-3 pr-3 text-right text-gray-700">{money(batch.unit_cost)}</td>}
                    <td className="py-3 text-right">
                      {isAdmin && repricingId === batch.id ? (
                        <span className="inline-flex items-center gap-2">
                          <input
                            type="number"
                            step="0.01"
                            min="0.01"
                            autoFocus
                            value={repriceValue}
                            onChange={(e) => setRepriceValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') void saveReprice(batch.id);
                              if (e.key === 'Escape') setRepricingId(null);
                            }}
                            className="w-24 rounded-xl border border-gray-200 bg-gray-50 px-2 py-1 text-right outline-none focus:ring-2 focus:ring-orange-500"
                          />
                          <button onClick={() => void saveReprice(batch.id)} className="text-xs font-bold text-orange-600 hover:underline">Save</button>
                          <button onClick={() => setRepricingId(null)} className="text-xs text-gray-400 hover:underline">Cancel</button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-2">
                          <span className="font-bold text-gray-900">{money(batch.selling_price)}</span>
                          {isAdmin && batch.quantity_remaining > 0 && (
                            <button
                              onClick={() => { setRepricingId(batch.id); setRepriceValue(String(batch.selling_price)); setMessage(''); }}
                              className="text-xs font-bold text-orange-600 hover:underline"
                            >
                              Change
                            </button>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {isAdmin && (
          <form onSubmit={submitAdjustment} className="border-t border-gray-100 bg-gray-50 p-6 space-y-3">
            <div className="flex items-center gap-3">
              <p className="text-xs font-bold uppercase tracking-[0.2em] text-gray-400">Adjust stock</p>
              <div className="flex rounded-xl border border-gray-200 bg-white p-0.5 text-xs font-bold">
                {(['remove', 'add'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setMode(option)}
                    className={cn('rounded-lg px-3 py-1.5', mode === option ? 'bg-orange-600 text-white' : 'text-gray-500')}
                  >
                    {option === 'remove' ? 'Remove' : 'Add'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400">
                {mode === 'remove'
                  ? 'Taken from the oldest stock first — damaged, expired, a recount.'
                  : 'Added as a new batch — stock that was not bought through a purchase.'}
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="space-y-1">
                <span className="block text-xs font-semibold text-gray-600">Quantity ({item.metric})</span>
                <input
                  type="number" step="0.001" min="0"
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  className="w-28 rounded-2xl border border-gray-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                />
              </label>
              {mode === 'add' && (
                <>
                  <label className="space-y-1">
                    <span className="block text-xs font-semibold text-gray-600">Cost before GST</span>
                    <input
                      type="number" step="0.01" min="0"
                      value={unitCost}
                      onChange={(e) => setUnitCost(e.target.value)}
                      placeholder={latest?.unit_cost != null ? String(latest.unit_cost) : 'Optional'}
                      className="w-32 rounded-2xl border border-gray-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-xs font-semibold text-gray-600">Selling price</span>
                    <input
                      type="number" step="0.01" min="0.01"
                      value={sellingPrice}
                      onChange={(e) => setSellingPrice(e.target.value)}
                      placeholder={latest ? String(latest.selling_price) : 'Required'}
                      className="w-32 rounded-2xl border border-gray-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    />
                  </label>
                </>
              )}
              <label className="flex-1 min-w-[14rem] space-y-1">
                <span className="block text-xs font-semibold text-gray-600">Reason</span>
                <input
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={mode === 'remove' ? 'e.g. 3 packets expired' : 'e.g. opening stock'}
                  className="w-full rounded-2xl border border-gray-200 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                />
              </label>
              <button
                type="submit"
                disabled={saving}
                className="rounded-2xl bg-orange-600 px-6 py-3 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700 disabled:opacity-50 disabled:pointer-events-none"
              >
                {saving ? 'Saving…' : mode === 'remove' ? 'Remove stock' : 'Add stock'}
              </button>
            </div>
          </form>
        )}
      </motion.div>
    </div>
  );
};
