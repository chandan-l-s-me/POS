/**
 * Settings that come only from a .env file, as on an installed shop, where
 * the Windows service passes no environment variables at all.
 *
 * DB_PATH in .env used to be ignored: the database module read it before the
 * server loaded .env, so the shop's data landed in the program folder, where
 * an update or uninstall would delete it.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyapara-envfile-'));
let child: ReturnType<typeof spawn> | null = null;

after(async () => {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child!.once('exit', resolve));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const freePort = () => new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as net.AddressInfo;
    server.close(() => resolve(port));
  });
});

describe('settings from a .env file only', () => {
  it('puts the database where DB_PATH in .env says', async () => {
    const port = await freePort();
    const dbPath = path.join(dir, 'data', 'shop.db');
    const envFile = path.join(dir, '.env');
    fs.writeFileSync(envFile, [
      'NODE_ENV="production"',
      'HOST="127.0.0.1"',
      `PORT="${port}"`,
      `DB_PATH='${dbPath}'`,
      `BACKUP_DIR='${path.join(dir, 'backups')}'`,
      'JWT_SECRET="env-file-test-secret-0123456789abcdef"',
      'ADMIN_INITIAL_PASSWORD="EnvFileTest2026"',
      'AUTO_BACKUP_HOURS="0"',
    ].join('\n'));

    // Nothing but the location of the .env file comes from the environment.
    const env: Record<string, string> = { DOTENV_CONFIG_PATH: envFile };
    for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', (chunk) => { output += chunk; });
    child.stderr!.on('data', (chunk) => { output += chunk; });

    const deadline = Date.now() + 40_000;
    let status = 0;
    while (Date.now() < deadline && child.exitCode === null) {
      try {
        status = (await fetch(`http://127.0.0.1:${port}/api/settings`)).status;
        if (status === 401) break;
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.equal(status, 401, `server did not start:\n${output}`);
    assert.ok(fs.existsSync(dbPath), `no database at DB_PATH (${dbPath})`);
    assert.ok(!fs.existsSync(path.join(ROOT, 'pos.db')) || fs.statSync(path.join(ROOT, 'pos.db')).mtimeMs < Date.now() - 60_000,
      'the server wrote to ./pos.db instead');

    const login = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'EnvFileTest2026' }),
    });
    assert.equal(login.status, 200, 'ADMIN_INITIAL_PASSWORD from .env was not used');
  });
});
