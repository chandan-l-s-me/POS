/**
 * The per-customer credit ledger.
 *
 * `customers.credit_balance` is a single number; this table is the record of
 * how it got there. The invariant that matters is that the two can never
 * disagree — every path that moves the balance must leave an entry, and the
 * last entry's `balance_after` must equal the stored balance.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, round2, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;

const makeItem = async (overrides: Record<string, unknown> = {}) => {
  const body = {
    name: `Item ${Math.random().toString(36).slice(2, 10)}`,
    hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    price: 100, metric: 'piece', is_loose: false,
    gst_applicable: false, gst_mode: 'split', gst_rate: 0,
    sgst_rate: 0, cgst_rate: 0, igst_rate: 0, stock_quantity: 10000,
    ...overrides,
  };
  const res = await admin.post('/api/items', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: res.body.id as number, ...body };
};

let phoneSeed = 7000000000;
const makeCustomer = async (overrides: Record<string, unknown> = {}) => {
  const body = {
    name: `Customer ${Math.random().toString(36).slice(2, 8)}`,
    phone: String(phoneSeed++),
    ...overrides,
  };
  const res = await admin.post('/api/customers', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { id: res.body.id as number, ...body };
};

const balanceOf = async (id: number) => {
  const res = await admin.get(`/api/customers/${id}/credit-entries?limit=1`);
  assert.equal(res.status, 200);
  return res.body.customer.credit_balance as number;
};

const ledgerOf = async (id: number) => {
  const res = await admin.get(`/api/customers/${id}/credit-entries?limit=1000`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};

/** Oldest-first, the order a statement is read in. */
const chronological = (entries: any[]) => [...entries].reverse();

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);

  const created = await admin.post('/api/cashiers', {
    name: 'Ledger Cashier', username: 'ledger-cashier', password: 'cashier-pass-1',
  });
  assert.equal(created.status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('ledger-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

describe('what lands in the ledger', () => {
  it('records an opening balance set at creation', async () => {
    const customer = await makeCustomer({ credit_balance: 750 });
    const ledger = await ledgerOf(customer.id);

    assert.equal(ledger.total, 1);
    const entry = ledger.data[0];
    assert.equal(entry.entry_type, 'opening');
    assert.equal(entry.amount, 750);
    assert.equal(entry.balance_before, 0);
    assert.equal(entry.balance_after, 750);
    assert.equal(entry.user_name, 'System Admin');
    assert.ok(entry.created_at, 'every entry is timestamped');
    assert.match(entry.note, /Opening balance/);
  });

  it('leaves no entry for a customer created with no credit', async () => {
    const customer = await makeCustomer();
    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 0);
    assert.equal(ledger.customer.credit_balance, 0);
  });

  it('records a credit sale, pointing at the bill', async () => {
    const item = await makeItem({ price: 250 });
    const customer = await makeCustomer();

    const bill = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 2 }],
      payment_method: 'credit',
      customer_id: customer.id,
    });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 1);
    const entry = ledger.data[0];
    assert.equal(entry.entry_type, 'sale');
    assert.equal(entry.amount, 500);
    assert.equal(entry.balance_before, 0);
    assert.equal(entry.balance_after, 500);
    assert.equal(entry.bill_id, bill.body.bill_id);
    assert.equal(entry.bill_number, bill.body.bill_number, 'the statement names the bill');
    assert.equal(entry.user_name, 'System Admin', 'and who rang it up');
  });

  it('records only the credit portion of a split payment', async () => {
    const item = await makeItem({ price: 100 });
    const customer = await makeCustomer();

    const bill = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 10 }],
      payment_method: 'split',
      customer_id: customer.id,
      cash_amount: 400, upi_amount: 300, credit_amount: 300,
    });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 1);
    assert.equal(ledger.data[0].amount, 300, 'only what went on credit');
    assert.equal(ledger.data[0].entry_type, 'sale');
  });

  it('records a cashier by name when they make the sale', async () => {
    const item = await makeItem({ price: 60 });
    const customer = await makeCustomer();

    assert.equal((await cashier.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'credit',
      customer_id: customer.id,
    })).status, 200);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.data[0].user_name, 'Ledger Cashier');
  });

  it('records an admin correcting the balance, with the reason given', async () => {
    const customer = await makeCustomer({ credit_balance: 1000 });

    const res = await admin.put(`/api/customers/${customer.id}`, {
      name: customer.name,
      phone: customer.phone,
      credit_balance: 400,
      credit_note: 'Wrote off disputed amount after discussion',
    });
    assert.equal(res.status, 200);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 2);
    const entry = ledger.data[0];
    assert.equal(entry.entry_type, 'adjustment');
    assert.equal(entry.amount, -600, 'signed: negative reduces what is owed');
    assert.equal(entry.balance_before, 1000);
    assert.equal(entry.balance_after, 400);
    assert.equal(entry.note, 'Wrote off disputed amount after discussion');
  });

  it('leaves no entry when an edit does not touch the balance', async () => {
    const customer = await makeCustomer({ credit_balance: 500 });
    assert.equal((await admin.put(`/api/customers/${customer.id}`, {
      name: 'Renamed Only',
      phone: customer.phone,
      address: 'A new address',
      credit_balance: 500,
    })).status, 200);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 1, 'still just the opening entry');
  });

  it('leaves no entry when a cashier edits contact details', async () => {
    const customer = await makeCustomer({ credit_balance: 300 });
    assert.equal((await cashier.put(`/api/customers/${customer.id}`, {
      name: customer.name,
      phone: customer.phone,
      credit_balance: 0,
    })).status, 200);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 1, 'a cashier cannot move the balance, so nothing is logged');
    assert.equal(ledger.customer.credit_balance, 300);
  });
});

describe('repayments', () => {
  it('reduces the balance and records the payment', async () => {
    const customer = await makeCustomer({ credit_balance: 1000 });

    const res = await admin.post(`/api/customers/${customer.id}/credit-payments`, {
      amount: 350,
      note: 'Cash received at counter',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.amount, 350);
    assert.equal(res.body.balance_before, 1000);
    assert.equal(res.body.balance_after, 650);

    assert.equal(await balanceOf(customer.id), 650);

    const ledger = await ledgerOf(customer.id);
    const entry = ledger.data[0];
    assert.equal(entry.entry_type, 'payment');
    assert.equal(entry.amount, -350);
    assert.equal(entry.balance_after, 650);
    assert.equal(entry.note, 'Cash received at counter');
  });

  it('lets a cashier take a payment', async () => {
    // Taking money at the counter is the cashier's job; only *editing* the
    // balance outright is restricted to an admin.
    const customer = await makeCustomer({ credit_balance: 200 });
    const res = await cashier.post(`/api/customers/${customer.id}/credit-payments`, { amount: 200 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(await balanceOf(customer.id), 0);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.data[0].user_name, 'Ledger Cashier');
  });

  it('refuses more than is outstanding', async () => {
    const customer = await makeCustomer({ credit_balance: 100 });
    const res = await admin.post(`/api/customers/${customer.id}/credit-payments`, { amount: 250 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /more than the ₹100.00 outstanding/);
    assert.equal(await balanceOf(customer.id), 100, 'a refused payment moves nothing');
    assert.equal((await ledgerOf(customer.id)).total, 1);
  });

  it('refuses a payment against nothing owed', async () => {
    const customer = await makeCustomer();
    const res = await admin.post(`/api/customers/${customer.id}/credit-payments`, { amount: 50 });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /no outstanding credit/);
  });

  it('refuses zero, negative and nonsense amounts', async () => {
    const customer = await makeCustomer({ credit_balance: 500 });
    for (const amount of [0, -100, 'abc', null, {}, Infinity]) {
      const res = await admin.post(`/api/customers/${customer.id}/credit-payments`, { amount });
      assert.equal(res.status, 400, `amount ${JSON.stringify(amount)} should be refused`);
    }
    assert.equal(await balanceOf(customer.id), 500);
  });

  it('404s for a customer that does not exist', async () => {
    assert.equal((await admin.post('/api/customers/987654321/credit-payments', { amount: 10 })).status, 404);
  });
});

describe('the ledger reconciles to the balance', () => {
  it('through a full sequence of sales, payments and corrections', async () => {
    const item = await makeItem({ price: 125 });
    const customer = await makeCustomer({ credit_balance: 200 });

    // Opening 200, + 375 sale, - 300 payment, + 250 sale, adjust to 500.
    assert.equal((await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 3 }], payment_method: 'credit', customer_id: customer.id,
    })).status, 200);
    assert.equal((await admin.post(`/api/customers/${customer.id}/credit-payments`, { amount: 300 })).status, 201);
    assert.equal((await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 2 }], payment_method: 'credit', customer_id: customer.id,
    })).status, 200);
    assert.equal((await admin.put(`/api/customers/${customer.id}`, {
      name: customer.name, phone: customer.phone, credit_balance: 500, credit_note: 'Rounded off',
    })).status, 200);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 5);

    const entries = chronological(ledger.data);
    assert.deepEqual(
      entries.map((e: any) => [e.entry_type, e.amount]),
      [['opening', 200], ['sale', 375], ['payment', -300], ['sale', 250], ['adjustment', -25]]
    );

    // Each entry must chain onto the one before it.
    let running = 0;
    for (const entry of entries) {
      assert.equal(entry.balance_before, running, `${entry.entry_type} starts where the last ended`);
      running = round2(running + entry.amount);
      assert.equal(entry.balance_after, running, `${entry.entry_type} ends at the running total`);
    }

    // And the chain must land exactly on the stored balance.
    assert.equal(running, 500);
    assert.equal(ledger.customer.credit_balance, 500);
  });

  it('stays consistent under concurrent credit sales', async () => {
    const item = await makeItem({ price: 50 });
    const customer = await makeCustomer();

    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        admin.post('/api/bills', {
          items: [{ id: item.id, quantity: 1 }],
          payment_method: 'credit',
          customer_id: customer.id,
        })
      )
    );
    assert.equal(results.filter((r) => r.status === 200).length, 12);

    const ledger = await ledgerOf(customer.id);
    assert.equal(ledger.total, 12);
    assert.equal(ledger.customer.credit_balance, 600);

    // No interleaving may leave a gap or a repeat in the running balance.
    const entries = chronological(ledger.data);
    let running = 0;
    for (const entry of entries) {
      assert.equal(entry.balance_before, running);
      running = round2(running + entry.amount);
      assert.equal(entry.balance_after, running);
    }
    assert.equal(running, 600);
  });

  it('writes nothing when the sale it belongs to is rejected', async () => {
    const item = await makeItem({ price: 100, stock_quantity: 1 });
    const customer = await makeCustomer({ credit_balance: 100 });

    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 5 }],
      payment_method: 'credit',
      customer_id: customer.id,
    });
    assert.equal(res.status, 400);

    assert.equal(await balanceOf(customer.id), 100, 'balance untouched');
    assert.equal((await ledgerOf(customer.id)).total, 1, 'no phantom ledger entry');
  });
});

describe('reading a statement', () => {
  it('returns newest first and pages', async () => {
    const item = await makeItem({ price: 10 });
    const customer = await makeCustomer();
    for (let i = 0; i < 5; i++) {
      assert.equal((await admin.post('/api/bills', {
        items: [{ id: item.id, quantity: 1 }], payment_method: 'credit', customer_id: customer.id,
      })).status, 200);
    }

    const page = await admin.get(`/api/customers/${customer.id}/credit-entries?limit=2&offset=0`);
    assert.equal(page.status, 200);
    assert.equal(page.body.total, 5);
    assert.equal(page.body.data.length, 2);
    assert.equal(page.body.limit, 2);
    // Newest first: the last entry has the highest running balance.
    assert.equal(page.body.data[0].balance_after, 50);
    assert.equal(page.body.data[1].balance_after, 40);

    const second = await admin.get(`/api/customers/${customer.id}/credit-entries?limit=2&offset=2`);
    assert.equal(second.body.data[0].balance_after, 30);
  });

  it('is readable by a cashier, who needs it at the counter', async () => {
    const customer = await makeCustomer({ credit_balance: 100 });
    assert.equal((await cashier.get(`/api/customers/${customer.id}/credit-entries`)).status, 200);
  });

  it('404s for a customer that does not exist', async () => {
    assert.equal((await admin.get('/api/customers/987654321/credit-entries')).status, 404);
  });

  it('rejects a non-numeric customer id', async () => {
    assert.equal((await admin.get('/api/customers/not-a-number/credit-entries')).status, 400);
  });
});
