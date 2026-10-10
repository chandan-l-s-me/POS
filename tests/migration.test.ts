/**
 * Schema migration against an existing database.
 *
 * A shop upgrading already has a `pos.db` with real bills in it. The schema
 * changes have to apply to that file in place, without losing anything and
 * without a manual step — so this exercises the actual upgrade path: write
 * data with one server, take it back to the old shape, and start a second
 * server on the same file.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

let server: TestServer;
let admin: Client;
let dbPath: string;
let billNumber: string;
let billId: number;

before(async () => {
  server = await startServer();
  dbPath = server.dbPath;
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);

  const item = await makeStockedItem(admin, {
    name: 'Legacy Item', hsn_code: '99887766', price: 33.33,
    gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 100,
  });

  const created = await admin.post('/api/bills', {
    items: [{ id: item.id, quantity: 7 }],
    payment_method: 'cash',
  });
  assert.equal(created.status, 200);
  billId = created.body.bill_id;
  billNumber = created.body.bill_number;
  assert.equal(created.body.subtotal_amount, 221.65);
});

after(async () => { await server?.stop(); });

describe('upgrading a database that predates subtotal_amount', () => {
  it('backfills the column from the line items, without touching anything else', async () => {
    // Stop the first server so the file is not being written, but keep the
    // database — that file is the thing being upgraded.
    await server.kill();

    // Put the database back into its pre-upgrade shape. Dropping the column
    // outright is what an older build's schema looks like.
    const raw = new Database(dbPath);
    const before = raw.prepare('SELECT * FROM bills WHERE id = ?').get(billId) as any;
    assert.equal(before.subtotal_amount, 221.65);
    raw.exec('ALTER TABLE bills DROP COLUMN subtotal_amount');
    const columns = raw.prepare('PRAGMA table_info(bills)').all() as Array<{ name: string }>;
    assert.ok(!columns.some((c) => c.name === 'subtotal_amount'), 'column should be gone');
    const billCountBefore = (raw.prepare('SELECT COUNT(*) c FROM bills').get() as any).c;
    const itemCountBefore = (raw.prepare('SELECT COUNT(*) c FROM bill_items').get() as any).c;
    raw.close();

    // Start a new server on the same file — this is the upgrade.
    const upgraded = await startServer({ DB_PATH: dbPath });
    try {
      const upgradedAdmin = client(upgraded.baseUrl);
      assert.equal((await upgradedAdmin.login('admin', ADMIN_PASSWORD)).status, 200);

      const bill = (await upgradedAdmin.get(`/api/bills/${billId}`)).body;
      assert.equal(bill.bill_number, billNumber, 'the bill must survive the upgrade');
      assert.equal(bill.total_amount, before.total_amount, 'the recorded total must not move');
      assert.equal(bill.tax_amount, before.tax_amount);
      assert.equal(
        bill.subtotal_amount,
        221.65,
        'the subtotal must be rebuilt from the line items, so old invoices reprint unchanged'
      );

      // Nothing lost.
      const check = new Database(dbPath, { readonly: true });
      assert.equal((check.prepare('SELECT COUNT(*) c FROM bills').get() as any).c, billCountBefore);
      assert.equal((check.prepare('SELECT COUNT(*) c FROM bill_items').get() as any).c, itemCountBefore);
      check.close();

      // And the upgraded server still bills correctly.
      const items = (await upgradedAdmin.get('/api/items?search=Legacy')).body.data;
      const fresh = await upgradedAdmin.post('/api/bills', {
        items: [{ id: items[0].id, quantity: 7 }],
        payment_method: 'cash',
      });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.subtotal_amount, 221.65);
      assert.notEqual(fresh.body.bill_number, billNumber, 'numbering continues rather than repeating');
    } finally {
      await upgraded.stop();
    }
  });

  it('is idempotent — a second start changes nothing', async () => {
    const again = await startServer({ DB_PATH: dbPath });
    try {
      const c = client(again.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);
      const bill = (await c.get(`/api/bills/${billId}`)).body;
      assert.equal(bill.subtotal_amount, 221.65);
      assert.equal(bill.bill_number, billNumber);
    } finally {
      await again.stop();
    }
  });

  it('does not re-seed the admin account on an existing database', async () => {
    const again = await startServer({ DB_PATH: dbPath, ADMIN_INITIAL_PASSWORD: 'a-different-password-9' });
    try {
      // The seed runs only on an empty database, so the original password must
      // still be the live one.
      assert.equal((await client(again.baseUrl).login('admin', 'a-different-password-9')).status, 401);
      assert.equal((await client(again.baseUrl).login('admin', ADMIN_PASSWORD)).status, 200);
    } finally {
      await again.stop();
    }
  });
});

describe('seeding the credit ledger on an existing database', () => {
  it('reconstructs history from past credit sales and reconciles to the balance', async () => {
    const fresh = await startServer();
    try {
      const c = client(fresh.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);

      const item = { body: await makeStockedItem(c, {
        name: 'Ledger Seed Item', hsn_code: '11112222', price: 100,
        gst_applicable: false, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, stock_quantity: 500,
      }) };
      const customer = await c.post('/api/customers', { name: 'Owes', phone: '7788990011' });

      // Three credit sales totalling 600.
      for (let i = 0; i < 3; i++) {
        assert.equal((await c.post('/api/bills', {
          items: [{ id: item.body.id, quantity: 2 }],
          payment_method: 'credit',
          customer_id: customer.body.id,
        })).status, 200);
      }
      assert.equal((await c.get(`/api/customers/${customer.body.id}/credit-entries`)).body.customer.credit_balance, 600);

      await fresh.kill();

      // Take the database back to its pre-ledger shape, and leave the balance
      // lower than the sales explain — as it would be if the shop had taken
      // repayments by retyping the number.
      const raw = new Database(fresh.dbPath);
      raw.exec('DROP TABLE customer_credit_entries');
      raw.prepare('UPDATE customers SET credit_balance = 250 WHERE id = ?').run(customer.body.id);
      raw.close();

      const upgraded = await startServer({ DB_PATH: fresh.dbPath });
      try {
        const u = client(upgraded.baseUrl);
        assert.equal((await u.login('admin', ADMIN_PASSWORD)).status, 200);

        const ledger = await u.get(`/api/customers/${customer.body.id}/credit-entries?limit=100`);
        assert.equal(ledger.status, 200);
        assert.equal(ledger.body.customer.credit_balance, 250);

        const entries = [...ledger.body.data].reverse(); // oldest first
        assert.equal(entries.length, 4, 'three real sales plus one reconciling entry');
        assert.deepEqual(entries.map((e: any) => e.entry_type), ['sale', 'sale', 'sale', 'adjustment']);
        assert.deepEqual(entries.map((e: any) => e.amount), [200, 200, 200, -350]);

        // Never negative, and it lands on the stored balance.
        for (const entry of entries) {
          assert.ok(entry.balance_after >= 0, 'a reconstructed statement must never read as the shop owing the customer');
        }
        assert.equal(entries[entries.length - 1].balance_after, 250);

        // The reconciling entry has to say what it is.
        assert.match(entries[3].note, /never itemised/i);
        assert.match(entries[3].note, /cumulative credit billed/i);

        // The real sales keep their bill references.
        assert.ok(entries.slice(0, 3).every((e: any) => e.bill_number), 'sales stay linked to their bills');
      } finally {
        await upgraded.stop();
      }
    } finally {
      await fresh.stop();
    }
  });

  it('does not seed twice when the server restarts', async () => {
    const fresh = await startServer();
    try {
      const c = client(fresh.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);
      const customer = await c.post('/api/customers', { name: 'Steady', phone: '7788990022', credit_balance: 500 });
      const firstCount = (await c.get(`/api/customers/${customer.body.id}/credit-entries`)).body.total;
      await fresh.kill();

      const again = await startServer({ DB_PATH: fresh.dbPath });
      try {
        const a = client(again.baseUrl);
        assert.equal((await a.login('admin', ADMIN_PASSWORD)).status, 200);
        const ledger = await a.get(`/api/customers/${customer.body.id}/credit-entries`);
        assert.equal(ledger.body.total, firstCount, 'restarting must not duplicate entries');
        assert.equal(ledger.body.customer.credit_balance, 500);
      } finally {
        await again.stop();
      }
    } finally {
      await fresh.stop();
    }
  });
});

describe('rebuilding stock batches on a database that predates them', () => {
  it('assigns current stock to the newest purchases, keeps prices, and sells FIFO afterwards', async () => {
    const fresh = await startServer();
    try {
      const c = client(fresh.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);

      // Two purchases at different costs — the first creates the item — then a
      // sale of 70. (Under the old model an item had one price, so both carry
      // the same selling price.)
      const first = await c.post('/api/purchases', {
        supplier_name: 'Mill',
        items: [{
          new_item: { name: 'Rebuild Flour', hsn_code: '11010000', metric: 'bag' },
          quantity: 100, unit_cost: 80, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0, selling_price: 100,
        }],
      });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const flour = first.body.created_items[0].id;
      assert.equal((await c.post('/api/purchases', {
        supplier_name: 'Mill',
        items: [{ item_id: flour, quantity: 120, unit_cost: 85, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0, selling_price: 100 }],
      })).status, 201);
      const sale = await c.post('/api/bills', { items: [{ id: flour, quantity: 70 }], payment_method: 'cash' });
      assert.equal(sale.status, 200);

      await fresh.kill();

      // Back to the pre-FIFO shape, plus stock nobody bought through the app.
      const raw = new Database(fresh.dbPath);
      raw.exec(`
        DROP TABLE bill_item_batches;
        DROP TABLE stock_adjustments;
        DROP TABLE stock_batches;
        ALTER TABLE items DROP COLUMN default_profit_percent;
        ALTER TABLE bill_items DROP COLUMN unit_price;
        ALTER TABLE bill_items DROP COLUMN price_overridden;
        ALTER TABLE purchase_items DROP COLUMN selling_price;
        ALTER TABLE purchase_items DROP COLUMN profit_percent;
      `);
      raw.prepare(`
        INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
        VALUES ('Old Stock Only', '99990000', 45, 'piece', 0, 0, 'split', 0, 0, 0, 0, 7)
      `).run();
      const before = raw.prepare('SELECT id, stock_quantity, price FROM items ORDER BY id').all() as any[];
      raw.close();

      const upgraded = await startServer({ DB_PATH: fresh.dbPath });
      try {
        const u = client(upgraded.baseUrl);
        assert.equal((await u.login('admin', ADMIN_PASSWORD)).status, 200);

        // Nothing the shop sees has changed.
        const check = new Database(fresh.dbPath, { readonly: true });
        const after = check.prepare('SELECT id, stock_quantity, price FROM items ORDER BY id').all();
        assert.deepEqual(after, before, 'stock and prices must be exactly as they were');
        const unitPrice = (check.prepare('SELECT unit_price FROM bill_items WHERE bill_id = ?').get(sale.body.bill_id) as any).unit_price;
        assert.equal(unitPrice, 100, 'old bill lines get their unit price filled in');
        check.close();

        // 150 left after buying 100 @ 80 then 120 @ 85 and selling 70: under
        // FIFO that is the last 30 of the first lot and all 120 of the second.
        const rebuilt = (await u.get(`/api/items/${flour}/batches?all=1`)).body;
        assert.deepEqual(
          rebuilt.data.map((b: any) => [b.source, b.unit_cost, b.quantity_received, b.quantity_remaining, b.selling_price]),
          [['purchase', 80, 100, 30, 100], ['purchase', 85, 120, 120, 100]]
        );
        assert.ok(rebuilt.item.default_profit_percent != null, 'margin remembered from the latest purchase');

        // Old purchase lines get the selling price and profit the report
        // download shows: 100 incl. 5% GST is 95.24 before GST, which is
        // 19.05% on a cost of 80 and 12.04% on 85.
        const report = (await u.get('/api/reports/purchase-items?from=2000-01-01')).body.data
          .filter((row: any) => row.item_id === flour);
        assert.deepEqual(
          report.map((row: any) => [row.unit_cost, row.selling_price, row.profit_percent]),
          [[85, 100, 12.04], [80, 100, 19.05]]
        );

        // Stock the purchases do not explain becomes one opening batch, cost unknown.
        const oldStockId = before[before.length - 1].id;
        const opening = (await u.get(`/api/items/${oldStockId}/batches`)).body.data;
        assert.deepEqual(opening.map((b: any) => [b.source, b.unit_cost, b.quantity_remaining, b.selling_price]), [['opening', null, 7, 45]]);

        // And billing now sells the older, cheaper lot first.
        const next = await u.post('/api/bills', { items: [{ id: flour, quantity: 31 }], payment_method: 'cash' });
        assert.equal(next.status, 200, JSON.stringify(next.body));
        const left = (await u.get(`/api/items/${flour}/batches`)).body.data;
        assert.deepEqual(left.map((b: any) => [b.unit_cost, b.quantity_remaining]), [[85, 119]]);
      } finally {
        await upgraded.stop();
      }
    } finally {
      await fresh.stop();
    }
  });

  it('only rebuilds once', async () => {
    const fresh = await startServer();
    try {
      const c = client(fresh.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);
      const item = await makeStockedItem(c, { price: 20, stock_quantity: 9 });
      await fresh.kill();

      const again = await startServer({ DB_PATH: fresh.dbPath });
      try {
        const a = client(again.baseUrl);
        assert.equal((await a.login('admin', ADMIN_PASSWORD)).status, 200);
        const { data } = (await a.get(`/api/items/${item.id}/batches?all=1`)).body;
        assert.equal(data.length, 1, 'a restart must not add batches');
        assert.equal(data[0].quantity_remaining, 9);
      } finally {
        await again.stop();
      }
    } finally {
      await fresh.stop();
    }
  });
});

describe('introducing purchase payments on an existing database', () => {
  it('links each purchase to its supplier and counts every earlier purchase as paid', async () => {
    const fresh = await startServer();
    try {
      const c = client(fresh.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);
      const item = await makeStockedItem(c, { name: 'Payments Upgrade Item', price: 50 });
      const bought = await c.post('/api/purchases', {
        supplier_name: 'Old Mill',
        items: [{ item_id: item.id, quantity: 4, unit_cost: 25, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, selling_price: 50 }],
      });
      assert.equal(bought.status, 201);
      await fresh.kill();

      // The shape before payments: no payment tables, purchases name their
      // supplier only as text — and one names a supplier who is not on file.
      const raw = new Database(fresh.dbPath);
      raw.exec('DROP TABLE supplier_payment_allocations; DROP TABLE supplier_payments;');
      raw.exec('DROP INDEX IF EXISTS idx_purchases_supplier_id; ALTER TABLE purchases DROP COLUMN supplier_id');
      raw.prepare("UPDATE purchases SET supplier_name = 'Unlisted Traders' WHERE id = ?").run(bought.body.purchase_id);
      const purchaseCount = (raw.prepare('SELECT COUNT(*) c FROM purchases').get() as any).c;
      raw.close();

      for (let start = 0; start < 2; start++) {
        const upgraded = await startServer({ DB_PATH: fresh.dbPath });
        try {
          const u = client(upgraded.baseUrl);
          assert.equal((await u.login('admin', ADMIN_PASSWORD)).status, 200);

          const credit = await u.get('/api/purchase-credit');
          assert.equal(credit.body.total_due, 0, 'nothing on file is owed after the upgrade');

          const paid = await u.get('/api/paid-purchases?limit=100');
          assert.equal(paid.body.total, purchaseCount, 'every earlier purchase is under Payments Done');

          const detail = await u.get(`/api/purchases/${bought.body.purchase_id}`);
          assert.equal(detail.body.balance_due, 0);
          assert.equal(detail.body.payments.length, 1, start === 0 ? 'one payment per purchase' : 'not added again on restart');
          assert.equal(detail.body.payments[0].method, null);
          assert.match(detail.body.payments[0].note, /before purchase payments were tracked/);

          const suppliers = (await u.get('/api/suppliers')).body as any[];
          assert.ok(suppliers.some((s) => s.name === 'Unlisted Traders'), 'a supplier named only on a purchase is added');
        } finally {
          await upgraded.stop();
        }
      }
    } finally {
      await fresh.stop();
    }
  });
});
