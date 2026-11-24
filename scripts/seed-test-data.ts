/**
 * Test data for trying every screen: four months of a bakery-supplies
 * wholesaler, put in through the app's own API.
 *
 *   npx tsx scripts/seed-test-data.ts                 # the database in .env (DB_PATH), or ./pos.db
 *   npx tsx scripts/seed-test-data.ts --db other.db   # another database
 *
 * Unlike scripts/seed-demo.ts, nothing is written around the server: the
 * script starts the real server on a spare port, against the chosen
 * database, and sells, buys, pays and adjusts through the same routes the
 * screens use. So FIFO batches, the customer credit ledger, purchase
 * payments, the activity log and stock all agree, exactly as they would after
 * four months of real use. Each change is then given the date it is meant to
 * have happened on (bills, purchases, payments, batches, ledger and log),
 * oldest first, so passbooks, ageing and reports read like real history.
 *
 * What it fills in, so each screen has something to show:
 *  - Items: 40, with and without barcodes, GST 0/5/18% and one IGST item,
 *    loose goods sold by the kg, prices that rose part-way (FIFO lines split
 *    across two prices), bulk prices, some left out of "my GST", low stock,
 *    out of stock, and items never sold.
 *  - Customers: bakeries and shop-less people; credit owed at every age
 *    (0–30 to 90+ days), repayments, an opening balance, one paid in full.
 *  - Suppliers and purchases: paid at entry, part paid, on credit, paid later
 *    by cash/UPI/bank/cheque, and one bought for cash with no supplier.
 *  - Bills: cash, UPI, credit and split; discounts; bulk prices; by the admin
 *    and two cashiers; one edited and one deleted; some today.
 *  - Stock adjustments with reasons; a repriced batch.
 *
 * It refuses a database that already has items, customers, bills or
 * purchases, so it can never mix itself into a shop's real books. Staff
 * passwords are not changed: the admin signs in as before. Two cashier
 * logins are created with random passwords, printed once at the end.
 *
 * Item and customer names are sent to Google for their Kannada spelling by
 * the app as usual (unless turned off in .env); any not done by the time
 * this finishes are done the next time the app runs.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import {
  allocateFifo, applyBulkPrice, bulkPriceFor, computeLine, priceSegments, round2, round3, type BulkPrice,
} from '../src/lib/billMath';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const argDb = process.argv.indexOf('--db');
const DB_PATH = path.resolve(ROOT, argDb > 0 ? process.argv[argDb + 1] : process.env.DB_PATH || 'pos.db');

// --- Repeatable randomness ---------------------------------------------------

let seedState = 20261117;
const rand = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)];
const chance = (p: number) => rand() < p;

// --- Dates, in the shop's time (IST), stored as UTC like the app does ---------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAYS = 120;

/** `daysAgo` days back at hh:mm IST, as SQLite's UTC text, never later than now. */
const at = (daysAgo: number, hour: number, minute: number) => {
  const istNow = new Date(Date.now() + IST_OFFSET_MS);
  const istWall = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - daysAgo, hour, minute, randInt(0, 59));
  const utc = Math.min(istWall - IST_OFFSET_MS, Date.now() - 60_000);
  return new Date(utc).toISOString().slice(0, 19).replace('T', ' ');
};
/** The IST calendar day of a stored timestamp, for invoice and payment dates. */
const istDay = (stamp: string) => new Date(Date.parse(`${stamp.replace(' ', 'T')}Z`) + IST_OFFSET_MS).toISOString().slice(0, 10);

// --- What the shop sells --------------------------------------------------------

type Unit = 'piece' | 'kg' | 'packet' | 'box' | 'bag';
interface CatalogueItem {
  name: string;
  hsn: string;
  unit: Unit;
  /** GST %, split as CGST + SGST unless `igst`. */
  gst: number;
  igst?: boolean;
  /** Selling price, GST included, at the start. */
  price: number;
  supplier: number;
  /** A pack with a code on it; loose goods have none. */
  barcode?: boolean;
  /** Per bill, as a buyer orders it. */
  qty: [number, number];
  /** Kept in stock about this much. */
  stock: number;
  /** Bought once and never again, so it runs out. */
  discontinued?: boolean;
  /** Price went up this much part-way through. */
  rise?: number;
  notMyGst?: boolean;
  bulk?: BulkPrice[];
  /** Never ordered: shows up as slow-moving stock. */
  unsold?: boolean;
}

const SUPPLIERS = [
  { name: 'Karnataka Flour Mills', phone: '9845011122', address: 'Peenya Industrial Area, Bengaluru 560058', gstin: '29AABCK1234F1Z2' },
  { name: 'Sweet Crystal Traders', phone: '9880022233', address: 'Yeshwanthpur APMC Yard, Bengaluru 560022', gstin: '29AAFCS5678G1Z9' },
  { name: 'Bakewell Ingredients Pvt Ltd', phone: '9741033344', address: 'Bommasandra Industrial Area, Bengaluru 560099', gstin: '29AACCB9012H1Z4' },
  { name: 'Coastal Dairy Distributors', phone: '9632044455', address: 'Hebbal, Bengaluru 560024', gstin: '29AAHCC3456J1Z7' },
  { name: 'Chennai Flavours & Colours', phone: '9444055566', address: 'Ambattur, Chennai 600053', gstin: '33AADCC7890K1Z1' },
];

const CATALOGUE: CatalogueItem[] = [
  // Flours (Karnataka Flour Mills)
  { name: 'Refined Maida - Bakers Grade (25 kg)', hsn: '11010000', unit: 'bag', gst: 5, price: 920, supplier: 0, qty: [1, 6], stock: 60, rise: 0.05, bulk: [{ min_quantity: 10, price: 895 }, { min_quantity: 25, price: 880 }] },
  { name: 'Whole Wheat Atta (25 kg)', hsn: '11010000', unit: 'bag', gst: 5, price: 990, supplier: 0, qty: [1, 4], stock: 30 },
  { name: 'Bombay Rava (1 kg)', hsn: '11031100', unit: 'packet', gst: 5, price: 62, supplier: 0, barcode: true, qty: [2, 10], stock: 80 },
  { name: 'Corn Flour (1 kg)', hsn: '11081200', unit: 'packet', gst: 5, price: 88, supplier: 0, barcode: true, qty: [2, 8], stock: 60 },
  { name: 'Gram Flour / Besan (1 kg)', hsn: '11061000', unit: 'packet', gst: 5, price: 105, supplier: 0, barcode: true, qty: [1, 6], stock: 40 },
  { name: 'Multigrain Bread Premix (5 kg)', hsn: '19012000', unit: 'bag', gst: 18, price: 640, supplier: 0, qty: [1, 2], stock: 8, unsold: true },
  // Sugars (Sweet Crystal Traders)
  { name: 'Sugar - S30 (50 kg)', hsn: '17019910', unit: 'bag', gst: 5, price: 2240, supplier: 1, qty: [1, 4], stock: 40, rise: 0.04, notMyGst: true },
  { name: 'Icing Sugar (1 kg)', hsn: '17019990', unit: 'packet', gst: 5, price: 78, supplier: 1, barcode: true, qty: [2, 12], stock: 90, bulk: [{ min_quantity: 20, price: 74 }] },
  { name: 'Castor Sugar (1 kg)', hsn: '17019990', unit: 'packet', gst: 5, price: 68, supplier: 1, barcode: true, qty: [2, 8], stock: 50 },
  { name: 'Brown Sugar (500 g)', hsn: '17011490', unit: 'packet', gst: 5, price: 58, supplier: 1, barcode: true, qty: [1, 6], stock: 40 },
  { name: 'Liquid Glucose (5 kg)', hsn: '17023090', unit: 'box', gst: 5, price: 430, supplier: 1, qty: [1, 3], stock: 15, discontinued: true },
  { name: 'Jaggery - Loose', hsn: '17011390', unit: 'kg', gst: 0, price: 64, supplier: 1, qty: [2, 10], stock: 80, notMyGst: true },
  // Leavening, improvers, gels (Bakewell)
  { name: 'Instant Dry Yeast (500 g)', hsn: '21021000', unit: 'packet', gst: 5, price: 210, supplier: 2, barcode: true, qty: [2, 10], stock: 80, rise: 0.06, bulk: [{ min_quantity: 12, price: 200 }] },
  { name: 'Fresh Compressed Yeast (500 g)', hsn: '21021000', unit: 'packet', gst: 5, price: 85, supplier: 2, qty: [2, 12], stock: 70 },
  { name: 'Baking Powder (1 kg)', hsn: '21023000', unit: 'packet', gst: 5, price: 180, supplier: 2, barcode: true, qty: [1, 5], stock: 40 },
  { name: 'Baking Soda - Food Grade (1 kg)', hsn: '28363000', unit: 'packet', gst: 18, price: 65, supplier: 2, barcode: true, qty: [1, 6], stock: 45 },
  { name: 'Bread Improver (1 kg)', hsn: '19019090', unit: 'packet', gst: 18, price: 245, supplier: 2, barcode: true, qty: [1, 3], stock: 25 },
  { name: 'Cake Gel / Emulsifier (1 kg)', hsn: '38249900', unit: 'packet', gst: 18, price: 215, supplier: 2, barcode: true, qty: [1, 4], stock: 30 },
  { name: 'Custard Powder - Vanilla (1 kg)', hsn: '19019090', unit: 'packet', gst: 18, price: 190, supplier: 2, barcode: true, qty: [1, 4], stock: 25 },
  { name: 'Gelatin Powder (500 g)', hsn: '35030020', unit: 'packet', gst: 18, price: 390, supplier: 2, qty: [1, 2], stock: 10, discontinued: true },
  { name: 'Cocoa Powder - Alkalised (1 kg)', hsn: '18050000', unit: 'packet', gst: 5, price: 520, supplier: 2, barcode: true, qty: [1, 5], stock: 30, rise: 0.08 },
  { name: 'Dark Chocolate Compound (500 g)', hsn: '18069010', unit: 'packet', gst: 5, price: 230, supplier: 2, barcode: true, qty: [2, 10], stock: 60, bulk: [{ min_quantity: 10, price: 220 }] },
  { name: 'Milk Chocolate Compound (500 g)', hsn: '18069010', unit: 'packet', gst: 5, price: 245, supplier: 2, barcode: true, qty: [2, 8], stock: 50 },
  { name: 'Choco Chips - Bake Stable (1 kg)', hsn: '18063100', unit: 'packet', gst: 5, price: 385, supplier: 2, barcode: true, qty: [1, 5], stock: 30 },
  { name: 'All in One Cake Premix (5 kg)', hsn: '19012000', unit: 'bag', gst: 18, price: 980, supplier: 2, qty: [1, 2], stock: 6, unsold: true },
  // Dairy and fats (Coastal Dairy)
  { name: 'Bakery Shortening (15 kg)', hsn: '15179090', unit: 'box', gst: 5, price: 1850, supplier: 3, qty: [1, 3], stock: 20 },
  { name: 'Unsalted Table Butter (500 g)', hsn: '04051000', unit: 'packet', gst: 5, price: 288, supplier: 3, barcode: true, qty: [2, 12], stock: 70, rise: 0.05 },
  { name: 'Dairy Whitener / Milk Powder (1 kg)', hsn: '04022100', unit: 'packet', gst: 5, price: 425, supplier: 3, barcode: true, qty: [1, 6], stock: 40 },
  { name: 'Condensed Milk (400 g)', hsn: '04029990', unit: 'piece', gst: 5, price: 135, supplier: 3, barcode: true, qty: [3, 15], stock: 100, bulk: [{ min_quantity: 24, price: 128 }] },
  { name: 'Non-Dairy Whipping Cream (1 kg)', hsn: '21069099', unit: 'packet', gst: 5, price: 385, supplier: 3, barcode: true, qty: [2, 10], stock: 60 },
  { name: 'Cream Cheese (1 kg)', hsn: '04061000', unit: 'packet', gst: 5, price: 645, supplier: 3, qty: [1, 4], stock: 20 },
  { name: 'Fresh Paneer - Loose', hsn: '04069000', unit: 'kg', gst: 0, price: 340, supplier: 3, qty: [1, 5], stock: 25 },
  // Essences and colours, from Tamil Nadu: IGST on purchase (Chennai Flavours)
  { name: 'Vanilla Essence (500 ml)', hsn: '33021090', unit: 'packet', gst: 18, price: 165, supplier: 4, barcode: true, qty: [1, 6], stock: 40 },
  { name: 'Pineapple Essence (500 ml)', hsn: '33021090', unit: 'packet', gst: 18, price: 155, supplier: 4, barcode: true, qty: [1, 5], stock: 30 },
  { name: 'Butterscotch Essence (500 ml)', hsn: '33021090', unit: 'packet', gst: 18, price: 172, supplier: 4, barcode: true, qty: [1, 5], stock: 30 },
  { name: 'Rose Essence (500 ml)', hsn: '33021090', unit: 'packet', gst: 18, price: 148, supplier: 4, qty: [1, 4], stock: 20 },
  { name: 'Food Colour Gel - Assorted (100 g)', hsn: '32041990', unit: 'piece', gst: 18, price: 95, supplier: 4, barcode: true, qty: [2, 10], stock: 60 },
  { name: 'Edible Silver Balls (100 g)', hsn: '21069099', unit: 'piece', gst: 18, price: 120, supplier: 4, qty: [1, 4], stock: 25, igst: true },
  { name: 'Sprinkles - Rainbow (500 g)', hsn: '17049090', unit: 'packet', gst: 18, price: 180, supplier: 4, barcode: true, qty: [1, 4], stock: 25, notMyGst: true },
  { name: 'Cake Boxes - 1 kg (Pack of 50)', hsn: '48191010', unit: 'box', gst: 18, price: 650, supplier: 4, qty: [1, 3], stock: 20 },
];

const CUSTOMERS = [
  { shop: 'Sri Ganesh Bakery', name: 'Ganesh Rao', phone: '9845012345', address: '12, 8th Cross, Malleshwaram, Bengaluru 560003', gstin: '29ABCPG1234K1Z5', buys: 1.6 },
  { shop: 'Golden Crust Bakers', name: 'Imran Khan', phone: '9900112233', address: 'Shivajinagar, Bengaluru 560051', gstin: '29AAKFG5678L1Z2', buys: 1.4 },
  { shop: 'Lohith Bakery', name: 'Lohith Kumar', phone: '9740098765', address: 'Rajajinagar 2nd Block, Bengaluru 560010', buys: 1.2 },
  { shop: 'Iyengar Bakery - Basavanagudi', name: 'Srinivas Iyengar', phone: '9886054321', address: 'DVG Road, Basavanagudi, Bengaluru 560004', gstin: '29AFIPS2345M1Z8', buys: 1.5 },
  { shop: 'Cake Corner', name: 'Ayesha Banu', phone: '9611223344', address: 'Frazer Town, Bengaluru 560005', buys: 1.0 },
  { shop: 'Hot Breads Jayanagar', name: 'Prakash Shetty', phone: '9945087654', address: '4th Block, Jayanagar, Bengaluru 560011', gstin: '29AAHFH8765N1Z3', buys: 1.3 },
  { shop: 'Sweet Tooth Patisserie', name: 'Neha Kapoor', phone: '9008765432', address: 'Indiranagar 100 Ft Road, Bengaluru 560038', buys: 0.9 },
  { shop: 'Nandini Bake House', name: 'Manjunath Gowda', phone: '9731122334', address: 'Vijayanagar, Bengaluru 560040', buys: 1.1 },
  { shop: 'Mysore Bakery & Sweets', name: 'Raghavendra Bhat', phone: '9480012233', address: 'Sayyaji Rao Road, Mysuru 570001', gstin: '29AAMFM4321P1Z6', buys: 0.8 },
  { shop: 'Kanti Sweets & Bakes', name: 'Kanti Lal', phone: '9343056789', address: 'Chickpet, Bengaluru 560053', buys: 0.9 },
  { shop: 'Fresh Oven', name: 'Joseph D’Souza', phone: '9535067890', address: 'Richmond Town, Bengaluru 560025', buys: 0.7 },
  { shop: 'Brahmin’s Bakery', name: 'Sudha Murthy', phone: '9845223344', address: 'Hanumanthanagar, Bengaluru 560019', buys: 0.6 },
  { shop: 'Royal Cake Palace', name: '', phone: '9611998877', address: 'Banashankari 2nd Stage, Bengaluru 560070', buys: 0.8 },
  { shop: '', name: 'Ramesh (home baker)', phone: '9902345678', address: 'BTM Layout, Bengaluru 560076', buys: 0.4 },
  { shop: '', name: 'Kavya Nair', phone: '9886777665', address: 'Whitefield, Bengaluru 560066', buys: 0.3 },
  { shop: 'Cupcake Studio', name: 'Pooja Hegde', phone: '9620445566', address: 'HSR Layout, Bengaluru 560102', buys: 0.5, joinsDaysAgo: 40 },
  { shop: 'Anand Sweets Counter', name: 'Anand Patil', phone: '9741556677', address: 'Yelahanka, Bengaluru 560064', buys: 0.4, joinsDaysAgo: 18 },
  { shop: 'Old Town Bakery', name: 'Faizal Ahmed', phone: '9845998877', address: 'Old Airport Road, Bengaluru 560017', buys: 0.5, opening: 8500 },
] as const;

/** Customers who stop paying, so Sales Credit shows dues 61–90 and 90+ days old. */
const SLOW_PAYERS = new Set(['Lohith Bakery', 'Fresh Oven', 'Old Town Bakery']);
/** A customer who clears everything at the end: a passbook ending at nil. */
const CLEARS_UP = 'Golden Crust Bakers';

// --- The server -----------------------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

const fail = (message: string): never => {
  console.error(`\n${message}\n`);
  process.exit(1);
};

const refuseNonEmpty = () => {
  if (!fs.existsSync(DB_PATH)) return;
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const count = (table: string) => {
      try { return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c; } catch { return 0; }
    };
    const found = ['items', 'customers', 'bills', 'purchases'].map((t) => [t, count(t)] as const).filter(([, n]) => n > 0);
    if (found.length) {
      fail(`Refusing to add test data: ${DB_PATH} already has ${found.map(([t, n]) => `${n} ${t}`).join(', ')}.\n` +
        'This script only fills an empty database, so it never mixes into real books.');
    }
  } finally {
    db.close();
  }
};

const startServer = async (secret: string) => {
  const port = await freePort();
  const production = fs.existsSync(path.join(ROOT, 'dist', 'index.html'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: production ? 'production' : 'development',
      DB_PATH,
      PORT: String(port),
      HOST: '127.0.0.1',
      JWT_SECRET: secret,
      // Never an erase, a demo seed or a backup from this run.
      START_FRESH: '',
      START_FRESH_CONFIRM: '',
      SEED_DEMO_DATA: '',
      AUTO_BACKUP_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) fail(`The server stopped while starting:\n${output}`);
    try {
      if ((await fetch(`${baseUrl}/api/settings`)).status === 401) break;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const stop = () => new Promise<void>((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 6000);
  });
  return { baseUrl, stop, output: () => output };
};

// --- Main -------------------------------------------------------------------------

const main = async () => {
  refuseNonEmpty();
  console.log(`Adding test data to ${DB_PATH}`);

  // A secret for this run only: tokens signed here mean nothing to the real server.
  const secret = crypto.randomBytes(32).toString('hex');
  const server = await startServer(secret);
  const db = new Database(DB_PATH);
  db.pragma('busy_timeout = 10000');

  try {
    // ---- Signing in as staff, without anyone's password ------------------------
    const tokenFor = (user: { id: number; role: string; name: string; token_version: number }) =>
      jwt.sign({ id: user.id, role: user.role, name: user.name, token_version: user.token_version }, secret, {
        algorithm: 'HS256', issuer: 'vyapara-billing', audience: 'vyapara-billing-app', expiresIn: '2h',
      });
    const userRow = (id: number) =>
      db.prepare('SELECT id, role, name, token_version FROM users WHERE id = ?').get(id) as { id: number; role: string; name: string; token_version: number };
    const adminRow = db.prepare("SELECT id FROM users WHERE role = 'admin' AND is_active = 1 AND COALESCE(env_managed, 0) = 0 ORDER BY id LIMIT 1").get() as { id: number } | undefined;
    if (!adminRow) fail('No admin account found in the database.');

    const call = async (token: string, method: string, url: string, body?: unknown) => {
      const response = await fetch(`${server.baseUrl}${url}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (!response.ok) throw new Error(`${method} ${url} → ${response.status}: ${data?.error ?? text}`);
      return data;
    };
    const admin = { id: adminRow!.id, token: tokenFor(userRow(adminRow!.id)) };

    // ---- Giving each change its date --------------------------------------------
    // After each call, the rows it added get the moment it is meant to have
    // happened. Calls are made oldest first, so every running balance and
    // FIFO order the server worked out stays true.
    const dated = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>)
      .map(({ name }) => ({
        name,
        columns: (db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>)
          .map((column) => column.name)
          .filter((column) => column === 'created_at' || column === 'received_at'),
      }))
      .filter((table) => table.columns.length > 0 && table.name !== 'settings');
    const lastRow = new Map<string, number>();
    const maxRow = (table: string) => Number((db.prepare(`SELECT COALESCE(MAX(rowid), 0) m FROM ${table}`).get() as { m: number }).m);
    for (const table of dated) lastRow.set(table.name, maxRow(table.name));
    const backdate = (stamp: string) => {
      for (const table of dated) {
        const before = lastRow.get(table.name)!;
        const after = maxRow(table.name);
        if (after > before) {
          db.prepare(`UPDATE ${table.name} SET ${table.columns.map((c) => `${c} = ?`).join(', ')} WHERE rowid > ?`)
            .run(...table.columns.map(() => stamp), before);
          lastRow.set(table.name, after);
        }
      }
    };
    // Time only moves forward: each change is dated when it is meant to be, or
    // just after the one before, never before it. Otherwise two bills rung up
    // in order could be dated the other way round, and a passbook sorted by
    // date would show its running balance jumping about.
    let lastDated = 0;
    const toStamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
    const on = async <T>(stamp: string, action: () => Promise<T>) => {
      const result = await action();
      const wanted = Date.parse(`${stamp.replace(' ', 'T')}Z`);
      lastDated = Math.max(lastDated, Math.min(Math.max(wanted, lastDated + randInt(20, 240) * 1000), Date.now() - 1000));
      backdate(toStamp(lastDated));
      return result;
    };
    /** The date the last change was given. */
    const lastStamp = () => toStamp(lastDated);

    // ---- The shop, if it still has the app's placeholder details ---------------
    const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get() as any;
    if (!settings || settings.shop_gstin === '27AAAAA0000A1Z5' || settings.shop_address === '123 Bakery Lane, Food City') {
      await call(admin.token, 'PUT', '/api/settings', {
        shop_name: 'Vasavi Bakery Supplies',
        shop_address: '38, 2nd Main, Yeshwanthpur Industrial Suburb, Bengaluru 560022',
        shop_phone: '+91 80 2337 4400',
        shop_gstin: '29AAACV1234M1ZK',
        bill_format: settings?.bill_format === 'standard' ? 'standard' : 'thermal',
        bill_header: 'BAKERY RAW MATERIALS - WHOLESALE',
        bill_footer: 'Goods once sold will not be taken back. Thank you!',
      });
    }

    // ---- Staff -------------------------------------------------------------------
    const start = at(DAYS, 9, 30);
    const cashierLogins: Array<{ username: string; password: string; name: string }> = [];
    const staff: Array<{ id: number; token: string }> = [admin];
    for (const person of [{ username: 'test.priya', name: 'Priya Shetty' }, { username: 'test.arun', name: 'Arun Kumar' }]) {
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(person.username)) continue;
      const password = `Test-${crypto.randomBytes(9).toString('base64url')}`;
      const account = await on(start, () => call(admin.token, 'POST', '/api/cashiers', { ...person, password }));
      cashierLogins.push({ ...person, password });
      staff.push({ id: account.id, token: tokenFor(userRow(account.id)) });
    }

    // ---- Suppliers and customers --------------------------------------------------
    const supplierIds: number[] = [];
    for (const supplier of SUPPLIERS) {
      const created = await on(start, () => call(admin.token, 'POST', '/api/suppliers', supplier));
      supplierIds.push(created.id);
    }

    type Shopper = { id: number; label: string; buys: number; joins: number };
    const shoppers: Shopper[] = [];
    const addCustomer = async (customer: (typeof CUSTOMERS)[number]) => {
      const joins = 'joinsDaysAgo' in customer ? customer.joinsDaysAgo : DAYS;
      const created = await on(at(joins, 10, 15), () => call(admin.token, 'POST', '/api/customers', {
        shop_name: customer.shop || undefined,
        name: customer.name || undefined,
        phone: customer.phone,
        address: customer.address,
        gstin: 'gstin' in customer ? customer.gstin : undefined,
        // An opening balance, carried over from before the app (admin only).
        ...('opening' in customer ? { credit_balance: customer.opening } : {}),
      }));
      shoppers.push({ id: created.id, label: customer.shop || customer.name, buys: customer.buys, joins });
    };
    for (const customer of CUSTOMERS) if (!('joinsDaysAgo' in customer)) await addCustomer(customer);

    // ---- Buying ----------------------------------------------------------------------
    const itemIds = new Map<number, number>(); // catalogue index → item id
    const priceNow = CATALOGUE.map((item) => item.price);
    const purchases: Array<{ id: number; supplier: number; total: number; day: number }> = [];

    const ean13 = (index: number) => {
      const body = `890${String(4410000 + index * 37).padStart(7, '0')}${String(index % 100).padStart(2, '0')}`;
      const sum = [...body].reduce((acc, digit, i) => acc + Number(digit) * (i % 2 ? 3 : 1), 0);
      return body + String((10 - (sum % 10)) % 10);
    };
    const stockOf = (index: number) => {
      const id = itemIds.get(index);
      if (!id) return 0;
      return Number((db.prepare('SELECT stock_quantity q FROM items WHERE id = ?').get(id) as { q: number }).q);
    };
    const rates = (item: CatalogueItem) =>
      item.gst === 0 ? { sgst_rate: 0, cgst_rate: 0, igst_rate: 0 }
        : item.igst ? { sgst_rate: 0, cgst_rate: 0, igst_rate: item.gst }
        : { sgst_rate: item.gst / 2, cgst_rate: item.gst / 2, igst_rate: 0 };

    /** One supplier's invoice for `lines`; how much is paid at entry decides what Purchase Credit shows. */
    const buy = async (day: number, supplier: number | null, lines: Array<{ index: number; quantity: number }>, paid: 'full' | 'part' | 'none') => {
      if (!lines.length) return;
      const stamp = at(day, randInt(10, 16), randInt(0, 59));
      const items = lines.map(({ index, quantity }) => {
        const item = CATALOGUE[index];
        const selling = priceNow[index];
        // Bought at 70–78% of the selling price, before GST.
        const unit_cost = round2((selling / (1 + item.gst / 100)) * (0.70 + rand() * 0.08));
        const known = itemIds.get(index);
        return {
          ...(known ? { item_id: known } : { new_item: { name: item.name, hsn_code: item.hsn, metric: item.unit } }),
          ...(item.barcode && !known ? { barcode: ean13(index) } : {}),
          quantity, unit_cost, selling_price: selling, ...rates(item),
        };
      });
      const total = round2(items.reduce((acc, line) => {
        const taxable = round2(line.quantity * line.unit_cost);
        return acc + taxable + round2((taxable * line.sgst_rate) / 100) + round2((taxable * line.cgst_rate) / 100) + round2((taxable * line.igst_rate) / 100);
      }, 0));
      const s = supplier === null ? null : SUPPLIERS[supplier];
      const amount_paid = supplier === null || paid === 'full' ? total : paid === 'part' ? Math.floor(total * (0.3 + rand() * 0.4)) : 0;
      const created = await on(stamp, () => call(admin.token, 'POST', '/api/purchases', {
        supplier_name: s?.name ?? '',
        supplier_phone: s?.phone, supplier_address: s?.address, supplier_gstin: s?.gstin,
        invoice_number: s ? `${s.name.split(' ')[0].toUpperCase()}/${2026}/${1000 + purchases.length}` : undefined,
        invoice_date: istDay(stamp),
        notes: supplier === null ? 'Bought for cash at the market' : undefined,
        amount_paid,
        ...(amount_paid > 0 ? { payment_method: pick(['cash', 'upi', 'bank', 'cheque'] as const), payment_reference: chance(0.5) ? `REF${randInt(100000, 999999)}` : undefined } : {}),
        items,
      }));
      for (const made of created.created_items ?? []) {
        const index = CATALOGUE.findIndex((item) => item.name === made.name);
        if (index >= 0) itemIds.set(index, made.id);
      }
      if (supplier !== null) purchases.push({ id: created.id, supplier, total, day });
    };

    /** Each supplier's run: top up its items to about their usual stock. */
    const restock = async (day: number, supplier: number, first = false) => {
      const lines = CATALOGUE.flatMap((item, index) => {
        if (item.supplier !== supplier) return [];
        if (!first && (item.discontinued || item.unsold)) return [];
        const have = stockOf(index);
        if (!first && have > item.stock * 0.6) return [];
        const quantity = item.unit === 'kg' ? Math.max(5, Math.round(item.stock * 1.2 - have)) : Math.max(item.qty[1], Math.round(item.stock * 1.2 - have));
        return [{ index, quantity }];
      });
      await buy(day, supplier, lines, first ? (supplier % 2 ? 'part' : 'full') : pick(['full', 'part', 'none', 'none'] as const));
    };

    // Opening stock, bought from every supplier in the first days.
    for (let supplier = 0; supplier < SUPPLIERS.length; supplier++) await restock(DAYS - supplier, supplier, true);
    // Market purchase with no supplier: must be paid in full.
    await buy(DAYS - 6, null, [{ index: 11, quantity: 20 }], 'full');

    // ---- Catalogue settings: bulk prices, "my GST" --------------------------------
    for (const [index, item] of CATALOGUE.entries()) {
      const id = itemIds.get(index)!;
      if (item.bulk) await on(at(DAYS - 5, 12, 0), () => call(admin.token, 'PUT', `/api/items/${id}/bulk-prices`, { bulk_prices: item.bulk }));
      if (item.notMyGst) {
        const row = db.prepare('SELECT * FROM items WHERE id = ?').get(id) as any;
        await on(at(DAYS - 5, 12, 10), () => call(admin.token, 'PUT', `/api/items/${id}`, {
          name: row.name, hsn_code: row.hsn_code, metric: row.metric, is_loose: !!row.is_loose,
          gst_applicable: !!row.gst_applicable, gst_mode: row.gst_mode, gst_rate: row.gst_rate,
          sgst_rate: row.sgst_rate, cgst_rate: row.cgst_rate, igst_rate: row.igst_rate, in_my_gst: false,
        }));
      }
    }

    // ---- Selling -----------------------------------------------------------------------
    // Priced the way the till prices a bill (src/lib/billMath.ts, shared with
    // the server), so a split payment adds up to exactly the total.
    const batchesOf = db.prepare('SELECT id, quantity_remaining, selling_price FROM stock_batches WHERE item_id = ? AND quantity_remaining > 0 ORDER BY received_at ASC, id ASC');
    const itemRow = db.prepare('SELECT * FROM items WHERE id = ?');
    const bulkOf = db.prepare('SELECT min_quantity, price FROM item_bulk_prices WHERE item_id = ?');
    const totalOf = (lines: Array<{ id: number; quantity: number }>, discount: number) => {
      let subtotal = 0;
      let tax = 0;
      for (const line of lines) {
        const { allocations } = allocateFifo(batchesOf.all(line.id) as any[], line.quantity);
        const bulk = bulkPriceFor(bulkOf.all(line.id) as BulkPrice[], line.quantity);
        for (const segment of priceSegments(applyBulkPrice(allocations, bulk))) {
          const amounts = computeLine(itemRow.get(line.id) as any, segment.unit_price, segment.quantity);
          subtotal += amounts.taxable_amount;
          tax += amounts.sgst_amount + amounts.cgst_amount + amounts.igst_amount;
        }
      }
      return Math.floor(round2(round2(subtotal) + round2(tax) - discount));
    };

    const sellable = CATALOGUE.map((item, index) => ({ item, index })).filter(({ item }) => !item.unsold);
    const bills: Array<{ id: number; day: number; lines: Array<{ id: number; quantity: number }>; customer: number | null; method: string }> = [];

    const sell = async (day: number, hour: number) => {
      const people = shoppers.filter((s) => s.joins >= day);
      const weights = people.map((s) => s.buys);
      const roll = rand() * weights.reduce((a, b) => a + b, 0) * 1.25;
      let acc = 0;
      const customer = people.find((_, i) => (acc += weights[i]) >= roll) ?? null; // ~20% walk-in

      const lines: Array<{ id: number; quantity: number }> = [];
      for (let n = randInt(1, 5); n > 0; n--) {
        const { item, index } = pick(sellable);
        const id = itemIds.get(index)!;
        if (lines.some((line) => line.id === id)) continue;
        // Now and then a big order, reaching a bulk price.
        const wanted = item.bulk && chance(0.15) ? item.bulk[0].min_quantity + randInt(0, 4) : randInt(item.qty[0], item.qty[1]);
        const quantity = Math.min(item.unit === 'kg' ? wanted + (chance(0.4) ? 0.5 : 0) : wanted, stockOf(index));
        if (quantity > 0) lines.push({ id, quantity: round3(quantity) });
      }
      if (!lines.length) return;

      const method = customer
        ? pick(['cash', 'upi', 'upi', 'credit', 'credit', 'split'] as const)
        : pick(['cash', 'cash', 'upi'] as const);
      const discount = chance(0.12) ? randInt(1, 6) * 10 : 0;
      const total = totalOf(lines, discount);
      let split = {};
      if (method === 'split') {
        const cash = Math.floor(total * (0.2 + rand() * 0.3));
        const upi = Math.floor((total - cash) * rand());
        split = { cash_amount: cash, upi_amount: upi, credit_amount: round2(total - cash - upi) };
      }
      const cashier = pick(staff);
      const stamp = at(day, hour, randInt(0, 59));
      const bill = await on(stamp, () => call(cashier.token, 'POST', '/api/bills', {
        items: lines, payment_method: method, customer_id: customer?.id ?? null,
        discount_amount: discount, expected_total: total, ...split,
      }));
      bills.push({ id: bill.bill_id, day, lines, customer: customer?.id ?? null, method });
    };

    const balanceOf = (customerId: number) =>
      Number((db.prepare('SELECT credit_balance b FROM customers WHERE id = ?').get(customerId) as { b: number }).b);

    /** Customers paying off part of what they owe, as most do every week or two. */
    const collect = async (day: number) => {
      for (const shopper of shoppers) {
        if (SLOW_PAYERS.has(shopper.label) && day < DAYS - 30) continue;
        const owed = balanceOf(shopper.id);
        if (owed < 500 || !chance(0.35)) continue;
        const amount = Math.max(100, Math.floor((owed * (0.3 + rand() * 0.5)) / 100) * 100);
        await on(at(day, randInt(11, 18), randInt(0, 59)), () => call(pick(staff).token, 'POST', `/api/customers/${shopper.id}/credit-payments`, {
          amount: Math.min(amount, owed), note: pick(['Cash at counter', 'UPI', 'Cheque deposited', 'Paid by son', '']) || undefined,
        }));
      }
    };

    /** Paying suppliers, oldest invoices first, as the shop does at month-end. */
    const paySuppliers = async (day: number) => {
      for (let supplier = 0; supplier < SUPPLIERS.length; supplier++) {
        const owed = Number((db.prepare(`
          SELECT COALESCE(SUM(p.total_amount - COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a WHERE a.purchase_id = p.id), 0)), 0) owed
          FROM purchases p WHERE p.supplier_id = ?`).get(supplierIds[supplier]) as { owed: number }).owed);
        if (owed < 1000 || !chance(0.7)) continue;
        const amount = Math.floor(owed * (0.4 + rand() * 0.5));
        const stamp = at(day, 16, randInt(0, 59));
        await on(stamp, () => call(admin.token, 'POST', '/api/supplier-payments', {
          supplier_id: supplierIds[supplier], amount, paid_on: istDay(stamp),
          method: pick(['bank', 'bank', 'upi', 'cheque', 'cash'] as const),
          reference: chance(0.7) ? `TXN${randInt(1000000, 9999999)}` : undefined,
          note: chance(0.3) ? 'Month-end settlement' : undefined,
        }));
      }
    };

    for (let day = DAYS - 7; day >= 0; day--) {
      // New customers on the day they first came.
      for (const customer of CUSTOMERS) {
        if ('joinsDaysAgo' in customer && customer.joinsDaysAgo === day) await addCustomer(customer);
      }
      // Prices go up part-way through: later purchases sell dearer, so a
      // bill can run across two prices.
      if (day === 55 || day === 20) {
        CATALOGUE.forEach((item, index) => { if (item.rise) priceNow[index] = round2(priceNow[index] * (1 + item.rise)); });
      }
      // Each supplier delivers once a week, on its own day.
      for (let s = 0; s < SUPPLIERS.length; s++) if (day % 7 === s) await restock(day, s);
      // A delivery at the new price, while the old stock is still on the shelf.
      if (day === 55 || day === 20) {
        for (let s = 0; s < SUPPLIERS.length; s++) {
          const lines = CATALOGUE.flatMap((item, index) => (item.supplier === s && item.rise ? [{ index, quantity: Math.round(item.stock * 0.6) }] : []));
          await buy(day, s, lines, 'none');
        }
      }

      const istNow = new Date(Date.now() + IST_OFFSET_MS);
      const weekday = new Date(istNow.getTime() - day * 86_400_000).getUTCDay();
      const lastHour = day === 0 ? Math.max(9, Math.min(19, istNow.getUTCHours())) : 19;
      const count = weekday === 0 ? randInt(0, 2) : randInt(5, 11);
      const hours = Array.from({ length: count }, () => randInt(9, lastHour)).sort((a, b) => a - b);
      for (const hour of hours) await sell(day, hour);

      if (day % 6 === 2) await collect(day);
      if (day === 92 || day === 62 || day === 31 || day === 3) await paySuppliers(day);

      // Now and then stock is found damaged or expired, or counted short.
      if (day === 70) {
        const index = CATALOGUE.findIndex((item) => item.name.startsWith('Condensed Milk'));
        if (stockOf(index) >= 3) await on(at(day, 18, 30), () => call(admin.token, 'POST', `/api/items/${itemIds.get(index)}/stock-adjustments`, { quantity: -3, reason: 'Dented tins, returned to bin' }));
      }
      if (day === 35) {
        const index = CATALOGUE.findIndex((item) => item.name.startsWith('Bombay Rava'));
        await on(at(day, 18, 45), () => call(admin.token, 'POST', `/api/items/${itemIds.get(index)}/stock-adjustments`, { quantity: 6, reason: 'Found in back store during count', unit_cost: 48 }));
      }
      if (day === 25) {
        // A batch repriced by hand (Items → Stock & prices → Reprice).
        const id = itemIds.get(CATALOGUE.findIndex((item) => item.name.startsWith('Cream Cheese')))!;
        const batch = batchesOf.get(id) as { id: number; selling_price: number } | undefined;
        if (batch) await on(at(day, 12, 0), () => call(admin.token, 'PUT', `/api/stock-batches/${batch.id}`, { selling_price: round2(batch.selling_price + 20) }));
      }
      // An admin corrects a bill from the days before, and deletes one made by mistake.
      if (day === 15) {
        // A cash or UPI bill, so no credit has to move; one line taken off.
        const target = [...bills].reverse().find((bill) => bill.day > day && bill.lines.length > 1 && (bill.method === 'cash' || bill.method === 'upi'));
        if (target) {
          const lines = target.lines.slice(0, -1);
          await on(at(day, 11, 20), () => call(admin.token, 'PUT', `/api/bills/${target.id}`, {
            items: lines, payment_method: target.method, customer_id: target.customer,
          }));
          db.prepare('UPDATE bills SET edited_at = ? WHERE id = ?').run(lastStamp(), target.id);
        }
      }
      if (day === 8) {
        const target = [...bills].reverse().find((bill) => bill.day >= day && bill.method !== 'credit');
        if (target) await on(at(day, 19, 30), () => call(admin.token, 'DELETE', `/api/bills/${target.id}`));
      }
    }

    // ---- How the shelves end up -------------------------------------------------------
    // Two items run out and a few run low, so the dashboard and Stock show both.
    const finalStamp = at(0, 9, 5);
    for (const name of ['Rose Essence', 'Cream Cheese']) {
      const index = CATALOGUE.findIndex((item) => item.name.startsWith(name));
      const have = stockOf(index);
      if (have > 0) await on(finalStamp, () => call(admin.token, 'POST', `/api/items/${itemIds.get(index)}/stock-adjustments`, { quantity: -have, reason: 'Expired — discarded' }));
    }
    for (const name of ['Baking Powder', 'Cocoa Powder', 'Brown Sugar', 'Cake Boxes']) {
      const index = CATALOGUE.findIndex((item) => item.name.startsWith(name));
      const extra = round3(stockOf(index) - randInt(3, 8));
      if (extra > 0) await on(finalStamp, () => call(admin.token, 'POST', `/api/items/${itemIds.get(index)}/stock-adjustments`, { quantity: -extra, reason: 'Stock count: shelf short' }));
    }
    // One bakery clears its account.
    const clearer = shoppers.find((s) => s.label === CLEARS_UP);
    if (clearer && balanceOf(clearer.id) > 0) {
      await on(at(0, 9, 30), () => call(admin.token, 'POST', `/api/customers/${clearer.id}/credit-payments`, { amount: balanceOf(clearer.id), note: 'Full settlement' }));
    }

    // ---- What was made ------------------------------------------------------------------
    const count = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    const money = (sql: string) => `₹${Number((db.prepare(sql).get() as { n: number }).n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
    console.log(`
Test data added, ${DAYS} days back to today.

  Items           ${count('SELECT COUNT(*) n FROM items')}  (${count("SELECT COUNT(*) n FROM items WHERE barcode IS NOT NULL AND barcode <> ''")} with barcodes, ${count('SELECT COUNT(*) n FROM items WHERE stock_quantity <= 0')} out of stock, ${count(`SELECT COUNT(*) n FROM items WHERE stock_quantity > 0 AND stock_quantity <= ${Number(process.env.LOW_STOCK_THRESHOLD || 10)}`)} low)
  Stock batches   ${count('SELECT COUNT(*) n FROM stock_batches')}
  Customers       ${count('SELECT COUNT(*) n FROM customers')}  (owe ${money('SELECT SUM(credit_balance) n FROM customers')} in all)
  Suppliers       ${count('SELECT COUNT(*) n FROM suppliers')}  (owed ${money(`SELECT SUM(p.total_amount - COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a WHERE a.purchase_id = p.id), 0)) n FROM purchases p`)})
  Purchases       ${count('SELECT COUNT(*) n FROM purchases')}
  Bills           ${count('SELECT COUNT(*) n FROM bills')}  (sales ${money('SELECT SUM(total_amount) n FROM bills')}; ${count("SELECT COUNT(*) n FROM bills WHERE date(created_at, '+330 minutes') = date('now', '+330 minutes')")} today)
  Repayments      ${count("SELECT COUNT(*) n FROM customer_credit_entries WHERE entry_type = 'payment'")}
  Supplier pay.   ${count('SELECT COUNT(*) n FROM supplier_payments')}
  Activity log    ${count('SELECT COUNT(*) n FROM audit_logs')}

Sign in as your admin, as before.${cashierLogins.length ? `
Cashier logins for testing (shown only now):
${cashierLogins.map((login) => `  ${login.username} / ${login.password}   (${login.name})`).join('\n')}` : ''}
`);
  } catch (err) {
    console.error(`\nStopped: ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    db.close();
    await server.stop();
  }
};

void main();
