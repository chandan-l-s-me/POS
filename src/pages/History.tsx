import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { Bill } from '../types';
import { useDataStore } from '../store/useDataStore';
import { 
  Search, 
  Calendar, 
  Printer, 
  ChevronRight, 
  Download,
  Filter,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
// Not useReactToPrint directly: printing must not drop the till out of full screen.
import { usePrint } from '../hooks/usePrint';
import { Receipt } from '../components/Receipt';
import { cn, formatDateTimeInIST, getISTTimestampForFileName } from '../lib/utils';
import { billCustomerContactName, billCustomerDisplayName } from '../lib/customer';

// Cap on how many bills one screen loads. Narrow the date range to look
// further back rather than raising this.
const HISTORY_PAGE_SIZE = 50;

/**
 * The bill's taxable value, as stored when the sale was rung up.
 *
 * This panel used to compute `total - tax + discount`. The stored total is
 * floored to whole rupees, so that folds the dropped paise into the subtotal
 * and the figure shown here disagreed with the one printed on the invoice
 * beside it. Older bills, written before the column existed, fall back to the
 * line items.
 */
const subtotalOf = (bill: Bill) => {
  if (typeof bill.subtotal_amount === 'number' && bill.subtotal_amount > 0) return bill.subtotal_amount;
  const fromLines = (bill.items || []).reduce(
    (acc, item) => acc + item.total_amount - item.sgst_amount - item.cgst_amount - (item.igst_amount || 0),
    0
  );
  return Math.round((fromLines + Number.EPSILON) * 100) / 100;
};

export const History = () => {
  const settings = useDataStore((state) => state.settings);
  const [bills, setBills] = useState<Bill[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  // Debounced copy of `search`, so typing doesn't fire a query per keystroke.
  const [appliedSearch, setAppliedSearch] = useState('');
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [showBillModal, setShowBillModal] = useState(false);

  const receiptRef = useRef<HTMLDivElement>(null);
  const handlePrint = usePrint({
    contentRef: receiptRef,
  });

  const onPrintClick = () => {
    if (!receiptRef.current) return;
    handlePrint();
  };

  useEffect(() => {
    const handle = setTimeout(() => {
      setAppliedSearch(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Any change to the filters starts again from page one.
  useEffect(() => { setPage(0); }, [startDate, endDate]);

  // Search, date filtering and paging all happen in SQL. Previously the page
  // fetched the 500 most recent bills and filtered them in the browser, so an
  // older bill simply could not be found — and there was no way to page past
  // those 500 at all.
  useEffect(() => {
    setLoading(true);
    api.getBillsPage({
      from: startDate || undefined,
      to: endDate || undefined,
      search: appliedSearch || undefined,
      limit: HISTORY_PAGE_SIZE,
      offset: page * HISTORY_PAGE_SIZE,
    })
      .then((res) => {
        setBills(res?.data ?? []);
        setTotal(res?.total ?? 0);
      })
      .catch(err => {
        console.error('Failed to fetch bills:', err);
        alert('Failed to fetch history: ' + err.message);
      })
      .finally(() => setLoading(false));
  }, [startDate, endDate, appliedSearch, page]);

  const pageCount = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));

  // The server has already applied the search and date range, so this page's
  // rows are exactly what should be shown.
  const filteredBills = bills;

  const escapeCsvValue = (value: string | number | null | undefined) => {
    const safeValue = value == null ? '' : String(value);
    return `"${safeValue.replace(/"/g, '""')}"`;
  };

  // Export the whole filtered result, not just the page on screen. Pulled in
  // server pages and capped, so exporting a multi-year range can't try to
  // materialise a million rows in the browser.
  const EXPORT_ROW_CAP = 20000;
  const EXPORT_CHUNK = 1000;
  const [exporting, setExporting] = useState(false);

  const handleExportCsv = async () => {
    if (total === 0) {
      alert('No bills available to export for the current filter.');
      return;
    }

    setExporting(true);
    let exportRows: Bill[] = [];
    try {
      for (let offset = 0; offset < Math.min(total, EXPORT_ROW_CAP); offset += EXPORT_CHUNK) {
        const res = await api.getBillsPage({
          from: startDate || undefined,
          to: endDate || undefined,
          search: appliedSearch || undefined,
          limit: EXPORT_CHUNK,
          offset,
        });
        const batch: Bill[] = res?.data ?? [];
        exportRows = exportRows.concat(batch);
        if (batch.length < EXPORT_CHUNK) break;
      }
    } catch (err: any) {
      alert(`Export failed: ${err.message}`);
      setExporting(false);
      return;
    }
    setExporting(false);

    if (total > EXPORT_ROW_CAP) {
      alert(`This filter matches ${total.toLocaleString('en-IN')} bills. Exporting the first ${EXPORT_ROW_CAP.toLocaleString('en-IN')} — narrow the date range to export the rest.`);
    }

    const headers = [
      'Bill Number',
      'Date',
      'Customer',
      'Contact Person',
      'Cashier',
      'Payment Method',
      'Tax Amount',
      'Discount Amount',
      'Total Amount',
    ];

    const rows = exportRows.map((bill) => [
      bill.bill_number,
      formatDateTimeInIST(bill.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      billCustomerDisplayName(bill),
      billCustomerContactName(bill) || '',
      bill.cashier_name,
      bill.payment_method,
      bill.tax_amount.toFixed(2),
      bill.discount_amount.toFixed(2),
      bill.total_amount.toFixed(2),
    ]);

    const csvContent = [
      headers.map(escapeCsvValue).join(','),
      ...rows.map((row) => row.map(escapeCsvValue).join(',')),
    ].join('\n');

    const blob = new Blob([`\uFEFF${csvContent}`], { type: 'text/csv;charset=utf-8;' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = `bill-history-${getISTTimestampForFileName()}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(downloadUrl);
  };

  const clearDateFilter = () => {
    setStartDate('');
    setEndDate('');
  };

  const hasDateFilter = Boolean(startDate || endDate);

  const handleViewBill = async (id: number) => {
    try {
      const bill = await api.getBill(id);
      setSelectedBill(bill);
      setShowBillModal(true);
    } catch (err: any) {
      alert(err.message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="relative w-96">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by bill number, bakery / shop, or customer..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowDateFilter((current) => !current)}
            className={cn(
              "flex items-center gap-2 px-4 py-3 bg-white border text-gray-600 font-bold rounded-2xl transition-all",
              hasDateFilter
                ? "border-orange-300 text-orange-700 bg-orange-50"
                : "border-gray-200 hover:bg-gray-50"
            )}
          >
            <Calendar size={20} />
            {hasDateFilter ? 'Date Filter Applied' : 'Filter by Date'}
          </button>
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            <Download size={20} />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {showDateFilter && (
        <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div>
              <h2 className="text-lg font-bold text-gray-900">Filter By Date</h2>
              <p className="text-sm text-gray-500">Bills and CSV export will follow this selected date range.</p>
            </div>
            {hasDateFilter && (
              <button
                type="button"
                onClick={clearDateFilter}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-gray-100 text-gray-700 font-semibold hover:bg-gray-200 transition-all"
              >
                <X size={16} />
                Clear Filter
              </button>
            )}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">From Date</span>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-gray-700">To Date</span>
              <input
                type="date"
                value={endDate}
                min={startDate || undefined}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
              />
            </label>
          </div>
        </div>
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Bill Number</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Date & Time</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Customer</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Cashier</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Method</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Amount</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-8 py-12 text-center text-gray-400">Loading history...</td>
              </tr>
            ) : filteredBills.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-8 py-12 text-center text-gray-400">No bills found</td>
              </tr>
            ) : (
              filteredBills.map(bill => (
                <tr key={bill.id} className="hover:bg-gray-50 transition-colors group">
                  <td className="px-8 py-4">
                    <span className="font-mono font-bold text-gray-900">{bill.bill_number}</span>
                  </td>
                  <td className="px-8 py-4 text-sm text-gray-500">
                    {formatDateTimeInIST(bill.created_at)}
                  </td>
                  <td className="px-8 py-4">
                    <p className="font-bold text-gray-900">{billCustomerDisplayName(bill)}</p>
                    {billCustomerContactName(bill) && (
                      <p className="text-xs text-gray-500">{billCustomerContactName(bill)}</p>
                    )}
                  </td>
                  <td className="px-8 py-4 text-sm text-gray-500">{bill.cashier_name}</td>
                  <td className="px-8 py-4">
                    <span className="text-[10px] font-black uppercase px-2 py-1 bg-gray-100 rounded-full text-gray-600">
                      {bill.payment_method}
                    </span>
                  </td>
                  <td className="px-8 py-4">
                    <span className="font-black text-gray-900">₹{bill.total_amount.toFixed(2)}</span>
                  </td>
                  <td className="px-8 py-4 text-right">
                    <button 
                      onClick={() => handleViewBill(bill.id)}
                      className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-xl transition-all"
                    >
                      <ChevronRight size={20} />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Paging controls. `total` comes from a COUNT in the same query, so
            the range shown is the true position in the full history, not just
            within a locally-cached slice. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-8 py-4">
          <p className="text-sm text-gray-500">
            {total === 0
              ? 'No bills match this filter'
              : `Showing ${page * HISTORY_PAGE_SIZE + 1}\u2013${Math.min((page + 1) * HISTORY_PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              Page {page + 1} of {pageCount.toLocaleString('en-IN')}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* Bill Detail Modal */}
      <AnimatePresence>
        {showBillModal && selectedBill && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className={cn(
                "bg-white w-full rounded-3xl shadow-2xl overflow-hidden h-[80vh]",
                settings.bill_format === 'standard'
                  ? "max-w-6xl flex flex-col"
                  : "max-w-5xl flex"
              )}
            >
              <div className="flex-1 p-8 overflow-auto">
                <div className="flex items-center justify-between mb-8">
                  <h3 className="font-bold text-2xl">Bill Details</h3>
                  <button onClick={() => setShowBillModal(false)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>

                <div className="grid grid-cols-3 gap-8 mb-8">
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Bill Info</p>
                    <p className="font-bold text-lg">{selectedBill.bill_number}</p>
                    <p className="text-sm text-gray-500">{formatDateTimeInIST(selectedBill.created_at)}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Customer</p>
                    <p className="font-bold text-lg">{billCustomerDisplayName(selectedBill)}</p>
                    {billCustomerContactName(selectedBill) && (
                      <p className="text-sm text-gray-500">{billCustomerContactName(selectedBill)}</p>
                    )}
                    <p className="text-sm text-gray-500">{selectedBill.customer_phone || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">Payment</p>
                    <p className="font-bold text-lg capitalize">{selectedBill.payment_method}</p>
                    {selectedBill.payment_method === 'split' && (
                      <div className="text-[10px] text-gray-500 space-y-0.5">
                        {selectedBill.cash_amount > 0 && <p>Cash: ₹{selectedBill.cash_amount.toFixed(2)}</p>}
                        {selectedBill.upi_amount > 0 && <p>UPI: ₹{selectedBill.upi_amount.toFixed(2)}</p>}
                        {selectedBill.credit_amount > 0 && <p>Credit: ₹{selectedBill.credit_amount.toFixed(2)}</p>}
                      </div>
                    )}
                    <p className="text-sm text-gray-500">Cashier: {selectedBill.cashier_name}</p>
                  </div>
                </div>

                <table className="w-full text-left mb-8">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="py-3 text-xs font-bold text-gray-400 uppercase">Item</th>
                      <th className="py-3 text-xs font-bold text-gray-400 uppercase text-center">Qty</th>
                      <th className="py-3 text-xs font-bold text-gray-400 uppercase text-right">Price</th>
                      <th className="py-3 text-xs font-bold text-gray-400 uppercase text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {selectedBill.items?.map(item => (
                      <tr key={item.id}>
                        <td className="py-4">
                          <p className="font-bold text-gray-900">{item.item_name}</p>
                          <p className="text-xs text-gray-400">HSN: {item.hsn_code}</p>
                        </td>
                        <td className="py-4 text-center font-semibold">{item.quantity} {item.metric}</td>
                        <td className="py-4 text-right">₹{item.price.toFixed(2)}</td>
                        <td className="py-4 text-right font-bold">₹{item.total_amount.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <div className="flex justify-end">
                  <div className="w-64 space-y-3">
                    <div className="flex justify-between text-gray-500">
                      <span>Subtotal</span>
                      <span className="font-bold text-gray-900">₹{subtotalOf(selectedBill).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-500">
                      <span>Tax</span>
                      <span className="font-bold text-gray-900">₹{selectedBill.tax_amount.toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-red-500">
                      <span>Discount</span>
                      <span className="font-bold">-₹{selectedBill.discount_amount.toFixed(2)}</span>
                    </div>
                    <div className="pt-3 border-t border-gray-100 flex justify-between items-end">
                      <span className="font-bold text-gray-900">Grand Total</span>
                      <span className="text-2xl font-black text-orange-600">₹{selectedBill.total_amount.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Thermal preview panel is sized for a real 80mm receipt (302px);
                  it used to be w-80/p-8 which left only 255px and clipped the
                  right edge of every reprint preview. */}
              {settings.bill_format === 'standard' ? (
                <div className="border-t border-gray-100 bg-gray-50 p-6">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-bold text-lg text-gray-900">Invoice Preview</h4>
                    <button
                      onClick={onPrintClick}
                      className="py-3 px-5 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all flex items-center justify-center gap-2"
                    >
                      <Printer size={18} />
                      Reprint Receipt
                    </button>
                  </div>
                  <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 overflow-auto max-h-[38vh]">
                    <div ref={receiptRef}>
                      <Receipt billId={selectedBill.id} />
                    </div>
                  </div>
                </div>
              ) : (
                <div className="w-[26rem] shrink-0 bg-gray-50 border-l border-gray-100 p-6 flex flex-col gap-4 overflow-y-auto">
                  <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 overflow-x-auto">
                    <div ref={receiptRef}>
                      <Receipt billId={selectedBill.id} />
                    </div>
                  </div>
                  <button
                    onClick={onPrintClick}
                    className="w-full py-4 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all flex items-center justify-center gap-2"
                  >
                    <Printer size={20} />
                    Reprint Receipt
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
