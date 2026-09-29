import { cn } from '../lib/utils';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  ReceiptText,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
// Not useReactToPrint directly: printing must not drop the till out of full screen.
import { usePrint } from '../hooks/usePrint';
import { Receipt } from '../components/Receipt';
import { Customer, Item } from '../types';
import { customerContactName, customerDisplayName } from '../lib/customer';

const normalizeCustomerKey = (value: string) => value.trim().toLowerCase();
const GST_OPTIONS = [0, 5, 12, 18, 28];

export const Billing = () => {
  const { items, customers, settings, refreshItems, setCustomers, itemsComplete } = useDataStore();
  const {
    carts,
    activeCartId,
    addBillingTab,
    setActiveCart,
    setCartName,
    closeBillingTab,
    addItem,
    removeItem,
    updateQuantity,
    setCustomer,
    setDiscount,
    setPaymentMethod,
    setPaymentAmount,
    clearCart,
  } = useCartStore();

  const [search, setSearch] = useState('');
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
  const [showCreateItemModal, setShowCreateItemModal] = useState(false);
  const [showCreateCustomerModal, setShowCreateCustomerModal] = useState(false);
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
  const discount = activeCart?.discount || 0;
  const paymentMethod = activeCart?.paymentMethod || 'cash';
  const paymentAmounts = activeCart?.paymentAmounts || { cash: 0, upi: 0, credit: 0 };
  const totals = activeCart?.totals || { subtotal: 0, tax: 0, total: 0 };

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

  const openCreateItemModal = (itemName: string) => {
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
    setShowCreateItemModal(true);
  };

  const handleCreateItem = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newItemForm.name?.trim()) {
      alert('Item name is required.');
      return;
    }

    if (!newItemForm.hsn_code?.trim()) {
      alert('HSN code is required.');
      return;
    }

    try {
      const gstMode = newItemForm.gst_mode || 'split';
      const gstRate = Number(newItemForm.gst_rate || 0);
      const normalizedItem = {
        ...newItemForm,
        name: newItemForm.name.trim(),
        hsn_code: newItemForm.hsn_code.trim(),
        gst_mode: gstMode,
        gst_rate: gstRate,
        sgst_rate: newItemForm.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
        cgst_rate: newItemForm.gst_applicable ? (gstMode === 'split' ? gstRate / 2 : 0) : 0,
        igst_rate: newItemForm.gst_applicable ? (gstMode === 'igst' ? gstRate : 0) : 0,
      };

      const result = await api.addItem(normalizedItem);
      await refreshItems();
      setShowCreateItemModal(false);

      const latestItems = useDataStore.getState().items;
      const createdItem = latestItems.find((item: Item) => item.id === result.id);
      if (createdItem) {
        addItem(createdItem);
        setSearch('');
      }
    } catch (err: any) {
      alert(err.message || 'Failed to create item');
    }
  };

  const handleCompleteSale = () => {
    if (cartItems.length === 0) {
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
        items: cartItems.map((item) => ({
          id: item.id,
          quantity: item.quantity,
          price: item.price,
          sgst_amount: item.sgst_amount,
          cgst_amount: item.cgst_amount,
          igst_amount: item.igst_amount,
          total_amount: item.total_amount,
        })),
        total_amount: totals.total,
        tax_amount: totals.tax,
        discount_amount: discount,
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
    } catch (err: any) {
      const errorMessage = err.message || 'An unknown error occurred while submitting the bill.';
      alert(`Sale Failed: ${errorMessage}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="bg-white/95 overflow-hidden rounded-[2rem] border border-[#e5ddff] shadow-[0_20px_50px_rgba(35,45,155,0.08)]">
        <div className="border-b border-[#ebe4ff] bg-gradient-to-r from-[#fff8e9] via-[#fffaf2] to-[#fffdea] px-8 py-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white shadow-sm text-[#1d285f]">
                <ReceiptText size={24} />
              </div>
              <div>
                <h2 className="text-3xl font-black text-[#1d285f]">Billing Entry</h2>
                <p className="mt-1 text-sm text-[#4d5688]">
                  Search items quickly, keep HSN visible, and complete billing from the same clean workflow as purchases.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              {carts.map((cart) => (
                <div
                  key={cart.id}
                  className={cn(
                    "flex min-h-[4.5rem] min-w-[11rem] items-center justify-between gap-3 rounded-2xl border px-5 py-3 shadow-sm transition-all",
                    cart.id === activeCartId
                      ? "border-transparent bg-gradient-to-r from-[#232d9b] via-[#5534b7] to-[#b153d7] text-white"
                      : "border-[#e5ddff] bg-white text-[#4d5688]"
                  )}
                >
                  <button onClick={() => setActiveCart(cart.id)} className="flex-1 text-left">
                    <p className="whitespace-nowrap text-base font-bold leading-tight">{cart.name}</p>
                    <p className="mt-0.5 whitespace-nowrap text-xs opacity-80">
                      {cart.items.length} items
                      {cart.customer ? ` | ${customerDisplayName(cart.customer)}` : ''}
                    </p>
                  </button>
                  {carts.length > 1 && (
                    <button
                      onClick={() => closeBillingTab(cart.id)}
                      className="rounded-lg p-1 transition-all hover:bg-white/15"
                      aria-label={`Close ${cart.name}`}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={addBillingTab}
                className="flex min-h-[4.5rem] items-center gap-2 rounded-2xl border border-dashed border-[#c8baf9] bg-white px-5 py-3 font-semibold text-[#5534b7] transition-all hover:bg-[#f9f6ff]"
              >
                <Plus size={16} />
                New Bill
              </button>
            </div>
          </div>
        </div>

        <div className="px-8 py-8">
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_220px]">
            <div className="space-y-2 relative">
              <label className="text-sm font-semibold text-[#24306c]">Customer (Bakery / Shop)</label>
              <div className="relative">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9a94c9]" size={18} />
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
                  placeholder="Type bakery / shop name, or customer name"
                  className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] py-3 pl-11 pr-4 text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
                />
              </div>

              {showCustomerSuggestions && customerSuggestions.length > 0 && (
                <div className="absolute z-20 top-full left-0 right-0 mt-1 overflow-hidden rounded-2xl border border-[#e3d8ff] bg-white shadow-xl">
                  {customerSuggestions.map((customerItem) => (
                    <button
                      key={customerItem.id}
                      type="button"
                      onMouseDown={() => selectCustomer(customerItem)}
                      className="w-full px-4 py-3 text-left transition-colors hover:bg-[#f9f4ff]"
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
                  className="absolute z-20 top-full left-0 right-0 mt-1 rounded-2xl border border-[#d9cbff] bg-white px-4 py-3 text-left text-sm font-semibold text-[#5a3fc0] shadow-xl transition-colors hover:bg-[#f9f4ff]"
                >
                  Add "{customerQuery.trim()}" as new customer
                </button>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-semibold text-[#24306c]">Discount</label>
              <input
                type="number"
                value={discount || ''}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setDiscount(e.target.value === '' ? 0 : Number(e.target.value))}
                placeholder="0"
                className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-4 py-3 font-semibold text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
              />
              <button
                type="button"
                onClick={() => openCreateCustomerModal(customerQuery.trim())}
                className="w-full rounded-xl border border-[#d4c6ff] bg-white px-3 py-2 text-xs font-semibold text-[#5a3fc0] transition-all hover:bg-[#f8f2ff]"
              >
                Add New Customer
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px]">
            <label className="space-y-2">
              <span className="text-sm font-semibold text-[#24306c]">Customer Phone</span>
              <input
                type="text"
                disabled={!customer}
                placeholder={customer ? '' : 'Select a customer first'}
                value={customerForm.customer_phone}
                onChange={(e) =>
                  setCustomerForm((current) => ({ ...current, customer_phone: e.target.value }))
                }
                className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-4 py-3 text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <label className="space-y-2">
              <span className="text-sm font-semibold text-[#24306c]">Customer GSTIN</span>
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
                className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-4 py-3 text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff] disabled:cursor-not-allowed disabled:opacity-60"
              />
            </label>

            <div className="flex items-end">
              {customer && (
                <button
                  type="button"
                  onClick={clearSelectedCustomer}
                  className="flex h-[50px] items-center justify-center gap-2 rounded-2xl border border-[#f0d2d2] bg-white px-4 text-sm font-semibold text-[#d16464] transition-all hover:bg-[#fff4f4]"
                >
                  <X size={16} />
                  Clear Customer
                </button>
              )}
            </div>
          </div>

          <label className="mt-4 block space-y-2">
            <span className="text-sm font-semibold text-[#24306c]">Customer Address</span>
            <input
              type="text"
              disabled={!customer}
              placeholder={customer ? '' : 'Select a customer first'}
              value={customerForm.customer_address}
              onChange={(e) =>
                setCustomerForm((current) => ({ ...current, customer_address: e.target.value }))
              }
              className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-4 py-3 text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="mt-4 space-y-2">
            <label className="text-sm font-semibold text-[#24306c]">Item Search</label>
            <div className="relative">
              <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[#9a94c9]" size={20} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
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
                      addItem(exactMatch || firstMatch);
                      setSearch('');
                      return;
                    }

                    if (search.trim()) {
                      const shouldCreate = window.confirm(
                        `"${search.trim()}" does not exist. Do you want to add this item and continue?`
                      );
                      if (shouldCreate) {
                        openCreateItemModal(search.trim());
                      }
                    }
                  }
                }}
                placeholder="Search by item name or HSN"
                className="w-full rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] py-3 pl-12 pr-4 text-[#1d285f] outline-none transition-all focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
              />
            </div>
            <p className="text-xs text-[#7068a2]">Tap or click a result to add it to the current bill.</p>
          </div>

          <div className="mt-5 flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="flex flex-wrap gap-2 xl:max-w-[calc(100%-280px)]">
              {items.slice(0, 10).map((item) => (
                <button
                  key={item.id}
                  onClick={() => addItem(item)}
                  className="rounded-2xl border border-[#e6deff] bg-[#fbf9ff] px-4 py-2 text-left transition-all hover:border-[#cdb9ff] hover:bg-[#f5f0ff]"
                >
                  <p className="text-sm font-semibold text-[#1d285f]">{item.name}</p>
                  <p className="text-xs text-[#7d75ac]">
                    HSN {item.hsn_code || '-'} | Rs. {item.price.toFixed(2)}
                  </p>
                </button>
              ))}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row xl:flex-col xl:min-w-[240px]">
              {editingCartId === activeCart?.id ? (
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
                  className="rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-4 py-3 font-semibold text-[#1d285f] outline-none focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
                  placeholder="Bill name"
                />
              ) : (
                <div className="flex items-center justify-between gap-3 rounded-2xl border border-[#e6deff] bg-[#fbf9ff] px-4 py-3">
                  <div>
                    <p className="text-sm font-bold text-[#1d285f]">{activeCart?.name || 'Current Bill'}</p>
                    <p className="text-xs text-[#7d75ac]">{cartItems.length} active items</p>
                  </div>
                  <button
                    onClick={() => activeCart && handleStartRename(activeCart.id, activeCart.name)}
                    className="rounded-xl p-2 text-[#7d75ac] transition-all hover:bg-white hover:text-[#5534b7]"
                    aria-label="Rename bill"
                  >
                    <Edit2 size={16} />
                  </button>
                </div>
              )}

              <button
                onClick={clearCart}
                className="flex items-center justify-center gap-2 rounded-2xl border border-[#f3d6d6] bg-white px-4 py-3 text-sm font-semibold text-[#d16464] transition-all hover:bg-[#fff5f5]"
              >
                <Trash2 size={16} />
                Clear Bill
              </button>
            </div>
          </div>

          {(search || filteredItems.length > 0) && (
            <div className="mt-4 rounded-[1.75rem] border border-[#e5ddff] bg-[#fffdf9] p-4">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm font-bold text-[#24306c]">Quick Add Results</p>
                {search.trim() && filteredItems.length === 0 && (
                  <button
                    type="button"
                    onClick={() => openCreateItemModal(search.trim())}
                    className="rounded-xl border border-[#d4c6ff] bg-white px-3 py-1.5 text-xs font-semibold text-[#5a3fc0] transition-all hover:bg-[#f8f2ff]"
                  >
                    Create "{search.trim()}"
                  </button>
                )}
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                <AnimatePresence>
                  {filteredItems.map((item) => (
                    <motion.button
                      key={item.id}
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: 4 }}
                      onClick={() => {
                        addItem(item);
                        setSearch('');
                      }}
                      className="rounded-2xl border border-[#e7defd] bg-[#f9f5ff] p-4 text-left transition-all hover:border-[#cdb9ff] hover:bg-[#f4edff]"
                    >
                      <p className="text-sm font-bold text-[#1d285f]">{item.name}</p>
                      <p className="mt-1 text-xs text-[#7168a4]">HSN {item.hsn_code || '-'}</p>
                      <p className="mt-2 text-xs text-[#7168a4]">
                        Rs. {item.price.toFixed(2)} / {item.metric}
                      </p>
                    </motion.button>
                  ))}
                </AnimatePresence>
                {search.trim() && filteredItems.length === 0 && (
                  <button
                    type="button"
                    onClick={() => openCreateItemModal(search.trim())}
                    className="rounded-2xl border border-dashed border-[#ccb9ff] bg-[#faf7ff] p-4 text-left transition-all hover:border-[#b89dff] hover:bg-[#f4edff]"
                  >
                    <p className="text-sm font-bold text-[#1d285f]">Item not found</p>
                    <p className="mt-1 text-xs text-[#7168a4]">
                      Click to add "{search.trim()}" and continue billing.
                    </p>
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="mt-8">
            <div className="mb-3">
              <h3 className="text-2xl font-black text-[#111c5a]">Bill Items</h3>
              <p className="mt-1 text-sm text-[#5c6797]">
                The billing table now follows the same clean structure as purchase entry, with HSN, metric, GST, and total clearly visible.
              </p>
            </div>

            <div className="overflow-hidden rounded-[1.8rem] border border-[#e5ddff] bg-[#fffdf9]">
              <div className="hidden grid-cols-[minmax(220px,2fr)_120px_120px_150px_150px_170px_150px_72px] gap-4 border-b border-[#efe8ff] bg-[#f3f1ff] px-4 py-4 text-xs font-bold uppercase tracking-wide text-[#56609a] lg:grid">
                <div>Item</div>
                <div>HSN</div>
                <div>Metric</div>
                <div>Qty</div>
                <div>Unit Price</div>
                <div>GST</div>
                <div>Line Total</div>
                <div />
              </div>

              {cartItems.length === 0 ? (
                <div className="flex min-h-[280px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
                  <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[#f6f1ff] text-[#8a80be]">
                    <ShoppingCart size={38} />
                  </div>
                  <div>
                    <p className="text-lg font-bold text-[#24306c]">Your bill is empty</p>
                    <p className="mt-1 text-sm text-[#7a73a6]">
                      Search by item name or HSN above and click an item to add it here.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[#f0e9ff]">
                  {cartItems.map((item) => {
                    const taxDisplay = getTaxDisplay(item);

                    return (
                      <motion.div
                        layout
                        key={item.id}
                        className="grid gap-4 px-4 py-5 lg:grid-cols-[minmax(220px,2fr)_120px_120px_150px_150px_170px_150px_72px] lg:items-center"
                      >
                        <div>
                          <p className="font-bold text-[#1d285f]">{item.name}</p>
                          <p className="mt-1 text-xs text-[#7a73a6]">
                            Base Rs. {item.price.toFixed(2)} / {item.metric}
                          </p>
                        </div>

                        <div className="rounded-2xl border border-[#e4dbff] bg-[#f8f5ff] px-3 py-3 text-sm text-[#5b538d]">
                          {item.hsn_code || '-'}
                        </div>

                        <div className="rounded-2xl border border-[#e4dbff] bg-[#f8f5ff] px-3 py-3 text-sm text-[#5b538d]">
                          {item.metric || '-'}
                        </div>

                        <div className="flex items-center gap-2 rounded-2xl border border-[#ddd3ff] bg-[#f9f7ff] px-2 py-2">
                          <button
                            onClick={() => updateQuantity(item.id, Math.max(0, item.quantity - 1))}
                            className="rounded-xl p-2 text-[#655d93] transition-all hover:bg-white"
                          >
                            <Minus size={16} />
                          </button>
                          <input
                            type="text"
                            inputMode="decimal"
                            value={getQuantityInputValue(item.id, item.quantity)}
                            onChange={(e) => handleQuantityInputChange(item.id, e.target.value)}
                            onBlur={() => handleQuantityInputBlur(item.id, item.quantity)}
                            onFocus={(e) => e.target.select()}
                            className="w-full bg-transparent text-center text-sm font-bold text-[#1d285f] outline-none"
                          />
                          <button
                            onClick={() => updateQuantity(item.id, item.quantity + 1)}
                            className="rounded-xl p-2 text-[#655d93] transition-all hover:bg-white"
                          >
                            <Plus size={16} />
                          </button>
                        </div>

                        <div className="rounded-2xl border border-[#e4dbff] bg-[#f8f5ff] px-3 py-3 text-sm font-semibold text-[#1d285f]">
                          Rs. {item.original_price.toFixed(2)}
                        </div>

                        <div className="rounded-2xl border border-[#e4dbff] bg-[#f8f5ff] px-3 py-3">
                          <p className="text-sm font-semibold text-[#1d285f]">{taxDisplay.label}</p>
                          <p className="mt-1 text-[11px] text-[#7b73aa]">{taxDisplay.breakdown}</p>
                          <p className="mt-1 text-[11px] text-[#7b73aa]">
                            Tax Rs. {(item.sgst_amount + item.cgst_amount + item.igst_amount).toFixed(2)}
                          </p>
                        </div>

                        <div className="text-right">
                          <p className="text-xl font-black text-[#0f1d59]">Rs. {item.total_amount.toFixed(2)}</p>
                          <p className="mt-1 text-[11px] text-[#7b73aa]">
                            {item.quantity} x Rs. {item.original_price.toFixed(2)}
                          </p>
                        </div>

                        <div className="flex justify-end">
                          <button
                            onClick={() => removeItem(item.id)}
                            className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[#f2d6d6] bg-white text-[#d16464] transition-all hover:bg-[#fff5f5]"
                          >
                            <Trash2 size={18} />
                          </button>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="mt-8 grid gap-4 xl:grid-cols-3">
            <div className="rounded-[1.6rem] border border-[#ddd3ff] bg-[#f4f2ff] px-6 py-5">
              <p className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Subtotal</p>
              <p className="mt-3 text-4xl font-black text-[#0f1d59]">Rs. {totals.subtotal.toFixed(2)}</p>
            </div>
            <div className="rounded-[1.6rem] border border-[#ddd3ff] bg-[#f4f2ff] px-6 py-5">
              <p className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">GST Total</p>
              <p className="mt-3 text-4xl font-black text-[#ef7a00]">Rs. {totals.tax.toFixed(2)}</p>
              <p className="mt-2 text-xs text-[#7a73a6]">Discount applied: Rs. {discount.toFixed(2)}</p>
            </div>
            <div className="rounded-[1.6rem] border border-[#ddd3ff] bg-[#f4f2ff] px-6 py-5">
              <p className="text-xs font-bold uppercase tracking-wide text-[#2433a3]">Grand Total</p>
              <p className="mt-3 text-4xl font-black text-[#2433a3]">Rs. {totals.total.toFixed(2)}</p>
            </div>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="rounded-[1.8rem] border border-[#e5ddff] bg-[#fffdf9] p-6">
              <p className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Payment Method</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
                      "flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-all",
                      paymentMethod === method.id
                        ? "border-transparent bg-gradient-to-r from-[#232d9b] via-[#5534b7] to-[#b153d7] text-white"
                        : "border-[#e5ddff] bg-[#f8f5ff] text-[#544c83]",
                      method.disabled && "cursor-not-allowed opacity-40 grayscale"
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
                <div className="mt-5 grid gap-3 rounded-[1.5rem] border border-[#e6deff] bg-[#f7f3ff] p-4 md:grid-cols-3">
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Cash</label>
                    <input
                      type="number"
                      value={paymentAmounts.cash || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setPaymentAmount('cash', Number(e.target.value))}
                      className="mt-2 w-full rounded-2xl border border-[#ddd3ff] bg-white px-4 py-3 font-semibold text-[#1d285f] outline-none focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">UPI</label>
                    <input
                      type="number"
                      value={paymentAmounts.upi || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setPaymentAmount('upi', Number(e.target.value))}
                      className="mt-2 w-full rounded-2xl border border-[#ddd3ff] bg-white px-4 py-3 font-semibold text-[#1d285f] outline-none focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff]"
                    />
                  </div>
                  <div>
                    <label className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Credit</label>
                    <input
                      type="number"
                      disabled={!customer}
                      value={paymentAmounts.credit || ''}
                      onFocus={(e) => e.target.select()}
                      onChange={(e) => setPaymentAmount('credit', Number(e.target.value))}
                      className="mt-2 w-full rounded-2xl border border-[#ddd3ff] bg-white px-4 py-3 font-semibold text-[#1d285f] outline-none focus:border-[#b89dff] focus:ring-2 focus:ring-[#d7c9ff] disabled:bg-[#f1edf8]"
                    />
                  </div>
                  <div className="flex items-center justify-between rounded-2xl border border-[#ddd3ff] bg-white px-4 py-3 md:col-span-3">
                    <span className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Remaining</span>
                    <span
                      className={cn(
                        "text-sm font-bold",
                        Math.abs(totals.total - (paymentAmounts.cash + paymentAmounts.upi + paymentAmounts.credit)) < 0.01
                          ? "text-green-600"
                          : "text-red-500"
                      )}
                    >
                      Rs. {(totals.total - (paymentAmounts.cash + paymentAmounts.upi + paymentAmounts.credit)).toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col justify-between rounded-[1.8rem] border border-[#e5ddff] bg-white p-6 shadow-sm">
              <div>
                <p className="text-xs font-bold uppercase tracking-wide text-[#5f68a1]">Ready To Bill</p>
                <p className="mt-3 text-3xl font-black text-[#0f1d59]">Rs. {totals.total.toFixed(2)}</p>
                <p className="mt-2 text-sm text-[#7a73a6]">
                  {customer ? `Billing for ${customerDisplayName(customer)}` : 'Walk-in billing is active'}
                </p>
              </div>

              <button
                onClick={handleCompleteSale}
                disabled={cartItems.length === 0 || isProcessing}
                className="mt-6 flex w-full items-center justify-center gap-3 rounded-[1.4rem] bg-[#2733a6] px-5 py-4 text-lg font-black text-white shadow-[0_18px_35px_rgba(39,51,166,0.22)] transition-all hover:brightness-105 disabled:opacity-50"
              >
                <Printer size={22} />
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

      {showCreateItemModal && (
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/25 p-6 backdrop-blur-sm">
          <div className="w-full max-w-2xl overflow-hidden rounded-3xl bg-white shadow-2xl">
            <form onSubmit={handleCreateItem}>
              <div className="flex items-center justify-between border-b border-gray-100 p-8">
                <div>
                  <h3 className="text-2xl font-bold text-gray-900">Add New Item</h3>
                  <p className="mt-1 text-sm text-gray-500">
                    This item was not found. Add it now and continue billing.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateItemModal(false)}
                  className="rounded-full p-2 transition-all hover:bg-gray-100"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="grid max-h-[70vh] grid-cols-2 gap-6 overflow-auto p-8">
                <div className="col-span-2 space-y-2">
                  <label className="text-sm font-bold text-gray-700">Item Name</label>
                  <input
                    type="text"
                    value={newItemForm.name || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, name: e.target.value }))}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">HSN Code</label>
                  <input
                    type="text"
                    value={newItemForm.hsn_code || ''}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, hsn_code: e.target.value }))}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Total Cost (Incl. GST) (Rs.)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={newItemForm.price || ''}
                    onChange={(e) =>
                      setNewItemForm((current) => ({
                        ...current,
                        price: e.target.value === '' ? 0 : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">Metric</label>
                  <select
                    value={newItemForm.metric || 'piece'}
                    onChange={(e) => setNewItemForm((current) => ({ ...current, metric: e.target.value }))}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
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
                    onChange={(e) =>
                      setNewItemForm((current) => ({
                        ...current,
                        stock_quantity: e.target.value === '' ? 0 : Number(e.target.value),
                      }))
                    }
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-bold text-gray-700">GST Type</label>
                  <select
                    value={newItemForm.gst_mode || 'split'}
                    onChange={(e) =>
                      setNewItemForm((current) => ({
                        ...current,
                        gst_mode: e.target.value as 'split' | 'igst',
                      }))
                    }
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
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
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    {GST_OPTIONS.map((rate) => (
                      <option key={rate} value={rate}>
                        {rate}%
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500">
                    {(newItemForm.gst_mode || 'split') === 'split'
                      ? `${Number(newItemForm.gst_rate || 0) / 2}% SGST + ${Number(newItemForm.gst_rate || 0) / 2}% CGST`
                      : `${Number(newItemForm.gst_rate || 0)}% IGST`}
                  </p>
                </div>
              </div>

              <div className="flex gap-4 border-t border-gray-100 bg-gray-50 p-8">
                <button
                  type="button"
                  onClick={() => setShowCreateItemModal(false)}
                  className="flex-1 rounded-2xl border border-gray-200 bg-white py-4 font-bold text-gray-600 transition-all hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 rounded-2xl bg-orange-600 py-4 font-bold text-white shadow-lg shadow-orange-100 transition-all hover:bg-orange-700"
                >
                  Save Item And Continue
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
