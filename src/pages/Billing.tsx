import { cn } from '../lib/utils';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDataStore } from '../store/useDataStore';
import { useCartStore } from '../store/useCartStore';
import { api } from '../api';
import {
  Search,
  Plus,
  Minus,
  Trash2,
  Edit2,
  UserPlus,
  Printer,
  Banknote,
  Smartphone,
  X,
  ShoppingCart,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
// Not useReactToPrint directly: printing must not drop the till out of full screen.
import { usePrint } from '../hooks/usePrint';
import { Receipt } from '../components/Receipt';
import { Link } from 'react-router-dom';
import { Customer, CartItem, Item } from '../types';
import { customerContactName, customerDisplayName } from '../lib/customer';
// Adds go through here: it reads the item's batches so each unit is priced
// first-in first-out, and refuses stock that is not there.
import { addItemToCart, refreshCartBatches } from '../lib/cartActions';
import { useNoticeStore } from '../store/useNoticeStore';
import { useAuthStore } from '../store/useAuthStore';
import type { ApiError } from '../api';
import { round2 } from '../lib/billMath';
import { UNIT_OPTIONS } from '../lib/units';
import { FORM_FIELD, FORM_LABEL, HEADER_NOTE, ROW_FIELD, TABLE_HEAD_ROW } from '../lib/entryStyles';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';

const normalizeCustomerKey = (value: string) => value.trim().toLowerCase();

const money = (value: number) => `Rs. ${value.toFixed(2)}`;

/** "Packet" for "packet": the unit as the Purchases screen names it. */
const unitLabel = (metric: string) => UNIT_OPTIONS.find((unit) => unit.value === metric)?.label ?? (metric || '-');

/** "3 @ Rs. 107.10 + 2 @ Rs. 113.40" — how a line crossing batches is charged. */
const describeSegments = (line: CartItem) =>
  line.segments.map((segment) => `${segment.quantity} @ ${money(segment.unit_price)}`).join(' + ');

export const Billing = () => {
  const { items, customers, settings, refreshItems, setCustomers, itemsComplete } = useDataStore();
  const {
    carts,
    activeCartId,
    addBillingTab,
    setActiveCart,
    setCartName,
    closeBillingTab,
    removeItem,
    updateQuantity,
    setCustomer,
    setPaymentMethod,
    setPaymentAmount,
    clearCart,
  } = useCartStore();

  const isAdmin = useAuthStore((state) => state.user?.role === 'admin');
  const notice = useNoticeStore();
  const [search, setSearch] = useState('');
  const [showItemMenu, setShowItemMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [lastBillId, setLastBillId] = useState<number | null>(null);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [quantityInputs, setQuantityInputs] = useState<Record<number, string>>({});
  const [customerQuery, setCustomerQuery] = useState('');
  const [showCustomerSuggestions, setShowCustomerSuggestions] = useState(false);
  const [customerForm, setCustomerForm] = useState({
    customer_phone: '',
    customer_gstin: '',
    customer_address: '',
  });
  const [editingCartId, setEditingCartId] = useState<string | null>(null);
  const [cartNameInput, setCartNameInput] = useState('');
  const [autoPrintPending, setAutoPrintPending] = useState(false);
  const [showCreateCustomerModal, setShowCreateCustomerModal] = useState(false);
  const [newCustomerForm, setNewCustomerForm] = useState<Partial<Customer>>({
    name: '',
    phone: '',
    shop_name: '',
    address: '',
    gstin: '',
    credit_balance: 0,
  });

  const activeCart = useMemo(
    () => carts.find((cart) => cart.id === activeCartId) || carts[0],
    [carts, activeCartId]
  );

  const cartItems = activeCart?.items || [];
  const customer = activeCart?.customer || null;
  const paymentMethod = activeCart?.paymentMethod || 'cash';
  const paymentAmounts = activeCart?.paymentAmounts || { cash: 0, upi: 0, credit: 0 };
  const totals = activeCart?.totals || { subtotal: 0, tax: 0, total: 0 };
  // The payable is floored to whole rupees; the paise dropped are shown.
  const roundOff = round2(totals.subtotal + totals.tax - totals.total);

  const receiptRef = useRef<HTMLDivElement>(null);
  const handlePrint = usePrint({
    contentRef: receiptRef,
  });

  const onPrintClick = () => {
    if (!receiptRef.current) {
      console.error('Print failed: receiptRef.current is null');
      return;
    }

    handlePrint();
  };

  const localItemMatches = useMemo(() => {
    if (!search) return [];

    return items
      .filter(
        (item) =>
          item.name.toLowerCase().includes(search.toLowerCase()) ||
          item.hsn_code?.includes(search)
      )
      .slice(0, 8);
  }, [items, search]);

  // When the catalogue is larger than the local cache, items beyond it used to
  // be unreachable: unscannable, unbillable and invisible, with no error. Ask
  // the server whenever the cache can't answer for certain.
  const [remoteItemMatches, setRemoteItemMatches] = useState<Item[]>([]);

  useEffect(() => {
    if (itemsComplete || !search.trim()) {
      setRemoteItemMatches([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(() => {
      api.getItems({ search: search.trim(), limit: 8 })
        .then((rows) => { if (!cancelled) setRemoteItemMatches(rows ?? []); })
        .catch(() => { if (!cancelled) setRemoteItemMatches([]); });
    }, 250);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [search, itemsComplete]);

  const filteredItems = useMemo(() => {
    if (itemsComplete) return localItemMatches;
    // Merge, preferring the cached rows and de-duplicating by id.
    const seen = new Set(localItemMatches.map((item) => item.id));
    return [...localItemMatches, ...remoteItemMatches.filter((item) => !seen.has(item.id))].slice(0, 8);
  }, [itemsComplete, localItemMatches, remoteItemMatches]);

  // Matches for the search row float over the page under its box, as on
  // Purchases, so the table's scroll box cannot clip them.
  const itemMenuStyle = useAnchoredMenu(showItemMenu && search.trim() !== '', () => searchInputRef.current, [
    search,
    cartItems.length,
  ]);

  const customerSuggestions = useMemo(() => {
    const query = normalizeCustomerKey(customerQuery || customerDisplayName(customer));
    // The server sends customers already sorted by bakery/shop name.
    if (!query) return customers.slice(0, 8);

    const matches = customers.filter(
      (customerItem) =>
        normalizeCustomerKey(customerItem.shop_name || '').includes(query) ||
        normalizeCustomerKey(customerItem.name || '').includes(query) ||
        (customerItem.phone || '').includes(query) ||
        normalizeCustomerKey(customerItem.gstin || '').includes(query)
    );

    // Customers whose bakery/shop name *starts* with what was typed come
    // first, so "sri" puts "Sri Ganesh Bakery" above a customer who merely
    // has "sri" somewhere in the owner's name. Stable otherwise.
    const rank = (customerItem: Customer) =>
      normalizeCustomerKey(customerDisplayName(customerItem)).startsWith(query) ? 0 : 1;
    return [...matches].sort((a, b) => rank(a) - rank(b)).slice(0, 8);
  }, [customers, customerQuery, customer]);

  // Customers are no longer preloaded app-wide, so the billing screen fetches
  // the list it needs for the customer picker.
  useEffect(() => {
    api.getCustomers({ limit: 1000 })
      .then(setCustomers)
      .catch(() => console.error('Could not load customers.'));
  }, [setCustomers]);

  useEffect(() => {
    setQuantityInputs({});
    setShowCustomerSuggestions(false);
    if (customer) {
      setCustomerQuery(customerDisplayName(customer));
      setCustomerForm({
        customer_phone: customer.phone || '',
        customer_gstin: customer.gstin || '',
        customer_address: customer.address || '',
      });
    } else {
      setCustomerQuery('');
      setCustomerForm({
        customer_phone: '',
        customer_gstin: '',
        customer_address: '',
      });
    }
  }, [activeCartId]);

  useEffect(() => {
    if (editingCartId) {
      const cart = carts.find((item) => item.id === editingCartId);
      setCartNameInput(cart?.name || '');
    }
  }, [editingCartId, carts]);

  useEffect(() => {
    if (customer) {
      setCustomerQuery(customerDisplayName(customer));
      setCustomerForm({
        customer_phone: customer.phone || '',
        customer_gstin: customer.gstin || '',
        customer_address: customer.address || '',
      });
      return;
    }

    setCustomerForm({
      customer_phone: '',
      customer_gstin: '',
      customer_address: '',
    });
  }, [customer]);

  const getQuantityInputValue = (itemId: number, quantity: number) => {
    return quantityInputs[itemId] ?? String(quantity);
  };

  const handleQuantityInputChange = (itemId: number, rawValue: string) => {
    const cleanedValue = rawValue.replace(/[^0-9.]/g, '');
    const dotCount = (cleanedValue.match(/\./g) || []).length;
    if (dotCount > 1) return;

    setQuantityInputs((current) => ({
      ...current,
      [itemId]: cleanedValue,
    }));

    if (cleanedValue === '' || cleanedValue === '.') {
      updateQuantity(itemId, 0);
      return;
    }

    const parsedValue = parseFloat(cleanedValue);
    if (!Number.isNaN(parsedValue)) {
      updateQuantity(itemId, parsedValue);
    }
  };

  const handleQuantityInputBlur = (itemId: number, quantity: number) => {
    setQuantityInputs((current) => {
      const next = { ...current };
      delete next[itemId];
      return next;
    });

    updateQuantity(itemId, quantity);
  };

  const handleStartRename = (cartId: string, currentName: string) => {
    setEditingCartId(cartId);
    setCartNameInput(currentName);
  };

  const handleSaveCartName = () => {
    if (!editingCartId) return;
    setCartName(editingCartId, cartNameInput);
    setEditingCartId(null);
  };

  const selectCustomer = (nextCustomer: Customer) => {
    setCustomer(nextCustomer);
    setCustomerQuery(customerDisplayName(nextCustomer));
    setCustomerForm({
      customer_phone: nextCustomer.phone || '',
      customer_gstin: nextCustomer.gstin || '',
      customer_address: nextCustomer.address || '',
    });
    setShowCustomerSuggestions(false);
  };

  const clearSelectedCustomer = () => {
    setCustomer(null);
    setCustomerQuery('');
    setCustomerForm({
      customer_phone: '',
      customer_gstin: '',
      customer_address: '',
    });
    setShowCustomerSuggestions(false);
  };

  const openCreateCustomerModal = (nameHint = '') => {
    // What the cashier typed into the picker goes into the bakery/shop field,
    // because that is how customers here are asked for. For an individual
    // with no shop, the form lets them move it to the person's name instead.
    setNewCustomerForm({
      name: '',
      phone: customerForm.customer_phone.trim(),
      shop_name: nameHint || customerQuery.trim(),
      address: customerForm.customer_address.trim(),
      gstin: customerForm.customer_gstin.trim(),
      credit_balance: 0,
    });
    setShowCreateCustomerModal(true);
  };

  const handleCreateCustomer = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newCustomerForm.shop_name?.trim() && !newCustomerForm.name?.trim()) {
      alert('Enter the bakery / shop name, or the customer’s name if they have no shop.');
      return;
    }
    if (!newCustomerForm.phone?.trim()) {
      alert('Customer phone is required.');
      return;
    }

    try {
      const payload = {
        name: newCustomerForm.name?.trim() || '',
        phone: newCustomerForm.phone.trim(),
        shop_name: newCustomerForm.shop_name?.trim() || '',
        address: newCustomerForm.address?.trim() || '',
        gstin: newCustomerForm.gstin?.trim().toUpperCase() || '',
        credit_balance: Number(newCustomerForm.credit_balance || 0),
      };
      const result = await api.addCustomer(payload);
      const latestCustomers = await api.getCustomers({ limit: 1000 });
      setCustomers(latestCustomers);
      setShowCreateCustomerModal(false);

      const createdCustomer = latestCustomers.find((entry: Customer) => entry.id === result.id);
      if (createdCustomer) {
        selectCustomer(createdCustomer);
      }
    } catch (err: any) {
      alert(err.message || 'Failed to create customer');
    }
  };

  // Notices clear themselves; a till should not need a click to dismiss one.
  useEffect(() => {
    if (!notice.message) return;
    const handle = window.setTimeout(() => notice.clear(), 7000);
    return () => window.clearTimeout(handle);
  }, [notice.id]);

  const addToBill = async (item: Parameters<typeof addItemToCart>[0]) => {
    if (await addItemToCart(item)) setSearch('');
  };

  const handleCompleteSale = () => {
    if (cartItems.length === 0) {
      return;
    }

    const short = cartItems.find((line) => line.quantity > line.available);
    if (short) {
      notice.show(`Only ${short.available} ${short.metric} of ${short.name} in stock — reduce the quantity.`, 'warning');
      return;
    }

    if (paymentMethod === 'split') {
      const paidTotal = paymentAmounts.cash + paymentAmounts.upi + paymentAmounts.credit;
      if (Math.abs(paidTotal - totals.total) > 0.01) {
        alert(`Payment mismatch! Paid: Rs. ${paidTotal.toFixed(2)}, Total: Rs. ${totals.total.toFixed(2)}`);
        return;
      }
    }

    if ((paymentMethod === 'credit' || (paymentMethod === 'split' && paymentAmounts.credit > 0)) && !customer) {
      alert('Credit payment requires a customer to be selected!');
      setShowCustomerSuggestions(true);
      return;
    }

    setShowConfirmModal(true);
  };

  const getTaxDisplay = (item: (typeof cartItems)[number]) => {
    const itemMode = item.gst_mode || (item.igst_rate ? 'igst' : 'split');
    const totalRate =
      itemMode === 'igst'
        ? item.igst_rate || item.gst_rate || 0
        : item.gst_rate || item.sgst_rate + item.cgst_rate;

    if (!item.gst_applicable || totalRate === 0) {
      return {
        label: '0%',
        breakdown: 'No GST',
      };
    }

    if (itemMode === 'igst') {
      return {
        label: `IGST ${totalRate}%`,
        breakdown: `IGST Rs. ${(item.igst_amount || 0).toFixed(2)}`,
      };
    }

    return {
      label: `GST ${totalRate}%`,
      breakdown: `${item.sgst_rate}% SGST + ${item.cgst_rate}% CGST`,
    };
  };

  /**
   * Save any edits the cashier made to the selected customer's phone, GSTIN or
   * address before the sale is written.
   *
   * These three fields are editable on this screen but were never sent
   * anywhere: a bill stores only `customer_id`, and the receipt reads the
   * contact details back from the customers table. So a cashier who corrected
   * a GSTIN at the till watched it save, printed an invoice with the old one,
   * and the correction was gone on the next bill. Persisting them here is what
   * the form has always implied it does.
   */
  const persistCustomerDetailEdits = async () => {
    if (!customer) return;

    const nextPhone = customerForm.customer_phone.trim();
    const nextGstin = customerForm.customer_gstin.trim();
    const nextAddress = customerForm.customer_address.trim();

    const unchanged =
      nextPhone === (customer.phone || '') &&
      nextGstin === (customer.gstin || '') &&
      nextAddress === (customer.address || '');
    if (unchanged) return;

    // A phone number is the customer's unique key, so an empty one would be
    // rejected — keep the stored value rather than failing the sale over it.
    const payload = {
      name: customer.name,
      phone: nextPhone || customer.phone,
      shop_name: customer.shop_name || '',
      address: nextAddress,
      gstin: nextGstin,
    };

    await api.updateCustomer(customer.id, payload);
    const updated = { ...customer, ...payload } as Customer;
    setCustomer(updated);
    setCustomers(customers.map((entry) => (entry.id === updated.id ? updated : entry)));
  };

  const processSale = async () => {
    setShowConfirmModal(false);
    setIsProcessing(true);

    try {
      // Before the bill, so the invoice prints the details just entered.
      await persistCustomerDetailEdits();

      const billData = {
        customer_id: customer?.id || null,
        // Prices come from the batches on the server, never from the till. The
        // total the screen showed is sent so the server can refuse if stock
        // moved and the price no longer matches.
        items: cartItems.map((item) => ({ id: item.id, quantity: item.quantity })),
        expected_total: totals.total,
        payment_method: paymentMethod,
        cash_amount: paymentAmounts.cash,
        upi_amount: paymentAmounts.upi,
        credit_amount: paymentAmounts.credit,
      };

      const result = await api.createBill(billData);
      setLastBillId(result.bill_id);
      // Show the confirmation. This was `false`, so the modal below — with the
      // receipt preview and the reprint button — was unreachable: a completed
      // sale gave the cashier no on-screen confirmation at all, and if the
      // print silently failed there was no way to reprint without going to
      // History and searching for the bill.
      setShowSuccessModal(true);
      clearCart();
      setAutoPrintPending(true);
      // Stock and the next-to-sell price have moved; keep the catalogue fresh.
      void refreshItems();
    } catch (err: unknown) {
      const error = err as ApiError;
      if (error.code === 'PRICE_CHANGED') {
        // Another sale used up a batch this bill was priced from. Re-price the
        // bill from current stock and let the cashier look before saving.
        await refreshCartBatches().catch(() => undefined);
        notice.show(error.message, 'warning');
      } else {
        alert(`Sale Failed: ${error.message || 'An unknown error occurred while submitting the bill.'}`);
      }
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 2xl:px-8 py-5 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-amber-50">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Billing Entry</h1>
              <p className="text-sm text-gray-600 mt-1">
                Search an item and press Enter to add it. Each unit is billed at the price of the stock it comes from, oldest first.
              </p>
            </div>

            {/* One tab per open bill. The active one can be renamed. */}
            <div className="flex flex-wrap gap-2">
              {carts.map((cart) => {
                const isActive = cart.id === activeCartId;
                return (
                  <div
                    key={cart.id}
                    className={cn(
                      'flex items-center gap-1 rounded-xl border px-3 py-1.5 shadow-sm transition-all',
                      isActive ? 'border-transparent bg-orange-600 text-white' : 'border-gray-200 bg-white text-gray-700'
                    )}
                  >
                    {editingCartId === cart.id ? (
                      <input
                        type="text"
                        value={cartNameInput}
                        onChange={(e) => setCartNameInput(e.target.value)}
                        onBlur={handleSaveCartName}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleSaveCartName();
                          if (e.key === 'Escape') setEditingCartId(null);
                        }}
                        autoFocus
                        aria-label="Bill name"
                        className="w-28 rounded-lg bg-white px-2 py-1 text-sm font-semibold text-gray-900 outline-none"
                      />
                    ) : (
                      <button onClick={() => setActiveCart(cart.id)} className="text-left">
                        <p className="whitespace-nowrap text-sm font-bold leading-tight">{cart.name}</p>
                        <p className="whitespace-nowrap text-[11px] opacity-80">
                          {cart.items.length} items
                          {cart.customer ? ` | ${customerDisplayName(cart.customer)}` : ''}
                        </p>
                      </button>
                    )}
                    {isActive && editingCartId !== cart.id && (
                      <button
                        onClick={() => handleStartRename(cart.id, cart.name)}
                        className="rounded-lg p-1 opacity-80 transition-all hover:bg-white/15 hover:opacity-100"
                        aria-label={`Rename ${cart.name}`}
                      >
                        <Edit2 size={14} />
                      </button>
                    )}
                    {carts.length > 1 && (
                      <button
                        onClick={() => closeBillingTab(cart.id)}
                        className="rounded-lg p-1 opacity-80 transition-all hover:bg-white/15 hover:opacity-100"
                        aria-label={`Close ${cart.name}`}
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
              <button
                onClick={addBillingTab}
                className="flex items-center gap-1.5 rounded-xl border border-dashed border-orange-300 bg-white px-3 py-1.5 text-sm font-semibold text-orange-600 transition-all hover:bg-orange-50"
              >
                <Plus size={14} />
                New Bill
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 2xl:p-8 space-y-6">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
              <div className="space-y-2 relative">
                <label className={FORM_LABEL}>Customer (Bakery / Shop)</label>
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                  <input
                    type="text"
                    value={customerQuery}
                    onChange={(e) => {
                      const nextValue = e.target.value;
                      setCustomerQuery(nextValue);
                      setShowCustomerSuggestions(true);
                      if (!customer || normalizeCustomerKey(nextValue) !== normalizeCustomerKey(customerDisplayName(customer))) {
                        setCustomer(null);
                      }
                    }}
                    onFocus={() => setShowCustomerSuggestions(true)}
                    onBlur={() => window.setTimeout(() => setShowCustomerSuggestions(false), 150)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        // An exact hit on the bakery/shop name wins; the
                        // person's name still counts, for shopless customers
                        // and for a cashier who knows the owner.
                        const typed = normalizeCustomerKey(customerQuery);
                        const exactMatch =
                          customers.find((customerItem) => normalizeCustomerKey(customerItem.shop_name || '') === typed) ||
                          customers.find((customerItem) => normalizeCustomerKey(customerItem.name || '') === typed);
                        const firstMatch = customerSuggestions[0];
                        if (exactMatch || firstMatch) {
                          selectCustomer(exactMatch || firstMatch);
                          return;
                        }

                        if (customerQuery.trim()) {
                          const shouldCreate = window.confirm(
                            `"${customerQuery.trim()}" does not exist. Do you want to add this customer and continue?`
                          );
                          if (shouldCreate) {
                            openCreateCustomerModal(customerQuery.trim());
                          }
                        }
                      }
                    }}
                    placeholder="Bakery / shop, or customer name"
                    className={cn(FORM_FIELD, 'pl-12')}
                  />
                </div>

                {showCustomerSuggestions && customerSuggestions.length > 0 && (
                  <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden">
                    {customerSuggestions.map((customerItem) => (
                      <button
                        key={customerItem.id}
                        type="button"
                        onMouseDown={() => selectCustomer(customerItem)}
                        className="w-full px-4 py-3 text-left hover:bg-orange-50 transition-colors"
                      >
                        <p className="font-semibold text-gray-900">{customerDisplayName(customerItem)}</p>
                        <p className="text-xs text-gray-500">
                          {[
                            customerContactName(customerItem),
                            customerItem.phone || 'No phone',
                            customerItem.gstin || 'No GSTIN',
                          ].filter(Boolean).join(' | ')}
                        </p>
                      </button>
                    ))}
                  </div>
                )}
                {showCustomerSuggestions && customerQuery.trim() && customerSuggestions.length === 0 && (
                  <button
                    type="button"
                    onMouseDown={() => openCreateCustomerModal(customerQuery.trim())}
                    className="absolute z-20 top-full left-0 right-0 mt-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left text-sm font-semibold text-orange-600 shadow-xl transition-colors hover:bg-orange-50"
                  >
                    Add "{customerQuery.trim()}" as new customer
                  </button>
                )}
              </div>

              <label className="space-y-2">
                <span className={FORM_LABEL}>Customer Phone</span>
                <input
                  type="text"
                  disabled={!customer}
                  placeholder={customer ? '' : 'Select a customer first'}
                  value={customerForm.customer_phone}
                  onChange={(e) =>
                    setCustomerForm((current) => ({ ...current, customer_phone: e.target.value }))
                  }
                  className={cn(FORM_FIELD, 'disabled:cursor-not-allowed disabled:opacity-60')}
                />
              </label>

              <label className="space-y-2">
                <span className={FORM_LABEL}>Customer GSTIN</span>
                <input
                  type="text"
                  disabled={!customer}
                  placeholder={customer ? '' : 'Select a customer first'}
                  value={customerForm.customer_gstin}
                  onChange={(e) =>
                    setCustomerForm((current) => ({
                      ...current,
                      customer_gstin: e.target.value.toUpperCase(),
                    }))
                  }
                  className={cn(FORM_FIELD, 'disabled:cursor-not-allowed disabled:opacity-60')}
                />
              </label>

              <div className="flex items-end">
                {customer ? (
                  <button
                    type="button"
                    onClick={clearSelectedCustomer}
                    className="flex h-[50px] w-full items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-red-200 bg-white px-4 text-sm font-semibold text-red-500 transition-all hover:bg-red-50"
                  >
                    <X size={16} />
                    Clear Customer
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => openCreateCustomerModal(customerQuery.trim())}
                    className="flex h-[50px] w-full items-center justify-center gap-2 whitespace-nowrap rounded-2xl border border-orange-200 bg-white px-4 text-sm font-semibold text-orange-600 transition-all hover:bg-orange-50"
                  >
                    <UserPlus size={16} />
                    Add New Customer
                  </button>
                )}
              </div>
            </div>

            <label className="block space-y-2">
              <span className={FORM_LABEL}>Customer Address</span>
              <input
                type="text"
                disabled={!customer}
                placeholder={customer ? '' : 'Select a customer first'}
                value={customerForm.customer_address}
                onChange={(e) =>
                  setCustomerForm((current) => ({ ...current, customer_address: e.target.value }))
                }
                className={cn(FORM_FIELD, 'disabled:cursor-not-allowed disabled:opacity-60')}
              />
            </label>
          </div>

          {notice.message && (
            <div
              role="status"
              className={cn(
                'flex items-start justify-between gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold',
                notice.tone === 'error'
                  ? 'border-[#f2d6d6] bg-[#fff5f5] text-[#d16464]'
                  : 'border-[#d9cbff] bg-[#f9f6ff] text-[#5a3fc0]'
              )}
            >
              <span>{notice.message}</span>
              <button type="button" onClick={notice.clear} aria-label="Dismiss" className="shrink-0 opacity-70 hover:opacity-100">
                <X size={16} />
              </button>
            </div>
          )}

          <div className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-gray-900">Bill Items</h2>
                <p className="text-sm text-gray-500">
                  Search an item in the last row and press Enter to add it. Prices come from the purchase and can't be
                  changed here.
                </p>
              </div>
              <button
                type="button"
                onClick={clearCart}
                disabled={cartItems.length === 0}
                className="flex h-9 shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl border border-red-200 bg-white px-3 text-sm font-semibold text-red-500 transition-all hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Trash2 size={15} />
                Clear Bill
              </button>
            </div>

            <div className="overflow-x-auto border border-gray-100 rounded-3xl">
              {/* The same fixed-width table as Purchase Items, with the search
                  as its last row. */}
              <table className="w-full min-w-[960px] table-fixed text-left text-sm">
                <colgroup>
                  <col className="w-[220px]" />
                  <col className="w-[104px]" />
                  <col className="w-[96px]" />
                  <col className="w-[128px]" />
                  <col className="w-[112px]" />
                  <col className="w-[112px]" />
                  <col className="w-[132px]" />
                  <col className="w-[56px]" />
                </colgroup>
                <thead className="bg-gray-50">
                  <tr className={TABLE_HEAD_ROW}>
                    <th className="pl-4 pr-2 py-3">Item</th>
                    <th className="px-2 py-3">HSN</th>
                    <th className="px-2 py-3">Metric</th>
                    <th className="px-2 py-3 text-center">Qty</th>
                    <th className="px-2 py-3 text-right">
                      Unit Price<span className={HEADER_NOTE}>incl. GST</span>
                    </th>
                    <th className="px-2 py-3">GST</th>
                    <th className="px-2 py-3 text-right">
                      Amount<span className={HEADER_NOTE}>incl. GST</span>
                    </th>
                    <th className="px-2 py-3">
                      <span className="sr-only">Remove</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 bg-white">
                  {cartItems.map((item) => {
                    const taxDisplay = getTaxDisplay(item);
                    const short = item.quantity > item.available;
                    const laterPrices = item.segments.slice(1).map((segment) => segment.unit_price.toFixed(2));

                    return (
                      <tr key={item.id} className="align-top">
                        <td className="pl-4 pr-2 py-2.5">
                          <div className={cn(ROW_FIELD, 'flex items-center font-semibold text-gray-900')} title={item.name}>
                            <span className="truncate">{item.name}</span>
                          </div>
                          <p className={cn('mt-1 truncate text-[11px]', short ? 'font-semibold text-red-500' : 'text-gray-400')}>
                            {short ? `Only ${item.available} ${item.metric} in stock` : `${item.available} ${item.metric} in stock`}
                          </p>
                        </td>

                        <td className="px-2 py-2.5">
                          <div className={cn(ROW_FIELD, 'flex items-center text-gray-600')} title={item.hsn_code || ''}>
                            <span className="truncate">{item.hsn_code || '-'}</span>
                          </div>
                        </td>

                        <td className="px-2 py-2.5">
                          <div className={cn(ROW_FIELD, 'flex items-center text-gray-600')}>
                            <span className="truncate">{unitLabel(item.metric)}</span>
                          </div>
                        </td>

                        <td className="px-2 py-2.5">
                          <div className={cn(ROW_FIELD, 'flex items-center gap-1 px-1')}>
                            <button
                              type="button"
                              onClick={() => updateQuantity(item.id, Math.max(0, item.quantity - 1))}
                              aria-label={`One less ${item.name}`}
                              className="rounded-lg p-1 text-gray-500 transition-all hover:bg-white"
                            >
                              <Minus size={14} />
                            </button>
                            <input
                              type="text"
                              inputMode="decimal"
                              aria-label={`Quantity of ${item.name}`}
                              value={getQuantityInputValue(item.id, item.quantity)}
                              onChange={(e) => handleQuantityInputChange(item.id, e.target.value)}
                              onBlur={() => handleQuantityInputBlur(item.id, item.quantity)}
                              onFocus={(e) => e.target.select()}
                              className="w-full min-w-0 bg-transparent text-center font-bold tabular-nums text-gray-900 outline-none"
                            />
                            <button
                              type="button"
                              onClick={() => updateQuantity(item.id, item.quantity + 1)}
                              aria-label={`One more ${item.name}`}
                              className="rounded-lg p-1 text-gray-500 transition-all hover:bg-white"
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                        </td>

                        {/* The selling price of the batch the units come from, set
                            on the purchase. Not editable at the till. */}
                        <td className="px-2 py-2.5">
                          <div
                            className={cn(ROW_FIELD, 'flex items-center justify-end whitespace-nowrap font-semibold tabular-nums text-gray-900')}
                            title="Set on the purchase. To change it, use Items → Stock & prices."
                          >
                            {item.unit_price.toFixed(2)}
                          </div>
                          {laterPrices.length > 0 && (
                            <p className="mt-1 truncate text-right text-[11px] font-semibold text-amber-600" title={describeSegments(item)}>
                              then {laterPrices.join(', ')}
                            </p>
                          )}
                        </td>

                        <td className="px-2 py-2.5">
                          <div className={cn(ROW_FIELD, 'flex items-center text-gray-600')} title={taxDisplay.breakdown}>
                            <span className="truncate">{taxDisplay.label === '0%' ? 'No GST' : taxDisplay.label}</span>
                          </div>
                          <p className="mt-1 truncate text-[11px] text-gray-400 tabular-nums">
                            Tax Rs. {(item.sgst_amount + item.cgst_amount + item.igst_amount).toFixed(2)}
                          </p>
                        </td>

                        <td className="px-2 py-2.5 text-right tabular-nums">
                          <p className="min-h-9 py-2 leading-5 break-words font-bold text-gray-900">
                            Rs. {item.total_amount.toFixed(2)}
                          </p>
                          {item.segments.length > 1 && (
                            <p className="text-[11px] break-words text-gray-400">
                              {item.segments.map((segment) => `${segment.quantity} @ ${segment.unit_price.toFixed(2)}`).join(' + ')}
                            </p>
                          )}
                        </td>

                        <td className="px-2 py-2.5">
                          <button
                            type="button"
                            onClick={() => removeItem(item.id)}
                            aria-label={`Remove ${item.name}`}
                            className="flex h-9 w-9 items-center justify-center rounded-xl border border-red-200 bg-white text-red-500 transition-all hover:bg-red-50"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}

                  {/* The last row is where items are searched and added, as on
                      Purchases. Matches float over the page under the box. */}
                  <tr className="align-top bg-orange-50/30">
                    <td className="pl-4 pr-2 py-2.5">
                      <input
                        ref={searchInputRef}
                        type="text"
                        value={search}
                        onChange={(e) => {
                          setSearch(e.target.value);
                          setShowItemMenu(true);
                        }}
                        onFocus={() => setShowItemMenu(true)}
                        onBlur={() => window.setTimeout(() => setShowItemMenu(false), 150)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            const exactMatch = items.find(
                              (item) =>
                                item.name.toLowerCase() === search.trim().toLowerCase() ||
                                item.hsn_code === search.trim()
                            );
                            const firstMatch = filteredItems[0];

                            if (exactMatch || firstMatch) {
                              void addToBill(exactMatch || firstMatch);
                              return;
                            }

                            if (search.trim()) {
                              notice.show(
                                `"${search.trim()}" is not in the catalogue. Items are added by entering a purchase.`,
                                'info'
                              );
                            }
                          }
                          if (e.key === 'Escape') setShowItemMenu(false);
                        }}
                        placeholder="Search item or HSN"
                        aria-label="Item search"
                        title={search}
                        className={ROW_FIELD}
                      />

                      {itemMenuStyle &&
                        createPortal(
                          <div
                            style={itemMenuStyle}
                            // Keep focus in the search box, so the next item can
                            // be typed straight after picking one.
                            onMouseDown={(e) => e.preventDefault()}
                            className="z-50 overflow-y-auto bg-white border border-gray-200 rounded-2xl shadow-xl"
                          >
                            {filteredItems.length > 0 ? (
                              filteredItems.map((item) => (
                                <button
                                  key={item.id}
                                  type="button"
                                  onMouseDown={() => void addToBill(item)}
                                  className="w-full px-4 py-2.5 text-left hover:bg-orange-50 transition-colors"
                                >
                                  <p className="font-semibold text-gray-900">{item.name}</p>
                                  <p className="text-xs text-gray-500">
                                    HSN {item.hsn_code || 'Not set'} •{' '}
                                    {item.stock_quantity > 0 ? `${item.stock_quantity} ${item.metric} in stock` : 'Out of stock'}
                                    {` • selling at Rs. ${item.price.toFixed(2)}`}
                                  </p>
                                </button>
                              ))
                            ) : (
                              <p className="px-4 py-3 text-sm text-gray-600">
                                Not in the catalogue. Items are created when they are first purchased.{' '}
                                {isAdmin ? (
                                  <Link to="/purchases" className="font-semibold text-orange-600 hover:underline">
                                    Enter a purchase
                                  </Link>
                                ) : (
                                  'Ask an admin to enter the purchase.'
                                )}
                              </p>
                            )}
                          </div>,
                          document.body
                        )}
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={cn(ROW_FIELD, 'flex items-center text-gray-400')}>-</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={cn(ROW_FIELD, 'flex items-center text-gray-400')}>-</div>
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={ROW_FIELD} />
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={ROW_FIELD} />
                    </td>
                    <td className="px-2 py-2.5">
                      <div className={ROW_FIELD} />
                    </td>
                    <td className="px-2 py-2.5 text-right">
                      <p className="h-9 leading-9 text-gray-300">-</p>
                    </td>
                    <td className="px-2 py-2.5" />
                  </tr>
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
                {roundOff > 0 && (
                  <p className="mt-1 text-xs text-gray-500">Rounded down by Rs. {roundOff.toFixed(2)}</p>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
              <p className="text-xs font-bold text-gray-500 uppercase">Payment Method</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                {[
                  { id: 'cash', icon: Banknote, label: 'Cash' },
                  { id: 'upi', icon: Smartphone, label: 'UPI' },
                  { id: 'credit', icon: UserPlus, label: 'Credit', disabled: !customer },
                  { id: 'split', icon: Plus, label: 'Split' },
                ].map((method) => (
                  <button
                    key={method.id}
                    disabled={method.disabled}
                    onClick={() => setPaymentMethod(method.id as any)}
                    className={cn(
                      'flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-all',
                      paymentMethod === method.id
                        ? 'border-transparent bg-orange-600 text-white'
                        : 'border-gray-200 bg-white text-gray-700 hover:bg-orange-50',
                      method.disabled && 'cursor-not-allowed opacity-40 grayscale'
                    )}
                  >
                    <method.icon size={18} />
                    <div>
                      <p className="text-sm font-bold">{method.label}</p>
                      <p className="text-[11px] opacity-80">
                        {method.id === 'credit' ? 'Needs customer' : 'Ready to use'}
                      </p>
                    </div>
                  </button>
                ))}
              </div>

              {paymentMethod === 'split' && (
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  {(['cash', 'upi', 'credit'] as const).map((method) => (
                    <label key={method} className="space-y-1">
                      <span className="text-xs font-bold uppercase text-gray-500">{method === 'upi' ? 'UPI' : method}</span>
                      <input
                        type="number"
                        disabled={method === 'credit' && !customer}
                        value={paymentAmounts[method] || ''}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setPaymentAmount(method, Number(e.target.value))}
                        className={cn(ROW_FIELD, 'h-11 bg-white px-3 font-semibold disabled:opacity-60')}
                      />
                    </label>
                  ))}
                  <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-4 py-2.5 md:col-span-3">
                    <span className="text-xs font-bold uppercase text-gray-500">Remaining</span>
                    <span
                      className={cn(
                        'text-sm font-bold',
                        Math.abs(totals.total - (paymentAmounts.cash + paymentAmounts.upi + paymentAmounts.credit)) < 0.01
                          ? 'text-green-600'
                          : 'text-red-500'
                      )}
                    >
                      Rs. {(totals.total - (paymentAmounts.cash + paymentAmounts.upi + paymentAmounts.credit)).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col justify-between gap-4 rounded-2xl border border-orange-100 bg-orange-50 p-4">
              <div>
                <p className="text-xs font-bold text-orange-600 uppercase">Ready To Bill</p>
                <p className="text-2xl font-black text-orange-700 mt-1">Rs. {totals.total.toFixed(2)}</p>
                <p className="mt-1 text-sm text-gray-600">
                  {customer ? `Billing for ${customerDisplayName(customer)}` : 'Walk-in billing'}
                </p>
              </div>

              <button
                onClick={handleCompleteSale}
                disabled={cartItems.length === 0 || isProcessing}
                className="flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-600 px-6 py-4 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700 disabled:opacity-60"
              >
                <Printer size={18} />
                {isProcessing ? 'Processing...' : 'Pay & Print'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showConfirmModal && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="w-full max-w-sm rounded-[2.5rem] bg-white p-8 text-center shadow-2xl"
            >
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-orange-100 text-orange-600">
                <Printer size={40} />
              </div>
              <h3 className="mb-2 text-2xl font-black text-gray-900">Confirm Sale</h3>
              <p className="mb-8 text-gray-500">
                Are you sure you want to complete this transaction of Rs. {totals.total.toFixed(2)}?
              </p>

              <div className="flex flex-col gap-3">
                <button
                  onClick={processSale}
                  className="w-full rounded-2xl bg-orange-600 py-4 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700"
                >
                  Yes, Complete Sale
                </button>
                <button
                  onClick={() => setShowConfirmModal(false)}
                  className="w-full rounded-2xl bg-gray-100 py-4 font-bold text-gray-600 transition-all hover:bg-gray-200"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {showCreateCustomerModal && (
        <div className="fixed inset-0 z-[66] flex items-center justify-center bg-black/25 p-6 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl">
            <form onSubmit={handleCreateCustomer}>
              <div className="flex items-center justify-between border-b border-gray-100 p-8">
                <div>
                  <h3 className="text-2xl font-bold text-gray-900">Add New Customer</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Customer not found. Create now and continue billing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateCustomerModal(false)}
                  className="rounded-full p-2 transition-all hover:bg-gray-100"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="grid max-h-[70vh] grid-cols-2 gap-6 overflow-auto p-8">
                <div className="col-span-2 space-y-2">
                  <label className="text-sm font-bold text-gray-700">Bakery / Shop Name</label>
                  <input
                    type="text"
                    value={newCustomerForm.shop_name || ''}
                    onChange={(e) => setNewCustomerForm((current) => ({ ...current, shop_name: e.target.value }))}
                    placeholder="e.g. Sri Ganesh Bakery"
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  {/* What was typed in the picker lands here. For an individual
                      with no shop, one click moves it to the person's name. */}
                  {newCustomerForm.shop_name?.trim() && !newCustomerForm.name?.trim() ? (
                    <button
                      type="button"
                      onClick={() =>
                        setNewCustomerForm((current) => ({ ...current, name: current.shop_name || '', shop_name: '' }))
                      }
                      className="text-xs font-semibold text-[#5a3fc0] hover:underline"
                    >
                      No bakery or shop? Use this as the customer’s name instead
                    </button>
                  ) : (
                    <p className="text-xs text-gray-500">Leave blank if the customer has no bakery or shop.</p>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">
                    Customer / Contact Name
                    {newCustomerForm.shop_name?.trim() ? (
                      <span className="ml-1 font-normal text-gray-400">(optional)</span>
                    ) : null}
                  </label>
                  <input
                    type="text"
                    value={newCustomerForm.name || ''}
                    onChange={(e) => setNewCustomerForm((current) => ({ ...current, name: e.target.value }))}
                    placeholder={newCustomerForm.shop_name?.trim() ? 'Who to ask for' : 'Required if no bakery / shop'}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Phone Number</label>
                  <input
                    type="text"
                    value={newCustomerForm.phone || ''}
                    onChange={(e) => setNewCustomerForm((current) => ({ ...current, phone: e.target.value }))}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    required
                  />
                </div>

                <div className="col-span-2 space-y-2">
                  <label className="text-sm font-bold text-gray-700">Address</label>
                  <input
                    type="text"
                    value={newCustomerForm.address || ''}
                    onChange={(e) => setNewCustomerForm((current) => ({ ...current, address: e.target.value }))}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">GSTIN</label>
                  <input
                    type="text"
                    value={newCustomerForm.gstin || ''}
                    onChange={(e) =>
                      setNewCustomerForm((current) => ({ ...current, gstin: e.target.value.toUpperCase() }))
                    }
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Credit Balance (Rs.)</label>
                  <input
                    type="number"
                    value={newCustomerForm.credit_balance || ''}
                    onChange={(e) =>
                      setNewCustomerForm((current) => ({
                        ...current,
                        credit_balance: e.target.value === '' ? 0 : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              </div>

              <div className="flex gap-4 border-t border-gray-100 bg-gray-50 p-8">
                <button
                  type="button"
                  onClick={() => setShowCreateCustomerModal(false)}
                  className="flex-1 rounded-2xl border border-gray-200 bg-white py-4 font-bold text-gray-600 transition-all hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-2xl bg-orange-600 py-4 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700"
                >
                  Save Customer And Continue
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <AnimatePresence>
        {showSuccessModal && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="w-full max-w-sm rounded-[2.5rem] bg-white p-8 text-center shadow-2xl"
            >
              <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-green-100 text-green-600">
                <ShoppingCart size={40} />
              </div>
              <h3 className="mb-2 text-2xl font-black text-gray-900">Sale Successful!</h3>
              <p className="mb-6 text-gray-500">The transaction has been completed and recorded.</p>

              {settings.bill_format !== 'standard' && (
                <div className="mb-6 max-h-[300px] overflow-auto rounded-2xl border border-gray-100 bg-gray-50 p-4">
                  {lastBillId && <Receipt billId={lastBillId} />}
                </div>
              )}

              {settings.bill_format === 'standard' && (
                <div className="mb-6 rounded-2xl border border-gray-100 bg-gray-50 p-4 text-sm text-gray-500">
                  Invoice generated successfully. Use the print button below to open the full invoice layout.
                </div>
              )}

              <div className="flex flex-col gap-3">
                <button
                  onClick={onPrintClick}
                  className="flex w-full items-center justify-center gap-2 rounded-2xl bg-orange-600 py-4 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700"
                >
                  <Printer size={20} />
                  Print Tax Invoice
                </button>
                <button
                  onClick={() => setShowSuccessModal(false)}
                  className="w-full rounded-2xl bg-gray-100 py-4 font-bold text-gray-600 transition-all hover:bg-gray-200"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <div style={{ position: 'absolute', left: '-9999px', top: 0, visibility: 'hidden' }}>
        <div ref={receiptRef}>
          {lastBillId && (
            <Receipt
              billId={lastBillId}
              onDataLoaded={() => {
                if (autoPrintPending) {
                  setAutoPrintPending(false);
                  setTimeout(() => {
                    onPrintClick();
                  }, 150);
                }
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
