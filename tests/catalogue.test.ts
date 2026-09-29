/**
 * Items, customers, suppliers and shop settings.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  name: `Item ${Math.random().toString(36).slice(2, 10)}`,
  hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  price: 100,
  metric: 'piece',
  is_loose: false,
  gst_applicable: true,
  gst_mode: 'split',
  gst_rate: 18,
  sgst_rate: 9,
  cgst_rate: 9,
  igst_rate: 0,
  stock_quantity: 10,
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

describe('items', () => {
  it('creates, reads, updates and deletes', async () => {
    const created = await admin.post('/api/items', baseItem({ name: 'Round Trip Item' }));
    assert.equal(created.status, 200);
    const id = created.body.id;

    const listed = (await admin.get(`/api/items?search=Round%20Trip&withImages=1`)).body.data;
    assert.equal(listed.length, 1);
    assert.equal(listed[0].name, 'Round Trip Item');
    assert.equal(listed[0].price, 100);

    assert.equal((await admin.put(`/api/items/${id}`, baseItem({ name: 'Renamed Item', price: 250 }))).status, 200);
    const after = (await admin.get(`/api/items?search=Renamed%20Item`)).body.data[0];
    assert.equal(after.name, 'Renamed Item');
    assert.equal(after.price, 250);

    assert.equal((await admin.del(`/api/items/${id}`)).status, 200);
    assert.equal((await admin.get(`/api/items?search=Renamed%20Item`)).body.total, 0);
  });

  it('omits image_url from the lean list and includes it with withImages', async () => {
    const created = await admin.post('/api/items', baseItem({ name: 'Pictured', image_url: 'https://example.test/a.png' }));
    assert.equal(created.status, 200);

    const lean = (await admin.get('/api/items?search=Pictured')).body.data[0];
    assert.equal(lean.image_url, undefined, 'the billing screen does not need image URLs');

    const full = (await admin.get('/api/items?search=Pictured&withImages=1')).body.data[0];
    assert.equal(full.image_url, 'https://example.test/a.png');
  });

  it('requires a name and an HSN code', async () => {
    assert.equal((await admin.post('/api/items', baseItem({ name: '' }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ name: '   ' }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ hsn_code: '' }))).status, 400);
  });

  it('rejects money and rates outside sane bounds', async () => {
    assert.equal((await admin.post('/api/items', baseItem({ price: -1 }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ price: 'abc' }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ stock_quantity: -5 }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ sgst_rate: 101 }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ sgst_rate: 60, cgst_rate: 60 }))).status, 400);
    assert.equal((await admin.post('/api/items', baseItem({ gst_mode: 'vat' }))).status, 400);
  });

  it('404s on updating or deleting an item that does not exist', async () => {
    assert.equal((await admin.put('/api/items/987654321', baseItem())).status, 404);
    assert.equal((await admin.del('/api/items/987654321')).status, 404);
  });

  it('refuses to delete an item that appears on a bill', async () => {
    const created = await admin.post('/api/items', baseItem({ name: 'Sold Item', stock_quantity: 5 }));
    const id = created.body.id;
    assert.equal((await admin.post('/api/bills', {
      items: [{ id, quantity: 1 }], payment_method: 'cash',
    })).status, 200);

    const res = await admin.del(`/api/items/${id}`);
    assert.equal(res.status, 409, 'deleting it would orphan the bill and break GST history');
    assert.match(res.body.error, /existing bills or purchases/);
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
