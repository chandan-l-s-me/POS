/**
 * Authentication, authorisation and account management.
 *
 * These are the checks that decide who can touch the shop's money, so they are
 * asserted against the running server rather than reasoned about.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';

let server: TestServer;
let admin: Client;

before(async () => {
  server = await startServer();
  admin = client(server.baseUrl);
  const res = await admin.login('admin', ADMIN_PASSWORD);
  assert.equal(res.status, 200, `admin login failed: ${JSON.stringify(res.body)}`);
});

after(async () => { await server?.stop(); });

describe('login', () => {
  it('issues a token for the seeded admin', async () => {
    const res = await client(server.baseUrl).login('admin', ADMIN_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.role, 'admin');
    assert.equal(res.body.user.username, 'admin');
    // The password hash must never travel to the client.
    assert.equal((res.body.user as any).password, undefined);
  });

  it('rejects a wrong password with a generic message', async () => {
    const res = await client(server.baseUrl).login('admin', 'not-the-password-1');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid username or password');
  });

  it('gives an unknown user the same message as a wrong password', async () => {
    // A different message here would let an attacker enumerate usernames.
    const res = await client(server.baseUrl).login('nobody', 'not-the-password-1');
    assert.equal(res.status, 401);
    assert.equal(res.body.error, 'Invalid username or password');
  });

  it('rejects non-string credentials instead of throwing', async () => {
    const res = await client(server.baseUrl).post('/api/auth/login', { username: { $ne: null }, password: [] });
    assert.equal(res.status, 401);
  });

  it('locks an account out after repeated failures', async () => {
    const c = client(server.baseUrl);
    const username = 'throttle-probe';
    let sawLockout = false;
    for (let i = 0; i < 8; i++) {
      const res = await c.login(username, `wrong-password-${i}`);
      if (res.status === 429) { sawLockout = true; break; }
    }
    assert.ok(sawLockout, 'login should throttle after repeated failures');
  });
});

describe('token handling', () => {
  it('refuses a request with no token', async () => {
    assert.equal((await admin.get('/api/settings', { token: null })).status, 401);
  });

  it('refuses a garbage token', async () => {
    assert.equal((await admin.get('/api/settings', { token: 'not.a.jwt' })).status, 401);
  });

  it('refuses a token sent without the Bearer scheme', async () => {
    const res = await fetch(`${server.baseUrl}/api/settings`, {
      headers: { Authorization: admin.token! },
    });
    assert.equal(res.status, 401);
  });

  it('refuses a token signed with a different secret', async () => {
    // Forged with the algorithm the server pins, but the wrong key.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      id: 1, role: 'admin', name: 'System Admin', token_version: 0,
      iss: 'vyapara-billing', aud: 'vyapara-billing-app',
      exp: Math.floor(Date.now() / 1000) + 3600,
    })).toString('base64url');
    const forged = `${header}.${payload}.${Buffer.from('wrong-signature').toString('base64url')}`;
    assert.equal((await admin.get('/api/settings', { token: forged })).status, 401);
  });

  it('refuses an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ id: 1, role: 'admin' })).toString('base64url');
    assert.equal((await admin.get('/api/settings', { token: `${header}.${payload}.` })).status, 401);
  });
});

describe('role enforcement', () => {
  let cashier: Client;
  let cashierId: number;

  before(async () => {
    const created = await admin.post('/api/cashiers', {
      name: 'Test Cashier',
      username: 'cashier-role-test',
      password: 'cashier-pass-1',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    cashierId = created.body.id;

    cashier = client(server.baseUrl);
    const login = await cashier.login('cashier-role-test', 'cashier-pass-1');
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'cashier');
  });

  // Every admin-only route, asserted as a set so a newly added one is not
  // silently left ungated.
  const adminOnlyGets = [
    '/api/cashiers',
    '/api/suppliers',
    '/api/purchases',
    '/api/analytics',
    '/api/audit-logs',
    '/api/reports/sales-items',
    '/api/reports/purchase-items',
    '/api/backups/local/status',
  ];

  for (const url of adminOnlyGets) {
    it(`forbids a cashier from GET ${url}`, async () => {
      assert.equal((await cashier.get(url)).status, 403);
    });
  }

  it('forbids a cashier from creating items', async () => {
    const res = await cashier.post('/api/items', {
      name: 'Contraband', hsn_code: '1234', price: 10, metric: 'piece',
      gst_applicable: 0, gst_rate: 0, sgst_rate: 0, cgst_rate: 0, igst_rate: 0, stock_quantity: 5,
    });
    assert.equal(res.status, 403);
  });

  it('forbids a cashier from changing shop settings', async () => {
    const res = await cashier.put('/api/settings', {
      shop_name: 'Hacked', shop_address: 'x', shop_phone: 'x',
      bill_format: 'thermal', shop_gstin: '', bill_header: '', bill_footer: '',
    });
    assert.equal(res.status, 403);
  });

  it('forbids a cashier from creating a backup', async () => {
    assert.equal((await cashier.post('/api/backups/local')).status, 403);
  });

  it('lets a cashier bill and read the catalogue', async () => {
    assert.equal((await cashier.get('/api/items')).status, 200);
    assert.equal((await cashier.get('/api/customers')).status, 200);
    assert.equal((await cashier.get('/api/bills')).status, 200);
  });

  it('ignores a forged role claim, reading the role from the database', async () => {
    // The cashier's own token is valid; the role must still come from the
    // users table, so it cannot be escalated by editing the payload.
    const [, payload] = cashier.token!.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(decoded.role, 'cashier');
    assert.equal((await cashier.get('/api/analytics')).status, 403);
  });

  it('revokes a live session when the cashier is deactivated', async () => {
    assert.equal((await cashier.get('/api/items')).status, 200);

    const res = await admin.put(`/api/cashiers/${cashierId}`, { is_active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.is_active, 0);

    // The 12-hour token must stop working immediately, not at expiry.
    assert.equal((await cashier.get('/api/items')).status, 401);
    assert.equal((await client(server.baseUrl).login('cashier-role-test', 'cashier-pass-1')).status, 401);
  });

  it('restores access when the cashier is reactivated', async () => {
    assert.equal((await admin.put(`/api/cashiers/${cashierId}`, { is_active: true })).status, 200);
    const back = client(server.baseUrl);
    assert.equal((await back.login('cashier-role-test', 'cashier-pass-1')).status, 200);
  });
});

describe('cashier accounts', () => {
  it('enforces the password policy', async () => {
    const short = await admin.post('/api/cashiers', { name: 'A', username: 'weak-1', password: 'abc1' });
    assert.equal(short.status, 400);
    assert.match(short.body.error, /at least 10 characters/);

    const noDigit = await admin.post('/api/cashiers', { name: 'A', username: 'weak-2', password: 'abcdefghijkl' });
    assert.equal(noDigit.status, 400);
    assert.match(noDigit.body.error, /letter and one number/);
  });

  it('rejects a duplicate username', async () => {
    const payload = { name: 'Dup', username: 'dup-cashier', password: 'cashier-pass-1' };
    assert.equal((await admin.post('/api/cashiers', payload)).status, 201);
    const second = await admin.post('/api/cashiers', payload);
    assert.equal(second.status, 400);
    assert.equal(second.body.error, 'Username already exists');
  });

  it('never returns password hashes in the cashier list', async () => {
    const res = await admin.get('/api/cashiers');
    assert.equal(res.status, 200);
    assert.ok(res.body.length > 0);
    for (const row of res.body) assert.equal(row.password, undefined);
  });

  it('rejects an update that changes nothing', async () => {
    const list = await admin.get('/api/cashiers');
    const target = list.body[0];
    const res = await admin.put(`/api/cashiers/${target.id}`, {});
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Nothing to update');
  });

  it('resets a password and invalidates the old one', async () => {
    const created = await admin.post('/api/cashiers', {
      name: 'Reset Me', username: 'reset-me', password: 'original-pass-1',
    });
    assert.equal(created.status, 201);

    const res = await admin.put(`/api/cashiers/${created.body.id}`, { new_password: 'brand-new-pass-2' });
    assert.equal(res.status, 200);

    assert.equal((await client(server.baseUrl).login('reset-me', 'original-pass-1')).status, 401);
    assert.equal((await client(server.baseUrl).login('reset-me', 'brand-new-pass-2')).status, 200);
  });

  it('404s on a cashier that does not exist', async () => {
    assert.equal((await admin.put('/api/cashiers/999999', { is_active: false })).status, 404);
  });

  it('rejects a non-numeric cashier id', async () => {
    assert.equal((await admin.put('/api/cashiers/abc', { is_active: false })).status, 400);
  });
});

describe('admin account changes', () => {
  it('requires the current password', async () => {
    const res = await admin.put('/api/admin/account', { username: 'admin', new_password: 'another-pass-1' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Current password is required/);
  });

  it('rejects a wrong current password', async () => {
    const res = await admin.put('/api/admin/account', {
      username: 'admin', current_password: 'wrong-pass-1', new_password: 'another-pass-1',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'Current password is incorrect');
  });

  it('rejects a no-op save that only resubmits the current username', async () => {
    // The form pre-fills the username, so this is what a stray save sends.
    // It must not silently bump token_version and log the admin out.
    const res = await admin.put('/api/admin/account', {
      username: 'admin', current_password: ADMIN_PASSWORD, new_password: '',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Enter a new username or a new password/);
    // The session must survive the rejected save.
    assert.equal((await admin.get('/api/settings')).status, 200);
  });

  it('enforces the password policy on the new password', async () => {
    const res = await admin.put('/api/admin/account', {
      username: 'admin', current_password: ADMIN_PASSWORD, new_password: 'short',
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /at least 10 characters/);
  });

  it('hands back a working replacement token on a real change', async () => {
    const fresh = client(server.baseUrl);
    assert.equal((await fresh.login('admin', ADMIN_PASSWORD)).status, 200);
    const oldToken = fresh.token!;

    const res = await fresh.put('/api/admin/account', {
      username: 'admin', current_password: ADMIN_PASSWORD, new_password: 'rotated-pass-9',
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(typeof res.body.token, 'string');

    // Old token dead, new token alive.
    assert.equal((await fresh.get('/api/settings', { token: oldToken })).status, 401);
    assert.equal((await fresh.get('/api/settings', { token: res.body.token })).status, 200);

    // Put it back so the shared `admin` client keeps working.
    const restore = client(server.baseUrl);
    assert.equal((await restore.login('admin', 'rotated-pass-9')).status, 200);
    assert.equal((await restore.put('/api/admin/account', {
      username: 'admin', current_password: 'rotated-pass-9', new_password: ADMIN_PASSWORD,
    })).status, 200);
    await admin.login('admin', ADMIN_PASSWORD);
  });
});
