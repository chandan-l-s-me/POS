/**
 * Purchases (input tax credit), reports, analytics, audit logs and backups.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import { ADMIN_PASSWORD, client, round2, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;

const makeItem = async (overrides: Record<string, unknown> = {}) => {
  const body = {
    name: `Item ${Math.random().toString(36).slice(2, 10)}`,
    hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    price: 100, metric: 'piece', is_loose: false,
    gst_applicable: true, gst_mode: 'split', gst_rate: 18,
    sgst_rate: 9, cgst_rate: 9, igst_rate: 0, stock_quantity: 100,
    ...overrides,
  };
  const res = await admin.post('/api/items', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: res.body.id as number, ...body };
};

const stockOf = async (id: number) =>
  (await admin.get('/api/items?limit=1000')).body.data.find((r: any) => r.id === id).stock_quantity;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

describe('purchases', () => {
  it('computes line tax and totals from quantity, cost and rate', async () => {
    const item = await makeItem({ stock_quantity: 0 });
    const created = await admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      supplier_gstin: '29BBBBB1111B2Z6',
      invoice_number: 'WC-001',
      invoice_date: '2026-09-01',
      items: [{ item_id: item.id, quantity: 10, unit_cost: 50, sgst_rate: 9, cgst_rate: 9, igst_rate: 0 }],
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    // 10 x 50 = 500 taxable, 9% each side = 45 + 45, total 590.
    assert.equal(created.body.subtotal_amount, 500);
    assert.equal(created.body.tax_amount, 90);
    assert.equal(created.body.total_amount, 590);

    const purchase = (await admin.get(`/api/purchases/${created.body.purchase_id}`)).body;
    const line = purchase.items[0];
    assert.equal(line.sgst_amount, 45);
    assert.equal(line.cgst_amount, 45);
    assert.equal(line.igst_amount, 0);
    assert.equal(line.total_amount, 590);
    assert.equal(line.item_name, item.name);
    assert.equal(line.hsn_code, item.hsn_code);
    assert.match(purchase.purchase_number, /^PUR-\d{8}-\d{5}$/);
  });

  it('adds purchased quantity to stock', async () => {
    const item = await makeItem({ stock_quantity: 5 });
    assert.equal((await admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      items: [{ item_id: item.id, quantity: 20, unit_cost: 10, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 }],
    })).status, 201);
    assert.equal(await stockOf(item.id), 25);
  });

  it('ignores client-supplied tax amounts', async () => {
    const item = await makeItem();
    const created = await admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      items: [{
        item_id: item.id, quantity: 2, unit_cost: 100,
        sgst_rate: 9, cgst_rate: 9, igst_rate: 0,
        // A tampered input-tax-credit claim.
        sgst_amount: 99999, cgst_amount: 99999, total_amount: 1,
      }],
      subtotal_amount: 1, tax_amount: 99999, total_amount: 1,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.subtotal_amount, 200);
    assert.equal(created.body.tax_amount, 36);
    assert.equal(created.body.total_amount, 236);
  });

  it('rejects a line that mixes IGST with SGST/CGST', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      items: [{ item_id: item.id, quantity: 1, unit_cost: 10, sgst_rate: 9, cgst_rate: 9, igst_rate: 18 }],
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /both IGST and SGST\/CGST/);
  });

  it('rejects impossible quantities, costs and rates', async () => {
    const item = await makeItem();
    const bad = (line: Record<string, unknown>) => admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      items: [{ item_id: item.id, quantity: 1, unit_cost: 10, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, ...line }],
    });
    assert.equal((await bad({ quantity: 0 })).status, 400);
    assert.equal((await bad({ quantity: -5 })).status, 400);
    assert.equal((await bad({ unit_cost: -1 })).status, 400);
    assert.equal((await bad({ sgst_rate: 60, cgst_rate: 60 })).status, 400);
    assert.equal((await bad({ quantity: 'abc' })).status, 400);
  });

  it('rejects a purchase with no items or an unknown item', async () => {
    assert.equal((await admin.post('/api/purchases', { supplier_name: 'X', items: [] })).status, 400);
    assert.equal((await admin.post('/api/purchases', {
      supplier_name: 'X',
      items: [{ item_id: 987654321, quantity: 1, unit_cost: 1 }],
    })).status, 400);
  });

  it('requires a supplier name', async () => {
    const item = await makeItem();
    assert.equal((await admin.post('/api/purchases', {
      items: [{ item_id: item.id, quantity: 1, unit_cost: 1 }],
    })).status, 400);
  });

  it('registers the supplier on the first purchase', async () => {
    const item = await makeItem();
    assert.equal((await admin.post('/api/purchases', {
      supplier_name: 'Brand New Supplier',
      supplier_phone: '9800000009',
      items: [{ item_id: item.id, quantity: 1, unit_cost: 10, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 }],
    })).status, 201);

    const suppliers = (await admin.get('/api/suppliers')).body;
    const row = suppliers.find((s: any) => s.name === 'Brand New Supplier');
    assert.ok(row, 'the supplier should be created from the purchase');
    assert.equal(row.phone, '9800000009');
  });

  it('rolls back the whole purchase when one line is invalid', async () => {
    const good = await makeItem({ stock_quantity: 7 });
    const res = await admin.post('/api/purchases', {
      supplier_name: 'Wholesale Co',
      items: [
        { item_id: good.id, quantity: 5, unit_cost: 10, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 },
        { item_id: 987654321, quantity: 5, unit_cost: 10, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 },
      ],
    });
    assert.equal(res.status, 400);
    assert.equal(await stockOf(good.id), 7, 'no stock may move on a failed purchase');
  });

  it('404s on a purchase that does not exist', async () => {
    assert.equal((await admin.get('/api/purchases/987654321')).status, 404);
  });
});

describe('reports', () => {
  before(async () => {
    const item = await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9, stock_quantity: 200 });
    for (let i = 0; i < 3; i++) {
      assert.equal((await admin.post('/api/bills', {
        items: [{ id: item.id, quantity: 2 }], payment_method: i === 0 ? 'cash' : 'upi',
      })).status, 200);
    }
  });

  it('returns sales line items inside the requested window', async () => {
    const res = await admin.get('/api/reports/sales-items');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length > 0);

    const row = res.body.data[0];
    for (const field of ['bill_number', 'item_name', 'hsn_code', 'quantity', 'price', 'sgst_amount', 'cgst_amount', 'igst_amount', 'total_amount']) {
      assert.ok(field in row, `sales report row is missing ${field}`);
    }
    // Rows must reconcile the same way the invoice does.
    const taxable = round2(row.total_amount - row.sgst_amount - row.cgst_amount - (row.igst_amount || 0));
    assert.equal(round2(taxable + row.sgst_amount + row.cgst_amount + (row.igst_amount || 0)), row.total_amount);
  });

  it('returns purchase line items with rates and amounts', async () => {
    const res = await admin.get('/api/reports/purchase-items');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length > 0);
    const row = res.body.data[0];
    for (const field of ['purchase_number', 'supplier_name', 'item_name', 'unit_cost', 'sgst_rate', 'cgst_rate', 'igst_rate', 'sgst_amount', 'cgst_amount', 'igst_amount', 'total_amount']) {
      assert.ok(field in row, `purchase report row is missing ${field}`);
    }
  });

  it('honours an explicit date range', async () => {
    const past = await admin.get('/api/reports/sales-items?from=2001-01-01&to=2001-12-31');
    assert.equal(past.status, 200);
    assert.equal(past.body.data.length, 0);
    assert.equal(past.body.from, '2001-01-01');
    assert.equal(past.body.to, '2001-12-31');
  });

  it('caps the row limit', async () => {
    assert.equal((await admin.get('/api/reports/sales-items?limit=99999')).status, 400);
    assert.equal((await admin.get('/api/reports/sales-items?from=nonsense')).status, 400);
  });
});

describe('analytics', () => {
  it('reports revenue, top items, daily sales, payment mix and a bill count', async () => {
    const res = await admin.get('/api/analytics');
    assert.equal(res.status, 200);
    const d = res.body;

    assert.equal(typeof d.todayRevenue, 'number');
    assert.equal(typeof d.monthRevenue, 'number');
    assert.ok(Array.isArray(d.topItems));
    assert.ok(Array.isArray(d.salesByDay));
    assert.ok(Array.isArray(d.paymentMethods));

    // The dashboard's "Total Orders" tile needs a real count of bills, not a
    // count of days that happened to have revenue.
    assert.equal(typeof d.monthBillCount, 'number', 'analytics must expose a real bill count');
    assert.equal(typeof d.todayBillCount, 'number');

    const billsToday = (await admin.get('/api/bills?limit=1')).body.total;
    assert.equal(d.monthBillCount, billsToday, 'every bill in this run was created this month');

    const mixTotal = d.paymentMethods.reduce((acc: number, row: any) => acc + row.count, 0);
    assert.equal(mixTotal, d.monthBillCount, 'the payment mix must cover every bill');
  });

  it('refreshes after a new sale rather than serving a stale cache', async () => {
    const before = (await admin.get('/api/analytics')).body;
    const item = await makeItem({ price: 500, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, stock_quantity: 10 });
    assert.equal((await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }], payment_method: 'cash',
    })).status, 200);

    const after = (await admin.get('/api/analytics')).body;
    assert.equal(round2(after.todayRevenue - before.todayRevenue), 500);
    assert.equal(after.monthBillCount, before.monthBillCount + 1);
  });
});

describe('audit logs', () => {
  it('records who did what, and pages with a true total', async () => {
    const res = await admin.get('/api/audit-logs?limit=10');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
    assert.ok(res.body.data.length <= 10);
    assert.equal(typeof res.body.total, 'number');
    assert.ok(res.body.total > res.body.data.length, 'this run created more than 10 auditable events');

    const actions = new Set(res.body.data.map((r: any) => r.action));
    assert.ok(res.body.data.every((r: any) => r.user_name && r.user_role && r.details));
    assert.ok(actions.size > 0);
  });

  it('logs a bill creation with its number and amount', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, stock_quantity: 5 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }], payment_method: 'cash',
    });
    const logs = await admin.get(`/api/audit-logs?search=${encodeURIComponent(created.body.bill_number)}`);
    assert.equal(logs.status, 200);
    assert.equal(logs.body.total, 1);
    assert.equal(logs.body.data[0].action, 'create');
    assert.equal(logs.body.data[0].entity_type, 'bill');
  });

  it('logs a login', async () => {
    const logs = await admin.get('/api/audit-logs?search=signed%20in');
    assert.ok(logs.body.total > 0);
  });
});

describe('backups', () => {
  it('writes a restorable database file with owner-only permissions', async () => {
    const status = await admin.get('/api/backups/local/status');
    assert.equal(status.status, 200);
    assert.equal(typeof status.body.backup_directory, 'string');

    const res = await admin.post('/api/backups/local');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.match(res.body.fileName, /^vyaparabilling-backup-.*\.db$/);
    assert.ok(res.body.sizeBytes > 0);

    assert.ok(fs.existsSync(res.body.filePath), 'the backup file should exist on disk');
    const mode = fs.statSync(res.body.filePath).mode & 0o777;
    assert.equal(mode, 0o600, 'backups hold customer data and must not be world-readable');

    // It must be a real SQLite database, not a JSON blob.
    const header = Buffer.alloc(16);
    const fd = fs.openSync(res.body.filePath, 'r');
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    assert.equal(header.toString('utf8', 0, 15), 'SQLite format 3');

    fs.rmSync(res.body.filePath, { force: true });
  });
});

describe('purchase date filtering', () => {
  it('bounds the purchase list by the requested range', async () => {
    const all = await admin.get('/api/purchases?limit=5');
    assert.equal(all.status, 200);
    assert.ok(all.body.total > 0);

    const past = await admin.get('/api/purchases?from=2001-01-01&to=2001-12-31');
    assert.equal(past.status, 200);
    assert.equal(past.body.total, 0, 'a window in the past must match no purchases');
    assert.equal(past.body.data.length, 0);

    // Today's window must contain everything this run created.
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const now = await admin.get(`/api/purchases?from=${today}&to=${today}`);
    assert.equal(now.body.total, all.body.total);
  });

  it('rejects a malformed purchase date filter', async () => {
    assert.equal((await admin.get('/api/purchases?from=31-12-2024')).status, 400);
  });
});

describe('low stock', () => {
  it('is computed server-side across the whole catalogue', async () => {
    const low = await makeItem({ name: 'Almost Gone', stock_quantity: 2 });
    const plenty = await makeItem({ name: 'Well Stocked', stock_quantity: 5000 });

    const res = await admin.get('/api/analytics');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.lowStock), 'analytics must carry a low-stock list');
    assert.equal(res.body.lowStockThreshold, 10);

    const ids = res.body.lowStock.map((r: any) => r.id);
    assert.ok(ids.includes(low.id), 'an item under the threshold must be listed');
    assert.ok(!ids.includes(plenty.id), 'a well-stocked item must not be');

    // Ascending by stock, so the most urgent is first.
    const quantities = res.body.lowStock.map((r: any) => r.stock_quantity);
    assert.deepEqual(quantities, [...quantities].sort((a: number, b: number) => a - b));

    for (const row of res.body.lowStock) {
      for (const field of ['id', 'name', 'metric', 'stock_quantity']) {
        assert.ok(field in row, `low stock row is missing ${field}`);
      }
    }
  });
});
