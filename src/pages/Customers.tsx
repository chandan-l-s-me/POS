import React, { useState, useMemo } from 'react';
import { useDataStore } from '../store/useDataStore';
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
  CreditCard
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Customer } from '../types';
import { cn } from '../lib/utils';

export const Customers = () => {
  const { customers, addCustomer, updateCustomer } = useDataStore();
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

  const filteredCustomers = useMemo(() => {
    return customers.filter(c => 
      c.name.toLowerCase().includes(search.toLowerCase()) || 
      c.phone.includes(search) ||
      c.shop_name?.toLowerCase().includes(search.toLowerCase())
    );
  }, [customers, search]);

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
    try {
      if (editingCustomer) {
        await api.updateCustomer(editingCustomer.id, formData);
        updateCustomer({ ...editingCustomer, ...formData } as Customer);
      } else {
        const result = await api.addCustomer(formData);
        addCustomer({ ...formData, id: result.id, created_at: new Date().toISOString() } as Customer);
      }
      setShowModal(false);
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
            placeholder="Search customers..."
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

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredCustomers.map(customer => (
          <motion.div
            layout
            key={customer.id}
            className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 group hover:shadow-md transition-all"
          >
            <div className="flex justify-between items-start mb-6">
              <div className="w-14 h-14 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center font-bold text-xl">
                {customer.name[0].toUpperCase()}
              </div>
              <button 
                onClick={() => handleOpenModal(customer)}
                className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
              >
                <Edit2 size={18} />
              </button>
            </div>

            <h4 className="font-bold text-xl text-gray-900 mb-1">{customer.name}</h4>
            {customer.shop_name && (
              <p className="text-sm font-semibold text-orange-600 mb-4">{customer.shop_name}</p>
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
              <button className="p-2 text-gray-400 hover:text-orange-600 transition-all">
                <CreditCard size={20} />
              </button>
            </div>
          </motion.div>
        ))}
      </div>

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
                    <label className="text-sm font-bold text-gray-700">Customer Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-6">
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
                    <div className="space-y-2">
                      <label className="text-sm font-bold text-gray-700">Shop Name</label>
                      <input
                        type="text"
                        value={formData.shop_name}
                        onChange={(e) => setFormData({ ...formData, shop_name: e.target.value })}
                        className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
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
