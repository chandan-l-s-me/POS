/**
 * How customers are named.
 *
 * This shop knows its customers by bakery or shop, not by the name of whoever
 * comes to the counter. So the shop name is the customer's identity, the
 * person's name is secondary, and a customer with no shop is known by their
 * own name. These tests pin that rule on both sides: the shared client helper
 * every screen uses, and the server's validation, sorting and search.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';
import {
  billCustomerContactName,
  billCustomerDisplayName,
  customerContactName,
  customerDisplayName,
  customerInitial,
} from '../src/lib/customer.ts';

describe('the naming rule (src/lib/customer.ts)', () => {
  it('shows the bakery, with the person as the contact', () => {
    const c = { name: 'Ramesh', shop_name: 'Sri Ganesh Bakery' };
    assert.equal(customerDisplayName(c), 'Sri Ganesh Bakery');
    assert.equal(customerContactName(c), 'Ramesh');
  });

  it('shows the person when there is no shop, with no separate contact', () => {
    for (const shop_name of [null, undefined, '', '   ']) {
      const c = { name: 'Ramesh', shop_name };
      assert.equal(customerDisplayName(c), 'Ramesh', `shop_name ${JSON.stringify(shop_name)}`);
      assert.equal(customerContactName(c), null, 'the name is already the heading; do not repeat it');
    }
  });

  it('shows the bakery alone when no person is recorded', () => {
    const c = { name: '', shop_name: 'Sri Ganesh Bakery' };
    assert.equal(customerDisplayName(c), 'Sri Ganesh Bakery');
    assert.equal(customerContactName(c), null);
  });

  it('does not repeat a person whose name is the shop name', () => {
    assert.equal(customerContactName({ name: 'sri ganesh bakery', shop_name: 'Sri Ganesh Bakery' }), null);
  });

  it('trims whitespace on both', () => {
    const c = { name: '  Ramesh  ', shop_name: '  Sri Ganesh Bakery ' };
    assert.equal(customerDisplayName(c), 'Sri Ganesh Bakery');
    assert.equal(customerContactName(c), 'Ramesh');
  });

  it('handles a missing customer', () => {
    assert.equal(customerDisplayName(null), '');
    assert.equal(customerContactName(undefined), null);
  });

  it('applies the same rule to bill rows, with a walk-in fallback', () => {
    const bill = { customer_name: 'Ramesh', customer_shop_name: 'Sri Ganesh Bakery' };
    assert.equal(billCustomerDisplayName(bill), 'Sri Ganesh Bakery');
    assert.equal(billCustomerContactName(bill), 'Ramesh');

    assert.equal(billCustomerDisplayName({ customer_name: 'Ramesh', customer_shop_name: null }), 'Ramesh');

    assert.equal(billCustomerDisplayName({}), 'Walk-in');
    assert.equal(billCustomerDisplayName({ customer_name: null }, 'Walk-in Customer'), 'Walk-in Customer');
    assert.equal(billCustomerContactName({}), null);
  });

  it('gives an avatar initial even for a shop-only customer', () => {
    // The Customers page used `customer.name[0].toUpperCase()`, which throws
    // on an empty name — the case a shop-only customer now is.
    assert.equal(customerInitial({ name: '', shop_name: 'sri ganesh bakery' }), 'S');
    assert.equal(customerInitial({ name: 'ramesh', shop_name: null }), 'R');
    assert.equal(customerInitial({ name: '', shop_name: '' }), '?');
    assert.equal(customerInitial(null), '?');
  });
});

let server: TestServer;
let admin: Client;
let phoneSeed = 6000000000;
const nextPhone = () => String(phoneSeed++);

const makeItem = async () => {
  const res = await admin.post('/api/items', {
    name: `Item ${Math.random().toString(36).slice(2, 10)}`,
    hsn_code: String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
    price: 100, metric: 'piece', is_loose: false,
    gst_applicable: false, gst_mode: 'split', gst_rate: 0,
    sgst_rate: 0, cgst_rate: 0, igst_rate: 0, stock_quantity: 1000,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
};

describe('the server', () => {
  before(async () => {
    server = await startServer();
    admin = client(server.baseUrl);
    assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  });

  after(async () => { await server?.stop(); });

  describe('creating a customer', () => {
    it('accepts a bakery with no person named', async () => {
      // A cashier who only knows "Sri Ganesh Bakery" must be able to add it.
      const res = await admin.post('/api/customers', { shop_name: 'Only Shop Bakery', phone: nextPhone() });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const row = (await admin.get('/api/customers?search=Only%20Shop')).body.data[0];
      assert.equal(row.shop_name, 'Only Shop Bakery');
      assert.equal(row.name, '');
    });

    it('accepts a person with no shop', async () => {
      const res = await admin.post('/api/customers', { name: 'Walkin Individual', phone: nextPhone() });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const row = (await admin.get('/api/customers?search=Walkin%20Individual')).body.data[0];
      assert.equal(row.name, 'Walkin Individual');
      assert.equal(row.shop_name, null);
    });

    it('accepts both', async () => {
      const res = await admin.post('/api/customers', {
        name: 'Both Person', shop_name: 'Both Bakery', phone: nextPhone(),
      });
      assert.equal(res.status, 200);
    });

    it('refuses neither', async () => {
      for (const body of [
        { phone: nextPhone() },
        { name: '', shop_name: '', phone: nextPhone() },
        { name: '   ', shop_name: '  ', phone: nextPhone() },
      ]) {
        const res = await admin.post('/api/customers', body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.match(res.body.error, /bakery \/ shop name, or the customer.s name/);
      }
    });

    it('still requires a phone number', async () => {
      assert.equal((await admin.post('/api/customers', { shop_name: 'No Phone Bakery' })).status, 400);
    });

    it('records the bakery in the audit log', async () => {
      const res = await admin.post('/api/customers', {
        name: 'Audit Person', shop_name: 'Audit Trail Bakery', phone: nextPhone(),
      });
      assert.equal(res.status, 200);
      const logs = await admin.get('/api/audit-logs?search=Audit%20Trail%20Bakery');
      assert.ok(logs.body.data.some((row: any) => row.details === 'Created customer Audit Trail Bakery'));
    });
  });

  describe('updating a customer', () => {
    it('can drop the person and keep the shop', async () => {
      const phone = nextPhone();
      const created = await admin.post('/api/customers', { name: 'Leaving Person', shop_name: 'Staying Bakery', phone });
      const res = await admin.put(`/api/customers/${created.body.id}`, { name: '', shop_name: 'Staying Bakery', phone });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    it('refuses to clear both names', async () => {
      const phone = nextPhone();
      const created = await admin.post('/api/customers', { name: 'Someone', shop_name: 'Some Bakery', phone });
      const res = await admin.put(`/api/customers/${created.body.id}`, { name: '', shop_name: '', phone });
      assert.equal(res.status, 400);
    });
  });

  describe('listing and searching', () => {
    it('sorts by bakery, falling back to the person for a shopless customer', async () => {
      // Chosen so the two orderings disagree. By the person's name this reads
      // Beta, Mid, Zeta — Beta Individual, Cobalt Stores, Aardvark Bakes. By
      // what the shop calls them it reads Aardvark, Beta, Cobalt.
      const ids = [
        (await admin.post('/api/customers', { name: 'Zeta Owner', shop_name: 'Aardvark Bakes', phone: nextPhone() })).body.id,
        (await admin.post('/api/customers', { name: 'Beta Individual', phone: nextPhone() })).body.id,
        (await admin.post('/api/customers', { name: 'Mid Owner', shop_name: 'Cobalt Stores', phone: nextPhone() })).body.id,
      ];

      const all = (await admin.get('/api/customers?limit=1000')).body.data;
      const ours = all.filter((row: any) => ids.includes(row.id)).map(customerDisplayName);
      assert.deepEqual(ours, ['Aardvark Bakes', 'Beta Individual', 'Cobalt Stores']);
    });

    it('sorts case-insensitively', async () => {
      const ids = [
        (await admin.post('/api/customers', { shop_name: 'bakery lowercase-sort', phone: nextPhone() })).body.id,
        (await admin.post('/api/customers', { shop_name: 'Bakery Uppercase-sort', phone: nextPhone() })).body.id,
      ];
      const all = (await admin.get('/api/customers?limit=1000')).body.data;
      const ours = all.filter((row: any) => ids.includes(row.id)).map(customerDisplayName);
      assert.deepEqual(ours, ['bakery lowercase-sort', 'Bakery Uppercase-sort']);
    });

    it('finds a customer by bakery name', async () => {
      await admin.post('/api/customers', { name: 'Hidden Owner', shop_name: 'Findable Cakes', phone: nextPhone() });
      const res = await admin.get('/api/customers?search=Findable');
      assert.equal(res.body.total, 1);
      assert.equal(res.body.data[0].shop_name, 'Findable Cakes');
    });
  });

  describe('bills', () => {
    let billId: number;
    let billNumber: string;

    before(async () => {
      const itemId = await makeItem();
      const customer = await admin.post('/api/customers', {
        name: 'Counter Person', shop_name: 'Billable Bakery', phone: nextPhone(),
      });
      const bill = await admin.post('/api/bills', {
        items: [{ id: itemId, quantity: 1 }],
        payment_method: 'credit',
        customer_id: customer.body.id,
      });
      assert.equal(bill.status, 200, JSON.stringify(bill.body));
      billId = bill.body.bill_id;
      billNumber = bill.body.bill_number;
    });

    it('carry the bakery name on the invoice read', async () => {
      const bill = (await admin.get(`/api/bills/${billId}`)).body;
      assert.equal(bill.customer_shop_name, 'Billable Bakery');
      assert.equal(bill.customer_name, 'Counter Person');
      assert.equal(billCustomerDisplayName(bill), 'Billable Bakery');
    });

    it('carry it in the history list', async () => {
      const row = (await admin.get(`/api/bills?search=${billNumber}`)).body.data[0];
      assert.equal(row.customer_shop_name, 'Billable Bakery');
    });

    it('can be found by bakery name', async () => {
      const res = await admin.get('/api/bills?search=Billable%20Bakery');
      assert.equal(res.status, 200);
      assert.equal(res.body.total, 1, 'the count must use the same filter as the rows');
      assert.equal(res.body.data[0].bill_number, billNumber);
    });

    it('carry it in the sales report', async () => {
      const rows = (await admin.get('/api/reports/sales-items')).body.data;
      const row = rows.find((r: any) => r.bill_number === billNumber);
      assert.ok(row, 'the bill should appear in this month’s sales report');
      assert.equal(row.customer_shop_name, 'Billable Bakery');
    });

    it('work for a shop-only customer', async () => {
      const itemId = await makeItem();
      const customer = await admin.post('/api/customers', { shop_name: 'Nameless Bakery', phone: nextPhone() });
      const created = await admin.post('/api/bills', {
        items: [{ id: itemId, quantity: 2 }],
        payment_method: 'credit',
        customer_id: customer.body.id,
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));

      const bill = (await admin.get(`/api/bills/${created.body.bill_id}`)).body;
      assert.equal(billCustomerDisplayName(bill), 'Nameless Bakery');
      assert.equal(billCustomerContactName(bill), null);
    });
  });

  describe('the credit statement', () => {
    it('names the bakery in its header data', async () => {
      const customer = await admin.post('/api/customers', {
        name: 'Statement Person', shop_name: 'Statement Bakery', phone: nextPhone(), credit_balance: 100,
      });
      const res = await admin.get(`/api/customers/${customer.body.id}/credit-entries`);
      assert.equal(res.body.customer.shop_name, 'Statement Bakery');
      assert.equal(customerDisplayName(res.body.customer), 'Statement Bakery');
    });

    it('records a payment against the bakery in the audit log', async () => {
      const customer = await admin.post('/api/customers', {
        name: 'Payer', shop_name: 'Paying Bakery', phone: nextPhone(), credit_balance: 500,
      });
      assert.equal((await admin.post(`/api/customers/${customer.body.id}/credit-payments`, { amount: 200 })).status, 201);
      const logs = await admin.get('/api/audit-logs?search=Paying%20Bakery');
      assert.ok(logs.body.data.some((row: any) => /^Received ₹200\.00 from Paying Bakery;/.test(row.details)));
    });
  });
});
