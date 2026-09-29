/**
 * The customer passbook: every transaction with a customer, in one timeline.
 *
 * What must hold:
 *   - every bill appears exactly once, however it was paid;
 *   - a credit bill is not also counted through its ledger 'sale' entry;
 *   - each row's balance = previous balance + billed - received;
 *   - the balance after the last row equals customers.credit_balance;
 *   - a period that starts part-way through opens with the balance actually
 *     owed on that day, and opening + billed - received = closing.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { ADMIN_PASSWORD, client, round2, startServer, type Client, type TestServer } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server: TestServer;
let admin: Client;
let cashier: Client;
let phoneSeed = 5000000000;

const makeItem = async (price = 100) => {
  const res = await admin.post('/api/items', {
    name: `Item ${Math.random().toString(36).slice(2, 10)}`,
    hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    price, metric: 'piece', is_loose: false,
    gst_applicable: false, gst_mode: 'split', gst_rate: 0,
    sgst_rate: 0, cgst_rate: 0, igst_rate: 0, stock_quantity: 100000,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
};

const makeCustomer = async (extra: Record<string, unknown> = {}) => {
  const res = await admin.post('/api/customers', {
    shop_name: `Bakery ${Math.random().toString(36).slice(2, 8)}`,
    phone: String(phoneSeed++),
    ...extra,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
};

const bill = async (body: Record<string, unknown>) => {
  const res = await admin.post('/api/bills', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { bill_id: number; bill_number: string; total_amount: number };
};

const passbook = async (customerId: number, query = '') => {
  const res = await admin.get(`/api/customers/${customerId}/passbook?limit=1000${query}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

/** The chain every passbook must satisfy, oldest first from `opening`. */
const assertChains = (rowsOldestFirst: any[], opening = 0) => {
  let running = opening;
  for (const row of rowsOldestFirst) {
    assert.equal(
      round2(row.amount_billed - row.amount_received),
      round2(row.balance_change),
      `${row.kind} ${row.bill_number ?? row.ref_id}: change must be billed - received`
    );
    running = round2(running + row.balance_change);
    assert.equal(row.balance, running, `${row.kind} ${row.bill_number ?? row.ref_id}: balance must chain`);
  }
  return running;
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);

  assert.equal((await admin.post('/api/cashiers', {
    name: 'Passbook Cashier', username: 'passbook-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('passbook-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

describe('what appears in a passbook', () => {
  it('shows a cash bill as billed and received in full, leaving the balance alone', async () => {
    const itemId = await makeItem(250);
    const customerId = await makeCustomer();
    const b = await bill({ items: [{ id: itemId, quantity: 2 }], payment_method: 'cash', customer_id: customerId });

    const pb = await passbook(customerId);
    assert.equal(pb.total, 1, 'a cash bill must appear — it is a transaction with this customer');
    const row = pb.data[0];
    assert.equal(row.kind, 'bill');
    assert.equal(row.ref_id, b.bill_id);
    assert.equal(row.bill_number, b.bill_number);
    assert.equal(row.payment_method, 'cash');
    assert.equal(row.amount_billed, 500);
    assert.equal(row.amount_received, 500);
    assert.equal(row.balance_change, 0);
    assert.equal(row.balance, 0);
    assert.equal(row.item_count, 1);
    assert.equal(row.user_name, 'System Admin');
  });

  it('shows a UPI bill the same way', async () => {
    const itemId = await makeItem(80);
    const customerId = await makeCustomer();
    await bill({ items: [{ id: itemId, quantity: 5 }], payment_method: 'upi', customer_id: customerId });

    const row = (await passbook(customerId)).data[0];
    assert.equal(row.payment_method, 'upi');
    assert.equal(row.amount_billed, 400);
    assert.equal(row.amount_received, 400);
    assert.equal(row.balance, 0);
  });

  it('shows a credit bill as billed with nothing received, raising the balance', async () => {
    const itemId = await makeItem(120);
    const customerId = await makeCustomer();
    await bill({ items: [{ id: itemId, quantity: 3 }], payment_method: 'credit', customer_id: customerId });

    const pb = await passbook(customerId);
    assert.equal(pb.total, 1, 'the bill and its ledger sale entry must not both appear');
    const row = pb.data[0];
    assert.equal(row.amount_billed, 360);
    assert.equal(row.amount_received, 0);
    assert.equal(row.balance_change, 360);
    assert.equal(row.balance, 360);
  });

  it('shows a split bill with only cash + UPI as received', async () => {
    const itemId = await makeItem(100);
    const customerId = await makeCustomer();
    await bill({
      items: [{ id: itemId, quantity: 10 }],
      payment_method: 'split',
      customer_id: customerId,
      cash_amount: 400, upi_amount: 250, credit_amount: 350,
    });

    const row = (await passbook(customerId)).data[0];
    assert.equal(row.amount_billed, 1000);
    assert.equal(row.amount_received, 650);
    assert.equal(row.balance_change, 350);
    assert.equal(row.cash_amount, 400);
    assert.equal(row.upi_amount, 250);
    assert.equal(row.credit_amount, 350);
  });

  it('shows a repayment as received, lowering the balance', async () => {
    const customerId = await makeCustomer({ credit_balance: 900 });
    assert.equal((await admin.post(`/api/customers/${customerId}/credit-payments`, {
      amount: 400, note: 'Cash at counter',
    })).status, 201);

    const pb = await passbook(customerId, '&order=asc');
    assert.deepEqual(pb.data.map((r: any) => r.kind), ['opening', 'payment']);
    const payment = pb.data[1];
    assert.equal(payment.amount_billed, 0);
    assert.equal(payment.amount_received, 400);
    assert.equal(payment.balance_change, -400);
    assert.equal(payment.balance, 500);
    assert.equal(payment.note, 'Cash at counter');
  });

  it('places adjustments by direction', async () => {
    const customerId = await makeCustomer({ credit_balance: 100 });
    const detail = (await admin.get(`/api/customers?limit=1000`)).body.data.find((c: any) => c.id === customerId);

    // Up, then down.
    assert.equal((await admin.put(`/api/customers/${customerId}`, {
      shop_name: detail.shop_name, phone: detail.phone, credit_balance: 250, credit_note: 'Missed bill',
    })).status, 200);
    assert.equal((await admin.put(`/api/customers/${customerId}`, {
      shop_name: detail.shop_name, phone: detail.phone, credit_balance: 200, credit_note: 'Goodwill',
    })).status, 200);

    const rows = (await passbook(customerId, '&order=asc')).data;
    assert.deepEqual(rows.map((r: any) => r.kind), ['opening', 'adjustment', 'adjustment']);
    assert.deepEqual(rows.map((r: any) => [r.amount_billed, r.amount_received]), [[100, 0], [150, 0], [0, 50]]);
    assert.equal(rows[2].balance, 200);
  });

  it('never shows another customer’s bills, or walk-in bills', async () => {
    const itemId = await makeItem(10);
    const mine = await makeCustomer();
    const theirs = await makeCustomer();

    await bill({ items: [{ id: itemId, quantity: 1 }], payment_method: 'cash', customer_id: mine });
    await bill({ items: [{ id: itemId, quantity: 1 }], payment_method: 'credit', customer_id: theirs });
    await bill({ items: [{ id: itemId, quantity: 1 }], payment_method: 'cash' });

    const pb = await passbook(mine);
    assert.equal(pb.total, 1);
  });
});

describe('balances', () => {
  it('chain row by row and land on the stored balance', async () => {
    const itemId = await makeItem(75);
    const customerId = await makeCustomer({ credit_balance: 500 });

    await bill({ items: [{ id: itemId, quantity: 4 }], payment_method: 'credit', customer_id: customerId }); // +300
    await bill({ items: [{ id: itemId, quantity: 2 }], payment_method: 'cash', customer_id: customerId });   //   0
    assert.equal((await admin.post(`/api/customers/${customerId}/credit-payments`, { amount: 350 })).status, 201); // -350
    await bill({
      items: [{ id: itemId, quantity: 6 }], payment_method: 'split', customer_id: customerId,
      cash_amount: 200, upi_amount: 0, credit_amount: 250,
    }); // +250
    await bill({ items: [{ id: itemId, quantity: 1 }], payment_method: 'upi', customer_id: customerId });    //   0

    const pb = await passbook(customerId, '&order=asc');
    assert.equal(pb.total, 6, 'opening + five transactions');

    const closing = assertChains(pb.data);
    assert.equal(closing, 700);
    assert.equal(pb.customer.credit_balance, 700, 'the passbook must agree with the account');

    // The summary is the same arithmetic, and says so.
    assert.equal(pb.summary.opening_balance, 0);
    assert.equal(pb.summary.total_billed, round2(500 + 300 + 150 + 450 + 75));
    assert.equal(pb.summary.total_received, round2(150 + 350 + 200 + 75));
    assert.equal(pb.summary.closing_balance, 700);
    assert.equal(pb.summary.bill_count, 4);
  });

  it('stay consistent under concurrent billing', async () => {
    const itemId = await makeItem(40);
    const customerId = await makeCustomer();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        admin.post('/api/bills', {
          items: [{ id: itemId, quantity: 1 }],
          payment_method: i % 2 ? 'credit' : 'cash',
          customer_id: customerId,
        })
      )
    );
    assert.ok(results.every((r) => r.status === 200));

    const pb = await passbook(customerId, '&order=asc');
    assert.equal(pb.total, 10);
    assert.equal(assertChains(pb.data), 200);
    assert.equal(pb.customer.credit_balance, 200);
  });
});

describe('a period that starts part-way through', () => {
  let customerId: number;

  before(async () => {
    const itemId = await makeItem(100);
    customerId = await makeCustomer();

    // Four transactions; the first three are then moved into the past, in
    // their original order, so the history spans several months.
    const a = await bill({ items: [{ id: itemId, quantity: 3 }], payment_method: 'credit', customer_id: customerId }); // +300
    assert.equal((await admin.post(`/api/customers/${customerId}/credit-payments`, { amount: 100 })).status, 201);   // -100
    const b = await bill({ items: [{ id: itemId, quantity: 2 }], payment_method: 'cash', customer_id: customerId });   //    0
    await bill({ items: [{ id: itemId, quantity: 1.5 }], payment_method: 'credit', customer_id: customerId });          // +150 (today)

    const payment = (await admin.get(`/api/customers/${customerId}/credit-entries`)).body.data
      .find((e: any) => e.entry_type === 'payment');

    const raw = new Database(server.dbPath);
    raw.prepare('UPDATE bills SET created_at = ? WHERE id = ?').run('2026-01-10 06:00:00', a.bill_id);
    raw.prepare('UPDATE customer_credit_entries SET created_at = ? WHERE bill_id = ?').run('2026-01-10 06:00:00', a.bill_id);
    raw.prepare('UPDATE customer_credit_entries SET created_at = ? WHERE id = ?').run('2026-01-20 06:00:00', payment.id);
    raw.prepare('UPDATE bills SET created_at = ? WHERE id = ?').run('2026-02-05 06:00:00', b.bill_id);
    raw.close();
  });

  it('opens with the balance owed going into the period', async () => {
    const pb = await passbook(customerId, '&from=2026-02-01&order=asc');
    assert.equal(pb.total, 2, 'only the February cash bill and today’s credit bill');
    assert.equal(pb.summary.opening_balance, 200, '300 billed on credit, less 100 repaid, before February');
    assertChains(pb.data, 200);
    assert.equal(pb.summary.total_billed, 350);
    assert.equal(pb.summary.total_received, 200);
    assert.equal(pb.summary.closing_balance, 350);
    assert.equal(pb.customer.credit_balance, 350);
  });

  it('closes at the end of the period, not today', async () => {
    const pb = await passbook(customerId, '&from=2026-01-15&to=2026-01-31');
    assert.equal(pb.total, 1, 'just the repayment');
    assert.equal(pb.data[0].kind, 'payment');
    assert.equal(pb.summary.opening_balance, 300);
    assert.equal(pb.summary.closing_balance, 200);
    assert.equal(pb.summary.bill_count, 0);
  });

  it('is empty, at zero, for a period before any activity', async () => {
    const pb = await passbook(customerId, '&from=2025-01-01&to=2025-12-31');
    assert.equal(pb.total, 0);
    assert.equal(pb.summary.opening_balance, 0);
    assert.equal(pb.summary.closing_balance, 0);
  });

  it('carries the true running balance on every row of a filtered period', async () => {
    // The running balance is computed over the whole history before the
    // filter, so the first row of a mid-history period is not reset to zero.
    const pb = await passbook(customerId, '&from=2026-02-01&order=asc');
    assert.equal(pb.data[0].balance, 200, 'the February cash bill leaves the balance at 200');
    assert.equal(pb.data[1].balance, 350);
  });
});

describe('ordering and paging', () => {
  let customerId: number;

  before(async () => {
    const itemId = await makeItem(10);
    customerId = await makeCustomer();
    for (let i = 1; i <= 5; i++) {
      await bill({ items: [{ id: itemId, quantity: i }], payment_method: 'credit', customer_id: customerId });
    }
  });

  it('defaults to newest first', async () => {
    const pb = await passbook(customerId);
    assert.equal(pb.order, 'desc');
    // The same running balances as oldest-first, read from the other end.
    assert.deepEqual(pb.data.map((r: any) => r.balance), [150, 100, 60, 30, 10]);
  });

  it('can read oldest first', async () => {
    const pb = await passbook(customerId, '&order=asc');
    assert.deepEqual(pb.data.map((r: any) => r.balance), [10, 30, 60, 100, 150]);
  });

  it('pages with a true total', async () => {
    const first = await admin.get(`/api/customers/${customerId}/passbook?limit=2&offset=0&order=asc`);
    assert.equal(first.body.total, 5);
    assert.deepEqual(first.body.data.map((r: any) => r.balance), [10, 30]);

    const second = await admin.get(`/api/customers/${customerId}/passbook?limit=2&offset=2&order=asc`);
    assert.deepEqual(second.body.data.map((r: any) => r.balance), [60, 100]);

    // The summary covers the whole period, not just the page.
    assert.equal(second.body.summary.total_billed, 150);
  });
});

describe('access and errors', () => {
  it('is readable by a cashier', async () => {
    const customerId = await makeCustomer();
    assert.equal((await cashier.get(`/api/customers/${customerId}/passbook`)).status, 200);
  });

  it('carries the customer’s details for the page header', async () => {
    const customerId = await makeCustomer({ name: 'Header Person', gstin: '29AAAAA0000A1Z5', address: '1 Main Rd' });
    const pb = await passbook(customerId);
    assert.equal(pb.customer.name, 'Header Person');
    assert.equal(pb.customer.gstin, '29AAAAA0000A1Z5');
    assert.equal(pb.customer.address, '1 Main Rd');
    assert.ok(pb.customer.shop_name);
  });

  it('404s for a customer that does not exist', async () => {
    assert.equal((await admin.get('/api/customers/987654321/passbook')).status, 404);
  });

  it('rejects bad input', async () => {
    const customerId = await makeCustomer();
    assert.equal((await admin.get('/api/customers/abc/passbook')).status, 400);
    assert.equal((await admin.get(`/api/customers/${customerId}/passbook?from=01-02-2026`)).status, 400);
    assert.equal((await admin.get(`/api/customers/${customerId}/passbook?from=2026-03-01&to=2026-02-01`)).status, 400);
    assert.equal((await admin.get(`/api/customers/${customerId}/passbook?order=sideways`)).status, 400);
    assert.equal((await admin.get(`/api/customers/${customerId}/passbook?limit=0`)).status, 400);
  });
});
