/**
 * Google Drive backups, against a stand-in for Google's sign-in and Drive
 * APIs (the server's GOOGLE_* base URLs point at it).
 *
 * Connecting must only accept a sign-in an admin started; every backup must
 * reach the Drive folder as a gzipped, working database; old automatic
 * backups there are deleted, manual ones kept; and disconnecting revokes the
 * token and forgets it.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';

// --- A stand-in for Google ----------------------------------------------------
const google = {
  uploads: [] as Array<{ name: string; parents: string[]; body: Buffer }>,
  deleted: [] as string[],
  revoked: [] as string[],
  folders: 0,
  existing: [] as Array<{ id: string; name: string }>,
};
let googleBase = '';

const fakeGoogle = http.createServer((req, res) => {
  const url = new URL(req.url!, 'http://x');
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'POST' && url.pathname === '/token') {
      const form = new URLSearchParams(body.toString());
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
        const idToken = ['x', Buffer.from(JSON.stringify({ email: 'owner@example.com' })).toString('base64url'), 'y'].join('.');
        return json(200, { access_token: 'access-1', expires_in: 3600, refresh_token: 'refresh-1', id_token: idToken });
      }
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'refresh-1') {
        return json(200, { access_token: 'access-2', expires_in: 3600 });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (req.method === 'POST' && url.pathname === '/revoke') {
      google.revoked.push(url.searchParams.get('token') || '');
      return json(200, {});
    }
    if (!/^Bearer access-/.test(req.headers.authorization || '') && !url.pathname.startsWith('/session/')) {
      return json(401, { error: { message: 'no auth' } });
    }
    if (req.method === 'POST' && url.pathname === '/drive/v3/files') {
      google.folders += 1;
      return json(200, { id: 'folder-1' });
    }
    if (req.method === 'GET' && url.pathname === '/drive/v3/files/folder-1') return json(200, { id: 'folder-1', trashed: false });
    if (req.method === 'POST' && url.pathname === '/upload/drive/v3/files') {
      const meta = JSON.parse(body.toString());
      const session = `${googleBase}/session/${encodeURIComponent(JSON.stringify(meta))}`;
      return json(200, {}, { Location: session });
    }
    if (req.method === 'PUT' && url.pathname.startsWith('/session/')) {
      const meta = JSON.parse(decodeURIComponent(url.pathname.slice('/session/'.length)));
      google.uploads.push({ name: meta.name, parents: meta.parents, body });
      return json(200, { id: `file-${google.uploads.length}` });
    }
    if (req.method === 'GET' && url.pathname === '/drive/v3/files') return json(200, { files: google.existing });
    if (req.method === 'DELETE' && url.pathname.startsWith('/drive/v3/files/')) {
      google.deleted.push(url.pathname.split('/').pop()!);
      res.writeHead(204).end();
      return;
    }
    json(404, { error: { message: `unexpected ${req.method} ${url.pathname}` } });
  });
});

let server: TestServer;
let admin: Client;
let cashier: Client;

before(async () => {
  await new Promise<void>((resolve) => fakeGoogle.listen(0, '127.0.0.1', () => resolve()));
  googleBase = `http://127.0.0.1:${(fakeGoogle.address() as AddressInfo).port}`;
  server = await startServer({
    GOOGLE_CLIENT_ID: 'client-id',
    GOOGLE_CLIENT_SECRET: 'client-secret',
    PUBLIC_URL: 'https://pos.example.in',
    GOOGLE_OAUTH_BASE: googleBase,
    GOOGLE_AUTH_URL: `${googleBase}/auth`,
    GOOGLE_API_BASE: googleBase,
  });
  admin = client(server.baseUrl);
  assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  assert.equal((await admin.post('/api/cashiers', { name: 'C', username: 'drive-cashier', password: 'cashier-pass-1' })).status, 201);
  cashier = client(server.baseUrl);
  assert.equal((await cashier.login('drive-cashier', 'cashier-pass-1')).status, 200);
});

after(async () => {
  await server?.stop();
  fakeGoogle.close();
});

/** Follow the callback as the browser would, returning where it redirects to. */
const callback = async (query: string) => {
  const res = await fetch(`${server.baseUrl}/api/backups/google/callback?${query}`, { redirect: 'manual' });
  return res.headers.get('location') || '';
};

describe('Google Drive backup', () => {
  it('is set up but not connected to start with', async () => {
    const status = (await admin.get('/api/backups/google/status')).body;
    assert.equal(status.configured, true);
    assert.equal(status.connected, false);
    assert.equal(status.redirect_uri, 'https://pos.example.in/api/backups/google/callback');
  });

  it('only accepts a sign-in an admin started', async () => {
    assert.equal((await cashier.post('/api/backups/google/connect')).status, 403);
    assert.match(await callback('code=good-code&state=made-up'), /drive=error/, 'a forged callback is refused');

    const { url } = (await admin.post('/api/backups/google/connect')).body;
    const auth = new URL(url);
    assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file openid email', 'only its own files');
    assert.equal(auth.searchParams.get('access_type'), 'offline');
    const state = auth.searchParams.get('state')!;

    assert.equal(await callback(`code=good-code&state=${state}`), '/settings?drive=connected');
    assert.match(await callback(`code=good-code&state=${state}`), /drive=error/, 'a sign-in link works once');

    const status = (await admin.get('/api/backups/google/status')).body;
    assert.equal(status.connected, true);
    assert.equal(status.email, 'owner@example.com');

    const stateFile = path.join(path.dirname(server.dbPath), 'google-drive.json');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600, 'the token file is private');
  });

  it('uploads each backup to the Drive folder as a gzipped, working database', async () => {
    google.existing = [
      { id: 'old-auto', name: 'vyaparabilling-auto-2026-01-01T00-00-00-000Z.db.gz' },
    ];
    const res = await admin.post('/api/backups/local');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.drive.uploaded, true);

    const upload = google.uploads.at(-1)!;
    assert.equal(upload.name, `${res.body.fileName}.gz`);
    assert.deepEqual(upload.parents, ['folder-1']);
    assert.equal(zlib.gunzipSync(upload.body).subarray(0, 15).toString(), 'SQLite format 3', 'a real database inside');
    assert.equal(google.folders, 1, 'the folder is made once');
    assert.deepEqual(google.deleted, ['old-auto'], 'automatic backups past their keep date are removed');

    const status = (await admin.get('/api/backups/google/status')).body;
    assert.equal(status.last_upload_file, upload.name);
    assert.equal(status.last_error, null);
  });

  it('keeps the local backup and reports it when Drive fails', async () => {
    const stateFile = path.join(path.dirname(server.dbPath), 'google-drive.json');
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...saved, refresh_token: 'revoked-elsewhere' }), { mode: 0o600 });
    // The server holds a still-valid access token for an hour, so make it refresh.
    await server.kill();
    server = await startServer({
      DB_PATH: server.dbPath,
      GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', PUBLIC_URL: 'https://pos.example.in',
      GOOGLE_OAUTH_BASE: googleBase, GOOGLE_AUTH_URL: `${googleBase}/auth`, GOOGLE_API_BASE: googleBase,
    });
    admin = client(server.baseUrl);
    assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);

    const res = await admin.post('/api/backups/local');
    assert.equal(res.status, 200, 'the local backup still succeeds');
    assert.equal(res.body.drive.uploaded, false);
    assert.match(res.body.drive.error, /Connect Google Drive again/);
    assert.match((await admin.get('/api/backups/google/status')).body.last_error, /Connect Google Drive again/);

    fs.writeFileSync(stateFile, JSON.stringify(saved), { mode: 0o600 });
  });

  it('disconnects: revokes the token and forgets it', async () => {
    assert.equal((await admin.post('/api/backups/google/disconnect')).status, 200);
    assert.ok(google.revoked.includes('refresh-1'));
    assert.equal((await admin.get('/api/backups/google/status')).body.connected, false);
    assert.ok(!fs.existsSync(path.join(path.dirname(server.dbPath), 'google-drive.json')));

    const res = await admin.post('/api/backups/local');
    assert.equal(res.body.drive, null, 'no upload once disconnected');
  });
});
