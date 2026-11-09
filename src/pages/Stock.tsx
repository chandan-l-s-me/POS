import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Download, PackageCheck, PackageX, Search } from 'lucide-react';
import { api } from '../api';
import type { StockRow, StockStatus, StockSummary } from '../types';
import { StockPanel } from '../components/StockPanel';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { formatRupees } from '../lib/supplierPayments';
import { cn, formatDateInIST, getISTTimestampForFileName } from '../lib/utils';
import { t, tn, unitLabel, withEnglish } from '../i18n';
import { ItemName } from '../components/ItemName';

type Filter = 'all' | StockStatus;
type Sort = 'name' | 'quantity' | 'days_left' | 'value';

const STATUS: Record<StockStatus, { label: string; chip: string }> = {
  in: { get label() { return t('In stock'); }, chip: 'bg-emerald-50 text-emerald-700' },
  low: { get label() { return t('Low stock'); }, chip: 'bg-amber-50 text-amber-700' },
  out: { get label() { return t('Out of stock'); }, chip: 'bg-red-50 text-red-700' },
};

/** Worst first when sorting by quantity: out, then low, then the rest. */
const STATUS_RANK: Record<StockStatus, number> = { out: 0, low: 1, in: 2 };

/** Under a week of stock left at the recent rate of sale. */
const RUNNING_OUT_DAYS = 7;

const qty = (value: number) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

const csvCell = (value: string | number | null | undefined) => `"${String(value ?? '').replace(/"/g, '""')}"`;

/**
 * Stock: every item and what is on the shelf — in stock, low or out — with
 * what it is worth and how long it will last. Click an item for its batches.
 */
export const Stock = () => {
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const refreshItems = useDataStore((state) => state.refreshItems);
  const [items, setItems] = useState<StockRow[]>([]);
  const [summary, setSummary] = useState<StockSummary | null>(null);
  const [threshold, setThreshold] = useState(10);
  const [windowDays, setWindowDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [search, setSearch] = useState('');
  const [openItem, setOpenItem] = useState<StockRow | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getStock()
      .then((res) => {
        setItems(res?.items ?? []);
        setSummary(res?.summary ?? null);
        setThreshold(res?.threshold ?? 10);
        setWindowDays(res?.sales_window_days ?? 30);
        setError(null);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    const rows = items.filter((item) =>
      (filter === 'all' || item.status === filter) &&
      (!query || item.name.toLowerCase().includes(query) || (item.hsn_code || '').toLowerCase().includes(query))
    );
    const byName = (a: StockRow, b: StockRow) => a.name.localeCompare(b.name);
    const sorters: Record<Sort, (a: StockRow, b: StockRow) => number> = {
      name: byName,
      quantity: (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.stock_quantity - b.stock_quantity || byName(a, b),
      // Soonest to run out first; out of stock before that, never-sold last.
      days_left: (a, b) => {
        const key = (row: StockRow) => (row.status === 'out' ? -1 : row.days_left ?? Number.MAX_SAFE_INTEGER);
        return key(a) - key(b) || byName(a, b);
      },
      value: (a, b) => b.value_at_price - a.value_at_price || byName(a, b),
    };
    return [...rows].sort(sorters[sort]);
  }, [items, filter, search, sort]);

  const handleExport = () => {
    const header = [
      'Item', 'HSN', 'Unit', 'Status', 'In Stock', 'Sells At', 'Value at Selling Price',
      ...(isAdmin ? ['Value at Cost'] : []),
      `Sold (last ${windowDays} days)`, 'Days Left', 'Last Purchased', 'Last Sold',
    ];
    const rows = visible.map((item) => [
      item.name, item.hsn_code, item.metric, STATUS[item.status].label, item.stock_quantity, item.price.toFixed(2),
      item.value_at_price.toFixed(2), ...(isAdmin ? [(item.value_at_cost ?? 0).toFixed(2)] : []),
      item.sold_recent, item.days_left ?? '',
      item.last_purchased_at ? formatDateInIST(item.last_purchased_at) : '',
      item.last_sold_at ? formatDateInIST(item.last_sold_at) : '',
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `stock-${filter}-${getISTTimestampForFileName()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const cards: Array<{ filter: Filter; label: string; value: string; note: string; icon: React.ElementType; tone: string }> = summary ? [
    {
      filter: 'in', label: t('In stock'), value: qty(summary.in_stock), icon: PackageCheck, tone: 'emerald',
      note: t('of {count} items', { count: qty(summary.item_count) }),
    },
    {
      filter: 'low', label: t('Low stock'), value: qty(summary.low_stock), icon: AlertTriangle, tone: 'amber',
      note: t('{count} or fewer left', { count: qty(threshold) }),
    },
    {
      filter: 'out', label: t('Out of stock'), value: qty(summary.out_of_stock), icon: PackageX, tone: 'red',
      note: t('nothing left to sell'),
    },
    {
      filter: 'all', label: t('Stock value'), value: formatRupees(summary.value_at_price), icon: Boxes, tone: 'sky',
      note: isAdmin && summary.value_at_cost != null ? t('at selling price; {cost} at cost', { cost: formatRupees(summary.value_at_cost) }) : t('at selling price'),
    },
  ] : [];

  const toneClasses: Record<string, { card: string; active: string; text: string; icon: string }> = {
    emerald: { card: 'border-emerald-100', active: 'ring-2 ring-emerald-400', text: 'text-emerald-700', icon: 'bg-emerald-50 text-emerald-600' },
    amber: { card: 'border-amber-100', active: 'ring-2 ring-amber-400', text: 'text-amber-700', icon: 'bg-amber-50 text-amber-600' },
    red: { card: 'border-red-100', active: 'ring-2 ring-red-400', text: 'text-red-700', icon: 'bg-red-50 text-red-600' },
    sky: { card: 'border-sky-100', active: 'ring-2 ring-sky-400', text: 'text-sky-800', icon: 'bg-sky-50 text-sky-600' },
  };

  const tabs: Array<{ value: Filter; label: string; count?: number }> = [
    { value: 'all', label: t('All items'), count: summary?.item_count },
    { value: 'in', label: t('In stock'), count: summary?.in_stock },
    { value: 'low', label: t('Low stock'), count: summary?.low_stock },
    { value: 'out', label: t('Out of stock'), count: summary?.out_of_stock },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-sky-50">
          <h1 className="text-2xl font-bold text-gray-900">{t('Stock')}</h1>
          <p className="text-sm text-gray-600 mt-1">
            {t('Everything on the shelf. Low stock is {threshold} or fewer left. “Lasts” is how long the stock will last at the rate it sold over the last {windowDays} days. Click an item to see its batches.', { threshold: qty(threshold), windowDays })}
          </p>
        </div>
        <div className="grid gap-4 p-6 2xl:px-8 sm:grid-cols-2 xl:grid-cols-4">
          {cards.map((card) => {
            const tone = toneClasses[card.tone];
            return (
              <button
                key={card.label}
                type="button"
                onClick={() => setFilter(card.filter)}
                className={cn(
                  'text-left rounded-2xl p-4 border bg-white transition-all hover:shadow-sm flex items-start gap-3',
                  tone.card,
                  filter === card.filter && card.filter !== 'all' && tone.active
                )}
              >
                <span className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0', tone.icon)}>
                  <card.icon size={20} />
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-bold uppercase text-gray-500">{card.label}</span>
                  <span className={cn('block text-2xl font-black tabular-nums', tone.text)}>{card.value}</span>
                  <span className="block text-xs text-gray-500">{card.note}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setFilter(tab.value)}
              className={cn(
                'px-4 py-2 rounded-2xl text-sm font-bold transition-all',
                filter === tab.value ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
              )}
            >
              {tab.label}
              {tab.count != null && <span className="ml-1.5 opacity-70">{tab.count}</span>}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Search item or HSN')}
              className="w-full pl-11 pr-4 py-2.5 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
            />
          </div>
          <select
            aria-label={t('Sort by')}
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="px-4 py-2.5 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm font-semibold text-gray-700"
          >
            <option value="name">{t('Sort: Name')}</option>
            <option value="quantity">{t('Sort: Least stock first')}</option>
            <option value="days_left">{t('Sort: Running out soonest')}</option>
            <option value="value">{t('Sort: Highest value')}</option>
          </select>
          <button
            onClick={() => withEnglish(handleExport)}
            disabled={visible.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            <Download size={18} />
            {t('Export CSV')}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</p>
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">{t('Item')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">{t('Status')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">{t('In Stock')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">{t('Sells At')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">{t('Value')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right" title={t('Units sold in the last {windowDays} days', { windowDays })}>{t('Sold {windowDays}', { windowDays })}d</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">{t('Lasts')}</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">{t('Last Bought / Sold')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-gray-400">{t('Loading stock…')}</td></tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-400">
                    {filter === 'low' ? t('No item is running low.') : filter === 'out' ? t('Nothing is out of stock.') : t('No items match.')}
                  </td>
                </tr>
              ) : visible.map((item) => (
                <tr
                  key={item.id}
                  onClick={() => setOpenItem(item)}
                  className={cn(
                    'cursor-pointer transition-colors hover:bg-gray-50',
                    item.status === 'out' && 'bg-red-50/40',
                    item.status === 'low' && 'bg-amber-50/40'
                  )}
                >
                  <td className="px-4 py-3 min-w-[14rem]">
                    <p className="font-bold text-gray-900"><ItemName name={item.name} /></p>
                    <p className="text-xs text-gray-400">{t('HSN {value}', { value: item.hsn_code || '—' })}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('text-xs font-bold px-2 py-1 rounded-full whitespace-nowrap', STATUS[item.status].chip)}>
                      {STATUS[item.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums whitespace-nowrap">
                    <span className={cn('font-black', item.status === 'out' ? 'text-red-600' : item.status === 'low' ? 'text-amber-700' : 'text-gray-900')}>
                      {qty(item.stock_quantity)}
                    </span>{' '}
                    <span className="text-xs text-gray-400">{unitLabel(item.metric)}</span>
                    {item.batch_count > 1 && <p className="text-xs text-gray-400">{t('{batch_count} batches', { batch_count: item.batch_count })}</p>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <p className="font-semibold text-gray-900">{formatRupees(item.price)}</p>
                    {item.price_count > 1 && <p className="text-xs text-gray-400 whitespace-nowrap">{t('+ other prices')}</p>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <p className="font-semibold text-gray-900">{item.stock_quantity > 0 ? formatRupees(item.value_at_price) : '—'}</p>
                    {isAdmin && item.stock_quantity > 0 && item.value_at_cost != null && (
                      <p className="text-xs text-gray-400 whitespace-nowrap" title={item.uncosted_batches ? t('Some stock has no recorded cost') : undefined}>
                        {t('{amount} at cost', { amount: formatRupees(item.value_at_cost) })}{item.uncosted_batches ? '*' : ''}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600">{item.sold_recent > 0 ? qty(item.sold_recent) : '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {item.status === 'out' ? (
                      <span className="text-xs font-bold text-red-600">{t('Sold out')}</span>
                    ) : item.days_left == null ? (
                      <span className="text-xs text-gray-400">{t('No recent sales')}</span>
                    ) : (
                      <span className={cn(
                        'text-xs font-bold px-2 py-1 rounded-full',
                        item.days_left < RUNNING_OUT_DAYS ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                      )}>
                        ~{tn(item.days_left, '1 day', '{count} days', { count: qty(item.days_left) })}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    <p><span className="text-gray-400">{t('Bought')}</span> {item.last_purchased_at ? formatDateInIST(item.last_purchased_at) : '—'}</p>
                    <p><span className="text-gray-400">{t('Sold')}</span> {item.last_sold_at ? formatDateInIST(item.last_sold_at) : t('never')}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && visible.length > 0 && (
          <p className="border-t border-gray-100 px-6 py-3 text-sm text-gray-500">
            {tn(visible.length, '1 item', '{count} items')}
            {filter !== 'all' ? ` · ${STATUS[filter].label}` : ''}
            {' · '}{t('worth {rupees} at selling price', { rupees: formatRupees(visible.reduce((acc, item) => acc + item.value_at_price, 0)) })}
          </p>
        )}
      </div>

      {openItem && (
        <StockPanel
          item={openItem}
          isAdmin={isAdmin}
          onClose={() => setOpenItem(null)}
          onChanged={() => {
            load();
            void refreshItems();
          }}
        />
      )}
    </div>
  );
};
