/**
 * Sharing a bill on WhatsApp from Quick Bill: the message carries the bill as
 * saved, and the link opens the customer's chat when their number is usable.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { billShareText, whatsappLink, whatsappNumber } from '../src/lib/billShare.ts';

const settings: any = { shop_name: 'Vyapara Bakery Supplies', bill_footer: 'Thank you!' };
const bill: any = {
  bill_number: 'INV-13102026-00004', created_at: '2026-10-13 06:00:00', customer_shop_name: 'Sri Ganesh Bakery',
  subtotal_amount: 1838.1, tax_amount: 91.9, total_amount: 1930, cash_amount: 1000, upi_amount: 0, credit_amount: 930,
  items: [
    { item_name: 'Refined Maida (25 kg)', quantity: 2, metric: 'bag', unit_price: 880, total_amount: 1760 },
    { item_name: 'Instant Dry Yeast (500 g)', quantity: 1, metric: 'packet', unit_price: 170, total_amount: 170 },
  ],
};

describe('WhatsApp bill', () => {
  it('reads like the bill', () => {
    const text = billShareText(bill, settings, 15452.03);
    assert.match(text, /^\*Vyapara Bakery Supplies\*/);
    assert.match(text, /Bill \*INV-13102026-00004\*/);
    assert.match(text, /To: Sri Ganesh Bakery/);
    assert.match(text, /2 bag × ₹880\.00 = ₹1,760\.00/);
    assert.match(text, /\*Total: ₹1,930\.00\*/);
    assert.match(text, /Paid: Cash ₹1,000\.00/);
    assert.match(text, /On credit: ₹930\.00/);
    assert.match(text, /_Total balance due: ₹15,452\.03_/);
    assert.match(text, /Thank you!$/);
  });

  it('leaves out the balance line when nothing is owed', () => {
    assert.doesNotMatch(billShareText(bill, settings, 0), /balance due/);
  });

  it('turns Indian numbers into WhatsApp’s format', () => {
    assert.equal(whatsappNumber('98450 12345'), '919845012345');
    assert.equal(whatsappNumber('+91-98450-12345'), '919845012345');
    assert.equal(whatsappNumber('09845012345'), '919845012345');
    assert.equal(whatsappNumber('080 2839 405'), null, 'not a mobile: let WhatsApp ask');
    assert.equal(whatsappNumber(null), null);
  });

  it('links to the chat, or to WhatsApp’s chat picker without a number', () => {
    assert.match(whatsappLink('hi there', '9845012345'), /^https:\/\/wa\.me\/919845012345\?text=hi%20there$/);
    assert.match(whatsappLink('hi', null), /^https:\/\/wa\.me\/\?text=hi$/);
  });
});
