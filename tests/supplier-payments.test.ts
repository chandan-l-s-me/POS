/**
 * Purchase credit: what the shop owes its suppliers, and the payments that
 * settle it.
 *
 * A purchase is paid at the time (in part or in full) or bought on credit.
 * The owner pays a supplier later, often one sum covering several invoices,
 * which clears that supplier's oldest invoices first. Once nothing is left to
 * pay, a purchase moves from Purchase Credit to Payments Done.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, itemFields, purchaseNewItem, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;
let itemId: number;

let supplierSeq = 0;
const newSupplierName = () => `Supplier ${Date.now().toString(36)}-${++supplierSeq}`;

/** A purchase of `amount` (no GST: 1 unit at `amount`) from `supplier`, paying `paid` now. */
const buy = async (supplier: string, amount: number, extra: Record<string, unknown> = {}) => {
  const res = await admin.post('/api/purchases', {
    supplier_name: supplier,
    items: [{ item_id: itemId, quantity: 1, unit_cost: amount, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, selling_price: amount * 2 }],
    ...extra,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body as { purchase_id: number; purchase_number: string; total_amount: number; amount_paid: number; balance_due: number };
};

const credit = async () => {
  const res = await admin.get('/api/purchase-credit');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { total_due: number; purchase_count: number; suppliers: any[] };
};
const creditFor = async (supplier: string) => (await credit()).suppliers.find((s) => s.name === supplier);

const paid = async (search: string) => {
  const res = await admin.get(`/api/paid-purchases?search=${encodeURIComponent(search)}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { data: any[]; total: number };
};

const supplierIdOf = async (name: string) => {
  const res = await admin.get('/api/suppliers');
  return (res.body as any[]).find((s) => s.name === name).id as number;
};

const pay = (body: Record<string, unknown>) => admin.post('/api/supplier-payments', body);

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', {
    name: 'Pay Cashier', username: 'pay-cashier', password: 'cashier-pass-1',
  })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('pay-cashier', 'cashier-pass-1')).status, 200);

  itemId = await purchaseNewItem(admin, itemFields({ gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0 }), {
    quantity: 1, unit_cost: 10, selling_price: 20, supplier_name: 'Setup Supplier',
  });
});

after(async () => { await server?.stop(); });

describe('buying on credit', () => {
  it('puts an unpaid purchase under Purchase Credit', async () => {
    const supplier = newSupplierName();
    const purchase = await buy(supplier, 1000);
    assert.equal(purchase.amount_paid, 0);
    assert.equal(purchase.balance_due, 1000);

    const entry = await creditFor(supplier);
    assert.equal(entry.total_due, 1000);
    assert.equal(entry.purchases.length, 1);
    assert.equal(entry.purchases[0].purchase_number, purchase.purchase_number);
    assert.equal(entry.purchases[0].age_days, 0);
    assert.equal((await paid(purchase.purchase_number)).total, 0);
  });

  it('records a payment made at purchase time, part or full', async () => {
    const supplier = newSupplierName();
    const part = await buy(supplier, 1000, { amount_paid: 400, payment_method: 'upi', payment_reference: 'UTR123' });
    assert.equal(part.balance_due, 600);
    assert.equal((await creditFor(supplier)).total_due, 600);

    const full = await buy(supplier, 500, { amount_paid: 500 });
    assert.equal(full.balance_due, 0);
    assert.equal((await creditFor(supplier)).purchases.length, 1, 'the fully paid one is not on credit');
    assert.equal((await paid(full.purchase_number)).total, 1, 'it is under Payments Done straight away');

    const detail = await admin.get(`/api/purchases/${part.purchase_id}`);
    assert.equal(detail.body.amount_paid, 400);
    assert.equal(detail.body.payments.length, 1);
    assert.equal(detail.body.payments[0].method, 'upi');
    assert.equal(detail.body.payments[0].reference, 'UTR123');
  });

  it('refuses paying more than the purchase total at entry', async () => {
    const res = await admin.post('/api/purchases', {
      supplier_name: newSupplierName(),
      items: [{ item_id: itemId, quantity: 1, unit_cost: 100, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, selling_price: 200 }],
      amount_paid: 150,
    });
    assert.equal(res.status, 400);
  });

  it('leaves the payment method optional but checks it when given', async () => {
    const supplier = newSupplierName();
    await buy(supplier, 100);
    const supplierId = await supplierIdOf(supplier);
    assert.equal((await pay({ supplier_id: supplierId, amount: 10, method: 'barter' })).status, 400);
    assert.equal((await pay({ supplier_id: supplierId, amount: 10 })).status, 201, 'no method is fine');
  });
});

describe('paying a supplier', () => {
  it('clears the oldest invoices first and splits across them', async () => {
    const supplier = newSupplierName();
    const oldest = await buy(supplier, 300, { invoice_date: '2026-01-05' });
    const middle = await buy(supplier, 500, { invoice_date: '2026-02-10' });
    const newest = await buy(supplier, 700, { invoice_date: '2026-03-15' });
    const supplierId = await supplierIdOf(supplier);

    const res = await pay({ supplier_id: supplierId, amount: 600, method: 'cash', paid_on: '2026-03-20' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(
      res.body.allocations.map((a: any) => [a.purchase_number, a.amount, a.cleared]),
      [[oldest.purchase_number, 300, true], [middle.purchase_number, 300, false]]
    );
    assert.equal(res.body.owed_before, 1500);
    assert.equal(res.body.owed_after, 900);

    const entry = await creditFor(supplier);
    assert.equal(entry.total_due, 900);
    assert.deepEqual(entry.purchases.map((p: any) => [p.purchase_number, p.balance_due]), [
      [middle.purchase_number, 200],
      [newest.purchase_number, 700],
    ]);

    const done = await paid(oldest.purchase_number);
    assert.equal(done.total, 1, 'the cleared invoice moved to Payments Done');
    assert.equal(done.data[0].paid_off_on, '2026-03-20');
    assert.equal(done.data[0].methods, 'cash');
  });

  it('can pay one chosen invoice instead', async () => {
    const supplier = newSupplierName();
    const oldest = await buy(supplier, 300, { invoice_date: '2026-01-05' });
    const newest = await buy(supplier, 700, { invoice_date: '2026-03-15' });

    const res = await pay({ purchase_id: newest.purchase_id, amount: 700, method: 'cheque', reference: 'CHQ 000981' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.allocations.map((a: any) => a.purchase_number), [newest.purchase_number]);

    const entry = await creditFor(supplier);
    assert.deepEqual(entry.purchases.map((p: any) => p.purchase_number), [oldest.purchase_number]);

    const over = await pay({ purchase_id: oldest.purchase_id, amount: 301 });
    assert.equal(over.status, 400);
    assert.match(over.body.error, /more than the ₹300.00 owed on this purchase/);
  });

  it('refuses paying more than is owed, a future date, and a paid-up supplier', async () => {
    const supplier = newSupplierName();
    await buy(supplier, 100);
    const supplierId = await supplierIdOf(supplier);

    assert.equal((await pay({ supplier_id: supplierId, amount: 100.01 })).status, 400);
    assert.equal((await pay({ supplier_id: supplierId, amount: 10, paid_on: '2999-01-01' })).status, 400);
    assert.equal((await pay({ supplier_id: supplierId, amount: 100 })).status, 201);
    const again = await pay({ supplier_id: supplierId, amount: 1 });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /Nothing is owed/);
    assert.equal(await creditFor(supplier), undefined, 'a paid-up supplier is not on the credit page');
  });

  it('lists every payment with the invoices it settled', async () => {
    const supplier = newSupplierName();
    await buy(supplier, 200);
    await buy(supplier, 200);
    const supplierId = await supplierIdOf(supplier);
    assert.equal((await pay({ supplier_id: supplierId, amount: 300, method: 'bank', reference: 'NEFT9', note: 'Feb dues' })).status, 201);

    const res = await admin.get(`/api/supplier-payments?supplier_id=${supplierId}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 1);
    const [payment] = res.body.data;
    assert.equal(payment.supplier_name, supplier);
    assert.equal(payment.amount, 300);
    assert.equal(payment.method, 'bank');
    assert.equal(payment.reference, 'NEFT9');
    assert.equal(payment.user_name, 'System Admin', 'who entered it');
    assert.deepEqual(payment.allocations.map((a: any) => a.amount), [200, 100]);
  });

  it('undoes a payment entered by mistake', async () => {
    const supplier = newSupplierName();
    const purchase = await buy(supplier, 250);
    const made = await pay({ purchase_id: purchase.purchase_id, amount: 250 });
    assert.equal((await paid(purchase.purchase_number)).total, 1);

    assert.equal((await admin.del(`/api/supplier-payments/${made.body.payment_id}`)).status, 200);
    assert.equal((await paid(purchase.purchase_number)).total, 0);
    assert.equal((await creditFor(supplier)).total_due, 250, 'back on credit');
  });

  it('shows what is owed on the Suppliers list and the dashboard', async () => {
    const supplier = newSupplierName();
    await buy(supplier, 450, { amount_paid: 50 });

    const suppliers = await admin.get('/api/suppliers');
    assert.equal((suppliers.body as any[]).find((s) => s.name === supplier).amount_due, 400);

    const analytics = await admin.get('/api/analytics');
    assert.equal(analytics.body.supplierDue, (await credit()).total_due);
  });

  it('follows a supplier who is renamed', async () => {
    const supplier = newSupplierName();
    await buy(supplier, 120);
    const supplierId = await supplierIdOf(supplier);
    assert.equal((await admin.put(`/api/suppliers/${supplierId}`, { name: `${supplier} Renamed` })).status, 200);
    assert.equal((await creditFor(`${supplier} Renamed`)).total_due, 120);
  });

  it('is for admins only', async () => {
    assert.equal((await cashier.get('/api/purchase-credit')).status, 403);
    assert.equal((await cashier.get('/api/paid-purchases')).status, 403);
    assert.equal((await cashier.post('/api/supplier-payments', { supplier_id: 1, amount: 1 })).status, 403);
  });
});
