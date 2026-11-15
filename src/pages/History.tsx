import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { Bill } from '../types';
import { useDataStore } from '../store/useDataStore';
import { useAuthStore } from '../store/useAuthStore';
import { 
  Search, 
  Printer, 
  ChevronRight, 
  Download,
  Trash2,
  X,
  Pencil,
  FileText
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { openBillForEditing } from '../lib/cartActions';
import { DateFilterButton, DateFilterPanel } from '../components/DateFilter';
import { PurchaseHistory } from '../components/PurchaseHistory';
import { SalesPurchaseSwitch, useTradeView } from '../components/SalesPurchaseSwitch';
import { motion, AnimatePresence } from 'motion/react';
// Not useReactToPrint directly: printing must not drop the till out of full screen.
import { usePrint } from '../hooks/usePrint';
import { Receipt } from '../components/Receipt';
import { cn, formatDateTimeInIST, getISTTimestampForFileName } from '../lib/utils';
import { billCustomerContactName, billCustomerDisplayName } from '../lib/customer';
import { localName, paymentLabel, t, unitLabel, withEnglish } from '../i18n';
import { HEADER_NOTE } from '../lib/entryStyles';
import { ItemName, LocalName } from '../components/ItemName';

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

/**
 * Sales history for everyone; purchase history too for admins, who can see
 * purchases. Which one is open is in the address (?view=purchases), so the
 * menu can link straight to either.
 */
export const History = () => {
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const [view, setView] = useTradeView(isAdmin);

  return (
    <div className="space-y-6">
      {isAdmin && <SalesPurchaseSwitch value={view} onChange={setView} id="history" />}
      {view === 'purchases' ? <PurchaseHistory /> : <SalesHistory />}
    </div>
  );
};

const SalesHistory = () => {
  const settings = useDataStore((state) => state.settings);
  const refreshItems = useDataStore((state) => state.refreshItems);
  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
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
  // Deleting asks again inside the modal rather than with confirm(): a
  // browser dialog can drop the till out of full screen.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // The invoice opens on top of the details, from its button.
  const [showInvoice, setShowInvoice] = useState(false);
  const [openingEdit, setOpeningEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Bumped after a delete so the list is fetched again.
  const [reloadKey, setReloadKey] = useState(0);

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
        alert(t('Failed to fetch history: {message}', { message: err.message }));
      })
      .finally(() => setLoading(false));
  }, [startDate, endDate, appliedSearch, page, reloadKey]);

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
      alert(t('No bills available to export for the current filter.'));
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
      alert(t('Export failed: {message}', { message: err.message }));
      setExporting(false);
      return;
    }
    setExporting(false);

    if (total > EXPORT_ROW_CAP) {
      alert(t('This filter matches {value} bills. Exporting the first {value2} — narrow the date range to export the rest.', { value: total.toLocaleString('en-IN'), value2: EXPORT_ROW_CAP.toLocaleString('en-IN') }));
    }

    const headers = [
      'Bill Number',
      'Date',
      'Customer',
      'Contact Person',
      'Cashier',
      'Payment Method',
      'Taxable Value (before GST)',
      'GST Amount',
      'Discount Amount',
      'Total Amount (incl. GST)',
    ];

    // The file reads the same in either language.
    const rows = withEnglish(() => exportRows.map((bill) => [
      bill.bill_number,
      formatDateTimeInIST(bill.created_at, { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      billCustomerDisplayName(bill),
      billCustomerContactName(bill) || '',
      bill.cashier_name,
      bill.payment_method,
      subtotalOf(bill).toFixed(2),
      subtotalOf(bill).toFixed(2),
      bill.tax_amount.toFixed(2),
      bill.discount_amount.toFixed(2),
      bill.total_amount.toFixed(2),
    ]));

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


  const handleViewBill = async (id: number) => {
    try {
      const bill = await api.getBill(id);
      setSelectedBill(bill);
      setConfirmingDelete(false);
      setDeleteError(null);
      setShowBillModal(true);
    } catch (err: any) {
      alert(err.message);
    }
  };

  /** Open the bill in a Billing tab to change it; saving there replaces it. */
  const handleEditBill = async () => {
    if (!selectedBill) return;
    setOpeningEdit(true);
    setEditError(null);
    try {
      await openBillForEditing(selectedBill);
      navigate('/billing');
    } catch (err: any) {
      setEditError(err?.message || t('Could not open the bill for editing.'));
    } finally {
      setOpeningEdit(false);
    }
  };

  const closeBillModal = () => {
    setShowInvoice(false);
    setEditError(null);
    setShowBillModal(false);
    setConfirmingDelete(false);
    setDeleteError(null);
  };

  const handleDeleteBill = async () => {
    if (!selectedBill) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteBill(selectedBill.id);
      closeBillModal();
      setSelectedBill(null);
      // The last bill on a later page: step back rather than show an empty page.
      if (bills.length === 1 && page > 0) setPage(page - 1);
      setReloadKey((key) => key + 1);
      // Its stock is back on the shelf; the till's item cache must see it.
      refreshItems().catch(() => {});
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeleting(false);
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
            placeholder={t('Search by bill number, bakery / shop, or customer...')}
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <DateFilterButton from={startDate} to={endDate} open={showDateFilter} onClick={() => setShowDateFilter((current) => !current)} />
          <button
            onClick={handleExportCsv}
            disabled={exporting}
            className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 text-gray-600 font-bold rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50 disabled:pointer-events-none"
          >
            <Download size={20} />
            {exporting ? t('Exporting…') : t('Export CSV')}
          </button>
        </div>
      </div>

      {showDateFilter && (
        <DateFilterPanel
          from={startDate}
          to={endDate}
          onFromChange={setStartDate}
          onToChange={setEndDate}
          description={t('Bills and CSV export will follow this selected date range.')}
        />
      )}

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Bill Number')}</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Date & Time')}</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Customer')}</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Cashier')}</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Method')}</th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('Amount')}<span className={HEADER_NOTE}>{t('incl. GST')}</span></th>
              <th className="px-8 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider text-right">{t('Actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-8 py-12 text-center text-gray-400">{t('Loading history...')}</td>
              </tr>
            ) : filteredBills.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-8 py-12 text-center text-gray-400">{t('No bills found')}</td>
              </tr>
            ) : (
              filteredBills.map(bill => (
                <tr key={bill.id} className="hover:bg-gray-50 transition-colors group">
                  <td className="px-8 py-4">
                    <span className="font-mono font-bold text-gray-900">{bill.bill_number}</span>
                  </td>
                  <td className="px-8 py-4 text-sm text-gray-500 whitespace-nowrap">
                    {formatDateTimeInIST(bill.created_at)}
                  </td>
                  <td className="px-8 py-4">
                    <p className="font-bold text-gray-900"><LocalName name={billCustomerDisplayName(bill)} /></p>
                    {billCustomerContactName(bill) && (
                      <p className="text-xs text-gray-500">{localName(billCustomerContactName(bill))}</p>
                    )}
                  </td>
                  <td className="px-8 py-4 text-sm text-gray-500">{bill.cashier_name}</td>
                  <td className="px-8 py-4">
                    <span className="text-[10px] font-black uppercase px-2 py-1 bg-gray-100 rounded-full text-gray-600">
                      {paymentLabel(bill.payment_method)}
                    </span>
                  </td>
                  <td className="px-8 py-4">
                    <span className="font-black text-gray-900 whitespace-nowrap">₹{bill.total_amount.toFixed(2)}</span>
                  </td>
                  <td className="px-8 py-4 text-right">
                    <button 
                      onClick={() => handleViewBill(bill.id)}
                      aria-label={t('View bill {bill_number}', { bill_number: bill.bill_number })}
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

        {/* Paging controls. `total` comes from a COUNT in the same query, so
            the range shown is the true position in the full history, not just
            within a locally-cached slice. */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-8 py-4">
          <p className="text-sm text-gray-500">
            {total === 0
              ? t('No bills match this filter')
              : t('Showing {value}–{value2} of {value3}', { value: page * HISTORY_PAGE_SIZE + 1, value2: Math.min((page + 1) * HISTORY_PAGE_SIZE, total), value3: total.toLocaleString('en-IN') })}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              {t('Previous')}
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              {t('Page {value} of {value2}', { value: page + 1, value2: pageCount.toLocaleString('en-IN') })}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              {t('Next')}
            </button>
          </div>
        </div>
      </div>

      {/* Bill Detail Modal: the bill's details. The invoice opens from a
          button, on top; printing works whether it is open or not. */}
      <AnimatePresence>
        {showBillModal && selectedBill && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/20 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-4xl rounded-3xl shadow-2xl max-h-[90vh] flex flex-col overflow-hidden"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-4 py-4 sm:px-8">
                <h3 className="font-bold text-2xl">{t('Bill Details')}</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {isAdmin && !confirmingDelete && (
                    <>
                      <button
                        onClick={() => void handleEditBill()}
                        disabled={openingEdit}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-orange-700 border border-orange-200 rounded-2xl hover:bg-orange-50 transition-all disabled:opacity-50"
                      >
                        <Pencil size={16} />
                        {openingEdit ? t('Opening…') : t('Edit Bill')}
                      </button>
                      <button
                        onClick={() => { setConfirmingDelete(true); setDeleteError(null); }}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-red-600 border border-red-200 rounded-2xl hover:bg-red-50 transition-all"
                      >
                        <Trash2 size={16} />
                        {t('Delete Bill')}
                      </button>
                    </>
                  )}
                  <button onClick={closeBillModal} className="p-2 hover:bg-gray-100 rounded-full" aria-label={t('Close')}>
                    <X size={24} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-6 sm:px-8">
                {editError && (
                  <p className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{editError}</p>
                )}
                {confirmingDelete && (
                  <div className="mb-8 rounded-2xl border border-red-200 bg-red-50 p-5">
                    <p className="font-bold text-red-700">{t('Delete bill {bill_number}?', { bill_number: selectedBill.bill_number })}</p>
                    <ul className="mt-2 list-disc pl-5 text-sm text-red-700 space-y-1">
                      <li>{t('Every item on it goes back into stock.')}</li>
                      {selectedBill.credit_amount > 0 && (
                        <li>
                          ₹{t('{value} comes off {selectedBill}’s credit balance.', { value: selectedBill.credit_amount.toFixed(2), selectedBill: localName(billCustomerDisplayName(selectedBill)) })}
                        </li>
                      )}
                      <li>{t('It is removed from history, the customer’s passbook, reports and the dashboard. This cannot be undone.')}</li>
                    </ul>
                    {deleteError && (
                      <p className="mt-3 rounded-xl bg-white px-3 py-2 text-sm font-semibold text-red-700 border border-red-200">{deleteError}</p>
                    )}
                    <div className="mt-4 flex gap-2">
                      <button
                        onClick={handleDeleteBill}
                        disabled={deleting}
                        className="flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-red-600 rounded-2xl hover:bg-red-700 transition-all disabled:opacity-50 disabled:pointer-events-none"
                      >
                        <Trash2 size={16} />
                        {deleting ? t('Deleting…') : t('Yes, delete bill')}
                      </button>
                      <button
                        onClick={() => { setConfirmingDelete(false); setDeleteError(null); }}
                        disabled={deleting}
                        className="px-4 py-2 text-sm font-bold text-gray-700 bg-white border border-gray-200 rounded-2xl hover:bg-gray-50 transition-all disabled:opacity-50"
                      >
                        {t('Cancel')}
                      </button>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 sm:gap-8 mb-8">
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">{t('Bill Info')}</p>
                    <p className="font-bold text-lg">{selectedBill.bill_number}</p>
                    <p className="text-sm text-gray-500">{formatDateTimeInIST(selectedBill.created_at)}</p>
                    {selectedBill.edited_at && (
                      <p className="mt-1 inline-block rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700">
                        {t('Edited {when} by {name}', { when: formatDateTimeInIST(selectedBill.edited_at), name: selectedBill.edited_by || '—' })}
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">{t('Customer')}</p>
                    <p className="font-bold text-lg"><LocalName name={billCustomerDisplayName(selectedBill)} /></p>
                    {billCustomerContactName(selectedBill) && (
                      <p className="text-sm text-gray-500">{localName(billCustomerContactName(selectedBill))}</p>
                    )}
                    <p className="text-sm text-gray-500">{selectedBill.customer_phone || 'N/A'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-bold text-gray-400 uppercase mb-1">{t('Payment')}</p>
                    <p className="font-bold text-lg capitalize">{paymentLabel(selectedBill.payment_method)}</p>
                    {selectedBill.payment_method === 'split' && (
                      <div className="text-[10px] text-gray-500 space-y-0.5">
                        {selectedBill.cash_amount > 0 && <p>{t('Cash: ₹{value}', { value: selectedBill.cash_amount.toFixed(2) })}</p>}
                        {selectedBill.upi_amount > 0 && <p>{t('UPI: ₹{value}', { value: selectedBill.upi_amount.toFixed(2) })}</p>}
                        {selectedBill.credit_amount > 0 && <p>{t('Credit: ₹{value}', { value: selectedBill.credit_amount.toFixed(2) })}</p>}
                      </div>
                    )}
                    <p className="text-sm text-gray-500">{t('Cashier: {cashier_name}', { cashier_name: selectedBill.cashier_name })}</p>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left mb-8">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="py-3 text-xs font-bold text-gray-400 uppercase">{t('Item')}</th>
                        <th className="py-3 text-xs font-bold text-gray-400 uppercase text-center">{t('Qty')}</th>
                        <th className="py-3 text-xs font-bold text-gray-400 uppercase text-right">{t('Price')}<span className={HEADER_NOTE}>{t('before GST')}</span></th>
                        <th className="py-3 text-xs font-bold text-gray-400 uppercase text-right">{t('GST')}</th>
                        <th className="py-3 text-xs font-bold text-gray-400 uppercase text-right">{t('Total')}<span className={HEADER_NOTE}>{t('incl. GST')}</span></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {selectedBill.items?.map(item => (
                        <tr key={item.id}>
                          <td className="py-4 pr-3">
                            <p className="font-bold text-gray-900"><ItemName name={item.item_name} /></p>
                            <p className="text-xs text-gray-400">{t('HSN: {hsn_code}', { hsn_code: item.hsn_code })}</p>
                          </td>
                          <td className="py-4 text-center font-semibold whitespace-nowrap">{item.quantity} {unitLabel(item.metric)}</td>
                          <td className="py-4 text-right">₹{item.price.toFixed(2)}</td>
                          <td className="py-4 text-right text-sm text-gray-600 whitespace-nowrap">
                            ₹{(item.sgst_amount + item.cgst_amount + (item.igst_amount || 0)).toFixed(2)}
                          </td>
                          <td className="py-4 text-right font-bold">₹{item.total_amount.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex justify-end">
                  <div className="w-full sm:w-80 space-y-3">
                    <div className="flex justify-between text-gray-500">
                      <span>{t('Subtotal (before GST)')}</span>
                      <span className="font-bold text-gray-900">₹{subtotalOf(selectedBill).toFixed(2)}</span>
                    </div>
                    <div className="flex justify-between text-gray-500">
                      <span>{t('GST')}</span>
                      <span className="font-bold text-gray-900">₹{selectedBill.tax_amount.toFixed(2)}</span>
                    </div>
                    {selectedBill.discount_amount > 0 && (
                      <div className="flex justify-between text-red-500">
                        <span>{t('Discount')}</span>
                        <span className="font-bold">-₹{selectedBill.discount_amount.toFixed(2)}</span>
                      </div>
                    )}
                    {(() => {
                      const roundOff = Math.round((selectedBill.total_amount - (subtotalOf(selectedBill) + selectedBill.tax_amount - selectedBill.discount_amount)) * 100) / 100;
                      return roundOff !== 0 && Math.abs(roundOff) < 1 ? (
                        <div className="flex justify-between text-gray-500">
                          <span>{t('Round off')}</span>
                          <span className="font-bold text-gray-900">{roundOff < 0 ? '-' : ''}₹{Math.abs(roundOff).toFixed(2)}</span>
                        </div>
                      ) : null;
                    })()}
                    <div className="pt-3 border-t border-gray-100 flex justify-between items-end">
                      <span className="font-bold text-gray-900">{t('Grand Total (incl. GST)')}</span>
                      <span className="text-2xl font-black text-orange-600">₹{selectedBill.total_amount.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap justify-end gap-3 border-t border-gray-100 bg-gray-50 px-4 py-4 sm:px-8">
                <button
                  onClick={() => setShowInvoice(true)}
                  className="flex items-center justify-center gap-2 rounded-2xl border border-gray-200 bg-white px-5 py-3 font-bold text-gray-700 transition-all hover:bg-gray-100"
                >
                  <FileText size={18} />
                  {t('Invoice Preview')}
                </button>
                <button
                  onClick={onPrintClick}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-orange-600 px-5 py-3 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700"
                >
                  <Printer size={18} />
                  {t('Reprint Receipt')}
                </button>
              </div>
            </motion.div>

            {/* What prints: always here, off screen, so Reprint works without the preview open. */}
            <div style={{ position: 'absolute', left: '-9999px', top: 0, visibility: 'hidden' }} aria-hidden>
              <div ref={receiptRef}>
                <Receipt billId={selectedBill.id} />
              </div>
            </div>

            {showInvoice && (
              <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4 sm:p-6" role="dialog" aria-label={t('Invoice Preview')}>
                <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
                  <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-6 py-4">
                    <h4 className="text-lg font-bold text-gray-900">{t('Invoice Preview')} · {selectedBill.bill_number}</h4>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={onPrintClick}
                        className="flex items-center gap-2 rounded-2xl bg-orange-600 px-4 py-2 text-sm font-bold text-white hover:bg-orange-700"
                      >
                        <Printer size={16} />
                        {t('Reprint Receipt')}
                      </button>
                      <button onClick={() => setShowInvoice(false)} className="rounded-full p-2 hover:bg-gray-100" aria-label={t('Close invoice preview')}>
                        <X size={22} />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 overflow-auto bg-gray-50 p-4 sm:p-6">
                    <div className="mx-auto w-fit rounded-2xl border border-gray-100 bg-white p-4 shadow-sm">
                      <Receipt billId={selectedBill.id} />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};
