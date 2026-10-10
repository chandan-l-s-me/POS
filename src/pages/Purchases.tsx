import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, Save } from 'lucide-react';
import { api } from '../api';
import { Item, Purchase, Supplier } from '../types';
import { useDataStore } from '../store/useDataStore';
import { formatDateTimeInIST, cn } from '../lib/utils';
import { round2, saleGstRate, type TaxableItem } from '../lib/billMath';
import { UNIT_OPTIONS } from '../lib/units';
import { HEADER_NOTE, ROW_FIELD, TABLE_HEAD_ROW } from '../lib/entryStyles';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { PAYMENT_METHOD_OPTIONS } from '../lib/supplierPayments';

/**
 * How this purchase is being paid. On credit by default: forgetting to mark a
 * purchase paid leaves it on Purchase Credit, where it is seen and fixed;
 * the other way round would hide a debt.
 */
type PaymentMode = 'credit' | 'full' | 'part';
const createEmptyPayment = () => ({ mode: 'credit' as PaymentMode, amount: '', method: '', reference: '' });

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
  selling_price?: number | null;
}

interface PurchaseRowState {
  item_id: number;
  item_query: string;
  quantity: number;
  /**
   * The cost per unit as the owner typed it: before GST or after GST, as
   * `cost_basis` says. The other figure is worked out from the line's GST (see
   * `costsOf`), so changing the GST moves the figure the owner did not type.
   */
  cost: number;
  cost_basis: CostBasis;
  gst_percent: number;
  gst_mode: GstMode;
  /**
   * What this stock will sell for, GST-inclusive, as the owner sets it. It
   * becomes the batch's price. The margin it makes is worked out and stored
   * by the server, and shows only in the purchase report download.
   */
  selling_price: number;
  /**
   * For a new item — a name typed that is not in the catalogue — its HSN code
   * and unit, entered in the row. The item is created only when the purchase
   * saves. Unused when `item_id` points at an existing item.
   */
  hsn_code: string;
  metric: string;
}

type CostBasis = 'before_gst' | 'after_gst';

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * A row's unit cost before and after GST, one typed and one derived. The cost
 * before GST is what the server is sent; worked back from an after-GST figure
 * it keeps six decimals, so the line still totals to exactly what the owner
 * typed (₹100 incl. 18% is ₹84.745763, and 10 of them come to ₹1,000.00).
 */
const costsOf = (row: Pick<PurchaseRowState, 'cost' | 'cost_basis' | 'gst_percent'>) => {
  const factor = 1 + row.gst_percent / 100;
  return row.cost_basis === 'after_gst'
    ? { before: round6(row.cost / factor), after: row.cost }
    : { before: row.cost, after: row.cost * factor };
};

/** A row naming an item that is not in the catalogue yet. */
const isNewItemRow = (row: PurchaseRowState) => !row.item_id && row.item_query.trim() !== '';

/**
 * GST type and slab in one dropdown, keyed `mode:percent`. Nil GST has no
 * type, so it is always `split:0`.
 */
const GST_CHOICES: { value: string; label: string }[] = [
  { value: 'split:0', label: 'No GST' },
  ...[5, 12, 18, 28].map((rate) => ({ value: `split:${rate}`, label: `GST ${rate}%` })),
  ...[5, 12, 18, 28].map((rate) => ({ value: `igst:${rate}`, label: `IGST ${rate}%` })),
];

const gstChoiceOf = (row: Pick<PurchaseRowState, 'gst_mode' | 'gst_percent'>) =>
  row.gst_percent > 0 ? `${row.gst_mode}:${row.gst_percent}` : 'split:0';



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
  cost: 0,
  cost_basis: 'before_gst',
  gst_percent: 0,
  gst_mode: 'split',
  selling_price: 0,
  hsn_code: '',
  metric: '',
});

const isRowEmpty = (row: PurchaseRowState) =>
  !row.item_id &&
  row.item_query.trim() === '' &&
  row.quantity === 0 &&
  row.cost === 0 &&
  row.gst_percent === 0 &&
  row.gst_mode === 'split' &&
  row.selling_price === 0 &&
  row.hsn_code === '' &&
  row.metric === '';

const normalizeRows = (rows: PurchaseRowState[]) => {
  const meaningfulRows = rows.filter((row) => !isRowEmpty(row));
  return [...meaningfulRows, createEmptyRow()];
};

const normalizeSupplierKey = (value: string) => value.trim().toLowerCase();

const getItemHsnCode = (item: Item | undefined) => {
  if (!item) return '';
  return item.hsn_code || (item as Item & { barcode?: string }).barcode || '';
};

/**
 * The cost this supplier last charged for the item, offered the way the owner
 * entered it. A cost with more than two decimals was worked back from an
 * after-GST figure, so that figure is offered again rather than 84.745763.
 */
function getLatestCostForSupplierItem(
  purchaseRows: PurchaseReportRow[],
  supplierName: string,
  itemId: number
): Pick<PurchaseRowState, 'cost' | 'cost_basis'> | null {
  if (!supplierName || !itemId) return null;

  const supplierKey = normalizeSupplierKey(supplierName);
  const match = purchaseRows.find(
    (row) => normalizeSupplierKey(row.supplier_name) === supplierKey && row.item_id === itemId
  );
  if (!match) return null;

  const rate = Number(match.sgst_rate || 0) + Number(match.cgst_rate || 0) + Number(match.igst_rate || 0);
  if (rate > 0 && Math.abs(match.unit_cost - round2(match.unit_cost)) > 1e-9) {
    return { cost: round2(match.unit_cost * (1 + rate / 100)), cost_basis: 'after_gst' };
  }
  return { cost: match.unit_cost, cost_basis: 'before_gst' };
}

/**
 * The selling price the owner set for this item on its latest purchase, from
 * any supplier, or the price it is billing at now. The report rows are newest
 * first.
 */
function getLastSellingPrice(purchaseRows: PurchaseReportRow[], item: Item) {
  const match = purchaseRows.find((row) => row.item_id === item.id && Number(row.selling_price) > 0);
  if (match) return Number(match.selling_price);
  return item.price > 0 ? item.price : 0;
}

export const Purchases = () => {
  const { items, refreshItems } = useDataStore();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseReportRow[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [supplierQuery, setSupplierQuery] = useState('');
  const [showSupplierSuggestions, setShowSupplierSuggestions] = useState(false);
  const [activeItemRow, setActiveItemRow] = useState<number | null>(null);
  const itemInputRefs = useRef(new Map<number, HTMLInputElement>());
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
  const [payment, setPayment] = useState(createEmptyPayment);

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

  const enterAdvances = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      advanceFocus(event.currentTarget);
    }
  };

  /**
   * One of the row's two cost boxes. The one the owner typed in shows what
   * they typed; the other shows the figure worked out from it, in grey, and
   * typing there makes that one the typed figure instead.
   */
  const costInput = (row: PurchaseRowState, rowIndex: number, basis: CostBasis) => {
    const typed = row.cost_basis === basis;
    const costs = costsOf(row);
    const derived = basis === 'before_gst' ? costs.before : costs.after;
    return (
      <input
        data-purchase-nav="true"
        type="number"
        inputMode="decimal"
        min="0"
        step="0.01"
        value={typed ? row.cost || '' : derived > 0 ? round2(derived) : ''}
        onChange={(e) => upsertRow(rowIndex, { cost: e.target.value === '' ? 0 : Number(e.target.value), cost_basis: basis })}
        onKeyDown={enterAdvances}
        title={
          typed || !(row.cost > 0)
            ? `Cost per unit ${basis === 'before_gst' ? 'before' : 'after'} GST`
            : `Worked out from the cost ${basis === 'before_gst' ? 'after' : 'before'} GST — type here to enter this one instead`
        }
        className={cn(ROW_FIELD, 'text-right tabular-nums', !typed && 'text-gray-500')}
      />
    );
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
          const latestCost = getLatestCostForSupplierItem(purchaseRows, supplier.name, row.item_id);
          if (latestCost == null) return row;
          return { ...row, ...latestCost };
        })
      )
    );
  };

  const selectItem = (rowIndex: number, itemId: number) => {
    const item = items.find((entry) => entry.id === itemId);
    if (!item) return;

    const latestCost = getLatestCostForSupplierItem(purchaseRows, form.supplier_name, itemId);
    upsertRow(rowIndex, {
      item_id: item.id,
      item_query: item.name,
      ...(latestCost ?? { cost: 0, cost_basis: 'before_gst' }),
      gst_mode: item.gst_mode || (item.igst_rate ? 'igst' : 'split'),
      gst_percent: Number(item.gst_rate || item.igst_rate || item.sgst_rate + item.cgst_rate || 0),
      // Start from the price set last time; the owner changes it as needed.
      selling_price: getLastSellingPrice(purchaseRows, item),
    });
    setActiveItemRow(null);
  };

  /**
   * The GST the row's goods will be SOLD at, which the selling price includes.
   * An existing item has its own; a new item takes the GST of the line it is
   * bought on — the server does the same when it creates the item.
   */
  const itemFor = (row: PurchaseRowState): TaxableItem | undefined => {
    if (row.item_id) return items.find((entry) => entry.id === row.item_id);
    if (!isNewItemRow(row)) return undefined;
    const split = row.gst_mode === 'split';
    return {
      gst_applicable: row.gst_percent > 0,
      gst_mode: row.gst_mode,
      gst_rate: row.gst_percent,
      sgst_rate: split ? row.gst_percent / 2 : 0,
      cgst_rate: split ? row.gst_percent / 2 : 0,
      igst_rate: split ? 0 : row.gst_percent,
    };
  };

  /**
   * The selling price, less the GST it includes, does not cover the cost.
   * The owner is warned, not stopped — clearance stock is sold at a loss.
   */
  const sellsBelowCost = (row: PurchaseRowState) => {
    const item = itemFor(row);
    const unitCost = costsOf(row).before;
    if (!item || !(row.selling_price > 0) || !(unitCost > 0)) return false;
    return row.selling_price / (1 + saleGstRate(item) / 100) < unitCost - 0.005;
  };

  // The item suggestions float over the page, placed against the row's search
  // box, so the table's scroll box can never clip them.
  const itemMenuStyle = useAnchoredMenu(
    activeItemRow != null,
    () => (activeItemRow == null ? null : itemInputRefs.current.get(activeItemRow)),
    [activeItemRow, rows]
  );

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
    setPayment(createEmptyPayment());
  };

  const computedRows = useMemo(() => {
    return rows.map((row) => {
      // Rounded exactly as the server rounds, so what is shown is what saves.
      const costs = costsOf(row);
      const taxableValue = round2(row.quantity * costs.before);
      const splitRate = row.gst_mode === 'split' ? row.gst_percent / 2 : 0;
      const igstRate = row.gst_mode === 'igst' ? row.gst_percent : 0;
      const sgstAmount = round2((taxableValue * splitRate) / 100);
      const cgstAmount = round2((taxableValue * splitRate) / 100);
      const igstAmount = round2((taxableValue * igstRate) / 100);
      const total = round2(taxableValue + sgstAmount + cgstAmount + igstAmount);

      return {
        ...row,
        unit_cost: costs.before,
        unit_cost_after_gst: costs.after,
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
    () => computedRows.filter((row) => (row.item_id || isNewItemRow(row)) && row.quantity > 0 && row.unit_cost > 0),
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

    // The selling price is set here, on the purchase, and becomes the price
    // this stock is billed at. A line without one cannot be sold.
    // A new item needs what the catalogue needs: an HSN code and a unit.
    const incomplete = filledRows.filter((row) => isNewItemRow(row) && (!row.hsn_code.trim() || !row.metric));
    if (incomplete.length > 0) {
      alert(`Enter the HSN code and unit for the new item: ${incomplete.map((row) => row.item_query.trim()).join(', ')}.`);
      return;
    }
    // Typed a name that is already in the catalogue without picking it.
    const existing = filledRows.filter(
      (row) => isNewItemRow(row) && items.some((item) => item.name.trim().toLowerCase() === row.item_query.trim().toLowerCase())
    );
    if (existing.length > 0) {
      alert(`Already an item — pick it from the list: ${existing.map((row) => row.item_query.trim()).join(', ')}.`);
      return;
    }
    const newNames = filledRows.filter(isNewItemRow).map((row) => row.item_query.trim().toLowerCase());
    const twice = newNames.find((name, index) => newNames.indexOf(name) !== index);
    if (twice) {
      alert(`"${twice}" is entered twice as a new item. Enter it once.`);
      return;
    }

    const unpriced = filledRows.filter((row) => !(row.selling_price > 0));
    if (unpriced.length > 0) {
      alert(
        `Enter the selling price for: ${unpriced.map((row) => row.item_query).join(', ')}.`
      );
      return;
    }

    const grandTotal = round2(totals.total);
    const partAmount = round2(Number(payment.amount) || 0);
    if (payment.mode === 'part' && !(partAmount > 0 && partAmount < grandTotal)) {
      alert(`Enter the amount paid now — more than 0 and less than the total of Rs. ${grandTotal.toFixed(2)}.`);
      return;
    }
    const amountPaid = payment.mode === 'full' ? grandTotal : payment.mode === 'part' ? partAmount : 0;

    setSaving(true);
    try {
      await api.createPurchase({
        amount_paid: amountPaid,
        payment_method: amountPaid > 0 ? payment.method || undefined : undefined,
        payment_reference: amountPaid > 0 ? payment.reference.trim() || undefined : undefined,
        ...form,
        supplier_name: form.supplier_name.trim(),
        supplier_phone: form.supplier_phone.trim(),
        supplier_address: form.supplier_address.trim(),
        supplier_gstin: form.supplier_gstin.trim(),
        invoice_number: form.invoice_number.trim(),
        notes: form.notes.trim(),
        items: filledRows.map((row) => ({
          // An existing item by id; a new one by its details, to be created
          // only as part of saving this purchase.
          ...(isNewItemRow(row)
            ? { new_item: { name: row.item_query.trim(), hsn_code: row.hsn_code.trim(), metric: row.metric } }
            : { item_id: row.item_id }),
          quantity: row.quantity,
          unit_cost: row.unit_cost,
          sgst_rate: row.sgst_rate,
          cgst_rate: row.cgst_rate,
          igst_rate: row.igst_rate,
          sgst_amount: row.sgst_amount,
          cgst_amount: row.cgst_amount,
          igst_amount: row.igst_amount,
          total_amount: row.total_amount,
          selling_price: round2(row.selling_price),
        })),
        subtotal_amount: totals.subtotal,
        tax_amount: totals.tax,
        total_amount: totals.total,
      });

      const [latestPurchases, latestPurchaseRows, , latestSuppliers] = await Promise.all([
        api.getPurchases(),
        api.getPurchaseItemReport(),
        // A purchase changes stock, so the shared catalogue cache is stale.
        // Refresh it the one supported way rather than with a bare
        // `api.getItems()`, which returns only the server's default 100 rows.
        refreshItems(),
        api.getSuppliers(),
      ]);

      if (!Array.isArray(latestSuppliers)) {
        throw new Error('Suppliers response is invalid. Please restart the app server and try again.');
      }

      setPurchases(latestPurchases);
      setPurchaseRows(latestPurchaseRows);
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
        <div className="px-6 2xl:px-8 py-6 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-amber-50">
          <h1 className="text-2xl font-bold text-gray-900">Purchase Entry</h1>
          <p className="text-sm text-gray-600 mt-1">
            Reuse supplier data, pick GST slabs quickly, and capture item-wise purchase cost with minimal typing.
          </p>
        </div>

        <form ref={formRef} onSubmit={handleSubmit} className="p-6 2xl:p-8 space-y-8">
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
                Search an item and keep pressing Enter to move across the row. Enter the cost either before or after GST — the
                other is worked out from the GST. The selling price is what this stock is billed at, once older stock has sold.
                Type a name that is not in the list to add it as a new item.
              </p>
            </div>

            <div className="overflow-x-auto border border-gray-100 rounded-3xl">
              {/* Every column has a width, adding up to the narrowest the table
                  goes (984px). On a wider screen the browser shares the extra
                  out in proportion, so the item name never hogs it. */}
              <table className="w-full min-w-[984px] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[176px]" />
                  <col className="w-[104px]" />
                  <col className="w-[96px]" />
                  <col className="w-[76px]" />
                  <col className="w-[96px]" />
                  <col className="w-[116px]" />
                  <col className="w-[96px]" />
                  <col className="w-[104px]" />
                  <col className="w-[120px]" />
                </colgroup>
                <thead className="bg-gray-50">
                  <tr className={TABLE_HEAD_ROW}>
                    <th className="pl-4 pr-2 py-3">Item</th>
                    <th className="px-2 py-3">HSN</th>
                    <th className="px-2 py-3">Metric</th>
                    <th className="px-2 py-3 text-right">Qty</th>
                    <th className="px-2 py-3 text-right">
                      Cost<span className={HEADER_NOTE}>before GST</span>
                    </th>
                    <th className="px-2 py-3">GST</th>
                    <th className="px-2 py-3 text-right">
                      Cost<span className={HEADER_NOTE}>after GST</span>
                    </th>
                    <th className="px-2 py-3 text-right">
                      Selling Price<span className={HEADER_NOTE}>incl. GST</span>
                    </th>
                    <th className="pl-2 pr-4 py-3 text-right">
                      Amount<span className={HEADER_NOTE}>incl. GST</span>
                    </th>
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
                    const isNew = isNewItemRow(row);
                    const selected = row.item_id ? items.find((item) => item.id === row.item_id) : undefined;
                    const saleItem = itemFor(row);
                    const belowCost = sellsBelowCost(row);
                    const unit = selected ? selected.metric : row.metric;
                    const knownUnit = UNIT_OPTIONS.some((option) => option.value === unit);
                    const showItemMenu =
                      activeItemRow === rowIndex && itemMenuStyle && (itemSuggestions.length > 0 || row.item_query.trim() !== '');

                    return (
                      <tr key={rowIndex} className={cn('align-top', isTrailingEmpty && 'bg-orange-50/30')}>
                        <td className="pl-4 pr-2 py-2.5">
                          <input
                            ref={(element) => {
                              if (element) itemInputRefs.current.set(rowIndex, element);
                              else itemInputRefs.current.delete(rowIndex);
                            }}
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
                                }
                                // No match: the row is a new item. Enter moves on
                                // to its HSN code and unit, in this same row.
                                advanceFocus(e.currentTarget);
                              }
                            }}
                            placeholder="Search or add item"
                            title={row.item_query}
                            className={ROW_FIELD}
                          />
                          {isNew && (
                            <p className="mt-1 truncate text-[11px] font-semibold text-orange-600" title="Added to the catalogue when this purchase is saved">
                              New item
                            </p>
                          )}
                          {selected && (
                            <p className="mt-1 truncate text-[11px] text-gray-400">
                              {selected.stock_quantity} {selected.metric} in stock
                            </p>
                          )}

                          {showItemMenu &&
                            createPortal(
                              <div
                                style={itemMenuStyle}
                                // Keep focus in the search box, so scrolling the
                                // list does not close it.
                                onMouseDown={(e) => e.preventDefault()}
                                className="z-50 overflow-y-auto bg-white border border-gray-200 rounded-2xl shadow-xl"
                              >
                                {itemSuggestions.length > 0 ? (
                                  itemSuggestions.map((item) => (
                                    <button
                                      key={item.id}
                                      type="button"
                                      onMouseDown={() => selectItem(rowIndex, item.id)}
                                      className="w-full px-4 py-2.5 text-left hover:bg-orange-50 transition-colors"
                                    >
                                      <p className="font-semibold text-gray-900">{item.name}</p>
                                      <p className="text-xs text-gray-500">
                                        HSN {getItemHsnCode(item) || 'Not set'} • {item.stock_quantity} {item.metric} in stock
                                        {item.price > 0 ? ` • selling at Rs. ${item.price.toFixed(2)}` : ''}
                                      </p>
                                    </button>
                                  ))
                                ) : (
                                  <p className="px-4 py-3 text-sm text-gray-600">
                                    Not in the catalogue. Fill in its HSN and unit in this row; it is created when the purchase is saved.
                                  </p>
                                )}
                              </div>,
                              document.body
                            )}
                        </td>

                        <td className="px-2 py-2.5">
                          {isNew ? (
                            <input
                              data-purchase-nav="true"
                              type="text"
                              value={row.hsn_code}
                              onChange={(e) => upsertRow(rowIndex, { hsn_code: e.target.value })}
                              onKeyDown={enterAdvances}
                              placeholder="HSN"
                              className={cn(ROW_FIELD, 'bg-white', !row.hsn_code.trim() && 'border-orange-300')}
                            />
                          ) : (
                            <div className={cn(ROW_FIELD, 'flex items-center text-gray-600')} title={getItemHsnCode(selected)}>
                              <span className="truncate">{getItemHsnCode(selected) || '-'}</span>
                            </div>
                          )}
                        </td>

                        <td className="px-2 py-2.5">
                          <select
                            data-purchase-nav="true"
                            value={unit}
                            disabled={!isNew}
                            onChange={(e) => upsertRow(rowIndex, { metric: e.target.value })}
                            onKeyDown={enterAdvances}
                            title={selected ? 'An existing item’s unit is changed in Items → Edit' : 'Unit this item is bought and sold in'}
                            className={cn(
                              ROW_FIELD,
                              'px-2 disabled:text-gray-600 disabled:cursor-not-allowed',
                              isNew && 'bg-white',
                              isNew && !row.metric && 'border-orange-300'
                            )}
                          >
                            <option value="" disabled>Unit</option>
                            {UNIT_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                            {/* An older item may use a unit no longer offered. */}
                            {unit && !knownUnit && <option value={unit}>{unit}</option>}
                          </select>
                        </td>

                        <td className="px-2 py-2.5">
                          <input
                            data-purchase-nav="true"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={row.quantity || ''}
                            onChange={(e) => upsertRow(rowIndex, { quantity: e.target.value === '' ? 0 : Number(e.target.value) })}
                            onKeyDown={enterAdvances}
                            className={cn(ROW_FIELD, 'text-right tabular-nums')}
                          />
                        </td>

                        <td className="px-2 py-2.5">{costInput(row, rowIndex, 'before_gst')}</td>

                        <td className="px-2 py-2.5">
                          <select
                            data-purchase-nav="true"
                            value={gstChoiceOf(row)}
                            onChange={(e) => {
                              const [mode, percent] = e.target.value.split(':');
                              upsertRow(rowIndex, { gst_mode: mode as GstMode, gst_percent: Number(percent) });
                            }}
                            onKeyDown={enterAdvances}
                            title="GST: CGST + SGST, from a supplier in this state. IGST: from another state."
                            className={cn(ROW_FIELD, 'px-2')}
                          >
                            {GST_CHOICES.map((choice) => (
                              <option key={choice.value} value={choice.value}>
                                {choice.label}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="px-2 py-2.5">{costInput(row, rowIndex, 'after_gst')}</td>

                        <td className="px-2 py-2.5">
                          <input
                            data-purchase-nav="true"
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={row.selling_price || ''}
                            onChange={(e) => upsertRow(rowIndex, { selling_price: e.target.value === '' ? 0 : Number(e.target.value) })}
                            onKeyDown={enterAdvances}
                            className={cn(
                              ROW_FIELD,
                              'text-right font-semibold tabular-nums',
                              belowCost
                                ? 'border-red-300 text-red-600'
                                : (row.item_id || isNew) && row.quantity > 0 && !(row.selling_price > 0) && 'border-orange-300'
                            )}
                          />
                          {belowCost ? (
                            <p className="mt-1 text-right text-[11px] font-semibold text-red-500">Below cost</p>
                          ) : (
                            saleItem && row.selling_price > 0 && (
                              <p className="mt-1 truncate text-right text-[11px] text-gray-400">
                                {saleGstRate(saleItem) > 0 ? `incl. ${saleGstRate(saleItem)}% GST` : 'no GST'}
                              </p>
                            )
                          )}
                        </td>

                        <td className="pl-2 pr-4 py-2.5 text-right tabular-nums">
                          {isTrailingEmpty ? (
                            <p className="h-9 leading-9 text-gray-300">-</p>
                          ) : (
                            <>
                              <p className="min-h-9 py-2 leading-5 break-words font-bold text-gray-900" title={`Rs. ${row.total_amount.toFixed(2)}`}>
                                Rs. {row.total_amount.toFixed(2)}
                              </p>
                              <p
                                className="text-[11px] break-words text-gray-400"
                                title={
                                  row.gst_mode === 'split'
                                    ? `CGST Rs. ${row.cgst_amount.toFixed(2)} + SGST Rs. ${row.sgst_amount.toFixed(2)}`
                                    : `IGST Rs. ${row.igst_amount.toFixed(2)}`
                                }
                              >
                                GST Rs. {(row.sgst_amount + row.cgst_amount + row.igst_amount).toFixed(2)}
                              </p>
                            </>
                          )}
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

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-bold text-gray-900">Payment</p>
                  <p className="text-xs text-gray-500">
                    {payment.mode === 'credit'
                      ? 'Nothing paid yet — the full amount goes to Purchase Credit.'
                      : payment.mode === 'full'
                        ? 'Paid in full now — goes straight to Payments Done.'
                        : `Rs. ${Math.max(0, round2(totals.total - (Number(payment.amount) || 0))).toFixed(2)} will be owed and go to Purchase Credit.`}
                  </p>
                </div>
                <div className="inline-flex rounded-2xl bg-white border border-gray-200 p-1">
                  {([['credit', 'On credit'], ['full', 'Paid in full'], ['part', 'Part paid']] as const).map(([mode, label]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setPayment((current) => ({ ...current, mode }))}
                      className={cn(
                        'px-4 py-2 rounded-xl text-sm font-bold transition-all',
                        payment.mode === mode ? 'bg-orange-600 text-white shadow' : 'text-gray-600 hover:bg-gray-50'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {payment.mode !== 'credit' && (
                <div className="grid gap-4 md:grid-cols-3">
                  {payment.mode === 'part' && (
                    <label className="space-y-2">
                      <span className="text-sm font-semibold text-gray-700">Paid now (Rs.)</span>
                      <input
                        type="number"
                        step="0.01"
                        min="0.01"
                        value={payment.amount}
                        onChange={(e) => setPayment((current) => ({ ...current, amount: e.target.value }))}
                        className="w-full px-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none font-bold tabular-nums"
                      />
                    </label>
                  )}
                  <label className="space-y-2">
                    <span className="text-sm font-semibold text-gray-700">
                      Method <span className="font-normal text-gray-400">(optional)</span>
                    </span>
                    <select
                      value={payment.method}
                      onChange={(e) => setPayment((current) => ({ ...current, method: e.target.value }))}
                      className="w-full px-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                    >
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
                      value={payment.reference}
                      onChange={(e) => setPayment((current) => ({ ...current, reference: e.target.value }))}
                      placeholder="UTR / cheque no."
                      className="w-full px-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                  </label>
                </div>
              )}
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
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Payment</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-400">Loading purchases...</td>
                </tr>
              ) : purchases.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-gray-400">No purchases recorded yet.</td>
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
                    <td className="px-6 py-4 text-right">
                      {(purchase.balance_due ?? 0) > 0 ? (
                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-amber-50 text-amber-700 whitespace-nowrap">
                          Due Rs. {(purchase.balance_due ?? 0).toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-xs font-bold px-2 py-1 rounded-full bg-emerald-50 text-emerald-700">Paid</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

    </div>
  );
};
