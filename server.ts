import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import db, { initDb } from './db/index';
import { readPool } from './db/asyncRead';

dotenv.config();

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
  return password;
};

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

const throttleKey = (req: express.Request, username: string) =>
  `${req.ip || 'unknown'}::${username.toLowerCase()}`;

const getLockout = (key: string): number => {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  const now = Date.now();
  if (entry.lockedUntil > now) return entry.lockedUntil - now;
  // Window elapsed with no lockout — forget the old failures.
  if (now - entry.firstAttemptAt > LOGIN_WINDOW_MS) loginAttempts.delete(key);
  return 0;
};

const recordLoginFailure = (key: string) => {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.firstAttemptAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, firstAttemptAt: now, lockedUntil: 0 });
    return;
  }
  entry.count += 1;
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
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

// Round to 2 decimal places, guarding against binary floating-point drift
// (e.g. 0.1 + 0.2) accumulating across many line items in a bill.
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// Mirrors the tax-splitting logic in src/store/useCartStore.ts. Kept here so
// the server can recompute bill totals from authoritative item data instead
// of trusting whatever price/tax numbers the client sends.
const computeUnitTaxBreakdown = (item: any, totalUnit: number) => {
  if (!item.gst_applicable) {
    return { sgstUnit: 0, cgstUnit: 0, igstUnit: 0, basePriceUnit: totalUnit };
  }

  const itemMode = item.gst_mode || (item.igst_rate ? 'igst' : 'split');
  if (itemMode === 'igst') {
    const igstUnit = (totalUnit * (item.igst_rate || item.gst_rate || 0)) / 100;
    return { sgstUnit: 0, cgstUnit: 0, igstUnit, basePriceUnit: totalUnit - igstUnit };
  }

  const sgstUnit = (totalUnit * item.sgst_rate) / 100;
  const cgstUnit = (totalUnit * item.cgst_rate) / 100;
  return { sgstUnit, cgstUnit, igstUnit: 0, basePriceUnit: totalUnit - sgstUnit - cgstUnit };
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
const createLocalBackup = () => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `vyaparabilling-backup-${timestamp}.db`;
  const backupDirectory = path.join(process.cwd(), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(backupDirectory, fileName);

  // VACUUM INTO refuses to overwrite, so a stale partial file must go first.
  fs.rmSync(filePath, { force: true });
  db.exec(`VACUUM INTO '${filePath.replace(/'/g, "''")}'`);

  // 0600: backups hold every customer's name, phone, address, GSTIN and
  // outstanding balance. Only the account running the server should read them.
  fs.chmodSync(filePath, 0o600);

  return { fileName, filePath, sizeBytes: fs.statSync(filePath).size };
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

  const key = throttleKey(req, username);
  const lockedForMs = getLockout(key);
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
    // One generic message for every failure mode: wrong user, wrong password,
    // deactivated account. Anything more specific is free reconnaissance.
    res.status(401).json({ error: 'Invalid username or password' });
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

app.get('/api/backups/local/status', authenticateToken, requireAdmin, (req, res) => {
  res.json({
    configured: true,
    backup_directory: path.join(process.cwd(), 'backups'),
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

app.post('/api/backups/local', authenticateToken, requireAdmin, (req, res) => {
  try {
    const result = createLocalBackup();
    writeAuditLog({
      user: req.user,
      action: 'backup',
      entityType: 'system',
      entityId: result.fileName,
      details: `Created local backup ${result.fileName}`,
    });
    res.json({
      success: true,
      ...result,
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create local backup' });
  }
});

// --- Cashier Routes ---
app.get('/api/cashiers', authenticateToken, requireAdmin, (req, res) => {
  const cashiers = db.prepare(`
    SELECT id, username, role, name, is_active
    FROM users
    WHERE role = 'cashier'
    ORDER BY name ASC
  `).all();

  res.json(cashiers);
});

app.post('/api/cashiers', authenticateToken, requireAdmin, route((req, res) => {
  const name = reqString(req.body?.name, 'Name', 100);
  const username = reqString(req.body?.username, 'Username', 100);
  const password = validatePassword(req.body?.password, 'Password');

  const existingUser = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as any;
  if (existingUser) {
    res.status(400).json({ error: 'Username already exists' });
    return;
  }

  const hashedPassword = bcrypt.hashSync(password, BCRYPT_ROUNDS);
  const result = db.prepare(`
    INSERT INTO users (username, password, role, name)
    VALUES (?, ?, 'cashier', ?)
  `).run(username, hashedPassword, name);

  const cashier = db.prepare(`
    SELECT id, username, role, name, is_active
    FROM users
    WHERE id = ?
  `).get(result.lastInsertRowid);

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'cashier',
    entityId: (cashier as any).id,
    details: `Created cashier account ${username} (${name})`,
  });
  res.status(201).json(cashier);
}));

/**
 * Deactivate or reactivate a cashier, and reset their password.
 *
 * There was previously no way to revoke a cashier's access at all — an
 * employee who left kept a working login forever. Deactivating (rather than
 * deleting) preserves the bills they rang up, which the foreign key requires
 * and GST records demand.
 */
app.put('/api/cashiers/:id', authenticateToken, requireAdmin, route((req, res) => {
  const id = rowId(req.params.id);
  const cashier = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'cashier'").get(id) as any;
  if (!cashier) {
    res.status(404).json({ error: 'Cashier not found' });
    return;
  }

  const changes: string[] = [];
  let nextActive = cashier.is_active;
  let nextPassword = cashier.password;
  let bumpTokenVersion = false;

  if (req.body?.is_active !== undefined) {
    nextActive = bool(req.body.is_active);
    if (nextActive !== cashier.is_active) {
      changes.push(nextActive ? 'reactivated' : 'deactivated');
      // Revoke any live session the moment the account is disabled.
      if (!nextActive) bumpTokenVersion = true;
    }
  }

  if (req.body?.new_password !== undefined && req.body.new_password !== '') {
    nextPassword = bcrypt.hashSync(validatePassword(req.body.new_password, 'New password'), BCRYPT_ROUNDS);
    changes.push('password reset');
    bumpTokenVersion = true;
  }

  if (changes.length === 0) {
    res.status(400).json({ error: 'Nothing to update' });
    return;
  }

  db.prepare(`
    UPDATE users
    SET is_active = ?, password = ?, token_version = token_version + ?
    WHERE id = ?
  `).run(nextActive, nextPassword, bumpTokenVersion ? 1 : 0, id);

  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'cashier',
    entityId: id,
    details: `Cashier ${cashier.username}: ${changes.join(', ')}`,
  });

  res.json(db.prepare('SELECT id, username, role, name, is_active FROM users WHERE id = ?').get(id));
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
  'id, name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity';

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
 * Shared validation for item writes. Money and tax rates are bounded: a
 * negative price produced negative revenue, and a >100% rate produced a
 * negative taxable base — both of which flowed straight into GST filings.
 */
const readItemPayload = (body: any) => ({
  name: reqString(body?.name, 'Item name', 200),
  hsn_code: reqString(body?.hsn_code, 'HSN code', 20),
  price: num(body?.price, 'Price', { min: 0, max: 10_000_000 }),
  metric: reqString(body?.metric, 'Metric', 20),
  is_loose: bool(body?.is_loose),
  gst_applicable: bool(body?.gst_applicable),
  gst_mode: oneOf(body?.gst_mode ?? 'split', ['split', 'igst'] as const, 'GST mode'),
  gst_rate: num(body?.gst_rate, 'GST rate', { min: 0, max: 100, fallback: 0 }),
  sgst_rate: num(body?.sgst_rate, 'SGST rate', { min: 0, max: 100, fallback: 0 }),
  cgst_rate: num(body?.cgst_rate, 'CGST rate', { min: 0, max: 100, fallback: 0 }),
  igst_rate: num(body?.igst_rate, 'IGST rate', { min: 0, max: 100, fallback: 0 }),
  image_url: optString(body?.image_url, 'Image URL', 2000),
  stock_quantity: num(body?.stock_quantity, 'Stock quantity', { min: 0, max: 100_000_000, fallback: 0 }),
});

app.post('/api/items', authenticateToken, requireAdmin, route((req, res) => {
  const item = readItemPayload(req.body);
  if (item.sgst_rate + item.cgst_rate > 100) fail('SGST + CGST cannot exceed 100%');

  const result = db.prepare(`
    INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, image_url, stock_quantity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(item.name, item.hsn_code, item.price, item.metric, item.is_loose, item.gst_applicable, item.gst_mode, item.gst_rate, item.sgst_rate, item.cgst_rate, item.igst_rate, item.image_url, item.stock_quantity);

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'item',
    entityId: Number(result.lastInsertRowid),
    details: `Created item ${item.name}`,
  });
  res.json({ id: Number(result.lastInsertRowid) });
}));

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
    UPDATE items SET name = ?, hsn_code = ?, price = ?, metric = ?, is_loose = ?, gst_applicable = ?, gst_mode = ?, gst_rate = ?, sgst_rate = ?, cgst_rate = ?, igst_rate = ?, image_url = ?, stock_quantity = ?
    WHERE id = ?
  `).run(item.name, item.hsn_code, item.price, item.metric, item.is_loose, item.gst_applicable, item.gst_mode, item.gst_rate, item.sgst_rate, item.cgst_rate, item.igst_rate, item.image_url, item.stock_quantity, id);

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
      error: 'This item appears on existing bills or purchases and cannot be deleted. Set its stock to 0 instead.',
    });
    return;
  }

  db.prepare('DELETE FROM items WHERE id = ?').run(id);
  writeAuditLog({
    user: req.user,
    action: 'delete',
    entityType: 'item',
    entityId: id,
    details: `Deleted item ${existingItem.name}`,
  });
  res.json({ success: true });
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

// --- Supplier Routes ---
app.get('/api/suppliers', authenticateToken, requireAdmin, (req, res) => {
  const suppliers = db.prepare(`
    SELECT *
    FROM suppliers
    ORDER BY name ASC
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
    quantity: num(item?.quantity, 'Quantity', { min: 0, max: 1_000_000 }),
  }));
  if (parsedItems.some((item) => item.quantity <= 0)) {
    fail('Every item needs a quantity greater than 0');
  }

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
    const lineItems: Array<{
      item_id: number;
      quantity: number;
      price: number;
      sgst_amount: number;
      cgst_amount: number;
      igst_amount: number;
      total_amount: number;
    }> = [];

    // Hoisted out of the loop: better-sqlite3 caches compiled statements, but
    // re-preparing per line item on every bill is needless work at this volume.
    const selectItem = db.prepare('SELECT * FROM items WHERE id = ?');

    for (const item of parsedItems) {
      const dbItem = selectItem.get(item.id) as any;
      if (!dbItem) {
        throw new ValidationError(`Item not found: ${item.id}`);
      }

      const quantity = item.quantity;
      if (quantity > dbItem.stock_quantity) {
        throw new ValidationError(`Insufficient stock for ${dbItem.name}: requested ${quantity}, only ${dbItem.stock_quantity} available`);
      }

      const totalUnit = dbItem.price;
      const { sgstUnit, cgstUnit, igstUnit } = computeUnitTaxBreakdown(dbItem, totalUnit);

      const lineSgst = round2(sgstUnit * quantity);
      const lineCgst = round2(cgstUnit * quantity);
      const lineIgst = round2(igstUnit * quantity);
      const lineTotal = round2(totalUnit * quantity);

      // Derive the taxable value by SUBTRACTING the already-rounded taxes from
      // the already-rounded line total, rather than rounding
      // (base-price-per-unit x qty) independently. Rounding the two figures
      // separately let them disagree by a paisa, so on the invoice the line
      // amounts did not add up to the printed Subtotal, and Subtotal + Tax did
      // not equal the Grand Total. This keeps the identity
      //     line taxable + line tax === line total
      // exactly true for every row, so the invoice always reconciles.
      const lineTaxable = round2(lineTotal - lineSgst - lineCgst - lineIgst);

      subtotal_amount += lineTaxable;
      tax_amount += lineSgst + lineCgst + lineIgst;

      lineItems.push({
        item_id: dbItem.id,
        quantity,
        // Unit rate consistent with the line taxable value above.
        price: quantity > 0 ? round2(lineTaxable / quantity) : 0,
        sgst_amount: lineSgst,
        cgst_amount: lineCgst,
        igst_amount: lineIgst,
        total_amount: lineTotal,
      });
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
      INSERT INTO bill_items (bill_id, item_id, quantity, price, sgst_amount, cgst_amount, igst_amount, total_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // Conditional UPDATE: even though stock was checked above, two tills
    // selling the last unit concurrently could both pass that check. The
    // WHERE clause makes the deduction fail rather than drive stock negative.
    const deductStock = db.prepare(
      'UPDATE items SET stock_quantity = stock_quantity - ? WHERE id = ? AND stock_quantity >= ?'
    );

    for (const line of lineItems) {
      insertBillItem.run(bill_id, line.item_id, line.quantity, line.price, line.sgst_amount, line.cgst_amount, line.igst_amount, line.total_amount);

      const deduction = deductStock.run(line.quantity, line.item_id, line.quantity);
      if (deduction.changes === 0) {
        throw new ValidationError('Stock changed while this bill was being processed. Please retry.');
      }
    }

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

    return { bill_id, bill_number, subtotal_amount, tax_amount, total_amount };
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

  const items = db.prepare(`
    SELECT bi.*, i.name as item_name, i.hsn_code, i.metric
    FROM bill_items bi
    JOIN items i ON bi.item_id = i.id
    WHERE bi.bill_id = ?
  `).all((bill as any).id);

  res.json({ ...bill as object, items });
}));

// --- Purchase Routes ---
const MAX_PURCHASE_LINE_ITEMS = 500;

app.post('/api/purchases', authenticateToken, requireAdmin, route((req, res) => {
  const supplier_name = reqString(req.body?.supplier_name, 'Supplier name', 200);
  const supplier_phone = optString(req.body?.supplier_phone, 'Supplier phone', 20);
  const supplier_address = optString(req.body?.supplier_address, 'Supplier address', 500);
  const supplier_gstin = optString(req.body?.supplier_gstin, 'Supplier GSTIN', 20);
  const invoice_number = optString(req.body?.invoice_number, 'Invoice number', 100);
  const invoice_date = optString(req.body?.invoice_date, 'Invoice date', 20);
  const notes = optString(req.body?.notes, 'Notes', 1000);
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
  const parsedItems = items.map((item: any) => ({
    item_id: rowId(item?.item_id, 'Purchase item id'),
    quantity: num(item?.quantity, 'Quantity', { min: 0, max: 1_000_000 }),
    unit_cost: num(item?.unit_cost, 'Unit cost', { min: 0, max: 10_000_000 }),
    sgst_rate: num(item?.sgst_rate, 'SGST rate', { min: 0, max: 100, fallback: 0 }),
    cgst_rate: num(item?.cgst_rate, 'CGST rate', { min: 0, max: 100, fallback: 0 }),
    igst_rate: num(item?.igst_rate, 'IGST rate', { min: 0, max: 100, fallback: 0 }),
  }));

  if (parsedItems.some((item) => item.quantity <= 0)) {
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

  const transaction = db.transaction(() => {
    const purchase_number = nextDocumentNumber('PUR');

    upsertSupplier({
      name: supplier_name,
      phone: supplier_phone ?? undefined,
      address: supplier_address ?? undefined,
      gstin: supplier_gstin ?? undefined,
    });

    const purchaseResult = db.prepare(`
      INSERT INTO purchases (
        purchase_number, supplier_name, supplier_phone, supplier_address, supplier_gstin,
        invoice_number, invoice_date, notes, user_id, subtotal_amount, tax_amount, total_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      purchase_number,
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

    const selectItem = db.prepare('SELECT id, name, hsn_code, metric FROM items WHERE id = ?');
    const insertPurchaseItem = db.prepare(`
      INSERT INTO purchase_items (
        purchase_id, item_id, item_name, hsn_code, metric, quantity, unit_cost,
        sgst_rate, cgst_rate, igst_rate, sgst_amount, cgst_amount, igst_amount, total_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const addStock = db.prepare('UPDATE items SET stock_quantity = stock_quantity + ? WHERE id = ?');

    for (const line of lineItems) {
      const existingItem = selectItem.get(line.item_id) as any;
      if (!existingItem) {
        throw new ValidationError(`Item not found for purchase entry: ${line.item_id}`);
      }

      insertPurchaseItem.run(
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
        line.total_amount
      );

      addStock.run(line.quantity, existingItem.id);
    }

    return { purchase_id, purchase_number };
  });

  const result = transaction();
  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'purchase',
    entityId: result.purchase_id,
    details: `Created purchase ${result.purchase_number} from ${supplier_name} for amount ₹${total_amount.toFixed(2)}`,
  });
  res.status(201).json({ ...result, subtotal_amount, tax_amount, total_amount });
}));

app.get('/api/purchases', authenticateToken, requireAdmin, route((req, res) => {
  const { limit, offset } = readPaging(req);
  // Date filtering, so the Reports screen can bound purchases the same way it
  // bounds sales. Without it that page pulled the most recent 1000 purchases
  // and filtered them in the browser, so selecting an older range on a shop
  // with more than 1000 purchases showed no purchases at all.
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');

  const IST_P = "date(datetime(p.created_at, '+5 hours', '+30 minutes'))";
  const where: string[] = [];
  const params: any[] = [];
  if (from) { where.push(`${IST_P} >= ?`); params.push(from); }
  if (to) { where.push(`${IST_P} <= ?`); params.push(to); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const purchases = db.prepare(`
    SELECT p.*, u.name as user_name
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
    SELECT p.*, u.name as user_name
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

  res.json({ ...purchase as object, items });
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
      pi.total_amount
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
  const [todayRevenue, monthRevenue, topItems, salesByDay, paymentMethods, lowStock] = await Promise.all([
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
  };
  analyticsCache = { at: Date.now(), payload };
  res.json(payload);
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
    return res.status(400).json({ error: err.message });
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
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

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startServer();
