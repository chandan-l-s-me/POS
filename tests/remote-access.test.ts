/**
 * Running behind a Cloudflare Tunnel, and automatic backups.
 *
 * Through a tunnel every request reaches the app from 127.0.0.1 (cloudflared),
 * with the visitor's real address in CF-Connecting-IP. Sign-in throttling must
 * use that address — otherwise one stranger guessing passwords would lock the
 * whole shop out — and remote guessing must never lock out the counter.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { ADMIN_PASSWORD, client, startServer, type TestServer } from './helpers.ts';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

let server: TestServer;

/** Sign in as if through the tunnel from `visitorIp`, or locally when it is null. */
const login = async (username: string, password: string, visitorIp: string | null = null) => {
  const res = await fetch(`${server.baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(visitorIp ? { 'CF-Connecting-IP': visitorIp } : {}) },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};

before(async () => {
  server = await startServer();
  const admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  for (const username of ['visitor-a', 'many-ips', 'demo-user']) {
    assert.equal((await admin.post('/api/cashiers', { name: username, username, password: 'right-pass-123' })).status, 201);
  }
});

after(async () => { await server?.stop(); });

describe('sign-in through the tunnel', () => {
  it('locks out the guessing visitor, not everyone else', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await login('visitor-a', 'wrong-pass-1', '203.0.113.10')).status, 401);
    assert.equal((await login('visitor-a', 'right-pass-123', '203.0.113.10')).status, 429, 'the guesser is locked out');
    assert.equal((await login('visitor-a', 'right-pass-123', '198.51.100.7')).status, 200, 'another visitor is not');
    assert.equal((await login('visitor-a', 'right-pass-123')).status, 200, 'nor is the counter');
  });

  it('caps guessing spread over many addresses, without locking the counter', async () => {
    for (let i = 0; i < 20; i++) {
      assert.equal((await login('many-ips', 'wrong-pass-1', `192.0.2.${i + 1}`)).status, 401);
    }
    const remote = await login('many-ips', 'right-pass-123', '192.0.2.200');
    assert.equal(remote.status, 429, 'the account is locked for remote sign-in');
    assert.equal((await login('many-ips', 'right-pass-123')).status, 200, 'the counter can still sign in');
  });

  it('refuses a published demo password from outside, but not at the counter', async () => {
    const db = new Database(server.dbPath);
    try {
      db.prepare('UPDATE users SET password = ? WHERE username = ?').run(bcrypt.hashSync('DemoPriya2026', 4), 'demo-user');
    } finally {
      db.close();
    }
    const remote = await login('demo-user', 'DemoPriya2026', '203.0.113.50');
    assert.equal(remote.status, 403);
    assert.equal(remote.body.code, 'DEMO_PASSWORD');
    assert.equal((await login('demo-user', 'DemoPriya2026')).status, 200, 'allowed locally, so it can be changed');
  });

  it('never lets a demo password be set', async () => {
    const admin = client(server.baseUrl);
    assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
    const res = await admin.post('/api/cashiers', { name: 'x', username: 'demo-again', password: 'DemoArun2026' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /demo password/);
  });
});

describe('development mode', () => {
  it('refuses tunnel traffic so the dev server is never exposed', async () => {
    const dev = await startServer({ NODE_ENV: 'development' });
    try {
      const viaTunnel = await fetch(`${dev.baseUrl}/`, { headers: { 'CF-Connecting-IP': '203.0.113.9' } });
      assert.equal(viaTunnel.status, 503);
      const local = await fetch(`${dev.baseUrl}/api/settings`);
      assert.equal(local.status, 401, 'local use is unaffected');
    } finally {
      await dev.stop();
    }
  });
});

describe('automatic backups', () => {
  it('backs up on schedule, copies to the second folder, and prunes old automatic ones only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyapara-backups-'));
    const backupDir = path.join(dir, 'main');
    const copyDir = path.join(dir, 'copy');
    fs.mkdirSync(backupDir);
    const old = Date.now() / 1000 - 40 * 24 * 60 * 60;
    for (const name of ['vyaparabilling-auto-old.db', 'vyaparabilling-backup-old-manual.db']) {
      fs.writeFileSync(path.join(backupDir, name), 'old');
      fs.utimesSync(path.join(backupDir, name), old, old);
    }

    const scheduled = await startServer({
      BACKUP_DIR: backupDir, BACKUP_COPY_DIR: copyDir, AUTO_BACKUP_HOURS: '24', AUTO_BACKUP_FIRST_DELAY_SECONDS: '1',
    });
    try {
      const admin = client(scheduled.baseUrl);
      assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
      const isFresh = (name: string) => name.startsWith('vyaparabilling-auto-') && name !== 'vyaparabilling-auto-old.db';
      for (let i = 0; i < 40 && !fs.readdirSync(backupDir).some(isFresh); i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 300)); // let the copy and prune finish
      const status = (await admin.get('/api/backups/local/status')).body;
      assert.ok(Date.now() - Date.parse(status.last_auto_backup_at) < 60_000, 'an automatic backup was taken just now');
      assert.equal(status.copy_directory, copyDir);

      const main = fs.readdirSync(backupDir);
      const fresh = main.find(isFresh);
      assert.ok(fresh, 'the new backup is in the backup folder');
      assert.ok(fs.readdirSync(copyDir).includes(fresh!), 'and copied to the second folder');
      assert.ok(!main.includes('vyaparabilling-auto-old.db'), 'an automatic backup past BACKUP_KEEP_DAYS is removed');
      assert.ok(main.includes('vyaparabilling-backup-old-manual.db'), 'a manual backup is never removed');

      const restored = new Database(path.join(backupDir, fresh!), { readonly: true });
      try {
        assert.ok((restored.prepare("SELECT COUNT(*) AS c FROM users WHERE username = 'admin'").get() as any).c === 1, 'the backup is a working database');
      } finally {
        restored.close();
      }
    } finally {
      await scheduled.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
