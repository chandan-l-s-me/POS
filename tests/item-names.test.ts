/**
 * Kannada item names, against a stand-in for Google Translate (the server's
 * TRANSLATE_API_BASE points at it).
 *
 * A new item gets its Kannada name in the background; renaming it gets a new
 * one; a name the admin typed is kept; with Google unreachable the item simply
 * stays English and nothing else is held up; and the names reach the app.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ADMIN_PASSWORD, client, itemFields, makeStockedItem, startServer, type Client, type TestServer } from './helpers.ts';

const DICTIONARY: Record<string, string> = {
  'Sugar 1kg': 'ಸಕ್ಕರೆ 1 ಕೆಜಿ',
  'Sugar 5kg': 'ಸಕ್ಕರೆ 5 ಕೆಜಿ',
  'Dark chocolate': 'ಡಾರ್ಕ್ ಚಾಕೊಲೇಟ್',
};

const google = { up: true, asked: [] as string[] };
let googleBase = '';

const fakeGoogle = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (url.pathname !== '/translate_a/single') { res.writeHead(404).end(); return; }
  if (!google.up) { res.writeHead(503).end('down'); return; }
  const text = url.searchParams.get('q') ?? '';
  assert.equal(url.searchParams.get('sl'), 'en');
  assert.equal(url.searchParams.get('tl'), 'kn');
  google.asked.push(text);
  const translated = DICTIONARY[text] ?? `ಕ:${text}`;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([[[translated, text, null, null, 10]], null, 'en']));
});

let server: TestServer;
let admin: Client;

const translateNow = async () => {
  const res = await admin.post('/api/items/translate');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
const kannadaNames = async () => (await admin.get('/api/items/kannada-names')).body;
const itemRow = async (id: number) =>
  (await admin.get('/api/items?withImages=1&limit=500')).body.data.find((row: any) => row.id === id);

describe('Kannada item names', () => {
  before(async () => {
    await new Promise<void>((resolve) => fakeGoogle.listen(0, '127.0.0.1', () => resolve()));
    googleBase = `http://127.0.0.1:${(fakeGoogle.address() as AddressInfo).port}`;
    server = await startServer({ TRANSLATE_ITEM_NAMES: 'on', TRANSLATE_API_BASE: googleBase });
    admin = client(server.baseUrl);
    await admin.login('admin', ADMIN_PASSWORD);
  });

  after(async () => {
    await server?.stop();
    await new Promise<void>((resolve) => fakeGoogle.close(() => resolve()));
  });

  it('gives a new item its Kannada name, and sends the app the names', async () => {
    const { id } = await makeStockedItem(admin, { name: 'Sugar 1kg' });
    const pass = await translateNow();
    assert.equal(pass.last_error, null);
    assert.equal(pass.pending, 0);
    assert.equal((await itemRow(id)).name_kn, 'ಸಕ್ಕರೆ 1 ಕೆಜಿ');
    const names = await kannadaNames();
    assert.equal(names.names['Sugar 1kg'], 'ಸಕ್ಕರೆ 1 ಕೆಜಿ');
    assert.equal(names.enabled, true);
    assert.ok(google.asked.includes('Sugar 1kg'), 'only the item name is sent');
  });

  it('translates again when the English name changes', async () => {
    const { id } = await makeStockedItem(admin, { name: 'Sugar loose pack' });
    await translateNow();
    const fields = itemFields({ name: 'Sugar 5kg' });
    const renamed = await admin.put(`/api/items/${id}`, { ...fields, hsn_code: (await itemRow(id)).hsn_code });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal((await itemRow(id)).name_kn, null, 'the old translation no longer fits');
    await translateNow();
    assert.equal((await itemRow(id)).name_kn, 'ಸಕ್ಕರೆ 5 ಕೆಜಿ');
  });

  it('keeps a Kannada name the admin typed, and blank means translate again', async () => {
    const { id } = await makeStockedItem(admin, { name: 'Dark chocolate' });
    await translateNow();
    const row = await itemRow(id);
    const typed = await admin.put(`/api/items/${id}`, { ...itemFields({ name: row.name }), hsn_code: row.hsn_code, name_kn: 'ಕಪ್ಪು ಚಾಕೊಲೇಟ್' });
    assert.equal(typed.status, 200, JSON.stringify(typed.body));
    await translateNow();
    assert.equal((await itemRow(id)).name_kn, 'ಕಪ್ಪು ಚಾಕೊಲೇಟ್', 'a typed name is not overwritten');

    // Saving the form again without touching the Kannada name keeps it.
    await admin.put(`/api/items/${id}`, { ...itemFields({ name: row.name }), hsn_code: row.hsn_code });
    assert.equal((await itemRow(id)).name_kn, 'ಕಪ್ಪು ಚಾಕೊಲೇಟ್');

    await admin.put(`/api/items/${id}`, { ...itemFields({ name: row.name }), hsn_code: row.hsn_code, name_kn: '' });
    await translateNow();
    assert.equal((await itemRow(id)).name_kn, 'ಡಾರ್ಕ್ ಚಾಕೊಲೇಟ್');
  });

  it('leaves the name in English while Google is unreachable, and catches up later', async () => {
    google.up = false;
    try {
      const { id } = await makeStockedItem(admin, { name: 'Cardamom 50g' });
      const pass = await translateNow();
      assert.match(pass.last_error, /503/);
      assert.equal(pass.pending, 1);
      assert.equal((await itemRow(id)).name_kn, null);
      // Selling it is not held up.
      const bill = await admin.post('/api/bills', { items: [{ id, quantity: 1 }], payment_method: 'cash' });
      assert.equal(bill.status, 200, JSON.stringify(bill.body));
      google.up = true;
      const retry = await translateNow();
      assert.equal(retry.last_error, null);
      assert.equal((await itemRow(id)).name_kn, 'ಕ:Cardamom 50g');
    } finally {
      google.up = true;
    }
  });

  it('lets a cashier read the names but not start a translation', async () => {
    const created = await admin.post('/api/users', { name: 'Kannada Cashier', username: 'kn-cashier', password: 'kn-cashier-1', role: 'cashier' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const cashier = client(server.baseUrl);
    await cashier.login('kn-cashier', 'kn-cashier-1');
    assert.equal((await cashier.get('/api/items/kannada-names')).status, 200);
    assert.equal((await cashier.post('/api/items/translate')).status, 403);
    assert.equal((await client(server.baseUrl).get('/api/items/kannada-names')).status, 401);
  });
});

describe('Kannada item names, turned off', () => {
  let offServer: TestServer;
  let offAdmin: Client;

  before(async () => {
    // The harness default: TRANSLATE_ITEM_NAMES=off.
    offServer = await startServer({ TRANSLATE_API_BASE: 'http://127.0.0.1:9' });
    offAdmin = client(offServer.baseUrl);
    await offAdmin.login('admin', ADMIN_PASSWORD);
  });

  after(async () => { await offServer?.stop(); });

  it('never calls out, and says it is off', async () => {
    await makeStockedItem(offAdmin, { name: 'Ghee 1L' });
    const pass = (await offAdmin.post('/api/items/translate')).body;
    assert.equal(pass.enabled, false);
    assert.equal(pass.translated, 0);
    assert.equal(pass.last_error, null);
    assert.deepEqual((await offAdmin.get('/api/items/kannada-names')).body.names, {});
  });
});
