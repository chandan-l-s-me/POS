import { useAuthStore } from '../store/useAuthStore';
import type { StaffAccount, User } from '../types';

const API_BASE = '/api';

export interface ListQuery {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
  search?: string;
  withImages?: 1;
  order?: 'asc' | 'desc';
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

export interface ApiError extends Error {
  status?: number;
  code?: string;
}

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
    // Carry the status and the server's reason code, so a caller can tell
    // "prices changed, refresh" (409 PRICE_CHANGED) from a plain failure.
    const error = new Error(data?.error || `Request failed with status ${response.status}`) as ApiError;
    error.status = response.status;
    error.code = data?.code;
    throw error;
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
  getGoogleDriveStatus: () => fetchWithAuth('/backups/google/status'),
  /** Returns the Google sign-in URL to send the browser to. */
  connectGoogleDrive: () => fetchWithAuth('/backups/google/connect', { method: 'POST' }),
  disconnectGoogleDrive: () => fetchWithAuth('/backups/google/disconnect', { method: 'POST' }),
  // Staff accounts, admins and cashiers. The role is set once, at creation.
  getUsers: (): Promise<StaffAccount[]> => fetchWithAuth('/users'),
  addUser: (account: { name: string; username: string; password: string; role: User['role'] }): Promise<StaffAccount> =>
    fetchWithAuth('/users', { method: 'POST', body: JSON.stringify(account) }),
  updateUser: (id: number, payload: { is_active?: boolean; new_password?: string }): Promise<StaffAccount> =>
    fetchWithAuth(`/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  /** Only an account that was never used; others are deactivated instead. */
  deleteUser: (id: number) => fetchWithAuth(`/users/${id}`, { method: 'DELETE' }),
  
  // The catalogue is cached client-side so the billing screen can match a
  // scanned code without a round trip. It ships lean columns by default;
  // the Items admin screen asks for the full row (including image_url).
  getItems: (params?: ListQuery) => fetchWithAuth(`/items${buildQuery(params)}`).then(unwrap),
  getItemsPage: (params?: ListQuery) => fetchWithAuth(`/items${buildQuery(params)}`),
  // No addItem: items are created only as new lines of a saved purchase.
  updateItem: (id: number, item: any) => fetchWithAuth(`/items/${id}`, { method: 'PUT', body: JSON.stringify(item) }),
  deleteItem: (id: number) => fetchWithAuth(`/items/${id}`, { method: 'DELETE' }),
  /** An item's stock batch by batch, oldest (next to sell) first. */
  getItemBatches: (id: number, options: { all?: boolean } = {}) =>
    fetchWithAuth(`/items/${id}/batches${options.all ? '?all=1' : ''}`),
  /** Add (quantity > 0) or remove (quantity < 0) stock, with a reason. */
  adjustStock: (id: number, payload: { quantity: number; reason: string; unit_cost?: number; selling_price?: number }) =>
    fetchWithAuth(`/items/${id}/stock-adjustments`, { method: 'POST', body: JSON.stringify(payload) }),
  repriceBatch: (batchId: number, sellingPrice: number) =>
    fetchWithAuth(`/stock-batches/${batchId}`, { method: 'PUT', body: JSON.stringify({ selling_price: sellingPrice }) }),

  getCustomers: (params?: ListQuery) => fetchWithAuth(`/customers${buildQuery(params)}`).then(unwrap),
  getCustomersPage: (params?: ListQuery) => fetchWithAuth(`/customers${buildQuery(params)}`),
  getStats: () => fetchWithAuth('/stats'),
  addCustomer: (customer: any) => fetchWithAuth('/customers', { method: 'POST', body: JSON.stringify(customer) }),
  updateCustomer: (id: number, customer: any) => fetchWithAuth(`/customers/${id}`, { method: 'PUT', body: JSON.stringify(customer) }),

  /** A customer's passbook: every bill, payment and correction, with the balance after each. */
  getCustomerPassbook: (id: number, params?: ListQuery) =>
    fetchWithAuth(`/customers/${id}/passbook${buildQuery(params)}`),
  /** A customer's credit statement: every change to what they owe. */
  getCustomerCreditEntries: (id: number, params?: ListQuery) =>
    fetchWithAuth(`/customers/${id}/credit-entries${buildQuery(params)}`),
  /** What customers owe: unpaid credit bills by customer, oldest first, with ageing. */
  getSalesCredit: () => fetchWithAuth('/sales-credit'),
  recordCreditPayment: (id: number, payload: { amount: number; note?: string }) =>
    fetchWithAuth(`/customers/${id}/credit-payments`, { method: 'POST', body: JSON.stringify(payload) }),

  getSuppliers: () => fetchWithAuth('/suppliers'),
  addSupplier: (supplier: any) => fetchWithAuth('/suppliers', { method: 'POST', body: JSON.stringify(supplier) }),
  updateSupplier: (id: number, supplier: any) => fetchWithAuth(`/suppliers/${id}`, { method: 'PUT', body: JSON.stringify(supplier) }),

  getBills: (params?: ListQuery) => fetchWithAuth(`/bills${buildQuery(params)}`).then(unwrap),
  getBillsPage: (params?: ListQuery) => fetchWithAuth(`/bills${buildQuery(params)}`),
  getBill: (id: number) => fetchWithAuth(`/bills/${id}`),
  createBill: (bill: any) => fetchWithAuth('/bills', { method: 'POST', body: JSON.stringify(bill) }),

  // Quick Bill (phone app)
  /** What this customer usually buys, and the shop's best sellers. */
  getQuickItems: (customerId?: number | null) =>
    fetchWithAuth(`/quick-items${customerId ? `?customer_id=${customerId}` : ''}`),
  /** A customer's most recent bill, item by item, for "repeat last order". */
  getLastOrder: (customerId: number) => fetchWithAuth(`/customers/${customerId}/last-order`),

  // Counter print queue
  requestCounterPrint: (billId: number) => fetchWithAuth(`/bills/${billId}/print-requests`, { method: 'POST' }),
  getPrintJobs: () => fetchWithAuth('/print-jobs'),
  getPrintJob: (id: number) => fetchWithAuth(`/print-jobs/${id}`),
  claimPrintJob: (id: number) => fetchWithAuth(`/print-jobs/${id}/claim`, { method: 'POST' }),
  /** Delete a bill: its stock goes back to the batches it came from and its credit comes off the customer. Admin. */
  deleteBill: (id: number) => fetchWithAuth(`/bills/${id}`, { method: 'DELETE' }),

  getPurchases: (params?: ListQuery) => fetchWithAuth(`/purchases${buildQuery(params)}`).then(unwrap),
  /** One page of purchases with the total count, for Purchase history. */
  getPurchasesPage: (params?: ListQuery) => fetchWithAuth(`/purchases${buildQuery(params)}`),
  getPurchase: (id: number) => fetchWithAuth(`/purchases/${id}`),
  createPurchase: (purchase: any) => fetchWithAuth('/purchases', { method: 'POST', body: JSON.stringify(purchase) }),

  /** Everything still owed to suppliers, by supplier, oldest invoice first. */
  getPurchaseCredit: () => fetchWithAuth('/purchase-credit'),
  /** Fully paid purchases; `from`/`to` bound the day they were cleared. */
  getPaidPurchases: (params?: ListQuery) => fetchWithAuth(`/paid-purchases${buildQuery(params)}`),
  getSupplierPayments: (params?: ListQuery & { supplier_id?: number }) =>
    fetchWithAuth(`/supplier-payments${buildQuery(params as ListQuery)}`),
  /** Pay a supplier: against one purchase, or their oldest unpaid purchases first. */
  recordSupplierPayment: (payload: {
    supplier_id?: number; purchase_id?: number; amount: number; paid_on?: string;
    method?: string; reference?: string; note?: string;
  }) => fetchWithAuth('/supplier-payments', { method: 'POST', body: JSON.stringify(payload) }),
  deleteSupplierPayment: (id: number) => fetchWithAuth(`/supplier-payments/${id}`, { method: 'DELETE' }),
  getPurchaseItemReport: (params?: ListQuery) =>
    fetchWithAuth(`/reports/purchase-items${buildQuery(params)}`).then(unwrap),
  getSalesItemReport: (params?: ListQuery) =>
    fetchWithAuth(`/reports/sales-items${buildQuery(params)}`).then(unwrap),

  getAnalytics: () => fetchWithAuth('/analytics'),
  /** Every item's stock: status against the low-stock threshold, value, rate of sale. */
  getStock: () => fetchWithAuth('/stock'),
  getAuditLogs: (params?: ListQuery) => fetchWithAuth(`/audit-logs${buildQuery(params)}`).then(unwrap),
  getAuditLogsPage: (params?: ListQuery) => fetchWithAuth(`/audit-logs${buildQuery(params)}`),
};
