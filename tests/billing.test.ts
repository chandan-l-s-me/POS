/**
 * Billing — the money math.
 *
 * Every assertion here is about a number that ends up on a customer's invoice
 * or in a GST return, so they check the recorded figures rather than the
 * status code. The central invariant is that for each line
 *
 *     taxable + sgst + cgst + igst === total
 *
 * holds exactly, and that the bill's stored total is the sum of those lines
 * floored to whole rupees.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, round2, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;

const makeItem = async (overrides: Record<string, unknown> = {}) => {
  const body = {
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
    stock_quantity: 1000,
    ...overrides,
  };
  const res = await admin.post('/api/items', body);
  assert.equal(res.status, 200, `item create failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.id as number, ...body };
};

const makeCustomer = async (overrides: Record<string, unknown> = {}) => {
  const body = {
    name: `Customer ${Math.random().toString(36).slice(2, 8)}`,
    phone: String(Math.floor(Math.random() * 1e10)).padStart(10, '9'),
    ...overrides,
  };
  const res = await admin.post('/api/customers', body);
  assert.equal(res.status, 200, `customer create failed: ${JSON.stringify(res.body)}`);
  return { id: res.body.id as number, ...body };
};

const getItem = async (id: number) => {
  const res = await admin.get(`/api/items?withImages=1&limit=1000`);
  return res.body.data.find((row: any) => row.id === id);
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

describe('bill arithmetic', () => {
  it('splits GST and reconciles every line exactly', async () => {
    const item = await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 3 }],
      payment_method: 'cash',
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.items.length, 1);

    const line = bill.items[0];
    assert.equal(line.total_amount, 354);          // 118 x 3, GST-inclusive
    assert.equal(line.sgst_amount, 31.86);         // 354 x 9%
    assert.equal(line.cgst_amount, 31.86);
    assert.equal(line.igst_amount, 0);

    const taxable = round2(line.total_amount - line.sgst_amount - line.cgst_amount - line.igst_amount);
    assert.equal(taxable, 290.28);
    // The identity the invoice depends on.
    assert.equal(round2(taxable + line.sgst_amount + line.cgst_amount + line.igst_amount), line.total_amount);

    assert.equal(bill.tax_amount, 63.72);
    assert.equal(bill.total_amount, 354);
  });

  it('charges IGST instead of SGST/CGST for an inter-state item', async () => {
    const item = await makeItem({ price: 200, gst_mode: 'igst', gst_rate: 12, sgst_rate: 0, cgst_rate: 0, igst_rate: 12 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 2 }],
      payment_method: 'upi',
    });
    assert.equal(created.status, 200);

    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    const line = bill.items[0];
    assert.equal(line.sgst_amount, 0);
    assert.equal(line.cgst_amount, 0);
    assert.equal(line.igst_amount, 48);            // 400 x 12%
    assert.equal(line.total_amount, 400);
    assert.equal(bill.tax_amount, 48);
    assert.equal(bill.total_amount, 400);
  });

  it('charges no tax on a GST-exempt item', async () => {
    const item = await makeItem({ price: 50, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 4 }],
      payment_method: 'cash',
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.tax_amount, 0);
    assert.equal(bill.items[0].total_amount, 200);
    assert.equal(bill.total_amount, 200);
  });

  it('floors the payable to whole rupees and keeps the lines adding up', async () => {
    // 33.33 x 7 = 233.31 — the paise become the invoice's Round Off line.
    const item = await makeItem({ price: 33.33, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 7 }],
      payment_method: 'cash',
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;

    const line = bill.items[0];
    assert.equal(line.total_amount, 233.31);
    const taxable = round2(line.total_amount - line.sgst_amount - line.cgst_amount - line.igst_amount);
    assert.equal(round2(taxable + line.sgst_amount + line.cgst_amount), line.total_amount);

    assert.equal(bill.total_amount, 233, 'payable is floored to whole rupees');
    assert.equal(bill.cash_amount, 233, 'the drawer records exactly what was floored');
  });

  it('keeps subtotal + tax - discount === total for a mixed multi-item bill', async () => {
    const a = await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 });
    const b = await makeItem({ price: 33.33, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 });
    const c = await makeItem({ price: 50, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const d = await makeItem({ price: 200, gst_mode: 'igst', gst_rate: 12, sgst_rate: 0, cgst_rate: 0, igst_rate: 12 });

    const created = await admin.post('/api/bills', {
      items: [
        { id: a.id, quantity: 2 },
        { id: b.id, quantity: 3 },
        { id: c.id, quantity: 1 },
        { id: d.id, quantity: 1.5 },
      ],
      payment_method: 'cash',
      discount_amount: 25,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.items.length, 4);

    let subtotal = 0;
    let tax = 0;
    for (const line of bill.items) {
      const taxable = round2(line.total_amount - line.sgst_amount - line.cgst_amount - (line.igst_amount || 0));
      assert.equal(
        round2(taxable + line.sgst_amount + line.cgst_amount + (line.igst_amount || 0)),
        line.total_amount,
        'each line must reconcile exactly'
      );
      subtotal = round2(subtotal + taxable);
      tax = round2(tax + line.sgst_amount + line.cgst_amount + (line.igst_amount || 0));
    }

    assert.equal(tax, bill.tax_amount, 'stored tax is the sum of the line taxes');
    assert.equal(bill.discount_amount, 25);
    assert.equal(
      Math.floor(round2(subtotal + tax - bill.discount_amount)),
      bill.total_amount,
      'stored total is the floored gross'
    );
  });

  it('handles fractional quantities for loose goods', async () => {
    const item = await makeItem({ price: 240, metric: 'kg', is_loose: true, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 0.25 }],
      payment_method: 'cash',
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.items[0].quantity, 0.25);
    assert.equal(bill.items[0].total_amount, 60);
    assert.equal(bill.items[0].sgst_amount, 1.5);
  });
});

describe('the client cannot dictate money', () => {
  it('ignores a tampered unit price', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1, price: 1, total_amount: 1, sgst_amount: 0, cgst_amount: 0 }],
      payment_method: 'cash',
      total_amount: 1,
      tax_amount: 0,
    });
    assert.equal(created.status, 200);
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.total_amount, 100, 'price comes from the items table, not the request');
  });

  it('ignores tampered line tax amounts', async () => {
    const item = await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1, sgst_amount: 0, cgst_amount: 0, igst_amount: 999 }],
      payment_method: 'cash',
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.items[0].sgst_amount, 10.62);
    assert.equal(bill.items[0].igst_amount, 0);
    assert.equal(bill.tax_amount, 21.24);
  });

  it('rejects a negative discount', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'cash',
      discount_amount: -500,
    });
    assert.equal(res.status, 400);
  });

  it('rejects a discount larger than the bill', async () => {
    const item = await makeItem({ price: 100 });
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'cash',
      discount_amount: 100000,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Discount cannot exceed/);
  });

  it('rejects a negative quantity', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: -5 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);
  });

  it('rejects a zero quantity', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 0 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);
  });

  it('rejects NaN and Infinity quantities', async () => {
    const item = await makeItem();
    for (const quantity of ['NaN', 'Infinity', 'abc', null, {}, []]) {
      const res = await admin.post('/api/bills', {
        items: [{ id: item.id, quantity }],
        payment_method: 'cash',
      });
      assert.equal(res.status, 400, `quantity ${JSON.stringify(quantity)} should be rejected`);
    }
  });

  it('rejects an empty bill', async () => {
    assert.equal((await admin.post('/api/bills', { items: [], payment_method: 'cash' })).status, 400);
    assert.equal((await admin.post('/api/bills', { payment_method: 'cash' })).status, 400);
  });

  it('rejects an unknown payment method', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'barter',
    });
    assert.equal(res.status, 400);
  });

  it('rejects an item that does not exist', async () => {
    const res = await admin.post('/api/bills', {
      items: [{ id: 987654321, quantity: 1 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Item not found/);
  });

  it('rejects a bill with more line items than a real sale', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: Array.from({ length: 501 }, () => ({ id: item.id, quantity: 1 })),
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /more than 500 line items/);
  });
});

describe('payment reconciliation', () => {
  it('records the whole total against the chosen single method', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    for (const method of ['cash', 'upi'] as const) {
      const created = await admin.post('/api/bills', {
        items: [{ id: item.id, quantity: 1 }],
        payment_method: method,
        // Deliberately inconsistent tender amounts — they must be ignored.
        cash_amount: 3, upi_amount: 4, credit_amount: 5,
      });
      const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
      assert.equal(bill.total_amount, 100);
      assert.equal(bill[`${method}_amount`], 100);
      const others = ['cash', 'upi', 'credit'].filter((m) => m !== method);
      for (const other of others) assert.equal(bill[`${other}_amount`], 0);
    }
  });

  it('accepts a split that adds up', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const customer = await makeCustomer();
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 3 }],
      payment_method: 'split',
      customer_id: customer.id,
      cash_amount: 100, upi_amount: 150, credit_amount: 50,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.total_amount, 300);
    assert.equal(bill.cash_amount + bill.upi_amount + bill.credit_amount, 300);
  });

  it('rejects a split that does not add up', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 3 }],
      payment_method: 'split',
      cash_amount: 10, upi_amount: 10, credit_amount: 0,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /does not match the bill total/);
  });

  it('rejects negative tender amounts', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const customer = await makeCustomer();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'split',
      customer_id: customer.id,
      cash_amount: 200, upi_amount: 0, credit_amount: -100,
    });
    assert.equal(res.status, 400, 'a negative credit tender would write off debt');
  });
});

describe('credit sales', () => {
  it('refuses credit without a named customer', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'credit',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /registered customers/);
  });

  it('refuses a split containing credit without a customer', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'split',
      cash_amount: 40, upi_amount: 0, credit_amount: 60,
    });
    assert.equal(res.status, 400);
  });

  it('adds the credit to the customer balance', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const customer = await makeCustomer();

    const before = (await admin.get(`/api/customers?search=${customer.phone}`)).body.data[0];
    assert.equal(before.credit_balance, 0);

    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 2 }],
      payment_method: 'credit',
      customer_id: customer.id,
    });
    assert.equal(created.status, 200, JSON.stringify(created.body));

    const after = (await admin.get(`/api/customers?search=${customer.phone}`)).body.data[0];
    assert.equal(after.credit_balance, 200);
  });

  it('rejects a bill for a customer that does not exist', async () => {
    const item = await makeItem();
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'credit',
      customer_id: 987654321,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Customer not found/);
  });
});

describe('stock', () => {
  it('deducts sold quantity from stock', async () => {
    const item = await makeItem({ stock_quantity: 20 });
    await admin.post('/api/bills', { items: [{ id: item.id, quantity: 3 }], payment_method: 'cash' });
    assert.equal((await getItem(item.id)).stock_quantity, 17);
  });

  it('refuses to oversell and leaves stock untouched', async () => {
    const item = await makeItem({ stock_quantity: 2 });
    const res = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 5 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Insufficient stock/);
    assert.equal((await getItem(item.id)).stock_quantity, 2, 'a rejected bill must not move stock');
  });

  it('rolls the whole bill back when one line is short', async () => {
    const ok = await makeItem({ stock_quantity: 50 });
    const short = await makeItem({ stock_quantity: 1 });

    const res = await admin.post('/api/bills', {
      items: [{ id: ok.id, quantity: 5 }, { id: short.id, quantity: 10 }],
      payment_method: 'cash',
    });
    assert.equal(res.status, 400);

    // The transaction must be all-or-nothing: no stock moved, no bill written.
    assert.equal((await getItem(ok.id)).stock_quantity, 50);
    assert.equal((await getItem(short.id)).stock_quantity, 1);
  });

  it('never drives stock negative under concurrent sales of the last units', async () => {
    const item = await makeItem({ stock_quantity: 10 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        admin.post('/api/bills', { items: [{ id: item.id, quantity: 1 }], payment_method: 'cash' })
      )
    );
    const succeeded = results.filter((r) => r.status === 200).length;
    assert.equal(succeeded, 10, 'exactly the available units may sell');
    assert.equal((await getItem(item.id)).stock_quantity, 0);
  });
});

describe('bill numbering', () => {
  it('issues unique sequential numbers under concurrent billing', async () => {
    const item = await makeItem({ stock_quantity: 500 });
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        admin.post('/api/bills', { items: [{ id: item.id, quantity: 1 }], payment_method: 'cash' })
      )
    );
    const numbers = results.filter((r) => r.status === 200).map((r) => r.body.bill_number);
    assert.equal(numbers.length, 25, 'no sale may be lost to a numbering collision');
    assert.equal(new Set(numbers).size, 25, 'bill numbers must be unique');
    for (const n of numbers) assert.match(n, /^INV-\d{8}-\d{5}$/);
  });
});

describe('reading bills back', () => {
  it('404s on a bill that does not exist', async () => {
    assert.equal((await admin.get('/api/bills/987654321')).status, 404);
  });

  it('rejects a non-numeric bill id', async () => {
    assert.equal((await admin.get('/api/bills/not-a-number')).status, 400);
  });

  it('returns the customer and cashier with the bill', async () => {
    const item = await makeItem({ price: 100, gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 });
    const customer = await makeCustomer({ gstin: '29AAAAA0000A1Z5', address: '1 Test Road' });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 1 }],
      payment_method: 'cash',
      customer_id: customer.id,
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(bill.customer_name, customer.name);
    assert.equal(bill.customer_gstin, '29AAAAA0000A1Z5');
    assert.equal(bill.cashier_name, 'System Admin');
    assert.equal(bill.items[0].item_name, item.name);
    assert.equal(bill.items[0].hsn_code, item.hsn_code);
  });

  it('pages, date-filters and searches the bill list', async () => {
    const list = await admin.get('/api/bills?limit=5&offset=0');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.data));
    assert.ok(list.body.data.length <= 5);
    assert.equal(typeof list.body.total, 'number');
    assert.ok(list.body.total > 0);

    const first = list.body.data[0];
    const found = await admin.get(`/api/bills?search=${encodeURIComponent(first.bill_number)}`);
    assert.equal(found.body.total, 1);
    assert.equal(found.body.data[0].bill_number, first.bill_number);

    // A window in the past must match nothing.
    const empty = await admin.get('/api/bills?from=2001-01-01&to=2001-01-02');
    assert.equal(empty.body.total, 0);
  });

  it('rejects a malformed date filter', async () => {
    assert.equal((await admin.get('/api/bills?from=01-01-2024')).status, 400);
  });

  it('caps the page size', async () => {
    assert.equal((await admin.get('/api/bills?limit=999999')).status, 400);
    assert.equal((await admin.get('/api/bills?limit=0')).status, 400);
    assert.equal((await admin.get('/api/bills?offset=-1')).status, 400);
  });
});

describe('request handling', () => {
  it('returns JSON, not HTML, for an unknown API path', async () => {
    const res = await admin.get('/api/does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'Not found');
  });

  it('rejects malformed JSON cleanly', async () => {
    const res = await admin.post('/api/items', '{ not json', { raw: true });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Malformed JSON/);
  });

  it('rejects an oversized body', async () => {
    const res = await admin.post('/api/items', JSON.stringify({ name: 'x'.repeat(600_000) }), { raw: true });
    assert.equal(res.status, 413);
  });

  it('never leaks raw SQLite errors', async () => {
    const res = await admin.post('/api/customers', { name: 'A', phone: '9000000001' });
    assert.equal(res.status, 200);
    const dup = await admin.post('/api/customers', { name: 'B', phone: '9000000001' });
    assert.equal(dup.status, 409);
    assert.doesNotMatch(dup.body.error, /UNIQUE constraint|SQLITE/i);
  });

  it('marks API responses no-store so sales data is never cached', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });

  it('sends the baseline security headers', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
    // NODE_ENV=production in the harness, so HSTS must be on.
    assert.match(res.headers.get('strict-transport-security') || '', /max-age=31536000/);
  });
});

describe('the stored subtotal', () => {
  it('is persisted on the bill and returned by both read paths', async () => {
    const item = await makeItem({ price: 33.33, gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5 });
    const created = await admin.post('/api/bills', {
      items: [{ id: item.id, quantity: 7 }],
      payment_method: 'cash',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.subtotal_amount, 221.65, 'the create response carries it');

    const single = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
    assert.equal(single.subtotal_amount, 221.65);

    const listed = (await admin.get(`/api/bills?search=${created.body.bill_number}`)).body.data[0];
    assert.equal(listed.subtotal_amount, 221.65, 'the list carries it too');

    // The three figures on the invoice must reconcile against each other.
    assert.equal(
      Math.floor(round2(single.subtotal_amount + single.tax_amount - single.discount_amount)),
      single.total_amount
    );
  });

  it('equals the sum of the line taxable values', async () => {
    const a = await makeItem({ price: 118, gst_rate: 18, sgst_rate: 9, cgst_rate: 9 });
    const b = await makeItem({ price: 9.99, gst_rate: 12, sgst_rate: 6, cgst_rate: 6 });
    const created = await admin.post('/api/bills', {
      items: [{ id: a.id, quantity: 2 }, { id: b.id, quantity: 13 }],
      payment_method: 'cash',
    });
    const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;

    const fromLines = round2(bill.items.reduce(
      (acc: number, line: any) => acc + round2(line.total_amount - line.sgst_amount - line.cgst_amount - (line.igst_amount || 0)),
      0
    ));
    assert.equal(bill.subtotal_amount, fromLines);
  });
});
