/**
 * Sales credit: what customers owe, and which bills that is.
 *
 * Repayments are taken against a customer's balance, so they settle the
 * oldest credit first: the unpaid bills are the most recent credit the balance
 * still covers, the oldest of them possibly part paid. They must always add up
 * to the balance, and age into 0-30 / 31-60 / 61-90 / 90+ day buckets.
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
let itemId: number;

let phoneSeed = 6200000000;
const makeCustomer = async (shop_name: string) => {
  const res = await admin.post('/api/customers', { shop_name, phone: String(phoneSeed++) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
};

/** A credit sale of `quantity` × ₹100 (no GST), dated `daysAgo` days back. */
const creditSale = async (customerId: number, quantity: number, daysAgo = 0) => {
  const res = await admin.post('/api/bills', { items: [{ id: itemId, quantity }], payment_method: 'credit', customer_id: customerId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  if (daysAgo > 0) {
    const db = new Database(server.dbPath);
    try {
      const shift = `-${daysAgo} days`;
      db.prepare('UPDATE bills SET created_at = datetime(created_at, ?) WHERE id = ?').run(shift, res.body.bill_id);
      db.prepare('UPDATE customer_credit_entries SET created_at = datetime(created_at, ?) WHERE bill_id = ?').run(shift, res.body.bill_id);
    } finally {
      db.close();
    }
  }
  return res.body as { bill_id: number; bill_number: string };
};

const salesCredit = async (as: Client = admin) => {
  const res = await as.get('/api/sales-credit');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { total_due: number; customer_count: number; ageing: any[]; customers: any[] };
};
const entryFor = async (customerId: number) => (await salesCredit()).customers.find((c) => c.id === customerId);

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', {
    name: 'Credit Cashier', username: 'credit-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('credit-cashier', 'cashier-pass-1')).status, 200);
  itemId = (await makeStockedItem(admin, {
    price: 100, stock_quantity: 100000, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0,
  })).id;
});

after(async () => { await server?.stop(); });

describe('sales credit', () => {
  it('lists unpaid credit bills, oldest first, adding up to the balance', async () => {
    const customer = await makeCustomer('Ageing Bakery');
    const oldest = await creditSale(customer, 5, 100);
    const middle = await creditSale(customer, 3, 45);
    const newest = await creditSale(customer, 2, 3);

    const entry = await entryFor(customer);
    assert.equal(entry.balance, 1000);
    assert.equal(entry.display_name, 'Ageing Bakery');
    assert.deepEqual(entry.unpaid.map((l: any) => [l.bill_number, l.outstanding, l.age_days]), [
      [oldest.bill_number, 500, 100],
      [middle.bill_number, 300, 45],
      [newest.bill_number, 200, 3],
    ]);
    assert.equal(entry.oldest_age_days, 100);
    assert.deepEqual(entry.ageing, { d0_30: 200, d31_60: 300, d61_90: 0, d90_plus: 500 });
  });

  it('applies a repayment to the oldest bill first', async () => {
    const customer = await makeCustomer('Part Paid Bakery');
    const oldest = await creditSale(customer, 5, 70);
    const newest = await creditSale(customer, 4, 10);
    assert.equal((await admin.post(`/api/customers/${customer}/credit-payments`, { amount: 300 })).status, 201);

    const entry = await entryFor(customer);
    assert.equal(entry.balance, 600);
    assert.deepEqual(entry.unpaid.map((l: any) => [l.bill_number, l.credit_amount, l.outstanding]), [
      [oldest.bill_number, 500, 200],
      [newest.bill_number, 400, 400],
    ], 'the oldest bill is part paid; the newer one untouched');
    assert.equal(entry.last_payment_amount, -300);
    assert.ok(entry.last_payment_at);

    assert.equal((await admin.post(`/api/customers/${customer}/credit-payments`, { amount: 200 })).status, 201);
    const after = await entryFor(customer);
    assert.deepEqual(after.unpaid.map((l: any) => l.bill_number), [newest.bill_number], 'the oldest is now paid off');
  });

  it('includes an opening balance, and drops a customer once they are paid up', async () => {
    const res = await admin.post('/api/customers', { shop_name: 'Opening Balance Bakery', phone: String(phoneSeed++), credit_balance: 750 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const entry = await entryFor(res.body.id);
    assert.equal(entry.unpaid.length, 1);
    assert.equal(entry.unpaid[0].kind, 'opening');
    assert.equal(entry.unpaid[0].outstanding, 750);

    assert.equal((await admin.post(`/api/customers/${res.body.id}/credit-payments`, { amount: 750 })).status, 201);
    assert.equal(await entryFor(res.body.id), undefined, 'nothing owed, not listed');
  });

  it('totals agree with every customer’s balance', async () => {
    const report = await salesCredit();
    const balances = report.customers.reduce((acc, c) => acc + c.balance, 0);
    assert.equal(report.total_due, Math.round(balances * 100) / 100);
    for (const c of report.customers) {
      const lines = Math.round(c.unpaid.reduce((acc: number, l: any) => acc + l.outstanding, 0) * 100) / 100;
      assert.equal(lines, c.balance, `${c.display_name}: unpaid lines add up to the balance`);
    }
    const aged = Math.round(report.ageing.reduce((acc, b) => acc + b.amount, 0) * 100) / 100;
    assert.equal(aged, report.total_due, 'the ageing buckets add up to the total');
  });

  it('is open to cashiers, who already take repayments', async () => {
    const report = await salesCredit(cashier);
    assert.ok(report.customer_count > 0);
  });
});
