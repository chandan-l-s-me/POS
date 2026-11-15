/**
 * Search that forgives a slip: on the screens (src/lib/fuzzy.ts) and in the
 * Items and Customers searches on the server.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';
import { editDistance, foldText, searchList } from '../src/lib/fuzzy.ts';

const ITEMS = [
  'Sugar 1kg', 'Fresh Compressed Yeast (500 g)', 'Dark Chocolate Compound (500 g)', 'Condensed Milk (400 g)',
  'Instant Dry Yeast (500 g)', 'Ice cream', 'Rice 1kg', 'Food Colour Gel - Assorted',
].map((name, id) => ({ id, name, hsn_code: `19${id}5`, barcode: id === 0 ? '8901234567890' : null }));
const FIELDS = { names: (item: (typeof ITEMS)[number]) => [item.name], codes: (item: (typeof ITEMS)[number]) => [item.hsn_code, item.barcode] };
const names = (query: string) => searchList(ITEMS, query, FIELDS).map((item) => item.name);

describe('forgiving search', () => {
  it('finds what was typed exactly as before, names starting with it first', () => {
    assert.deepEqual(names('sug'), ['Sugar 1kg']);
    assert.deepEqual(names('yeast'), ['Fresh Compressed Yeast (500 g)', 'Instant Dry Yeast (500 g)']);
    assert.deepEqual(names('ice'), ['Ice cream', 'Rice 1kg'], 'starts with it, then contains it');
    assert.deepEqual(names(''), ITEMS.map((item) => item.name), 'nothing typed: everything, in order');
  });

  it('finds the closest name for a wrong, missing, extra or swapped letter', () => {
    assert.deepEqual(names('suger'), ['Sugar 1kg'], 'wrong');
    assert.deepEqual(names('sugr'), ['Sugar 1kg'], 'missing');
    assert.deepEqual(names('suggar'), ['Sugar 1kg'], 'extra');
    assert.deepEqual(names('chcolate'), ['Dark Chocolate Compound (500 g)'], 'swapped');
    assert.deepEqual(names('condenced milk'), ['Condensed Milk (400 g)'], 'every word may have a slip');
    assert.deepEqual(names('dry yaest'), ['Instant Dry Yeast (500 g)']);
    assert.deepEqual(names('colr gel'), ['Food Colour Gel - Assorted'], 'while still typing a word');
  });

  it('allows two slips only in a long word, and none in a short one', () => {
    assert.deepEqual(names('chacolatte'), ['Dark Chocolate Compound (500 g)'], '10 letters, 2 slips');
    assert.deepEqual(names('sugra'), ['Sugar 1kg'], 'a swap is one slip');
    assert.deepEqual(names('xugor'), [], '5 letters, 2 slips');
    assert.deepEqual(names('rx'), [], 'two letters: as typed only');
  });

  it('does not add close matches when something contains the text', () => {
    // "rice" is one slip from "ice", but Rice 1kg is what was meant.
    assert.deepEqual(names('rice'), ['Rice 1kg']);
  });

  it('matches codes only as typed', () => {
    assert.deepEqual(names('8901234567890'), ['Sugar 1kg']);
    assert.deepEqual(names('8901234567891'), [], 'one digit off is another product');
    assert.deepEqual(names('1955'), ['Ice cream'], 'HSN as typed');
    assert.deepEqual(names('1956'), [], 'and not one digit off');
  });

  it('works for Kannada names and ignores case, accents and punctuation', () => {
    const kn = [{ name: 'Sugar 1kg', kn: 'ಸಕ್ಕರೆ 1 ಕೆಜಿ' }];
    assert.equal(searchList(kn, 'ಸಕ್ಕ', { names: (entry) => [entry.name, entry.kn] }).length, 1);
    assert.equal(foldText('Café  "Sri"-Ganesh'), 'cafe sri ganesh');
    assert.equal(editDistance('ganseh', 'ganesh'), 1);
    assert.equal(editDistance('abc', 'xyz', 1), 2, 'stops early past the limit');
  });
});

describe('forgiving search on the server', () => {
  let server: TestServer;
  let admin: Client;

  before(async () => {
    server = await startServer();
    admin = client(server.baseUrl);
    await admin.login('admin', ADMIN_PASSWORD);
  });
  after(async () => { await server?.stop(); });

  it('sends the closest items when nothing contains the search, and says so', async () => {
    const tag = `Zq${Date.now().toString(36)}`;
    const choc = await makeStockedItem(admin, { name: `${tag} Chocolate Compound` });
    await makeStockedItem(admin, { name: `${tag} Cocoa Powder` });

    const exact = (await admin.get(`/api/items?search=${tag}%20chocolate`)).body;
    assert.deepEqual(exact.data.map((i: any) => i.id), [choc.id]);
    assert.equal(exact.close_match, undefined);

    const slip = (await admin.get(`/api/items?search=${tag}%20chocolte&counts=1`)).body;
    assert.deepEqual(slip.data.map((i: any) => i.id), [choc.id]);
    assert.equal(slip.close_match, true);
    assert.equal(slip.total, 1);
    assert.equal(slip.counts.all_items, 1, 'the counts are of the close matches');

    const nothing = (await admin.get('/api/items?search=qqqqqqqq')).body;
    assert.equal(nothing.total, 0);
    assert.equal(nothing.close_match, undefined);
  });

  it('sends the closest customers when nothing contains the search', async () => {
    const created = await admin.post('/api/customers', { name: 'Anitha Rao', shop_name: 'Sri Ganesh Bakery', phone: '9845012345' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const slip = (await admin.get('/api/customers?search=ganseh')).body;
    assert.deepEqual(slip.data.map((c: any) => c.id), [created.body.id]);
    assert.equal(slip.close_match, true);
    const byPerson = (await admin.get('/api/customers?search=anita%20rao')).body;
    assert.deepEqual(byPerson.data.map((c: any) => c.id), [created.body.id]);
    assert.equal((await admin.get('/api/customers?search=9845012346')).body.total, 0, 'a phone one digit off is nobody');
  });
});
