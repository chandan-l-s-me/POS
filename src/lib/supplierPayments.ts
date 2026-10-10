import type { SupplierPaymentMethod } from '../types';
import { formatDateInIST } from './utils';

/** How a supplier can be paid. Recording the method is optional. */
export const PAYMENT_METHOD_OPTIONS: { value: SupplierPaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'bank', label: 'Bank transfer' },
  { value: 'cheque', label: 'Cheque' },
];

export const paymentMethodLabel = (method: string | null | undefined) =>
  PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.label ?? 'Not recorded';

/** "cash,upi" as the server lists the methods used on a purchase → "Cash, UPI". */
export const paymentMethodsLabel = (methods: string | null | undefined) =>
  methods ? methods.split(',').map(paymentMethodLabel).join(', ') : 'Not recorded';

export const formatRupees = (value: number) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A YYYY-MM-DD day as "05 Mar 2026". */
export const formatDay = (day: string | null | undefined) => (day ? formatDateInIST(`${day}T00:00:00+05:30`) : '—');

/** Today in India, as YYYY-MM-DD, for date inputs. */
export const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** "Today", "1 day", "45 days" — how long a purchase has been unpaid. */
export const ageLabel = (days: number) => (days <= 0 ? 'Today' : days === 1 ? '1 day' : `${days} days`);
