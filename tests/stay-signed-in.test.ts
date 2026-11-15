/**
 * A cashier on the phone app stays signed in across closing and reopening it.
 * On every reopen the app asks POST /api/auth/session: still allowed in gets a
 * renewed session; deactivated (or a reset password) gets 401, and the app
 * signs out.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;
let cashierId: number;

const DAY = 24 * 60 * 60;
const expiresInDays = (token: string) => {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return (payload.exp - payload.iat) / DAY;
};

const login = (username: string, password: string, stay: boolean) =>
  fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, stay_signed_in: stay }),
  }).then(async (res) => ({ status: res.status, body: await res.json() as any }));

const session = (token: string) =>
  fetch(`${server.baseUrl}/api/auth/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) as any }));

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  cashierId = (await admin.post('/api/users', { name: 'Phone Cashier', username: 'phone-cashier', password: 'phone-cashier-1', role: 'cashier' })).body.id;
});

after(async () => { await server?.stop(); });

describe('staying signed in on the phone app', () => {
  it('gives a cashier on the app a long session, and a browser a working day', async () => {
    const app = await login('phone-cashier', 'phone-cashier-1', true);
    assert.equal(app.status, 200);
    assert.equal(expiresInDays(app.body.token), 90);
    const browser = await login('phone-cashier', 'phone-cashier-1', false);
    assert.equal(expiresInDays(browser.body.token), 0.5);
  });

  it('never gives an admin a long session', async () => {
    const res = await login('admin', ADMIN_PASSWORD, true);
    assert.equal(expiresInDays(res.body.token), 0.5);
    const checked = await session(res.body.token);
    assert.equal(checked.status, 200);
    assert.equal(checked.body.token, undefined, 'nothing renewed');
  });

  it('renews the session each time the app is reopened', async () => {
    const { token } = (await login('phone-cashier', 'phone-cashier-1', true)).body;
    const res = await session(token);
    assert.equal(res.status, 200);
    assert.equal(res.body.user.username, 'phone-cashier');
    assert.equal(expiresInDays(res.body.token), 90);
    assert.equal((await session(res.body.token)).status, 200, 'the renewed token works');
  });

  it('signs out a cashier who has been deactivated, and lets them back once reactivated', async () => {
    const { token } = (await login('phone-cashier', 'phone-cashier-1', true)).body;
    assert.equal((await admin.put(`/api/users/${cashierId}`, { is_active: false })).status, 200);
    assert.equal((await session(token)).status, 401, 'the reopened app is signed out');
    assert.equal((await login('phone-cashier', 'phone-cashier-1', true)).status, 401);

    assert.equal((await admin.put(`/api/users/${cashierId}`, { is_active: true })).status, 200);
    assert.equal((await session(token)).status, 401, 'the old session stays ended');
    assert.equal((await login('phone-cashier', 'phone-cashier-1', true)).status, 200);
  });

  it('signs out a cashier whose password was reset', async () => {
    const { token } = (await login('phone-cashier', 'phone-cashier-1', true)).body;
    assert.equal((await admin.put(`/api/users/${cashierId}`, { new_password: 'phone-cashier-2' })).status, 200);
    assert.equal((await session(token)).status, 401);
  });
});
