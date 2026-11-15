/**
 * Editing a saved bill (History → Edit Bill): items, quantities, customer,
 * discount and payment change; the number and date stay; stock and the
 * customer's credit follow; and nothing changes if the edit cannot be saved.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
});

after(async () => { await server?.stop(); });

const stockOf = async (id: number) => (await admin.get(`/api/items/${id}/batches`)).body.item.stock_quantity as number;
const billOf = async (id: number) => (await admin.get(`/api/bills/${id}`)).body;
const balanceOf = async (id: number) =>
  (await admin.get(`/api/customers/${id}`)).body.credit_balance as number;
const newCustomer = async (shop: string) =>
  (await admin.post('/api/customers', { shop_name: shop, name: `${shop} Owner`, phone: `98${String(Date.now()).slice(-8)}` })).body;
const sell = async (body: Record<string, unknown>) => {
  const res = await admin.post('/api/bills', { payment_method: 'cash', ...body });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const edit = (id: number, body: Record<string, unknown>) => admin.put(`/api/bills/${id}`, { payment_method: 'cash', ...body });

describe('editing a bill', () => {
  it('changes items and quantities, keeping the number and the date', async () => {
    const sugar = await makeStockedItem(admin, { price: 118, stock_quantity: 50 });
    const biscuit = await makeStockedItem(admin, { price: 10, stock_quantity: 50 });
    const sale = await sell({ items: [{ id: sugar.id, quantity: 3 }] });
    const before = await billOf(sale.bill_id);

    const res = await edit(sale.bill_id, { items: [{ id: sugar.id, quantity: 5 }, { id: biscuit.id, quantity: 2 }], expected_total: 610 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bill_id, sale.bill_id);
    assert.equal(res.body.bill_number, sale.bill_number);

    const after = await billOf(sale.bill_id);
    assert.equal(after.bill_number, before.bill_number);
    assert.equal(after.created_at, before.created_at, 'the date stays');
    assert.equal(after.total_amount, 610);
    assert.deepEqual(after.items.map((l: any) => [l.item_id, l.quantity]), [[sugar.id, 5], [biscuit.id, 2]]);
    assert.ok(after.edited_at, 'when it was edited');
    assert.equal(after.edited_by, 'System Admin');
    assert.equal(await stockOf(sugar.id), 45, 'stock follows the new quantities');
    assert.equal(await stockOf(biscuit.id), 48);

    const logs = (await admin.get(`/api/audit-logs?search=${encodeURIComponent(`Edited bill ${sale.bill_number}:`)}`)).body.data;
    assert.ok(logs.some((log: any) => /₹354\.00 → ₹610\.00/.test(log.details) && /was .*× 3; now .*× 5, .*× 2/.test(log.details)), JSON.stringify(logs));
  });

  it('can keep the units it sold, even when they were the last ones', async () => {
    const item = await makeStockedItem(admin, { price: 50, stock_quantity: 3 });
    const sale = await sell({ items: [{ id: item.id, quantity: 3 }] });
    assert.equal(await stockOf(item.id), 0);

    // The till reads the batches as if the bill were undone.
    const batches = (await admin.get(`/api/items/${item.id}/batches?excluding_bill=${sale.bill_id}`)).body.data;
    assert.equal(batches.reduce((acc: number, b: any) => acc + b.quantity_remaining, 0), 3);
    assert.equal((await admin.get(`/api/items/${item.id}/batches`)).body.data.length, 0, 'not without it');

    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 2 }] })).status, 200);
    assert.equal(await stockOf(item.id), 1, 'one back on the shelf');
    const tooMany = await edit(sale.bill_id, { items: [{ id: item.id, quantity: 4 }] });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.body.error, /Insufficient stock/);
    assert.equal(await stockOf(item.id), 1, 'a failed edit changes nothing');
    assert.deepEqual((await billOf(sale.bill_id)).items.map((l: any) => l.quantity), [2]);
  });

  it('changes the discount and the payment', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 20 });
    const sale = await sell({ items: [{ id: item.id, quantity: 2 }] });
    const res = await edit(sale.bill_id, { items: [{ id: item.id, quantity: 2 }], discount_amount: 15, payment_method: 'upi' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const bill = await billOf(sale.bill_id);
    assert.deepEqual([bill.discount_amount, bill.total_amount, bill.payment_method, bill.upi_amount, bill.cash_amount], [15, 185, 'upi', 185, 0]);
  });

  it('refuses a stale total and leaves the bill as it was', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 20 });
    const sale = await sell({ items: [{ id: item.id, quantity: 1 }] });
    const res = await edit(sale.bill_id, { items: [{ id: item.id, quantity: 2 }], expected_total: 150 });
    assert.equal(res.status, 409);
    assert.equal((await billOf(sale.bill_id)).total_amount, 100);
    assert.equal(await stockOf(item.id), 19);
  });

  it('is for admins, and 404s on a bill that does not exist', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 20 });
    const sale = await sell({ items: [{ id: item.id, quantity: 1 }] });
    await admin.post('/api/users', { name: 'Edit Cashier', username: 'edit-cashier', password: 'edit-cashier-1', role: 'cashier' });
    const cashier = client(server.baseUrl);
    await cashier.login('edit-cashier', 'edit-cashier-1');
    assert.equal((await cashier.put(`/api/bills/${sale.bill_id}`, { items: [{ id: item.id, quantity: 2 }], payment_method: 'cash' })).status, 403);
    assert.equal((await edit(999999, { items: [{ id: item.id, quantity: 1 }] })).status, 404);
  });
});

describe('editing a credit bill', () => {
  it('moves the customer’s balance by the difference, keeping one sale entry', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 50 });
    const customer = await newCustomer('Edit Credit Bakery');
    const sale = await sell({ items: [{ id: item.id, quantity: 5 }], payment_method: 'credit', customer_id: customer.id });
    assert.equal(await balanceOf(customer.id), 500);

    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 3 }], payment_method: 'credit', customer_id: customer.id })).status, 200);
    assert.equal(await balanceOf(customer.id), 300);
    const entries = (await admin.get(`/api/customers/${customer.id}/credit-entries`)).body.data;
    assert.deepEqual(entries.map((e: any) => [e.entry_type, e.amount, e.balance_after]), [['sale', 300, 300]], 'the sale entry itself changes');

    // The passbook agrees.
    const passbook = (await admin.get(`/api/customers/${customer.id}/passbook`)).body;
    assert.equal(passbook.data[0].balance, 300);
  });

  it('works after a part payment, and refuses to take the balance below zero', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 50 });
    const customer = await newCustomer('Part Paid Bakery');
    const sale = await sell({ items: [{ id: item.id, quantity: 10 }], payment_method: 'credit', customer_id: customer.id });
    await admin.post(`/api/customers/${customer.id}/credit-payments`, { amount: 400 });
    assert.equal(await balanceOf(customer.id), 600);

    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 9 }], payment_method: 'credit', customer_id: customer.id })).status, 200);
    assert.equal(await balanceOf(customer.id), 500);

    const refused = await edit(sale.bill_id, { items: [{ id: item.id, quantity: 3 }], payment_method: 'credit', customer_id: customer.id });
    assert.equal(refused.status, 400);
    assert.match(refused.body.error, /already paid some of it.*then edit the bill/);
    assert.equal(await balanceOf(customer.id), 500, 'unchanged');
    assert.equal((await billOf(sale.bill_id)).total_amount, 900);
  });

  it('moves the credit to another customer, or off credit altogether', async () => {
    const item = await makeStockedItem(admin, { price: 100, stock_quantity: 50 });
    const first = await newCustomer('First Bakery');
    const second = await newCustomer('Second Bakery');
    const sale = await sell({ items: [{ id: item.id, quantity: 2 }], payment_method: 'credit', customer_id: first.id });

    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 2 }], payment_method: 'credit', customer_id: second.id })).status, 200);
    assert.equal(await balanceOf(first.id), 0);
    assert.equal(await balanceOf(second.id), 200);
    assert.equal((await admin.get(`/api/customers/${first.id}/credit-entries`)).body.data.length, 0, 'no line left on the first statement');

    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 2 }], payment_method: 'cash', customer_id: second.id })).status, 200);
    assert.equal(await balanceOf(second.id), 0);

    // And back onto credit.
    assert.equal((await edit(sale.bill_id, { items: [{ id: item.id, quantity: 1 }], payment_method: 'credit', customer_id: second.id })).status, 200);
    assert.equal(await balanceOf(second.id), 100);
  });
});
