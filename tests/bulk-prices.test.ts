/**
 * Bulk prices: "10 or more at ₹45 each". Set per item by an admin; billing
 * charges them on its own once the bill holds enough of the item, and the till
 * shows the same total the server records.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, addStock, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';
import { applyBulkPrice, bulkPriceFor, nextBulkPrice } from '../src/lib/billMath.ts';
import { useCartStore } from '../src/store/useCartStore.ts';
import type { Item } from '../src/types.ts';

let server: TestServer;
let admin: Client;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

const RULES = [
  { min_quantity: 10, price: 45 },
  { min_quantity: 50, price: 42 },
];

/** Sell `lines` on one bill and return the saved bill. */
const sell = async (lines: Array<{ id: number; quantity: number }>, expected_total?: number) => {
  const res = await admin.post('/api/bills', { items: lines, payment_method: 'cash', ...(expected_total != null ? { expected_total } : {}) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (await admin.get(`/api/bills/${res.body.bill_id}`)).body;
};

const itemWithBulk = async (overrides: Record<string, unknown> = {}, rules = RULES) => {
  const item = await makeStockedItem(admin, { price: 50, stock_quantity: 1000, ...overrides });
  const res = await admin.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices: rules });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return item;
};

describe('the bulk price rules', () => {
  it('takes the largest quantity reached', () => {
    assert.equal(bulkPriceFor(RULES, 9), null);
    assert.deepEqual(bulkPriceFor(RULES, 10), RULES[0]);
    assert.deepEqual(bulkPriceFor(RULES, 49.999), RULES[0]);
    assert.deepEqual(bulkPriceFor(RULES, 50), RULES[1]);
    assert.deepEqual(bulkPriceFor([...RULES].reverse(), 120), RULES[1], 'whatever order they come in');
    assert.equal(bulkPriceFor(undefined, 100), null);
  });

  it('knows the next one up, for the till’s hint', () => {
    assert.deepEqual(nextBulkPrice(RULES, 3), RULES[0]);
    assert.deepEqual(nextBulkPrice(RULES, 10), RULES[1]);
    assert.equal(nextBulkPrice(RULES, 50), null);
  });

  it('never raises a batch that already sells for less', () => {
    const allocations = [
      { batch_id: 1, quantity: 4, selling_price: 40 },
      { batch_id: 2, quantity: 8, selling_price: 50 },
    ];
    assert.deepEqual(applyBulkPrice(allocations, RULES[0]).map((a) => a.selling_price), [40, 45]);
    assert.equal(applyBulkPrice(allocations, null), allocations);
  });
});

describe('setting bulk prices', () => {
  it('saves them, and every read of the item carries them', async () => {
    const item = await itemWithBulk();
    const batches = await admin.get(`/api/items/${item.id}/batches`);
    assert.deepEqual(batches.body.item.bulk_prices, RULES);
    const list = await admin.get(`/api/items?search=${encodeURIComponent(item.name)}`);
    assert.deepEqual(list.body.data.find((row: any) => row.id === item.id).bulk_prices, RULES);
    assert.ok(list.body.data.every((row: any) => Array.isArray(row.bulk_prices)), 'an empty list for items with none');

    await admin.put(`/api/items/${item.id}/barcode`, { barcode: '8901234500017' });
    assert.deepEqual((await admin.get('/api/items/barcode/8901234500017')).body.bulk_prices, RULES);
  });

  it('sorts them, replaces the old list, and removes them all with []', async () => {
    const item = await itemWithBulk({}, [{ min_quantity: 24, price: 44 }, { min_quantity: 12, price: 47.5 }]);
    let rules = (await admin.get(`/api/items/${item.id}/batches`)).body.item.bulk_prices;
    assert.deepEqual(rules, [{ min_quantity: 12, price: 47.5 }, { min_quantity: 24, price: 44 }]);

    assert.equal((await admin.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices: [] })).status, 200);
    rules = (await admin.get(`/api/items/${item.id}/batches`)).body.item.bulk_prices;
    assert.deepEqual(rules, []);
  });

  it('refuses rules that make no sense', async () => {
    const item = await makeStockedItem(admin, { price: 50 });
    const put = (bulk_prices: unknown) => admin.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices });
    const refused = async (bulk_prices: unknown, message: RegExp) => {
      const res = await put(bulk_prices);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.match(res.body.error, message);
    };
    await refused([{ min_quantity: 1, price: 45 }], /more than 1/);
    await refused([{ min_quantity: 10, price: 0 }], /Bulk price must be at least/);
    await refused([{ min_quantity: 10, price: 45 }, { min_quantity: 10, price: 44 }], /different quantity/);
    await refused([{ min_quantity: 10, price: 45 }, { min_quantity: 20, price: 46 }], /higher bulk price/);
    await refused(Array.from({ length: 11 }, (_, i) => ({ min_quantity: i + 2, price: 50 - i })), /At most 10/);
    await refused('10 at 45', /as a list/);
    assert.deepEqual((await admin.get(`/api/items/${item.id}/batches`)).body.item.bulk_prices, [], 'nothing saved');
    assert.equal((await admin.put('/api/items/999999/bulk-prices', { bulk_prices: [] })).status, 404);
  });

  it('is for admins; a cashier sees them but cannot change them', async () => {
    const item = await itemWithBulk();
    await admin.post('/api/users', { name: 'Bulk Cashier', username: 'bulk-cashier', password: 'bulk-cashier-1', role: 'cashier' });
    const cashier = client(server.baseUrl);
    assert.equal((await cashier.login('bulk-cashier', 'bulk-cashier-1')).status, 200);
    assert.deepEqual((await cashier.get(`/api/items/${item.id}/batches`)).body.item.bulk_prices, RULES);
    assert.equal((await cashier.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices: [] })).status, 403);
  });

  it('is written to the activity log', async () => {
    const item = await itemWithBulk();
    const logs = (await admin.get(`/api/audit-logs?search=${encodeURIComponent('Bulk prices for ' + item.name)}`)).body.data;
    assert.ok(logs.some((log: any) => /10\+ piece @ ₹45\.00, 50\+ piece @ ₹42\.00/.test(log.details)), JSON.stringify(logs));
  });
});

describe('billing with bulk prices', () => {
  it('charges the normal price below the quantity and the bulk price from it', async () => {
    const item = await itemWithBulk();
    assert.deepEqual((await sell([{ id: item.id, quantity: 9 }])).items.map((l: any) => [l.quantity, l.unit_price]), [[9, 50]]);
    const ten = await sell([{ id: item.id, quantity: 10 }]);
    assert.deepEqual(ten.items.map((l: any) => [l.quantity, l.unit_price, l.total_amount]), [[10, 45, 450]]);
    assert.equal(ten.total_amount, 450);
    const fifty = await sell([{ id: item.id, quantity: 50 }]);
    assert.deepEqual(fifty.items.map((l: any) => [l.quantity, l.unit_price]), [[50, 42]]);
  });

  it('works out the GST on the bulk price', async () => {
    // ₹45 incl. 18% GST: ₹38.14 before GST, ₹6.86 GST a unit.
    const item = await itemWithBulk();
    const bill = await sell([{ id: item.id, quantity: 10 }]);
    const line = bill.items[0];
    assert.equal(line.price, 38.14);
    assert.equal(+(line.sgst_amount + line.cgst_amount).toFixed(2), 68.64);
    assert.equal(bill.subtotal_amount + bill.tax_amount, 450);
  });

  it('counts the item across the whole bill', async () => {
    const item = await itemWithBulk();
    const bill = await sell([{ id: item.id, quantity: 6 }, { id: item.id, quantity: 4 }]);
    assert.ok(bill.items.every((l: any) => l.unit_price === 45), JSON.stringify(bill.items));
    assert.equal(bill.total_amount, 450);
  });

  it('keeps a cheaper batch at its own price', async () => {
    const item = await makeStockedItem(admin, { price: 40, stock_quantity: 4 });
    await addStock(admin, item.id, { quantity: 100, selling_price: 50 });
    await admin.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices: RULES });
    const bill = await sell([{ id: item.id, quantity: 12 }]);
    assert.deepEqual(bill.items.map((l: any) => [l.quantity, l.unit_price]), [[4, 40], [8, 45]]);
  });

  it('works for loose goods sold by weight', async () => {
    const item = await itemWithBulk({ metric: 'kg', is_loose: true, price: 60, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 },
      [{ min_quantity: 5, price: 55 }]);
    assert.deepEqual((await sell([{ id: item.id, quantity: 4.999 }])).items.map((l: any) => l.unit_price), [60]);
    assert.deepEqual((await sell([{ id: item.id, quantity: 5.25 }])).items.map((l: any) => [l.unit_price, l.total_amount]), [[55, 288.75]]);
  });

  it('shows the same total on the till as the server records', async () => {
    const created = await itemWithBulk({ price: 107.1, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 }, [{ min_quantity: 12, price: 99.75 }]);
    const res = await admin.get(`/api/items/${created.id}/batches`);
    const batches = res.body.data.map((b: any) => ({ id: b.id, quantity_remaining: b.quantity_remaining, selling_price: b.selling_price }));
    const item = { created_at: '', ...created, ...res.body.item } as unknown as Item;

    const cart = useCartStore.getState();
    cart.clearCart();
    cart.addItem(item, batches, 1);
    let line = useCartStore.getState().carts[0].items[0];
    assert.equal(line.bulk_price, null);
    assert.equal(line.unit_price, 107.1);

    useCartStore.getState().updateQuantity(item.id, 13);
    const state = useCartStore.getState();
    const active = state.carts.find((c) => c.id === state.activeCartId)!;
    line = active.items[0];
    assert.deepEqual(line.bulk_price, { min_quantity: 12, price: 99.75 });
    assert.equal(line.unit_price, 99.75);

    // expected_total makes the server refuse if its figure differs.
    const bill = await sell([{ id: item.id, quantity: 13 }], active.totals.total);
    assert.equal(bill.total_amount, active.totals.total);
    assert.equal(bill.tax_amount, active.totals.tax);
    assert.equal(bill.subtotal_amount, active.totals.subtotal);

    // Back under the quantity, back to the normal price.
    useCartStore.getState().updateQuantity(item.id, 11);
    assert.equal(useCartStore.getState().carts[0].items[0].unit_price, 107.1);
    useCartStore.getState().clearCart();
  });

  it('picks up changed bulk prices when the bill is refreshed', async () => {
    const created = await makeStockedItem(admin, { price: 50 });
    const res = await admin.get(`/api/items/${created.id}/batches`);
    const batches = res.body.data.map((b: any) => ({ id: b.id, quantity_remaining: b.quantity_remaining, selling_price: b.selling_price }));
    const store = useCartStore.getState();
    store.clearCart();
    store.addItem({ created_at: '', ...created, ...res.body.item } as unknown as Item, batches, 10);
    assert.equal(useCartStore.getState().carts[0].items[0].unit_price, 50);
    useCartStore.getState().setItemBatches(created.id, batches, RULES);
    assert.equal(useCartStore.getState().carts[0].items[0].unit_price, 45);
    useCartStore.getState().clearCart();
  });
});
