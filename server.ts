// First, before any other import: imported modules run before this file's own
// code, and db/index.ts reads DB_PATH as it loads. When .env was loaded later
// in this file, DB_PATH (and anything else read at import time) from .env was
// ignored and the database was always ./pos.db in whatever folder the server
// started in. See tests/env-file.test.ts.
import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import db, { dbPath, initDb, syncItemStock } from './db/index';
import { createGoogleDrive } from './server/googleDrive';
import { readPool } from './db/asyncRead';
// The same arithmetic the till runs, so the screen and the ledger cannot
// disagree. See src/lib/billMath.ts.
import {
  allocateFifo,
  computeLine,
  lineGstRates,
  priceSegments,
  profitPercentFromSellingPrice,
  round2,
  round3,
  saleGstRate,
} from './src/lib/billMath';
import { isLooseUnit, UNIT_VALUES } from './src/lib/units';


// BigInt serialization fix
(BigInt.prototype as any).toJSON = function () {
  return Number(this);
};

// Extend Express Request interface
declare global {
  namespace Express {
    interface Request {
      user?: any;
    }
  }
}

const app = express();
const PORT = Number(process.env.PORT) || 3000;
// Bind to loopback by default. The previous 0.0.0.0 bind published the till —
// with no TLS — to every device on the shop's network (and to the internet
// behind a typical router with UPnP), so bearer tokens and passwords crossed
// the wire in cleartext. Set HOST=0.0.0.0 deliberately, and only behind a
// reverse proxy that terminates HTTPS.
const HOST = process.env.HOST || '127.0.0.1';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Never fall back to a hardcoded secret — it would be visible to anyone
// who has this source code, letting them forge admin tokens. If JWT_SECRET
// isn't set, generate a random one for this process instead. This is fine
// for local dev; in production, JWT_SECRET must be set in the environment
// so sessions survive restarts.
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be set in production. Set it in your environment/.env file.');
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[security] JWT_SECRET not set — using a random secret for this run. All existing sessions will be invalidated on restart. Set JWT_SECRET in your .env file to avoid this.');
}
const JWT_EXPIRY = '12h';
// Pinning these means a token minted for a different purpose (or with a
// tampered `alg` header) is rejected outright rather than merely unverified.
const JWT_ALGORITHM = 'HS256' as const;
const JWT_ISSUER = 'vyapara-billing';
const JWT_AUDIENCE = 'vyapara-billing-app';

app.disable('x-powered-by');

// Baseline security headers. Hand-rolled rather than pulling in helmet so the
// dependency surface of a till that handles money stays small.
app.use((_req, res, next) => {
  // The app loads no third-party scripts, fonts, or frames.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // Vite's dev client needs inline/eval; production serves static bundles.
      IS_PRODUCTION
        ? "script-src 'self'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'" + (IS_PRODUCTION ? '' : ' ws: wss:'),
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  // Never let a browser or proxy cache an API response containing sales data.
  if (_req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  if (IS_PRODUCTION) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// The development server (Vite in middleware mode) serves source files and has
// had file-read vulnerabilities; it must never be reachable from the internet.
// If a request arrives through the tunnel while not in production mode, refuse
// it rather than expose the dev server.
app.use((req, res, next) => {
  if (!IS_PRODUCTION && req.headers['cf-connecting-ip'] && isLoopback(req.socket.remoteAddress)) {
    res.status(503).type('text/plain').send('This app is running in development mode and cannot be used remotely. Start it with npm start (NODE_ENV=production).');
    return;
  }
  next();
});

// Cap request bodies. Without a limit, a single crafted request with a
// multi-megabyte items array can pin the event loop and stall every till.
app.use(express.json({ limit: '512kb' }));

// --- Input validation helpers ---
//
// Every one of these exists because `req.body` is attacker-controlled. Passing
// a non-string to better-sqlite3 throws a TypeError that used to escape as an
// unhandled 500, and passing a NaN/negative number straight into a money or
// stock column silently corrupts the books.

const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_LENGTH = 200;
const MAX_TEXT_LENGTH = 500;

class ValidationError extends Error {
  status = 400;
  /** Optional machine-readable reason the client can act on. */
  code?: string;
}

/**
 * The request was fine but the world moved underneath it — e.g. a bill priced
 * on the till from batches another sale has since used up. The client should
 * refresh and let the cashier confirm, not just retry.
 */
class ConflictError extends ValidationError {
  status = 409;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

const fail = (message: string): never => {
  throw new ValidationError(message);
};

/** Required, non-empty, length-capped string. */
const reqString = (value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string => {
  if (typeof value !== 'string') fail(`${field} must be text`);
  const trimmed = (value as string).trim();
  if (!trimmed) fail(`${field} is required`);
  if (trimmed.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return trimmed;
};

/** Optional string; empty/absent becomes null so it lands cleanly in SQLite. */
const optString = (value: unknown, field: string, maxLength = MAX_TEXT_LENGTH): string | null => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') fail(`${field} must be text`);
  const trimmed = (value as string).trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return trimmed;
};

/**
 * Finite number in [min, max]. Rejects NaN, Infinity, numeric strings that
 * aren't actually numeric, booleans, arrays and objects — all of which
 * `Number(x)` would have happily coerced into a value written to the ledger.
 */
const num = (
  value: unknown,
  field: string,
  { min = -Infinity, max = Infinity, fallback }: { min?: number; max?: number; fallback?: number } = {}
): number => {
  if ((value == null || value === '') && fallback !== undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') fail(`${field} must be a number`);
  const parsed = typeof value === 'number' ? value : Number((value as string).trim());
  if (!Number.isFinite(parsed)) fail(`${field} must be a valid number`);
  if (parsed < min) fail(`${field} must be at least ${min}`);
  if (parsed > max) fail(`${field} must be at most ${max}`);
  return parsed;
};

/** Positive integer row id. Rejects "1 OR 1=1", "abc", 1.5, -1, etc. */
const rowId = (value: unknown, field = 'id'): number => {
  const parsed = num(value, field, { min: 1, max: Number.MAX_SAFE_INTEGER });
  if (!Number.isInteger(parsed)) fail(`${field} must be a whole number`);
  return parsed;
};

const optRowId = (value: unknown, field: string): number | null =>
  value == null || value === '' ? null : rowId(value, field);

const bool = (value: unknown) => (value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0);

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T => {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
};

/**
 * A shop till is a high-value target for anyone who gets on the network, and
 * a short password is guessable in seconds. Enforce a floor rather than
 * accepting whatever the form submits.
 */
const validatePassword = (value: unknown, field: string): string => {
  if (typeof value !== 'string') fail(`${field} must be text`);
  const password = value as string;
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`${field} must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    // bcrypt only reads the first 72 bytes; a huge input is pure CPU burn.
    fail(`${field} must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    fail(`${field} must contain at least one letter and one number`);
  }
  if (isKnownDemoPassword(password)) {
    fail(`${field} is a published demo password. Choose a different one.`);
  }
  return password;
};

/**
 * Passwords written in scripts/seed-demo.ts, which is in the public source.
 * An account still using one is effectively passwordless to anyone who has
 * read the repository, so such a login is refused from the internet (see
 * POST /api/auth/login) and the passwords can never be set again.
 */
const KNOWN_DEMO_PASSWORDS = new Set(['DemoAdmin2026', 'DemoPriya2026', 'DemoArun2026']);
const isKnownDemoPassword = (password: string) => KNOWN_DEMO_PASSWORDS.has(password);

/**
 * Pagination for list endpoints. Unbounded list routes are both a scalability
 * problem and a denial-of-service vector: at a few lakh bills a week, one
 * request for the full bills table serialises hundreds of MB of JSON and pins
 * the process for every other till.
 */
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1000;

const readPaging = (req: express.Request) => ({
  limit: Math.min(num(req.query.limit, 'limit', { min: 1, max: MAX_PAGE_SIZE, fallback: DEFAULT_PAGE_SIZE }), MAX_PAGE_SIZE),
  offset: num(req.query.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
});

/** Optional YYYY-MM-DD filter, used to keep report queries bounded. */
const optDate = (value: unknown, field: string): string | null => {
  const raw = optString(value, field, 10);
  if (raw === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) fail(`${field} must be in YYYY-MM-DD format`);
  return raw;
};

// --- Login throttling ---
//
// Without this, the login route is an unlimited password oracle: an attacker
// on the shop wi-fi can try every 4-digit PIN in well under a second. Track
// failures per username and per source IP, and make each one progressively
// more expensive.
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

type LoginAttempt = { count: number; firstAttemptAt: number; lockedUntil: number };
const loginAttempts = new Map<string, LoginAttempt>();

// --- Where a request came from ---
//
// Remote access is through a Cloudflare Tunnel: `cloudflared` runs on this
// machine and connects to the app over loopback, so every remote request
// arrives from 127.0.0.1. Cloudflare puts the visitor's real address in
// CF-Connecting-IP (overwriting any value the visitor sent). That header is
// believed only when the connection itself is from loopback — i.e. from
// cloudflared — so a device on the shop network cannot spoof it.
const isLoopback = (address: string | undefined) =>
  !!address && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1');

const tunnelVisitorIp = (req: express.Request): string | null => {
  if (!isLoopback(req.socket.remoteAddress)) return null;
  const header = req.headers['cf-connecting-ip'];
  const value = Array.isArray(header) ? header[0] : header;
  return value && value.trim() ? value.trim() : null;
};

/** The address to attribute a request to: the visitor behind the tunnel, or the direct peer. */
const clientIp = (req: express.Request) => tunnelVisitorIp(req) ?? req.socket.remoteAddress ?? 'unknown';

/**
 * Whether the request came from outside this machine: through the tunnel, or
 * from another device on the network. The counter on this laptop is local.
 */
const isRemoteRequest = (req: express.Request) =>
  tunnelVisitorIp(req) !== null || !isLoopback(req.socket.remoteAddress);

const throttleKey = (req: express.Request, username: string) =>
  `${clientIp(req)}::${username.toLowerCase()}`;

// Per-address throttling alone does not stop a password being guessed from
// many addresses at once. Remote failures for one account are also counted
// together, and past this many the account cannot be signed into remotely for
// LOGIN_LOCKOUT_MS. Sign-in at the counter is never affected, so an attacker
// cannot lock the shop out of its own till.
const REMOTE_ACCOUNT_MAX_FAILURES = 20;
const remoteAccountKey = (username: string) => `remote-account::${username.toLowerCase()}`;

const getLockout = (key: string): number => {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  const now = Date.now();
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  // Window elapsed with no lockout — forget the old failures.
  if (now - entry.firstAttemptAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
};

const recordLoginFailure = (key: string, maxAttempts = LOGIN_MAX_ATTEMPTS) => {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= maxAttempts) {
    console.warn(`[security] sign-in locked for ${LOGIN_LOCKOUT_MS / 60000} min after repeated failures: ${key}`);
    entry.lockedUntil = now + LOGIN_LOCKOUT_MS;
    entry.count = 0;
    entry.firstAttemptAt = now;
  }
};

const clearLoginFailures = (key: string) => loginAttempts.delete(key);

// Bound the map so a rotating-username flood can't exhaust memory.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (entry.lockedUntil < now && now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(key);
    }
  }
}, LOGIN_WINDOW_MS).unref();

/**
 * Audit log retention.
 *
 * The table grows at roughly one row per bill and was never pruned, so at a
 * few lakh transactions a week it becomes the largest table in the database
 * and every Logs query pages through it forever. Keep a bounded window; GST
 * records live in `bills`/`bill_items`, not here.
 */
const AUDIT_LOG_RETENTION_DAYS = Number(process.env.AUDIT_LOG_RETENTION_DAYS) || 400;

const pruneAuditLogs = () => {
  try {
    const result = db.prepare(
      `DELETE FROM audit_logs WHERE created_at < datetime('now', ?)`
    ).run(`-${AUDIT_LOG_RETENTION_DAYS} days`);
    if (result.changes > 0) {
      console.log(`[maintenance] pruned ${result.changes} audit log row(s) older than ${AUDIT_LOG_RETENTION_DAYS} days`);
    }
  } catch (err: any) {
    console.error('[maintenance] audit log prune failed:', err.message);
  }
};

// Initialize DB
initDb();

const BCRYPT_ROUNDS = 12;

// Seed exactly one admin, once, on an empty database.
//
// This previously hardcoded `admin / 0210` and `cashier / cashier123`. Those
// passwords are in the source, so anyone who can reach the port owns the
// shop's books — and the seeded cashier account existed on every install
// whether or not the shop had a second user. Now the initial password comes
// from ADMIN_INITIAL_PASSWORD, or is randomly generated and printed once.
const seedInitialAdmin = () => {
  const existingAdmin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (existingAdmin) return;

  const configured = process.env.ADMIN_INITIAL_PASSWORD;
  if (configured && configured.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_INITIAL_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (configured && isKnownDemoPassword(configured)) {
    throw new Error('ADMIN_INITIAL_PASSWORD is a published demo password. Choose a different one.');
  }
  // 24 base64url chars ~= 144 bits of entropy; not guessable, not brute-forceable.
  const initialPassword = configured || crypto.randomBytes(18).toString('base64url');

  db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)')
    .run('admin', bcrypt.hashSync(initialPassword, BCRYPT_ROUNDS), 'admin', 'System Admin');

  if (configured) {
    console.log('[setup] Admin account created with the password from ADMIN_INITIAL_PASSWORD.');
  } else {
    console.log('\n=======================================================');
    console.log(' Admin account created.');
    console.log(' Username: admin');
    console.log(` Password: ${initialPassword}`);
    console.log(' This is shown ONCE. Save it, then change it in Settings.');
    console.log('=======================================================\n');
  }
};
seedInitialAdmin();

pruneAuditLogs();
// Sweep daily so a long-running till doesn't accumulate a year of rows.
setInterval(pruneAuditLogs, 24 * 60 * 60 * 1000).unref();

const writeAuditLog = (params: {
  user: { id: number; name: string; role: string };
  action: string;
  entityType: string;
  entityId?: string | number | null;
  details: string;
}) => {
  db.prepare(`
    INSERT INTO audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, details)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.user.id,
    params.user.name,
    params.user.role,
    params.action,
    params.entityType,
    params.entityId == null ? null : String(params.entityId),
    params.details
  );
};

/**
 * Move a customer's credit balance and record why, as one atomic step.
 *
 * Every path that changes what a customer owes goes through here — a credit
 * sale, an opening balance, a repayment, an admin correction — so the ledger
 * can never drift from `customers.credit_balance`. Changing the balance with a
 * bare UPDATE somewhere else would silently reintroduce exactly the gap this
 * table exists to close.
 *
 * `delta` is signed: positive means the customer owes more.
 * MUST be called inside a db.transaction().
 */
const recordCreditChange = (params: {
  customerId: number;
  delta: number;
  entryType: 'opening' | 'sale' | 'payment' | 'adjustment';
  note?: string | null;
  billId?: number | null;
  user: { id: number; name: string };
}) => {
  const row = db.prepare('SELECT credit_balance FROM customers WHERE id = ?').get(params.customerId) as any;
  if (!row) throw new ValidationError('Customer not found');

  const before = round2(row.credit_balance || 0);
  const after = round2(before + params.delta);
  // A negative outstanding balance would mean the shop owes the customer,
  // which this app has no concept of; every caller bounds its input, so
  // reaching here is a bug rather than bad user input.
  if (after < 0) {
    throw new ValidationError('That change would take the customer’s balance below zero.');
  }

  db.prepare('UPDATE customers SET credit_balance = ? WHERE id = ?').run(after, params.customerId);
  db.prepare(`
    INSERT INTO customer_credit_entries
      (customer_id, bill_id, entry_type, amount, balance_before, balance_after, note, user_id, user_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.customerId,
    params.billId ?? null,
    params.entryType,
    round2(params.delta),
    before,
    after,
    params.note ?? null,
    params.user.id,
    params.user.name
  );

  return { before, after };
};

const upsertSupplier = (params: {
  name: string;
  phone?: string;
  address?: string;
  gstin?: string;
}) => {
  const trimmedName = String(params.name || '').trim();
  if (!trimmedName) return null;

  const existingSupplier = db.prepare(`
    SELECT *
    FROM suppliers
    WHERE lower(name) = lower(?)
  `).get(trimmedName) as any;

  if (existingSupplier) {
    const nextPhone = params.phone?.trim() || existingSupplier.phone || null;
    const nextAddress = params.address?.trim() || existingSupplier.address || null;
    const nextGstin = params.gstin?.trim() || existingSupplier.gstin || null;

    db.prepare(`
      UPDATE suppliers
      SET name = ?, phone = ?, address = ?, gstin = ?
      WHERE id = ?
    `).run(trimmedName, nextPhone, nextAddress, nextGstin, existingSupplier.id);

    return existingSupplier.id;
  }

  const result = db.prepare(`
    INSERT INTO suppliers (name, phone, address, gstin)
    VALUES (?, ?, ?, ?)
  `).run(
    trimmedName,
    params.phone?.trim() || null,
    params.address?.trim() || null,
    params.gstin?.trim() || null
  );

  return Number(result.lastInsertRowid);
};

/**
 * Allocate the next sequential document number for the day.
 *
 * The previous implementation derived the number from a second-granularity
 * timestamp. Two bills rung up in the same second produced the same string and
 * the second one died on the UNIQUE constraint — the sale was simply lost. At
 * a few lakh transactions a week with more than one till, that is a matter of
 * when, not if. This bumps a counter row, and because it runs inside the
 * caller's write transaction the increment is atomic.
 *
 * MUST be called inside a db.transaction().
 */
const nextDocumentNumber = (prefix: 'INV' | 'PUR') => {
  const { year, month, day } = getISTDateParts();
  const dateKey = `${day}${month}${year}`;
  const scope = `${prefix}:${dateKey}`;

  db.prepare('INSERT OR IGNORE INTO document_counters (scope, last_value) VALUES (?, 0)').run(scope);
  const row = db.prepare(
    'UPDATE document_counters SET last_value = last_value + 1 WHERE scope = ? RETURNING last_value'
  ).get(scope) as any;

  return `${prefix}-${dateKey}-${String(row.last_value).padStart(5, '0')}`;
};

const getISTDateParts = () => {
  const now = new Date();
  const istDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const year = istDate.getFullYear();
  const month = String(istDate.getMonth() + 1).padStart(2, '0');
  const day = String(istDate.getDate()).padStart(2, '0');

  return {
    year,
    month,
    day,
    today: `${year}-${month}-${day}`,
    startOfMonth: `${year}-${month}-01`,
  };
};

/**
 * Snapshot the database to a file.
 *
 * This used to build a JSON document by running `SELECT *` over every table
 * into JavaScript arrays and then `JSON.stringify`-ing the result. At 1.27M
 * bills that allocated ~4 GB of heap and killed the process outright:
 *
 *   POST /api/backups/local -> 22.7s -> FATAL ERROR: heap out of memory
 *
 * An admin pressing "Backup" took the whole shop offline. SQLite's VACUUM INTO
 * writes a fully-formed, transactionally-consistent copy of the database
 * straight to disk. It streams inside SQLite, so JS heap use is constant
 * regardless of table size, and the output is a real .db file that can be
 * opened or restored directly rather than a JSON blob nothing can read back.
 */
//
// Where backups go: BACKUP_DIR, or backups/ in the app folder. Automatic
// backups run every AUTO_BACKUP_HOURS (default 24; 0 turns them off) and are
// kept for BACKUP_KEEP_DAYS (default 30); manual ones are never deleted.
// BACKUP_COPY_DIR, if set, gets a copy of every backup — point it at a USB
// drive or a cloud-synced folder so a dead laptop disk does not take the
// books with it. Only the finished backup file is copied there, never the
// live database, which a sync client could corrupt mid-write.
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'));
const BACKUP_COPY_DIR = process.env.BACKUP_COPY_DIR ? path.resolve(process.env.BACKUP_COPY_DIR) : null;
const AUTO_BACKUP_HOURS = process.env.AUTO_BACKUP_HOURS === undefined ? 24 : Math.max(0, Number(process.env.AUTO_BACKUP_HOURS) || 0);
const BACKUP_KEEP_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 30);
const MANUAL_BACKUP_PREFIX = 'vyaparabilling-backup-';
const AUTO_BACKUP_PREFIX = 'vyaparabilling-auto-';

// Google Drive (server/googleDrive.ts). Set up with GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET and PUBLIC_URL; connected once from Settings. The
// connection is kept in google-drive.json beside the database.
const googleDrive = createGoogleDrive({
  stateFile: path.join(path.dirname(dbPath), 'google-drive.json'),
  publicUrl: process.env.PUBLIC_URL || null,
});

/** Upload a backup to Google Drive if connected, and tidy old automatic ones there. */
const sendBackupToDrive = async (filePath: string) => {
  if (!googleDrive.isConnected()) return null;
  const uploaded = await googleDrive.uploadBackup(filePath);
  await googleDrive.pruneBackups(BACKUP_KEEP_DAYS, AUTO_BACKUP_PREFIX).catch((err) => {
    console.error('[backup] could not tidy old Google Drive backups:', err.message);
  });
  return uploaded;
};

const createLocalBackup = (kind: 'manual' | 'auto' = 'manual') => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `${kind === 'auto' ? AUTO_BACKUP_PREFIX : MANUAL_BACKUP_PREFIX}${timestamp}.db`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true, mode: 0o700 });
  const filePath = path.join(BACKUP_DIR, fileName);

  // VACUUM INTO refuses to overwrite, so a stale partial file must go first.
  fs.rmSync(filePath, { force: true });
  db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);

  // 0600: backups hold every customer's name, phone, address, GSTIN and
  // outstanding balance. Only the account running the server should read them.
  fs.chmodSync(filePath, 0o600);

  // The off-machine copy is best effort: a missing USB drive must not make
  // the backup itself fail.
  let copiedTo: string | null = null;
  if (BACKUP_COPY_DIR) {
    try {
      fs.mkdirSync(BACKUP_COPY_DIR, { recursive: true });
      copiedTo = path.join(BACKUP_COPY_DIR, fileName);
      fs.copyFileSync(filePath, copiedTo);
    } catch (err: any) {
      copiedTo = null;
      console.error(`[backup] could not copy ${fileName} to ${BACKUP_COPY_DIR}: ${err.message}`);
    }
  }

  return { fileName, filePath, sizeBytes: fs.statSync(filePath).size, copiedTo };
};

/** Backup files in a folder, newest first. */
const listBackups = (directory: string) => {
  try {
    return fs.readdirSync(directory)
      .filter((name) => name.endsWith('.db') && (name.startsWith(MANUAL_BACKUP_PREFIX) || name.startsWith(AUTO_BACKUP_PREFIX)))
      .map((name) => ({ name, path: path.join(directory, name), at: fs.statSync(path.join(directory, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
};

/** Delete automatic backups past BACKUP_KEEP_DAYS, here and in the copy folder. */
const pruneAutoBackups = () => {
  const cutoff = Date.now() - BACKUP_KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const directory of [BACKUP_DIR, BACKUP_COPY_DIR].filter(Boolean) as string[]) {
    for (const file of listBackups(directory)) {
      if (file.name.startsWith(AUTO_BACKUP_PREFIX) && file.at < cutoff) {
        try { fs.rmSync(file.path, { force: true }); } catch { /* next sweep */ }
      }
    }
  }
};

/** Take an automatic backup if the last one is older than AUTO_BACKUP_HOURS. */
const runAutoBackupIfDue = () => {
  if (AUTO_BACKUP_HOURS <= 0) return;
  const lastAuto = listBackups(BACKUP_DIR).find((file) => file.name.startsWith(AUTO_BACKUP_PREFIX));
  if (lastAuto && Date.now() - lastAuto.at < AUTO_BACKUP_HOURS * 60 * 60 * 1000) return;
  try {
    const result = createLocalBackup('auto');
    console.log(`[backup] automatic backup ${result.fileName}${result.copiedTo ? `, copied to ${BACKUP_COPY_DIR}` : ''}`);
    pruneAutoBackups();
    sendBackupToDrive(result.filePath)
      .then((uploaded) => uploaded && console.log(`[backup] uploaded ${uploaded.name} to Google Drive`))
      .catch((err) => console.error('[backup] Google Drive upload failed:', err.message));
  } catch (err: any) {
    console.error('[backup] automatic backup failed:', err.message);
  }
};

// Middleware for auth
const authenticateToken = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers['authorization'];
  const [scheme, token] = (authHeader || '').split(' ');

  if (!token || scheme !== 'Bearer') return res.sendStatus(401);

  let payload: any;
  try {
    payload = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  } catch {
    // Return 401 (not 403) for invalid/expired tokens too, so the frontend's
    // existing "logout on 401" handling kicks in and sends the user back to
    // the login screen instead of getting stuck on a silent failure.
    return res.sendStatus(401);
  }

  // Re-read the user on every request. A token is a 12-hour bearer credential;
  // without this check, a cashier who was deactivated — or whose password was
  // changed after a compromise — keeps full access until it expires. The role
  // also comes from the database, not the token, so a stale or tampered role
  // claim can never grant admin.
  const user = db.prepare(
    'SELECT id, username, role, name, token_version, is_active FROM users WHERE id = ?'
  ).get(payload.id) as any;

  if (!user || !user.is_active) return res.sendStatus(401);
  if (Number(payload.token_version ?? 0) !== Number(user.token_version)) return res.sendStatus(401);

  req.user = { id: user.id, username: user.username, role: user.role, name: user.name };
  next();
};

/**
 * Admin-only gate. Previously every privileged route repeated
 * `if (req.user.role !== 'admin') return res.sendStatus(403)` inline, which is
 * exactly the kind of check that gets forgotten on a newly added route.
 */
const requireAdmin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.user?.role !== 'admin') return res.sendStatus(403);
  next();
};

const issueToken = (user: { id: number; role: string; name: string; token_version: number }) =>
  jwt.sign(
    { id: user.id, role: user.role, name: user.name, token_version: user.token_version },
    JWT_SECRET,
    {
      expiresIn: JWT_EXPIRY,
      algorithm: JWT_ALGORITHM,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }
  );

/** Wraps an async/throwing handler so validation errors become clean JSON. */
const route =
  (handler: (req: express.Request, res: express.Response) => void | Promise<void>) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const result = handler(req, res);
      if (result instanceof Promise) result.catch(next);
    } catch (err) {
      next(err);
    }
  };

// --- Auth Routes ---

// A real bcrypt hash of a value nobody knows, compared against when the
// username doesn't exist. Without it, a missing user returns in microseconds
// while a real user costs ~100ms of bcrypt — a timing gap that lets an
// attacker enumerate valid usernames before attacking a password.
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS);

app.post('/api/auth/login', route((req, res) => {
  // Reject non-string credentials before they reach bcrypt or SQLite.
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';

  if (!username || !password || username.length > MAX_TEXT_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  const remote = isRemoteRequest(req);
  const key = throttleKey(req, username);
  const lockedForMs = Math.max(getLockout(key), remote ? getLockout(remoteAccountKey(username)) : 0);
  if (lockedForMs > 0) {
    res.status(429).json({
      error: `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedForMs / 60000)} minute(s).`,
    });
    return;
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as any;
  const passwordMatches = bcrypt.compareSync(password, user?.password || DUMMY_PASSWORD_HASH);

  if (!user || !user.is_active || !passwordMatches) {
    recordLoginFailure(key);
    if (remote) recordLoginFailure(remoteAccountKey(username), REMOTE_ACCOUNT_MAX_FAILURES);
    // One generic message for every failure mode: wrong user, wrong password,
    // deactivated account. Anything more specific is free reconnaissance.
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }

  // The right password, but one anyone can read in the source. Allowed at the
  // counter so the owner can sign in and change it; refused from outside.
  if (remote && isKnownDemoPassword(password)) {
    console.warn(`[security] refused remote sign-in to ${user.username} with a published demo password from ${clientIp(req)}`);
    res.status(403).json({
      error: 'This account still uses the demo password, so it cannot be used remotely. Sign in at the shop counter and change the password in Settings first.',
      code: 'DEMO_PASSWORD',
    });
    return;
  }

  clearLoginFailures(key);
  const token = issueToken(user);
  writeAuditLog({
    user,
    action: 'login',
    entityType: 'auth',
    entityId: user.id,
    details: `${user.username} signed in`,
  });
  res.json({ token, user: { id: user.id, username: user.username, role: user.role, name: user.name } });
}));

// --- Settings Routes ---
app.get('/api/settings', authenticateToken, (_req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  res.json(settings);
});

app.get('/api/backups/local/status', authenticateToken, requireAdmin, (_req, res) => {
  const backups = listBackups(BACKUP_DIR);
  const lastAuto = backups.find((file) => file.name.startsWith(AUTO_BACKUP_PREFIX));
  res.json({
    configured: true,
    backup_directory: BACKUP_DIR,
    copy_directory: BACKUP_COPY_DIR,
    auto_backup_hours: AUTO_BACKUP_HOURS,
    keep_days: BACKUP_KEEP_DAYS,
    backup_count: backups.length,
    last_backup_at: backups[0] ? new Date(backups[0].at).toISOString() : null,
    last_backup_file: backups[0]?.name ?? null,
    last_auto_backup_at: lastAuto ? new Date(lastAuto.at).toISOString() : null,
  });
});

app.put('/api/settings', authenticateToken, requireAdmin, route((req, res) => {
  const shop_name = reqString(req.body?.shop_name, 'Shop name', 200);
  const shop_address = reqString(req.body?.shop_address, 'Shop address', 500);
  const shop_phone = reqString(req.body?.shop_phone, 'Shop phone', 50);
  const shop_gstin = optString(req.body?.shop_gstin, 'Shop GSTIN', 20) || '';
  const bill_format = oneOf(req.body?.bill_format, ['thermal', 'standard'] as const, 'Bill format');
  const bill_header = optString(req.body?.bill_header, 'Bill header', 500) || '';
  const bill_footer = optString(req.body?.bill_footer, 'Bill footer', 500) || '';

  db.prepare(`
    UPDATE settings
    SET shop_name = ?,
        shop_address = ?,
        shop_phone = ?,
        shop_gstin = ?,
        bill_format = ?,
        bill_header = ?,
        bill_footer = ?
    WHERE id = 1
  `).run(
    shop_name,
    shop_address,
    shop_phone,
    shop_gstin,
    bill_format,
    bill_header,
    bill_footer
  );

  const updatedSettings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'settings',
    entityId: 1,
    details: `Updated shop settings for ${shop_name}`,
  });
  res.json(updatedSettings);
}));

app.put('/api/admin/account', authenticateToken, requireAdmin, route((req, res) => {
  const trimmedUsername = optString(req.body?.username, 'Username', 100) || '';
  const hasNewPassword = typeof req.body?.new_password === 'string' && req.body.new_password.length > 0;

  if (typeof req.body?.current_password !== 'string' || !req.body.current_password) {
    res.status(400).json({ error: 'Current password is required' });
    return;
  }
  const current_password = req.body.current_password;

  if (!trimmedUsername && !hasNewPassword) {
    res.status(400).json({ error: 'Enter a new username or password to update' });
    return;
  }

  const adminUser = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id) as any;
  if (!adminUser) {
    res.status(404).json({ error: 'Admin account not found' });
    return;
  }

  // Throttle this too: it is a second password oracle for the admin account.
  const key = throttleKey(req, `account:${adminUser.username}`);
  const lockedForMs = getLockout(key);
  if (lockedForMs > 0) {
    res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(lockedForMs / 60000)} minute(s).`,
    });
    return;
  }

  if (!bcrypt.compareSync(current_password, adminUser.password)) {
    recordLoginFailure(key);
    res.status(400).json({ error: 'Current password is incorrect' });
    return;
  }
  clearLoginFailures(key);

  // Enforce the password policy on the new password, not just on creation.
  const newPassword = hasNewPassword ? validatePassword(req.body.new_password, 'New password') : null;

  // Work out what genuinely changes. The username field is pre-filled with the
  // current username, so a password-only save still submits it — treating that
  // as a "change" made every no-op save bump token_version below, which killed
  // the caller's session and reported success while changing nothing.
  const usernameChanged = Boolean(trimmedUsername) && trimmedUsername !== adminUser.username;

  if (!usernameChanged && !newPassword) {
    res.status(400).json({ error: 'Enter a new username or a new password to update.' });
    return;
  }

  if (usernameChanged) {
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmedUsername, req.user.id) as any;
    if (existingUser) {
      res.status(400).json({ error: 'Username already exists' });
      return;
    }
  }

  const nextUsername = usernameChanged ? trimmedUsername : adminUser.username;
  const nextPassword = newPassword ? bcrypt.hashSync(newPassword, BCRYPT_ROUNDS) : adminUser.password;

  // Bump token_version so every token issued under the old credentials stops
  // working immediately. Changing your password after a suspected compromise
  // is worthless if the attacker's existing session keeps running for 12h.
  db.prepare(`
    UPDATE users
    SET username = ?, password = ?, token_version = token_version + 1
    WHERE id = ?
  `).run(nextUsername, nextPassword, req.user.id);

  const updatedUser = db.prepare(`
    SELECT id, username, role, name, token_version
    FROM users
    WHERE id = ?
  `).get(req.user.id) as any;

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'admin_account',
    entityId: req.user.id,
    details:
      'Updated admin account: ' +
      [newPassword ? 'password changed' : null, usernameChanged ? `username changed to ${nextUsername}` : null]
        .filter(Boolean)
        .join(', '),
  });

  // Hand back a fresh token so the admin isn't logged out by their own change.
  res.json({
    user: { id: updatedUser.id, username: updatedUser.username, role: updatedUser.role, name: updatedUser.name },
    token: issueToken(updatedUser),
  });
}));

app.post('/api/backups/local', authenticateToken, requireAdmin, async (req, res) => {
  let result: ReturnType<typeof createLocalBackup>;
  try {
    result = createLocalBackup();
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create local backup' });
    return;
  }
  // The local backup is done whatever happens with Drive; report both.
  let drive: { uploaded: boolean; name?: string; error?: string } | null = null;
  if (googleDrive.isConnected()) {
    try {
      const uploaded = await sendBackupToDrive(result.filePath);
      drive = { uploaded: true, name: uploaded?.name };
    } catch (err: any) {
      drive = { uploaded: false, error: err.message || 'Upload failed' };
    }
  }
  writeAuditLog({
    user: req.user,
    action: 'backup',
    entityType: 'system',
    entityId: result.fileName,
    details: `Created local backup ${result.fileName}` +
      (drive ? (drive.uploaded ? '; uploaded to Google Drive' : `; Google Drive upload failed: ${drive.error}`) : ''),
  });
  res.json({ success: true, ...result, drive });
});

// --- Google Drive backups ---

app.get('/api/backups/google/status', authenticateToken, requireAdmin, (_req, res) => {
  res.json(googleDrive.status());
});

/** Start connecting: the browser is sent to Google to sign in and allow access. */
app.post('/api/backups/google/connect', authenticateToken, requireAdmin, route((_req, res) => {
  if (!googleDrive.configured) {
    fail('Google Drive is not set up on the server yet. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and PUBLIC_URL to .env and restart.');
  }
  res.json({ url: googleDrive.authorizationUrl() });
}));

/**
 * Where Google sends the browser back. Not behind the app's sign-in (it is a
 * plain redirect, with no bearer token); it is trusted only with the one-time
 * `state` an admin's connect request created moments before.
 */
app.get('/api/backups/google/callback', async (req, res) => {
  const back = (query: string) => res.redirect(`/settings?${query}`);
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (req.query.error) return back(`drive=error&reason=${encodeURIComponent(String(req.query.error))}`);
  if (!code || !state) return back('drive=error&reason=missing_code');
  try {
    const connected = await googleDrive.completeConnection(code, state);
    console.log(`[backup] Google Drive connected${connected.email ? ` (${connected.email})` : ''}`);
    return back('drive=connected');
  } catch (err: any) {
    console.error('[backup] Google Drive connection failed:', err.message);
    return back(`drive=error&reason=${encodeURIComponent(err.message || 'failed')}`);
  }
});

app.post('/api/backups/google/disconnect', authenticateToken, requireAdmin, route(async (req, res) => {
  const email = googleDrive.status().email;
  await googleDrive.disconnect();
  writeAuditLog({
    user: req.user, action: 'update', entityType: 'system', entityId: 'google-drive',
    details: `Disconnected Google Drive backups${email ? ` (${email})` : ''}`,
  });
  res.json({ success: true });
}));

// --- Staff Accounts ---
//
// Admins and cashiers alike. The role is chosen when an account is created and
// never changes afterwards: promoting a cashier means a new admin account, so
// the audit log always says plainly who could do what when.

const STAFF_COLUMNS = 'id, username, role, name, is_active';
type StaffRole = 'admin' | 'cashier';

const readStaff = (id: number | bigint) =>
  db.prepare(`SELECT ${STAFF_COLUMNS} FROM users WHERE id = ?`).get(id);

const createStaffAccount = (req: express.Request, role: StaffRole) => {
  const name = reqString(req.body?.name, 'Name', 100);
  const username = reqString(req.body?.username, 'Username', 100);
  const password = validatePassword(req.body?.password, 'Password');

  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) fail('Username already exists');

  const result = db.prepare('INSERT INTO users (username, password, role, name) VALUES (?, ?, ?, ?)')
    .run(username, bcrypt.hashSync(password, BCRYPT_ROUNDS), role, name);
  const account = readStaff(result.lastInsertRowid) as any;

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: role,
    entityId: account.id,
    details: `Created ${role} account ${username} (${name})`,
  });
  return account;
};

/**
 * Deactivate or reactivate an account, and reset its password.
 *
 * Deactivating (rather than deleting) keeps the bills the person rang up,
 * which the foreign key requires and GST records demand. Nobody can deactivate
 * their own account, so the shop cannot lock itself out of admin. An admin's
 * own password is changed under My account, which asks for the current one.
 */
const updateStaffAccount = (req: express.Request, account: any) => {
  const isSelf = account.id === req.user.id;
  const changes: string[] = [];
  let nextActive = account.is_active;
  let nextPassword = account.password;
  let bumpTokenVersion = false;

  if (req.body?.is_active !== undefined) {
    nextActive = bool(req.body.is_active);
    if (nextActive !== account.is_active) {
      if (!nextActive) {
        // Only an active admin gets this far, so refusing their own account is
        // also what guarantees an active admin always remains.
        if (isSelf) fail('You cannot deactivate your own account.');
        // Revoke any live session the moment the account is disabled.
        bumpTokenVersion = true;
      }
      changes.push(nextActive ? 'reactivated' : 'deactivated');
    }
  }

  if (req.body?.new_password !== undefined && req.body.new_password !== '') {
    if (isSelf) fail('Change your own password under My account.');
    nextPassword = bcrypt.hashSync(validatePassword(req.body.new_password, 'New password'), BCRYPT_ROUNDS);
    changes.push('password reset');
    bumpTokenVersion = true;
  }

  if (changes.length === 0) fail('Nothing to update');

  db.prepare(`
    UPDATE users
    SET is_active = ?, password = ?, token_version = token_version + ?
    WHERE id = ?
  `).run(nextActive, nextPassword, bumpTokenVersion ? 1 : 0, account.id);

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: account.role,
    entityId: account.id,
    details: `${account.role === 'admin' ? 'Admin' : 'Cashier'} ${account.username}: ${changes.join(', ')}`,
  });
  return readStaff(account.id);
};

const staffRole = (value: unknown): StaffRole => {
  if (value !== 'admin' && value !== 'cashier') fail('Choose a role: admin or cashier.');
  return value as StaffRole;
};

/**
 * Every record that names the person who made it. An account that appears in
 * any of these is part of the shop's books and can only be deactivated;
 * deleting it would orphan its bills, purchases and audit trail.
 */
const USER_REFERENCES: Array<[table: string, column: string]> = [
  ['bills', 'user_id'],
  ['purchases', 'user_id'],
  ['audit_logs', 'user_id'],
  ['customer_credit_entries', 'user_id'],
  ['stock_adjustments', 'user_id'],
  ['supplier_payments', 'user_id'],
  ['print_jobs', 'requested_by'],
];
const userInUseSql = (idExpression: string) =>
  USER_REFERENCES.map(([table, column]) => `EXISTS (SELECT 1 FROM ${table} WHERE ${column} = ${idExpression})`).join(' OR ');

app.get('/api/users', authenticateToken, requireAdmin, (_req, res) => {
  // Admins first, then by name; deactivated accounts last within each.
  res.json(db.prepare(`
    SELECT ${STAFF_COLUMNS}, (${userInUseSql('users.id')}) AS in_use FROM users
    ORDER BY role = 'admin' DESC, is_active DESC, name COLLATE NOCASE ASC
  `).all());
});

/**
 * Delete an account that was never used: a typo, or someone who never started.
 * Once a person has signed in (which the audit log records), billed or bought,
 * their name is on the shop's records, so they are deactivated instead.
 */
app.delete('/api/users/:id', authenticateToken, requireAdmin, route((req, res) => {
  const account = db.prepare('SELECT * FROM users WHERE id = ?').get(rowId(req.params.id)) as any;
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  if (account.id === req.user.id) fail('You cannot delete your own account.');

  db.transaction(() => {
    const { in_use } = db.prepare(`SELECT (${userInUseSql('?')}) AS in_use`)
      .get(...USER_REFERENCES.map(() => account.id)) as { in_use: number };
    if (in_use) {
      const err = new ValidationError(
        `${account.name} has already used the app (signed in, billed or similar), so the account is part of the shop's records and cannot be deleted. Deactivate it instead: they can no longer sign in, and their records are kept.`
      );
      err.code = 'ACCOUNT_IN_USE';
      err.status = 409;
      throw err;
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(account.id);
    writeAuditLog({
      user: req.user,
      action: 'delete',
      entityType: account.role,
      entityId: account.id,
      details: `Deleted unused ${account.role} account ${account.username} (${account.name})`,
    });
  })();

  res.json({ success: true });
}));

app.post('/api/users', authenticateToken, requireAdmin, route((req, res) => {
  // No default: whoever creates the account has to say which it is.
  const role = staffRole(req.body?.role);
  res.status(201).json(createStaffAccount(req, role));
}));

app.put('/api/users/:id', authenticateToken, requireAdmin, route((req, res) => {
  const account = db.prepare('SELECT * FROM users WHERE id = ?').get(rowId(req.params.id));
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  res.json(updateStaffAccount(req, account));
}));

// The cashier-only routes the app used before admins could be created here.
// Kept so older callers keep working; they cannot see or touch admin accounts.
app.get('/api/cashiers', authenticateToken, requireAdmin, (_req, res) => {
  res.json(db.prepare(`SELECT ${STAFF_COLUMNS} FROM users WHERE role = 'cashier' ORDER BY name ASC`).all());
});

app.post('/api/cashiers', authenticateToken, requireAdmin, route((req, res) => {
  res.status(201).json(createStaffAccount(req, 'cashier'));
}));

app.put('/api/cashiers/:id', authenticateToken, requireAdmin, route((req, res) => {
  const cashier = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'cashier'").get(rowId(req.params.id));
  if (!cashier) {
    res.status(404).json({ error: 'Cashier not found' });
    return;
  }
  res.json(updateStaffAccount(req, cashier));
}));

// --- Audit Log Routes ---
app.get('/api/audit-logs', authenticateToken, requireAdmin, route(async (req, res) => {
  const { limit, offset } = readPaging(req);
  const search = optString(req.query.search, 'search', 100);

  const where = search
    ? 'WHERE user_name LIKE ? OR action LIKE ? OR entity_type LIKE ? OR details LIKE ?'
    : '';
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`] : [];

  const [logs, countRow] = await Promise.all([
    readPool.all(`
      SELECT * FROM audit_logs ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset]),
    readPool.get(`SELECT COUNT(*) as total FROM audit_logs ${where}`, params),
  ]);

  res.json({ data: logs, total: countRow?.total ?? 0, limit, offset });
}));

// --- Item Routes ---
// Columns the billing/scanning screens actually need. `SELECT *` also shipped
// image_url (an arbitrary-length URL), barcode and created_at to every client
// on every page load — dead weight in the payload and, for image_url,
// unbounded. The Items admin screen asks for the full row via ?withImages=1.
const ITEM_LIST_COLUMNS =
  'id, name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity, default_profit_percent';

app.get('/api/items', authenticateToken, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const search = optString(req.query.search, 'search', 100);
  const withImages = req.query.withImages === '1';
  const columns = withImages ? '*' : ITEM_LIST_COLUMNS;

  const where = search ? 'WHERE name LIKE ? OR hsn_code LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`] : [];

  const items = db.prepare(`
    SELECT ${columns} FROM items ${where} ORDER BY name ASC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM items ${where}`).get(...params) as any;

  res.json({ data: items, total, limit, offset });
}));

/**
 * Shared validation for item writes: the catalogue details only.
 *
 * Price and stock are deliberately not here. Stock is held in batches, each
 * with its own selling price, and only moves through a purchase, a sale or a
 * stock adjustment with a reason — so it always adds up and every change can
 * be traced. Letting this form set them, as it used to, meant anyone editing
 * an item's name could also rewrite its stock count with no record at all.
 * Rates are bounded: a >100% rate produced a negative taxable base, which
 * flowed straight into GST filings.
 */
const readItemPayload = (body: any) => ({
  name: reqString(body?.name, 'Item name', 200),
  hsn_code: reqString(body?.hsn_code, 'HSN code', 20),
  metric: reqString(body?.metric, 'Metric', 20),
  is_loose: bool(body?.is_loose),
  gst_applicable: bool(body?.gst_applicable),
  gst_mode: oneOf(body?.gst_mode ?? 'split', ['split', 'igst'] as const, 'GST mode'),
  gst_rate: num(body?.gst_rate, 'GST rate', { min: 0, max: 100, fallback: 0 }),
  sgst_rate: num(body?.sgst_rate, 'SGST rate', { min: 0, max: 100, fallback: 0 }),
  cgst_rate: num(body?.cgst_rate, 'CGST rate', { min: 0, max: 100, fallback: 0 }),
  igst_rate: num(body?.igst_rate, 'IGST rate', { min: 0, max: 100, fallback: 0 }),
  image_url: optString(body?.image_url, 'Image URL', 2000),
});

// There is deliberately no POST /api/items. An item comes into existence only
// as a line of a saved purchase (see POST /api/purchases), so every item in
// the catalogue was bought, has a cost and a selling price, and has stock that
// can be traced back to a supplier. A standalone create used to leave items
// with no purchase, no stock and no price whenever a purchase was abandoned
// after its "new item" popup had already saved.

app.put('/api/items/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const item = readItemPayload(req.body);
  if (item.sgst_rate + item.cgst_rate > 100) fail('SGST + CGST cannot exceed 100%');

  const existingItem = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as any;
  if (!existingItem) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  db.prepare(`
    UPDATE items SET name = ?, hsn_code = ?, metric = ?, is_loose = ?, gst_applicable = ?, gst_mode = ?, gst_rate = ?, sgst_rate = ?, cgst_rate = ?, igst_rate = ?, image_url = ?
    WHERE id = ?
  `).run(item.name, item.hsn_code, item.metric, item.is_loose, item.gst_applicable, item.gst_mode, item.gst_rate, item.sgst_rate, item.cgst_rate, item.igst_rate, item.image_url, id);

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'item',
    entityId: id,
    details: `Updated item ${existingItem.name} to ${item.name}`,
  });
  res.json({ success: true });
}));

app.delete('/api/items/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const existingItem = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as any;
  if (!existingItem) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  // An item referenced by a past bill cannot be deleted without orphaning
  // that bill's line items (and breaking every historical GST report).
  const { referenced } = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM bill_items WHERE item_id = ?)
      + (SELECT COUNT(*) FROM purchase_items WHERE item_id = ?) AS referenced
  `).get(id, id) as any;

  if (referenced > 0) {
    res.status(409).json({
      error: 'This item appears on existing bills or purchases and cannot be deleted. Adjust its stock to 0 instead.',
    });
    return;
  }

  // Stock added by hand (with no purchase or sale behind it) goes with the item.
  db.transaction(() => {
    db.prepare('DELETE FROM stock_adjustments WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM stock_batches WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  })();
  writeAuditLog({
    user: req.user,
    action: 'delete',
    entityType: 'item',
    entityId: id,
    details: `Deleted item ${existingItem.name}`,
  });
  res.json({ success: true });
}));

// --- Stock: batches, adjustments, repricing ---

/**
 * An item's stock, batch by batch, in the order it will be sold.
 *
 * Billing calls this when an item goes into the cart, to price it FIFO. By
 * default only batches with stock left; `?all=1` includes sold-out ones.
 * Purchase cost and margin are shown to admins only — a cashier needs the
 * selling price, not the shop's margins.
 */
app.get('/api/items/:id/batches', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const item = db.prepare(`SELECT ${ITEM_LIST_COLUMNS} FROM items WHERE id = ?`).get(id) as any;
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  const includeSoldOut = req.query.all === '1';
  const isAdmin = req.user.role === 'admin';
  const gstRate = saleGstRate(item);

  const batches = (db.prepare(`
    SELECT b.id, b.source, b.received_at, b.quantity_received, b.quantity_remaining,
           b.unit_cost, b.selling_price, b.purchase_id,
           p.purchase_number, p.supplier_name, p.invoice_number
    FROM stock_batches b
    LEFT JOIN purchases p ON p.id = b.purchase_id
    WHERE b.item_id = ? ${includeSoldOut ? '' : 'AND b.quantity_remaining > 0'}
    ORDER BY b.received_at ASC, b.id ASC
  `).all(id) as any[]).map((batch) => {
    if (!isAdmin) {
      const { unit_cost: _cost, ...visible } = batch;
      return visible;
    }
    return { ...batch, profit_percent: profitPercentFromSellingPrice(batch.unit_cost, batch.selling_price, gstRate) };
  });

  res.json({ item, data: batches });
}));

/**
 * Change stock by hand, with a reason: damage, expiry, a recount, stock that
 * was already on the shelf before the app.
 *
 *   quantity < 0  takes from the oldest batches first, exactly as a sale would.
 *   quantity > 0  adds a new batch; cost and selling price default to the
 *                 item's most recent batch.
 *
 * This replaces typing a new stock figure into the item form, which left no
 * trace of what changed, by how much, or why.
 */
app.post('/api/items/:id/stock-adjustments', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const quantity = round3(num(req.body?.quantity, 'Quantity', { min: -1_000_000, max: 1_000_000 }));
  if (quantity === 0) fail('Enter a quantity to add or remove');
  const reason = reqString(req.body?.reason, 'Reason', 300);
  const requestedCost = req.body?.unit_cost == null || req.body?.unit_cost === ''
    ? undefined
    : round2(num(req.body.unit_cost, 'Unit cost', { min: 0, max: 10_000_000 }));
  const requestedPrice = req.body?.selling_price == null || req.body?.selling_price === ''
    ? undefined
    : round2(num(req.body.selling_price, 'Selling price', { min: 0.01, max: 10_000_000 }));

  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as any;
  if (!item) {
    res.status(404).json({ error: 'Item not found' });
    return;
  }

  const recordAdjustment = db.prepare(`
    INSERT INTO stock_adjustments (item_id, batch_id, quantity, reason, user_id, user_name)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const apply = db.transaction(() => {
    if (quantity < 0) {
      const batches = db.prepare(`
        SELECT id, quantity_remaining, selling_price FROM stock_batches
        WHERE item_id = ? AND quantity_remaining > 0 ORDER BY received_at ASC, id ASC
      `).all(id) as any[];
      const { allocations, shortfall } = allocateFifo(batches, -quantity);
      if (shortfall > 0) {
        throw new ValidationError(`Only ${round3(-quantity - shortfall)} ${item.metric} of ${item.name} in stock to remove`);
      }
      const drawDown = db.prepare(
        'UPDATE stock_batches SET quantity_remaining = ROUND(quantity_remaining - ?, 3) WHERE id = ?'
      );
      for (const allocation of allocations) {
        drawDown.run(allocation.quantity, allocation.batch_id);
        recordAdjustment.run(id, allocation.batch_id, -allocation.quantity, reason, req.user.id, req.user.name);
      }
    } else {
      const latest = db.prepare(`
        SELECT unit_cost, selling_price FROM stock_batches WHERE item_id = ? ORDER BY received_at DESC, id DESC LIMIT 1
      `).get(id) as any;
      const sellingPrice = requestedPrice ?? latest?.selling_price;
      if (sellingPrice == null) {
        throw new ValidationError(`${item.name} has never been purchased, so enter the selling price for this stock`);
      }
      const unitCost = requestedCost !== undefined ? requestedCost : (latest?.unit_cost ?? null);
      const batch = db.prepare(`
        INSERT INTO stock_batches (item_id, source, quantity_received, quantity_remaining, unit_cost, selling_price)
        VALUES (?, 'adjustment', ?, ?, ?, ?)
      `).run(id, quantity, quantity, unitCost, sellingPrice);
      recordAdjustment.run(id, Number(batch.lastInsertRowid), quantity, reason, req.user.id, req.user.name);
    }
    syncItemStock(id);
    return db.prepare('SELECT stock_quantity, price FROM items WHERE id = ?').get(id) as any;
  });

  const after = apply();
  analyticsCache = null; // low-stock panel
  writeAuditLog({
    user: req.user,
    action: 'stock_adjustment',
    entityType: 'item',
    entityId: id,
    details: `Stock of ${item.name} ${quantity > 0 ? 'increased' : 'reduced'} by ${Math.abs(quantity)} ${item.metric} (${reason}); now ${after.stock_quantity}`,
  });
  res.status(201).json({ item_id: id, stock_quantity: after.stock_quantity, price: after.price });
}));

/**
 * Reprice the stock left in a batch. Selling prices are set at purchase; this
 * is for revising them afterwards — a price rise, a clearance — without
 * touching quantities or cost.
 */
app.put('/api/stock-batches/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const sellingPrice = round2(num(req.body?.selling_price, 'Selling price', { min: 0.01, max: 10_000_000 }));

  const batch = db.prepare(`
    SELECT b.*, i.name AS item_name FROM stock_batches b JOIN items i ON i.id = b.item_id WHERE b.id = ?
  `).get(id) as any;
  if (!batch) {
    res.status(404).json({ error: 'Batch not found' });
    return;
  }
  if (!(batch.quantity_remaining > 0)) {
    fail('This batch is sold out, so there is nothing left to reprice');
  }

  db.transaction(() => {
    db.prepare('UPDATE stock_batches SET selling_price = ? WHERE id = ?').run(sellingPrice, id);
    syncItemStock(batch.item_id);
  })();

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'stock_batch',
    entityId: id,
    details: `Repriced ${batch.quantity_remaining} of ${batch.item_name} (batch #${id}) from ₹${batch.selling_price.toFixed(2)} to ₹${sellingPrice.toFixed(2)}`,
  });
  res.json({ id, selling_price: sellingPrice });
}));

// --- Customer Routes ---

/**
 * A customer's display name, in SQL: their bakery/shop name, falling back to
 * their own name for a customer who has no shop.
 *
 * This shop refers to customers by bakery, so that is what lists sort by and
 * what the audit log records. It is the same rule as customerDisplayName() in
 * src/lib/customer.ts — change one and you must change the other.
 */
const CUSTOMER_DISPLAY_SQL = (alias = '') => {
  const col = (name: string) => (alias ? `${alias}.${name}` : name);
  return `COALESCE(NULLIF(TRIM(${col('shop_name')}), ''), ${col('name')})`;
};

/** The JS side of CUSTOMER_DISPLAY_SQL, for audit messages. */
const customerDisplayName = (customer: { name?: string | null; shop_name?: string | null }) =>
  (customer.shop_name ?? '').trim() || (customer.name ?? '').trim();

app.get('/api/customers', authenticateToken, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const search = optString(req.query.search, 'search', 100);

  const where = search ? 'WHERE shop_name LIKE ? OR name LIKE ? OR phone LIKE ?' : '';
  const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

  // Alphabetical by bakery, so the list reads the way the shop talks. Sorting
  // by the person's name scattered a bakery's entry wherever its owner's first
  // name happened to fall.
  const customers = db.prepare(`
    SELECT * FROM customers ${where}
    ORDER BY lower(${CUSTOMER_DISPLAY_SQL()}) ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM customers ${where}`).get(...params) as any;

  res.json({ data: customers, total, limit, offset });
}));

// Cheap counts for the sidebar badges, so the shell doesn't need the full
// item and customer lists in memory just to render two numbers.
app.get('/api/stats', authenticateToken, (_req, res) => {
  res.json({
    items: (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c,
    customers: (db.prepare('SELECT COUNT(*) c FROM customers').get() as any).c,
  });
});

/**
 * A customer needs a bakery/shop name, or — for someone with no shop — their
 * own name. At least one; either on its own is enough.
 *
 * This used to require the person's name and treat the shop as optional,
 * which is backwards for a shop that knows its customers by bakery: a cashier
 * who only knew "Sri Ganesh Bakery" could not create the customer without
 * inventing a person to put in the required field.
 */
const readCustomerPayload = (body: any) => {
  const shop_name = optString(body?.shop_name, 'Bakery / shop name', 200);
  const name = optString(body?.name, 'Customer name', 200);
  if (!shop_name && !name) {
    fail('Enter the bakery / shop name, or the customer’s name if they have no shop');
  }
  return {
    // The column is NOT NULL, so a shop-only customer stores an empty
    // person's name rather than NULL. Every reader goes through the display
    // rule, which skips blanks.
    name: name ?? '',
    phone: reqString(body?.phone, 'Customer phone', 20),
    shop_name,
    address: optString(body?.address, 'Address', 500),
    gstin: optString(body?.gstin, 'GSTIN', 20),
  };
};

app.post('/api/customers', authenticateToken, route((req, res) => {
  const customer = readCustomerPayload(req.body);

  // credit_balance is money owed to the shop. A cashier could previously set
  // it to any value on create or update — including zero — silently writing
  // off a customer's outstanding debt with no trace in the ledger. Only an
  // admin may set an opening balance; for everyone else it starts at 0 and
  // moves only through actual credit sales.
  const credit_balance =
    req.user.role === 'admin'
      ? num(req.body?.credit_balance, 'Credit balance', { min: 0, max: 100_000_000, fallback: 0 })
      : 0;

  const existing = db.prepare('SELECT id FROM customers WHERE phone = ?').get(customer.phone) as any;
  if (existing) {
    res.status(409).json({ error: 'A customer with this phone number already exists' });
    return;
  }

  // The row is inserted with a zero balance and then moved through
  // recordCreditChange, so an opening balance appears on the customer's
  // statement instead of materialising out of nowhere.
  const create = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT INTO customers (name, phone, shop_name, address, gstin, credit_balance)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(customer.name, customer.phone, customer.shop_name, customer.address, customer.gstin);

    const customerId = Number(inserted.lastInsertRowid);
    if (credit_balance > 0) {
      recordCreditChange({
        customerId,
        delta: credit_balance,
        entryType: 'opening',
        note: 'Opening balance set when the customer was created',
        user: req.user,
      });
    }
    return inserted;
  });
  const result = create();

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'customer',
    entityId: Number(result.lastInsertRowid),
    details: `Created customer ${customerDisplayName(customer)}`,
  });
  res.json({ id: Number(result.lastInsertRowid) });
}));

app.put('/api/customers/:id', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const customer = readCustomerPayload(req.body);

  const existingCustomer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!existingCustomer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const phoneOwner = db.prepare('SELECT id FROM customers WHERE phone = ? AND id != ?').get(customer.phone, id) as any;
  if (phoneOwner) {
    res.status(409).json({ error: 'Another customer already uses this phone number' });
    return;
  }

  // Cashiers may correct contact details but never the balance owed.
  const nextCreditBalance =
    req.user.role === 'admin' && req.body?.credit_balance !== undefined
      ? num(req.body.credit_balance, 'Credit balance', { min: 0, max: 100_000_000 })
      : existingCustomer.credit_balance;

  const balanceChanged = nextCreditBalance !== existingCustomer.credit_balance;
  const adjustmentNote = optString(req.body?.credit_note, 'Credit note', 300);

  // Contact details and the balance move together, so a failure cannot leave
  // the balance changed with no ledger entry explaining it.
  const update = db.transaction(() => {
    db.prepare(`
      UPDATE customers
      SET name = ?, phone = ?, shop_name = ?, address = ?, gstin = ?
      WHERE id = ?
    `).run(customer.name, customer.phone, customer.shop_name, customer.address, customer.gstin, id);

    if (balanceChanged) {
      recordCreditChange({
        customerId: id,
        delta: round2(nextCreditBalance - existingCustomer.credit_balance),
        entryType: 'adjustment',
        note: adjustmentNote || 'Balance corrected by an admin',
        user: req.user,
      });
    }
  });
  update();
  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'customer',
    entityId: id,
    details:
      `Updated customer ${customerDisplayName(existingCustomer)} to ${customerDisplayName(customer)}` +
      // Balance adjustments are the entry most worth being able to trace later.
      (balanceChanged ? `; credit balance ${existingCustomer.credit_balance} -> ${nextCreditBalance}` : ''),
  });

  res.json({ success: true });
}));

/**
 * Record a repayment against a customer's outstanding credit.
 *
 * Before this existed, the only way to record "the customer paid ₹500" was for
 * an admin to retype the balance, which left no record of the amount, the
 * date, or that it was a payment at all. A shop extending credit needs to be
 * able to show a customer their statement.
 */
app.post('/api/customers/:id/credit-payments', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const amount = num(req.body?.amount, 'Payment amount', { min: 0.01, max: 100_000_000 });
  const note = optString(req.body?.note, 'Note', 300);

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as any;
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const outstanding = round2(customer.credit_balance || 0);
  if (outstanding <= 0) {
    res.status(400).json({ error: 'This customer has no outstanding credit.' });
    return;
  }
  // Taking more than is owed would leave a negative balance, which the app
  // has no way to represent or settle. Say so rather than silently capping.
  if (round2(amount) > outstanding) {
    res.status(400).json({
      error: `Payment of ₹${round2(amount).toFixed(2)} is more than the ₹${outstanding.toFixed(2)} outstanding.`,
    });
    return;
  }

  const settle = db.transaction(() =>
    recordCreditChange({
      customerId: id,
      delta: -round2(amount),
      entryType: 'payment',
      note: note || 'Credit repayment received',
      user: req.user,
    })
  );
  const { before, after } = settle();

  writeAuditLog({
    user: req.user,
    action: 'credit_payment',
    entityType: 'customer',
    entityId: id,
    details: `Received ₹${round2(amount).toFixed(2)} from ${customerDisplayName(customer)}; balance ${before.toFixed(2)} -> ${after.toFixed(2)}`,
  });

  res.status(201).json({ customer_id: id, amount: round2(amount), balance_before: before, balance_after: after });
}));

/** A customer's credit statement: when the balance moved, by how much, and why. */
app.get('/api/customers/:id/credit-entries', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const { limit, offset } = readPaging(req);

  const customer = db.prepare('SELECT id, name, shop_name, credit_balance FROM customers WHERE id = ?').get(id) as any;
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const entries = db.prepare(`
    SELECT e.*, b.bill_number
    FROM customer_credit_entries e
    LEFT JOIN bills b ON b.id = e.bill_id
    WHERE e.customer_id = ?
    ORDER BY e.created_at DESC, e.id DESC
    LIMIT ? OFFSET ?
  `).all(id, limit, offset);
  const { total } = db.prepare(
    'SELECT COUNT(*) as total FROM customer_credit_entries WHERE customer_id = ?'
  ).get(id) as any;

  res.json({
    data: entries,
    total,
    limit,
    offset,
    customer: {
      id: customer.id,
      name: customer.name,
      shop_name: customer.shop_name,
      credit_balance: customer.credit_balance,
    },
  });
}));

/**
 * A customer's passbook: every transaction with them, in one timeline.
 *
 * The credit statement above shows only what moved the outstanding balance,
 * so a bakery that pays cash for most orders looked almost inactive there.
 * A passbook shows everything — every bill however it was paid, every
 * repayment, every correction — with what was billed, what was received, and
 * the balance due after each one.
 *
 * Each row carries three figures:
 *   amount_billed    what the customer was charged (a bill's total)
 *   amount_received  what they paid (cash + UPI at the counter, or a repayment)
 *   balance_change   billed - received, i.e. what went onto their account
 *
 * A bill appears once, as itself. Its 'sale' ledger entry is deliberately left
 * out — it is the credit portion of that same bill, and including both would
 * count it twice. Every other ledger entry (payment, adjustment, opening) is a
 * row of its own. Summing balance_change over the whole history therefore
 * lands exactly on customers.credit_balance, and the tests hold it there.
 *
 * The running balance is computed over the customer's entire history *before*
 * the date filter is applied, so a period that starts mid-way opens with the
 * balance that was actually owed on that day, not zero.
 */
const PASSBOOK_EVENTS_SQL = `
  WITH events AS (
    SELECT
      'bill'             AS kind,
      b.id               AS ref_id,
      b.created_at       AS created_at,
      0                  AS kind_order,
      b.bill_number      AS bill_number,
      b.payment_method   AS payment_method,
      b.cash_amount      AS cash_amount,
      b.upi_amount       AS upi_amount,
      b.credit_amount    AS credit_amount,
      b.subtotal_amount  AS subtotal_amount,
      b.tax_amount       AS tax_amount,
      b.discount_amount  AS discount_amount,
      (SELECT COUNT(*) FROM bill_items bi WHERE bi.bill_id = b.id) AS item_count,
      b.total_amount     AS amount_billed,
      ROUND(b.cash_amount + b.upi_amount, 2) AS amount_received,
      b.credit_amount    AS balance_change,
      NULL               AS note,
      COALESCE(u.name, 'Unknown') AS user_name
    FROM bills b
    LEFT JOIN users u ON u.id = b.user_id
    WHERE b.customer_id = ?

    UNION ALL

    SELECT
      e.entry_type,
      e.id,
      e.created_at,
      -- Within the same second: an opening balance comes before anything
      -- else, and a repayment or correction after the bill it follows.
      CASE e.entry_type WHEN 'opening' THEN -1 ELSE 1 END,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END,
      CASE WHEN e.amount < 0 THEN -e.amount ELSE 0 END,
      e.amount,
      e.note,
      e.user_name
    FROM customer_credit_entries e
    WHERE e.customer_id = ? AND e.entry_type != 'sale'
  ),
  running AS (
    SELECT
      events.*,
      date(datetime(created_at, '+5 hours', '+30 minutes')) AS ist_date,
      ROUND(SUM(balance_change) OVER (
        ORDER BY created_at, kind_order, ref_id
        ROWS UNBOUNDED PRECEDING
      ), 2) AS balance
    FROM events
  )`;

app.get('/api/customers/:id/passbook', authenticateToken, route(async (req, res) => {
  const id = rowId(req.params.id);
  const { limit, offset } = readPaging(req);
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');
  if (from && to && from > to) fail('from must be on or before to');
  const order = req.query.order === undefined ? 'desc' : oneOf(req.query.order, ['asc', 'desc'] as const, 'order');

  const customer = db.prepare(
    'SELECT id, name, shop_name, phone, address, gstin, credit_balance, created_at FROM customers WHERE id = ?'
  ).get(id) as any;
  if (!customer) {
    res.status(404).json({ error: 'Customer not found' });
    return;
  }

  const where: string[] = [];
  const rangeParams: string[] = [];
  if (from) { where.push('ist_date >= ?'); rangeParams.push(from); }
  if (to) { where.push('ist_date <= ?'); rangeParams.push(to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const direction = order === 'asc' ? 'ASC' : 'DESC';
  const orderSql = `ORDER BY created_at ${direction}, kind_order ${direction}, ref_id ${direction}`;

  const [rows, summary, openingRow] = await Promise.all([
    readPool.all(
      `${PASSBOOK_EVENTS_SQL} SELECT * FROM running ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
      [id, id, ...rangeParams, limit, offset]
    ),
    readPool.get(
      `${PASSBOOK_EVENTS_SQL}
       SELECT
         COUNT(*) AS total,
         COALESCE(SUM(CASE WHEN kind = 'bill' THEN 1 ELSE 0 END), 0) AS bill_count,
         ROUND(COALESCE(SUM(amount_billed), 0), 2) AS total_billed,
         ROUND(COALESCE(SUM(amount_received), 0), 2) AS total_received
       FROM running ${whereSql}`,
      [id, id, ...rangeParams]
    ),
    // What was owed going into the period: the running balance of the last
    // transaction before it starts. Without a start date there is nothing
    // before, so the period opens at zero.
    from
      ? readPool.get(
          `${PASSBOOK_EVENTS_SQL}
           SELECT balance FROM running WHERE ist_date < ?
           ORDER BY created_at DESC, kind_order DESC, ref_id DESC LIMIT 1`,
          [id, id, from]
        )
      : Promise.resolve(null),
  ]);

  const openingBalance = round2(openingRow?.balance ?? 0);
  const totalBilled = round2(summary?.total_billed ?? 0);
  const totalReceived = round2(summary?.total_received ?? 0);

  res.json({
    customer: {
      id: customer.id,
      name: customer.name,
      shop_name: customer.shop_name,
      phone: customer.phone,
      address: customer.address,
      gstin: customer.gstin,
      credit_balance: customer.credit_balance,
      created_at: customer.created_at,
    },
    summary: {
      opening_balance: openingBalance,
      total_billed: totalBilled,
      total_received: totalReceived,
      // Opening + billed - received, which by construction equals the running
      // balance after the period's last transaction.
      closing_balance: round2(openingBalance + totalBilled - totalReceived),
      bill_count: summary?.bill_count ?? 0,
    },
    data: rows,
    total: summary?.total ?? 0,
    limit,
    offset,
    from,
    to,
    order,
  });
}));

/**
 * Sales credit: what customers owe the shop, customer by customer.
 *
 * Repayments are taken against a customer's balance, not against particular
 * bills, so which bills are still unpaid is worked out the usual way: payments
 * settle the oldest credit first. Whatever the balance still covers is
 * therefore its most recent credit — walking the customer's credit newest
 * first until the balance is accounted for gives the unpaid bills, the oldest
 * of them possibly part paid. Credit that is not a bill (an opening balance, a
 * correction) is included the same way, so the unpaid lines always add up to
 * the balance.
 *
 * Ages are counted from the day of each line, and summed into the 0-30, 31-60,
 * 61-90 and 90+ day buckets an auditor's receivables ageing asks for.
 */
const AGEING_BUCKETS = [
  { key: 'd0_30', label: '0–30 days', max: 30 },
  { key: 'd31_60', label: '31–60 days', max: 60 },
  { key: 'd61_90', label: '61–90 days', max: 90 },
  { key: 'd90_plus', label: 'Over 90 days', max: Infinity },
] as const;

app.get('/api/sales-credit', authenticateToken, route((_req, res) => {
  const customers = db.prepare(`
    SELECT c.id, c.name, c.shop_name, c.phone, ROUND(c.credit_balance, 2) AS balance,
           ${CUSTOMER_DISPLAY_SQL('c')} AS display_name,
           (SELECT MAX(e.created_at) FROM customer_credit_entries e WHERE e.customer_id = c.id AND e.entry_type = 'payment') AS last_payment_at,
           (SELECT e.amount FROM customer_credit_entries e WHERE e.customer_id = c.id AND e.entry_type = 'payment'
             ORDER BY e.created_at DESC, e.id DESC LIMIT 1) AS last_payment_amount
    FROM customers c
    WHERE ROUND(c.credit_balance, 2) > 0
    ORDER BY c.credit_balance DESC, lower(${CUSTOMER_DISPLAY_SQL('c')}) ASC
  `).all() as any[];

  // Everything that ever added to a customer's balance, newest first.
  const creditOf = db.prepare(`
    SELECT e.id, e.entry_type, e.amount, e.created_at, e.note, e.bill_id, b.bill_number,
           b.total_amount AS bill_total,
           CAST(julianday(date('now', '+5 hours', '+30 minutes'))
                - julianday(date(datetime(e.created_at, '+5 hours', '+30 minutes'))) AS INTEGER) AS age_days
    FROM customer_credit_entries e
    LEFT JOIN bills b ON b.id = e.bill_id
    WHERE e.customer_id = ? AND e.amount > 0
    ORDER BY e.created_at DESC, e.id DESC
  `);

  const ageing = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket.key, 0])) as Record<string, number>;
  const bucketOf = (days: number) => AGEING_BUCKETS.find((bucket) => days <= bucket.max)!.key;

  for (const customer of customers) {
    let toExplain = customer.balance;
    const unpaid: any[] = [];
    for (const entry of creditOf.iterate(customer.id) as Iterable<any>) {
      if (toExplain <= 0) break;
      const outstanding = round2(Math.min(entry.amount, toExplain));
      toExplain = round2(toExplain - outstanding);
      unpaid.push({
        entry_id: entry.id,
        kind: entry.entry_type,
        bill_id: entry.bill_id,
        bill_number: entry.bill_number,
        bill_total: entry.bill_total,
        note: entry.bill_id ? null : entry.note,
        created_at: entry.created_at,
        credit_amount: round2(entry.amount),
        outstanding,
        age_days: Math.max(0, entry.age_days),
      });
    }
    // A balance the ledger cannot explain (it always should) still has to be
    // shown and aged somewhere: count it as of today.
    if (toExplain > 0) {
      unpaid.push({ entry_id: null, kind: 'adjustment', bill_id: null, bill_number: null, bill_total: null,
        note: 'Balance not itemised in the ledger', created_at: null, credit_amount: toExplain, outstanding: toExplain, age_days: 0 });
    }

    unpaid.reverse(); // oldest first, the order they will be paid off in
    customer.unpaid = unpaid;
    customer.oldest_age_days = unpaid[0]?.age_days ?? 0;
    customer.ageing = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket.key, 0]));
    for (const line of unpaid) {
      const key = bucketOf(line.age_days);
      customer.ageing[key] = round2(customer.ageing[key] + line.outstanding);
      ageing[key] = round2(ageing[key] + line.outstanding);
    }
  }

  res.json({
    total_due: round2(customers.reduce((acc, customer) => acc + customer.balance, 0)),
    customer_count: customers.length,
    ageing: AGEING_BUCKETS.map((bucket) => ({ key: bucket.key, label: bucket.label, amount: ageing[bucket.key] })),
    customers,
  });
}));

// --- Supplier Routes ---
app.get('/api/suppliers', authenticateToken, requireAdmin, (_req, res) => {
  // What the shop owes each supplier, for the Suppliers page and the
  // Purchases supplier picker.
  const suppliers = db.prepare(`
    SELECT s.*, ROUND(COALESCE((
      SELECT SUM(MAX(0, p.total_amount - ${PURCHASE_PAID_SQL})) FROM purchases p WHERE p.supplier_id = s.id
    ), 0), 2) AS amount_due
    FROM suppliers s
    ORDER BY s.name ASC
  `).all();

  res.json(suppliers);
});

const readSupplierPayload = (body: any) => ({
  name: reqString(body?.name, 'Supplier name', 200),
  phone: optString(body?.phone, 'Phone', 20),
  address: optString(body?.address, 'Address', 500),
  gstin: optString(body?.gstin, 'GSTIN', 20),
});

app.post('/api/suppliers', authenticateToken, requireAdmin, route((req, res) => {
  const supplier = readSupplierPayload(req.body);

  const existing = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?)').get(supplier.name) as any;
  if (existing) {
    res.status(409).json({ error: 'A supplier with this name already exists' });
    return;
  }

  const result = db.prepare(`
    INSERT INTO suppliers (name, phone, address, gstin)
    VALUES (?, ?, ?, ?)
  `).run(supplier.name, supplier.phone, supplier.address, supplier.gstin);

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'supplier',
    entityId: Number(result.lastInsertRowid),
    details: `Created supplier ${supplier.name}`,
  });

  res.status(201).json({ id: Number(result.lastInsertRowid) });
}));

app.put('/api/suppliers/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const supplier = readSupplierPayload(req.body);

  const existingSupplier = db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as any;
  if (!existingSupplier) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }

  const nameOwner = db.prepare('SELECT id FROM suppliers WHERE lower(name) = lower(?) AND id != ?').get(supplier.name, id) as any;
  if (nameOwner) {
    res.status(409).json({ error: 'Another supplier already uses this name' });
    return;
  }

  db.prepare(`
    UPDATE suppliers
    SET name = ?, phone = ?, address = ?, gstin = ?
    WHERE id = ?
  `).run(supplier.name, supplier.phone, supplier.address, supplier.gstin, id);

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'supplier',
    entityId: id,
    details: `Updated supplier ${existingSupplier.name} to ${supplier.name}`,
  });

  res.json({ success: true });
}));

// --- Billing Routes ---

// A single bill with more line items than this is not a real sale.
const MAX_BILL_LINE_ITEMS = 500;
// Tolerance for comparing client-supplied money against server-computed money.
const MONEY_EPSILON = 0.01;

app.post('/api/bills', authenticateToken, route((req, res) => {
  const { items } = req.body ?? {};

  // --- Basic request validation ---
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'At least one item is required to create a bill' });
    return;
  }
  if (items.length > MAX_BILL_LINE_ITEMS) {
    res.status(400).json({ error: `A bill cannot have more than ${MAX_BILL_LINE_ITEMS} line items` });
    return;
  }

  const payment_method = oneOf(req.body?.payment_method, ['cash', 'upi', 'credit', 'split'] as const, 'Payment method');
  const customer_id = optRowId(req.body?.customer_id, 'Customer');
  const safeDiscount = num(req.body?.discount_amount, 'Discount', { min: 0, max: 100_000_000, fallback: 0 });

  // Each of these was previously written to the ledger straight from the
  // request body with no checks at all. A negative credit_amount subtracted
  // from a customer's outstanding balance — a one-request debt write-off — and
  // a cash_amount unrelated to the total let a sale be recorded as ₹0 collected
  // while the stock still left the shelf.
  const requestedCash = num(req.body?.cash_amount, 'Cash amount', { min: 0, max: 100_000_000, fallback: 0 });
  const requestedUpi = num(req.body?.upi_amount, 'UPI amount', { min: 0, max: 100_000_000, fallback: 0 });
  const requestedCredit = num(req.body?.credit_amount, 'Credit amount', { min: 0, max: 100_000_000, fallback: 0 });

  const parsedItems = items.map((item: any) => ({
    id: rowId(item?.id, 'Item id'),
    quantity: round3(num(item?.quantity, 'Quantity', { min: 0, max: 1_000_000 })),
    // Prices are not set at billing: each unit is charged the selling price of
    // the batch it comes from, which is set on the purchase (or repriced in
    // Items → Stock & prices). A unit_price is accepted only if it is that
    // price — anything else is refused below, not quietly ignored.
    unit_price:
      item?.unit_price == null || item?.unit_price === ''
        ? null
        : round2(num(item.unit_price, 'Price', { min: 0.01, max: 10_000_000 })),
  }));
  if (parsedItems.some((item) => item.quantity <= 0)) {
    fail('Every item needs a quantity greater than 0');
  }

  // The grand total the till showed the cashier. Prices now come from batches,
  // and another sale can use up a batch between the item going into the cart
  // and the bill being saved — so without this check the customer could be
  // charged a different amount from the one on screen.
  // Queue the bill for the counter's receipt printer — how a bill saved on a
  // phone gets printed at the counter. In the same transaction as the bill.
  const printAtCounter = req.body?.print_at_counter === true;

  const expectedTotal =
    req.body?.expected_total == null || req.body?.expected_total === ''
      ? null
      : num(req.body.expected_total, 'Expected total', { min: 0, max: 1_000_000_000 });

  if (customer_id) {
    const customerExists = db.prepare('SELECT id FROM customers WHERE id = ?').get(customer_id);
    if (!customerExists) {
      res.status(400).json({ error: 'Customer not found' });
      return;
    }
  }

  const transaction = db.transaction(() => {
    const bill_number = nextDocumentNumber('INV');
    // Recompute price/tax/stock from the authoritative items table rather
    // than trusting the amounts the client sent — a client-supplied price
    // could otherwise be tampered with (e.g. via devtools/Postman) to
    // under-record revenue while still deducting real stock.
    let subtotal_amount = 0;
    let tax_amount = 0;

    // One entry per bill line to write. A requested line can become several
    // when its quantity crosses from one batch into a dearer one.
    const lineItems: Array<{
      item_id: number;
      amounts: ReturnType<typeof computeLine>;
      rates: ReturnType<typeof lineGstRates>;
      allocations: Array<{ batch_id: number; quantity: number }>;
    }> = [];
    const touchedItems = new Set<number>();

    const selectItem = db.prepare('SELECT * FROM items WHERE id = ?');
    const selectBatches = db.prepare(`
      SELECT id, quantity_remaining, selling_price, unit_cost
      FROM stock_batches
      WHERE item_id = ? AND quantity_remaining > 0
      ORDER BY received_at ASC, id ASC
    `);
    // What this bill has already taken from each batch, so the same item on
    // two lines of one bill carries on down the FIFO queue instead of selling
    // the same units twice.
    const takenThisBill = new Map<number, number>();
    const batchCost = new Map<number, number | null>();

    for (const item of parsedItems) {
      const dbItem = selectItem.get(item.id) as any;
      if (!dbItem) {
        throw new ValidationError(`Item not found: ${item.id}`);
      }

      const batches = (selectBatches.all(item.id) as any[]).map((batch) => {
        batchCost.set(batch.id, batch.unit_cost);
        return { ...batch, quantity_remaining: round3(batch.quantity_remaining - (takenThisBill.get(batch.id) ?? 0)) };
      });
      const { allocations, shortfall } = allocateFifo(batches, item.quantity);
      if (shortfall > 0) {
        const available = round3(batches.reduce((acc, batch) => acc + Math.max(0, batch.quantity_remaining), 0));
        throw new ValidationError(
          `Insufficient stock for ${dbItem.name}: requested ${item.quantity}, only ${available} available`
        );
      }
      for (const allocation of allocations) {
        takenThisBill.set(allocation.batch_id, round3((takenThisBill.get(allocation.batch_id) ?? 0) + allocation.quantity));
      }
      touchedItems.add(dbItem.id);

      const segments = priceSegments(allocations);
      if (item.unit_price != null && !(segments.length === 1 && segments[0].unit_price === item.unit_price)) {
        const fifoPrices = segments.map((segment) => `${segment.quantity} @ ₹${segment.unit_price.toFixed(2)}`).join(' + ');
        throw new ValidationError(
          `The price of ${dbItem.name} cannot be changed at billing (it sells as ${fifoPrices}). ` +
            'Change the selling price in Items → Stock & prices.'
        );
      }

      for (const segment of segments) {
        const amounts = computeLine(dbItem, segment.unit_price, segment.quantity);
        subtotal_amount += amounts.taxable_amount;
        tax_amount += amounts.sgst_amount + amounts.cgst_amount + amounts.igst_amount;
        lineItems.push({
          item_id: dbItem.id,
          amounts,
          rates: lineGstRates(dbItem),
          allocations: segment.allocations.map(({ batch_id, quantity }) => ({ batch_id, quantity })),
        });
      }
    }

    subtotal_amount = round2(subtotal_amount);
    tax_amount = round2(tax_amount);

    if (safeDiscount > subtotal_amount + tax_amount) {
      throw new ValidationError('Discount cannot exceed the bill subtotal');
    }
    // The shop settles in whole rupees and rounds DOWN, so the payable is
    // floored and the dropped paise become the invoice's Round Off line.
    // Storing the floored figure (rather than the exact one) keeps printed,
    // recorded and collected amounts identical — otherwise the cash drawer
    // never reconciles against the ledger.
    const grossTotal = round2(subtotal_amount + tax_amount - safeDiscount);
    const total_amount = Math.floor(grossTotal);

    // --- Reconcile the payment split against the authoritative total ---
    //
    // The tender amounts must account for exactly the money owed. Anything
    // else is either a UI bug or someone under-recording a sale.
    let cash_amount = 0;
    let upi_amount = 0;
    let credit_amount = 0;

    if (payment_method === 'cash') {
      cash_amount = total_amount;
    } else if (payment_method === 'upi') {
      upi_amount = total_amount;
    } else if (payment_method === 'credit') {
      credit_amount = total_amount;
    } else {
      // Split: honour the client's breakdown, but only if it adds up.
      const tendered = round2(requestedCash + requestedUpi + requestedCredit);
      if (Math.abs(tendered - total_amount) > MONEY_EPSILON) {
        throw new ValidationError(
          `Payment split (₹${tendered.toFixed(2)}) does not match the bill total (₹${total_amount.toFixed(2)})`
        );
      }
      cash_amount = round2(requestedCash);
      upi_amount = round2(requestedUpi);
      // Absorb rounding into credit so the three always sum to the total.
      credit_amount = round2(total_amount - cash_amount - upi_amount);
      if (credit_amount < 0) credit_amount = 0;
    }

    // Credit is an unsecured loan from the shop; it needs a named debtor.
    if (credit_amount > 0 && !customer_id) {
      throw new ValidationError('Credit can only be given to registered customers');
    }

    if (expectedTotal != null && Math.abs(expectedTotal - total_amount) > 0.001) {
      throw new ConflictError(
        `Prices or stock changed while this bill was open: it showed ₹${expectedTotal.toFixed(2)} but is now ₹${total_amount.toFixed(2)}. The bill has been refreshed — please check it and save again.`,
        'PRICE_CHANGED'
      );
    }

    const billResult = db.prepare(`
      INSERT INTO bills (
        bill_number, customer_id, user_id, subtotal_amount, total_amount, tax_amount,
        discount_amount, payment_method, cash_amount, upi_amount, credit_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bill_number, customer_id, req.user.id, subtotal_amount, total_amount, tax_amount,
      safeDiscount, payment_method, cash_amount, upi_amount, credit_amount
    );

    const bill_id = Number(billResult.lastInsertRowid);

    const insertBillItem = db.prepare(`
      INSERT INTO bill_items (
        bill_id, item_id, quantity, price, unit_price, sgst_amount, cgst_amount, igst_amount, total_amount,
        sgst_rate, cgst_rate, igst_rate
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAllocation = db.prepare(
      'INSERT INTO bill_item_batches (bill_item_id, batch_id, quantity, unit_cost) VALUES (?, ?, ?, ?)'
    );
    // Conditional: the batch must still hold what is being taken from it. The
    // whole transaction is serialised, so this cannot fail in practice; it is
    // here so that if it ever did, the bill fails rather than the stock going
    // negative.
    const drawDown = db.prepare(`
      UPDATE stock_batches SET quantity_remaining = ROUND(quantity_remaining - @quantity, 3)
      WHERE id = @id AND quantity_remaining - @quantity >= -0.0005
    `);

    for (const line of lineItems) {
      const { amounts, rates } = line;
      const billItem = insertBillItem.run(
        bill_id, line.item_id, amounts.quantity, amounts.price, amounts.unit_price,
        amounts.sgst_amount, amounts.cgst_amount, amounts.igst_amount, amounts.total_amount,
        rates.sgst_rate, rates.cgst_rate, rates.igst_rate
      );
      const billItemId = Number(billItem.lastInsertRowid);

      for (const allocation of line.allocations) {
        insertAllocation.run(billItemId, allocation.batch_id, allocation.quantity, batchCost.get(allocation.batch_id) ?? null);
        if (drawDown.run({ id: allocation.batch_id, quantity: allocation.quantity }).changes === 0) {
          throw new ValidationError('Stock changed while this bill was being processed. Please retry.');
        }
      }
    }

    for (const itemId of touchedItems) syncItemStock(itemId);

    // Update customer credit balance if credit_amount > 0, and leave a ledger
    // entry so the customer's statement shows which sale it came from.
    if (customer_id && credit_amount > 0) {
      recordCreditChange({
        customerId: customer_id,
        delta: credit_amount,
        entryType: 'sale',
        billId: bill_id,
        note: `Credit sale on bill ${bill_number}`,
        user: req.user,
      });
    }

    const print_job_id = printAtCounter
      ? Number(db.prepare('INSERT INTO print_jobs (bill_id, requested_by, requested_by_name) VALUES (?, ?, ?)')
          .run(bill_id, req.user.id, req.user.name).lastInsertRowid)
      : null;

    return { bill_id, bill_number, subtotal_amount, tax_amount, total_amount, print_job_id };
  });

  const result = transaction();
  analyticsCache = null; // a new sale invalidates the dashboard figures
  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'bill',
    entityId: result.bill_id,
    details: `Created bill ${result.bill_number} for amount ₹${result.total_amount.toFixed(2)}`,
  });
  res.json(result);
}));

app.get('/api/bills', authenticateToken, route(async (req, res) => {
  const { limit, offset } = readPaging(req);
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');
  const search = optString(req.query.search, 'search', 100);

  // Returning every bill ever rung up was fine with a handful of test rows and
  // ruinous at a few lakh a week. Page, date-filter and search in SQL.
  //
  // Search matters as much as paging: without it the only way to reach an old
  // bill is to page down to it, and at 1M rows OFFSET is O(n) — page 1000 took
  // 400ms because SQLite walks every skipped row.
  const IST_B = "date(datetime(b.created_at, '+5 hours', '+30 minutes'))";
  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push(`${IST_B} >= ?`); params.push(from); }
  if (to) { where.push(`${IST_B} <= ?`); params.push(to); }
  if (search) {
    // Shop name first: a cashier looking for last week's bill types the
    // bakery, not the owner's name.
    where.push('(b.bill_number LIKE ? OR c.shop_name LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [json, countRow] = await Promise.all([
    readPool.json(`
      SELECT b.*, c.name as customer_name, c.shop_name as customer_shop_name, u.name as cashier_name
      FROM bills b
      LEFT JOIN customers c ON b.customer_id = c.id
      JOIN users u ON b.user_id = u.id
      ${whereSql}
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT ? OFFSET ?
    `, [...params, limit, offset], { limit, offset }),
    readPool.get(`
      SELECT COUNT(*) as total FROM bills b
      LEFT JOIN customers c ON b.customer_id = c.id
      ${whereSql}
    `, params),
  ]);

  // Splice the count into the worker-built JSON without re-parsing the rows.
  res.type('application/json').send(json.replace(/\}$/, `,"total":${countRow?.total ?? 0}}`));
}));

app.get('/api/bills/:id', authenticateToken, route((req, res) => {
  const bill = db.prepare(`
    SELECT b.*, c.name as customer_name, c.shop_name as customer_shop_name, c.phone as customer_phone, c.address as customer_address, c.gstin as customer_gstin, u.name as cashier_name
    FROM bills b
    LEFT JOIN customers c ON b.customer_id = c.id
    JOIN users u ON b.user_id = u.id
    WHERE b.id = ?
  `).get(rowId(req.params.id));

  if (!bill) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }

  const rows = db.prepare(`
    SELECT bi.*, i.name as item_name, i.hsn_code, i.metric,
      i.gst_applicable AS item_gst_applicable, i.gst_mode AS item_gst_mode, i.gst_rate AS item_gst_rate,
      i.sgst_rate AS item_sgst_rate, i.cgst_rate AS item_cgst_rate, i.igst_rate AS item_igst_rate
    FROM bill_items bi
    JOIN items i ON bi.item_id = i.id
    WHERE bi.bill_id = ?
  `).all((bill as any).id) as any[];

  // Lines written before bill_items kept their rates have NULL there. The
  // invoice still needs a slab to print, so use the item's rates today; a line
  // that carried no tax had none.
  const items = rows.map(({
    item_gst_applicable, item_gst_mode, item_gst_rate, item_sgst_rate, item_cgst_rate, item_igst_rate, ...line
  }) => {
    if (line.sgst_rate != null) return line;
    const taxed = line.sgst_amount + line.cgst_amount + (line.igst_amount || 0) > 0;
    const rates = taxed
      ? lineGstRates({
          gst_applicable: item_gst_applicable, gst_mode: item_gst_mode, gst_rate: item_gst_rate,
          sgst_rate: item_sgst_rate, cgst_rate: item_cgst_rate, igst_rate: item_igst_rate,
        })
      : { sgst_rate: 0, cgst_rate: 0, igst_rate: 0 };
    return { ...line, ...rates };
  });

  res.json({ ...bill as object, items });
}));

/**
 * Delete a bill as though it had never been rung up.
 *
 *   Stock    every unit goes back to the batch it was sold from, so it sells
 *            again in its old place in the FIFO queue and at its old price.
 *            Bills from before batch tracking have no record of their batches;
 *            their units come back as a new batch at the item's latest cost
 *            and price, as a stock adjustment adding them would.
 *   Credit   the credit portion comes off the customer's balance, and the
 *            bill's 'sale' entry is removed from their ledger. Later entries'
 *            running balances are shifted by the same amount, so the statement
 *            still reads straight through and ends on the stored balance.
 *   Records  the bill and its lines go, so it drops out of history, the
 *            passbook, reports and the dashboard.
 *
 * Every unit returned leaves a stock_adjustments row naming the bill, and the
 * deletion itself is audit-logged with the bill's details.
 *
 * Refused when the customer has already repaid more than their balance now
 * holds: taking the credit off would leave the shop owing them, which the app
 * cannot represent. The admin records the refund as a balance correction
 * first, then deletes.
 */
app.delete('/api/bills/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const bill = db.prepare(`
    SELECT b.*, c.name AS customer_name, c.shop_name AS customer_shop_name
    FROM bills b LEFT JOIN customers c ON c.id = b.customer_id
    WHERE b.id = ?
  `).get(id) as any;
  if (!bill) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }

  const reason = `Bill ${bill.bill_number} deleted`;

  const remove = db.transaction(() => {
    const lines = db.prepare('SELECT id, item_id, quantity, unit_price, total_amount FROM bill_items WHERE bill_id = ?').all(id) as any[];
    const selectAllocations = db.prepare('SELECT batch_id, quantity FROM bill_item_batches WHERE bill_item_id = ?');
    const putBack = db.prepare('UPDATE stock_batches SET quantity_remaining = ROUND(quantity_remaining + ?, 3) WHERE id = ?');
    const latestBatch = db.prepare(`
      SELECT unit_cost, selling_price FROM stock_batches WHERE item_id = ? ORDER BY received_at DESC, id DESC LIMIT 1
    `);
    const insertBatch = db.prepare(`
      INSERT INTO stock_batches (item_id, source, quantity_received, quantity_remaining, unit_cost, selling_price)
      VALUES (?, 'adjustment', ?, ?, ?, ?)
    `);
    const recordAdjustment = db.prepare(`
      INSERT INTO stock_adjustments (item_id, batch_id, quantity, reason, user_id, user_name)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const touchedItems = new Set<number>();
    for (const line of lines) {
      const allocations = selectAllocations.all(line.id) as Array<{ batch_id: number; quantity: number }>;
      if (allocations.length > 0) {
        for (const allocation of allocations) {
          putBack.run(allocation.quantity, allocation.batch_id);
          recordAdjustment.run(line.item_id, allocation.batch_id, allocation.quantity, reason, req.user.id, req.user.name);
        }
      } else if (line.quantity > 0) {
        const latest = latestBatch.get(line.item_id) as any;
        const sellingPrice = latest?.selling_price ?? line.unit_price ?? round2(line.total_amount / line.quantity);
        const batch = insertBatch.run(line.item_id, line.quantity, line.quantity, latest?.unit_cost ?? null, sellingPrice);
        recordAdjustment.run(line.item_id, Number(batch.lastInsertRowid), line.quantity, reason, req.user.id, req.user.name);
      }
      touchedItems.add(line.item_id);
    }
    for (const itemId of touchedItems) syncItemStock(itemId);

    // Take the bill's credit back off the customer, and its sale entry out of
    // the ledger. Not through recordCreditChange(): that appends an entry, and
    // a deleted bill should leave no line on the statement, not a sale and a
    // reversal.
    const saleEntries = db.prepare(`
      SELECT id, customer_id, amount, created_at FROM customer_credit_entries WHERE bill_id = ? ORDER BY created_at, id
    `).all(id) as any[];
    for (const entry of saleEntries) {
      const customer = db.prepare('SELECT credit_balance FROM customers WHERE id = ?').get(entry.customer_id) as any;
      const after = round2((customer?.credit_balance || 0) - entry.amount);
      if (after < 0) {
        throw new ValidationError(
          `${bill.bill_number} put ₹${round2(entry.amount).toFixed(2)} on credit, but the customer now owes only ` +
            `₹${round2(customer?.credit_balance || 0).toFixed(2)} — they have already paid some of it. Record the refund ` +
            'as a balance correction on the customer first, then delete the bill.'
        );
      }
      db.prepare('UPDATE customers SET credit_balance = ? WHERE id = ?').run(after, entry.customer_id);
      db.prepare(`
        UPDATE customer_credit_entries
        SET balance_before = ROUND(balance_before - @amount, 2), balance_after = ROUND(balance_after - @amount, 2)
        WHERE customer_id = @customer AND (created_at > @at OR (created_at = @at AND id > @id))
      `).run({ amount: entry.amount, customer: entry.customer_id, at: entry.created_at, id: entry.id });
      db.prepare('DELETE FROM customer_credit_entries WHERE id = ?').run(entry.id);
    }

    db.prepare(`
      DELETE FROM bill_item_batches WHERE bill_item_id IN (SELECT id FROM bill_items WHERE bill_id = ?)
    `).run(id);
    db.prepare('DELETE FROM bill_items WHERE bill_id = ?').run(id);
    db.prepare('DELETE FROM print_jobs WHERE bill_id = ?').run(id);
    db.prepare('DELETE FROM bills WHERE id = ?').run(id);

    return { lineCount: lines.length, itemCount: touchedItems.size };
  });

  const { lineCount, itemCount } = remove();
  analyticsCache = null; // takings, bill counts and low stock all change

  const customer = bill.customer_id ? ` for ${customerDisplayName({ name: bill.customer_name, shop_name: bill.customer_shop_name })}` : '';
  const credit = bill.credit_amount > 0 ? `; ₹${round2(bill.credit_amount).toFixed(2)} taken off their credit balance` : '';
  writeAuditLog({
    user: req.user,
    action: 'delete',
    entityType: 'bill',
    entityId: id,
    details: `Deleted bill ${bill.bill_number}${customer} (₹${round2(bill.total_amount).toFixed(2)}, ${bill.payment_method}); ` +
      `stock returned for ${lineCount} line${lineCount === 1 ? '' : 's'}${credit}`,
  });
  res.json({ success: true, bill_number: bill.bill_number, items_restocked: itemCount });
}));

// --- Quick Bill (the phone app) ---

/**
 * The items a cashier is most likely to want next, so a phone bill rarely
 * needs typing: what this customer usually buys (last 180 days, most often
 * bought first), and the shop's best sellers (last 30 days). Items out of
 * stock are still listed, flagged, so a regular order is not silently short.
 */
app.get('/api/quick-items', authenticateToken, route(async (req, res) => {
  const customerId = optRowId(req.query.customer_id, 'Customer');
  const limit = num(req.query.limit, 'limit', { min: 1, max: 50, fallback: 12 });
  const columns = ITEM_LIST_COLUMNS.split(',').map((column) => `i.${column.trim()}`).join(', ');

  const [usual, popular] = await Promise.all([
    customerId
      ? readPool.all(`
          SELECT ${columns}, COUNT(DISTINCT b.id) AS times_bought, ROUND(SUM(bi.quantity), 3) AS total_quantity
          FROM bill_items bi
          JOIN bills b ON b.id = bi.bill_id
          JOIN items i ON i.id = bi.item_id
          WHERE b.customer_id = ? AND b.created_at >= datetime('now', '-180 days')
          GROUP BY i.id
          ORDER BY times_bought DESC, total_quantity DESC, lower(i.name) ASC
          LIMIT ?`, [customerId, limit])
      : Promise.resolve([]),
    readPool.all(`
      SELECT ${columns}, COUNT(DISTINCT b.id) AS times_bought, ROUND(SUM(bi.quantity), 3) AS total_quantity
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      JOIN items i ON i.id = bi.item_id
      WHERE b.created_at >= datetime('now', '-30 days')
      GROUP BY i.id
      ORDER BY times_bought DESC, total_quantity DESC, lower(i.name) ASC
      LIMIT ?`, [limit]),
  ]);

  res.json({ usual, popular });
}));

/**
 * A customer's most recent bill, item by item (a line split across batches is
 * one item again), with each item as it is now — so "repeat last order" can
 * put the same quantities in a new bill at today's prices.
 */
app.get('/api/customers/:id/last-order', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const bill = db.prepare(`
    SELECT id, bill_number, created_at, total_amount FROM bills
    WHERE customer_id = ? ORDER BY created_at DESC, id DESC LIMIT 1
  `).get(id) as any;
  if (!bill) {
    res.json({ bill: null, items: [] });
    return;
  }
  const columns = ITEM_LIST_COLUMNS.split(',').map((column) => `i.${column.trim()}`).join(', ');
  const items = db.prepare(`
    SELECT ${columns}, ROUND(SUM(bi.quantity), 3) AS ordered_quantity
    FROM bill_items bi JOIN items i ON i.id = bi.item_id
    WHERE bi.bill_id = ?
    GROUP BY i.id
    ORDER BY MIN(bi.id)
  `).all(bill.id);
  res.json({ bill, items });
}));

// --- Counter print queue ---
//
// Phones cannot reach the counter's receipt printer, so a phone bill is
// queued and the counter computer prints it. See print_jobs in db/index.ts.

/** Queue a bill (again) for the counter printer: a reprint from a phone. */
app.post('/api/bills/:id/print-requests', authenticateToken, route((req, res) => {
  const billId = rowId(req.params.id);
  if (!db.prepare('SELECT 1 FROM bills WHERE id = ?').get(billId)) {
    res.status(404).json({ error: 'Bill not found' });
    return;
  }
  const pending = db.prepare("SELECT id FROM print_jobs WHERE bill_id = ? AND status = 'pending'").get(billId) as any;
  const id = pending?.id ?? Number(db.prepare(
    'INSERT INTO print_jobs (bill_id, requested_by, requested_by_name) VALUES (?, ?, ?)'
  ).run(billId, req.user.id, req.user.name).lastInsertRowid);
  res.status(201).json({ id, status: 'pending' });
}));

/** Bills waiting for the counter printer, oldest first. Polled by the print station. */
app.get('/api/print-jobs', authenticateToken, route((_req, res) => {
  const jobs = db.prepare(`
    SELECT j.id, j.bill_id, j.status, j.requested_by_name, j.created_at, b.bill_number
    FROM print_jobs j JOIN bills b ON b.id = j.bill_id
    WHERE j.status = 'pending'
      -- A job nobody printed within a day is stale: the bill was long since
      -- handed over. Reprint it from History if it is still wanted.
      AND j.created_at >= datetime('now', '-1 day')
    ORDER BY j.created_at ASC, j.id ASC
    LIMIT 20
  `).all();
  res.json({ data: jobs });
}));

/** Whether a queued bill has been printed yet, for the phone that sent it. */
app.get('/api/print-jobs/:id', authenticateToken, route((req, res) => {
  const job = db.prepare('SELECT id, bill_id, status, created_at, printed_at, printed_by_name FROM print_jobs WHERE id = ?')
    .get(rowId(req.params.id));
  if (!job) {
    res.status(404).json({ error: 'Print job not found' });
    return;
  }
  res.json(job);
}));

/**
 * The print station takes a job. Marked printed in the same step, and only
 * if still pending, so with two counter computers open each bill prints once.
 */
app.post('/api/print-jobs/:id/claim', authenticateToken, route((req, res) => {
  const id = rowId(req.params.id);
  const claimed = db.prepare(`
    UPDATE print_jobs SET status = 'printed', printed_at = CURRENT_TIMESTAMP, printed_by_name = ?
    WHERE id = ? AND status = 'pending'
  `).run(req.user.name, id);
  if (claimed.changes === 0) {
    res.status(409).json({ error: 'Already printed', code: 'ALREADY_PRINTED' });
    return;
  }
  res.json({ id, status: 'printed' });
}));

// --- Purchase Routes ---
const MAX_PURCHASE_LINE_ITEMS = 500;

// --- Purchase payments ---
//
// A purchase is paid at the time, in part or in full, or bought on credit and
// paid later. What it still owes is always its total less the payments
// allocated to it (supplier_payment_allocations); nothing stores the figure,
// so it cannot drift. A purchase with nothing left to pay is "paid".

const PAYMENT_METHODS = ['cash', 'upi', 'bank', 'cheque'] as const;
type PaymentMethod = (typeof PAYMENT_METHODS)[number];
const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash', upi: 'UPI', bank: 'Bank transfer', cheque: 'Cheque',
};

/** How a supplier was paid. Optional: blank means not recorded. */
const optPaymentMethod = (value: unknown): PaymentMethod | null =>
  value == null || value === '' ? null : oneOf(value, PAYMENT_METHODS, 'Payment method');

/** What has been paid against purchase `p`, in SQL. */
const PURCHASE_PAID_SQL =
  '(SELECT ROUND(COALESCE(SUM(a.amount), 0), 2) FROM supplier_payment_allocations a WHERE a.purchase_id = p.id)';

/**
 * The order a supplier's invoices are settled in: oldest invoice first. The
 * invoice date is the supplier's own, and is optional, so the day the
 * purchase was entered stands in for it.
 */
const PURCHASE_AGE_ORDER_SQL =
  "COALESCE(NULLIF(p.invoice_date, ''), date(datetime(p.created_at, '+5 hours', '+30 minutes'))) ASC, p.created_at ASC, p.id ASC";

/**
 * Record a payment to a supplier and settle their purchases with it.
 *
 * With `purchaseId`, the whole amount goes to that purchase. Without, it
 * clears the supplier's oldest unpaid purchases first, splitting across as
 * many as it covers. Paying more than is owed is refused: the app has no
 * notion of an advance to a supplier.
 *
 * MUST be called inside a db.transaction().
 */
const recordSupplierPayment = (params: {
  supplierId: number;
  purchaseId?: number | null;
  amount: number;
  paidOn: string;
  method: PaymentMethod | null;
  reference?: string | null;
  note?: string | null;
  user: { id: number; name: string };
}) => {
  const amount = round2(params.amount);
  const outstanding = db.prepare(`
    SELECT p.id, p.purchase_number, ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) AS balance_due
    FROM purchases p
    WHERE p.supplier_id = ? ${params.purchaseId ? 'AND p.id = ?' : ''}
      AND ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) > 0
    ORDER BY ${PURCHASE_AGE_ORDER_SQL}
  `).all(...(params.purchaseId ? [params.supplierId, params.purchaseId] : [params.supplierId])) as Array<{
    id: number; purchase_number: string; balance_due: number;
  }>;

  const owed = round2(outstanding.reduce((acc, row) => acc + row.balance_due, 0));
  if (owed <= 0) {
    throw new ValidationError(params.purchaseId ? 'This purchase is already fully paid.' : 'Nothing is owed to this supplier.');
  }
  if (amount > owed) {
    throw new ValidationError(
      `₹${amount.toFixed(2)} is more than the ₹${owed.toFixed(2)} owed${params.purchaseId ? ' on this purchase' : ' to this supplier'}.`
    );
  }

  const payment = db.prepare(`
    INSERT INTO supplier_payments (supplier_id, amount, paid_on, method, reference, note, user_id, user_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    params.supplierId, amount, params.paidOn, params.method, params.reference ?? null, params.note ?? null,
    params.user.id, params.user.name
  );
  const paymentId = Number(payment.lastInsertRowid);

  const allocate = db.prepare('INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount) VALUES (?, ?, ?)');
  const allocations: Array<{ purchase_id: number; purchase_number: string; amount: number; cleared: boolean }> = [];
  let left = amount;
  for (const row of outstanding) {
    if (left <= 0) break;
    const take = round2(Math.min(left, row.balance_due));
    allocate.run(paymentId, row.id, take);
    allocations.push({ purchase_id: row.id, purchase_number: row.purchase_number, amount: take, cleared: take >= row.balance_due });
    left = round2(left - take);
  }

  return { payment_id: paymentId, amount, owed_before: owed, owed_after: round2(owed - amount), allocations };
};

/** The payments that went towards one purchase, oldest first. */
const purchasePaymentsOf = (purchaseId: number) =>
  db.prepare(`
    SELECT sp.id AS payment_id, a.amount, sp.amount AS payment_amount, sp.paid_on, sp.method, sp.reference,
           sp.note, sp.user_name, sp.created_at
    FROM supplier_payment_allocations a
    JOIN supplier_payments sp ON sp.id = a.payment_id
    WHERE a.purchase_id = ?
    ORDER BY sp.paid_on ASC, sp.id ASC
  `).all(purchaseId);

/** A payment date: today if not given, and never in the future. */
const readPaidOn = (value: unknown) => {
  const { today } = getISTDateParts();
  const paidOn = optDate(value, 'Payment date') ?? today;
  if (paidOn > today) fail('The payment date cannot be in the future');
  return paidOn;
};

app.post('/api/purchases', authenticateToken, requireAdmin, route((req, res) => {
  const supplier_name = reqString(req.body?.supplier_name, 'Supplier name', 200);
  const supplier_phone = optString(req.body?.supplier_phone, 'Supplier phone', 20);
  const supplier_address = optString(req.body?.supplier_address, 'Supplier address', 500);
  const supplier_gstin = optString(req.body?.supplier_gstin, 'Supplier GSTIN', 20);
  const invoice_number = optString(req.body?.invoice_number, 'Invoice number', 100);
  const invoice_date = optString(req.body?.invoice_date, 'Invoice date', 20);
  const notes = optString(req.body?.notes, 'Notes', 1000);
  // Paid now, in part or in full. Whatever is not paid is owed to the
  // supplier and appears under Purchase Credit. The method is optional.
  const amount_paid = round2(num(req.body?.amount_paid, 'Amount paid', { min: 0, max: 1_000_000_000, fallback: 0 }));
  const paymentMethod = optPaymentMethod(req.body?.payment_method);
  const paymentReference = optString(req.body?.payment_reference, 'Payment reference', 100);
  const { items } = req.body ?? {};

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'At least one purchase item is required' });
    return;
  }
  if (items.length > MAX_PURCHASE_LINE_ITEMS) {
    res.status(400).json({ error: `A purchase cannot have more than ${MAX_PURCHASE_LINE_ITEMS} line items` });
    return;
  }

  // Every amount below is recomputed from quantity, unit cost and tax rate.
  //
  // This route previously wrote subtotal_amount, tax_amount, total_amount and
  // each line's sgst/cgst/igst amounts straight from the request body. Those
  // numbers are the shop's input-tax-credit claim: a tampered request (or just
  // a client-side rounding bug) could book tax the shop never paid, and a
  // negative quantity would have *decremented* stock through a purchase entry.
  const parsedItems = items.map((item: any) => {
    // A line is either an existing item (item_id) or a new one (new_item):
    // a name, HSN code and unit. A new item is created only when this whole
    // purchase saves, in the same transaction — never on its own.
    const isNew = item?.new_item != null;
    if (isNew && item?.item_id != null) fail('A purchase line is either an existing item or a new one, not both');
    return {
    item_id: isNew ? null : rowId(item?.item_id, 'Purchase item id'),
    new_item: isNew
      ? {
          name: reqString(item.new_item?.name, 'New item name', 200),
          hsn_code: reqString(item.new_item?.hsn_code, 'HSN code for the new item', 20),
          metric: oneOf(item.new_item?.metric, UNIT_VALUES, 'Unit for the new item'),
        }
      : null,
    quantity: num(item?.quantity, 'Quantity', { min: 0, max: 1_000_000 }),
    unit_cost: num(item?.unit_cost, 'Unit cost', { min: 0, max: 10_000_000 }),
    sgst_rate: num(item?.sgst_rate, 'SGST rate', { min: 0, max: 100, fallback: 0 }),
    cgst_rate: num(item?.cgst_rate, 'CGST rate', { min: 0, max: 100, fallback: 0 }),
    igst_rate: num(item?.igst_rate, 'IGST rate', { min: 0, max: 100, fallback: 0 }),
    // What this stock will sell for, GST-inclusive. Set here, at purchase, so
    // every batch carries its own price and FIFO billing can charge it. The
    // profit margin is derived from it rather than trusted from the client.
    selling_price: round2(num(item?.selling_price, 'Selling price', { min: 0.01, max: 10_000_000 })),
    };
  });

  if (parsedItems.some((item) => round3(item.quantity) <= 0)) {
    fail('Every purchase item needs a quantity greater than 0');
  }
  for (const item of parsedItems) {
    if (item.sgst_rate + item.cgst_rate + item.igst_rate > 100) {
      fail('Total GST rate on a purchase line cannot exceed 100%');
    }
    // A line is either intra-state (SGST+CGST) or inter-state (IGST).
    if (item.igst_rate > 0 && (item.sgst_rate > 0 || item.cgst_rate > 0)) {
      fail('A purchase line cannot have both IGST and SGST/CGST');
    }
  }

  // Recompute each line, mirroring the client's arithmetic in src/pages/Purchases.tsx.
  const lineItems = parsedItems.map((item) => {
    const taxableValue = round2(item.quantity * item.unit_cost);
    const sgst_amount = round2((taxableValue * item.sgst_rate) / 100);
    const cgst_amount = round2((taxableValue * item.cgst_rate) / 100);
    const igst_amount = round2((taxableValue * item.igst_rate) / 100);
    return {
      ...item,
      taxableValue,
      sgst_amount,
      cgst_amount,
      igst_amount,
      total_amount: round2(taxableValue + sgst_amount + cgst_amount + igst_amount),
    };
  });

  const subtotal_amount = round2(lineItems.reduce((acc, line) => acc + line.taxableValue, 0));
  const tax_amount = round2(
    lineItems.reduce((acc, line) => acc + line.sgst_amount + line.cgst_amount + line.igst_amount, 0)
  );
  const total_amount = round2(subtotal_amount + tax_amount);
  if (amount_paid > total_amount) {
    fail(`Amount paid (₹${amount_paid.toFixed(2)}) is more than the purchase total (₹${total_amount.toFixed(2)})`);
  }

  const transaction = db.transaction(() => {
    const purchase_number = nextDocumentNumber('PUR');

    const supplier_id = upsertSupplier({
      name: supplier_name,
      phone: supplier_phone ?? undefined,
      address: supplier_address ?? undefined,
      gstin: supplier_gstin ?? undefined,
    });

    const purchaseResult = db.prepare(`
      INSERT INTO purchases (
        purchase_number, supplier_id, supplier_name, supplier_phone, supplier_address, supplier_gstin,
        invoice_number, invoice_date, notes, user_id, subtotal_amount, tax_amount, total_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      purchase_number,
      supplier_id,
      supplier_name,
      supplier_phone,
      supplier_address,
      supplier_gstin,
      invoice_number,
      invoice_date,
      notes,
      req.user.id,
      subtotal_amount,
      tax_amount,
      total_amount
    );

    const purchase_id = Number(purchaseResult.lastInsertRowid);

    const selectItem = db.prepare(`
      SELECT id, name, hsn_code, metric, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate
      FROM items WHERE id = ?
    `);
    const insertPurchaseItem = db.prepare(`
      INSERT INTO purchase_items (
        purchase_id, item_id, item_name, hsn_code, metric, quantity, unit_cost,
        sgst_rate, cgst_rate, igst_rate, sgst_amount, cgst_amount, igst_amount, total_amount,
        selling_price, profit_percent
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertBatch = db.prepare(`
      INSERT INTO stock_batches
        (item_id, source, purchase_id, purchase_item_id, quantity_received, quantity_remaining, unit_cost, selling_price)
      VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?)
    `);
    const rememberMargin = db.prepare('UPDATE items SET default_profit_percent = ? WHERE id = ?');

    // New items on this purchase. Their sale GST is the GST on the line they
    // were bought on: one place to enter it, so the two cannot disagree. The
    // item can still be edited later in Items.
    const findByName = db.prepare('SELECT id FROM items WHERE lower(trim(name)) = lower(trim(?))');
    const insertNewItem = db.prepare(`
      INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
      VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);
    const createdItems: Array<{ id: number; name: string }> = [];
    const newNames = new Set<string>();
    const createItemFor = (line: (typeof lineItems)[number]) => {
      const { name, hsn_code, metric } = line.new_item!;
      const key = name.trim().toLowerCase();
      if (newNames.has(key)) {
        throw new ValidationError(`"${name}" is on this purchase twice as a new item. Enter it once, or pick it on the second line.`);
      }
      if (findByName.get(name)) {
        throw new ValidationError(`"${name}" is already an item. Pick it from the list instead of adding it again.`);
      }
      newNames.add(key);
      const isIgst = line.igst_rate > 0;
      const gstRate = isIgst ? line.igst_rate : line.sgst_rate + line.cgst_rate;
      const created = insertNewItem.run(
        name, hsn_code, metric, isLooseUnit(metric) ? 1 : 0, gstRate > 0 ? 1 : 0,
        isIgst ? 'igst' : 'split', gstRate,
        isIgst ? 0 : line.sgst_rate, isIgst ? 0 : line.cgst_rate, isIgst ? line.igst_rate : 0
      );
      const id = Number(created.lastInsertRowid);
      createdItems.push({ id, name });
      return id;
    };

    for (const line of lineItems) {
      const itemId = line.new_item ? createItemFor(line) : line.item_id;
      const existingItem = selectItem.get(itemId) as any;
      if (!existingItem) {
        throw new ValidationError(`Item not found for purchase entry: ${line.item_id}`);
      }

      // The margin is worked out here, from the cost and the selling price the
      // owner set, and stored with the line for reports. It is not shown on
      // the purchase screen.
      const profitPercent = profitPercentFromSellingPrice(line.unit_cost, line.selling_price, saleGstRate(existingItem));
      const purchaseItem = insertPurchaseItem.run(
        purchase_id,
        existingItem.id,
        existingItem.name,
        existingItem.hsn_code,
        existingItem.metric,
        line.quantity,
        line.unit_cost,
        line.sgst_rate,
        line.cgst_rate,
        line.igst_rate,
        line.sgst_amount,
        line.cgst_amount,
        line.igst_amount,
        line.total_amount,
        line.selling_price,
        profitPercent
      );

      // The stock arrives as its own batch, queued behind whatever is already
      // on the shelf. The item's selling price only moves to this batch's
      // price once the older stock has sold.
      const quantity = round3(line.quantity);
      insertBatch.run(
        existingItem.id, purchase_id, Number(purchaseItem.lastInsertRowid),
        quantity, quantity, line.unit_cost, line.selling_price
      );
      rememberMargin.run(profitPercent, existingItem.id);
      syncItemStock(existingItem.id);
    }

    if (amount_paid > 0) {
      recordSupplierPayment({
        supplierId: supplier_id!,
        purchaseId: purchase_id,
        amount: amount_paid,
        paidOn: getISTDateParts().today,
        method: paymentMethod,
        reference: paymentReference,
        note: `Paid at purchase ${purchase_number}`,
        user: req.user,
      });
    }

    return { purchase_id, purchase_number, created_items: createdItems };
  });

  const result = transaction();
  analyticsCache = null; // stock and what is owed to suppliers both moved
  const balance_due = round2(total_amount - amount_paid);
  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'purchase',
    entityId: result.purchase_id,
    details: `Created purchase ${result.purchase_number} from ${supplier_name} for amount ₹${total_amount.toFixed(2)}` +
      (balance_due > 0 ? ` (paid ₹${amount_paid.toFixed(2)}, ₹${balance_due.toFixed(2)} on credit)` : ' (paid in full)'),
  });
  for (const item of result.created_items) {
    writeAuditLog({
      user: req.user,
      action: 'create',
      entityType: 'item',
      entityId: item.id,
      details: `Created item ${item.name} on purchase ${result.purchase_number}`,
    });
  }
  res.status(201).json({ ...result, subtotal_amount, tax_amount, total_amount, amount_paid, balance_due });
}));

app.get('/api/purchases', authenticateToken, requireAdmin, route((req, res) => {
  const { limit, offset } = readPaging(req);
  // Date filtering, so the Reports screen can bound purchases the same way it
  // bounds sales. Without it that page pulled the most recent 1000 purchases
  // and filtered them in the browser, so selecting an older range on a shop
  // with more than 1000 purchases showed no purchases at all.
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');
  // Purchase history's search box: the purchase or supplier invoice number,
  // the supplier, or an item on the purchase.
  const search = optString(req.query.search, 'search', 100);

  const IST_P = "date(datetime(p.created_at, '+5 hours', '+30 minutes'))";
  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push(`${IST_P} >= ?`); params.push(from); }
  if (to) { where.push(`${IST_P} <= ?`); params.push(to); }
  if (search) {
    const like = `%${search}%`;
    where.push(`(p.purchase_number LIKE ? OR p.supplier_name LIKE ? OR p.invoice_number LIKE ?
      OR EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.purchase_id = p.id AND pi.item_name LIKE ?))`);
    params.push(like, like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const purchases = db.prepare(`
    SELECT p.*, u.name as user_name, ${PURCHASE_PAID_SQL} AS amount_paid,
           ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) AS balance_due
    FROM purchases p
    JOIN users u ON p.user_id = u.id
    ${whereSql}
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const { total } = db.prepare(`SELECT COUNT(*) as total FROM purchases p ${whereSql}`).get(...params) as any;

  res.json({ data: purchases, total, limit, offset });
}));

app.get('/api/purchases/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const purchase = db.prepare(`
    SELECT p.*, u.name as user_name, ${PURCHASE_PAID_SQL} AS amount_paid,
           ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) AS balance_due
    FROM purchases p
    JOIN users u ON p.user_id = u.id
    WHERE p.id = ?
  `).get(id);

  if (!purchase) {
    res.status(404).json({ error: 'Purchase not found' });
    return;
  }

  const items = db.prepare(`
    SELECT *
    FROM purchase_items
    WHERE purchase_id = ?
    ORDER BY id ASC
  `).all(id);

  res.json({ ...purchase as object, items, payments: purchasePaymentsOf(id) });
}));

/**
 * Purchase credit: everything still owed to suppliers, by supplier, oldest
 * invoice first. The Purchase Credit page.
 */
app.get('/api/purchase-credit', authenticateToken, requireAdmin, route((_req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.purchase_number, p.supplier_id, p.supplier_name AS invoice_supplier_name,
           p.invoice_number, p.invoice_date, p.created_at, p.total_amount,
           ${PURCHASE_PAID_SQL} AS amount_paid,
           ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) AS balance_due,
           CAST(julianday(date('now', '+5 hours', '+30 minutes'))
                - julianday(COALESCE(NULLIF(p.invoice_date, ''), date(datetime(p.created_at, '+5 hours', '+30 minutes'))))
                AS INTEGER) AS age_days,
           s.name AS supplier_name, s.phone AS supplier_phone, s.gstin AS supplier_gstin
    FROM purchases p
    JOIN suppliers s ON s.id = p.supplier_id
    WHERE ROUND(p.total_amount - ${PURCHASE_PAID_SQL}, 2) > 0
    ORDER BY ${PURCHASE_AGE_ORDER_SQL}
  `).all() as any[];

  const bySupplier = new Map<number, any>();
  for (const row of rows) {
    let supplier = bySupplier.get(row.supplier_id);
    if (!supplier) {
      supplier = {
        supplier_id: row.supplier_id,
        name: row.supplier_name,
        phone: row.supplier_phone,
        gstin: row.supplier_gstin,
        total_due: 0,
        oldest_age_days: row.age_days,
        purchases: [],
      };
      bySupplier.set(row.supplier_id, supplier);
    }
    supplier.total_due = round2(supplier.total_due + row.balance_due);
    supplier.oldest_age_days = Math.max(supplier.oldest_age_days, row.age_days);
    const { supplier_name: _n, supplier_phone: _p, supplier_gstin: _g, ...purchase } = row;
    supplier.purchases.push(purchase);
  }

  // Most owed first: the supplier the owner most needs to think about.
  const suppliers = [...bySupplier.values()].sort((a, b) => b.total_due - a.total_due || a.name.localeCompare(b.name));
  res.json({
    total_due: round2(suppliers.reduce((acc, supplier) => acc + supplier.total_due, 0)),
    purchase_count: rows.length,
    suppliers,
  });
}));

/**
 * Fully paid purchases, most recently settled first: the Payments Done page.
 * `from`/`to` bound the day the last payment cleared it.
 */
app.get('/api/paid-purchases', authenticateToken, requireAdmin, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');
  const search = optString(req.query.search, 'search', 100);

  const where = ['ROUND(p.total_amount - paid.amount, 2) <= 0'];
  const params: any[] = [];
  if (from) { where.push('paid.paid_off_on >= ?'); params.push(from); }
  if (to) { where.push('paid.paid_off_on <= ?'); params.push(to); }
  if (search) {
    where.push('(s.name LIKE ? OR p.supplier_name LIKE ? OR p.purchase_number LIKE ? OR p.invoice_number LIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  const baseSql = `
    FROM purchases p
    JOIN suppliers s ON s.id = p.supplier_id
    JOIN (
      SELECT a.purchase_id, ROUND(SUM(a.amount), 2) AS amount, MAX(sp.paid_on) AS paid_off_on,
             COUNT(*) AS payment_count, GROUP_CONCAT(DISTINCT sp.method) AS methods
      FROM supplier_payment_allocations a
      JOIN supplier_payments sp ON sp.id = a.payment_id
      GROUP BY a.purchase_id
    ) paid ON paid.purchase_id = p.id
    WHERE ${where.join(' AND ')}
  `;

  const rows = db.prepare(`
    SELECT p.id, p.purchase_number, p.supplier_id, s.name AS supplier_name, p.invoice_number, p.invoice_date,
           p.created_at, p.total_amount, paid.amount AS amount_paid, paid.paid_off_on, paid.payment_count, paid.methods
    ${baseSql}
    ORDER BY paid.paid_off_on DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
  const summary = db.prepare(`SELECT COUNT(*) AS total, ROUND(COALESCE(SUM(p.total_amount), 0), 2) AS total_amount ${baseSql}`)
    .get(...params) as any;

  res.json({ data: rows, total: summary.total, total_amount: summary.total_amount, limit, offset });
}));

/**
 * Every payment made to suppliers, newest first, with the purchases each one
 * settled. The payment register an auditor reads.
 */
app.get('/api/supplier-payments', authenticateToken, requireAdmin, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');
  const supplierId = optRowId(req.query.supplier_id, 'Supplier');

  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push('sp.paid_on >= ?'); params.push(from); }
  if (to) { where.push('sp.paid_on <= ?'); params.push(to); }
  if (supplierId) { where.push('sp.supplier_id = ?'); params.push(supplierId); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const payments = db.prepare(`
    SELECT sp.*, s.name AS supplier_name
    FROM supplier_payments sp
    JOIN suppliers s ON s.id = sp.supplier_id
    ${whereSql}
    ORDER BY sp.paid_on DESC, sp.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];
  const summary = db.prepare(`
    SELECT COUNT(*) AS total, ROUND(COALESCE(SUM(sp.amount), 0), 2) AS total_amount FROM supplier_payments sp ${whereSql}
  `).get(...params) as any;

  const allocationsOf = db.prepare(`
    SELECT a.amount, p.id AS purchase_id, p.purchase_number, p.invoice_number
    FROM supplier_payment_allocations a JOIN purchases p ON p.id = a.purchase_id
    WHERE a.payment_id = ? ORDER BY a.id
  `);
  for (const payment of payments) payment.allocations = allocationsOf.all(payment.id);

  res.json({ data: payments, total: summary.total, total_amount: summary.total_amount, limit, offset });
}));

/**
 * The owner paid a supplier. With `purchase_id`, against that purchase;
 * otherwise against the supplier's oldest unpaid purchases first.
 */
app.post('/api/supplier-payments', authenticateToken, requireAdmin, route((req, res) => {
  const purchaseId = optRowId(req.body?.purchase_id, 'Purchase');
  let supplierId = optRowId(req.body?.supplier_id, 'Supplier');
  const amount = round2(num(req.body?.amount, 'Payment amount', { min: 0.01, max: 1_000_000_000 }));
  const paidOn = readPaidOn(req.body?.paid_on);
  const method = optPaymentMethod(req.body?.method);
  const reference = optString(req.body?.reference, 'Reference', 100);
  const note = optString(req.body?.note, 'Note', 300);

  if (purchaseId) {
    const purchase = db.prepare('SELECT supplier_id FROM purchases WHERE id = ?').get(purchaseId) as any;
    if (!purchase) {
      res.status(404).json({ error: 'Purchase not found' });
      return;
    }
    if (supplierId && supplierId !== purchase.supplier_id) fail('That purchase is from a different supplier');
    supplierId = purchase.supplier_id;
  }
  if (!supplierId) fail('Choose the supplier that was paid');
  const supplier = db.prepare('SELECT id, name FROM suppliers WHERE id = ?').get(supplierId) as any;
  if (!supplier) {
    res.status(404).json({ error: 'Supplier not found' });
    return;
  }

  const result = db.transaction(() => recordSupplierPayment({
    supplierId: supplier.id, purchaseId, amount, paidOn, method, reference, note, user: req.user,
  }))();
  analyticsCache = null;

  writeAuditLog({
    user: req.user,
    action: 'supplier_payment',
    entityType: 'supplier',
    entityId: supplier.id,
    details: `Paid ₹${amount.toFixed(2)} to ${supplier.name} on ${paidOn}` +
      (method ? ` by ${PAYMENT_METHOD_LABELS[method]}` : '') +
      (reference ? ` (ref ${reference})` : '') +
      `, against ${result.allocations.map((a) => `${a.purchase_number} ₹${a.amount.toFixed(2)}`).join(', ')}` +
      `; owed ${result.owed_before.toFixed(2)} -> ${result.owed_after.toFixed(2)}`,
  });
  res.status(201).json(result);
}));

/**
 * Undo a payment entered by mistake. The purchases it settled owe that money
 * again and, if they had been cleared, go back to Purchase Credit.
 */
app.delete('/api/supplier-payments/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const payment = db.prepare(`
    SELECT sp.*, s.name AS supplier_name FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id WHERE sp.id = ?
  `).get(id) as any;
  if (!payment) {
    res.status(404).json({ error: 'Payment not found' });
    return;
  }

  db.transaction(() => {
    db.prepare('DELETE FROM supplier_payment_allocations WHERE payment_id = ?').run(id);
    db.prepare('DELETE FROM supplier_payments WHERE id = ?').run(id);
  })();
  analyticsCache = null;

  writeAuditLog({
    user: req.user,
    action: 'delete',
    entityType: 'supplier_payment',
    entityId: id,
    details: `Removed payment of ₹${round2(payment.amount).toFixed(2)} to ${payment.supplier_name} dated ${payment.paid_on}` +
      (payment.method ? ` (${PAYMENT_METHOD_LABELS[payment.method as PaymentMethod]})` : ''),
  });
  res.json({ success: true });
}));

// Reports previously returned every line item ever recorded. Bound them to a
// date window (defaulting to the current month) with an explicit row cap, so a
// single report request can't exhaust memory once the shop has years of data.
// A single response of 50k rows took 866ms to build and megabytes to ship.
// Reports now page like every other list; the cap is the ceiling, not the
// default.
const MAX_REPORT_ROWS = 5_000;
const DEFAULT_REPORT_ROWS = 500;

const readReportRange = (req: express.Request) => {
  const { today, startOfMonth } = getISTDateParts();
  return {
    from: optDate(req.query.from, 'from') || startOfMonth,
    to: optDate(req.query.to, 'to') || today,
    limit: Math.min(
      num(req.query.limit, 'limit', { min: 1, max: MAX_REPORT_ROWS, fallback: DEFAULT_REPORT_ROWS }),
      MAX_REPORT_ROWS
    ),
    offset: num(req.query.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: 0 }),
  };
};

app.get('/api/reports/purchase-items', authenticateToken, requireAdmin, route(async (req, res) => {
  const { from, to, limit, offset } = readReportRange(req);

  const json = await readPool.json(`
    SELECT
      p.id as purchase_id,
      p.purchase_number,
      p.supplier_name,
      p.supplier_phone,
      p.supplier_gstin,
      p.invoice_number,
      p.invoice_date,
      p.created_at,
      u.name as user_name,
      pi.item_id,
      pi.item_name,
      pi.hsn_code,
      pi.metric,
      pi.quantity,
      pi.unit_cost,
      pi.sgst_rate,
      pi.cgst_rate,
      pi.igst_rate,
      pi.sgst_amount,
      pi.cgst_amount,
      pi.igst_amount,
      pi.total_amount,
      pi.selling_price,
      pi.profit_percent
    FROM purchase_items pi
    JOIN purchases p ON pi.purchase_id = p.id
    JOIN users u ON p.user_id = u.id
    WHERE date(datetime(p.created_at, '+5 hours', '+30 minutes')) BETWEEN ? AND ?
    ORDER BY p.created_at DESC, p.id DESC, pi.id ASC
    LIMIT ? OFFSET ?
  `, [from, to, limit, offset], { from, to, limit, offset });

  res.type('application/json').send(json);
}));

app.get('/api/reports/sales-items', authenticateToken, requireAdmin, route(async (req, res) => {
  const { from, to, limit, offset } = readReportRange(req);

  const json = await readPool.json(`
    SELECT
      b.id as bill_id,
      b.bill_number,
      b.payment_method,
      b.created_at,
      c.name as customer_name,
      c.shop_name as customer_shop_name,
      c.phone as customer_phone,
      u.name as cashier_name,
      bi.item_id,
      i.name as item_name,
      i.hsn_code,
      i.metric,
      bi.quantity,
      bi.price,
      bi.sgst_amount,
      bi.cgst_amount,
      bi.igst_amount,
      bi.total_amount
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    JOIN items i ON bi.item_id = i.id
    JOIN users u ON b.user_id = u.id
    LEFT JOIN customers c ON b.customer_id = c.id
    WHERE date(datetime(b.created_at, '+5 hours', '+30 minutes')) BETWEEN ? AND ?
    ORDER BY b.created_at DESC, b.id DESC, bi.id ASC
    LIMIT ? OFFSET ?
  `, [from, to, limit, offset], { from, to, limit, offset });

  res.type('application/json').send(json);
}));

// --- Analytics Routes ---
/**
 * Dashboard figures are aggregates over the whole day/month — they do not need
 * to be accurate to the second, and the admin landing page is often reloaded.
 * A short TTL turns repeat visits into an instant hit instead of re-running
 * five aggregate queries.
 */
const ANALYTICS_TTL_MS = 60_000;
let analyticsCache: { at: number; payload: unknown } | null = null;

// Stock at or below this counts as "low" on the dashboard.
const LOW_STOCK_THRESHOLD = Number(process.env.LOW_STOCK_THRESHOLD) || 10;
// The panel is a prompt to reorder, not a full stock report.
const LOW_STOCK_LIMIT = 50;

app.get('/api/analytics', authenticateToken, requireAdmin, route(async (_req, res) => {
  if (analyticsCache && Date.now() - analyticsCache.at < ANALYTICS_TTL_MS) {
    res.json(analyticsCache.payload);
    return;
  }

  const { today, startOfMonth } = getISTDateParts();
  const IST = "datetime(created_at, '+5 hours', '+30 minutes')";
  const IST_B = "datetime(b.created_at, '+5 hours', '+30 minutes')";

  // All five run on the read workers. Previously they ran inline and the
  // dashboard froze every till for ~6 seconds.
  const [todayRevenue, monthRevenue, topItems, salesByDay, paymentMethods, lowStock, supplierDue] = await Promise.all([
    // COUNT alongside SUM: the dashboard's order tile used to infer a count by
    // tallying how many of the last 30 days had any revenue, which is a count
    // of trading days, not of bills.
    readPool.get(`SELECT SUM(total_amount) as total, COUNT(*) as bills FROM bills WHERE date(${IST}) = ?`, [today]),
    readPool.get(`SELECT SUM(total_amount) as total, COUNT(*) as bills FROM bills WHERE date(${IST}) >= ?`, [startOfMonth]),
    // Drive from bills (indexed on the IST date) and join down into
    // bill_items, instead of scanning all 5.2M line items and looking up each
    // parent bill to test its date. Also narrowed 365 -> 90 days: a "top
    // sellers" panel is about current demand, and the extra 9 months cost far
    // more than they inform.
    // CROSS JOIN is SQLite's documented "do not reorder" hint. Left to itself
    // the planner scans all of bill_items and looks up each parent bill to
    // test its date; forcing it to start from the date-indexed bills table and
    // fan out was 8x faster on a 1.27M-bill database (20.0s -> 2.5s).
    readPool.all(
      `SELECT i.name, SUM(bi.quantity) as total_qty
       FROM bills b
       CROSS JOIN bill_items bi ON bi.bill_id = b.id
       CROSS JOIN items i ON i.id = bi.item_id
       WHERE date(${IST_B}) >= date(?, '-90 days')
       GROUP BY bi.item_id
       ORDER BY total_qty DESC
       LIMIT 5`,
      [today]
    ),
    readPool.all(
      `SELECT date(${IST}) as date, SUM(total_amount) as revenue
       FROM bills WHERE date(${IST}) >= date(?, '-30 days')
       GROUP BY date(${IST}) ORDER BY date ASC`,
      [today]
    ),
    readPool.all(
      `SELECT payment_method, COUNT(*) as count, SUM(total_amount) as total
       FROM bills WHERE date(${IST}) >= ? GROUP BY payment_method`,
      [startOfMonth]
    ),
    // Computed here rather than in the browser. The dashboard used to filter
    // the client-side item cache, which holds at most the first 1000 items by
    // name — so a shop with a larger catalogue was never told about low stock
    // on anything past "H", and the page showed "All items are in stock".
    readPool.all(
      `SELECT id, name, hsn_code, metric, stock_quantity
       FROM items
       WHERE stock_quantity <= ?
       ORDER BY stock_quantity ASC, name ASC
       LIMIT ?`,
      [LOW_STOCK_THRESHOLD, LOW_STOCK_LIMIT]
    ),
    // What the shop owes its suppliers: purchases not yet fully paid.
    readPool.get(
      `SELECT ROUND(COALESCE(SUM(due), 0), 2) AS total, COUNT(DISTINCT supplier_id) AS suppliers
       FROM (SELECT p.supplier_id, p.total_amount - ${PURCHASE_PAID_SQL} AS due FROM purchases p)
       WHERE due > 0.005`,
      []
    ),
  ]);

  const payload = {
    todayRevenue: todayRevenue?.total || 0,
    todayBillCount: todayRevenue?.bills || 0,
    monthRevenue: monthRevenue?.total || 0,
    monthBillCount: monthRevenue?.bills || 0,
    topItems: topItems || [],
    salesByDay: salesByDay || [],
    paymentMethods: paymentMethods || [],
    lowStock: lowStock || [],
    lowStockThreshold: LOW_STOCK_THRESHOLD,
    supplierDue: supplierDue?.total || 0,
    supplierDueCount: supplierDue?.suppliers || 0,
  };
  analyticsCache = { at: Date.now(), payload };
  res.json(payload);
}));

/**
 * Stock on hand, item by item: the Stock page.
 *
 * Each item's quantity is what its batches hold (items.stock_quantity is the
 * cache syncItemStock() keeps of exactly that), with its status against
 * LOW_STOCK_THRESHOLD, what it sells at next, what the stock is worth, how
 * fast it has sold over the last 30 days, and so roughly how long it will
 * last. Cost — and so value at cost — is for admins only, as on the batches.
 */
const STOCK_SALES_WINDOW_DAYS = 30;

app.get('/api/stock', authenticateToken, route(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const rows = await readPool.all(`
    SELECT i.id, i.name, i.hsn_code, i.metric, i.price, i.stock_quantity,
           (SELECT COUNT(*) FROM stock_batches b WHERE b.item_id = i.id AND b.quantity_remaining > 0) AS batch_count,
           (SELECT COUNT(DISTINCT b.selling_price) FROM stock_batches b WHERE b.item_id = i.id AND b.quantity_remaining > 0) AS price_count,
           (SELECT ROUND(COALESCE(SUM(b.quantity_remaining * b.selling_price), 0), 2)
              FROM stock_batches b WHERE b.item_id = i.id AND b.quantity_remaining > 0) AS value_at_price,
           (SELECT ROUND(COALESCE(SUM(b.quantity_remaining * b.unit_cost), 0), 2)
              FROM stock_batches b WHERE b.item_id = i.id AND b.quantity_remaining > 0 AND b.unit_cost IS NOT NULL) AS value_at_cost,
           (SELECT COUNT(*) FROM stock_batches b WHERE b.item_id = i.id AND b.quantity_remaining > 0 AND b.unit_cost IS NULL) AS uncosted_batches,
           (SELECT MAX(b.received_at) FROM stock_batches b WHERE b.item_id = i.id AND b.source = 'purchase') AS last_purchased_at,
           (SELECT MAX(bl.created_at) FROM bill_items bi JOIN bills bl ON bl.id = bi.bill_id WHERE bi.item_id = i.id) AS last_sold_at,
           (SELECT ROUND(COALESCE(SUM(bi.quantity), 0), 3) FROM bill_items bi JOIN bills bl ON bl.id = bi.bill_id
             WHERE bi.item_id = i.id AND bl.created_at >= datetime('now', ?)) AS sold_recent
    FROM items i
    ORDER BY lower(i.name) ASC, i.id ASC
  `, [`-${STOCK_SALES_WINDOW_DAYS} days`]);

  const items = rows.map((row: any) => {
    const quantity = round3(row.stock_quantity || 0);
    const status = quantity <= 0 ? 'out' : quantity <= LOW_STOCK_THRESHOLD ? 'low' : 'in';
    const perDay = row.sold_recent / STOCK_SALES_WINDOW_DAYS;
    const item = {
      ...row,
      stock_quantity: quantity,
      status,
      // Days the stock lasts at the last 30 days' rate; null when it has not sold.
      days_left: quantity > 0 && perDay > 0 ? Math.floor(quantity / perDay) : null,
    };
    if (!isAdmin) {
      const { value_at_cost: _cost, uncosted_batches: _uncosted, ...visible } = item;
      return visible;
    }
    return item;
  });

  const count = (status: string) => items.filter((item: any) => item.status === status).length;
  res.json({
    threshold: LOW_STOCK_THRESHOLD,
    sales_window_days: STOCK_SALES_WINDOW_DAYS,
    summary: {
      item_count: items.length,
      in_stock: count('in'),
      low_stock: count('low'),
      out_of_stock: count('out'),
      value_at_price: round2(items.reduce((acc: number, item: any) => acc + item.value_at_price, 0)),
      ...(isAdmin ? { value_at_cost: round2(items.reduce((acc: number, item: any) => acc + item.value_at_cost, 0)) } : {}),
    },
    items,
  });
}));

// Unknown API paths must not fall through to the SPA handler and return HTML
// to a client expecting JSON.
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// --- Central error handler ---
//
// Routes previously returned `err.message` directly, leaking raw SQLite text
// ("UNIQUE constraint failed: users.username") — which discloses schema
// details and confirms record existence. Validation messages are written to be
// user-facing and are safe to return; everything else is logged and replaced
// with a generic message.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ValidationError) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'Malformed JSON in request body' });
  }
  console.error('[error]', err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// --- Vite Middleware ---
async function startServer() {
  if (!IS_PRODUCTION) {
    // Loaded only here: an installed shop runs in production, where the dev
    // server is never used, and its package does not ship Vite at all.
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    // Built assets have a content hash in their names, so a file never changes:
    // browsers and Cloudflare may keep it for a year.
    app.use('/assets', express.static(path.join(distPath, 'assets'), { immutable: true, maxAge: '365d', index: false }));
    // A missing asset is a 404. It used to get index.html with a 200, which a
    // browser left open across an update then tried to use as its stylesheet
    // (prints came out unstyled) - and Cloudflare cached that for hours.
    app.use('/assets', (_req, res) => {
      res.status(404).type('text/plain').send('Not found');
    });
    app.use(express.static(distPath, { index: false, maxAge: 0 }));
    app.get('*', (req, res) => {
      if (req.path.startsWith('/api/') || path.extname(req.path)) {
        res.status(404).type('text/plain').send('Not found');
        return;
      }
      // The page that names the current assets: never kept anywhere, so after
      // an update every browser loads the new version, not a stale copy that
      // points at files that are gone.
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`Server running on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST === '0.0.0.0' && !IS_PRODUCTION) {
      console.warn(
        '[security] Listening on all network interfaces without TLS. Anyone on this network can read passwords and session tokens in transit. Put the app behind an HTTPS reverse proxy before exposing it.'
      );
    }
  });

  // Flush the WAL and close the database cleanly, so a restart never leaves a
  // half-written transaction behind.
  const shutdown = (signal: string) => {
    console.log(`\n[${signal}] Shutting down...`);
    server.close(() => {
      try {
        readPool.close();
        db.pragma('wal_checkpoint(TRUNCATE)');
        db.close();
      } catch (err) {
        console.error('[shutdown] Error closing database:', err);
      }
      process.exit(0);
    });
    // Don't hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  // Automatic backups: shortly after start (so a laptop that was off overnight
  // catches up), then checked every 15 minutes.
  if (AUTO_BACKUP_HOURS > 0) {
    setTimeout(runAutoBackupIfDue, (Number(process.env.AUTO_BACKUP_FIRST_DELAY_SECONDS) || 60) * 1000).unref();
    setInterval(runAutoBackupIfDue, 15 * 60_000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();
