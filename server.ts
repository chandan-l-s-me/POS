import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import db, { initDb } from './db/index';

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

const buildBackupPayload = () => {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name ASC
  `).all() as { name: string }[];

  const backupData = Object.fromEntries(
    tables.map(({ name }) => {
      // The backup is a plaintext JSON file on disk. Exporting `users` as-is
      // put every bcrypt password hash into it, so anyone who copies a backup
      // (USB stick, cloud sync, email to an accountant) can crack credentials
      // offline at their leisure. Export the account metadata, never the hash.
      if (name === 'users') {
        return [name, db.prepare('SELECT id, username, role, name, is_active FROM users').all()];
      }
      return [name, db.prepare(`SELECT * FROM ${name}`).all()];
    })
  );

  return {
    app: 'VyaparaBilling',
    generated_at: new Date().toISOString(),
    backup_type: 'full',
    tables: backupData,
  };
};

const createLocalBackup = () => {
  const backupPayload = buildBackupPayload();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `vyaparabilling-backup-${timestamp}.json`;
  const backupDirectory = path.join(process.cwd(), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  const filePath = path.join(backupDirectory, fileName);
  // 0600: backups hold every customer's name, phone, address, GSTIN and
  // outstanding balance. Only the account running the server should read them.
  fs.writeFileSync(filePath, JSON.stringify(backupPayload, null, 2), { encoding: 'utf-8', mode: 0o600 });

  return {
    fileName,
    filePath,
  };
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

  if (trimmedUsername && trimmedUsername !== adminUser.username) {
    const existingUser = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(trimmedUsername, req.user.id) as any;
    if (existingUser) {
      res.status(400).json({ error: 'Username already exists' });
      return;
    }
  }

  const nextUsername = trimmedUsername || adminUser.username;
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
    details: `Updated admin account credentials${nextUsername !== adminUser.username ? `, username changed to ${nextUsername}` : ''}`,
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
app.get('/api/audit-logs', authenticateToken, requireAdmin, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const logs = db.prepare(`
    SELECT *
    FROM audit_logs
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM audit_logs').get() as any;

  res.json({ data: logs, total, limit, offset });
}));

// --- Item Routes ---
app.get('/api/items', authenticateToken, (req, res) => {
  const items = db.prepare('SELECT * FROM items ORDER BY name ASC').all();
  res.json(items);
});

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
app.get('/api/customers', authenticateToken, (req, res) => {
  const customers = db.prepare('SELECT * FROM customers ORDER BY name ASC').all();
  res.json(customers);
});

const readCustomerPayload = (body: any) => ({
  name: reqString(body?.name, 'Customer name', 200),
  phone: reqString(body?.phone, 'Customer phone', 20),
  shop_name: optString(body?.shop_name, 'Shop name', 200),
  address: optString(body?.address, 'Address', 500),
  gstin: optString(body?.gstin, 'GSTIN', 20),
});

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

  const result = db.prepare(`
    INSERT INTO customers (name, phone, shop_name, address, gstin, credit_balance)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(customer.name, customer.phone, customer.shop_name, customer.address, customer.gstin, credit_balance);

  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'customer',
    entityId: Number(result.lastInsertRowid),
    details: `Created customer ${customer.name}`,
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

  db.prepare(`
    UPDATE customers
    SET name = ?, phone = ?, shop_name = ?, address = ?, gstin = ?, credit_balance = ?
    WHERE id = ?
  `).run(customer.name, customer.phone, customer.shop_name, customer.address, customer.gstin, nextCreditBalance, id);

  const balanceChanged = nextCreditBalance !== existingCustomer.credit_balance;
  writeAuditLog({
    user: req.user,
    action: 'update',
    entityType: 'customer',
    entityId: id,
    details:
      `Updated customer ${existingCustomer.name} to ${customer.name}` +
      // Balance adjustments are the entry most worth being able to trace later.
      (balanceChanged ? `; credit balance ${existingCustomer.credit_balance} -> ${nextCreditBalance}` : ''),
  });

  res.json({ success: true });
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
      const { sgstUnit, cgstUnit, igstUnit, basePriceUnit } = computeUnitTaxBreakdown(dbItem, totalUnit);

      const lineSgst = round2(sgstUnit * quantity);
      const lineCgst = round2(cgstUnit * quantity);
      const lineIgst = round2(igstUnit * quantity);
      const lineTotal = round2(totalUnit * quantity);

      subtotal_amount += round2(basePriceUnit * quantity);
      tax_amount += lineSgst + lineCgst + lineIgst;

      lineItems.push({
        item_id: dbItem.id,
        quantity,
        price: round2(basePriceUnit),
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
    const total_amount = round2(subtotal_amount + tax_amount - safeDiscount);

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
        bill_number, customer_id, user_id, total_amount, tax_amount, 
        discount_amount, payment_method, cash_amount, upi_amount, credit_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      bill_number, customer_id, req.user.id, total_amount, tax_amount,
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

    // Update customer credit balance if credit_amount > 0
    if (customer_id && credit_amount > 0) {
      db.prepare('UPDATE customers SET credit_balance = credit_balance + ? WHERE id = ?')
        .run(credit_amount, customer_id);
    }

    return { bill_id, bill_number, total_amount };
  });

  const result = transaction();
  writeAuditLog({
    user: req.user,
    action: 'create',
    entityType: 'bill',
    entityId: result.bill_id,
    details: `Created bill ${result.bill_number} for amount ₹${result.total_amount.toFixed(2)}`,
  });
  res.json(result);
}));

app.get('/api/bills', authenticateToken, route((req, res) => {
  const { limit, offset } = readPaging(req);
  const from = optDate(req.query.from, 'from');
  const to = optDate(req.query.to, 'to');

  // Returning every bill ever rung up was fine with a handful of test rows and
  // ruinous at a few lakh a week — hundreds of MB serialised into one response
  // on every page load. Page and date-filter instead.
  const where: string[] = [];
  const params: any[] = [];
  if (from) {
    where.push("date(datetime(b.created_at, '+5 hours', '+30 minutes')) >= ?");
    params.push(from);
  }
  if (to) {
    where.push("date(datetime(b.created_at, '+5 hours', '+30 minutes')) <= ?");
    params.push(to);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const bills = db.prepare(`
    SELECT b.*, c.name as customer_name, u.name as cashier_name
    FROM bills b
    LEFT JOIN customers c ON b.customer_id = c.id
    JOIN users u ON b.user_id = u.id
    ${whereSql}
    ORDER BY b.created_at DESC, b.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const { total } = db.prepare(`
    SELECT COUNT(*) as total FROM bills b ${whereSql}
  `).get(...params) as any;

  res.json({ data: bills, total, limit, offset });
}));

app.get('/api/bills/:id', authenticateToken, route((req, res) => {
  const bill = db.prepare(`
    SELECT b.*, c.name as customer_name, c.phone as customer_phone, c.address as customer_address, c.gstin as customer_gstin, u.name as cashier_name
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
  const purchases = db.prepare(`
    SELECT p.*, u.name as user_name
    FROM purchases p
    JOIN users u ON p.user_id = u.id
    ORDER BY p.created_at DESC, p.id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const { total } = db.prepare('SELECT COUNT(*) as total FROM purchases').get() as any;

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
const MAX_REPORT_ROWS = 50_000;

const readReportRange = (req: express.Request) => {
  const { today, startOfMonth } = getISTDateParts();
  return {
    from: optDate(req.query.from, 'from') || startOfMonth,
    to: optDate(req.query.to, 'to') || today,
    limit: Math.min(
      num(req.query.limit, 'limit', { min: 1, max: MAX_REPORT_ROWS, fallback: MAX_REPORT_ROWS }),
      MAX_REPORT_ROWS
    ),
  };
};

app.get('/api/reports/purchase-items', authenticateToken, requireAdmin, route((req, res) => {
  const { from, to, limit } = readReportRange(req);

  const rows = db.prepare(`
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
    LIMIT ?
  `).all(from, to, limit);

  res.json({ data: rows, from, to, truncated: rows.length === limit });
}));

app.get('/api/reports/sales-items', authenticateToken, requireAdmin, route((req, res) => {
  const { from, to, limit } = readReportRange(req);

  const rows = db.prepare(`
    SELECT
      b.id as bill_id,
      b.bill_number,
      b.payment_method,
      b.created_at,
      c.name as customer_name,
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
    LIMIT ?
  `).all(from, to, limit);

  res.json({ data: rows, from, to, truncated: rows.length === limit });
}));

// --- Analytics Routes ---
app.get('/api/analytics', authenticateToken, requireAdmin, (req, res) => {
  const { today, startOfMonth } = getISTDateParts();

  const todayRevenue = db.prepare(`
    SELECT SUM(total_amount) as total
    FROM bills
    WHERE date(datetime(created_at, '+5 hours', '+30 minutes')) = ?
  `).get(today) as any;
  const monthRevenue = db.prepare(`
    SELECT SUM(total_amount) as total
    FROM bills
    WHERE date(datetime(created_at, '+5 hours', '+30 minutes')) >= ?
  `).get(startOfMonth) as any;
  // Scoped to the last 12 months: an all-time GROUP BY over bill_items scans
  // every row the shop has ever written, on every dashboard load.
  const topItems = db.prepare(`
    SELECT i.name, SUM(bi.quantity) as total_qty
    FROM bill_items bi
    JOIN bills b ON bi.bill_id = b.id
    JOIN items i ON bi.item_id = i.id
    WHERE date(datetime(b.created_at, '+5 hours', '+30 minutes')) >= date(?, '-365 days')
    GROUP BY bi.item_id
    ORDER BY total_qty DESC
    LIMIT 5
  `).all(today);

  const salesByDay = db.prepare(`
    SELECT date(datetime(created_at, '+5 hours', '+30 minutes')) as date, SUM(total_amount) as revenue
    FROM bills
    WHERE date(datetime(created_at, '+5 hours', '+30 minutes')) >= date(?, '-30 days')
    GROUP BY date(datetime(created_at, '+5 hours', '+30 minutes'))
    ORDER BY date ASC
  `).all(today);

  const paymentMethods = db.prepare(`
    SELECT payment_method, COUNT(*) as count, SUM(total_amount) as total
    FROM bills
    WHERE date(datetime(created_at, '+5 hours', '+30 minutes')) >= ?
    GROUP BY payment_method
  `).all(startOfMonth);

  res.json({
    todayRevenue: todayRevenue?.total || 0,
    monthRevenue: monthRevenue?.total || 0,
    topItems: topItems || [],
    salesByDay: salesByDay || [],
    paymentMethods: paymentMethods || []
  });
});

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
