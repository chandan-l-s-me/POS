/**
 * Test harness.
 *
 * Boots the real `server.ts` as a child process against a throwaway database
 * and talks to it over HTTP. Nothing is stubbed: the same Express app, the
 * same SQLite schema, the same middleware chain and the same read-worker pool
 * that a shop runs in production.
 *
 * A throwaway DB_PATH matters — an earlier version of this harness would have
 * pointed at the real `pos.db` and written test bills into the shop's books.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const ADMIN_PASSWORD = 'test-admin-pass-1';

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

export interface TestServer {
  baseUrl: string;
  dbPath: string;
  /** Terminate the process and delete its database directory. */
  stop: () => Promise<void>;
  /**
   * Terminate the process but leave the database on disk, so another server
   * can be started against the same file. This is how the migration tests
   * reproduce an upgrade of an existing shop's database.
   */
  kill: () => Promise<void>;
  stderr: () => string;
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vyapara-test-'));
  const dbPath = path.join(dir, 'pos.db');

  // Node with tsx as a loader, not `npx tsx`: Windows cannot spawn npx (a .cmd)
  // without a shell, and this way the server is one process that kill() stops.
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    ['--import', 'tsx', 'server.ts'],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        DB_PATH: dbPath,
        PORT: String(port),
        HOST: '127.0.0.1',
        JWT_SECRET: 'test-secret-not-used-in-production-0123456789abcdef',
        ADMIN_INITIAL_PASSWORD: ADMIN_PASSWORD,
        SEED_DEMO_DATA: '',
        // Backups of a test database belong in its temp folder, never the
        // shop's backups/; automatic ones are off unless a test turns them on.
        BACKUP_DIR: path.join(dir, 'backups'),
        AUTO_BACKUP_HOURS: '0',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ) as ChildProcessWithoutNullStreams;

  let stderr = '';
  let stdout = '';
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 40_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early (code ${child.exitCode})\n${stderr}\n${stdout}`);
    }
    try {
      // 401 is the expected answer from an authenticated route with no token:
      // it proves the process is listening and the middleware chain is wired.
      const res = await fetch(`${baseUrl}/api/settings`);
      if (res.status === 401) { ready = true; break; }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`server did not become ready\n${stderr}\n${stdout}`);
  }

  const kill = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise<void>((resolve) => child.once('exit', () => resolve())),
        new Promise<void>((resolve) => setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000)),
      ]);
    }
  };

  const stop = async () => {
    await kill();
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { baseUrl, dbPath, stop, kill, stderr: () => stderr };
}

export interface ApiResult<T = any> {
  status: number;
  body: T;
}

export function client(baseUrl: string) {
  let token: string | null = null;

  const request = async <T = any>(
    method: string,
    url: string,
    body?: unknown,
    opts: { raw?: boolean; token?: string | null } = {}
  ): Promise<ApiResult<T>> => {
    const useToken = opts.token === undefined ? token : opts.token;
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: opts.raw ? (body as string) : JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: any = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { status: res.status, body: parsed };
  };

  return {
    get raw() { return request; },
    get token() { return token; },
    setToken(next: string | null) { token = next; },
    get: <T = any>(url: string, opts?: { token?: string | null }) => request<T>('GET', url, undefined, opts),
    post: <T = any>(url: string, body?: unknown, opts?: { raw?: boolean; token?: string | null }) =>
      request<T>('POST', url, body, opts),
    put: <T = any>(url: string, body?: unknown, opts?: { token?: string | null }) =>
      request<T>('PUT', url, body, opts),
    del: <T = any>(url: string, opts?: { token?: string | null }) => request<T>('DELETE', url, undefined, opts),

    async login(username: string, password: string) {
      const res = await request<any>('POST', '/api/auth/login', { username, password }, { token: null });
      if (res.status === 200) token = res.body.token;
      return res;
    },
  };
}

export type Client = ReturnType<typeof client>;

/** Round to paise, the same way server.ts and the cart store do. */
export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------------------
// Items and stock
//
// An item can only come into existence as a new item on a saved purchase —
// there is no other way to create one. Tests that just need "an item that
// sells at ₹X with N in stock" use makeStockedItem, which buys it.

let itemSeq = 0;

/** Catalogue fields for a test item, with sensible defaults. */
export const itemFields = (overrides: Record<string, unknown> = {}) => ({
  name: `Item ${Date.now().toString(36)}-${++itemSeq}`,
  hsn_code: String(10000000 + itemSeq),
  metric: 'piece',
  is_loose: false,
  gst_applicable: true,
  gst_mode: 'split',
  gst_rate: 18,
  sgst_rate: 9,
  cgst_rate: 9,
  igst_rate: 0,
  ...overrides,
});

/**
 * The GST on a purchase line, from catalogue-style fields. A new item takes
 * its sale GST from the line it is bought on.
 */
export const lineRates = (fields: Record<string, any>) => {
  if (fields.gst_applicable === false || !Number(fields.gst_rate || fields.igst_rate || 0)) {
    return { sgst_rate: 0, cgst_rate: 0, igst_rate: 0 };
  }
  if (fields.gst_mode === 'igst') return { sgst_rate: 0, cgst_rate: 0, igst_rate: Number(fields.igst_rate || fields.gst_rate) };
  return { sgst_rate: Number(fields.sgst_rate), cgst_rate: Number(fields.cgst_rate), igst_rate: 0 };
};

/**
 * Buy a brand-new item: one purchase whose single line creates it. Returns the
 * new item's id.
 */
export async function purchaseNewItem(
  c: Client,
  fields: Record<string, any>,
  { quantity, unit_cost, selling_price, supplier_name = 'Test Supplier' }:
    { quantity: number; unit_cost: number; selling_price: number; supplier_name?: string }
) {
  const res = await c.post('/api/purchases', {
    supplier_name,
    items: [{
      new_item: { name: fields.name, hsn_code: fields.hsn_code, metric: fields.metric },
      quantity, unit_cost, selling_price, ...lineRates(fields),
    }],
  });
  if (res.status !== 201) throw new Error(`new item purchase failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.created_items[0].id as number;
}

/** Add a batch of stock to an item through a stock adjustment. */
export async function addStock(
  c: Client,
  itemId: number,
  { quantity, selling_price, unit_cost, reason = 'Test stock' }:
    { quantity: number; selling_price?: number; unit_cost?: number | null; reason?: string }
) {
  const res = await c.post(`/api/items/${itemId}/stock-adjustments`, { quantity, selling_price, unit_cost, reason });
  if (res.status !== 201) throw new Error(`addStock failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/**
 * Create an item that sells at `price` (GST-inclusive) with `stock_quantity`
 * in stock, by buying it. Any other field is a catalogue field. With a stock
 * of 0 it is bought and the unit removed again, so it exists with none left.
 */
export async function makeStockedItem(c: Client, overrides: Record<string, unknown> = {}) {
  const { price = 100, stock_quantity = 1000, unit_cost, ...catalogue } = overrides as any;
  const fields = itemFields(catalogue);
  const quantity = Number(stock_quantity);
  const id = await purchaseNewItem(c, fields, {
    quantity: quantity > 0 ? quantity : 1,
    unit_cost: unit_cost == null ? round2(Number(price) * 0.7) : Number(unit_cost),
    selling_price: Number(price),
  });
  if (!(quantity > 0)) {
    const res = await c.post(`/api/items/${id}/stock-adjustments`, { quantity: -1, reason: 'Test: start with none' });
    if (res.status !== 201) throw new Error(`emptying stock failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return { id, ...fields, price: Number(price), stock_quantity: quantity };
}
