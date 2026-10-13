import type { Bill, ShopSettings } from '../types';
import { formatDateTimeInIST } from './utils';

/**
 * A bill as a WhatsApp message, and the link that opens WhatsApp with it.
 *
 * Used by Quick Bill's "Share on WhatsApp" after a sale. The link opens the
 * customer's chat with the message typed in; nothing is sent until the
 * cashier presses send in WhatsApp. WhatsApp formatting: *bold*, _italic_.
 */

const rupees = (value: number) =>
  `₹${Number(value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qty = (value: number) => Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export const billShareText = (bill: Bill, settings: ShopSettings, balanceDue?: number | null) => {
  const customer = (bill.customer_shop_name || '').trim() || (bill.customer_name || '').trim();
  const lines: string[] = [];
  lines.push(`*${settings.shop_name}*`);
  lines.push(`Bill *${bill.bill_number}* · ${formatDateTimeInIST(bill.created_at)}`);
  if (customer) lines.push(`To: ${customer}`);
  lines.push('');

  for (const item of bill.items ?? []) {
    const unit = item.unit_price ?? (item.quantity ? item.total_amount / item.quantity : 0);
    lines.push(`${item.item_name}`);
    lines.push(`   ${qty(item.quantity)} ${item.metric} × ${rupees(unit)} = ${rupees(item.total_amount)}`);
  }
  lines.push('');

  if (bill.tax_amount > 0) {
    lines.push(`Subtotal: ${rupees(bill.subtotal_amount)}`);
    lines.push(`GST: ${rupees(bill.tax_amount)}`);
  }
  lines.push(`*Total: ${rupees(bill.total_amount)}*`);

  const paid: string[] = [];
  if (bill.cash_amount > 0) paid.push(`Cash ${rupees(bill.cash_amount)}`);
  if (bill.upi_amount > 0) paid.push(`UPI ${rupees(bill.upi_amount)}`);
  if (paid.length) lines.push(`Paid: ${paid.join(' + ')}`);
  if (bill.credit_amount > 0) lines.push(`On credit: ${rupees(bill.credit_amount)}`);
  if (balanceDue != null && balanceDue > 0) lines.push(`_Total balance due: ${rupees(balanceDue)}_`);

  if (settings.bill_footer) {
    lines.push('');
    lines.push(settings.bill_footer);
  }
  return lines.join('\n');
};

/**
 * WhatsApp's number format: country code and number, digits only. Ten-digit
 * Indian mobiles get 91 in front; anything that cannot be a phone number is
 * dropped, and WhatsApp then lets the cashier pick the chat.
 */
export const whatsappNumber = (phone: string | null | undefined) => {
  let digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  // Indian mobiles are ten digits starting 6-9; a landline (080...) has no WhatsApp.
  return /^[6-9]\d{9}$/.test(digits) ? `91${digits}` : null;
};

export const whatsappLink = (text: string, phone?: string | null) => {
  const number = whatsappNumber(phone);
  return `https://wa.me/${number ?? ''}?text=${encodeURIComponent(text)}`;
};
