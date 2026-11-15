/**
 * Starting fresh after a trial, from .env (START_FRESH + START_FRESH_CONFIRM):
 * the practice data goes, once, with a backup first; staff logins and shop
 * settings stay; bill numbers start again at 0001.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vasavi-start-fresh-'));
const dbPath = path.join(dir, 'pos.db');
const backupDir = path.join(dir, 'backups');
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Start the app on the same database with these .env lines, run `check`, stop it. */
const withServer = async (env: Record<string, string>, check: (api: Client, server: TestServer) => Promise<void>) => {
  const server = await startServer({ DB_PATH: dbPath, BACKUP_DIR: backupDir, ...env });
  try {
    const api = client(server.baseUrl);
    assert.equal((await api.login('admin', ADMIN_PASSWORD)).status, 200, 'staff logins are kept');
    await check(api, server);
  } finally {
    await server.kill();
  }
};

const ids = { item: 0, customer: 0 };

describe('starting fresh after a trial', () => {
  it('a trial: items, customers, credit bills, purchases', async () => {
    await withServer({}, async (api) => {
      const settings = (await api.get('/api/settings')).body;
      await api.put('/api/settings', { ...settings, shop_name: 'Sri Vasavi Stores' });
      const item = await makeStockedItem(api, { name: 'Trial Sugar', price: 48, stock_quantity: 40 });
      ids.item = item.id;
      ids.customer = (await api.post('/api/customers', { shop_name: 'Trial Bakery', name: 'Ravi', phone: '9845000001' })).body.id;
      for (let i = 0; i < 3; i++) {
        const res = await api.post('/api/bills', { items: [{ id: item.id, quantity: 2 }], payment_method: 'credit', customer_id: ids.customer });
        assert.equal(res.status, 200);
      }
      assert.equal((await api.get(`/api/customers/${ids.customer}`)).body.credit_balance, 288);
    });
  });

  it('refuses to run without a proper confirm word or scope', async () => {
    await withServer({ START_FRESH: 'transactions', START_FRESH_CONFIRM: 'ab' }, async (api, server) => {
      assert.equal((await api.get('/api/bills')).body.total, 3, 'nothing erased');
      assert.match(server.stderr(), /START_FRESH_CONFIRM to a new word/);
    });
    await withServer({ START_FRESH: 'all of it', START_FRESH_CONFIRM: 'TRIAL-ONE' }, async (api, server) => {
      assert.equal((await api.get('/api/bills')).body.total, 3);
      assert.match(server.stderr(), /must be "transactions" or "everything"/);
    });
  });

  it('START_FRESH="transactions": erases the trial, keeps items, customers and settings', async () => {
    await withServer({ START_FRESH: 'transactions', START_FRESH_CONFIRM: 'TRIAL-ONE' }, async (api) => {
      assert.equal((await api.get('/api/bills')).body.total, 0, 'no bills');
      assert.equal((await api.get('/api/purchases')).body.length ?? (await api.get('/api/purchases')).body.total ?? 0, 0, 'no purchases');
      const item = (await api.get(`/api/items/${ids.item}/batches`)).body;
      assert.equal(item.item.name, 'Trial Sugar', 'the item is kept');
      assert.equal(item.item.stock_quantity, 0, 'with no stock');
      assert.equal(item.item.price, 48, 'and its selling price');
      assert.equal(item.data.length, 0);
      const customer = (await api.get(`/api/customers/${ids.customer}`)).body;
      assert.equal(customer.shop_name, 'Trial Bakery');
      assert.equal(customer.credit_balance, 0, 'owing nothing');
      assert.equal((await api.get('/api/settings')).body.shop_name, 'Sri Vasavi Stores', 'settings kept');

      // A backup of the trial, in the backups folder.
      const backups = fs.readdirSync(backupDir).filter((name) => name.endsWith('.db'));
      assert.equal(backups.length, 1);

      // The activity log starts with the start fresh, saying what was done.
      const logs = (await api.get('/api/audit-logs?search=Started%20fresh')).body.data;
      assert.equal(logs.length, 1);
      assert.match(logs[0].details, /erased 3 bill\(s\), 1 purchase\(s\)/);

      // Counted stock goes in at the item's kept price; bill numbers restart.
      const added = await api.post(`/api/items/${ids.item}/stock-adjustments`, { quantity: 25, reason: 'Opening count' });
      assert.equal(added.status, 201, JSON.stringify(added.body));
      const sale = await api.post('/api/bills', { items: [{ id: ids.item, quantity: 1 }], payment_method: 'cash' });
      assert.equal(sale.body.bill_number, '0001');
      assert.equal(sale.body.total_amount, 48);
    });
  });

  it('does nothing more when started again with the same word', async () => {
    await withServer({ START_FRESH: 'transactions', START_FRESH_CONFIRM: 'TRIAL-ONE' }, async (api, server) => {
      assert.equal((await api.get('/api/bills')).body.total, 1, 'the real bill is still there');
      assert.match(server.stdout(), /already done for "TRIAL-ONE"/);
    });
  });

  it('START_FRESH="everything" with a new word: items, customers and suppliers go too', async () => {
    await withServer({ START_FRESH: 'everything', START_FRESH_CONFIRM: 'TRIAL-TWO' }, async (api) => {
      assert.equal((await api.get('/api/items')).body.total, 0);
      assert.equal((await api.get('/api/customers?limit=10')).body.length ?? (await api.get('/api/customers?limit=10')).body.total, 0);
      assert.equal((await api.get('/api/suppliers')).body.length ?? 0, 0);
      assert.equal((await api.get('/api/settings')).body.shop_name, 'Sri Vasavi Stores', 'settings kept');
      assert.equal(fs.readdirSync(backupDir).filter((name) => name.endsWith('.db')).length, 2, 'a second backup');
    });
  });
});
