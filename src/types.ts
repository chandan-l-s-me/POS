export interface User {
  id: number;
  username: string;
  role: 'admin' | 'cashier';
  name: string;
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
  stock_quantity: number;
  created_at: string;
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

export type CreditEntryType = 'opening' | 'sale' | 'payment' | 'adjustment';

/** One change to a customer's outstanding credit. */
export interface CustomerCreditEntry {
  id: number;
  customer_id: number;
  bill_id?: number | null;
  bill_number?: string | null;
  entry_type: CreditEntryType;
  /** Signed: positive increases what the customer owes. */
  amount: number;
  balance_before: number;
  balance_after: number;
  note?: string | null;
  user_id?: number | null;
  user_name: string;
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
}

export interface BillItem {
  id: number;
  bill_id: number;
  item_id: number;
  item_name: string;
  hsn_code: string;
  metric: string;
  quantity: number;
  price: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount?: number;
  total_amount: number;
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
}

export interface CartItem extends Item {
  quantity: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
  /**
   * The line's taxable value: total_amount minus the three tax amounts, all
   * already rounded. Derived by subtraction rather than multiplied out
   * independently, so `taxable_amount + tax === total_amount` holds exactly
   * and the cart's subtotal matches the one the server stores on the bill.
   */
  taxable_amount: number;
  original_price: number; // The total cost inclusive of GST
}
