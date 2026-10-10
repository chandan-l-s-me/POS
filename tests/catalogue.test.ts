/**
 * Items, customers, suppliers and shop settings.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server: TestServer;
let admin: Client;
let cashier: Client;

// Catalogue fields only: an item has no price or stock of its own until a
// purchase or stock adjustment gives it a batch.
const baseItem = (overrides: Record<string, unknown> = {}) => ({
  name: `Item ${Math.random().toString(36).slice(2, 10)}`,
  hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  metric: 'piece',
  is_loose: false,
  gst_applicable: true,
  gst_mode: 'split',
  gst_rate: 18,
  sgst_rate: 9,
  cgst_rate: 9,
  igst_rate: 0,
  ...overrides,
});

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);

  const created = await admin.post('/api/cashiers', {
    name: 'Catalogue Cashier', username: 'catalogue-cashier', password: 'cashier-pass-1',
  });
  assert.equal(created.status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('catalogue-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

/** A purchase with one line that creates a new item. */
const newItemPurchase = (newItem: Record<string, unknown>, line: Record<string, unknown> = {}) => ({
  supplier_name: 'Catalogue Supplier',
  items: [{
    new_item: { name: `New ${Math.random().toString(36).slice(2, 8)}`, hsn_code: '19019090', metric: 'packet', ...newItem },
    quantity: 10, unit_cost: 50, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0, selling_price: 63,
    ...line,
  }],
});

describe('items are created only by purchases', () => {
  it('has no way to create an item outside a purchase', async () => {
    const res = await admin.post('/api/items', baseItem({ name: 'Back Door Item' }));
    assert.equal(res.status, 404);
    assert.equal((await admin.get('/api/items?search=Back%20Door')).body.total, 0);
  });

  it('creates a new item from a purchase line, with stock and price from that line', async () => {
    const res = await admin.post('/api/purchases', newItemPurchase({ name: 'Purchased Custard', metric: 'kg' }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.created_items.length, 1);
    assert.equal(res.body.created_items[0].name, 'Purchased Custard');

    const row = (await admin.get('/api/items?search=Purchased%20Custard')).body.data[0];
    assert.equal(row.id, res.body.created_items[0].id);
    assert.equal(row.hsn_code, '19019090');
    assert.equal(row.metric, 'kg');
    assert.equal(row.is_loose, 1, 'sold by the kg means sold loose');
    assert.equal(row.stock_quantity, 10);
    assert.equal(row.price, 63);
    assert.equal(row.gst_mode, 'split', 'its GST is the GST it was bought at');
    assert.equal(row.gst_rate, 5);
    assert.equal(row.sgst_rate, 2.5);

    const logs = await admin.get('/api/audit-logs?search=Purchased%20Custard');
    assert.ok(logs.body.data.some((l: any) => /^Created item Purchased Custard on purchase PUR-/.test(l.details)));
  });

  it('takes IGST from the line for an inter-state purchase', async () => {
    const res = await admin.post('/api/purchases', newItemPurchase(
      { name: 'Interstate Essence' },
      { sgst_rate: 0, cgst_rate: 0, igst_rate: 18, selling_price: 70.8 }
    ));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = (await admin.get('/api/items?search=Interstate%20Essence')).body.data[0];
    assert.equal(row.gst_mode, 'igst');
    assert.equal(row.igst_rate, 18);
    assert.equal(row.sgst_rate, 0);
  });

  it('creates nothing when the purchase does not save', async () => {
    const res = await admin.post('/api/purchases', {
      supplier_name: 'Catalogue Supplier',
      items: [
        { new_item: { name: 'Never Saved Item', hsn_code: '11112222', metric: 'piece' }, quantity: 1, unit_cost: 10, selling_price: 15 },
        { item_id: 987654321, quantity: 1, unit_cost: 10, selling_price: 15 },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal((await admin.get('/api/items?search=Never%20Saved')).body.total, 0, 'no stray item from an abandoned purchase');
  });

  it('refuses a new item that already exists, whatever the case', async () => {
    const existing = await makeStockedItem(admin, { name: 'Unique Cocoa' });
    const res = await admin.post('/api/purchases', newItemPurchase({ name: '  unique COCOA ' }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already an item. Pick it from the list/);
    assert.equal((await admin.get('/api/items?search=Unique%20Cocoa')).body.total, 1);
    assert.ok(existing.id);
  });

  it('refuses the same new item twice on one purchase', async () => {
    const line = { new_item: { name: 'Twice Item', hsn_code: '11112222', metric: 'piece' }, quantity: 1, unit_cost: 10, selling_price: 15 };
    const res = await admin.post('/api/purchases', { supplier_name: 'Catalogue Supplier', items: [line, line] });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /on this purchase twice/);
    assert.equal((await admin.get('/api/items?search=Twice%20Item')).body.total, 0);
  });

  it('requires a name, an HSN code and a known unit for a new item', async () => {
    for (const bad of [{ name: '' }, { name: '   ' }, { hsn_code: '' }, { metric: '' }, { metric: 'gallon' }]) {
      const res = await admin.post('/api/purchases', newItemPurchase(bad));
      assert.equal(res.status, 400, JSON.stringify(bad));
    }
  });

  it('refuses a line that is both an existing item and a new one', async () => {
    const existing = await makeStockedItem(admin);
    const res = await admin.post('/api/purchases', newItemPurchase({}, { item_id: existing.id }));
    assert.equal(res.status, 400);
    assert.match(res.body.error, /either an existing item or a new one/);
  });

  it('lets only an admin create items, since only an admin enters purchases', async () => {
    assert.equal((await cashier.post('/api/purchases', newItemPurchase({ name: 'Cashier Item' }))).status, 403);
  });
});

describe('items', () => {
  it('reads and updates catalogue details', async () => {
    const { id } = await makeStockedItem(admin, { name: 'Round Trip Item' });

    const listed = (await admin.get(`/api/items?search=Round%20Trip&withImages=1`)).body.data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Round Trip Item');

    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ name: 'Renamed Item', metric: 'kg' }))).status, 200);
    const after = (await admin.get(`/api/items?search=Renamed%20Item`)).body.data[0];
    assert.equal(after.name, 'Renamed Item');
    assert.equal(after.metric, 'kg');
  });

  it('omits image_url from the lean list and includes it with withImages', async () => {
    const item = await makeStockedItem(admin, { name: 'Pictured' });
    assert.equal((await admin.put(`/api/items/${item.id}`, baseItem({
      name: 'Pictured', hsn_code: item.hsn_code, image_url: 'https://example.test/a.png',
    }))).status, 200);

    const lean = (await admin.get('/api/items?search=Pictured')).body.data[0];
    assert.equal(lean.image_url, undefined, 'the billing screen does not need image URLs');

    const full = (await admin.get('/api/items?search=Pictured&withImages=1')).body.data[0];
    assert.equal(full.image_url, 'https://example.test/a.png');
  });

  it('requires a name and an HSN code when editing', async () => {
    const { id } = await makeStockedItem(admin);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ name: '' }))).status, 400);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ name: '   ' }))).status, 400);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ hsn_code: '' }))).status, 400);
  });

  it('cannot set price or stock through the item form', async () => {
    // Stock lives in batches and only moves through purchases, sales and
    // adjustments with a reason. The form used to overwrite the stock count
    // with no record of what changed.
    const item = await makeStockedItem(admin, { price: 120, stock_quantity: 8 });
    const res = await admin.put(`/api/items/${item.id}`, {
      ...baseItem({ name: item.name, hsn_code: item.hsn_code }),
      price: 1, stock_quantity: 99999,
    });
    assert.equal(res.status, 200);
    const row = (await admin.get(`/api/items?search=${encodeURIComponent(item.name)}`)).body.data[0];
    assert.equal(row.price, 120, 'price unchanged');
    assert.equal(row.stock_quantity, 8, 'stock unchanged');
  });

  it('rejects rates outside sane bounds when editing', async () => {
    const { id } = await makeStockedItem(admin);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ sgst_rate: 101 }))).status, 400);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ sgst_rate: 60, cgst_rate: 60 }))).status, 400);
    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ gst_mode: 'vat' }))).status, 400);
  });

  it('404s on updating or deleting an item that does not exist', async () => {
    assert.equal((await admin.put('/api/items/987654321', baseItem())).status, 404);
    assert.equal((await admin.del('/api/items/987654321')).status, 404);
  });

  it('refuses to delete an item that was purchased', async () => {
    // Every item is created by a purchase, so in practice items stay — they
    // are part of the purchase and GST history.
    const { id } = await makeStockedItem(admin, { name: 'Bought Item', stock_quantity: 5 });
    const res = await admin.del(`/api/items/${id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error, /existing bills or purchases/);
  });

  it('can still delete an item from before batches that was never bought or sold', async () => {
    const raw = new Database(server.dbPath);
    const id = Number(raw.prepare(`
      INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
      VALUES ('Old Unused Item', '12340001', 10, 'piece', 0, 0, 'split', 0, 0, 0, 0, 0)
    `).run().lastInsertRowid);
    raw.close();
    assert.equal((await admin.del(`/api/items/${id}`)).status, 200);
    assert.equal((await admin.get(`/api/items/${id}/batches`)).status, 404);
  });

  it('pages and reports a true total', async () => {
    const res = await admin.get('/api/items?limit=2&offset=0');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length <= 2);
    assert.ok(res.body.total >= res.body.data.length);
    assert.equal(res.body.limit, 2);
    assert.equal(res.body.offset, 0);
  });

  it('treats a search term as data, not SQL', async () => {
    const res = await admin.get(`/api/items?search=${encodeURIComponent("'; DROP TABLE items; --")}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 0);
    // The table must still be there.
    assert.ok((await admin.get('/api/items')).body.total > 0);
  });
});

describe('customers', () => {
  it('creates, updates and rejects duplicate phone numbers', async () => {
    const created = await admin.post('/api/customers', { name: 'Asha', phone: '9812345670' });
    assert.equal(created.status, 200);
    const id = created.body.id;

    const dup = await admin.post('/api/customers', { name: 'Someone Else', phone: '9812345670' });
    assert.equal(dup.status, 409);

    assert.equal((await admin.put(`/api/customers/${id}`, {
      name: 'Asha Rao', phone: '9812345670', address: 'New address',
    })).status, 200);

    const row = (await admin.get('/api/customers?search=9812345670')).body.data[0];
    assert.equal(row.name, 'Asha Rao');
    assert.equal(row.address, 'New address');
  });

  it('refuses to move a phone number onto another customer', async () => {
    const a = await admin.post('/api/customers', { name: 'A', phone: '9812345671' });
    await admin.post('/api/customers', { name: 'B', phone: '9812345672' });
    const res = await admin.put(`/api/customers/${a.body.id}`, { name: 'A', phone: '9812345672' });
    assert.equal(res.status, 409);
  });

  it('requires a name and phone', async () => {
    assert.equal((await admin.post('/api/customers', { name: '', phone: '9812345673' })).status, 400);
    assert.equal((await admin.post('/api/customers', { name: 'X' })).status, 400);
  });

  it('lets only an admin set an opening credit balance', async () => {
    const byCashier = await cashier.post('/api/customers', {
      name: 'Cashier Made', phone: '9812345674', credit_balance: 5000,
    });
    assert.equal(byCashier.status, 200);
    const row = (await admin.get('/api/customers?search=9812345674')).body.data[0];
    assert.equal(row.credit_balance, 0, 'a cashier must not be able to invent receivables');

    const byAdmin = await admin.post('/api/customers', {
      name: 'Admin Made', phone: '9812345675', credit_balance: 5000,
    });
    assert.equal(byAdmin.status, 200);
    const adminRow = (await admin.get('/api/customers?search=9812345675')).body.data[0];
    assert.equal(adminRow.credit_balance, 5000);
  });

  it('stops a cashier from writing off an outstanding balance', async () => {
    const created = await admin.post('/api/customers', {
      name: 'Owes Money', phone: '9812345676', credit_balance: 1200,
    });
    const id = created.body.id;

    const res = await cashier.put(`/api/customers/${id}`, {
      name: 'Owes Money', phone: '9812345676', credit_balance: 0,
    });
    assert.equal(res.status, 200, 'a cashier may still correct contact details');

    const row = (await admin.get('/api/customers?search=9812345676')).body.data[0];
    assert.equal(row.credit_balance, 1200, 'the balance must be untouched');
  });

  it('rejects a negative credit balance from an admin too', async () => {
    const res = await admin.post('/api/customers', {
      name: 'Negative', phone: '9812345677', credit_balance: -100,
    });
    assert.equal(res.status, 400);
  });

  it('404s on a customer that does not exist', async () => {
    assert.equal((await admin.put('/api/customers/987654321', { name: 'X', phone: '1' })).status, 404);
  });
});

describe('suppliers', () => {
  it('creates and updates, rejecting duplicate names case-insensitively', async () => {
    const created = await admin.post('/api/suppliers', { name: 'Acme Traders', phone: '9800000001' });
    assert.equal(created.status, 201);

    const dup = await admin.post('/api/suppliers', { name: 'acme traders' });
    assert.equal(dup.status, 409);

    assert.equal((await admin.put(`/api/suppliers/${created.body.id}`, {
      name: 'Acme Traders Pvt Ltd', phone: '9800000002', gstin: '29AAAAA0000A1Z5',
    })).status, 200);

    const list = (await admin.get('/api/suppliers')).body;
    const row = list.find((s: any) => s.id === created.body.id);
    assert.equal(row.name, 'Acme Traders Pvt Ltd');
    assert.equal(row.gstin, '29AAAAA0000A1Z5');
  });

  it('requires a name', async () => {
    assert.equal((await admin.post('/api/suppliers', { phone: '9800000003' })).status, 400);
  });

  it('404s on a supplier that does not exist', async () => {
    assert.equal((await admin.put('/api/suppliers/987654321', { name: 'X' })).status, 404);
  });
});

describe('shop settings', () => {
  it('round-trips and validates the bill format', async () => {
    const payload = {
      shop_name: 'Test Shop',
      shop_address: '42 Test Street',
      shop_phone: '+91 90000 00000',
      shop_gstin: '29AAAAA0000A1Z5',
      bill_format: 'standard',
      bill_header: 'Header line',
      bill_footer: 'Footer line',
    };
    const res = await admin.put('/api/settings', payload);
    assert.equal(res.status, 200);
    assert.equal(res.body.shop_name, 'Test Shop');
    assert.equal(res.body.bill_format, 'standard');

    const read = await admin.get('/api/settings');
    assert.equal(read.body.shop_gstin, '29AAAAA0000A1Z5');

    assert.equal((await admin.put('/api/settings', { ...payload, bill_format: 'pdf' })).status, 400);
    assert.equal((await admin.put('/api/settings', { ...payload, shop_name: '' })).status, 400);
  });
});

describe('sidebar counts', () => {
  it('returns live item and customer counts', async () => {
    const stats = await admin.get('/api/stats');
    assert.equal(stats.status, 200);
    const items = (await admin.get('/api/items?limit=1')).body.total;
    const customers = (await admin.get('/api/customers?limit=1')).body.total;
    assert.equal(stats.body.items, items);
    assert.equal(stats.body.customers, customers);
  });
});
