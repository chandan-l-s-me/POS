/**
 * Item barcodes: the shared rules, saving them on purchases, the Items page
 * and the import, finding an item by one, the Items filters, and the
 * one-time clean-up of the old `barcode` column.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_PASSWORD, client, itemFields, lineRates, makeStockedItem, purchaseNewItem, startServer,
  type Client, type TestServer,
} from './helpers.ts';
import { barcodeProblem, findByBarcode, looksLikeBarcode, normalizeBarcode } from '../src/lib/barcode.ts';
import { checkImportRows, emptyImportRow, type ImportRow } from '../src/lib/itemImport.ts';

const Database = createRequire(import.meta.url)('better-sqlite3');

describe('barcode rules', () => {
  it('stores codes without spaces and in one case, so Caps Lock does not matter', () => {
    assert.equal(normalizeBarcode(' 890 1234 567890 '), '8901234567890');
    assert.equal(normalizeBarcode('abc-12x'), 'ABC-12X');
    assert.equal(normalizeBarcode(null), '');
  });

  it('accepts what scanners read and refuses what they cannot', () => {
    assert.equal(barcodeProblem(''), null, 'no barcode is fine');
    assert.equal(barcodeProblem('8901234567890'), null);
    assert.equal(barcodeProblem('SKU-0042/A'), null);
    assert.match(barcodeProblem('123')!, /4 to 48/);
    assert.match(barcodeProblem('9'.repeat(49))!, /4 to 48/);
    assert.match(barcodeProblem('ಅಕ್ಕಿ1234')!, /English letters/);
  });

  it('tells a scanned product code from an item name', () => {
    assert.equal(looksLikeBarcode('8901234567890'), true);
    assert.equal(looksLikeBarcode('12345678'), true);
    assert.equal(looksLikeBarcode('1701'), false, 'an HSN code');
    assert.equal(looksLikeBarcode('Parle 100g'), false);
  });

  it('finds an item by its code, whatever the case', () => {
    const items = [{ id: 1, barcode: null }, { id: 2, barcode: 'ABC-1234' }];
    assert.equal(findByBarcode(items, 'abc-1234')?.id, 2);
    assert.equal(findByBarcode(items, 'nope'), undefined);
    assert.equal(findByBarcode(items, ''), undefined);
  });

  it('checks barcodes in an import: format, twice in the file, already in the app', () => {
    const row = (name: string, barcode: string): ImportRow => ({
      ...emptyImportRow(), name, hsn_code: '1905', unit: 'packet', gst: '18', quantity: '5', price: '10', barcode,
    });
    const checked = checkImportRows(
      [row('A', '8901111111111'), row('B', '8901111111111'), row('C', '12'), row('D', '8902222222222'), row('E', '')],
      new Set(),
      new Map([['8902222222222', 'Old Item']])
    );
    assert.equal(checked[0].item?.barcode, '8901111111111');
    assert.deepEqual(checked[1].problems.map((p) => [p.field, p.message, p.vars]), [['barcode', 'Same barcode as row {row}', { row: 1 }]]);
    assert.match(checked[2].problems[0].message, /4 to 48/);
    assert.deepEqual(checked[3].problems.map((p) => [p.message, p.vars]), [['This barcode is already on {item}', { item: 'Old Item' }]]);
    assert.equal(checked[4].item?.barcode, null, 'optional');
  });
});

describe('barcodes in the app', () => {
  let server: TestServer;
  let admin: Client;

  before(async () => {
    server = await startServer();
    admin = client(server.baseUrl);
    assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  });
  after(async () => { await server?.stop(); });

  const itemById = async (id: number) =>
    (await admin.get('/api/items?limit=500')).body.data.find((item: any) => item.id === id);

  /** Buy a new item with a barcode on its line. */
  const buyNew = (fields: Record<string, any>, barcode: string | undefined, extra: Record<string, any> = {}) =>
    admin.post('/api/purchases', {
      supplier_name: 'Barcode Supplier',
      items: [{
        new_item: { name: fields.name, hsn_code: fields.hsn_code, metric: fields.metric },
        ...(barcode === undefined ? {} : { barcode }),
        quantity: 5, unit_cost: 50, selling_price: 80, ...lineRates(fields), ...extra,
      }],
    });

  const buyExisting = (itemId: number, barcode?: string) =>
    admin.post('/api/purchases', {
      supplier_name: 'Barcode Supplier',
      items: [{ item_id: itemId, ...(barcode === undefined ? {} : { barcode }), quantity: 2, unit_cost: 50, selling_price: 80, sgst_rate: 9, cgst_rate: 9, igst_rate: 0 }],
    });

  it('saves a barcode with a new item bought on a purchase, and finds the item by it', async () => {
    const fields = itemFields();
    const res = await buyNew(fields, ' 890 0000 000017 ');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.created_items[0].id;

    const item = await itemById(id);
    assert.equal(item.barcode, '8900000000017', 'in the lean list the billing screen caches');

    const found = await admin.get('/api/items/barcode/8900000000017');
    assert.equal(found.status, 200);
    assert.equal(found.body.id, id);

    const missing = await admin.get('/api/items/barcode/8909999999999');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error, 'No item has the barcode 8909999999999');

    const searched = (await admin.get('/api/items?search=0000000017')).body.data;
    assert.deepEqual(searched.map((i: any) => i.id), [id], 'the Items search finds barcodes too');
  });

  it('matches a code scanned with Caps Lock on', async () => {
    const res = await buyNew(itemFields(), 'shop-0001');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const found = await admin.get('/api/items/barcode/Shop-0001');
    assert.equal(found.body.barcode, 'SHOP-0001');
  });

  it('gives an existing item its first barcode on a purchase, and keeps one it already has', async () => {
    const item = await makeStockedItem(admin, { price: 80 });
    const first = await buyExisting(item.id, '8900000000024');
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal((await itemById(item.id)).barcode, '8900000000024');

    // The same code again (the purchase screen sends it only when missing,
    // but an older screen might) is fine.
    assert.equal((await buyExisting(item.id, '8900000000024')).status, 201);

    // A different one is refused, and nothing of that purchase is saved.
    const stockBefore = (await itemById(item.id)).stock_quantity;
    const purchasesBefore = (await admin.get('/api/purchases')).body.total;
    const other = await buyExisting(item.id, '8900000000031');
    assert.equal(other.status, 400);
    assert.equal(other.body.error, `${item.name} already has the barcode 8900000000024. Change it in Items.`);
    assert.equal((await itemById(item.id)).stock_quantity, stockBefore);
    assert.equal((await admin.get('/api/purchases')).body.total, purchasesBefore);
  });

  it('refuses a barcode another item has, on a purchase', async () => {
    const owner = await makeStockedItem(admin);
    assert.equal((await admin.put(`/api/items/${owner.id}/barcode`, { barcode: '8900000000048' })).status, 200);

    const fields = itemFields();
    const res = await buyNew(fields, '8900000000048');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, `Barcode 8900000000048 is already on ${owner.name}.`);
    const created = (await admin.get(`/api/items?search=${encodeURIComponent(fields.name)}`)).body.data;
    assert.equal(created.length, 0, 'the new item was not created');

    const plain = await makeStockedItem(admin);
    assert.equal((await buyExisting(plain.id, '8900000000048')).status, 400);
  });

  it('refuses one barcode on two different items of a purchase', async () => {
    const a = itemFields();
    const b = itemFields();
    const res = await admin.post('/api/purchases', {
      supplier_name: 'Barcode Supplier',
      items: [a, b].map((fields) => ({
        new_item: { name: fields.name, hsn_code: fields.hsn_code, metric: fields.metric },
        barcode: '8900000000055', quantity: 1, unit_cost: 10, selling_price: 20, ...lineRates(fields),
      })),
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /^Barcode 8900000000055 is already on /);
  });

  it('refuses a badly formed barcode', async () => {
    const res = await buyNew(itemFields(), '12');
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'A barcode must be 4 to 48 characters long');
  });

  it('adds, changes and removes a barcode from the Items page', async () => {
    const item = await makeStockedItem(admin);
    const other = await makeStockedItem(admin);
    assert.equal((await admin.put(`/api/items/${other.id}/barcode`, { barcode: '8900000000062' })).status, 200);

    const set = await admin.put(`/api/items/${item.id}/barcode`, { barcode: '8900000000079' });
    assert.deepEqual(set.body, { success: true, barcode: '8900000000079' });

    const taken = await admin.put(`/api/items/${item.id}/barcode`, { barcode: '8900000000062' });
    assert.equal(taken.status, 400);
    assert.equal(taken.body.error, `Barcode 8900000000062 is already on ${other.name}.`);
    assert.equal((await itemById(item.id)).barcode, '8900000000079', 'unchanged');

    assert.equal((await admin.put(`/api/items/${item.id}/barcode`, { barcode: '' })).status, 200);
    assert.equal((await itemById(item.id)).barcode, null, 'removed');
    assert.equal((await admin.put(`/api/items/${item.id}/barcode`, {})).status, 400, 'says what to set');
    assert.equal((await admin.put('/api/items/999999/barcode', { barcode: '89000' })).status, 404);

    const logs = (await admin.get('/api/audit-logs?search=barcode')).body.data.map((l: any) => l.details);
    assert.ok(logs.includes(`Set the barcode of ${item.name} to 8900000000079`), logs.join('\n'));
    assert.ok(logs.includes(`Removed the barcode 8900000000079 from ${item.name}`));
  });

  it('keeps the barcode when an item is edited without one, and changes it when one is sent', async () => {
    const item = await makeStockedItem(admin);
    await admin.put(`/api/items/${item.id}/barcode`, { barcode: '8900000000086' });
    const { id: _id, price: _price, stock_quantity: _stock, ...catalogue } = item as any;

    assert.equal((await admin.put(`/api/items/${item.id}`, { ...catalogue, name: `${item.name} renamed` })).status, 200);
    assert.equal((await itemById(item.id)).barcode, '8900000000086', 'left out: kept');

    assert.equal((await admin.put(`/api/items/${item.id}`, { ...catalogue, barcode: 'x-77-y' })).status, 200);
    assert.equal((await itemById(item.id)).barcode, 'X-77-Y');

    assert.equal((await admin.put(`/api/items/${item.id}`, { ...catalogue, barcode: '' })).status, 200);
    assert.equal((await itemById(item.id)).barcode, null, 'sent empty: removed');
  });

  it('lets a cashier find items by barcode but not change barcodes', async () => {
    const item = await makeStockedItem(admin);
    await admin.put(`/api/items/${item.id}/barcode`, { barcode: '8900000000093' });
    const created = await admin.post('/api/users', { name: 'Scan Cashier', username: 'scan-cashier', password: 'scan-cashier-1', role: 'cashier' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const cashier = client(server.baseUrl);
    await cashier.login('scan-cashier', 'scan-cashier-1');
    assert.equal((await cashier.get('/api/items/barcode/8900000000093')).body.id, item.id);
    assert.equal((await cashier.put(`/api/items/${item.id}/barcode`, { barcode: '8900000000109' })).status, 403);
    assert.equal((await client(server.baseUrl).get('/api/items/barcode/8900000000093')).status, 401);
  });

  it('filters the Items list, and counts each filter within the search', async () => {
    const tag = `Filt${Date.now().toString(36)}`;
    const withCode = await makeStockedItem(admin, { name: `${tag} coded`, stock_quantity: 50 });
    await admin.put(`/api/items/${withCode.id}/barcode`, { barcode: `${tag}-1` });
    const low = await makeStockedItem(admin, { name: `${tag} low`, stock_quantity: 4 });
    const out = await makeStockedItem(admin, { name: `${tag} out`, stock_quantity: 0 });

    const list = async (filter?: string) => {
      const res = await admin.get(`/api/items?search=${tag}&counts=1${filter ? `&filter=${filter}` : ''}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body;
    };
    const all = await list();
    assert.deepEqual(all.counts, { all_items: 3, barcode: 1, no_barcode: 2, low_stock: 1, out_of_stock: 1 });
    assert.deepEqual((await list('barcode')).data.map((i: any) => i.id), [withCode.id]);
    assert.deepEqual((await list('no_barcode')).data.map((i: any) => i.id).sort(), [low.id, out.id].sort());
    assert.deepEqual((await list('low_stock')).data.map((i: any) => i.id), [low.id]);
    const outList = await list('out_of_stock');
    assert.deepEqual(outList.data.map((i: any) => i.id), [out.id]);
    assert.equal(outList.total, 1);
    assert.deepEqual(outList.counts, all.counts, 'the counts do not depend on the filter chosen');

    assert.equal((await admin.get('/api/items?filter=bogus')).status, 400);
    assert.equal((await admin.get('/api/items')).body.counts, undefined, 'only when asked');
  });

  it('imports items with their barcodes, and refuses one already in the app', async () => {
    const row = (name: string, barcode: string) => ({
      name, hsn_code: '1905', unit: 'packet', gst: '18', quantity: '3', cost: '8', price: '10', name_kn: '', barcode,
    });
    const tag = `Imp${Date.now().toString(36)}`;
    const saved = await admin.post('/api/items/import', { rows: [row(`${tag} one`, '890 1000 000014'), row(`${tag} two`, '')] });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal((await admin.get('/api/items/barcode/8901000000014')).body.name, `${tag} one`);

    const again = await admin.post('/api/items/import', { rows: [row(`${tag} three`, '8901000000014')] });
    assert.equal(again.body.saved, false);
    assert.deepEqual(again.body.problems.map((p: any) => [p.field, p.message, p.vars]), [
      ['barcode', 'This barcode is already on {item}', { item: `${tag} one` }],
    ]);
  });
});

describe('upgrading the old barcode column', () => {
  it('moves HSN codes once, clears them from barcode, and never copies a real barcode into HSN', async () => {
    const old = await startServer();
    let upgraded: TestServer | null = null;
    let again: TestServer | null = null;
    try {
      const c = client(old.baseUrl);
      assert.equal((await c.login('admin', ADMIN_PASSWORD)).status, 200);
      const legacyNoHsn = await purchaseNewItem(c, itemFields(), { quantity: 1, unit_cost: 10, selling_price: 20 });
      const legacySame = await purchaseNewItem(c, itemFields(), { quantity: 1, unit_cost: 10, selling_price: 20 });
      const realCode = await purchaseNewItem(c, itemFields(), { quantity: 1, unit_cost: 10, selling_price: 20 });
      await old.kill();

      // As a shop on an old version had it: HSN codes kept in `barcode`.
      const db = new Database(old.dbPath);
      try {
        db.prepare("UPDATE items SET hsn_code = '', barcode = '0402' WHERE id = ?").run(legacyNoHsn);
        db.prepare("UPDATE items SET barcode = hsn_code WHERE id = ?").run(legacySame);
        db.prepare("UPDATE items SET barcode = 'abc 123' WHERE id = ?").run(realCode);
        db.pragma('user_version = 0');
      } finally {
        db.close();
      }

      upgraded = await startServer({ DB_PATH: old.dbPath });
      const read = (path: string) => {
        const check = new Database(path, { readonly: true });
        try {
          return {
            rows: check.prepare('SELECT id, hsn_code, barcode FROM items WHERE id IN (?, ?, ?) ORDER BY id').all(legacyNoHsn, legacySame, realCode),
            version: check.pragma('user_version', { simple: true }),
          };
        } finally {
          check.close();
        }
      };
      await upgraded.kill();
      const after1 = read(old.dbPath);
      assert.equal(after1.version, 1);
      const [noHsn, same, real] = after1.rows as any[];
      assert.deepEqual([noHsn.hsn_code, noHsn.barcode], ['0402', null], 'the HSN code moved, and is no barcode');
      assert.equal(same.barcode, null, 'a copy of the HSN code is no barcode');
      assert.equal(real.barcode, 'ABC123', 'a real code stays, stored as scans are compared');

      // A real barcode on an item with no HSN code stays out of the HSN code
      // on every later start.
      const db2 = new Database(old.dbPath);
      try {
        db2.prepare("UPDATE items SET hsn_code = '' WHERE id = ?").run(realCode);
      } finally {
        db2.close();
      }
      again = await startServer({ DB_PATH: old.dbPath });
      await again.kill();
      const after2 = (read(old.dbPath).rows as any[]).find((row) => row.id === realCode);
      assert.deepEqual([after2.hsn_code, after2.barcode], ['', 'ABC123']);
    } finally {
      await again?.kill();
      await upgraded?.kill();
      await old.stop();
    }
  });
});
