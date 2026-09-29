import React, { useCallback, useEffect, useState } from 'react';
import { useAuthStore } from '../store/useAuthStore';
import { api } from '../api';
import { 
  Search, 
  Plus, 
  Edit2, 
  Trash2, 
  Package, 
  AlertCircle, 
  X,
  Save,
  Image as ImageIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Item } from '../types';
import { cn } from '../lib/utils';

export const Items = () => {
  const GST_OPTIONS = [0, 5, 12, 18, 28];
  const { user } = useAuthStore();
  // This screen keeps its own rows rather than writing into the shared
  // catalogue cache. It loads one 48-row page at a time, and pushing that page
  // into the store overwrote the app-wide cache that the billing screen
  // matches scans against — while leaving `itemsComplete` true, so billing did
  // not fall back to server-side search either. After a visit here, most of
  // the catalogue was simply unfindable at the till until a reload.
  const [rows, setRows] = useState<Item[]>([]);
  const isAdmin = user?.role === 'admin';
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);

  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState('');
  const PAGE_SIZE = 48;

  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Search and paging happen in SQL. Filtering the cached page in the browser
  // meant anything past the cache limit could not be found or edited at all.
  // This page also needs the full rows (image_url) for its thumbnails.
  const [loadError, setLoadError] = useState('');

  const reload = useCallback(() => {
    return api.getItemsPage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, withImages: 1, search: appliedSearch || undefined })
      .then((res) => { setRows(res?.data ?? []); setTotal(res?.total ?? 0); setLoadError(''); })
      .catch((err: any) => setLoadError(err?.message || 'Could not load items.'));
  }, [page, appliedSearch]);

  useEffect(() => { reload(); }, [reload]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [formData, setFormData] = useState<Partial<Item>>({
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

  // The server already applied the search, so this page's rows are the result.
  const filteredItems = rows;

  const handleOpenModal = (item?: Item) => {
    if (item) {
      setEditingItem(item);
      setFormData({
        ...item,
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
    const gstMode = formData.gst_mode || 'split';
    const gstRate = Number(formData.gst_rate || 0);
    const normalizedForm = {
      ...formData,
      gst_mode: gstMode,
      gst_rate: gstRate,
      sgst_rate: formData.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
      cgst_rate: formData.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
      igst_rate: formData.gst_applicable ? (gstMode === 'igst' ? gstRate : 0) : 0,
    };
    try {
      if (editingItem) {
        await api.updateItem(editingItem.id, normalizedForm);
      } else {
        await api.addItem(normalizedForm);
      }
      setShowModal(false);
      // Re-read rather than splicing the form values into the list: the server
      // normalises and bounds what it stores, so the row on screen should be
      // what it actually holds.
      await reload();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleDelete = async (id: number) => {
    if (window.confirm('Are you sure you want to delete this item?')) {
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
      <div className="flex items-center justify-between">
        <div className="relative w-96">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search items by name or HSN..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        {isAdmin && (
          <button
            onClick={() => handleOpenModal()}
            className="flex items-center gap-2 px-6 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
          >
            <Plus size={20} />
            Add New Item
          </button>
        )}
      </div>

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
                  Retry
                </button>
              </>
            ) : (
              <>
                <p className="font-medium">No items found</p>
                {search ? (
                  <p className="text-sm">Try searching for something else</p>
                ) : (
                  <p className="text-sm">Items will appear here once added</p>
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
                  <img src={item.image_url} alt={item.name} className="w-full h-full object-cover" />
                ) : (
                  <Package size={32} />
                )}
              </div>
              {isAdmin && (
                <div className="flex gap-1">
                  <button 
                    onClick={() => handleOpenModal(item)}
                    className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
                  >
                    <Edit2 size={18} />
                  </button>
                  <button 
                    onClick={() => handleDelete(item.id)}
                    className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              )}
            </div>

            <h4 className="font-bold text-gray-900 mb-1">{item.name}</h4>
            <p className="text-xs text-gray-400 mb-4 font-mono">HSN: {item.hsn_code || 'NOT SET'}</p>

            <div className="flex items-center justify-between pt-4 border-t border-gray-50">
              <div>
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">Total Cost</p>
                <p className="text-lg font-black text-orange-600">₹{item.price.toFixed(2)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">Stock</p>
                <p className={cn(
                  "text-lg font-black",
                  item.stock_quantity < 10 ? "text-red-500" : "text-gray-900"
                )}>
                  {item.stock_quantity} <span className="text-xs font-normal text-gray-400">{item.metric}</span>
                </p>
              </div>
            </div>

            {item.stock_quantity < 10 && (
              <div className="mt-4 flex items-center gap-2 text-xs font-bold text-red-500 bg-red-50 px-3 py-2 rounded-xl">
                <AlertCircle size={14} />
                LOW STOCK ALERT
              </div>
            )}
          </motion.div>
        )))}
      </div>

      {/* Paging. `total` is a COUNT from the same query, so this reflects the
          whole table, not just what happens to be cached. */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-gray-100 bg-white px-6 py-4">
          <p className="text-sm text-gray-500">
            Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, total)} of {total.toLocaleString('en-IN')}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              Page {page + 1} of {pageCount.toLocaleString('en-IN')}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
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
                  <h3 className="font-bold text-2xl">{editingItem ? 'Edit Item' : 'Add New Item'}</h3>
                  <button type="button" onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>

                <div className="p-8 grid grid-cols-2 gap-6 max-h-[70vh] overflow-auto">
                  <div className="space-y-2 col-span-2">
                    <label className="text-sm font-bold text-gray-700">Item Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">HSN Code</label>
                    <input
                      type="text"
                      value={formData.hsn_code}
                      onChange={(e) => setFormData({ ...formData, hsn_code: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Total Cost (Incl. GST) (₹)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.price || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setFormData({ ...formData, price: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Metric</label>
                    <select
                      value={formData.metric}
                      onChange={(e) => setFormData({ ...formData, metric: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      <option value="piece">Piece</option>
                      <option value="kg">KG</option>
                      <option value="packet">Packet</option>
                      <option value="box">Box</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Stock Quantity</label>
                    <input
                      type="number"
                      value={formData.stock_quantity || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setFormData({ ...formData, stock_quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">GST Type</label>
                    <select
                      value={formData.gst_mode || 'split'}
                      onChange={(e) => setFormData({ ...formData, gst_mode: e.target.value as 'split' | 'igst' })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      <option value="split">CGST + SGST</option>
                      <option value="igst">IGST</option>
                    </select>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">GST Slab (%)</label>
                    <select
                      value={formData.gst_rate ?? 12}
                      onChange={(e) => setFormData({ ...formData, gst_rate: Number(e.target.value) })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
                      {GST_OPTIONS.map((rate) => (
                        <option key={rate} value={rate}>{rate}%</option>
                      ))}
                    </select>
                    <p className="text-xs text-gray-500">
                      {(formData.gst_mode || 'split') === 'split'
                        ? `${Number(formData.gst_rate || 0) / 2}% SGST + ${Number(formData.gst_rate || 0) / 2}% CGST`
                        : `${Number(formData.gst_rate || 0)}% IGST`}
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
                      <span className="text-sm font-bold text-gray-700">Loose Item (Weight based)</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={formData.gst_applicable}
                        onChange={(e) => setFormData({ ...formData, gst_applicable: e.target.checked })}
                        className="w-5 h-5 accent-orange-600"
                      />
                      <span className="text-sm font-bold text-gray-700">GST Applicable</span>
                    </label>
                  </div>
                </div>

                <div className="p-8 bg-gray-50 border-t border-gray-100 flex gap-4">
                  <button
                    type="button"
                    onClick={() => setShowModal(false)}
                    className="flex-1 py-4 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-100 transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 py-4 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all flex items-center justify-center gap-2"
                  >
                    <Save size={20} />
                    {editingItem ? 'Update Item' : 'Save Item'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
