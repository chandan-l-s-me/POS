import { useAuthStore } from '../store/useAuthStore';

const API_BASE = '/api';

export interface ListQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

const buildQuery = (params?: ListQuery) => {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const queryString = search.toString();
  return queryString ? `?${queryString}` : '';
};

/**
 * List endpoints now return `{ data, total, limit, offset }` instead of a bare
 * array, so that a shop with years of bills doesn't ship its entire history in
 * one response. Callers that only need the rows get them here.
 */
const unwrap = (response: any) => (Array.isArray(response) ? response : response?.data ?? []);

async function fetchWithAuth(url: string, options: RequestInit = {}) {
  const token = useAuthStore.getState().token;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${url}`, { ...options, headers });
  const responseText = await response.text();
  let data = null;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = { error: responseText };
    }
  }

  if (!response.ok) {
    if (response.status === 401) {
      useAuthStore.getState().logout();
    }
    throw new Error(data?.error || `Request failed with status ${response.status}`);
  }

  return data;
}

export const api = {
  login: (credentials: any) => fetchWithAuth('/auth/login', { method: 'POST', body: JSON.stringify(credentials) }),

  getSettings: () => fetchWithAuth('/settings'),
  updateSettings: (settings: any) => fetchWithAuth('/settings', { method: 'PUT', body: JSON.stringify(settings) }),
  updateAdminAccount: (account: { username: string; current_password: string; new_password: string }) =>
    fetchWithAuth('/admin/account', { method: 'PUT', body: JSON.stringify(account) }),
  getLocalBackupStatus: () => fetchWithAuth('/backups/local/status'),
  createLocalBackup: () => fetchWithAuth('/backups/local', { method: 'POST' }),
  getCashiers: () => fetchWithAuth('/cashiers'),
  addCashier: (cashier: { name: string; username: string; password: string }) => fetchWithAuth('/cashiers', { method: 'POST', body: JSON.stringify(cashier) }),
  
  getItems: () => fetchWithAuth('/items'),
  addItem: (item: any) => fetchWithAuth('/items', { method: 'POST', body: JSON.stringify(item) }),
  updateItem: (id: number, item: any) => fetchWithAuth(`/items/${id}`, { method: 'PUT', body: JSON.stringify(item) }),
  deleteItem: (id: number) => fetchWithAuth(`/items/${id}`, { method: 'DELETE' }),

  getCustomers: () => fetchWithAuth('/customers'),
  addCustomer: (customer: any) => fetchWithAuth('/customers', { method: 'POST', body: JSON.stringify(customer) }),
  updateCustomer: (id: number, customer: any) => fetchWithAuth(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(customer) }),

  getSuppliers: () => fetchWithAuth('/suppliers'),
  addSupplier: (supplier: any) => fetchWithAuth('/suppliers', { method: 'POST', body: JSON.stringify(supplier) }),
  updateSupplier: (id: number, supplier: any) => fetchWithAuth(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(supplier) }),

  getBills: (params?: ListQuery) => fetchWithAuth(`/bills${buildQuery(params)}`).then(unwrap),
  getBillsPage: (params?: ListQuery) => fetchWithAuth(`/bills${buildQuery(params)}`),
  getBill: (id: number) => fetchWithAuth(`/bills/${id}`),
  createBill: (bill: any) => fetchWithAuth('/bills', { method: 'POST', body: JSON.stringify(bill) }),

  getPurchases: (params?: ListQuery) => fetchWithAuth(`/purchases${buildQuery(params)}`).then(unwrap),
  getPurchase: (id: number) => fetchWithAuth(`/purchases/${id}`),
  createPurchase: (purchase: any) => fetchWithAuth('/purchases', { method: 'POST', body: JSON.stringify(purchase) }),
  getPurchaseItemReport: (params?: ListQuery) =>
    fetchWithAuth(`/reports/purchase-items${buildQuery(params)}`).then(unwrap),
  getSalesItemReport: (params?: ListQuery) =>
    fetchWithAuth(`/reports/sales-items${buildQuery(params)}`).then(unwrap),

  getAnalytics: () => fetchWithAuth('/analytics'),
  getAuditLogs: (params?: ListQuery) => fetchWithAuth(`/audit-logs${buildQuery(params)}`).then(unwrap),
  updateCashier: (id: number, payload: { is_active?: boolean; new_password?: string }) =>
    fetchWithAuth(`/cashiers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
};
