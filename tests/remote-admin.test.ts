/**
 * The admin set in .env (REMOTE_ADMIN_USERNAME / REMOTE_ADMIN_PASSWORD): the
 * one admin that can sign in from the internet. Every other admin still works
 * only at the shop computer. A request "from the internet" is one that came
 * through the Cloudflare tunnel, which adds CF-Connecting-IP.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, startServer, type TestServer } from './helpers.ts';

const OWNER = 'owner';
const OWNER_PASSWORD = 'Shop-Owner-Key-2026';

const login = (server: TestServer, username: string, password: string, fromInternet = true) =>
  fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fromInternet ? { 'CF-Connecting-IP': '203.0.113.60' } : {}) },
    body: JSON.stringify({ username, password }),
  }).then(async (res) => ({ status: res.status, body: await res.json() as any }));

const call = (server: TestServer, token: string, url: string, init: RequestInit = {}) =>
  fetch(`${server.baseUrl}${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.60', ...(init.headers || {}) },
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) as any }));

describe('the admin set in .env', () => {
  let server: TestServer;
  before(async () => { server = await startServer({ REMOTE_ADMIN_USERNAME: OWNER, REMOTE_ADMIN_PASSWORD: OWNER_PASSWORD }); });
  after(async () => { await server?.stop(); });

  it('signs in from the internet, and has the admin screens there', async () => {
    const res = await login(server, OWNER, OWNER_PASSWORD);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.role, 'admin');
    // Admin-only routes, from the internet.
    assert.equal((await call(server, res.body.token, '/api/users')).status, 200);
    assert.equal((await call(server, res.body.token, '/api/stock')).status, 200);
    const logs = await call(server, res.body.token, `/api/audit-logs?search=${encodeURIComponent('signed in from the internet')}`);
    assert.ok(logs.body.data.some((log: any) => log.details.includes('203.0.113.60')), 'the sign-in and where from are logged');
  });

  it('also signs in at the shop computer', async () => {
    assert.equal((await login(server, OWNER, OWNER_PASSWORD, false)).status, 200);
  });

  it('leaves every other admin at the shop computer only', async () => {
    const res = await login(server, 'admin', ADMIN_PASSWORD);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'ADMIN_LOCAL_ONLY');
  });

  it('refuses a wrong password', async () => {
    assert.equal((await login(server, OWNER, 'Shop-Owner-Key-2025')).status, 401);
  });

  it('cannot be changed, deactivated or deleted from the app', async () => {
    const local = (await login(server, 'admin', ADMIN_PASSWORD, false)).body.token;
    const localCall = (url: string, init: RequestInit) =>
      fetch(`${server.baseUrl}${url}`, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${local}` } })
        .then(async (res) => ({ status: res.status, body: await res.json() as any }));
    const users = (await localCall('/api/users', {})).body as any[];
    const owner = users.find((u) => u.username === OWNER);
    assert.equal(owner.env_managed, 1, 'the staff list marks it');

    for (const body of [{ new_password: 'Another-Pass-123' }, { is_active: false }]) {
      const res = await localCall(`/api/users/${owner.id}`, { method: 'PUT', body: JSON.stringify(body) });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /set in the \.env file/);
    }
    const deleted = await localCall(`/api/users/${owner.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 400);

    const own = (await login(server, OWNER, OWNER_PASSWORD)).body.token;
    const changed = await call(server, own, '/api/admin/account', {
      method: 'PUT', body: JSON.stringify({ current_password: OWNER_PASSWORD, new_password: 'Another-Pass-123' }),
    });
    assert.equal(changed.status, 400);
    assert.equal((await login(server, OWNER, OWNER_PASSWORD)).status, 200, 'still the .env password');
  });
});

describe('keeping the account in step with .env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vasavi-remote-admin-'));
  const dbPath = path.join(dir, 'pos.db');
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const withEnv = async (env: Record<string, string>, check: (server: TestServer) => Promise<void>) => {
    const server = await startServer({ DB_PATH: dbPath, ...env });
    try { await check(server); } finally { await server.kill(); }
  };

  it('takes a new password from .env, signing out the old sessions', async () => {
    let oldToken = '';
    await withEnv({ REMOTE_ADMIN_USERNAME: OWNER, REMOTE_ADMIN_PASSWORD: OWNER_PASSWORD }, async (server) => {
      oldToken = (await login(server, OWNER, OWNER_PASSWORD)).body.token;
    });
    await withEnv({ REMOTE_ADMIN_USERNAME: OWNER, REMOTE_ADMIN_PASSWORD: 'A-Brand-New-Key-77' }, async (server) => {
      assert.equal((await login(server, OWNER, OWNER_PASSWORD)).status, 401, 'the old password no longer works');
      assert.equal((await login(server, OWNER, 'A-Brand-New-Key-77')).status, 200);
      assert.equal((await call(server, oldToken, '/api/users')).status, 401, 'an old session is signed out');
    });
  });

  it('turns the account off when the lines are removed', async () => {
    await withEnv({}, async (server) => {
      assert.equal((await login(server, OWNER, 'A-Brand-New-Key-77')).status, 401);
    });
  });

  it('does not open with a short or demo password, or a username already taken', async () => {
    await withEnv({ REMOTE_ADMIN_USERNAME: OWNER, REMOTE_ADMIN_PASSWORD: 'short-1' }, async (server) => {
      assert.equal((await login(server, OWNER, 'short-1')).status, 401);
      assert.match(server.stderr(), /REMOTE_ADMIN_PASSWORD must be at least 12 characters/);
    });
    await withEnv({ REMOTE_ADMIN_USERNAME: 'admin', REMOTE_ADMIN_PASSWORD: 'Long-Enough-Key-1' }, async (server) => {
      // The real admin is untouched, and still only at the shop computer.
      assert.equal((await login(server, 'admin', 'Long-Enough-Key-1')).status, 401);
      assert.equal((await login(server, 'admin', ADMIN_PASSWORD)).status, 403);
      assert.match(server.stderr(), /already belongs to another account/);
    });
  });
});
