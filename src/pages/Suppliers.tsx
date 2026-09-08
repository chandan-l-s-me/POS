import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import {
  Search,
  Plus,
  Edit2,
  Phone,
  MapPin,
  X,
  Save,
  Truck,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Supplier } from '../types';

export const Suppliers = () => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [search, setSearch] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editingSupplier, setEditingSupplier] = useState<Supplier | null>(null);
  const [formData, setFormData] = useState<Partial<Supplier>>({
    name: '',
    phone: '',
    address: '',
    gstin: '',
  });

  useEffect(() => {
    api.getSuppliers()
      .then((data) => {
        if (!Array.isArray(data)) {
          throw new Error('Suppliers response is invalid. Please restart the app server and try again.');
        }
        setSuppliers(data);
      })
      .catch((err) => {
        console.error('Failed to fetch suppliers:', err);
        alert(`Failed to load suppliers: ${err.message}`);
      });
  }, []);

  const filteredSuppliers = useMemo(() => {
    const query = search.toLowerCase();
    return suppliers.filter((supplier) =>
      supplier.name.toLowerCase().includes(query) ||
      (supplier.phone || '').includes(search) ||
      (supplier.gstin || '').toLowerCase().includes(query)
    );
  }, [suppliers, search]);

  const handleOpenModal = (supplier?: Supplier) => {
    if (supplier) {
      setEditingSupplier(supplier);
      setFormData(supplier);
    } else {
      setEditingSupplier(null);
      setFormData({
        name: '',
        phone: '',
        address: '',
        gstin: '',
      });
    }
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingSupplier) {
        await api.updateSupplier(editingSupplier.id, formData);
        setSuppliers((current) =>
          current.map((supplier) =>
            supplier.id === editingSupplier.id ? { ...editingSupplier, ...formData } as Supplier : supplier
          )
        );
      } else {
        const result = await api.addSupplier(formData);
        setSuppliers((current) => [
          ...current,
          { ...formData, id: result.id, created_at: new Date().toISOString() } as Supplier,
        ]);
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
            placeholder="Search suppliers..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none shadow-sm"
          />
        </div>
        <button
          onClick={() => handleOpenModal()}
          className="flex items-center gap-2 px-6 py-3 bg-orange-600 text-white font-bold rounded-2xl shadow-lg shadow-orange-100 hover:bg-orange-700 transition-all"
        >
          <Plus size={20} />
          Add New Supplier
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {filteredSuppliers.map((supplier) => (
          <motion.div
            layout
            key={supplier.id}
            className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100 group hover:shadow-md transition-all"
          >
            <div className="flex justify-between items-start mb-6">
              <div className="w-14 h-14 bg-orange-100 text-orange-600 rounded-2xl flex items-center justify-center font-bold text-xl">
                {supplier.name[0].toUpperCase()}
              </div>
              <button
                onClick={() => handleOpenModal(supplier)}
                className="p-2 text-gray-400 hover:text-orange-600 hover:bg-orange-50 rounded-lg transition-all"
              >
                <Edit2 size={18} />
              </button>
            </div>

            <h4 className="font-bold text-xl text-gray-900 mb-4">{supplier.name}</h4>

            <div className="space-y-3 mb-6">
              <div className="flex items-center gap-3 text-gray-500 text-sm">
                <Phone size={16} />
                <span>{supplier.phone || 'No phone'}</span>
              </div>
              {supplier.address && (
                <div className="flex items-start gap-3 text-gray-500 text-sm">
                  <MapPin size={16} className="mt-1" />
                  <span className="line-clamp-2">{supplier.address}</span>
                </div>
              )}
              {supplier.gstin && (
                <div className="flex items-center gap-3 text-gray-500 text-sm">
                  <span className="font-bold text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">GST</span>
                  <span>{supplier.gstin}</span>
                </div>
              )}
            </div>

            <div className="pt-6 border-t border-gray-50 flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-400 uppercase font-bold tracking-wider">Supplier</p>
                <p className="text-lg font-black text-orange-600">Active</p>
              </div>
              <Truck size={20} className="text-gray-400" />
            </div>
          </motion.div>
        ))}
      </div>

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
                  <h3 className="font-bold text-2xl">{editingSupplier ? 'Edit Supplier' : 'Add New Supplier'}</h3>
                  <button type="button" onClick={() => setShowModal(false)} className="p-2 hover:bg-gray-100 rounded-full">
                    <X size={24} />
                  </button>
                </div>

                <div className="p-8 space-y-6">
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Supplier Name</label>
                    <input
                      type="text"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                      required
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Phone Number</label>
                    <input
                      type="tel"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">Address</label>
                    <textarea
                      value={formData.address}
                      onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none resize-none h-24"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-bold text-gray-700">GSTIN</label>
                    <input
                      type="text"
                      value={formData.gstin}
                      onChange={(e) => setFormData({ ...formData, gstin: e.target.value.toUpperCase() })}
                      className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:ring-2 focus:ring-orange-500 outline-none"
                    />
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
                    {editingSupplier ? 'Update Supplier' : 'Save Supplier'}
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
