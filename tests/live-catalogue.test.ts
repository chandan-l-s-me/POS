/**
 * The tills' live copy of the catalogue: GET /api/items/changes returns every
 * item changed on another computer — bought, repriced, sold, edited, given
 * bulk prices, deleted — and nothing else, and the store merges it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, addStock, client, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';
import { useDataStore } from '../src/store/useDataStore.ts';
import type { Item } from '../src/types.ts';

let server: TestServer;
let admin: Client;
let cashier: Client;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  await admin.post('/api/users', { name: 'Live Cashier', username: 'live-cashier', password: 'live-cashier-1', role: 'cashier' });
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('live-cashier', 'live-cashier-1')).status, 200);
});

after(async () => { await server?.stop(); });

/** What the cashier's till is up to, then what changed after it. */
const seqNow = async () => (await cashier.get('/api/items/changes')).body.seq as number;
const changesSince = async (since: number) => {
  const res = await cashier.get(`/api/items/changes?since=${since}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body as { seq: number; reset?: boolean; items: any[]; deleted: number[] };
};

describe('GET /api/items/changes', () => {
  it('gives where things are up to, and the item list says the same', async () => {
    const seq = await seqNow();
    assert.equal(typeof seq, 'number');
    assert.equal((await cashier.get('/api/items?limit=5')).body.seq, seq);
    const none = await changesSince(seq);
    assert.deepEqual([none.items, none.deleted, none.reset], [[], [], undefined], 'nothing changed');
  });

  it('reports a new item, a price change and a sale — only the item touched', async () => {
    const other = await makeStockedItem(admin, { name: 'Untouched Item', price: 10 });
    let seq = await seqNow();

    const oil = await makeStockedItem(admin, { name: 'Coconut Oil 500ml', price: 99, stock_quantity: 12 });
    let changes = await changesSince(seq);
    assert.deepEqual(changes.items.map((i) => i.name), ['Coconut Oil 500ml'], 'a new item');
    assert.equal(changes.items[0].price, 99);
    assert.deepEqual(changes.items[0].bulk_prices, [], 'with the same fields as the list');
    seq = changes.seq;

    const batch = (await admin.get(`/api/items/${oil.id}/batches`)).body.data[0];
    await admin.put(`/api/stock-batches/${batch.id}`, { selling_price: 105 });
    changes = await changesSince(seq);
    assert.deepEqual(changes.items.map((i) => [i.id, i.price]), [[oil.id, 105]], 'a new price');
    seq = changes.seq;

    await cashier.post('/api/bills', { items: [{ id: oil.id, quantity: 5 }], payment_method: 'cash' });
    changes = await changesSince(seq);
    assert.deepEqual(changes.items.map((i) => [i.id, i.stock_quantity]), [[oil.id, 7]], 'stock after a sale on another till');
    assert.ok(!changes.items.some((i) => i.id === other.id));
    seq = changes.seq;

    await addStock(admin, oil.id, { quantity: 3, reason: 'Found in the back' });
    assert.deepEqual((await changesSince(seq)).items.map((i) => [i.id, i.stock_quantity]), [[oil.id, 10]], 'a stock adjustment');
  });

  it('reports an edit and a change of bulk prices', async () => {
    const item = await makeStockedItem(admin, { name: 'Rename Me', price: 50 });
    let seq = await seqNow();
    const now = (await admin.get(`/api/items/${item.id}/batches`)).body.item;
    await admin.put(`/api/items/${item.id}`, { ...now, name: 'Renamed Item' });
    let changes = await changesSince(seq);
    assert.deepEqual(changes.items.map((i) => i.name), ['Renamed Item']);
    seq = changes.seq;

    await admin.put(`/api/items/${item.id}/bulk-prices`, { bulk_prices: [{ min_quantity: 10, price: 45 }] });
    changes = await changesSince(seq);
    assert.deepEqual(changes.items.map((i) => [i.id, i.bulk_prices]), [[item.id, [{ min_quantity: 10, price: 45 }]]]);
  });

  it('says to reload the whole list after a restore to an earlier point', async () => {
    const res = await changesSince((await seqNow()) + 1000);
    assert.equal(res.reset, true);
  });

  it('refuses a since that is not a number, and needs a sign-in', async () => {
    assert.equal((await cashier.get('/api/items/changes?since=abc')).status, 400);
    assert.equal((await fetch(`${server.baseUrl}/api/items/changes?since=0`)).status, 401);
  });
});

describe('merging changes into the till’s copy', () => {
  const item = (id: number, name: string, price = 10) => ({ id, name, price, stock_quantity: 5 } as unknown as Item);

  it('replaces changed items, adds new ones in name order, and drops deleted ones', () => {
    useDataStore.setState({ items: [item(1, 'Atta'), item(2, 'Biscuit'), item(3, 'Rice')], itemsComplete: true, itemsSeq: 10 });
    useDataStore.getState().applyItemChanges({ seq: 14, items: [item(2, 'Biscuit', 12), item(4, 'Jaggery')], deleted: [3] });
    const state = useDataStore.getState();
    assert.deepEqual(state.items.map((i) => [i.id, i.name, i.price]), [[1, 'Atta', 10], [2, 'Biscuit', 12], [4, 'Jaggery', 10]]);
    assert.equal(state.itemsSeq, 14);
    assert.equal(state.itemsComplete, true);
  });
});
