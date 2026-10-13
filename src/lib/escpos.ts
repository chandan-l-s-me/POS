import type { Bill, ShopSettings } from '../types';
import { formatDateTimeInIST } from './utils';

/**
 * A bill as ESC/POS bytes, for a Bluetooth thermal printer.
 *
 * The counter prints the HTML receipt (src/components/Receipt.tsx) through the
 * browser; a pocket Bluetooth printer cannot render HTML, so the same bill is
 * laid out here as fixed-width text plus the ESC/POS commands every cheap
 * thermal printer understands. 58 mm paper holds 32 characters a line, 80 mm
 * holds 48.
 *
 * Text is plain ASCII: these printers' code pages have no rupee sign or
 * Indian scripts, so "Rs." is used and anything else non-ASCII is dropped.
 */
export type PaperWidth = 58 | 80;

export const columnsFor = (paper: PaperWidth) => (paper === 80 ? 48 : 32);

const ascii = (text: string | null | undefined) =>
  String(text ?? '')
    .replace(/₹/g, 'Rs.')
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7E]/g, '');

const money = (value: number) => Number(value || 0).toFixed(2);

/** Wrap text to `width`, breaking on spaces where possible. */
const wrap = (text: string, width: number): string[] => {
  const words = ascii(text).split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (word.length > width) {
      if (line) { lines.push(line); line = ''; }
      for (let i = 0; i < word.length; i += width) lines.push(word.slice(i, i + width));
      continue;
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

/** `left` and `right` on one line, right-aligned; `left` is cut if they do not fit. */
const pair = (left: string, right: string, width: number) => {
  const r = ascii(right);
  const l = ascii(left).slice(0, Math.max(0, width - r.length - 1));
  return l + ' '.repeat(Math.max(1, width - l.length - r.length)) + r;
};

type Line =
  | { kind: 'text'; text: string; align?: 'left' | 'center'; bold?: boolean; big?: boolean }
  | { kind: 'rule' }
  | { kind: 'feed'; lines: number };

/**
 * The receipt as lines, before encoding. Kept separate so the layout can be
 * checked (and tested) as plain text.
 */
export const receiptLines = (bill: Bill, settings: ShopSettings, paper: PaperWidth = 58): Line[] => {
  const width = columnsFor(paper);
  const out: Line[] = [];
  const text = (value: string, extra: Partial<Extract<Line, { kind: 'text' }>> = {}) =>
    out.push({ kind: 'text', text: value, ...extra });

  // Double-size text is twice as wide, so the shop name wraps at half width.
  for (const line of wrap(settings.shop_name, Math.floor(width / 2))) text(line, { align: 'center', bold: true, big: true });
  for (const line of wrap(settings.shop_address, width)) text(line, { align: 'center' });
  if (settings.shop_phone) text(`Ph: ${ascii(settings.shop_phone)}`, { align: 'center' });
  if (settings.shop_gstin) text(`GSTIN: ${ascii(settings.shop_gstin)}`, { align: 'center' });
  if (settings.bill_header) for (const line of wrap(settings.bill_header, width)) text(line, { align: 'center' });
  out.push({ kind: 'rule' });

  text(pair(`Bill: ${bill.bill_number}`, '', width).trimEnd(), { bold: true });
  text(formatDateTimeInIST(bill.created_at));
  if (bill.cashier_name) text(`Cashier: ${ascii(bill.cashier_name)}`);
  const customer = (bill.customer_shop_name || '').trim() || (bill.customer_name || '').trim();
  if (customer) {
    for (const line of wrap(`To: ${customer}`, width)) text(line);
    if (bill.customer_gstin) text(`GSTIN: ${ascii(bill.customer_gstin)}`);
  }
  out.push({ kind: 'rule' });

  for (const item of bill.items ?? []) {
    for (const line of wrap(item.item_name, width)) text(line);
    const unit = item.unit_price ?? (item.quantity ? item.total_amount / item.quantity : 0);
    text(pair(`  ${item.quantity} ${ascii(item.metric)} x ${money(unit)}`, money(item.total_amount), width));
  }
  out.push({ kind: 'rule' });

  const items = bill.items ?? [];
  const sum = (key: 'cgst_amount' | 'sgst_amount' | 'igst_amount') =>
    Math.round(items.reduce((acc, item) => acc + Number(item[key] || 0), 0) * 100) / 100;
  const cgst = sum('cgst_amount');
  const sgst = sum('sgst_amount');
  const igst = sum('igst_amount');
  const subtotal = Number(bill.subtotal_amount || 0);
  text(pair('Subtotal', money(subtotal), width));
  if (cgst) text(pair('CGST', money(cgst), width));
  if (sgst) text(pair('SGST', money(sgst), width));
  if (igst) text(pair('IGST', money(igst), width));
  if (bill.discount_amount) text(pair('Discount', `-${money(bill.discount_amount)}`, width));
  const roundOff = Math.round((bill.total_amount - (subtotal + bill.tax_amount - (bill.discount_amount || 0))) * 100) / 100;
  if (roundOff) text(pair('Round off', money(roundOff), width));
  text(pair('TOTAL', `Rs.${money(bill.total_amount)}`, Math.floor(width / 2)), { bold: true, big: true });
  out.push({ kind: 'rule' });

  const paid: string[] = [];
  if (bill.cash_amount) paid.push(`Cash ${money(bill.cash_amount)}`);
  if (bill.upi_amount) paid.push(`UPI ${money(bill.upi_amount)}`);
  if (bill.credit_amount) paid.push(`Credit ${money(bill.credit_amount)}`);
  for (const line of wrap(`Paid: ${paid.join(', ') || bill.payment_method}`, width)) text(line);
  if (settings.bill_footer) {
    out.push({ kind: 'feed', lines: 1 });
    for (const line of wrap(settings.bill_footer, width)) text(line, { align: 'center' });
  }
  out.push({ kind: 'feed', lines: 3 });
  return out;
};

/** The receipt as plain text, as it will look on paper (big text is not doubled). */
export const receiptText = (bill: Bill, settings: ShopSettings, paper: PaperWidth = 58) => {
  const width = columnsFor(paper);
  return receiptLines(bill, settings, paper)
    .map((line) => {
      if (line.kind === 'rule') return '-'.repeat(width);
      if (line.kind === 'feed') return '\n'.repeat(line.lines - 1);
      const lineWidth = line.big ? Math.floor(width / 2) : width;
      return line.align === 'center'
        ? ' '.repeat(Math.max(0, Math.floor((lineWidth - line.text.length) / 2))) + line.text
        : line.text;
    })
    .join('\n');
};

const ESC = 0x1b;
const GS = 0x1d;

/** Encode the receipt as ESC/POS commands. */
export const receiptBytes = (bill: Bill, settings: ShopSettings, paper: PaperWidth = 58): Uint8Array => {
  const width = columnsFor(paper);
  const bytes: number[] = [ESC, 0x40]; // initialise
  const push = (...values: number[]) => bytes.push(...values);
  const write = (value: string) => { for (const char of ascii(value)) bytes.push(char.charCodeAt(0)); };

  for (const line of receiptLines(bill, settings, paper)) {
    if (line.kind === 'rule') { write('-'.repeat(width)); push(0x0a); continue; }
    if (line.kind === 'feed') { push(ESC, 0x64, line.lines); continue; }
    push(ESC, 0x61, line.align === 'center' ? 1 : 0); // alignment
    push(ESC, 0x45, line.bold ? 1 : 0); // bold
    push(GS, 0x21, line.big ? 0x11 : 0x00); // double width and height
    write(line.text);
    push(0x0a);
  }
  push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0);
  push(GS, 0x56, 0x42, 0x00); // partial cut, on printers that have a cutter
  return Uint8Array.from(bytes);
};
