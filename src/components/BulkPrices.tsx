import React, { useEffect, useState } from 'react';
import { Plus, Tags, Trash2 } from 'lucide-react';
import { api } from '../api';
import type { BulkPrice, CartItem } from '../types';
import { nextBulkPrice, round2, round3 } from '../lib/billMath';
import { cn } from '../lib/utils';
import { t, unitLabel } from '../i18n';

/**
 * Bulk prices: a lower price per unit for buying in quantity — "10 or more at
 * ₹45 each". Set per item under Items → Stock & prices; billing applies them on
 * its own once the bill holds enough of the item (src/lib/billMath.ts).
 */

const rupees = (value: number) =>
  `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** "10+ at ₹45.00", the rules one after another. */
export const bulkSummary = (rules: readonly BulkPrice[] | null | undefined) =>
  (rules ?? []).map((rule) => t('{min}+ at {price}', { min: rule.min_quantity, price: rupees(rule.price) })).join(' · ');

/**
 * Under a bill line's price: that a bulk price is on, or how many more would
 * get one, so the cashier can tell the customer.
 */
export const BulkNote: React.FC<{ line: Pick<CartItem, 'quantity' | 'bulk_price' | 'bulk_prices'>; className?: string }> = ({
  line,
  className,
}) => {
  if (line.bulk_price) {
    return (
      <span className={cn('block truncate text-[11px] font-bold text-green-600', className)}>
        {t('Bulk price · {min}+', { min: line.bulk_price.min_quantity })}
      </span>
    );
  }
  const next = nextBulkPrice(line.bulk_prices, line.quantity);
  if (!next) return null;
  return (
    <span className={cn('block truncate text-[11px] font-semibold text-indigo-500', className)} title={t('Bulk price')}>
      {t('{min}+ at {price}', { min: next.min_quantity, price: rupees(next.price) })}
    </span>
  );
};

interface Row {
  key: number;
  min_quantity: string;
  price: string;
}

let nextKey = 1;
const toRows = (rules: readonly BulkPrice[]): Row[] =>
  rules.map((rule) => ({ key: nextKey++, min_quantity: String(rule.min_quantity), price: String(rule.price) }));

/** What is wrong with the rows as typed, or '' when they can be saved. */
const problemWith = (rows: Row[]): string => {
  const rules = rows.map((row) => ({ min_quantity: round3(Number(row.min_quantity)), price: round2(Number(row.price)) }));
  if (rules.some((rule) => !(rule.min_quantity > 1))) return t('Enter a quantity of more than 1.');
  if (rules.some((rule) => !(rule.price > 0))) return t('Enter a price above zero.');
  const sorted = [...rules].sort((a, b) => a.min_quantity - b.min_quantity);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].min_quantity === sorted[index - 1].min_quantity) return t('Each bulk price needs a different quantity.');
    if (sorted[index].price > sorted[index - 1].price) return t('A bigger quantity cannot have a higher price.');
  }
  return '';
};

interface EditorProps {
  itemId: number;
  metric: string;
  rules: readonly BulkPrice[];
  /** The price the next unit sells at, to warn about a bulk price that is not lower. */
  normalPrice: number | null;
  isAdmin: boolean;
  onSaved: (rules: BulkPrice[]) => void;
}

/** The Bulk prices section of Stock & prices. Cashiers see the list; admins change it. */
export const BulkPriceEditor: React.FC<EditorProps> = ({ itemId, metric, rules, normalPrice, isAdmin, onSaved }) => {
  const [rows, setRows] = useState<Row[]>(() => toRows(rules));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // A fresh read of the item replaces what is shown.
  useEffect(() => { setRows(toRows(rules)); }, [rules]);

  const unit = unitLabel(metric);
  const changed =
    JSON.stringify(rows.map((row) => [Number(row.min_quantity), Number(row.price)])) !==
    JSON.stringify(rules.map((rule) => [rule.min_quantity, rule.price]));

  const update = (key: number, field: 'min_quantity' | 'price', value: string) => {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, [field]: value } : row)));
    setError('');
    setMessage('');
  };

  const addRow = () => {
    setRows((current) => [...current, { key: nextKey++, min_quantity: '', price: '' }]);
    setMessage('');
  };

  const removeRow = (key: number) => {
    setRows((current) => current.filter((row) => row.key !== key));
    setError('');
    setMessage('');
  };

  const save = async () => {
    const problem = problemWith(rows);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    try {
      const result = await api.setBulkPrices(
        itemId,
        rows.map((row) => ({ min_quantity: round3(Number(row.min_quantity)), price: round2(Number(row.price)) }))
      );
      setError('');
      setMessage(t('Bulk prices saved.'));
      onSaved(result.bulk_prices);
    } catch (err: any) {
      setError(err?.message || t('Could not save the bulk prices.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-2xl border border-indigo-100 bg-indigo-50/40 p-5 space-y-3" aria-labelledby="bulk-prices-title">
      <div>
        <h4 id="bulk-prices-title" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.2em] text-indigo-500">
          <Tags size={14} />
          {t('Bulk prices')}
        </h4>
        <p className="mt-1 text-sm text-gray-500">
          {t('A lower price when a customer buys more. Once the bill has this quantity or more, every unit sells at the bulk price.')}
        </p>
      </div>

      {!isAdmin ? (
        rules.length ? (
          <ul className="space-y-1 text-sm">
            {rules.map((rule) => (
              <li key={rule.min_quantity} className="font-semibold text-gray-800">
                {t('{min} {metric} or more: {price} each', { min: rule.min_quantity, metric: unit, price: rupees(rule.price) })}
                <span className="ml-1 font-normal text-gray-400">{t('incl. GST')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-gray-400">{t('No bulk prices. Every quantity sells at the normal price.')}</p>
        )
      ) : (
        <>
          {rows.length === 0 && (
            <p className="text-sm text-gray-400">{t('No bulk prices. Every quantity sells at the normal price.')}</p>
          )}
          {rows.map((row, index) => {
            const price = Number(row.price);
            const notLower = normalPrice != null && normalPrice > 0 && price > 0 && price >= normalPrice;
            return (
              <div key={row.key} className="flex flex-wrap items-end gap-3">
                <label className="space-y-1">
                  <span className="block text-xs font-semibold text-gray-600">{t('Buys at least ({metric})', { metric: unit })}</span>
                  <input
                    type="number"
                    step="any"
                    min="0"
                    inputMode="decimal"
                    data-bulk-quantity={index}
                    value={row.min_quantity}
                    onChange={(e) => update(row.key, 'min_quantity', e.target.value)}
                    placeholder={t('e.g. 10')}
                    className="w-36 rounded-2xl border border-gray-200 bg-white px-4 py-2.5 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </label>
                <label className="space-y-1">
                  <span className="block text-xs font-semibold text-gray-600">{t('Price each')} <span className="font-normal text-gray-400">{t('incl. GST')}</span></span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    inputMode="decimal"
                    data-bulk-price={index}
                    value={row.price}
                    onChange={(e) => update(row.key, 'price', e.target.value)}
                    placeholder={normalPrice ? String(normalPrice) : ''}
                    className={cn(
                      'w-36 rounded-2xl border bg-white px-4 py-2.5 outline-none focus:ring-2 focus:ring-orange-500',
                      notLower ? 'border-amber-300' : 'border-gray-200'
                    )}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => removeRow(row.key)}
                  aria-label={t('Remove bulk price')}
                  title={t('Remove bulk price')}
                  className="mb-0.5 flex h-10 w-10 items-center justify-center rounded-xl border border-red-200 bg-white text-red-500 hover:bg-red-50"
                >
                  <Trash2 size={16} />
                </button>
                {notLower && (
                  <p className="basis-full text-xs font-semibold text-amber-600">
                    {t('Not lower than the normal price ({price}), so it changes nothing.', { price: rupees(normalPrice!) })}
                  </p>
                )}
              </div>
            );
          })}

          {error && <p className="text-sm font-semibold text-red-600">{error}</p>}
          {message && !error && <p className="text-sm font-semibold text-green-600">{message}</p>}

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={addRow}
              className="flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-white px-4 py-2 text-sm font-bold text-indigo-600 hover:bg-indigo-50"
            >
              <Plus size={16} />
              {t('Add bulk price')}
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !changed}
              className="rounded-xl bg-orange-600 px-5 py-2 text-sm font-bold text-white hover:bg-orange-700 disabled:opacity-40 disabled:pointer-events-none"
            >
              {saving ? t('Saving…') : t('Save bulk prices')}
            </button>
          </div>
        </>
      )}
    </section>
  );
};
