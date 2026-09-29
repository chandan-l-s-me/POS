import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import {
  Search,
  Plus,
  Edit2,
  User,
  Phone,
  MapPin,
  X,
  Save,
  BookOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Customer } from '../types';
import { cn } from '../lib/utils';
import { customerContactName, customerDisplayName, customerInitial } from '../lib/customer';

export const Customers = () => {
  // Local rows, for the same reason as the Items screen: this page loads one
  // 50-row page at a time, and writing that into the shared store replaced the
  // customer list the billing screen's picker reads.
  const [rows, setRows] = useState<Customer[]>([]);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [formData, setFormData] = useState<Partial<Customer>>({
    name: '',
    phone: '',
    shop_name: '',
    address: '',
    gstin: '',
    credit_balance: 0
  });

  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const [appliedSearch, setAppliedSearch] = useState('');
  const PAGE_SIZE = 50;

  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  // Search and paging in SQL, so a customer beyond the first page is still
  // reachable instead of silently absent.
  const reload = useCallback(() => {
    return api.getCustomersPage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, search: appliedSearch || undefined })
      .then((res) => { setRows(res?.data ?? []); setTotal(res?.total ?? 0); setLoadError(''); })
      .catch((err: any) => setLoadError(err?.message || 'Could not load customers.'));
  }, [page, appliedSearch]);

  useEffect(() => { reload(); }, [reload]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The server already applied the search.
  const filteredCustomers = rows;

  const handleOpenModal = (customer?: Customer) => {
    if (customer) {
      setEditingCustomer(customer);
      setFormData(customer);
    } else {
      setEditingCustomer(null);
      setFormData({
        name: '',
        phone: '',
        shop_name: '',
        address: '',
        gstin: '',
        credit_balance: 0
      });
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.shop_name?.trim() && !formData.name?.trim()) {
      alert('Enter the bakery / shop name, or the customer’s name if they have no shop.');
      return;
    }
    try {
      if (editingCustomer) {
        await api.updateCustomer(editingCustomer.id, formData);
      } else {
        await api.addCustomer(formData);
      }
      setShowModal(false);
      // Re-read, so the row shows what the server stored — a cashier's attempt
      // to set a credit balance, for instance, is ignored server-side and the
      // list must not pretend otherwise.
      await reload();
    } catch (err: any) {
      alert(err.message);
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
            placeholder="Search by bakery / shop, name or phone..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 px-6 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
        >
          <Plus size={20} />
          Add New Customer
        </button>
      </div>

      {loadError && (
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-100 bg-red-50 px-6 py-4">
          <p className="font-medium text-red-600">{loadError}</p>
          <button
            onClick={() => reload()}
            className="rounded-xl bg-white px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-100"
          >
            Retry
          </button>
        </div>
      )}

      {!loadError && filteredCustomers.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-gray-400">
          <User size={40} />
          <p className="font-medium">No customers found</p>
          <p className="text-sm">{search ? 'Try searching for something else' : 'Customers will appear here once added'}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredCustomers.map(customer => (
          <motion.div
            layout
            key={customer.id}
            className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 group hover:shadow-md transition-all"
          >
            <div className="flex justify-between items-start mb-6">
              <div className="w-14 h-14 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center font-bold text-xl">
                {customerInitial(customer)}
              </div>
              <button 
                onClick={() => handleOpenModal(customer)}
                className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
              >
                <Edit2 size={18} />
              </button>
            </div>

            {/* The bakery/shop is how this shop knows the customer, so it is
                the heading; the person's name is who to ask for. A customer
                with no shop is headed by their own name. */}
            <h4 className="font-bold text-xl text-gray-900 mb-1">
              <Link to={`/customers/${customer.id}`} className="hover:underline">
                {customerDisplayName(customer)}
              </Link>
            </h4>
            {customerContactName(customer) && (
              <p className="flex items-center gap-1.5 text-sm font-semibold text-orange-600 mb-4">
                <User size={14} />
                {customerContactName(customer)}
              </p>
            )}

            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-3 text-gray-500 text-sm">
                <Phone size={16} />
                <span>{customer.phone}</span>
              </div>
              {customer.address && (
                <div className="flex items-start gap-3 text-gray-500 text-sm">
                  <MapPin size={16} className="mt-1" />
                  <span className="line-clamp-2">{customer.address}</span>
                </div>
              )}
              {customer.gstin && (
                <div className="flex items-center gap-3 text-gray-500 text-sm">
                  <span className="font-bold text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">GST</span>
                  <span>{customer.gstin}</span>
                </div>
              )}
            </div>

            <div className="pt-6 border-t border-gray-50 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">Credit Balance</p>
                <p className={cn(
                  "text-lg font-black",
                  customer.credit_balance > 0 ? "text-red-500" : "text-green-500"
                )}>
                  ₹{customer.credit_balance.toFixed(2)}
                </p>
              </div>
              <Link
                to={`/customers/${customer.id}`}
                className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs font-bold text-gray-600 transition-all hover:bg-gray-100"
                title="Every bill, payment and balance change for this customer"
              >
                <BookOpen size={16} />
                Passbook
              </Link>
            </div>
          </motion.div>
        ))}
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

      {/* Customer Modal */}
      <AnimatePresence>
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/20 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden"
            >
              <form onSubmit={handleSubmit}>
                <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                  <h3 className="font-bold text-2xl">{editingCustomer ? 'Edit Customer' : 'Add New Customer'}</h3>
                  <button type="button" onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>

                <div className="p-8 space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Bakery / Shop Name</label>
                    <input
                      type="text"
                      value={formData.shop_name || ''}
                      onChange={(e) => setFormData({ ...formData, shop_name: e.target.value })}
                      placeholder="e.g. Sri Ganesh Bakery"
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                    <p className="text-xs text-gray-500">Leave blank if the customer has no bakery or shop.</p>
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-gray-700">
                        Customer / Contact Name
                        {formData.shop_name?.trim() ? (
                          <span className="ml-1 font-normal text-gray-400">(optional)</span>
                        ) : null}
                      </label>
                      <input
                        type="text"
                        value={formData.name || ''}
                        onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                        placeholder={formData.shop_name?.trim() ? 'Who to ask for' : 'Required if no bakery / shop'}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-gray-700">Phone Number</label>
                      <input
                        type="tel"
                        value={formData.phone}
                        onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                        required
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Address</label>
                    <textarea
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none resize-none h-24"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-gray-700">GSTIN</label>
                      <input
                        type="text"
                        value={formData.gstin}
                        onChange={(e) => setFormData({ ...formData, gstin: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-gray-700">Credit Balance (₹)</label>
                      <input
                        type="number"
                        value={formData.credit_balance || ''}
                        onFocus={(e) => e.target.select()}
                        onChange={(e) => setFormData({ ...formData, credit_balance: e.target.value === '' ? 0 : Number(e.target.value) })}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      />
                    </div>
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
                    {editingCustomer ? 'Update Customer' : 'Save Customer'}
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
