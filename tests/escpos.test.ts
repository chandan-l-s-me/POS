/**
 * Bluetooth receipts: the bill laid out as fixed-width text for a thermal
 * printer. Every line must fit the paper (32 characters on 58 mm, 48 on
 * 80 mm), the money must match the bill, and only ASCII may reach the printer.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { receiptBytes, receiptLines, receiptText, columnsFor } from '../src/lib/escpos.ts';

const settings = {
  id: 1, shop_name: 'Vyapara Bakery Supplies', shop_address: '12 Market Road, Mysuru 570001, Karnataka',
  shop_phone: '+91 98450 12345', shop_gstin: '29AAAAA0000A1Z5', bill_format: 'thermal' as const,
  bill_header: 'Wholesale bakery ingredients', bill_footer: 'Thank you — visit again!',
};
const bill: any = {
  id: 7, bill_number: 'INV-12102026-00007', created_at: '2026-10-12 06:30:00', cashier_name: 'Priya Shetty',
  customer_shop_name: 'Sri Ganesh Bakery', customer_name: 'Ganesh', customer_gstin: '29BBBBB1111B1Z2',
  subtotal_amount: 1838.10, tax_amount: 91.90, discount_amount: 0, total_amount: 1930,
  payment_method: 'split', cash_amount: 1000, upi_amount: 930, credit_amount: 0,
  items: [
    { item_name: 'Refined Maida - Bakers Grade (25 kg)', quantity: 2, metric: 'bag', unit_price: 880, total_amount: 1760, cgst_amount: 41.90, sgst_amount: 41.90, igst_amount: 0 },
    { item_name: 'Instant Dry Yeast (500 g)', quantity: 1, metric: 'packet', unit_price: 170, total_amount: 170, cgst_amount: 4.05, sgst_amount: 4.05, igst_amount: 0 },
  ],
};

describe('Bluetooth receipt', () => {
  for (const paper of [58, 80] as const) {
    it(`fits ${paper} mm paper`, () => {
      const width = columnsFor(paper);
      for (const line of receiptLines(bill, settings, paper)) {
        if (line.kind !== 'text') continue;
        assert.ok(line.text.length <= (line.big ? Math.floor(width / 2) : width), `too wide: "${line.text}"`);
      }
    });
  }

  it('carries the bill’s figures and wraps long names', () => {
    const text = receiptText(bill, settings, 58);
    assert.match(text, /INV-12102026-00007/);
    assert.match(text, /Sri Ganesh Bakery/);
    assert.match(text, /Refined Maida - Bakers Grade/);
    assert.match(text, /2 bag x 880\.00\s+1760\.00/);
    assert.match(text, /CGST\s+45\.95/);
    assert.match(text, /TOTAL\s+Rs\.1930\.00/);
    assert.match(text, /Paid: Cash 1000\.00, UPI 930\.00/);
    assert.match(text, /Thank you - visit again!/, 'typographic dash made ASCII');
  });

  it('sends only ASCII and ESC/POS commands, ending in a cut', () => {
    const bytes = receiptBytes(bill, settings, 58);
    assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40], 'starts by initialising the printer');
    assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x42, 0x00], 'ends with a cut');
    assert.ok([...bytes].every((b) => b < 0x80), 'no byte outside ASCII');
  });
});
