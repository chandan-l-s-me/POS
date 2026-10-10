/**
 * Stock in batches, sold first-in first-out.
 *
 * The shop's own example: yeast bought last week at ₹85, and again this week at
 * ₹90. Last week's stock must be sold first, at last week's price; this week's
 * price only applies once that runs out. Nobody can change the price on a
 * bill line — it is set on the purchase. And the stock figure must always be
 * exactly what the batches say is left.
 *
 * Prices here use 5% GST and a 20% margin on cost before GST:
 *   ₹85 cost -> 85 x 1.20 x 1.05 = ₹107.10 selling
 *   ₹90 cost -> 90 x 1.20 x 1.05 = ₹113.40 selling
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import {
  ADMIN_PASSWORD, addStock, client, itemFields, makeStockedItem, purchaseNewItem, round2, startServer,
  type Client, type TestServer,
} from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server: TestServer;
let admin: Client;
let cashier: Client;

const YEAST_GST = { gst_applicable: true, gst_mode: 'split', gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0 };

/**
 * Buy an item that is not in the catalogue yet: the purchase line creates it,
 * exactly as the Purchases screen does. There is no other way to create one.
 */
const buyNew = async (quantity: number, unit_cost: number, selling_price: number, overrides: Record<string, unknown> = {}) => {
  const fields = itemFields({ ...YEAST_GST, ...overrides });
  const id = await purchaseNewItem(admin, fields, { quantity, unit_cost, selling_price, supplier_name: 'Yeast Supplier' });
  return { id, ...fields };
};

/** Buy `quantity` at `unit_cost` (before GST), to sell at `selling_price` (with GST). */
const purchase = async (itemId: number, quantity: number, unit_cost: number, selling_price: number) => {
  const res = await admin.post('/api/purchases', {
    supplier_name: 'Yeast Supplier',
    items: [{ item_id: itemId, quantity, unit_cost, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0, selling_price }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
};

const batchesOf = async (itemId: number, all = false, as: Client = admin) => {
  const res = await as.get(`/api/items/${itemId}/batches${all ? '?all=1' : ''}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { item: any; data: any[] };
};

const bill = async (body: Record<string, unknown>, as: Client = admin) => as.post('/api/bills', body);

const billLines = async (billId: number) => (await admin.get(`/api/bills/${billId}`)).body.items as any[];

/** Last week's ₹85 yeast, then this week's ₹90 yeast: 10 of each. */
const twoWeeksOfYeast = async () => {
  const yeast = await buyNew(10, 85, 107.1, { name: `Yeast ${Math.random().toString(36).slice(2, 7)}` });
  await purchase(yeast.id, 10, 90, 113.4);
  return yeast;
};

/** Every item's cached stock equals what its batches hold, and nothing is negative. */
const assertStockAddsUp = () => {
  const db = new Database(server.dbPath, { readonly: true });
  try {
    const drift = db.prepare(`
      SELECT i.id, i.name, i.stock_quantity,
             ROUND(COALESCE((SELECT SUM(quantity_remaining) FROM stock_batches b WHERE b.item_id = i.id), 0), 3) AS in_batches
      FROM items i
      WHERE ABS(i.stock_quantity - COALESCE((SELECT SUM(quantity_remaining) FROM stock_batches b WHERE b.item_id = i.id), 0)) > 0.0005
    `).all();
    assert.deepEqual(drift, [], 'items.stock_quantity must equal the stock left in its batches');

    const negative = db.prepare('SELECT id FROM stock_batches WHERE quantity_remaining < 0').all();
    assert.deepEqual(negative, [], 'no batch may go below zero');

    const unallocated = db.prepare(`
      SELECT bi.id, bi.quantity, (SELECT ROUND(SUM(quantity), 3) FROM bill_item_batches a WHERE a.bill_item_id = bi.id) AS allocated
      FROM bill_items bi
      WHERE EXISTS (SELECT 1 FROM bill_item_batches a WHERE a.bill_item_id = bi.id)
        AND ABS(bi.quantity - (SELECT SUM(quantity) FROM bill_item_batches a WHERE a.bill_item_id = bi.id)) > 0.0005
    `).all();
    assert.deepEqual(unallocated, [], 'every unit sold must come from a batch');
  } finally {
    db.close();
  }
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', {
    name: 'FIFO Cashier', username: 'fifo-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('fifo-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

describe('purchases set the selling price', () => {
  it('turns each purchase line into a batch at its own price', async () => {
    const yeast = await buyNew(10, 85, 107.1);

    const { item, data } = await batchesOf(yeast.id);
    assert.equal(item.stock_quantity, 10);
    assert.equal(item.price, 107.1, 'the item now sells at the price set on the purchase');
    assert.equal(data.length, 1);
    assert.equal(data[0].source, 'purchase');
    assert.equal(data[0].unit_cost, 85);
    assert.equal(data[0].selling_price, 107.1);
    assert.equal(data[0].quantity_remaining, 10);
    assert.equal(data[0].supplier_name, 'Yeast Supplier');
  });

  it('works out and remembers the profit margin', async () => {
    const yeast = await buyNew(10, 85, 107.1);
    const { item, data } = await batchesOf(yeast.id);
    assert.equal(data[0].profit_percent, 20, '107.10 incl. 5% GST is 102 before GST: 20% on 85');
    assert.equal(item.default_profit_percent, 20, 'offered again on the next purchase');
  });

  it('queues a dearer purchase behind the stock already on the shelf', async () => {
    const yeast = await twoWeeksOfYeast();
    const { item, data } = await batchesOf(yeast.id);
    assert.equal(item.stock_quantity, 20);
    assert.equal(item.price, 107.1, 'still last week’s price: that stock sells first');
    assert.deepEqual(data.map((b) => [b.unit_cost, b.selling_price, b.quantity_remaining]), [[85, 107.1, 10], [90, 113.4, 10]]);
  });
});

describe('billing sells the oldest stock first', () => {
  it('charges last week’s price while last week’s stock lasts', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 3 }], payment_method: 'cash' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const lines = await billLines(res.body.bill_id);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].unit_price, 107.1);
    assert.equal(lines[0].total_amount, 321.3);
    assert.equal(lines[0].price_overridden, 0);

    const { item, data } = await batchesOf(yeast.id);
    assert.deepEqual(data.map((b) => b.quantity_remaining), [7, 10], 'taken from last week’s batch only');
    assert.equal(item.stock_quantity, 17);
    assert.equal(item.price, 107.1);
  });

  it('splits a sale that runs past the old stock into two lines', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 12 }], payment_method: 'cash' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const lines = await billLines(res.body.bill_id);
    assert.deepEqual(
      lines.map((l) => [l.quantity, l.unit_price, l.total_amount]),
      [[10, 107.1, 1071], [2, 113.4, 226.8]],
      'each unit is charged the price of the batch it came from'
    );

    // The invoice still reconciles.
    const detail = (await admin.get(`/api/bills/${res.body.bill_id}`)).body;
    let subtotal = 0;
    let tax = 0;
    for (const line of lines) {
      const lineTax = round2(line.sgst_amount + line.cgst_amount + line.igst_amount);
      assert.equal(round2(round2(line.total_amount - lineTax) + lineTax), line.total_amount);
      subtotal = round2(subtotal + line.total_amount - lineTax);
      tax = round2(tax + lineTax);
    }
    assert.equal(detail.subtotal_amount, subtotal);
    assert.equal(detail.tax_amount, tax);
    assert.equal(detail.total_amount, Math.floor(round2(subtotal + tax)));

    const { item, data } = await batchesOf(yeast.id);
    assert.deepEqual(data.map((b) => b.quantity_remaining), [8], 'last week’s batch is used up');
    assert.equal(item.price, 113.4, 'and the item now sells at this week’s price');
    assertStockAddsUp();
  });

  it('carries on down the queue when one bill has the same item twice', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await bill({
      items: [{ id: yeast.id, quantity: 8 }, { id: yeast.id, quantity: 4 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const lines = await billLines(res.body.bill_id);
    assert.deepEqual(lines.map((l) => [l.quantity, l.unit_price]), [[8, 107.1], [2, 107.1], [2, 113.4]]);
    assert.deepEqual((await batchesOf(yeast.id)).data.map((b) => b.quantity_remaining), [8]);
  });

  it('refuses more than all batches hold, and moves nothing', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 21 }], payment_method: 'cash' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Insufficient stock .* only 20 available/);
    assert.deepEqual((await batchesOf(yeast.id)).data.map((b) => b.quantity_remaining), [10, 10]);
  });

  it('never oversells under concurrent bills, and stock still adds up', async () => {
    const yeast = await twoWeeksOfYeast();
    const results = await Promise.all(
      Array.from({ length: 25 }, () => bill({ items: [{ id: yeast.id, quantity: 1 }], payment_method: 'cash' }))
    );
    assert.equal(results.filter((r) => r.status === 200).length, 20);
    const { item, data } = await batchesOf(yeast.id, true);
    assert.equal(item.stock_quantity, 0);
    assert.deepEqual(data.map((b) => b.quantity_remaining), [0, 0]);
    assertStockAddsUp();
  });

  it('sells loose goods by weight across batches', async () => {
    const flour = await buyNew(1.25, 40, 50.4, { metric: 'kg' });
    await purchase(flour.id, 5, 42, 52.92);
    const res = await bill({ items: [{ id: flour.id, quantity: 2.5 }], payment_method: 'cash' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual((await billLines(res.body.bill_id)).map((l) => [l.quantity, l.unit_price]), [[1.25, 50.4], [1.25, 52.92]]);
    assert.deepEqual((await batchesOf(flour.id)).data.map((b) => b.quantity_remaining), [3.75]);
    assertStockAddsUp();
  });
});

describe('the price cannot be changed at the counter', () => {
  // Prices are set on the purchase, or repriced in Items → Stock & prices.
  // A bill that asks for any other price is refused, by anyone, and nothing
  // is sold.
  const billsSoFar = async () => (await admin.get('/api/bills?limit=1')).body.total;

  it('refuses a different price, from a cashier or an admin', async () => {
    const yeast = await twoWeeksOfYeast();
    const before = await billsSoFar();
    for (const who of [cashier, admin]) {
      const res = await bill({ items: [{ id: yeast.id, quantity: 3, unit_price: 99 }], payment_method: 'cash' }, who);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, /cannot be changed at billing \(it sells as 3 @ ₹107\.10\)/);
      assert.match(res.body.error, /Stock & prices/);
    }
    assert.equal(await billsSoFar(), before, 'no bill is written');
    assert.equal((await batchesOf(yeast.id)).item.stock_quantity, 20, 'no stock moves');
  });

  it('refuses one price for a line that crosses into a dearer batch', async () => {
    // 10 @ 107.10 then 2 @ 113.40: charging all 12 at the first price is a change.
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 12, unit_price: 107.1 }], payment_method: 'cash' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /10 @ ₹107\.10 \+ 2 @ ₹113\.40/);
  });

  it('accepts a price that is exactly what the batch sells at', async () => {
    // An older till that still sends the price it showed is not refused.
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 2, unit_price: 107.1 }], payment_method: 'cash' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [line] = await billLines(res.body.bill_id);
    assert.equal(line.unit_price, 107.1);
    assert.equal(line.price_overridden, 0);
  });

  it('rejects a price that is not a positive amount', async () => {
    const yeast = await twoWeeksOfYeast();
    for (const unit_price of [0, -5, 'abc', {}]) {
      const res = await bill({ items: [{ id: yeast.id, quantity: 1, unit_price }], payment_method: 'cash' });
      assert.equal(res.status, 400, `price ${JSON.stringify(unit_price)}`);
    }
    assert.equal((await batchesOf(yeast.id)).item.stock_quantity, 20);
  });
});

describe('the total on screen is the total charged', () => {
  it('accepts a bill whose total matches what the till showed', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await bill({ items: [{ id: yeast.id, quantity: 12 }], payment_method: 'cash', expected_total: 1297 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.total_amount, 1297);
  });

  it('refuses one priced from stock that another sale has since used up', async () => {
    const yeast = await twoWeeksOfYeast();
    // The till priced 3 units from last week's batch: ₹321.
    const shownOnTill = 321;
    // Meanwhile another counter sells all of last week's stock.
    assert.equal((await bill({ items: [{ id: yeast.id, quantity: 10 }], payment_method: 'cash' })).status, 200);

    const res = await bill({ items: [{ id: yeast.id, quantity: 3 }], payment_method: 'cash', expected_total: shownOnTill });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'PRICE_CHANGED');
    assert.match(res.body.error, /showed ₹321\.00 but is now ₹340\.00/);
    assert.deepEqual((await batchesOf(yeast.id)).data.map((b) => b.quantity_remaining), [10], 'nothing was sold');
  });
});

describe('stock adjustments', () => {
  it('removes stock oldest first, with a reason', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: -12, reason: 'Expired packets' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.stock_quantity, 8);
    assert.equal(res.body.price, 113.4);
    assert.deepEqual((await batchesOf(yeast.id)).data.map((b) => b.quantity_remaining), [8]);

    const logs = await admin.get(`/api/audit-logs?search=Expired%20packets`);
    assert.match(logs.body.data[0].details, /reduced by 12 piece \(Expired packets\); now 8/);
    assertStockAddsUp();
  });

  it('refuses to remove more than is in stock', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: -25, reason: 'Recount' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Only 20 piece/);
  });

  it('adds stock as a new batch at the latest cost and price', async () => {
    const yeast = await twoWeeksOfYeast();
    const res = await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: 5, reason: 'Found in store room' });
    assert.equal(res.status, 201);
    const { data } = await batchesOf(yeast.id);
    const added = data[data.length - 1];
    assert.equal(added.source, 'adjustment');
    assert.equal(added.quantity_remaining, 5);
    assert.equal(added.unit_cost, 90);
    assert.equal(added.selling_price, 113.4);
  });

  it('needs a selling price to add stock to an item with no stock history', async () => {
    // Every item made through the app was bought, so it has a batch. The one
    // case without is an item that predates batches; make one directly.
    const raw = new Database(server.dbPath);
    const legacyId = Number(raw.prepare(`
      INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
      VALUES ('Legacy No History', '12340000', 0, 'piece', 0, 1, 'split', 5, 2.5, 2.5, 0, 0)
    `).run().lastInsertRowid);
    raw.close();
    const item = { id: legacyId };
    const without = await admin.post(`/api/items/${item.id}/stock-adjustments`, { quantity: 5, reason: 'Opening stock' });
    assert.equal(without.status, 400);
    assert.match(without.body.error, /enter the selling price/);

    const withPrice = await admin.post(`/api/items/${item.id}/stock-adjustments`, {
      quantity: 5, reason: 'Opening stock', selling_price: 60, unit_cost: 48,
    });
    assert.equal(withPrice.status, 201);
    assert.equal(withPrice.body.price, 60);
  });

  it('requires a reason and a non-zero quantity', async () => {
    const yeast = await twoWeeksOfYeast();
    assert.equal((await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: 5 })).status, 400);
    assert.equal((await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: 0, reason: 'x' })).status, 400);
    assert.equal((await admin.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: 'abc', reason: 'x' })).status, 400);
  });

  it('is admin-only', async () => {
    const yeast = await twoWeeksOfYeast();
    assert.equal((await cashier.post(`/api/items/${yeast.id}/stock-adjustments`, { quantity: -1, reason: 'x' })).status, 403);
  });
});

describe('repricing stock already on the shelf', () => {
  it('changes what that batch sells for, and the item follows if it sells next', async () => {
    const yeast = await twoWeeksOfYeast();
    const { data } = await batchesOf(yeast.id);
    const res = await admin.put(`/api/stock-batches/${data[0].id}`, { selling_price: 110 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await batchesOf(yeast.id)).item.price, 110);

    const sale = await bill({ items: [{ id: yeast.id, quantity: 1 }], payment_method: 'cash' });
    assert.equal((await billLines(sale.body.bill_id))[0].unit_price, 110);
  });

  it('refuses a sold-out batch, a bad price, and a cashier', async () => {
    const yeast = await twoWeeksOfYeast();
    await bill({ items: [{ id: yeast.id, quantity: 10 }], payment_method: 'cash' });
    const { data } = await batchesOf(yeast.id, true);
    assert.equal((await admin.put(`/api/stock-batches/${data[0].id}`, { selling_price: 100 })).status, 400);
    assert.equal((await admin.put(`/api/stock-batches/${data[1].id}`, { selling_price: 0 })).status, 400);
    assert.equal((await cashier.put(`/api/stock-batches/${data[1].id}`, { selling_price: 100 })).status, 403);
    assert.equal((await admin.put('/api/stock-batches/987654321', { selling_price: 100 })).status, 404);
  });
});

describe('the batch list', () => {
  it('shows a cashier selling prices but not purchase costs', async () => {
    const yeast = await twoWeeksOfYeast();
    const { data } = await batchesOf(yeast.id, false, cashier);
    assert.equal(data.length, 2);
    assert.equal(data[0].selling_price, 107.1);
    assert.equal(data[0].unit_cost, undefined);
    assert.equal(data[0].profit_percent, undefined);
  });

  it('hides sold-out batches unless asked', async () => {
    const yeast = await twoWeeksOfYeast();
    await bill({ items: [{ id: yeast.id, quantity: 10 }], payment_method: 'cash' });
    assert.equal((await batchesOf(yeast.id)).data.length, 1);
    assert.equal((await batchesOf(yeast.id, true)).data.length, 2);
  });

  it('404s for an item that does not exist', async () => {
    assert.equal((await admin.get('/api/items/987654321/batches')).status, 404);
  });
});

describe('stock always adds up', () => {
  it('after a mix of purchases, sales and adjustments', async () => {
    const a = await twoWeeksOfYeast();
    const b = await makeStockedItem(admin, { price: 50, stock_quantity: 30 });
    await addStock(admin, b.id, { quantity: 12, selling_price: 55 });
    await purchase(a.id, 4.5, 88, 110.88);
    await bill({ items: [{ id: a.id, quantity: 11 }, { id: b.id, quantity: 31 }], payment_method: 'cash' });
    await bill({ items: [{ id: b.id, quantity: 3 }], payment_method: 'upi' });
    await admin.post(`/api/items/${a.id}/stock-adjustments`, { quantity: -2.5, reason: 'Damaged' });
    assertStockAddsUp();
  });
});
