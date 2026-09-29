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
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';

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

  const item = await admin.post('/api/items', {
    name: 'Legacy Item', hsn_code: '99887766', price: 33.33, metric: 'piece',
    is_loose: false, gst_applicable: true, gst_mode: 'split',
    gst_rate: 5, sgst_rate: 2.5, cgst_rate: 2.5, igst_rate: 0, stock_quantity: 100,
  });
  assert.equal(item.status, 200);

  const created = await admin.post('/api/bills', {
    items: [{ id: item.body.id, quantity: 7 }],
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

      const item = await c.post('/api/items', {
        name: 'Ledger Seed Item', hsn_code: '11112222', price: 100, metric: 'piece',
        is_loose: false, gst_applicable: false, gst_mode: 'split',
        gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, stock_quantity: 500,
      });
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
