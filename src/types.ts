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
  name: string;
  phone: string;
  shop_name?: string;
  address?: string;
  gstin?: string;
  credit_balance: number;
  created_at: string;
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
  customer_name?: string;
  customer_phone?: string;
  customer_address?: string;
  customer_gstin?: string;
  user_id: number;
  cashier_name: string;
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
  original_price: number; // The total cost inclusive of GST
}
