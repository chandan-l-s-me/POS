import { create } from 'zustand';
import { api } from '../api';
import { Item, Customer, ShopSettings } from '../types';

/**
 * How many items the shared catalogue cache holds.
 *
 * The billing screen matches scanned codes against this cache, so every place
 * that refreshes it must load the same way. They did not: two callers in
 * Purchases used `api.getItems()` with no arguments, which the server answers
 * with its default page of 100. That replaced the 1000-item cache with 100
 * rows and left `itemsComplete` true, so billing neither had the items nor
 * fell back to server-side search — most of the catalogue simply stopped being
 * findable at the till. Everything now goes through `refreshItems` below.
 */
export const ITEM_CACHE_LIMIT = 1000;

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
  /** Row counts from the server, so the sidebar badges stay correct even
   *  when a page has not loaded the full list into memory. */
  stats: { items: number; customers: number };
  setStats: (stats: { items: number; customers: number }) => void;
  /** False when the server has more rows than the cache holds, which is the
   *  signal to fall back to server-side search instead of filtering locally. */
  itemsComplete: boolean;
  setItemsComplete: (complete: boolean) => void;
  setItems: (items: Item[]) => void;
  /** Reload the shared catalogue cache. The only supported way to refresh it. */
  refreshItems: () => Promise<void>;
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
  stats: { items: 0, customers: 0 },
  setStats: (stats) => set({ stats }),
  itemsComplete: true,
  setItemsComplete: (itemsComplete) => set({ itemsComplete }),
  setItems: (items) => set({ items }),
  refreshItems: async () => {
    const res = await api.getItemsPage({ limit: ITEM_CACHE_LIMIT });
    const rows: Item[] = res?.data ?? [];
    set({
      items: rows,
      // False when the shop has more items than the cache holds, which is the
      // signal for the billing screen to search the server instead.
      itemsComplete: (res?.total ?? rows.length) <= rows.length,
    });
  },
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
