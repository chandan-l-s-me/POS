/**
 * Deleting a bill undoes it everywhere.
 *
 * Its stock goes back to the batches it was sold from (so it sells again at
 * its old price, in its old place in the queue), its credit comes off the
 * customer, its sale entry leaves their ledger, and the bill drops out of
 * history and the passbook. Only an admin can do it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import {
  ADMIN_PASSWORD, client, itemFields, purchaseNewItem, startServer, type Client, type TestServer,
} from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server: TestServer;
let admin: Client;
let cashier: Client;

const NO_GST = { gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 };

/** An item with two batches: 10 @ ₹100, then 10 @ ₹120. */
const twoBatchItem = async () => {
  const fields = itemFields(NO_GST);
  const id = await purchaseNewItem(admin, fields, { quantity: 10, unit_cost: 80, selling_price: 100 });
  const res = await admin.post('/api/purchases', {
    supplier_name: 'Test Supplier',
    items: [{ item_id: id, quantity: 10, unit_cost: 90, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, selling_price: 120 }],
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return id;
};

const batchesOf = async (itemId: number) => {
  const res = await admin.get(`/api/items/${itemId}/batches?all=1`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { item: any; data: any[] };
};

let phoneSeed = 6100000000;
const makeCustomer = async () => {
  const res = await admin.post('/api/customers', { shop_name: `Bakery ${phoneSeed}`, phone: String(phoneSeed++) });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id as number;
};

const sell = async (body: Record<string, unknown>) => {
  const res = await admin.post('/api/bills', body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { bill_id: number; bill_number: string; total_amount: number };
};

const ledgerOf = async (customerId: number) => {
  const res = await admin.get(`/api/customers/${customerId}/credit-entries?limit=1000`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { data: any[]; customer: { credit_balance: number } };
};

/** The ledger chains (each entry starts where the last ended) and ends on the stored balance. */
const assertLedgerConsistent = async (customerId: number) => {
  const { data, customer } = await ledgerOf(customerId);
  const oldestFirst = [...data].reverse();
  for (let i = 1; i < oldestFirst.length; i++) {
    assert.equal(oldestFirst[i].balance_before, oldestFirst[i - 1].balance_after, 'each entry starts where the last ended');
  }
  assert.equal(oldestFirst.at(-1)?.balance_after ?? 0, customer.credit_balance, 'the ledger ends on the stored balance');

  const passbook = await admin.get(`/api/customers/${customerId}/passbook?order=desc&limit=1`);
  assert.equal(passbook.status, 200);
  assert.equal(passbook.body.data[0]?.balance ?? 0, customer.credit_balance, 'the passbook ends on the stored balance');
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', {
    name: 'Delete Cashier', username: 'delete-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('delete-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => { await server?.stop(); });

describe('deleting a bill', () => {
  it('puts the stock back into the batches it came from and removes the bill', async () => {
    const itemId = await twoBatchItem();
    const sold = await sell({ items: [{ id: itemId, quantity: 12 }], payment_method: 'cash' });
    assert.equal(sold.total_amount, 10 * 100 + 2 * 120);
    assert.deepEqual((await batchesOf(itemId)).data.map((b) => b.quantity_remaining), [0, 8]);

    const res = await admin.del(`/api/bills/${sold.bill_id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { item, data } = await batchesOf(itemId);
    assert.deepEqual(data.map((b) => b.quantity_remaining), [10, 10], 'each batch gets back exactly what was taken');
    assert.equal(item.stock_quantity, 20);
    assert.equal(item.price, 100, 'the older batch sells next again, at its own price');

    assert.equal((await admin.get(`/api/bills/${sold.bill_id}`)).status, 404);
    const list = await admin.get(`/api/bills?search=${sold.bill_number}`);
    assert.equal(list.body.total, 0, 'gone from history');

    const db = new Database(server.dbPath, { readonly: true });
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS c FROM bill_items WHERE bill_id = ?').get(sold.bill_id).c, 0);
      const adjustments = db.prepare('SELECT quantity, reason FROM stock_adjustments WHERE item_id = ? ORDER BY id').all(itemId);
      assert.deepEqual(adjustments, [
        { quantity: 10, reason: `Bill ${sold.bill_number} deleted` },
        { quantity: 2, reason: `Bill ${sold.bill_number} deleted` },
      ], 'every unit returned is traceable to the bill');
    } finally {
      db.close();
    }

    const logs = await admin.get('/api/audit-logs?limit=5');
    assert.ok(
      logs.body.data.some((log: any) => log.entity_type === 'bill' && log.action === 'delete' && log.details.includes(sold.bill_number)),
      'the deletion is audit-logged'
    );
  });

  it('takes the credit off the customer and the sale out of their ledger', async () => {
    const itemId = await twoBatchItem();
    const customerId = await makeCustomer();

    const first = await sell({ items: [{ id: itemId, quantity: 2 }], payment_method: 'credit', customer_id: customerId });
    const second = await sell({ items: [{ id: itemId, quantity: 3 }], payment_method: 'credit', customer_id: customerId });
    assert.equal((await admin.post(`/api/customers/${customerId}/credit-payments`, { amount: 50 })).status, 201);
    assert.equal((await ledgerOf(customerId)).customer.credit_balance, 200 + 300 - 50);

    const res = await admin.del(`/api/bills/${first.bill_id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { data, customer } = await ledgerOf(customerId);
    assert.equal(customer.credit_balance, 300 - 50);
    assert.ok(!data.some((entry) => entry.bill_id === first.bill_id), 'its sale entry is gone');
    assert.ok(data.some((entry) => entry.bill_id === second.bill_id), 'other bills are untouched');
    await assertLedgerConsistent(customerId);

    const passbook = await admin.get(`/api/customers/${customerId}/passbook?limit=100`);
    assert.ok(!passbook.body.data.some((row: any) => row.bill_number === first.bill_number), 'gone from the passbook');
  });

  it('refuses when the customer has already paid more than their balance now holds', async () => {
    const itemId = await twoBatchItem();
    const customerId = await makeCustomer();
    const sold = await sell({ items: [{ id: itemId, quantity: 2 }], payment_method: 'credit', customer_id: customerId });
    assert.equal((await admin.post(`/api/customers/${customerId}/credit-payments`, { amount: 150 })).status, 201);

    const res = await admin.del(`/api/bills/${sold.bill_id}`);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /already paid/);

    assert.equal((await admin.get(`/api/bills/${sold.bill_id}`)).status, 200, 'nothing was deleted');
    assert.equal((await batchesOf(itemId)).item.stock_quantity, 18, 'no stock moved');
    assert.equal((await ledgerOf(customerId)).customer.credit_balance, 50);
    await assertLedgerConsistent(customerId);
  });

  it('restocks a bill from before batch tracking as a new batch', async () => {
    const itemId = await twoBatchItem();
    const sold = await sell({ items: [{ id: itemId, quantity: 4 }], payment_method: 'upi' });

    // Old bills carry no record of which batches they came from.
    const db = new Database(server.dbPath);
    try {
      db.prepare(`
        DELETE FROM bill_item_batches WHERE bill_item_id IN (SELECT id FROM bill_items WHERE bill_id = ?)
      `).run(sold.bill_id);
    } finally {
      db.close();
    }

    const res = await admin.del(`/api/bills/${sold.bill_id}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const { item, data } = await batchesOf(itemId);
    assert.equal(item.stock_quantity, 20, 'all 4 units are back');
    const restocked = data.at(-1);
    assert.equal(restocked.source, 'adjustment');
    assert.equal(restocked.quantity_remaining, 4);
    assert.equal(restocked.selling_price, 120, 'at the latest batch’s price');
  });

  it('is for admins only', async () => {
    const itemId = await twoBatchItem();
    const sold = await sell({ items: [{ id: itemId, quantity: 1 }], payment_method: 'cash' });
    assert.equal((await cashier.del(`/api/bills/${sold.bill_id}`)).status, 403);
    assert.equal((await admin.get(`/api/bills/${sold.bill_id}`)).status, 200);
  });

  it('says so for a bill that does not exist', async () => {
    assert.equal((await admin.del('/api/bills/999999')).status, 404);
  });
});
