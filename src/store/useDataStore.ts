import { create } from 'zustand';
import { Item, Customer, ShopSettings } from '../types';

export const defaultShopSettings: ShopSettings = {
  id: 1,
  shop_name: 'Bakery POS System',
  shop_address: '123 Bakery Lane, Food City',
  shop_phone: '+91 98765 43210',
  shop_gstin: '27AAAAA0000A1Z5',
  bill_format: 'standard',
  bill_header: 'THANK YOU FOR VISITING!',
  bill_footer: 'Visit again soon',
};

interface DataState {
  items: Item[];
  customers: Customer[];
  settings: ShopSettings;
  setItems: (items: Item[]) => void;
  setCustomers: (customers: Customer[]) => void;
  setSettings: (settings: ShopSettings) => void;
  addItem: (item: Item) => void;
  updateItem: (item: Item) => void;
  removeItem: (id: number) => void;
  addCustomer: (customer: Customer) => void;
  updateCustomer: (customer: Customer) => void;
  removeCustomer: (id: number) => void;
}

export const useDataStore = create<DataState>((set) => ({
  items: [],
  customers: [],
  settings: defaultShopSettings,
  setItems: (items) => set({ items }),
  setCustomers: (customers) => set({ customers }),
  setSettings: (settings) => set({ settings }),
  addItem: (item) => set((state) => ({ items: [...state.items, item] })),
  updateItem: (item) =>
    set((state) => ({
      items: state.items.map((i) => (i.id === item.id ? item : i)),
    })),
  removeItem: (id) =>
    set((state) => ({ items: state.items.filter((i) => i.id !== id) })),
  addCustomer: (customer) =>
    set((state) => ({ customers: [...state.customers, customer] })),
  updateCustomer: (customer) =>
    set((state) => ({
      customers: state.customers.map((c) => (c.id === customer.id ? customer : c)),
    })),
  removeCustomer: (id) =>
    set((state) => ({ customers: state.customers.filter((c) => c.id !== id) })),
}));
