import { useEffect, useMemo, useState } from 'react';
import { Download, Search } from 'lucide-react';
import { api } from '../api';
import { Bill, Purchase } from '../types';
import { cn, formatDateInIST, formatDateTimeInIST, getISTTimestampForFileName } from '../lib/utils';
import { billCustomerContactName, billCustomerDisplayName } from '../lib/customer';
import { DateFilterButton, DateFilterPanel } from '../components/DateFilter';
import { SalesPurchaseSwitch, useTradeView } from '../components/SalesPurchaseSwitch';

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
  igst_rate: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
  /** Selling price set on the purchase (incl. GST); null for very old lines. */
  selling_price: number | null;
  /** Margin on cost before GST. Only in the download — not shown on screen. */
  profit_percent: number | null;
}

interface SalesReportRow {
  bill_id: number;
  bill_number: string;
  payment_method: string;
  created_at: string;
  customer_name?: string;
  customer_shop_name?: string | null;
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

  const blob = new Blob([`﻿${csvContent}`], { type: 'text/csv;charset=utf-8;' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(downloadUrl);
};

// Server-side caps. A report over a wide range can match millions of line
// items; rather than trying to ship them all, a bounded slice is taken and the
// page says plainly when the range is too wide.
const REPORT_LIMIT = 5000;
const LIST_LIMIT = 1000;

const rupees = (value: number) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const SummaryCard = ({ label, value, tone }: { label: string; value: string; tone?: 'orange' | 'amber' | 'red' }) => (
  <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-5">
    <p className="text-xs font-bold text-gray-500 uppercase">{label}</p>
    <p className={cn(
      'text-2xl xl:text-3xl font-black mt-2 tabular-nums',
      tone === 'orange' ? 'text-orange-600' : tone === 'amber' ? 'text-amber-600' : tone === 'red' ? 'text-red-600' : 'text-gray-900'
    )}>
      {value}
    </p>
  </div>
);

const headCell = 'px-6 py-4 text-xs font-bold text-gray-500 uppercase whitespace-nowrap';

/**
 * Sales or purchase records for a date range, one side at a time (the switch
 * at the top, kept in the address as ?view=purchases), each with its totals
 * and CSV download.
 */
export const Reports = () => {
  const [view, setView] = useTradeView(true);
  const [bills, setBills] = useState<Bill[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchaseRows, setPurchaseRows] = useState<PurchaseReportRow[]>([]);
  const [salesRows, setSalesRows] = useState<SalesReportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [truncated, setTruncated] = useState(false);

  // The date range is sent to the server so it filters in SQL. Only the side
  // on screen is loaded.
  useEffect(() => {
    let current = true;
    const range = { from: startDate || undefined, to: endDate || undefined };
    setLoading(true);
    const load = view === 'sales'
      ? Promise.all([
          api.getBills({ ...range, limit: LIST_LIMIT }),
          api.getSalesItemReport({ ...range, limit: REPORT_LIMIT }),
        ]).then(([billData, rows]) => {
          if (!current) return;
          setBills(billData);
          setSalesRows(rows);
          setTruncated(billData.length >= LIST_LIMIT || rows.length >= REPORT_LIMIT);
        })
      : Promise.all([
          api.getPurchases({ ...range, limit: LIST_LIMIT }),
          api.getPurchaseItemReport({ ...range, limit: REPORT_LIMIT }),
        ]).then(([purchaseData, rows]) => {
          if (!current) return;
          setPurchases(purchaseData);
          setPurchaseRows(rows);
          setTruncated(purchaseData.length >= LIST_LIMIT || rows.length >= REPORT_LIMIT);
        });
    load
      .catch((err) => {
        console.error('Failed to load reports:', err);
        if (current) alert(`Failed to load reports: ${err.message}`);
      })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [view, startDate, endDate]);

  const normalizedSearch = search.trim().toLowerCase();
  const matches = (...fields: Array<string | null | undefined>) =>
    normalizedSearch.length === 0 || fields.some((field) => (field || '').toLowerCase().includes(normalizedSearch));

  const filteredBills = useMemo(
    () => bills.filter((bill) => matches(bill.bill_number, bill.customer_shop_name, bill.customer_name, bill.cashier_name)),
    [bills, normalizedSearch]
  );
  const filteredSalesRows = useMemo(
    () => salesRows.filter((row) => matches(row.bill_number, row.customer_shop_name, row.customer_name, row.cashier_name, row.item_name, row.hsn_code)),
    [salesRows, normalizedSearch]
  );
  const filteredPurchases = useMemo(
    () => purchases.filter((purchase) => matches(purchase.purchase_number, purchase.supplier_name, purchase.invoice_number, purchase.supplier_gstin)),
    [purchases, normalizedSearch]
  );
  const filteredPurchaseRows = useMemo(
    () => purchaseRows.filter((row) => matches(row.purchase_number, row.supplier_name, row.item_name, row.hsn_code, row.invoice_number, row.supplier_gstin)),
    [purchaseRows, normalizedSearch]
  );

  const sum = <T,>(rows: T[], pick: (row: T) => number) => rows.reduce((total, row) => total + (pick(row) || 0), 0);

  const exportSales = () => {
    if (filteredSalesRows.length === 0) {
      alert('No sales records available for the current filter.');
      return;
    }

    downloadCsv(
      `sales-report-${getISTTimestampForFileName()}.csv`,
      ['Bill Number', 'Date & Time', 'Customer', 'Contact Person', 'Cashier', 'Payment Method', 'Item', 'HSN', 'Quantity', 'Metric', 'Base Price', 'SGST Amount', 'Other GST Amount', 'Line Total'],
      filteredSalesRows.map((row) => [
        row.bill_number,
        formatDateTimeInIST(row.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        billCustomerDisplayName(row),
        billCustomerContactName(row) || '',
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
      // IGST columns were missing, so an inter-state purchase downloaded as if
      // it carried no tax. Selling price and profit % are recorded on each
      // purchase line and appear only here, not on screen.
      ['Purchase Number', 'Date & Time', 'Supplier', 'Supplier GSTIN', 'Invoice Number', 'Invoice Date', 'Created By', 'Item', 'HSN', 'Quantity', 'Metric', 'Unit Cost (before GST)', 'SGST %', 'CGST %', 'IGST %', 'SGST Amount', 'CGST Amount', 'IGST Amount', 'Line Total', 'Selling Price (incl. GST)', 'Profit %'],
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
        (row.igst_rate ?? 0).toFixed(2),
        row.sgst_amount.toFixed(2),
        row.cgst_amount.toFixed(2),
        (row.igst_amount ?? 0).toFixed(2),
        row.total_amount.toFixed(2),
        row.selling_price == null ? '' : row.selling_price.toFixed(2),
        row.profit_percent == null ? '' : row.profit_percent.toFixed(2),
      ])
    );
  };

  const isSales = view === 'sales';
  const rowCount = isSales ? filteredSalesRows.length : filteredPurchaseRows.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <SalesPurchaseSwitch value={view} onChange={setView} id="reports" />
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-80">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isSales ? 'Search bill, customer, cashier, item, HSN...' : 'Search supplier, GSTIN, invoice, item, HSN...'}
              className="w-full pl-11 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
            />
          </div>
          <DateFilterButton from={startDate} to={endDate} open={showDateFilter} onClick={() => setShowDateFilter((open) => !open)} />
        </div>
      </div>

      {showDateFilter && (
        <DateFilterPanel
          from={startDate}
          to={endDate}
          onFromChange={setStartDate}
          onToChange={setEndDate}
          description="Totals, the table and the CSV download all follow this range."
        />
      )}

      {truncated && (
        <div className="rounded-2xl border border-orange-200 bg-orange-50 px-6 py-4 text-sm font-semibold text-orange-700">
          This date range matches more rows than can be shown at once. Figures below cover only the first{' '}
          {REPORT_LIMIT.toLocaleString('en-IN')} line items &mdash; narrow the date range for a complete report.
        </div>
      )}

      <div className="grid gap-4 grid-cols-2 xl:grid-cols-4">
        {isSales ? (
          <>
            <SummaryCard label="Sales total" value={rupees(sum(filteredBills, (b) => b.total_amount))} />
            <SummaryCard label="GST collected" value={rupees(sum(filteredBills, (b) => b.tax_amount))} tone="orange" />
            <SummaryCard label="Taxable value" value={rupees(sum(filteredBills, (b) => b.subtotal_amount ?? b.total_amount - b.tax_amount))} />
            <SummaryCard label="Bills" value={filteredBills.length.toLocaleString('en-IN')} />
          </>
        ) : (
          <>
            <SummaryCard label="Purchase total" value={rupees(sum(filteredPurchases, (p) => p.total_amount))} />
            <SummaryCard label="GST paid" value={rupees(sum(filteredPurchases, (p) => p.tax_amount))} tone="amber" />
            <SummaryCard label="Still owed" value={rupees(sum(filteredPurchases, (p) => p.balance_due ?? 0))} tone="red" />
            <SummaryCard label="Purchases" value={filteredPurchases.length.toLocaleString('en-IN')} />
          </>
        )}
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-100 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900">{isSales ? 'Sales' : 'Purchases'}, item by item</h2>
            <p className="text-sm text-gray-500">
              {isSales
                ? 'Every line of every bill, for stock and GST review.'
                : 'Every purchase line with supplier, invoice, cost and GST.'}
              {!loading && ` ${rowCount.toLocaleString('en-IN')} lines.`}
            </p>
          </div>
          <button
            onClick={isSales ? exportSales : exportPurchases}
            className="inline-flex items-center gap-2 px-4 py-3 rounded-2xl bg-white border border-gray-200 text-gray-700 font-semibold hover:bg-gray-50 transition-all"
          >
            <Download size={18} />
            Export {isSales ? 'Sales' : 'Purchase'} CSV
          </button>
        </div>

        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Report table">
          {isSales ? (
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  <th className={headCell}>Bill No.</th>
                  <th className={headCell}>Date & Time</th>
                  <th className={headCell}>Customer</th>
                  <th className={headCell}>Cashier</th>
                  <th className={headCell}>Method</th>
                  <th className={headCell}>Item</th>
                  <th className={cn(headCell, 'text-right')}>Qty</th>
                  <th className={cn(headCell, 'text-right')}>Base Price</th>
                  <th className={cn(headCell, 'text-right')}>GST</th>
                  <th className={cn(headCell, 'text-right')}>Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={10} className="px-6 py-12 text-center text-gray-400">Loading report data...</td></tr>
                ) : filteredSalesRows.length === 0 ? (
                  <tr><td colSpan={10} className="px-6 py-12 text-center text-gray-400">No sales records found.</td></tr>
                ) : (
                  filteredSalesRows.map((row, index) => (
                    <tr key={`${row.bill_id}-${row.item_id}-${index}`} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 font-mono font-bold text-gray-900">{row.bill_number}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 whitespace-nowrap">{formatDateTimeInIST(row.created_at)}</td>
                      <td className="px-6 py-4 text-sm text-gray-700">{billCustomerDisplayName(row)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{row.cashier_name}</td>
                      <td className="px-6 py-4 text-sm uppercase text-gray-600">{row.payment_method}</td>
                      <td className="px-6 py-4">
                        <p className="font-semibold text-gray-900">{row.item_name}</p>
                        <p className="text-xs text-gray-500">HSN: {row.hsn_code || 'Not set'}</p>
                      </td>
                      <td className="px-6 py-4 text-right text-sm text-gray-700 whitespace-nowrap">{row.quantity} {row.metric}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-700">{rupees(row.price)}</td>
                      <td className="px-6 py-4 text-right font-semibold text-orange-600">{rupees(row.sgst_amount + row.cgst_amount + (row.igst_amount || 0))}</td>
                      <td className="px-6 py-4 text-right font-bold text-gray-900">{rupees(row.total_amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-gray-50">
                <tr>
                  <th className={headCell}>Purchase No.</th>
                  <th className={headCell}>Date & Time</th>
                  <th className={headCell}>Supplier</th>
                  <th className={headCell}>GSTIN</th>
                  <th className={headCell}>Invoice</th>
                  <th className={headCell}>Item</th>
                  <th className={cn(headCell, 'text-right')}>Qty</th>
                  <th className={cn(headCell, 'text-right')}>Unit Cost</th>
                  <th className={headCell}>Created By</th>
                  <th className={cn(headCell, 'text-right')}>GST</th>
                  <th className={cn(headCell, 'text-right')}>Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr><td colSpan={11} className="px-6 py-12 text-center text-gray-400">Loading report data...</td></tr>
                ) : filteredPurchaseRows.length === 0 ? (
                  <tr><td colSpan={11} className="px-6 py-12 text-center text-gray-400">No purchase records found.</td></tr>
                ) : (
                  filteredPurchaseRows.map((row, index) => (
                    <tr key={`${row.purchase_id}-${row.item_id}-${index}`} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 font-mono font-bold text-gray-900">{row.purchase_number}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 whitespace-nowrap">{formatDateTimeInIST(row.created_at)}</td>
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
                      <td className="px-6 py-4 text-right text-sm text-gray-700 whitespace-nowrap">{row.quantity} {row.metric}</td>
                      <td className="px-6 py-4 text-right text-sm text-gray-700">{rupees(row.unit_cost)}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{row.user_name}</td>
                      {/* IGST included: an inter-state purchase used to show no GST here. */}
                      <td className="px-6 py-4 text-right font-semibold text-amber-600">{rupees(row.sgst_amount + row.cgst_amount + (row.igst_amount || 0))}</td>
                      <td className="px-6 py-4 text-right font-bold text-gray-900">{rupees(row.total_amount)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
