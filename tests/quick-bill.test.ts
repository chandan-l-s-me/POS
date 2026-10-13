/**
 * Quick Bill, the phone app: suggestions so a bill rarely needs typing, and
 * the counter print queue that lets a bill saved on a phone print on the
 * counter's receipt printer.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;
let flour: number;
let yeast: number;
let sugar: number;
let customerId: number;

const NO_GST = { gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0 };

const sell = async (items: Array<{ id: number; quantity: number }>, extra: Record<string, unknown> = {}, as: Client = cashier) => {
  const res = await as.post('/api/bills', { items, payment_method: 'cash', ...extra });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { bill_id: number; bill_number: string; print_job_id: number | null };
};

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', { name: 'Phone Cashier', username: 'phone', password: 'phone-pass-123' })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('phone', 'phone-pass-123')).status, 200);

  flour = (await makeStockedItem(admin, { ...NO_GST, name: 'QB Flour', price: 900, stock_quantity: 500 })).id;
  yeast = (await makeStockedItem(admin, { ...NO_GST, name: 'QB Yeast', price: 200, stock_quantity: 500 })).id;
  sugar = (await makeStockedItem(admin, { ...NO_GST, name: 'QB Sugar', price: 50, stock_quantity: 500 })).id;
  const customer = await admin.post('/api/customers', { shop_name: 'Quick Bakery', phone: '6300000001' });
  customerId = customer.body.id;
});

after(async () => { await server?.stop(); });

describe('suggestions', () => {
  it('lists what the customer usually buys, most often first, and the shop’s best sellers', async () => {
    await sell([{ id: flour, quantity: 2 }, { id: yeast, quantity: 1 }], { customer_id: customerId });
    await sell([{ id: flour, quantity: 3 }], { customer_id: customerId });
    await sell([{ id: sugar, quantity: 10 }]);
    await sell([{ id: sugar, quantity: 5 }]);
    await sell([{ id: sugar, quantity: 5 }]);

    const res = await cashier.get(`/api/quick-items?customer_id=${customerId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.usual.map((i: any) => [i.name, i.times_bought]), [['QB Flour', 2], ['QB Yeast', 1]]);
    assert.equal(res.body.usual[0].total_quantity, 5);
    assert.equal(res.body.popular[0].name, 'QB Sugar', 'sold on the most bills');
    assert.ok('stock_quantity' in res.body.usual[0] && 'price' in res.body.usual[0], 'enough to add to the cart');

    const walkIn = await cashier.get('/api/quick-items');
    assert.deepEqual(walkIn.body.usual, [], 'no customer, no usual items');
  });

  it('repeats the last order item by item, joining lines split across batches', async () => {
    const last = await sell([{ id: yeast, quantity: 4 }, { id: flour, quantity: 1 }, { id: yeast, quantity: 2 }], { customer_id: customerId });
    const res = await cashier.get(`/api/customers/${customerId}/last-order`);
    assert.equal(res.status, 200);
    assert.equal(res.body.bill.bill_number, last.bill_number);
    assert.deepEqual(res.body.items.map((i: any) => [i.name, i.ordered_quantity]), [['QB Yeast', 6], ['QB Flour', 1]]);

    const none = await admin.post('/api/customers', { shop_name: 'New Bakery', phone: '6300000002' });
    const empty = await cashier.get(`/api/customers/${none.body.id}/last-order`);
    assert.deepEqual(empty.body, { bill: null, items: [] });
  });
});

describe('counter print queue', () => {
  it('queues a phone bill, and the print station prints it exactly once', async () => {
    const bill = await sell([{ id: sugar, quantity: 1 }], { print_at_counter: true });
    assert.ok(bill.print_job_id, 'the bill came back with its print job');

    const queue = await admin.get('/api/print-jobs');
    const job = queue.body.data.find((j: any) => j.id === bill.print_job_id);
    assert.ok(job, 'the counter sees it');
    assert.equal(job.bill_number, bill.bill_number);
    assert.equal(job.requested_by_name, 'Phone Cashier');

    assert.equal((await cashier.get(`/api/print-jobs/${bill.print_job_id}`)).body.status, 'pending');
    assert.equal((await admin.post(`/api/print-jobs/${bill.print_job_id}/claim`)).status, 200);
    const second = await admin.post(`/api/print-jobs/${bill.print_job_id}/claim`);
    assert.equal(second.status, 409, 'a second print station does not print it again');

    const status = (await cashier.get(`/api/print-jobs/${bill.print_job_id}`)).body;
    assert.equal(status.status, 'printed', 'the phone can show it printed');
    assert.ok(!(await admin.get('/api/print-jobs')).body.data.some((j: any) => j.id === bill.print_job_id));
  });

  it('does not queue a bill unless asked', async () => {
    const bill = await sell([{ id: sugar, quantity: 1 }]);
    assert.equal(bill.print_job_id, null);
  });

  it('reprints on request, without queuing the same bill twice', async () => {
    const bill = await sell([{ id: sugar, quantity: 1 }]);
    const first = await cashier.post(`/api/bills/${bill.bill_id}/print-requests`);
    const again = await cashier.post(`/api/bills/${bill.bill_id}/print-requests`);
    assert.equal(first.status, 201);
    assert.equal(again.body.id, first.body.id, 'still pending: one job');
  });

  it('drops queued prints when the bill is deleted', async () => {
    const bill = await sell([{ id: sugar, quantity: 1 }], { print_at_counter: true });
    assert.equal((await admin.del(`/api/bills/${bill.bill_id}`)).status, 200);
    assert.ok(!(await admin.get('/api/print-jobs')).body.data.some((j: any) => j.bill_id === bill.bill_id));
  });
});
