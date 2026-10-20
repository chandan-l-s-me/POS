export interface User {
  id: number;
  username: string;
  role: 'admin' | 'cashier';
  name: string;
}

/** A user as the staff list shows it. SQLite hands booleans back as 0/1. */
export interface StaffAccount extends User {
  is_active: number;
  /** 1 once the account has signed in or made any record; it can then only be deactivated. */
  in_use?: number;
}

export interface AuditLog {
  id: number;
  user_id: number;
  user_name: string;
  user_role: 'admin' | 'cashier';
  action: string;
  entity_type: string;
  entity_id?: string;
  details: string;
  created_at: string;
}

export interface ShopSettings {
  id: number;
  shop_name: string;
  shop_address: string;
  shop_phone: string;
  shop_gstin: string;
  bill_format: 'thermal' | 'standard';
  bill_header: string;
  bill_footer: string;
}

export interface Item {
  id: number;
  name: string;
  hsn_code: string;
  /**
   * GST-inclusive selling price of the batch that sells next (the oldest with
   * stock left). A cache maintained by the server — never set directly.
   */
  price: number;
  metric: string;
  is_loose: boolean;
  gst_applicable: boolean;
  gst_mode?: 'split' | 'igst';
  gst_rate?: number;
  sgst_rate: number;
  cgst_rate: number;
  igst_rate?: number;
  image_url?: string;
  /** Total left across all batches. A cache maintained by the server. */
  stock_quantity: number;
  /** Profit margin used on the last purchase, offered on the next one. */
  default_profit_percent?: number | null;
  created_at: string;
}

/** One lot of an item's stock, sold oldest first. */
export interface StockBatch {
  id: number;
  source: 'purchase' | 'adjustment' | 'opening';
  received_at: string;
  quantity_received: number;
  quantity_remaining: number;
  /** GST-inclusive. */
  selling_price: number;
  /** Before GST. Admins only; null when not known. */
  unit_cost?: number | null;
  /** Admins only; null when the cost is not known. */
  profit_percent?: number | null;
  purchase_id?: number | null;
  purchase_number?: string | null;
  supplier_name?: string | null;
  invoice_number?: string | null;
}

export interface Customer {
  id: number;
  /** The person's name. Blank for a customer known only by their shop. */
  name: string;
  phone: string;
  /** The bakery/shop — the customer's primary identity when present. */
  shop_name?: string | null;
  address?: string;
  gstin?: string;
  credit_balance: number;
  created_at: string;
}

/**
 * One line of a customer's passbook: a bill (however it was paid), or a
 * payment, correction or opening balance on their account.
 */
export interface PassbookEntry {
  kind: 'bill' | 'payment' | 'adjustment' | 'opening';
  /** bills.id for a bill; customer_credit_entries.id otherwise. */
  ref_id: number;
  created_at: string;
  /** What the customer was charged. */
  amount_billed: number;
  /** What they paid: cash + UPI at the counter, or a repayment. */
  amount_received: number;
  /** billed - received: what went onto (or came off) their account. */
  balance_change: number;
  /** Balance due after this line. */
  balance: number;
  user_name: string;
  note?: string | null;
  // Bill rows only.
  bill_number?: string | null;
  payment_method?: Bill['payment_method'] | null;
  cash_amount?: number | null;
  upi_amount?: number | null;
  credit_amount?: number | null;
  subtotal_amount?: number | null;
  tax_amount?: number | null;
  discount_amount?: number | null;
  item_count?: number | null;
}

export interface PassbookSummary {
  opening_balance: number;
  total_billed: number;
  total_received: number;
  closing_balance: number;
  bill_count: number;
}

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  address?: string;
  gstin?: string;
  supplier_name?: string;
  supplier_phone?: string;
  supplier_address?: string;
  supplier_gstin?: string;
  created_at: string;
  /** What the shop still owes this supplier. */
  amount_due?: number;
}

export interface BillItem {
  id: number;
  bill_id: number;
  item_id: number;
  item_name: string;
  hsn_code: string;
  metric: string;
  quantity: number;
  /** Taxable value per unit. */
  price: number;
  /** GST-inclusive price per unit charged on this line. */
  unit_price?: number;
  /** 1 when the cashier changed the price. Billing no longer allows it; older lines only. */
  price_overridden?: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount?: number;
  total_amount: number;
  /** GST rates (%) the line was charged at. */
  sgst_rate?: number;
  cgst_rate?: number;
  igst_rate?: number;
}

export interface Bill {
  id: number;
  bill_number: string;
  customer_id?: number;
  /** The customer's own name. May be blank for a customer known only by shop. */
  customer_name?: string;
  /** The bakery/shop — how this shop refers to the customer. See src/lib/customer.ts. */
  customer_shop_name?: string | null;
  customer_phone?: string;
  customer_address?: string;
  customer_gstin?: string;
  user_id: number;
  cashier_name: string;
  /** Taxable value of the bill, stored at the time of sale. */
  subtotal_amount: number;
  total_amount: number;
  tax_amount: number;
  discount_amount: number;
  payment_method: 'cash' | 'upi' | 'credit' | 'split';
  cash_amount: number;
  upi_amount: number;
  credit_amount: number;
  created_at: string;
  items?: BillItem[];
}

export interface PurchaseItem {
  id: number;
  purchase_id: number;
  item_id: number;
  item_name: string;
  hsn_code: string;
  metric: string;
  quantity: number;
  unit_cost: number;
  sgst_rate: number;
  cgst_rate: number;
  igst_rate: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
}

export interface Purchase {
  id: number;
  purchase_number: string;
  supplier_name: string;
  supplier_phone?: string;
  supplier_address?: string;
  supplier_gstin?: string;
  invoice_number?: string;
  invoice_date?: string;
  notes?: string;
  user_id: number;
  user_name: string;
  subtotal_amount: number;
  tax_amount: number;
  total_amount: number;
  created_at: string;
  items?: PurchaseItem[];
  supplier_id?: number;
  /** Paid against this purchase so far, and what is still owed on it. */
  amount_paid?: number;
  balance_due?: number;
  payments?: PurchasePayment[];
}

export type SupplierPaymentMethod = 'cash' | 'upi' | 'bank' | 'cheque';

/** One payment's share of one purchase. */
export interface PurchasePayment {
  payment_id: number;
  /** The part of the payment that went to this purchase. */
  amount: number;
  /** The whole payment, which may have covered other purchases too. */
  payment_amount: number;
  paid_on: string;
  method: SupplierPaymentMethod | null;
  reference: string | null;
  note: string | null;
  user_name: string;
  created_at: string;
}

/** A purchase with money still owed on it, as the Purchase Credit page lists it. */
export interface CreditPurchase {
  id: number;
  purchase_number: string;
  supplier_id: number;
  invoice_supplier_name: string;
  invoice_number?: string | null;
  invoice_date?: string | null;
  created_at: string;
  total_amount: number;
  amount_paid: number;
  balance_due: number;
  age_days: number;
}

export interface SupplierCredit {
  supplier_id: number;
  name: string;
  phone?: string | null;
  gstin?: string | null;
  total_due: number;
  oldest_age_days: number;
  purchases: CreditPurchase[];
}

export interface PaidPurchase {
  id: number;
  purchase_number: string;
  supplier_id: number;
  supplier_name: string;
  invoice_number?: string | null;
  invoice_date?: string | null;
  created_at: string;
  total_amount: number;
  amount_paid: number;
  /** The day the last payment cleared it. */
  paid_off_on: string;
  payment_count: number;
  /** Comma-separated methods used, or null when none was recorded. */
  methods: string | null;
}

export interface SupplierPayment {
  id: number;
  supplier_id: number;
  supplier_name: string;
  amount: number;
  paid_on: string;
  method: SupplierPaymentMethod | null;
  reference: string | null;
  note: string | null;
  user_name: string;
  created_at: string;
  allocations: Array<{ amount: number; purchase_id: number; purchase_number: string; invoice_number?: string | null }>;
}

/** Part of a cart line charged at one price: units from batches at the same price. */
export interface CartSegment {
  quantity: number;
  unit_price: number;
  total_amount: number;
  taxable_amount: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
}

export interface CartItem extends Item {
  quantity: number;
  /** Sums over `segments`. */
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
  /**
   * The line's taxable value: each segment's total minus its rounded taxes,
   * summed. Derived by subtraction, so the cart's subtotal matches the one the
   * server stores on the bill.
   */
  taxable_amount: number;
  /** The item's stock when it went into the cart, oldest batch first. */
  batches: Array<{ id: number; quantity_remaining: number; selling_price: number }>;
  /** Total of `batches`. */
  available: number;
  /** The GST-inclusive unit price of the first segment. Not editable at the till. */
  unit_price: number;
  /** How the line is charged: one segment, or several when it crosses batches. */
  segments: CartSegment[];
}

/** Part of a customer's balance: a credit bill (or opening balance) not yet paid off. */
export interface UnpaidCredit {
  entry_id: number | null;
  kind: 'sale' | 'opening' | 'adjustment' | 'payment';
  bill_id: number | null;
  bill_number: string | null;
  bill_total: number | null;
  note: string | null;
  created_at: string | null;
  /** What this line put on the customer's account. */
  credit_amount: number;
  /** How much of it is still owed. */
  outstanding: number;
  age_days: number;
}

export type AgeingKey = 'd0_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export interface CustomerCredit {
  id: number;
  name: string;
  shop_name?: string | null;
  display_name: string;
  phone?: string | null;
  balance: number;
  last_payment_at: string | null;
  /** Negative: a payment reduces the balance. */
  last_payment_amount: number | null;
  oldest_age_days: number;
  ageing: Record<AgeingKey, number>;
  /** Oldest first. */
  unpaid: UnpaidCredit[];
}

export type StockStatus = 'in' | 'low' | 'out';

/** One item on the Stock page. */
export interface StockRow {
  id: number;
  name: string;
  hsn_code?: string | null;
  metric: string;
  /** What it sells at next: the oldest batch with stock left. */
  price: number;
  stock_quantity: number;
  status: StockStatus;
  batch_count: number;
  /** How many different selling prices the stock on the shelf has. */
  price_count: number;
  value_at_price: number;
  /** Admins only. */
  value_at_cost?: number;
  /** Admins only: batches with stock whose cost is not known. */
  uncosted_batches?: number;
  last_purchased_at: string | null;
  last_sold_at: string | null;
  /** Units sold in the recent window (sales_window_days). */
  sold_recent: number;
  /** Days the stock lasts at the recent rate; null when it has not sold. */
  days_left: number | null;
}

export interface StockSummary {
  item_count: number;
  in_stock: number;
  low_stock: number;
  out_of_stock: number;
  value_at_price: number;
  value_at_cost?: number;
}
