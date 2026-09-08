import React, { useEffect, useMemo, useState } from 'react';
import { Download, FileSpreadsheet, Search } from 'lucide-react';
import { api } from '../api';
import { Bill, Purchase } from '../types';
import { formatDateInIST, formatDateTimeInIST, getISTDateKey, getISTTimestampForFileName } from '../lib/utils';

interface PurchaseReportRow {
  purchase_id: number;
  purchase_number: string;
  supplier_name: string;
  supplier_phone?: string;
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
  sgst_amount: number;
  cgst_amount: number;
  total_amount: number;
}

interface SalesReportRow {
  bill_id: number;
  bill_number: string;
  payment_method: string;
  created_at: string;
  customer_name?: string;
  customer_phone?: string;
  cashier_name: string;
  item_id: number;
  item_name: string;
  hsn_code?: string;
  metric: string;
  quantity: number;
  price: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount?: number;
  total_amount: number;
}

const escapeCsvValue = (value: string | number | null | undefined) => {
  const safeValue = value == null ? '' : String(value);
  return `"${safeValue.replace(/"/g, '""')}"`;
};

const downloadCsv = (fileName: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) => {
  const csvContent = [
    headers.map(escapeCsvValue).join(','),
    ...rows.map((row) => row.map(escapeCsvValue).join(',')),
  ].join('\n');

  const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(downloadUrl);
};

export const Reports = () => {
  const [bills, setBills] = useState<Bill[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseReportRow[]>([]);
  const [salesRows, setSalesRows] = useState<SalesReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // The date range is sent to the server so it filters in SQL. Loading every
  // bill and line item and filtering in the browser stops working long before
  // a year's worth of transactions accumulates.
  useEffect(() => {
    const range = { from: startDate || undefined, to: endDate || undefined };
    setLoading(true);
    Promise.all([
      api.getBills({ ...range, limit: 1000 }),
      api.getPurchases({ limit: 1000 }),
      api.getPurchaseItemReport(range),
      api.getSalesItemReport(range),
    ])
      .then(([billData, purchaseData, purchaseItemData, salesItemData]) => {
        setBills(billData);
        setPurchases(purchaseData);
        setPurchaseRows(purchaseItemData);
        setSalesRows(salesItemData);
      })
      .catch((err) => {
        console.error('Failed to load reports:', err);
        alert(`Failed to load reports: ${err.message}`);
      })
      .finally(() => setLoading(false));
  }, [startDate, endDate]);

  const normalizedSearch = search.trim().toLowerCase();

  const dateMatches = (value: string) => {
    const dateKey = getISTDateKey(value);
    if (startDate && dateKey < startDate) return false;
    if (endDate && dateKey > endDate) return false;
    return true;
  };

  const filteredBills = useMemo(() => {
    return bills.filter((bill) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        bill.bill_number.toLowerCase().includes(normalizedSearch) ||
        (bill.customer_name || '').toLowerCase().includes(normalizedSearch) ||
        bill.cashier_name.toLowerCase().includes(normalizedSearch);

      return matchesSearch && dateMatches(bill.created_at);
    });
  }, [bills, normalizedSearch, startDate, endDate]);

  const filteredPurchases = useMemo(() => {
    return purchases.filter((purchase) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        purchase.purchase_number.toLowerCase().includes(normalizedSearch) ||
        purchase.supplier_name.toLowerCase().includes(normalizedSearch) ||
        (purchase.invoice_number || '').toLowerCase().includes(normalizedSearch) ||
        (purchase.supplier_gstin || '').toLowerCase().includes(normalizedSearch);

      return matchesSearch && dateMatches(purchase.created_at);
    });
  }, [purchases, normalizedSearch, startDate, endDate]);

  const filteredPurchaseRows = useMemo(() => {
    return purchaseRows.filter((row) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        row.purchase_number.toLowerCase().includes(normalizedSearch) ||
        row.supplier_name.toLowerCase().includes(normalizedSearch) ||
        row.item_name.toLowerCase().includes(normalizedSearch) ||
        (row.hsn_code || '').toLowerCase().includes(normalizedSearch) ||
        (row.invoice_number || '').toLowerCase().includes(normalizedSearch) ||
        (row.supplier_gstin || '').toLowerCase().includes(normalizedSearch);

      return matchesSearch && dateMatches(row.created_at);
    });
  }, [purchaseRows, normalizedSearch, startDate, endDate]);

  const filteredSalesRows = useMemo(() => {
    return salesRows.filter((row) => {
      const matchesSearch =
        normalizedSearch.length === 0 ||
        row.bill_number.toLowerCase().includes(normalizedSearch) ||
        (row.customer_name || '').toLowerCase().includes(normalizedSearch) ||
        row.cashier_name.toLowerCase().includes(normalizedSearch) ||
        row.item_name.toLowerCase().includes(normalizedSearch) ||
        (row.hsn_code || '').toLowerCase().includes(normalizedSearch);

      return matchesSearch && dateMatches(row.created_at);
    });
  }, [salesRows, normalizedSearch, startDate, endDate]);

  const salesTotal = filteredBills.reduce((sum, bill) => sum + bill.total_amount, 0);
  const salesTax = filteredBills.reduce((sum, bill) => sum + bill.tax_amount, 0);
  const purchaseTotal = filteredPurchases.reduce((sum, purchase) => sum + purchase.total_amount, 0);
  const purchaseTax = filteredPurchases.reduce((sum, purchase) => sum + purchase.tax_amount, 0);

  const exportSales = () => {
    if (filteredSalesRows.length === 0) {
      alert('No sales records available for the current filter.');
      return;
    }

    downloadCsv(
      `sales-report-${getISTTimestampForFileName()}.csv`,
      ['Bill Number', 'Date & Time', 'Customer', 'Cashier', 'Payment Method', 'Item', 'HSN', 'Quantity', 'Metric', 'Base Price', 'SGST Amount', 'Other GST Amount', 'Line Total'],
      filteredSalesRows.map((row) => [
        row.bill_number,
        formatDateTimeInIST(row.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        row.customer_name || 'Walk-in',
        row.cashier_name,
        row.payment_method,
        row.item_name,
        row.hsn_code || '',
        row.quantity,
        row.metric,
        row.price.toFixed(2),
        row.sgst_amount.toFixed(2),
        (row.cgst_amount + (row.igst_amount || 0)).toFixed(2),
        row.total_amount.toFixed(2),
      ])
    );
  };

  const exportPurchases = () => {
    if (filteredPurchaseRows.length === 0) {
      alert('No purchase records available for the current filter.');
      return;
    }

    downloadCsv(
      `purchase-report-${getISTTimestampForFileName()}.csv`,
      ['Purchase Number', 'Date & Time', 'Supplier', 'Supplier GSTIN', 'Invoice Number', 'Invoice Date', 'Created By', 'Item', 'HSN', 'Quantity', 'Metric', 'Unit Cost', 'SGST %', 'CGST %', 'SGST Amount', 'CGST Amount', 'Line Total'],
      filteredPurchaseRows.map((row) => [
        row.purchase_number,
        formatDateTimeInIST(row.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        row.supplier_name,
        row.supplier_gstin || '',
        row.invoice_number || '',
        row.invoice_date ? formatDateInIST(row.invoice_date, { month: '2-digit', day: '2-digit', year: 'numeric' }) : '',
        row.user_name,
        row.item_name,
        row.hsn_code || '',
        row.quantity,
        row.metric,
        row.unit_cost.toFixed(2),
        row.sgst_rate.toFixed(2),
        row.cgst_rate.toFixed(2),
        row.sgst_amount.toFixed(2),
        row.cgst_amount.toFixed(2),
        row.total_amount.toFixed(2),
      ])
    );
  };

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-start gap-4">
          <div className="w-14 h-14 rounded-2xl bg-orange-100 text-orange-600 flex items-center justify-center">
            <FileSpreadsheet size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sales & Purchase Reports</h1>
            <p className="text-sm text-gray-500 mt-1">
              Review GST-relevant purchase and sales records together and export each dataset to CSV.
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr),180px,180px] mt-6">
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search supplier, GSTIN, HSN, bill number, customer..."
              className="w-full pl-11 pr-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
            />
          </div>
          <input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
          />
          <input
            type="date"
            value={endDate}
            min={startDate || undefined}
            onChange={(e) => setEndDate(e.target.value)}
            className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs font-bold text-gray-500 uppercase">Sales Total</p>
          <p className="text-3xl font-black text-gray-900 mt-2">Rs. {salesTotal.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs font-bold text-gray-500 uppercase">Sales GST</p>
          <p className="text-3xl font-black text-orange-600 mt-2">Rs. {salesTax.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs font-bold text-gray-500 uppercase">Purchase Total</p>
          <p className="text-3xl font-black text-gray-900 mt-2">Rs. {purchaseTotal.toFixed(2)}</p>
        </div>
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5">
          <p className="text-xs font-bold text-gray-500 uppercase">Purchase GST</p>
          <p className="text-3xl font-black text-amber-600 mt-2">Rs. {purchaseTax.toFixed(2)}</p>
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Purchase Data</h2>
            <p className="text-sm text-gray-500">Item-wise purchase records with supplier, invoice, cost, quantity, and GST values.</p>
          </div>
          <button
            onClick={exportPurchases}
            className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-semibold hover:bg-gray-50 transition-all"
          >
            <Download size={18} />
            Export Purchase CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Purchase No.</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Date & Time</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Supplier</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">GSTIN</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Invoice</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Item</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Qty</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Unit Cost</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Created By</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">GST</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={11} className="px-6 py-12 text-center text-gray-400">Loading report data...</td>
                </tr>
              ) : filteredPurchaseRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-6 py-12 text-center text-gray-400">No purchase records found.</td>
                </tr>
              ) : (
                filteredPurchaseRows.map((row, index) => (
                  <tr key={`${row.purchase_id}-${row.item_id}-${index}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-mono font-bold text-gray-900">{row.purchase_number}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{formatDateTimeInIST(row.created_at)}</td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-gray-900">{row.supplier_name}</p>
                      <p className="text-xs text-gray-500">{row.supplier_phone || 'No phone'}</p>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600">{row.supplier_gstin || 'N/A'}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">
                      {row.invoice_number || 'N/A'}
                      {row.invoice_date ? ` • ${formatDateInIST(row.invoice_date)}` : ''}
                    </td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-gray-900">{row.item_name}</p>
                      <p className="text-xs text-gray-500">HSN: {row.hsn_code || 'Not set'}</p>
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-gray-700">{row.quantity} {row.metric}</td>
                    <td className="px-6 py-4 text-right text-sm text-gray-700">Rs. {row.unit_cost.toFixed(2)}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{row.user_name}</td>
                    <td className="px-6 py-4 text-right font-semibold text-amber-600">Rs. {(row.sgst_amount + row.cgst_amount).toFixed(2)}</td>
                    <td className="px-6 py-4 text-right font-bold text-gray-900">Rs. {row.total_amount.toFixed(2)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">Sales Data</h2>
            <p className="text-sm text-gray-500">Item-wise sales rows derived from each bill for stock and GST review.</p>
          </div>
          <button
            onClick={exportSales}
            className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-semibold hover:bg-gray-50 transition-all"
          >
            <Download size={18} />
            Export Sales CSV
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Bill No.</th>
                <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Date & Time</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Customer</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Cashier</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Method</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase">Item</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Qty</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Base Price</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">GST</th>
                  <th className="px-6 py-4 text-xs font-bold text-gray-500 uppercase text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
              {loading ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-gray-400">Loading report data...</td>
                </tr>
              ) : filteredSalesRows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-6 py-12 text-center text-gray-400">No sales records found.</td>
                </tr>
              ) : (
                filteredSalesRows.map((row, index) => (
                  <tr key={`${row.bill_id}-${row.item_id}-${index}`} className="hover:bg-gray-50 transition-colors">
                    <td className="px-6 py-4 font-mono font-bold text-gray-900">{row.bill_number}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{formatDateTimeInIST(row.created_at)}</td>
                    <td className="px-6 py-4 text-sm text-gray-700">{row.customer_name || 'Walk-in'}</td>
                    <td className="px-6 py-4 text-sm text-gray-600">{row.cashier_name}</td>
                    <td className="px-6 py-4 text-sm uppercase text-gray-600">{row.payment_method}</td>
                    <td className="px-6 py-4">
                      <p className="font-semibold text-gray-900">{row.item_name}</p>
                      <p className="text-xs text-gray-500">HSN: {row.hsn_code || 'Not set'}</p>
                    </td>
                    <td className="px-6 py-4 text-right text-sm text-gray-700">{row.quantity} {row.metric}</td>
                    <td className="px-6 py-4 text-right text-sm text-gray-700">Rs. {row.price.toFixed(2)}</td>
                    <td className="px-6 py-4 text-right font-semibold text-orange-600">Rs. {(row.sgst_amount + row.cgst_amount + (row.igst_amount || 0)).toFixed(2)}</td>
                    <td className="px-6 py-4 text-right font-bold text-gray-900">Rs. {row.total_amount.toFixed(2)}</td>
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
