import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Boxes, Download, PackageCheck, PackageX, Search } from 'lucide-react';
import { api } from '../api';
import type { StockRow, StockStatus, StockSummary } from '../types';
import { StockPanel } from '../components/StockPanel';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { formatRupees } from '../lib/supplierPayments';
import { cn, formatDateInIST, getISTTimestampForFileName } from '../lib/utils';

type Filter = 'all' | StockStatus;
type Sort = 'name' | 'quantity' | 'days_left' | 'value';

const STATUS: Record<StockStatus, { label: string; chip: string }> = {
  in: { label: 'In stock', chip: 'bg-emerald-50 text-emerald-700' },
  low: { label: 'Low stock', chip: 'bg-amber-50 text-amber-700' },
  out: { label: 'Out of stock', chip: 'bg-red-50 text-red-700' },
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
      filter: 'in', label: 'In stock', value: qty(summary.in_stock), icon: PackageCheck, tone: 'emerald',
      note: `of ${qty(summary.item_count)} items`,
    },
    {
      filter: 'low', label: 'Low stock', value: qty(summary.low_stock), icon: AlertTriangle, tone: 'amber',
      note: `${qty(threshold)} or fewer left`,
    },
    {
      filter: 'out', label: 'Out of stock', value: qty(summary.out_of_stock), icon: PackageX, tone: 'red',
      note: 'nothing left to sell',
    },
    {
      filter: 'all', label: 'Stock value', value: formatRupees(summary.value_at_price), icon: Boxes, tone: 'sky',
      note: isAdmin && summary.value_at_cost != null ? `at selling price; ${formatRupees(summary.value_at_cost)} at cost` : 'at selling price',
    },
  ] : [];

  const toneClasses: Record<string, { card: string; active: string; text: string; icon: string }> = {
    emerald: { card: 'border-emerald-100', active: 'ring-2 ring-emerald-400', text: 'text-emerald-700', icon: 'bg-emerald-50 text-emerald-600' },
    amber: { card: 'border-amber-100', active: 'ring-2 ring-amber-400', text: 'text-amber-700', icon: 'bg-amber-50 text-amber-600' },
    red: { card: 'border-red-100', active: 'ring-2 ring-red-400', text: 'text-red-700', icon: 'bg-red-50 text-red-600' },
    sky: { card: 'border-sky-100', active: 'ring-2 ring-sky-400', text: 'text-sky-800', icon: 'bg-sky-50 text-sky-600' },
  };

  const tabs: Array<{ value: Filter; label: string; count?: number }> = [
    { value: 'all', label: 'All items', count: summary?.item_count },
    { value: 'in', label: 'In stock', count: summary?.in_stock },
    { value: 'low', label: 'Low stock', count: summary?.low_stock },
    { value: 'out', label: 'Out of stock', count: summary?.out_of_stock },
  ];

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-emerald-50 to-sky-50">
          <h1 className="text-2xl font-bold text-gray-900">Stock</h1>
          <p className="text-sm text-gray-600 mt-1">
            Everything on the shelf. Low stock is {qty(threshold)} or fewer left. “Lasts” is how long the stock will last at
            the rate it sold over the last {windowDays} days. Click an item to see its batches.
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
              placeholder="Search item or HSN"
              className="w-full pl-11 pr-4 py-2.5 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
            />
          </div>
          <select
            aria-label="Sort by"
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="px-4 py-2.5 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm font-semibold text-gray-700"
          >
            <option value="name">Sort: Name</option>
            <option value="quantity">Sort: Least stock first</option>
            <option value="days_left">Sort: Running out soonest</option>
            <option value="value">Sort: Highest value</option>
          </select>
          <button
            onClick={handleExport}
            disabled={visible.length === 0}
            className="flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            <Download size={18} />
            Export CSV
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
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Item</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Status</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">In Stock</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">Sells At</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right">Value</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase text-right" title={`Units sold in the last ${windowDays} days`}>Sold {windowDays}d</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Lasts</th>
                <th className="px-4 py-3 text-xs font-bold text-gray-500 uppercase">Last Bought / Sold</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr><td colSpan={8} className="px-6 py-12 text-center text-gray-400">Loading stock…</td></tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-400">
                    {filter === 'low' ? 'No item is running low.' : filter === 'out' ? 'Nothing is out of stock.' : 'No items match.'}
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
                    <p className="font-bold text-gray-900">{item.name}</p>
                    <p className="text-xs text-gray-400">HSN {item.hsn_code || '—'}</p>
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
                    <span className="text-xs text-gray-400">{item.metric}</span>
                    {item.batch_count > 1 && <p className="text-xs text-gray-400">{item.batch_count} batches</p>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <p className="font-semibold text-gray-900">{formatRupees(item.price)}</p>
                    {item.price_count > 1 && <p className="text-xs text-gray-400 whitespace-nowrap">+ other prices</p>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <p className="font-semibold text-gray-900">{item.stock_quantity > 0 ? formatRupees(item.value_at_price) : '—'}</p>
                    {isAdmin && item.stock_quantity > 0 && item.value_at_cost != null && (
                      <p className="text-xs text-gray-400 whitespace-nowrap" title={item.uncosted_batches ? 'Some stock has no recorded cost' : undefined}>
                        {formatRupees(item.value_at_cost)} at cost{item.uncosted_batches ? '*' : ''}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-gray-600">{item.sold_recent > 0 ? qty(item.sold_recent) : '—'}</td>
                  <td className="px-4 py-3 whitespace-nowrap">
                    {item.status === 'out' ? (
                      <span className="text-xs font-bold text-red-600">Sold out</span>
                    ) : item.days_left == null ? (
                      <span className="text-xs text-gray-400">No recent sales</span>
                    ) : (
                      <span className={cn(
                        'text-xs font-bold px-2 py-1 rounded-full',
                        item.days_left < RUNNING_OUT_DAYS ? 'bg-red-50 text-red-700' : 'bg-gray-100 text-gray-600'
                      )}>
                        ~{qty(item.days_left)} day{item.days_left === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">
                    <p><span className="text-gray-400">Bought</span> {item.last_purchased_at ? formatDateInIST(item.last_purchased_at) : '—'}</p>
                    <p><span className="text-gray-400">Sold</span> {item.last_sold_at ? formatDateInIST(item.last_sold_at) : 'never'}</p>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && visible.length > 0 && (
          <p className="border-t border-gray-100 px-6 py-3 text-sm text-gray-500">
            {visible.length} item{visible.length === 1 ? '' : 's'}
            {filter !== 'all' ? ` · ${STATUS[filter].label.toLowerCase()}` : ''}
            {' · '}worth {formatRupees(visible.reduce((acc, item) => acc + item.value_at_price, 0))} at selling price
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
