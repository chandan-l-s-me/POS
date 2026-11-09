import type { SupplierPaymentMethod } from '../types';
import { formatDateInIST } from './utils';
import { t } from '../i18n';

/** How a supplier can be paid. Recording the method is optional. */
export const PAYMENT_METHOD_OPTIONS: { value: SupplierPaymentMethod; label: string }[] = [
  { value: 'cash', get label() { return t('Cash'); } },
  { value: 'upi', get label() { return t('UPI'); } },
  { value: 'bank', get label() { return t('Bank transfer'); } },
  { value: 'cheque', get label() { return t('Cheque'); } },
];

export const paymentMethodLabel = (method: string | null | undefined) =>
  PAYMENT_METHOD_OPTIONS.find((option) => option.value === method)?.label ?? t('Not recorded');

/** "cash,upi" as the server lists the methods used on a purchase → "Cash, UPI". */
export const paymentMethodsLabel = (methods: string | null | undefined) =>
  methods ? methods.split(',').map(paymentMethodLabel).join(', ') : t('Not recorded');

export const formatRupees = (value: number) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** A YYYY-MM-DD day as "05 Mar 2026". */
export const formatDay = (day: string | null | undefined) => (day ? formatDateInIST(`${day}T00:00:00+05:30`) : '—');

/** Today in India, as YYYY-MM-DD, for date inputs. */
export const todayIST = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** "Today", "1 day", "45 days" — how long a purchase has been unpaid. */
export const ageLabel = (days: number) => (days <= 0 ? t('Today') : days === 1 ? t('1 day') : t('{count} days', { count: days }));
