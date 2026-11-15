/**
 * "Include in my GST" (a report view of chosen items), the bill discount with
 * its round off, and GST printed for every item.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';
import { checkImportRows, emptyImportRow, readYesNo, rowsFromCells, type ImportRow } from '../src/lib/itemImport.ts';
import { useCartStore } from '../src/store/useCartStore.ts';
import { billShareText } from '../src/lib/billShare.ts';
import { receiptLines } from '../src/lib/escpos.ts';
import type { Item } from '../src/types.ts';

let server: TestServer;
let admin: Client;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

const row = (values: Partial<ImportRow>): ImportRow => ({ ...emptyImportRow(), ...values });
const good = (name: string, extra: Partial<ImportRow> = {}) =>
  row({ name, hsn_code: '1701', unit: 'kg', gst: '5', quantity: '10', cost: '40', price: '46', ...extra });

const itemById = async (id: number) => (await admin.get(`/api/items/${id}/batches`)).body.item;

/** The catalogue fields the Items form sends, from the item as listed. */
const formOf = (item: any, extra: Record<string, unknown> = {}) => ({
  name: item.name, hsn_code: item.hsn_code, metric: item.metric, is_loose: item.is_loose,
  gst_applicable: item.gst_applicable, gst_mode: item.gst_mode, gst_rate: item.gst_rate,
  sgst_rate: item.sgst_rate, cgst_rate: item.cgst_rate, igst_rate: item.igst_rate, ...extra,
});

describe('Include in my GST', () => {
  it('is on for every item until unticked, and the Items form changes it', async () => {
    const created = await makeStockedItem(admin, { price: 118 });
    let item = await itemById(created.id);
    assert.equal(item.in_my_gst, 1, 'ticked by default');

    assert.equal((await admin.put(`/api/items/${created.id}`, formOf(item, { in_my_gst: 0 }))).status, 200);
    item = await itemById(created.id);
    assert.equal(item.in_my_gst, 0);

    // A form that does not send it (an older screen) leaves it as it is.
    assert.equal((await admin.put(`/api/items/${created.id}`, formOf(item))).status, 200);
    assert.equal((await itemById(created.id)).in_my_gst, 0);

    const list = (await admin.get(`/api/items?search=${encodeURIComponent(created.name)}`)).body.data;
    assert.equal(list.find((row: any) => row.id === created.id).in_my_gst, 0);

    const logs = (await admin.get(`/api/audit-logs?search=${encodeURIComponent('left out of my GST')}`)).body.data;
    assert.ok(logs.some((log: any) => log.details.includes(created.name)), 'the change is in the activity log');
  });

  it('marks each line of the sales report, without changing the bill', async () => {
    const mine = await makeStockedItem(admin, { price: 118 });
    const other = await makeStockedItem(admin, { price: 59 });
    await admin.put(`/api/items/${other.id}`, formOf(await itemById(other.id), { in_my_gst: false }));

    const sale = await admin.post('/api/bills', { items: [{ id: mine.id, quantity: 1 }, { id: other.id, quantity: 2 }], payment_method: 'cash' });
    assert.equal(sale.status, 200, JSON.stringify(sale.body));
    const bill = (await admin.get(`/api/bills/${sale.body.bill_id}`)).body;
    // GST on every item, as on any bill: 18 on the first, 18 on the second.
    assert.equal(bill.tax_amount, 36);
    assert.equal(bill.total_amount, 236);

    const rows = (await admin.get('/api/reports/sales-items')).body.data.filter((r: any) => r.bill_id === sale.body.bill_id);
    assert.deepEqual(rows.map((r: any) => [r.item_id, r.in_my_gst]).sort(), [[mine.id, 1], [other.id, 0]].sort());
  });

  it('is on each row of the stock list, for its In my GST view', async () => {
    const mine = await makeStockedItem(admin, { price: 30 });
    const other = await makeStockedItem(admin, { price: 40 });
    await admin.put(`/api/items/${other.id}`, formOf(await itemById(other.id), { in_my_gst: 0 }));
    const rows = (await admin.get('/api/stock')).body.items;
    assert.equal(rows.find((r: any) => r.id === mine.id).in_my_gst, 1);
    assert.equal(rows.find((r: any) => r.id === other.id).in_my_gst, 0);
  });

  it('comes in from the import: Yes, No, or empty for Yes', async () => {
    assert.equal(readYesNo(''), true);
    assert.equal(readYesNo('Yes'), true);
    assert.equal(readYesNo(' y '), true);
    assert.equal(readYesNo('NO'), false);
    assert.equal(readYesNo('0'), false);
    assert.equal(readYesNo('maybe'), null);

    const checked = checkImportRows([good('Check A', { in_my_gst: 'maybe' })], new Set(), new Map());
    assert.ok(checked[0].problems.some((p) => p.field === 'in_my_gst'), 'a word that is not yes or no is a problem');

    // The template's heading, and a sheet with no headings (the column is last).
    const headed = rowsFromCells([
      ['Item name', 'HSN code', 'Unit', 'GST %', 'Quantity in stock', 'Cost price (before GST)', 'Selling price (with GST)', 'Kannada name (optional)', 'Barcode (optional)', 'Include in my GST (Yes/No) / ನನ್ನ ಜಿಎಸ್‌ಟಿಯಲ್ಲಿ ಸೇರಿಸಿ (Yes/No)'],
      ['Jaggery', '1701', 'kg', '5', '4', '60', '70', '', '', 'No'],
    ]);
    assert.equal(headed.rows[0].in_my_gst, 'No');
    const bare = rowsFromCells([['Jaggery', '1701', 'kg', '5', '4', '60', '70', '', '', 'No']]);
    assert.equal(bare.rows[0].in_my_gst, 'No');

    const res = await admin.post('/api/items/import', {
      rows: [good('MyGST Import Yes'), good('MyGST Import No', { in_my_gst: 'No' })],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const find = async (name: string) => (await admin.get(`/api/items?search=${encodeURIComponent(name)}`)).body.data.find((i: any) => i.name === name);
    assert.equal((await find('MyGST Import Yes')).in_my_gst, 1);
    assert.equal((await find('MyGST Import No')).in_my_gst, 0);

    const refused = await admin.post('/api/items/import', { rows: [good('MyGST Import Bad', { in_my_gst: 'perhaps' })] });
    assert.equal(refused.body.saved, false);
    assert.ok(refused.body.problems.some((p: any) => p.field === 'in_my_gst'));
  });
});

describe('discount and round off', () => {
  it('takes the discount off the total after GST, and floors the rest to rupees', async () => {
    // 3 × ₹107.10 = ₹321.30 incl. 5% GST; ₹20 off = ₹301.30 → ₹301, round off −₹0.30.
    const item = await makeStockedItem(admin, { price: 107.1, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 });
    const sale = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 3 }], payment_method: 'cash', discount_amount: 20, expected_total: 301,
    });
    assert.equal(sale.status, 200, JSON.stringify(sale.body));
    const bill = (await admin.get(`/api/bills/${sale.body.bill_id}`)).body;
    assert.equal(bill.discount_amount, 20);
    assert.equal(bill.total_amount, 301);
    assert.equal(bill.cash_amount, 301);
    assert.equal(+(bill.subtotal_amount + bill.tax_amount).toFixed(2), 321.3, 'GST on the full prices');

    const text = billShareText(bill, { shop_name: 'Test Shop' } as any);
    assert.match(text, /Discount: -₹20\.00/);
    assert.match(text, /Round off: -₹0\.30/);
    assert.match(text, /\*Total \(incl\. GST\): ₹301\.00\*/);
  });

  it('shows the same total on the till as the server records', async () => {
    const created = await makeStockedItem(admin, { price: 118 });
    const res = await admin.get(`/api/items/${created.id}/batches`);
    const batches = res.body.data.map((b: any) => ({ id: b.id, quantity_remaining: b.quantity_remaining, selling_price: b.selling_price }));
    const store = useCartStore.getState();
    store.clearCart();
    store.addItem({ created_at: '', ...created, ...res.body.item } as unknown as Item, batches, 3);
    useCartStore.getState().setDiscount(25.5);
    const state = useCartStore.getState();
    const cart = state.carts.find((c) => c.id === state.activeCartId)!;
    assert.equal(cart.totals.total, 328, '354 − 25.50 = 328.50, floored');

    const sale = await admin.post('/api/bills', {
      items: [{ id: created.id, quantity: 3 }], payment_method: 'cash', discount_amount: cart.discount, expected_total: cart.totals.total,
    });
    assert.equal(sale.status, 200, JSON.stringify(sale.body));
    assert.equal(sale.body.total_amount, 328);
    useCartStore.getState().clearCart();
    assert.equal(useCartStore.getState().carts[0].discount, 0, 'a new bill starts with no discount');
  });

  it('refuses a discount bigger than the bill', async () => {
    const item = await makeStockedItem(admin, { price: 50 });
    const res = await admin.post('/api/bills', { items: [{ id: item.id, quantity: 1 }], payment_method: 'cash', discount_amount: 51 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Discount cannot exceed/);
  });
});

describe('GST printed for every item', () => {
  it('on the Bluetooth receipt, rate and amount under each item', () => {
    const bill: any = {
      bill_number: 'INV-1', created_at: '2026-11-15 06:30:00', subtotal_amount: 150, tax_amount: 21, discount_amount: 0, total_amount: 171,
      payment_method: 'cash', cash_amount: 171, upi_amount: 0, credit_amount: 0,
      items: [
        { item_name: 'Biscuit', quantity: 1, metric: 'packet', unit_price: 118, total_amount: 118, sgst_rate: 9, cgst_rate: 9, igst_rate: 0, sgst_amount: 9, cgst_amount: 9, igst_amount: 0 },
        { item_name: 'Sugar', quantity: 1, metric: 'kg', unit_price: 53, total_amount: 53, sgst_rate: 0, cgst_rate: 0, igst_rate: 5, sgst_amount: 0, cgst_amount: 0, igst_amount: 3 },
      ],
    };
    const text = receiptLines(bill, { shop_name: 'Test Shop' } as any, 80)
      .flatMap((line) => (line.kind === 'text' ? [line.text] : []));
    assert.ok(text.includes('  GST 18%: 18.00'), text.join('\n'));
    assert.ok(text.includes('  GST 5%: 3.00'), text.join('\n'));
  });
});
