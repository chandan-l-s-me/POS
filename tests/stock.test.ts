/**
 * The Stock page: every item with what is on the shelf, whether it is in
 * stock, low (at or under LOW_STOCK_THRESHOLD) or out, what the stock is worth,
 * and how long it will last at the recent rate of sale.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, addStock, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;

const NO_GST = { gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 };

const stock = async (as: Client = admin) => {
  const res = await as.get('/api/stock');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { threshold: number; summary: any; items: any[] };
};
const rowFor = async (id: number, as: Client = admin) => (await stock(as)).items.find((item) => item.id === id);

before(async () => {
  server = await startServer({ LOW_STOCK_THRESHOLD: '5' });
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', {
    name: 'Stock Cashier', username: 'stock-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('stock-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

describe('stock', () => {
  it('marks items in stock, low and out against the threshold', async () => {
    const plenty = await makeStockedItem(admin, { ...NO_GST, stock_quantity: 50 });
    const low = await makeStockedItem(admin, { ...NO_GST, stock_quantity: 5 });
    const out = await makeStockedItem(admin, { ...NO_GST, stock_quantity: 0 });

    const report = await stock();
    assert.equal(report.threshold, 5);
    assert.equal((await rowFor(plenty.id)).status, 'in');
    assert.equal((await rowFor(low.id)).status, 'low', 'at the threshold counts as low');
    assert.equal((await rowFor(out.id)).status, 'out');
    assert.equal(report.summary.item_count, report.items.length);
    assert.equal(
      report.summary.in_stock + report.summary.low_stock + report.summary.out_of_stock,
      report.summary.item_count
    );
  });

  it('values stock batch by batch, at selling price and at cost', async () => {
    const item = await makeStockedItem(admin, { ...NO_GST, price: 100, unit_cost: 60, stock_quantity: 10 });
    await addStock(admin, item.id, { quantity: 5, selling_price: 120, unit_cost: 80 });

    const row = await rowFor(item.id);
    assert.equal(row.stock_quantity, 15);
    assert.equal(row.batch_count, 2);
    assert.equal(row.price_count, 2, 'two prices on the shelf');
    assert.equal(row.price, 100, 'sells at the older batch’s price next');
    assert.equal(row.value_at_price, 10 * 100 + 5 * 120);
    assert.equal(row.value_at_cost, 10 * 60 + 5 * 80);
  });

  it('works out how long the stock lasts from the last 30 days of sales', async () => {
    const item = await makeStockedItem(admin, { ...NO_GST, stock_quantity: 100 });
    assert.equal((await rowFor(item.id)).days_left, null, 'never sold: no estimate');

    const sold = await admin.post('/api/bills', { items: [{ id: item.id, quantity: 30 }], payment_method: 'cash' });
    assert.equal(sold.status, 200);
    const row = await rowFor(item.id);
    assert.equal(row.sold_recent, 30);
    assert.equal(row.days_left, 70, '70 left at 1 a day');
    assert.ok(row.last_sold_at);
    assert.ok(row.last_purchased_at);
  });

  it('hides cost from cashiers', async () => {
    const item = await makeStockedItem(admin, { ...NO_GST, stock_quantity: 10 });
    const report = await stock(cashier);
    const row = report.items.find((i) => i.id === item.id);
    assert.equal(row.value_at_cost, undefined);
    assert.ok(row.value_at_price > 0);
    assert.equal(report.summary.value_at_cost, undefined);
  });
});
