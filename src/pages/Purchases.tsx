import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Save } from 'lucide-react';
import { api } from '../api';
import { Item, Purchase, Supplier } from '../types';
import { useDataStore } from '../store/useDataStore';
import { formatDateTimeInIST, cn } from '../lib/utils';

type GstMode = 'split' | 'igst';

interface PurchaseReportRow {
  purchase_id: number;
  purchase_number: string;
  supplier_name: string;
  supplier_phone?: string;
  supplier_address?: string;
  supplier_gstin?: string;
  invoice_number?: string;
  invoice_date?: string;
  created_at: string;
  user_name: string;
  item_id: number;
  item_name: string;
  hsn_code?: string;
  metric: string;
  quantity: number;
  unit_cost: number;
  sgst_rate: number;
  cgst_rate: number;
  igst_rate: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
}

interface PurchaseRowState {
  item_id: number;
  item_query: string;
  quantity: number;
  unit_cost: number;
  gst_percent: number;
  gst_mode: GstMode;
}

const GST_OPTIONS = [0, 5, 12, 18, 28];

const getTodayDateValue = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const createEmptyRow = (): PurchaseRowState => ({
  item_id: 0,
  item_query: '',
  quantity: 0,
  unit_cost: 0,
  gst_percent: 0,
  gst_mode: 'split',
});

const isRowEmpty = (row: PurchaseRowState) =>
  !row.item_id &&
  row.item_query.trim() === '' &&
  row.quantity === 0 &&
  row.unit_cost === 0 &&
  row.gst_percent === 0 &&
  row.gst_mode === 'split';

const normalizeRows = (rows: PurchaseRowState[]) => {
  const meaningfulRows = rows.filter((row) => !isRowEmpty(row));
  return [...meaningfulRows, createEmptyRow()];
};

const normalizeSupplierKey = (value: string) => value.trim().toLowerCase();

const getItemHsnCode = (item: Item | undefined) => {
  if (!item) return '';
  return item.hsn_code || (item as Item & { barcode?: string }).barcode || '';
};

function getLatestUnitCostForSupplierItem(
  purchaseRows: PurchaseReportRow[],
  supplierName: string,
  itemId: number
) {
  if (!supplierName || !itemId) return null;

  const supplierKey = normalizeSupplierKey(supplierName);
  const match = purchaseRows.find(
    (row) => normalizeSupplierKey(row.supplier_name) === supplierKey && row.item_id === itemId
  );

  return match?.unit_cost ?? null;
}

export const Purchases = () => {
  const { items, setItems } = useDataStore();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseReportRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [supplierQuery, setSupplierQuery] = useState('');
  const [showSupplierSuggestions, setShowSupplierSuggestions] = useState(false);
  const [activeItemRow, setActiveItemRow] = useState<number | null>(null);
  const [createItemRowIndex, setCreateItemRowIndex] = useState<number | null>(null);
  const [showCreateItemModal, setShowCreateItemModal] = useState(false);
  const [newItemForm, setNewItemForm] = useState<Partial<Item>>({
    name: '',
    hsn_code: '',
    price: 0,
    metric: 'piece',
    is_loose: false,
    gst_applicable: true,
    gst_mode: 'split',
    gst_rate: 0,
    sgst_rate: 0,
    cgst_rate: 0,
    igst_rate: 0,
    stock_quantity: 0,
    image_url: '',
  });
  const [form, setForm] = useState({
    supplier_name: '',
    supplier_phone: '',
    supplier_address: '',
    supplier_gstin: '',
    invoice_number: '',
    invoice_date: getTodayDateValue(),
    notes: '',
  });
  const [rows, setRows] = useState<PurchaseRowState[]>([createEmptyRow()]);

  useEffect(() => {
    Promise.all([api.getPurchases(), api.getPurchaseItemReport(), api.getSuppliers()])
      .then(([purchaseData, purchaseItemData, supplierData]) => {
        setPurchases(purchaseData);
        setPurchaseRows(purchaseItemData);
        if (!Array.isArray(supplierData)) {
          throw new Error('Suppliers response is invalid. Please restart the app server and try again.');
        }

        setSuppliers(
          supplierData.map((supplier: Supplier) => ({
            ...supplier,
            supplier_name: supplier.name,
            supplier_phone: supplier.phone,
            supplier_address: supplier.address,
            supplier_gstin: supplier.gstin,
          }))
        );
      })
      .catch((err) => {
        console.error('Failed to fetch purchase context:', err);
        alert(`Failed to load purchase data: ${err.message}`);
      })
      .finally(() => setLoading(false));
  }, []);

  const supplierSuggestions = useMemo(() => {
    const query = normalizeSupplierKey(supplierQuery || form.supplier_name);
    if (!query) return suppliers.slice(0, 8);

    return suppliers
      .filter((supplier) => normalizeSupplierKey(supplier.name).includes(query))
      .slice(0, 8);
  }, [suppliers, supplierQuery, form.supplier_name]);

  const advanceFocus = (currentElement: HTMLElement) => {
    // Explicit type argument: the `|| []` union widens the inferred element
    // type to `unknown` without it, which breaks the typecheck.
    const focusable = Array.from<HTMLElement>(
      formRef.current?.querySelectorAll<HTMLElement>('[data-purchase-nav="true"]') || []
    ).filter((element) => !element.hasAttribute('disabled'));
    const currentIndex = focusable.indexOf(currentElement);
    const nextElement = currentIndex >= 0 ? focusable[currentIndex + 1] : null;

    if (nextElement) {
      window.setTimeout(() => nextElement.focus(), 0);
    }
  };

  const upsertRow = (rowIndex: number, patch: Partial<PurchaseRowState>) => {
    setRows((current) => {
      const next = current.map((row, index) => (index === rowIndex ? { ...row, ...patch } : row));
      return normalizeRows(next);
    });
  };

  const selectSupplier = (supplier: Supplier) => {
    setSupplierQuery(supplier.name);
    setShowSupplierSuggestions(false);
    setForm((current) => ({
      ...current,
      supplier_name: supplier.name,
      supplier_phone: supplier.phone || '',
      supplier_address: supplier.address || '',
      supplier_gstin: supplier.gstin || '',
    }));

    setRows((current) =>
      normalizeRows(
        current.map((row) => {
          if (!row.item_id) return row;
          const latestPrice = getLatestUnitCostForSupplierItem(purchaseRows, supplier.name, row.item_id);
          return latestPrice == null ? row : { ...row, unit_cost: latestPrice };
        })
      )
    );
  };

  const selectItem = (rowIndex: number, itemId: number) => {
    const item = items.find((entry) => entry.id === itemId);
    if (!item) return;

    const latestPrice = getLatestUnitCostForSupplierItem(purchaseRows, form.supplier_name, itemId);
    upsertRow(rowIndex, {
      item_id: item.id,
      item_query: item.name,
      unit_cost: latestPrice ?? 0,
      gst_mode: item.gst_mode || (item.igst_rate ? 'igst' : 'split'),
      gst_percent: Number(item.gst_rate || item.igst_rate || item.sgst_rate + item.cgst_rate || 0),
    });
    setActiveItemRow(null);
  };

  const openCreateItemModal = (rowIndex: number, itemName: string) => {
    setCreateItemRowIndex(rowIndex);
    setShowCreateItemModal(true);
    setNewItemForm({
      name: itemName,
      hsn_code: '',
      price: 0,
      metric: 'piece',
      is_loose: false,
      gst_applicable: true,
      gst_mode: 'split',
      gst_rate: 0,
      sgst_rate: 0,
      cgst_rate: 0,
      igst_rate: 0,
      stock_quantity: 0,
      image_url: '',
    });
  };

  const handleCreateItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (createItemRowIndex == null) return;

    try {
      const gstMode = newItemForm.gst_mode || 'split';
      const gstRate = Number(newItemForm.gst_rate || 0);
      const normalizedItem = {
        ...newItemForm,
        gst_mode: gstMode,
        gst_rate: gstRate,
        sgst_rate: newItemForm.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
        cgst_rate: newItemForm.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
        igst_rate: newItemForm.gst_applicable ? (gstMode === 'igst' ? gstRate : 0) : 0,
      };
      const result = await api.addItem(normalizedItem);
      const latestItems = await api.getItems();
      setItems(latestItems);
      setShowCreateItemModal(false);

      const createdItem = latestItems.find((item: Item) => item.id === result.id);
      if (createdItem) {
        selectItem(createItemRowIndex, createdItem.id);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to create item');
    }
  };

  const resetForm = () => {
    setSupplierQuery('');
    setShowSupplierSuggestions(false);
    setActiveItemRow(null);
    setForm({
      supplier_name: '',
      supplier_phone: '',
      supplier_address: '',
      supplier_gstin: '',
      invoice_number: '',
      invoice_date: getTodayDateValue(),
      notes: '',
    });
    setRows([createEmptyRow()]);
  };

  const computedRows = useMemo(() => {
    return rows.map((row) => {
      const taxableValue = row.quantity * row.unit_cost;
      const splitRate = row.gst_mode === 'split' ? row.gst_percent / 2 : 0;
      const igstRate = row.gst_mode === 'igst' ? row.gst_percent : 0;
      const sgstAmount = (taxableValue * splitRate) / 100;
      const cgstAmount = (taxableValue * splitRate) / 100;
      const igstAmount = (taxableValue * igstRate) / 100;
      const total = taxableValue + sgstAmount + cgstAmount + igstAmount;

      return {
        ...row,
        taxableValue,
        sgst_rate: splitRate,
        cgst_rate: splitRate,
        igst_rate: igstRate,
        sgst_amount: sgstAmount,
        cgst_amount: cgstAmount,
        igst_amount: igstAmount,
        total_amount: total,
      };
    });
  }, [rows]);

  const filledRows = useMemo(
    () => computedRows.filter((row) => row.item_id && row.quantity > 0 && row.unit_cost > 0),
    [computedRows]
  );

  const totals = useMemo(() => {
    return filledRows.reduce(
      (acc, row) => {
        acc.subtotal += row.taxableValue;
        acc.tax += row.sgst_amount + row.cgst_amount + row.igst_amount;
        acc.total += row.total_amount;
        return acc;
      },
      { subtotal: 0, tax: 0, total: 0 }
    );
  }, [filledRows]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.supplier_name.trim()) {
      alert('Supplier name is required.');
      return;
    }

    if (filledRows.length === 0) {
      alert('Enter at least one valid purchase row.');
      return;
    }

    setSaving(true);
    try {
      await api.createPurchase({
        ...form,
        supplier_name: form.supplier_name.trim(),
        supplier_phone: form.supplier_phone.trim(),
        supplier_address: form.supplier_address.trim(),
        supplier_gstin: form.supplier_gstin.trim(),
        invoice_number: form.invoice_number.trim(),
        notes: form.notes.trim(),
        items: filledRows.map((row) => ({
          item_id: row.item_id,
          quantity: row.quantity,
          unit_cost: row.unit_cost,
          sgst_rate: row.sgst_rate,
          cgst_rate: row.cgst_rate,
          igst_rate: row.igst_rate,
          sgst_amount: row.sgst_amount,
          cgst_amount: row.cgst_amount,
          igst_amount: row.igst_amount,
          total_amount: row.total_amount,
        })),
        subtotal_amount: totals.subtotal,
        tax_amount: totals.tax,
        total_amount: totals.total,
      });

      const [latestPurchases, latestPurchaseRows, latestItems, latestSuppliers] = await Promise.all([
        api.getPurchases(),
        api.getPurchaseItemReport(),
        api.getItems(),
        api.getSuppliers(),
      ]);

      if (!Array.isArray(latestSuppliers)) {
        throw new Error('Suppliers response is invalid. Please restart the app server and try again.');
      }

      setPurchases(latestPurchases);
      setPurchaseRows(latestPurchaseRows);
      setItems(latestItems);
      setSuppliers(
        latestSuppliers.map((supplier: Supplier) => ({
          ...supplier,
          supplier_name: supplier.name,
          supplier_phone: supplier.phone,
          supplier_address: supplier.address,
          supplier_gstin: supplier.gstin,
        }))
      );
      resetForm();
    } catch (err: any) {
      alert(err.message || 'Failed to save purchase');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-amber-50">
          <h1 className="text-2xl font-bold text-gray-900">Purchase Entry</h1>
          <p className="text-sm text-gray-600 mt-1">
            Reuse supplier data, pick GST slabs quickly, and capture item-wise purchase cost with minimal typing.
          </p>
        </div>

        <form ref={formRef} onSubmit={handleSubmit} className="p-8 space-y-8">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            <div className="space-y-2 relative">
              <label className="text-sm font-semibold text-gray-700">Supplier Name</label>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                <input
                  data-purchase-nav="true"
                  type="text"
                  value={supplierQuery}
                  onChange={(e) => {
                    const value = e.target.value;
                    setSupplierQuery(value);
                    setShowSupplierSuggestions(true);
                    setForm((current) => ({ ...current, supplier_name: value }));
                  }}
                  onFocus={() => setShowSupplierSuggestions(true)}
                  onBlur={() => window.setTimeout(() => setShowSupplierSuggestions(false), 150)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const exactMatch = suppliers.find(
                        (supplier) => normalizeSupplierKey(supplier.name) === normalizeSupplierKey(supplierQuery)
                      );
                      const firstMatch = supplierSuggestions[0];

                      if (exactMatch || firstMatch) {
                        selectSupplier(exactMatch || firstMatch);
                      }

                      advanceFocus(e.currentTarget);
                    }
                  }}
                  placeholder="Type supplier name"
                  className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                  required
                />
              </div>

              {showSupplierSuggestions && supplierSuggestions.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden">
                  {supplierSuggestions.map((supplier) => (
                    <button
                      key={supplier.id}
                      type="button"
                      onMouseDown={() => selectSupplier(supplier)}
                      className="w-full px-4 py-3 text-left hover:bg-orange-50 transition-colors"
                    >
                      <p className="font-semibold text-gray-900">{supplier.name}</p>
                      <p className="text-xs text-gray-500">
                        {supplier.supplier_phone || 'No phone'} • {supplier.supplier_gstin || 'No GSTIN'}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Supplier Phone</span>
              <input
                data-purchase-nav="true"
                type="text"
                value={form.supplier_phone}
                onChange={(e) => setForm((current) => ({ ...current, supplier_phone: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advanceFocus(e.currentTarget);
                  }
                }}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Supplier GSTIN</span>
              <input
                data-purchase-nav="true"
                type="text"
                value={form.supplier_gstin}
                onChange={(e) => setForm((current) => ({ ...current, supplier_gstin: e.target.value.toUpperCase() }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advanceFocus(e.currentTarget);
                  }
                }}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2 xl:col-span-2">
              <span className="text-sm font-semibold text-gray-700">Supplier Address</span>
              <input
                data-purchase-nav="true"
                type="text"
                value={form.supplier_address}
                onChange={(e) => setForm((current) => ({ ...current, supplier_address: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advanceFocus(e.currentTarget);
                  }
                }}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Invoice Number</span>
              <input
                data-purchase-nav="true"
                type="text"
                value={form.invoice_number}
                onChange={(e) => setForm((current) => ({ ...current, invoice_number: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advanceFocus(e.currentTarget);
                  }
                }}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">Invoice Date</span>
              <input
                data-purchase-nav="true"
                type="date"
                value={form.invoice_date}
                onChange={(e) => setForm((current) => ({ ...current, invoice_date: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    advanceFocus(e.currentTarget);
                  }
                }}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2 xl:col-span-3">
              <span className="text-sm font-semibold text-gray-700">Notes</span>
              <textarea
                data-purchase-nav="true"
                value={form.notes}
                onChange={(e) => setForm((current) => ({ ...current, notes: e.target.value }))}
                rows={2}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none resize-none"
                placeholder="Optional purchase note"
              />
            </label>
          </div>

          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Purchase Items</h2>
              <p className="text-sm text-gray-500">
                Search item, press Enter to select, and keep pressing Enter to move across rows. One empty row is always kept ready.
              </p>
            </div>

            <div className="overflow-x-auto border border-gray-100 rounded-3xl">
              <table className="w-full min-w-[1100px] text-left">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase">Item Search</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase">HSN</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase">Metric</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase text-right">Qty</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase text-right">Unit Cost</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase">GST Type</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase">GST Slab</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase text-right">GST Amount</th>
                    <th className="px-4 py-4 text-xs font-bold text-gray-500 uppercase text-right">Line Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {computedRows.map((row, rowIndex) => {
                    const itemSuggestions = items
                      .filter((item) => {
                        const query = row.item_query.trim().toLowerCase();
                        if (!query) return true;
                        return item.name.toLowerCase().includes(query) || item.hsn_code?.includes(query);
                      })
                      .slice(0, 8);

                    const isTrailingEmpty = rowIndex === computedRows.length - 1 && isRowEmpty(row);

                    return (
                      <tr key={rowIndex} className={cn(isTrailingEmpty && 'bg-orange-50/30')}>
                        <td className="px-4 py-4 relative">
                          <input
                            data-purchase-nav="true"
                            type="text"
                            value={row.item_query}
                            onFocus={() => setActiveItemRow(rowIndex)}
                            onBlur={() => window.setTimeout(() => setActiveItemRow((current) => (current === rowIndex ? null : current)), 150)}
                            onChange={(e) => {
                              upsertRow(rowIndex, {
                                item_query: e.target.value,
                                item_id: 0,
                              });
                              setActiveItemRow(rowIndex);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                const exactMatch = items.find(
                                  (item) =>
                                    item.name.toLowerCase() === row.item_query.trim().toLowerCase() ||
                                    item.hsn_code === row.item_query.trim()
                                );
                                const firstMatch = itemSuggestions[0];

                                if (exactMatch || firstMatch) {
                                  selectItem(rowIndex, (exactMatch || firstMatch).id);
                                } else if (row.item_query.trim()) {
                                  const shouldCreate = window.confirm(`"${row.item_query.trim()}" does not exist. Do you want to add this item and continue?`);
                                  if (shouldCreate) {
                                    openCreateItemModal(rowIndex, row.item_query.trim());
                                  }
                                }

                                advanceFocus(e.currentTarget);
                              }
                            }}
                            placeholder="Search by item name or HSN"
                            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-orange-500"
                          />

                          {activeItemRow === rowIndex && itemSuggestions.length > 0 && (
                            <div className="absolute z-20 top-full left-4 right-4 mt-1 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden">
                              {itemSuggestions.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  onMouseDown={() => selectItem(rowIndex, item.id)}
                                  className="w-full px-4 py-3 text-left hover:bg-orange-50 transition-colors"
                                >
                                  <p className="font-semibold text-gray-900">{item.name}</p>
                                  <p className="text-xs text-gray-500">
                                    HSN {getItemHsnCode(item) || 'Not set'} • {item.stock_quantity} {item.metric} in stock
                                  </p>
                                </button>
                              ))}
                            </div>
                          )}

                          {activeItemRow === rowIndex && row.item_query.trim() && itemSuggestions.length === 0 && (
                            <button
                              type="button"
                              onMouseDown={() => openCreateItemModal(rowIndex, row.item_query.trim())}
                              className="absolute z-20 top-full left-4 right-4 mt-1 px-4 py-3 bg-white border border-gray-200 rounded-2xl shadow-xl text-left hover:bg-orange-50 transition-colors"
                            >
                              Create "{row.item_query.trim()}" as a new item
                            </button>
                          )}
                        </td>

                        <td className="px-4 py-4">
                          <div className="px-3 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-sm text-gray-600 min-w-[140px]">
                            {getItemHsnCode(items.find((item) => item.id === row.item_id)) || '-'}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          <div className="px-3 py-3 bg-gray-50 border border-gray-200 rounded-2xl text-sm text-gray-600 min-w-[100px]">
                            {items.find((item) => item.id === row.item_id)?.metric || '-'}
                          </div>
                        </td>

                        <td className="px-4 py-4">
                          <input
                            data-purchase-nav="true"
                            type="number"
                            min="0"
                            step="0.01"
                            value={row.quantity || ''}
                            onChange={(e) => upsertRow(rowIndex, { quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                advanceFocus(e.currentTarget);
                              }
                            }}
                            className="w-24 ml-auto block px-3 py-3 text-right bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-orange-500"
                          />
                        </td>

                        <td className="px-4 py-4">
                          <input
                            data-purchase-nav="true"
                            type="number"
                            min="0"
                            step="0.01"
                            value={row.unit_cost || ''}
                            onChange={(e) => upsertRow(rowIndex, { unit_cost: e.target.value === '' ? 0 : Number(e.target.value) })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                advanceFocus(e.currentTarget);
                              }
                            }}
                            className="w-28 ml-auto block px-3 py-3 text-right bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-orange-500"
                          />
                        </td>

                        <td className="px-4 py-4">
                          <select
                            data-purchase-nav="true"
                            value={row.gst_mode}
                            onChange={(e) => upsertRow(rowIndex, { gst_mode: e.target.value as GstMode })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                advanceFocus(e.currentTarget);
                              }
                            }}
                            className="w-full px-3 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-orange-500"
                          >
                            <option value="split">CGST + SGST</option>
                            <option value="igst">IGST</option>
                          </select>
                        </td>

                        <td className="px-4 py-4">
                          <select
                            data-purchase-nav="true"
                            value={row.gst_percent}
                            onChange={(e) => upsertRow(rowIndex, { gst_percent: Number(e.target.value) })}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                advanceFocus(e.currentTarget);
                              }
                            }}
                            className="w-full px-3 py-3 bg-gray-50 border border-gray-200 rounded-2xl outline-none focus:ring-2 focus:ring-orange-500"
                          >
                            {GST_OPTIONS.map((rate) => (
                              <option key={rate} value={rate}>
                                {rate}%
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {row.gst_mode === 'split'
                              ? `${(row.gst_percent / 2).toFixed(1)}% CGST + ${(row.gst_percent / 2).toFixed(1)}% SGST`
                              : `${row.gst_percent}% IGST`}
                          </p>
                        </td>

                        <td className="px-4 py-4 text-right">
                          <p className="font-semibold text-gray-900">
                            Rs. {(row.sgst_amount + row.cgst_amount + row.igst_amount).toFixed(2)}
                          </p>
                          <p className="text-[11px] text-gray-400">
                            {row.gst_mode === 'split'
                              ? `SGST ${row.sgst_amount.toFixed(2)} • CGST ${row.cgst_amount.toFixed(2)}`
                              : `IGST ${row.igst_amount.toFixed(2)}`}
                          </p>
                        </td>

                        <td className="px-4 py-4 text-right font-bold text-gray-900">
                          Rs. {row.total_amount.toFixed(2)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                <p className="text-xs font-bold text-gray-500 uppercase">Subtotal</p>
                <p className="text-2xl font-black text-gray-900 mt-1">Rs. {totals.subtotal.toFixed(2)}</p>
              </div>
              <div className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
                <p className="text-xs font-bold text-gray-500 uppercase">GST Total</p>
                <p className="text-2xl font-black text-amber-600 mt-1">Rs. {totals.tax.toFixed(2)}</p>
              </div>
              <div className="bg-orange-50 rounded-2xl p-4 border border-orange-100">
                <p className="text-xs font-bold text-orange-600 uppercase">Grand Total</p>
                <p className="text-2xl font-black text-orange-700 mt-1">Rs. {totals.total.toFixed(2)}</p>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 px-6 py-4 rounded-2xl bg-orange-600 text-white font-bold shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all disabled:opacity-60"
              >
                <Save size={18} />
                {saving ? 'Saving Purchase...' : 'Save Purchase'}
              </button>
            </div>
          </div>
        </form>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100">
          <h2 className="text-xl font-bold text-gray-900">Recent Purchases</h2>
          <p className="text-sm text-gray-500">Latest purchase entries saved in the system.</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Purchase No.</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Supplier</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Invoice</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Created By</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Created At</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-400">Loading purchases...</td>
                </tr>
              ) : purchases.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-12 text-center text-gray-400">No purchases recorded yet.</td>
                </tr>
              ) : (
                purchases.map((purchase) => (
                  <tr key={purchase.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-mono font-bold text-gray-900">{purchase.purchase_number}</td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-gray-900">{purchase.supplier_name}</p>
                      <p className="text-xs text-gray-500">{purchase.supplier_gstin || 'No GSTIN'}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{purchase.invoice_number || 'N/A'}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{purchase.user_name}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{formatDateTimeInIST(purchase.created_at)}</td>
                    <td className="px-6 py-4 text-right font-bold text-orange-600">Rs. {purchase.total_amount.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showCreateItemModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
          <div className="bg-white w-full max-w-2xl rounded-3xl shadow-2xl overflow-hidden">
            <form onSubmit={handleCreateItem}>
              <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-2xl text-gray-900">Add New Item</h3>
                  <p className="text-sm text-gray-500 mt-1">This item was not found in stock master. Create it and continue this purchase.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateItemModal(false)}
                  className="p-2 hover:bg-gray-100 rounded-full"
                >
                  x
                </button>
              </div>

              <div className="p-8 grid grid-cols-2 gap-6 max-h-[70vh] overflow-auto">
                <div className="space-y-2 col-span-2">
                  <label className="text-sm font-bold text-gray-700">Item Name</label>
                  <input
                    type="text"
                    value={newItemForm.name || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, name: e.target.value }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">HSN Code</label>
                  <input
                    type="text"
                    value={newItemForm.hsn_code || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, hsn_code: e.target.value }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Total Cost (Incl. GST) (Rs.)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newItemForm.price || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, price: e.target.value === '' ? 0 : Number(e.target.value) }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Metric</label>
                  <select
                    value={newItemForm.metric || 'piece'}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, metric: e.target.value }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                  >
                    <option value="piece">Piece</option>
                    <option value="kg">KG</option>
                    <option value="packet">Packet</option>
                    <option value="box">Box</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Initial Stock Quantity</label>
                  <input
                    type="number"
                    value={newItemForm.stock_quantity || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, stock_quantity: e.target.value === '' ? 0 : Number(e.target.value) }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">GST Type</label>
                  <select
                    value={newItemForm.gst_mode || 'split'}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, gst_mode: e.target.value as 'split' | 'igst' }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                  >
                    <option value="split">CGST + SGST</option>
                    <option value="igst">IGST</option>
                  </select>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">GST Slab (%)</label>
                  <select
                    value={newItemForm.gst_rate ?? 0}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, gst_rate: Number(e.target.value) }))}
                    className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                  >
                    {GST_OPTIONS.map((rate) => (
                      <option key={rate} value={rate}>{rate}%</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500">
                    {(newItemForm.gst_mode || 'split') === 'split'
                      ? `${Number(newItemForm.gst_rate || 0) / 2}% SGST + ${Number(newItemForm.gst_rate || 0) / 2}% CGST`
                      : `${Number(newItemForm.gst_rate || 0)}% IGST`}
                  </p>
                </div>
              </div>

              <div className="p-8 bg-gray-50 border-t border-gray-100 flex gap-4">
                <button
                  type="button"
                  onClick={() => setShowCreateItemModal(false)}
                  className="flex-1 py-4 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-100 transition-all"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 py-4 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
                >
                  Save Item And Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
