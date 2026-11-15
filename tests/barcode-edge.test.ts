/**
 * Barcodes at their edges: the length limits, codes that need escaping in a
 * URL, Excel's shortened numbers, a purchase that fails half way, codes moving
 * between items, a deleted item's code, and two screens saving at once.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_PASSWORD, client, itemFields, lineRates, makeStockedItem, startServer,
  type Client, type TestServer,
} from './helpers.ts';
import { barcodeProblem, looksLikeBarcode, normalizeBarcode } from '../src/lib/barcode.ts';
import { checkImportRows, emptyImportRow, rowsFromCells, type ImportRow } from '../src/lib/itemImport.ts';

const SHORTENED = 'Excel has shortened this barcode. Format the column as Text, type the barcode again and save.';

describe('barcode rules at their limits', () => {
  it('takes 4 and 48 characters, not 3 or 49', () => {
    assert.equal(barcodeProblem('1234'), null);
    assert.equal(barcodeProblem('A'.repeat(48)), null);
    assert.match(barcodeProblem('123')!, /4 to 48/);
    assert.match(barcodeProblem('A'.repeat(49))!, /4 to 48/);
  });

  it('drops every kind of space a scanner or a paste can bring', () => {
    assert.equal(normalizeBarcode('\t8901 234\n567890\r'), '8901234567890');
    assert.equal(normalizeBarcode(8901234567890), '8901234567890', 'a number from a spreadsheet');
  });

  it('refuses a code Excel has shortened to 8.90123E+12, and only that', () => {
    assert.equal(barcodeProblem(normalizeBarcode('8.90123E+12')), SHORTENED);
    assert.equal(barcodeProblem(normalizeBarcode('8.90123e+12')), SHORTENED);
    assert.equal(barcodeProblem('89E+12'), SHORTENED);
    assert.equal(barcodeProblem('12E45'), null, 'a code a shop made up');
    assert.equal(barcodeProblem('SKU-1E+2X'), null);
  });

  it('refuses letters from other scripts and emoji, which no scanner types', () => {
    assert.match(barcodeProblem('ABC१२३४')!, /English letters/);
    assert.match(barcodeProblem('ABCD😀')!, /English letters/);
  });

  it('reads only 8 to 14 digits as a product code in a name box', () => {
    assert.equal(looksLikeBarcode('1234567'), false);
    assert.equal(looksLikeBarcode(' 12345678 '), true);
    assert.equal(looksLikeBarcode('12345678901234'), true);
    assert.equal(looksLikeBarcode('123456789012345'), false);
    assert.equal(looksLikeBarcode('8901-234'), false);
  });

  it('finds the shortened code in an imported CSV and every format problem in the file', () => {
    const { rows } = rowsFromCells([
      ['Name', 'HSN', 'Unit', 'GST', 'Quantity', 'Selling price', 'Barcode'],
      ['Soap', '3401', 'piece', '18', '5', '40', '8.90123E+12'],
      ['Oil', '1512', 'packet', '5', '5', '150', ' 890 1234 567890 '],
      ['Salt', '2501', 'packet', '5', '5', '20', ''],
    ]);
    assert.equal(rows[1].barcode, '8901234567890', 'read without its spaces');
    const checked = checkImportRows(rows, new Set(), new Map());
    assert.deepEqual(checked[0].problems.map((p) => [p.field, p.message]), [['barcode', SHORTENED]]);
    assert.equal(checked[1].problems.length, 0, JSON.stringify(checked[1].problems));
    assert.equal(checked[1].item?.barcode, '8901234567890');
    assert.equal(checked[2].item?.barcode, null);
  });

  it('treats codes that differ only in case as one code, in an import', () => {
    const row = (name: string, barcode: string): ImportRow => ({
      ...emptyImportRow(), name, hsn_code: '1905', unit: 'packet', gst: '18', quantity: '5', price: '10', barcode,
    });
    const checked = checkImportRows([row('A', 'shop-01'), row('B', 'Shop-01')], new Set(), new Map());
    assert.deepEqual(checked[1].problems.map((p) => p.message), ['Same barcode as row {row}']);
  });
});

describe('barcodes in the app, at their edges', () => {
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
  const lookup = (code: string) => admin.get(`/api/items/barcode/${encodeURIComponent(code)}`);
  const setCode = (id: number, barcode: unknown) => admin.put(`/api/items/${id}/barcode`, { barcode });
  const line = (itemId: number, extra: Record<string, unknown> = {}) => ({
    item_id: itemId, quantity: 2, unit_cost: 50, selling_price: 80, sgst_rate: 9, cgst_rate: 9, igst_rate: 0, ...extra,
  });
  const newLine = (fields: Record<string, any>, extra: Record<string, unknown> = {}) => ({
    new_item: { name: fields.name, hsn_code: fields.hsn_code, metric: fields.metric },
    quantity: 3, unit_cost: 20, selling_price: 30, ...lineRates(fields), ...extra,
  });
  const purchase = (items: unknown[]) => admin.post('/api/purchases', { supplier_name: 'Edge Supplier', items });

  it('saves and finds codes with characters that need escaping in a link', async () => {
    const item = await makeStockedItem(admin);
    for (const code of ['SKU/42#A?B%', 'A+B&C=D', 'X.Y_Z~1']) {
      const set = await setCode(item.id, code);
      assert.equal(set.status, 200, `${code}: ${JSON.stringify(set.body)}`);
      const found = await lookup(code.toLowerCase());
      assert.equal(found.status, 200, `${code} found`);
      assert.equal(found.body.id, item.id);
    }
  });

  it('takes the longest code and refuses one longer, and a shortened Excel number', async () => {
    const item = await makeStockedItem(admin);
    const longest = `L${'7'.repeat(47)}`;
    assert.equal((await setCode(item.id, longest)).status, 200);
    assert.equal((await lookup(longest)).body.id, item.id);
    const tooLong = await setCode(item.id, `${longest}7`);
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.error, 'A barcode must be 4 to 48 characters long');
    const shortened = await setCode(item.id, '8.90123E+12');
    assert.equal(shortened.status, 400);
    assert.equal(shortened.body.error, SHORTENED);
    assert.equal((await itemById(item.id)).barcode, longest, 'kept');
  });

  it('answers wrong requests with 400, not a crash', async () => {
    const item = await makeStockedItem(admin);
    const number = await setCode(item.id, 8901234567890);
    assert.equal(number.status, 400);
    assert.equal(number.body.error, 'Barcode must be text');
    assert.equal((await setCode(item.id, ['8901234567890'])).status, 400);
    assert.equal((await setCode(item.id, { code: '1' })).status, 400);
    assert.equal((await admin.put('/api/items/abc/barcode', { barcode: '89012345' })).status, 400);
    assert.equal((await admin.put('/api/items/-1/barcode', { barcode: '89012345' })).status, 400);
    assert.equal((await setCode(item.id, null)).status, 200, 'null removes it, as an empty code does');
    assert.equal((await setCode(item.id, '   ')).status, 200, 'only spaces is no code');
    assert.equal((await itemById(item.id)).barcode, null);

    const bad = await purchase([line(item.id, { barcode: 12345678 })]);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'Barcode must be text');

    const blank = await admin.get('/api/items/barcode/%20%20');
    assert.equal(blank.status, 404, 'a code of only spaces finds nothing');
  });

  it('writes no history when the code saved is the one the item has', async () => {
    const item = await makeStockedItem(admin);
    await setCode(item.id, 'SAME-0001');
    const count = async () => (await admin.get('/api/audit-logs?search=SAME-0001')).body.data.length;
    const before = await count();
    assert.equal((await setCode(item.id, ' same-0001 ')).status, 200);
    assert.equal(await count(), before);
  });

  it('lets a code move to another item once its first item lets go of it', async () => {
    const a = await makeStockedItem(admin);
    const b = await makeStockedItem(admin);
    await setCode(a.id, 'MOVE-0001');
    await setCode(b.id, 'MOVE-0002');

    // Swapping two codes: neither can take the other's while it is held.
    assert.equal((await setCode(b.id, 'MOVE-0001')).status, 400);
    assert.equal((await setCode(a.id, 'MOVE-0003')).status, 200, 'a changes its code');
    assert.equal((await setCode(b.id, 'MOVE-0001')).status, 200, 'and b may now have the old one');
    assert.equal((await lookup('MOVE-0001')).body.id, b.id);
    assert.equal((await lookup('MOVE-0002')).status, 404, "b's old code is free");
  });

  it('keeps the rest of an item edit from saving when its barcode is taken', async () => {
    const owner = await makeStockedItem(admin);
    await setCode(owner.id, 'EDIT-0001');
    const item = await makeStockedItem(admin);
    const { id: _id, price: _p, stock_quantity: _s, ...catalogue } = item as any;
    const res = await admin.put(`/api/items/${item.id}`, { ...catalogue, name: `${item.name} renamed`, barcode: 'edit-0001' });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, `Barcode EDIT-0001 is already on ${owner.name}.`);
    const after = await itemById(item.id);
    assert.equal(after.name, item.name, 'not renamed');
    assert.equal(after.barcode, null);
  });

  it('takes one code on two lines of the same item in a purchase, and records it once', async () => {
    const item = await makeStockedItem(admin);
    const res = await purchase([line(item.id, { barcode: 'TWICE-0001' }), line(item.id, { barcode: 'twice-0001' })]);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.barcodes_added, [{ id: item.id, name: item.name, barcode: 'TWICE-0001' }]);
    const logs = (await admin.get('/api/audit-logs?search=TWICE-0001')).body.data;
    assert.equal(logs.length, 1);
    assert.match(logs[0].details, /on purchase /);
  });

  it('saves no barcode, item or stock of a purchase that fails on a later line', async () => {
    const a = await makeStockedItem(admin, { stock_quantity: 10 });
    const holder = await makeStockedItem(admin);
    await setCode(holder.id, 'HELD-0001');
    const fresh = itemFields();

    const res = await purchase([
      line(a.id, { barcode: 'ROLL-0001' }),
      newLine(fresh, { barcode: 'ROLL-0002' }),
      line(holder.id, { barcode: 'HELD-0002' }), // holder already has a code
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.body.error, `${holder.name} already has the barcode HELD-0001. Change it in Items.`);

    const after = await itemById(a.id);
    assert.equal(after.barcode, null, 'the first line gave it nothing');
    assert.equal(after.stock_quantity, 10);
    assert.equal((await lookup('ROLL-0001')).status, 404);
    assert.equal((await lookup('ROLL-0002')).status, 404);
    assert.equal((await admin.get(`/api/items?search=${encodeURIComponent(fresh.name)}`)).body.total, 0, 'the new item was not made');

    // Both codes are still free to use.
    const retry = await purchase([line(a.id, { barcode: 'ROLL-0001' }), newLine(fresh, { barcode: 'ROLL-0002' })]);
    assert.equal(retry.status, 201, JSON.stringify(retry.body));
    assert.equal((await lookup('ROLL-0001')).body.id, a.id);
    assert.equal((await lookup('ROLL-0002')).body.name, fresh.name);
  });

  it('refuses a missing item on a line before giving any code away', async () => {
    const fresh = itemFields();
    const res = await purchase([newLine(fresh, { barcode: 'GONE-0001' }), line(999999)]);
    assert.equal(res.status, 400);
    assert.equal((await lookup('GONE-0001')).status, 404);
  });

  it('frees the code of a deleted item', async () => {
    const tag = `Del${Date.now().toString(36)}`;
    const imported = await admin.post('/api/items/import', {
      rows: [{ name: `${tag} soap`, hsn_code: '3401', unit: 'piece', gst: '18', quantity: '0', cost: '', price: '40', name_kn: '', barcode: 'FREE-0001' }],
    });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    const { id } = (await lookup('FREE-0001')).body;
    assert.equal((await admin.del(`/api/items/${id}`)).status, 200);
    assert.equal((await lookup('FREE-0001')).status, 404);
    const other = await makeStockedItem(admin);
    assert.equal((await setCode(other.id, 'FREE-0001')).status, 200);
  });

  it('gives a code to only one of two items saved at the same moment', async () => {
    const a = await makeStockedItem(admin);
    const b = await makeStockedItem(admin);
    const results = await Promise.all([setCode(a.id, 'RACE-0001'), setCode(b.id, 'RACE-0001')]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const winner = results[0].status === 200 ? a.id : b.id;
    assert.equal((await lookup('RACE-0001')).body.id, winner);
  });

  it('refuses two rows with one code in an import sent straight to the server', async () => {
    const tag = `Dup${Date.now().toString(36)}`;
    const row = (name: string, barcode: string) => ({
      name, hsn_code: '1905', unit: 'packet', gst: '18', quantity: '1', cost: '', price: '10', name_kn: '', barcode,
    });
    const res = await admin.post('/api/items/import', { rows: [row(`${tag} a`, 'DUP-0001'), row(`${tag} b`, 'dup-0001'), row(`${tag} c`, '8.90123E+12')] });
    assert.equal(res.body.saved, false);
    assert.deepEqual(res.body.problems.map((p: any) => [p.row, p.message]), [
      [1, 'Same barcode as row {row}'],
      [2, SHORTENED],
    ]);
    assert.equal((await lookup('DUP-0001')).status, 404, 'nothing saved');
  });

  it('sells a barcoded item on a bill as any other, and keeps its code', async () => {
    const item = await makeStockedItem(admin, { price: 50, stock_quantity: 5 });
    await setCode(item.id, 'SELL-0001');
    const found = (await lookup('sell-0001')).body;
    const bill = await admin.post('/api/bills', { items: [{ id: found.id, quantity: 2 }], payment_method: 'cash' });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    const after = await itemById(item.id);
    assert.equal(after.stock_quantity, 3);
    assert.equal(after.barcode, 'SELL-0001');
  });

  it('searches barcodes in any case and part, and combines the search with a filter', async () => {
    const tag = `Srch${Date.now().toString(36)}`;
    const coded = await makeStockedItem(admin, { name: `${tag} coded`, stock_quantity: 3 });
    await setCode(coded.id, `${tag}-ZX77`);
    await makeStockedItem(admin, { name: `${tag} plain`, stock_quantity: 3 });

    const ids = async (query: string) => (await admin.get(`/api/items?${query}`)).body.data.map((i: any) => i.id);
    assert.deepEqual(await ids(`search=${tag.toLowerCase()}-zx`), [coded.id]);
    assert.deepEqual(await ids(`search=zx%2077`), [coded.id], 'a space typed in the code');
    assert.deepEqual(await ids(`search=${tag}&filter=barcode`), [coded.id]);
    assert.equal((await ids(`search=${tag}&filter=no_barcode`)).length, 1);
    const both = (await admin.get(`/api/items?search=${tag}&filter=low_stock&counts=1`)).body;
    assert.equal(both.total, 2);
    assert.deepEqual(both.counts, { all_items: 2, barcode: 1, no_barcode: 1, low_stock: 2, out_of_stock: 0 });
  });

  it('counts the whole shop when there is no search, and the counts add up', async () => {
    const { counts, total } = (await admin.get('/api/items?counts=1&limit=1')).body;
    assert.equal(counts.all_items, total);
    assert.equal(counts.barcode + counts.no_barcode, counts.all_items);
    assert.ok(counts.low_stock + counts.out_of_stock <= counts.all_items);
  });
});
