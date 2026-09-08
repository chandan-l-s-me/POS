import React, { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { Bill } from '../types';
import { useDataStore } from '../store/useDataStore';
import { 
  Search, 
  Calendar, 
  Printer, 
  ChevronRight, 
  FileText, 
  Download,
  Filter,
  X
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useReactToPrint } from 'react-to-print';
import { Receipt } from '../components/Receipt';
import { cn, formatDateTimeInIST, getISTDateKey, getISTTimestampForFileName } from '../lib/utils';

// Cap on how many bills one screen loads. Narrow the date range to look
// further back rather than raising this.
const HISTORY_PAGE_SIZE = 500;

export const History = () => {
  const settings = useDataStore((state) => state.settings);
  const [bills, setBills] = useState<Bill[]>([]);
  const [search, setSearch] = useState('');
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [selectedBill, setSelectedBill] = useState<Bill | null>(null);
  const [showBillModal, setShowBillModal] = useState(false);

  const receiptRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: receiptRef,
  });

  const onPrintClick = () => {
    console.log('History: printing bill', selectedBill?.id);
    if (!receiptRef.current) {
      console.error('History print failed: receiptRef.current is null');
      return;
    }
    handlePrint();
  };

  // Fetch server-side by date range rather than pulling every bill ever rung
  // up. With no range chosen we take the most recent page; the search box then
  // filters within what was loaded.
  useEffect(() => {
    setLoading(true);
    api.getBills({
      from: startDate || undefined,
      to: endDate || undefined,
      limit: HISTORY_PAGE_SIZE,
    })
      .then(setBills)
      .catch(err => {
        console.error('Failed to fetch bills:', err);
        alert('Failed to fetch history: ' + err.message);
      })
      .finally(() => setLoading(false));
  }, [startDate, endDate]);

  const filteredBills = bills.filter((bill) => {
    const normalizedSearch = search.trim().toLowerCase();
    const matchesSearch =
      normalizedSearch.length === 0 ||
      bill.bill_number.toLowerCase().includes(normalizedSearch) ||
      (bill.customer_name || '').toLowerCase().includes(normalizedSearch);

    if (!matchesSearch) {
      return false;
    }

    const billDate = getISTDateKey(bill.created_at);
    if (startDate && billDate < startDate) {
      return false;
    }

    if (endDate && billDate > endDate) {
      return false;
    }

    return true;
  });

  const escapeCsvValue = (value: string | number | null | undefined) => {
    const safeValue = value == null ? '' : String(value);
    return `"${safeValue.replace(/"/g, '""')}"`;
  };

  const handleExportCsv = () => {
    if (filteredBills.length === 0) {
      alert('No bills available to export for the current filter.');
      return;
    }

    const headers = [
      'Bill Number',
      'Date',
      'Customer',
      'Cashier',
      'Payment Method',
      'Tax Amount',
      'Discount Amount',
      'Total Amount',
    ];

    const rows = filteredBills.map((bill) => [
      bill.bill_number,
      formatDateTimeInIST(bill.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      bill.customer_name || 'Walk-in',
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
            placeholder="Search by bill number or customer..."
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
            className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all"
          >
            <Download size={20} />
            Export CSV
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
                    <p className="font-bold text-gray-900">{bill.customer_name || 'Walk-in'}</p>
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
                  : "max-w-4xl flex"
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
                    <p className="font-bold text-lg">{selectedBill.customer_name || 'Walk-in'}</p>
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
                      <span className="font-bold text-gray-900">₹{(selectedBill.total_amount - selectedBill.tax_amount + selectedBill.discount_amount).toFixed(2)}</span>
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
                <div className="w-80 bg-gray-50 border-l border-gray-100 p-8 flex flex-col gap-4">
                  <div className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
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
                  <button className="w-full py-4 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-100 transition-all flex items-center justify-center gap-2">
                    <FileText size={20} />
                    Refund Bill
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
