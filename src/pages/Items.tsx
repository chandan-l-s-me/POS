import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuthStore } from '../store/useAuthStore';
import { useDataStore } from '../store/useDataStore';
import { StockPanel } from '../components/StockPanel';
import { UNIT_OPTIONS } from '../lib/units';
import { GST_SLABS } from '../lib/billMath';
import { api, type ItemFilter } from '../api';
import { useBarcodeScanner } from '../hooks/useBarcodeScanner';
import { barcodeProblem, normalizeBarcode } from '../lib/barcode';
import { 
  FileSpreadsheet,
  Search, 
  Edit2, 
  Trash2, 
  Package, 
  AlertCircle, 
  X,
  Save,
  Layers,
  Truck,
  Barcode,
  Check,
  Tags
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Item } from '../types';
import { cn } from '../lib/utils';
import { itemLabel, t, unitLabel, useItemNamesStore } from '../i18n';
import { HEADER_NOTE } from '../lib/entryStyles';
import { ItemName } from '../components/ItemName';
import { bulkSummary } from '../components/BulkPrices';

/** Ticked unless set to 0: items from before the option are included. */
const inMyGst = (item: Partial<Item>) => item.in_my_gst !== 0 && item.in_my_gst !== false;

export const Items = () => {
  const { user } = useAuthStore();
  // This screen keeps its own rows rather than writing into the shared
  // catalogue cache. It loads one 48-row page at a time, and pushing that page
  // into the store overwrote the app-wide cache that the billing screen
  // matches scans against — while leaving `itemsComplete` true, so billing did
  // not fall back to server-side search either. After a visit here, most of
  // the catalogue was simply unfindable at the till until a reload.
  const [rows, setRows] = useState<Item[]>([]);
  const isAdmin = user?.role === 'admin';
  // The item whose batches are open in the stock panel.
  const [stockItem, setStockItem] = useState<Item | null>(null);
  const refreshItems = useDataStore((state) => state.refreshItems);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);

  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState('');
  const PAGE_SIZE = 48;
  // Which items are shown, and how many each choice has (within the search).
  const [filter, setFilter] = useState<ItemFilter | null>(null);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  // Nothing contained the search, so the server sent the closest names.
  const [closeMatch, setCloseMatch] = useState(false);
  // The card whose barcode is being added or changed right there.
  const [barcodeFor, setBarcodeFor] = useState<number | null>(null);
  const [barcodeDraft, setBarcodeDraft] = useState('');
  const [barcodeError, setBarcodeError] = useState('');
  const [savingBarcode, setSavingBarcode] = useState(false);

  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Search and paging happen in SQL. Filtering the cached page in the browser
  // meant anything past the cache limit could not be found or edited at all.
  // This page also needs the full rows (image_url) for its thumbnails.
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(() => {
    return api.getItemsPage({
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      withImages: 1,
      search: appliedSearch || undefined,
      filter: filter ?? undefined,
      counts: 1,
    })
      .then((res) => { setRows(res?.data ?? []); setTotal(res?.total ?? 0); setCounts(res?.counts ?? null); setCloseMatch(Boolean(res?.close_match)); setLoadError(''); })
      .catch((err: any) => setLoadError(err?.message || t('Could not load items.')));
  }, [page, appliedSearch, filter]);

  useEffect(() => { reload(); }, [reload]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const chooseFilter = (next: ItemFilter | null) => {
    setFilter(next);
    setPage(0);
  };

  // A scan goes to the barcode box that is open (the edit window's, or a
  // card's) wherever the cursor is; with none open, it finds the item the
  // code belongs to.
  useBarcodeScanner((code) => {
    const scanned = normalizeBarcode(code);
    if (showModal) {
      setFormData((form) => ({ ...form, barcode: scanned }));
      document.getElementById('item-barcode')?.focus();
    } else if (barcodeFor != null) {
      setBarcodeDraft(scanned);
      setBarcodeError('');
      document.querySelector<HTMLInputElement>('[data-card-barcode]')?.focus();
    } else {
      setSearch(scanned);
      setFilter(null);
    }
  });

  const startBarcode = (item: Item) => {
    setBarcodeFor(item.id);
    setBarcodeDraft(item.barcode ?? '');
    setBarcodeError('');
  };

  const cancelBarcode = () => {
    setBarcodeFor(null);
    setBarcodeError('');
  };

  /** Save the barcode typed or scanned on a card ('' removes it). */
  const saveBarcode = async (item: Item) => {
    const code = normalizeBarcode(barcodeDraft);
    const problem = barcodeProblem(code);
    if (problem) {
      setBarcodeError(t(problem));
      return;
    }
    if (!code && item.barcode && !window.confirm(t('Remove the barcode from {name}?', { name: itemLabel(item.name) }))) return;
    setSavingBarcode(true);
    try {
      await api.setItemBarcode(item.id, code);
      setBarcodeFor(null);
      setBarcodeError('');
      await Promise.all([reload(), refreshItems()]);
    } catch (err: any) {
      setBarcodeError(err?.message || t('Could not save the barcode.'));
    } finally {
      setSavingBarcode(false);
    }
  };

  const FILTERS: Array<{ value: ItemFilter | null; label: string; count?: number }> = [
    { value: null, label: t('All items'), count: counts?.all_items },
    { value: 'barcode', label: t('With barcode'), count: counts?.barcode },
    { value: 'no_barcode', label: t('Without barcode'), count: counts?.no_barcode },
    { value: 'low_stock', label: t('Low stock'), count: counts?.low_stock },
    { value: 'out_of_stock', label: t('Out of stock'), count: counts?.out_of_stock },
  ];
  // Whether the Kannada name was typed in this form, rather than left to translation.
  const [kannadaTouched, setKannadaTouched] = useState(false);
  const [formData, setFormData] = useState<Partial<Item>>({
    name: '',
    hsn_code: '',
    barcode: '',
    price: 0,
    metric: 'piece',
    is_loose: false,
    gst_applicable: true,
    gst_mode: 'split',
    gst_rate: 12,
    sgst_rate: 6,
    cgst_rate: 6,
    igst_rate: 0,
    stock_quantity: 0,
    image_url: ''
  });
  const formBarcodeProblem = barcodeProblem(normalizeBarcode(formData.barcode));

  // The server already applied the search, so this page's rows are the result.
  const filteredItems = rows;

  const handleOpenModal = (item?: Item) => {
    setKannadaTouched(false);
    if (item) {
      setEditingItem(item);
      setFormData({
        ...item,
        barcode: item.barcode ?? '',
        gst_mode: item.gst_mode || (item.igst_rate ? 'igst' : 'split'),
        gst_rate: item.gst_rate ?? item.igst_rate ?? (item.sgst_rate + item.cgst_rate),
      });
    } else {
      setEditingItem(null);
      setFormData({
        name: '',
        hsn_code: '',
        price: 0,
        metric: 'piece',
        is_loose: false,
        gst_applicable: true,
        gst_mode: 'split',
        gst_rate: 12,
        sgst_rate: 6,
        cgst_rate: 6,
        igst_rate: 0,
        stock_quantity: 0,
        image_url: ''
      });
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formBarcodeProblem) return;
    // The Kannada name as typed; blank (or a renamed item) means translate it
    // again; untouched, the server keeps what it has.
    const renamed = editingItem != null && formData.name !== editingItem.name;
    const nameKn = kannadaTouched ? (formData.name_kn ?? '').trim() : renamed ? '' : undefined;
    const gstMode = formData.gst_mode || 'split';
    const gstRate = Number(formData.gst_rate || 0);
    // Catalogue details only. Price and stock live in batches: they change
    // through purchases, sales, and stock adjustments with a reason.
    const normalizedForm = {
      name: formData.name,
      hsn_code: formData.hsn_code,
      barcode: normalizeBarcode(formData.barcode),
      metric: formData.metric,
      is_loose: formData.is_loose,
      gst_applicable: formData.gst_applicable,
      image_url: formData.image_url,
      gst_mode: gstMode,
      gst_rate: gstRate,
      sgst_rate: formData.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
      cgst_rate: formData.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
      igst_rate: formData.gst_applicable ? (gstMode === 'igst' ? gstRate : 0) : 0,
      name_kn: nameKn,
      in_my_gst: inMyGst(formData) ? 1 : 0,
    };
    try {
      if (!editingItem) return;
      await api.updateItem(editingItem.id, normalizedForm);
      setShowModal(false);
      // Show a typed Kannada name at once, rather than at the next refresh.
      if (nameKn && formData.name) {
        const { names, setNames } = useItemNamesStore.getState();
        setNames({ ...names, [formData.name]: nameKn });
      }
      // Re-read rather than splicing the form values into the list: the server
      // normalises and bounds what it stores, so the row on screen should be
      // what it actually holds.
      await Promise.all([reload(), refreshItems()]);
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (window.confirm(t('Are you sure you want to delete this item?'))) {
      try {
        await api.deleteItem(id);
        await reload();
      } catch (err: any) {
        alert(err.message);
      }
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-barcode-input
            placeholder={t('Search by name, HSN or barcode...')}
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        {/* Items are created on the Purchases screen, where their selling
            price and first stock are entered together. */}
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            {/* The shop's existing shelves, all at once, as opening stock. */}
            <Link
              to="/items/import"
              className="flex items-center gap-2 px-5 py-3 bg-white border border-gray-200 text-gray-700 font-bold rounded-2xl shadow-sm hover:bg-gray-50 transition-all"
              title={t('Add many items at once, with the stock already in the shop')}
            >
              <FileSpreadsheet size={20} />
              {t('Import items')}
            </Link>
            <Link
              to="/purchases"
              className="flex items-center gap-2 px-6 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
              title={t('New items are added with their first purchase')}
            >
              <Truck size={20} />
              {t('Add items via Purchases')}
            </Link>
          </div>
        )}
      </div>

      {/* Filters. Each shows how many items it has, within the search. */}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('Show')}>
        {FILTERS.map((option) => {
          const active = filter === option.value;
          return (
            <button
              key={option.value ?? 'all'}
              type="button"
              onClick={() => chooseFilter(option.value)}
              aria-pressed={active}
              className={cn(
                'flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-semibold transition-all',
                active
                  ? 'border-orange-600 bg-orange-600 text-white shadow-sm'
                  : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'
              )}
            >
              {option.label}
              {option.count != null && (
                <span className={cn('rounded-full px-2 py-0.5 text-xs tabular-nums', active ? 'bg-white/20' : 'bg-gray-100 text-gray-500')}>
                  {option.count.toLocaleString('en-IN')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {closeMatch && (
        <p className="-mt-2 text-sm text-gray-500">
          {t('No exact match for “{search}”. Showing the closest names.', { search: search.trim() })}
        </p>
      )}

      {filter === 'no_barcode' && isAdmin && total > 0 && (
        <p className="-mt-2 text-sm text-gray-500">
          {t('To add barcodes quickly: press “Add barcode” on an item and scan its pack. It leaves this list once saved.')}
        </p>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {filteredItems.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center py-20 text-gray-400 gap-4">
            <div className="w-20 h-20 bg-gray-50 rounded-full flex items-center justify-center">
              <Package size={40} />
            </div>
            {loadError ? (
              <>
                <p className="font-medium text-red-500">{loadError}</p>
                <button
                  onClick={() => reload()}
                  className="px-4 py-2 rounded-xl bg-gray-100 font-semibold text-gray-600 hover:bg-gray-200 transition-all"
                >
                  {t('Retry')}
                </button>
              </>
            ) : (
              <>
                <p className="font-medium">{t('No items found')}</p>
                {filter ? (
                  <button type="button" onClick={() => { setSearch(''); chooseFilter(null); }} className="text-sm font-semibold text-orange-600 hover:underline">
                    {t('Show all items')}
                  </button>
                ) : search ? (
                  <p className="text-sm">{t('Try searching for something else')}</p>
                ) : (
                  <p className="text-sm">{t('Items appear here once they are purchased')}</p>
                )}
              </>
            )}
          </div>
        ) : (
          filteredItems.map(item => (
            <motion.div
              layout
              key={item.id}
              className="bg-white p-6 rounded-3xl shadow-sm border border-gray-100 group hover:shadow-md transition-all"
            >
            <div className="flex justify-between items-start mb-4">
              <div className="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center text-gray-400 overflow-hidden">
                {item.image_url ? (
                  <img src={item.image_url} alt={itemLabel(item.name)} className="w-full h-full object-cover" />
                ) : (
                  <Package size={32} />
                )}
              </div>
              {isAdmin && (
                <div className="flex gap-1">
                  <button 
                    onClick={() => handleOpenModal(item)}
                    aria-label={t('Edit {name}', { name: itemLabel(item.name) })}
                    title={t('Edit')}
                    className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button 
                    onClick={() => handleDelete(item.id)}
                    aria-label={t('Delete {name}', { name: itemLabel(item.name) })}
                    title={t('Delete')}
                    className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              )}
            </div>

            <h4 className="font-bold text-gray-900 mb-1 break-words"><ItemName name={item.name} /></h4>
            <p className="text-xs text-gray-400 font-mono">{t('HSN:')} {item.hsn_code || t('NOT SET')}</p>
            {!inMyGst(item) && (
              <p className="mt-1 inline-block rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-bold text-gray-500">{t('Not in my GST')}</p>
            )}

            {barcodeFor === item.id ? (
              <div className="mt-2 mb-4">
                <div className="flex gap-1.5">
                  <input
                    autoFocus
                    data-barcode-input
                    data-card-barcode
                    type="text"
                    // Selected, so a scan replaces the old code instead of adding to it.
                    onFocus={(e) => e.target.select()}
                    autoComplete="off"
                    spellCheck={false}
                    value={barcodeDraft}
                    onChange={(e) => { setBarcodeDraft(e.target.value); setBarcodeError(''); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void saveBarcode(item); }
                      if (e.key === 'Escape') cancelBarcode();
                    }}
                    placeholder={t('Scan or type the barcode')}
                    aria-label={t('Barcode for {name}', { name: itemLabel(item.name) })}
                    className={cn(
                      'min-w-0 flex-1 rounded-lg border bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:ring-2 focus:ring-orange-500',
                      barcodeError ? 'border-red-300' : 'border-gray-200'
                    )}
                  />
                  <button
                    type="button"
                    onClick={() => void saveBarcode(item)}
                    disabled={savingBarcode}
                    title={t('Save')}
                    aria-label={t('Save')}
                    className="rounded-lg bg-orange-600 px-2 text-white hover:bg-orange-700 disabled:opacity-50"
                  >
                    <Check size={16} />
                  </button>
                  <button
                    type="button"
                    onClick={cancelBarcode}
                    title={t('Cancel')}
                    aria-label={t('Cancel')}
                    className="rounded-lg border border-gray-200 px-2 text-gray-500 hover:bg-gray-100"
                  >
                    <X size={16} />
                  </button>
                </div>
                {barcodeError && <p className="mt-1 text-xs font-semibold text-red-500">{barcodeError}</p>}
              </div>
            ) : item.barcode ? (
              <p className="mt-1 mb-4 flex items-center gap-1.5 text-xs font-mono text-gray-500" title={t('Barcode')}>
                <Barcode size={14} className="shrink-0 text-gray-400" />
                <span className="truncate">{item.barcode}</span>
                {isAdmin && (
                  <button
                    type="button"
                    onClick={() => startBarcode(item)}
                    className="ml-auto shrink-0 font-sans font-semibold text-gray-400 hover:text-orange-600"
                  >
                    {t('Change')}
                  </button>
                )}
              </p>
            ) : isAdmin ? (
              <button
                type="button"
                onClick={() => startBarcode(item)}
                className="mt-1 mb-4 flex items-center gap-1.5 text-xs font-semibold text-orange-600 hover:underline"
              >
                <Barcode size={14} />
                {t('Add barcode')}
              </button>
            ) : (
              <p className="mt-1 mb-4 text-xs text-gray-300">{t('No barcode')}</p>
            )}

            <div className="flex items-center justify-between pt-4 border-t border-gray-50">
              <div>
                {/* The price the next unit sells at: the oldest batch's. */}
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">{t('Selling Price')}<span className={HEADER_NOTE}>{t('incl. GST')}</span></p>
                <p className="text-lg font-black text-orange-600">
                  {item.price > 0 ? `₹${item.price.toFixed(2)}` : '—'}
                </p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">{t('Stock')}</p>
                <p className={cn(
                  "text-lg font-black",
                  item.stock_quantity < 10 ? "text-red-500" : "text-gray-900"
                )}>
                  {item.stock_quantity} <span className="text-xs font-normal text-gray-400">{unitLabel(item.metric)}</span>
                </p>
              </div>
            </div>

            {/* Lower prices for buying more; set under Stock & prices. */}
            {(item.bulk_prices?.length ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => setStockItem(item)}
                className="mt-3 flex w-full items-start gap-1.5 rounded-xl bg-indigo-50 px-3 py-2 text-left text-xs font-semibold text-indigo-600 hover:bg-indigo-100"
              >
                <Tags size={14} className="mt-0.5 shrink-0" />
                <span>
                  <span className="font-bold">{t('Bulk price')}:</span> {bulkSummary(item.bulk_prices)}{' '}
                  <span className="font-normal text-indigo-400">({t('incl. GST')})</span>
                </span>
              </button>
            )}

            {item.stock_quantity < 10 && (
              <div className="mt-4 flex items-center gap-2 text-xs font-bold text-red-500 bg-red-50 px-3 py-2 rounded-xl">
                <AlertCircle size={14} />
                {item.stock_quantity <= 0 ? t('OUT OF STOCK') : t('LOW STOCK ALERT')}
              </div>
            )}

            <button
              onClick={() => setStockItem(item)}
              className="mt-4 w-full flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 transition-all hover:bg-gray-100"
            >
              <Layers size={14} />
              {t('Stock & prices')}
            </button>
          </motion.div>
        )))}
      </div>

      {/* Paging. `total` is a COUNT from the same query, so this reflects the
          whole table, not just what happens to be cached. */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-6 py-4">
          <p className="text-sm text-gray-500">
            {t('Showing {value}–{value2} of {value3}', { value: page * PAGE_SIZE + 1, value2: Math.min((page + 1) * PAGE_SIZE, total), value3: total.toLocaleString('en-IN') })}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              {t('Previous')}
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              {t('Page {value} of {value2}', { value: page + 1, value2: pageCount.toLocaleString('en-IN') })}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              {t('Next')}
            </button>
          </div>
        </div>
      )}

      {/* Item Modal */}
      <AnimatePresence>
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden"
            >
              <form onSubmit={handleSubmit}>
                <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-bold text-2xl">{t('Edit Item')}</h3>
                  <button type="button" onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>

                <div className="p-8 grid grid-cols-2 gap-6 max-h-[70vh] overflow-auto">
                  <div className="space-y-2 col-span-2">
                    <label className="text-sm font-bold text-gray-700">{t('Item Name')}</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => {
                        const name = e.target.value;
                        // A new English name gets a new translation, unless one was typed.
                        const name_kn = kannadaTouched ? formData.name_kn : name === editingItem?.name ? editingItem?.name_kn : '';
                        setFormData({ ...formData, name, name_kn });
                      }}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2 col-span-2">
                    <label htmlFor="item-name-kn" className="text-sm font-bold text-gray-700">{t('Name in Kannada')}</label>
                    <input
                      id="item-name-kn"
                      type="text"
                      lang="kn"
                      value={formData.name_kn ?? ''}
                      onChange={(e) => { setKannadaTouched(true); setFormData({ ...formData, name_kn: e.target.value }); }}
                      placeholder={t('Translated automatically from the English name')}
                      maxLength={200}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                    <p className="text-xs text-gray-500">{t('Shown when the app is in Kannada. Correct it here if the translation is wrong; leave it empty to translate again.')}</p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">{t('HSN Code')}</label>
                    <input
                      type="text"
                      value={formData.hsn_code}
                      onChange={(e) => setFormData({ ...formData, hsn_code: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label htmlFor="item-barcode" className="text-sm font-bold text-gray-700">
                      {t('Barcode')} <span className="font-normal text-gray-400">{t('(optional)')}</span>
                    </label>
                    <input
                      id="item-barcode"
                      type="text"
                      data-barcode-input
                      autoComplete="off"
                      spellCheck={false}
                      value={formData.barcode ?? ''}
                      onChange={(e) => setFormData({ ...formData, barcode: e.target.value })}
                      // Selected, so a scan replaces the old code instead of adding to it.
                      onFocus={(e) => e.target.select()}
                      // A scanner ends with Enter, which would save the form.
                      onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                      placeholder={t('Scan or type the barcode')}
                      className={cn(
                        'w-full px-4 py-3 bg-gray-50 border rounded-xl font-mono focus:ring-2 focus:ring-orange-500 outline-none',
                        formBarcodeProblem ? 'border-red-300' : 'border-gray-200'
                      )}
                    />
                    {formBarcodeProblem && <p className="text-xs font-semibold text-red-500">{t(formBarcodeProblem)}</p>}
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">{t('Selling Price & Stock')}</label>
                    <p className="px-4 py-3 bg-gray-50 border border-gray-100 rounded-xl text-sm text-gray-600">
                      {editingItem && editingItem.price > 0 ? t('₹{price} incl. GST', { price: editingItem.price.toFixed(2) }) : t('No price yet')} ·{' '}
                      {t('{value} {metric} in stock', { value: editingItem?.stock_quantity ?? 0, metric: editingItem?.metric })}
                      {(editingItem?.bulk_prices?.length ?? 0) > 0 && (
                        <span className="block text-xs font-semibold text-indigo-600 mt-1">
                          {t('Bulk price')}: {bulkSummary(editingItem?.bulk_prices)}
                        </span>
                      )}
                      <span className="block text-xs text-gray-400 mt-1">
                        {t('Set on purchases. Change them under Stock & prices.')}
                      </span>
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">{t('Metric')}</label>
                    <select
                      value={formData.metric}
                      onChange={(e) => setFormData({ ...formData, metric: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      {UNIT_OPTIONS.map((unit) => (
                        <option key={unit.value} value={unit.value}>{t(unit.label)}</option>
                      ))}
                      {/* An older item may use a unit no longer offered. */}
                      {formData.metric && !UNIT_OPTIONS.some((unit) => unit.value === formData.metric) && (
                        <option value={formData.metric}>{formData.metric}</option>
                      )}
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">{t('GST Type')}</label>
                    <select
                      value={formData.gst_mode || 'split'}
                      onChange={(e) => setFormData({ ...formData, gst_mode: e.target.value as 'split' | 'igst' })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      <option value="split">{t('CGST + SGST')}</option>
                      <option value="igst">{t('IGST')}</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">{t('GST Slab (%)')}</label>
                    <select
                      value={formData.gst_rate ?? 12}
                      onChange={(e) => setFormData({ ...formData, gst_rate: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      {GST_SLABS.map((rate) => (
                        <option key={rate} value={rate}>{rate}%</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500">
                      {(formData.gst_mode || 'split') === 'split'
                        ? t('{value}% SGST + {value2}% CGST', { value: Number(formData.gst_rate || 0) / 2, value2: Number(formData.gst_rate || 0) / 2 })
                        : t('{number}% IGST', { number: Number(formData.gst_rate || 0) })}
                    </p>
                  </div>

                  <div className="col-span-2 flex items-center gap-4 py-2">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.is_loose}
                        onChange={(e) => setFormData({ ...formData, is_loose: e.target.checked })}
                        className="w-5 h-5 accent-orange-600"
                      />
                      <span className="text-sm font-bold text-gray-700">{t('Loose Item (Weight based)')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.gst_applicable}
                        onChange={(e) => setFormData({ ...formData, gst_applicable: e.target.checked })}
                        className="w-5 h-5 accent-orange-600"
                      />
                      <span className="text-sm font-bold text-gray-700">{t('GST Applicable')}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        id="item-in-my-gst"
                        checked={inMyGst(formData)}
                        onChange={(e) => setFormData({ ...formData, in_my_gst: e.target.checked ? 1 : 0 })}
                        className="w-5 h-5 accent-orange-600"
                      />
                      <span className="text-sm font-bold text-gray-700">{t('Include in my GST')}</span>
                    </label>
                  </div>
                  <p className="col-span-2 -mt-4 text-xs text-gray-500">
                    {t('Include in my GST: the sales report can show only these items. Bills show GST on every item either way.')}
                  </p>
                </div>

                <div className="p-8 bg-gray-50 border-t border-gray-100 flex gap-4">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-4 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-100 transition-all"
                  >
                    {t('Cancel')}
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-4 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all flex items-center justify-center gap-2"
                  >
                    <Save size={20} />
                    {t('Update Item')}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {stockItem && (
        <StockPanel
          item={stockItem}
          isAdmin={isAdmin}
          onClose={() => setStockItem(null)}
          onChanged={() => {
            void reload();
            void refreshItems();
          }}
        />
      )}
    </div>
  );
};
