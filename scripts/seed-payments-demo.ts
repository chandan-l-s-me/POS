/**
 * Demo data for purchase credit and supplier payments.
 *
 * Adds backdated purchases from the existing suppliers, some on credit, some
 * part-paid, some settled later, so the Purchase Credit and Payments Done
 * pages have something to show:
 *
 *   - invoices unpaid for 60+ days (red), 30+ days (amber) and recent ones
 *   - one bank payment that cleared an old invoice and part of the next
 *   - a purchase paid in full at the time, and one settled in two payments
 *   - an inter-state (IGST) supplier, part paid at purchase
 *
 *   npx tsx scripts/seed-payments-demo.ts
 *
 * Additive: nothing existing is changed, and no password is touched. It backs
 * up the database to backups/ first, and refuses to run a second time. The
 * stock bought on these purchases is added to the shelf as real batches, at
 * each item's current selling price.
 *
 * NOT for a live shop's database.
 */
import fs from 'fs';
import path from 'path';
import db, { dbPath, initDb, syncItemStock } from '../db/index';
import { profitPercentFromSellingPrice, round2, saleGstRate } from '../src/lib/billMath';

const DEMO_NOTE = 'Demo purchase (seed-payments-demo)';

const IST_OFFSET = 5.5 * 60 * 60 * 1000;

/** A moment `daysAgo` days back at the given IST wall-clock time. */
const at = (daysAgo: number, hour = 11, minute = 0) => {
  const istNow = new Date(Date.now() + IST_OFFSET);
  const istWall = new Date(Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - daysAgo, hour, minute, 0));
  const utc = new Date(istWall.getTime() - IST_OFFSET);
  const day = istWall.toISOString().slice(0, 10);
  return {
    sqlite: utc.toISOString().slice(0, 19).replace('T', ' '),
    day,
    dayKey: `${day.slice(8, 10)}${day.slice(5, 7)}${day.slice(0, 4)}`,
  };
};

type Line = { item: string; quantity: number };
type Payment = { daysAgo: number; amount: number | 'rest'; method: 'cash' | 'upi' | 'bank' | 'cheque' | null; reference?: string; note?: string };
type DemoPurchase = {
  key: string;
  supplier: string;
  daysAgo: number;
  invoice: string;
  /** Inter-state supplier: IGST instead of CGST + SGST. */
  igst?: boolean;
  lines: Line[];
  /** Paid at the time of purchase. */
  paidAtPurchase?: Omit<Payment, 'daysAgo'>;
};

const PURCHASES: DemoPurchase[] = [
  // Sunrise Flour Mills: three invoices, the oldest cleared and the next part
  // paid by one bank transfer, the newest untouched.
  { key: 'sunrise-1', supplier: 'Sunrise Flour Mills', daysAgo: 84, invoice: 'SUNRISE/2026/1188',
    lines: [{ item: 'Refined Maida - Bakers Grade (25 kg)', quantity: 40 }, { item: 'Whole Wheat Atta (25 kg)', quantity: 20 }] },
  { key: 'sunrise-2', supplier: 'Sunrise Flour Mills', daysAgo: 47, invoice: 'SUNRISE/2026/1241',
    lines: [{ item: 'Refined Maida - Bakers Grade (25 kg)', quantity: 50 }, { item: 'Corn Flour (1 kg)', quantity: 60 }] },
  { key: 'sunrise-3', supplier: 'Sunrise Flour Mills', daysAgo: 9, invoice: 'SUNRISE/2026/1307',
    lines: [{ item: 'Refined Maida - Bakers Grade (25 kg)', quantity: 30 }, { item: 'Custard Powder - Vanilla (1 kg)', quantity: 24 }] },

  // Zeelac: one invoice left unpaid for over two months.
  { key: 'zeelac-1', supplier: 'Zeelac Food Ingredients', daysAgo: 66, invoice: 'ZFI/INV/5521',
    lines: [{ item: 'Cake Gel / Emulsifier (1 kg)', quantity: 40 }, { item: 'Vanilla Essence (500 ml)', quantity: 48 }, { item: 'Pineapple Essence (500 ml)', quantity: 24 }] },

  // Kwality Dairy: an older invoice part-paid by cheque, a recent one on credit.
  { key: 'kwality-1', supplier: 'Kwality Dairy Products', daysAgo: 38, invoice: 'KDP-2026-0912',
    lines: [{ item: 'Unsalted Table Butter (500 g)', quantity: 80 }, { item: 'Non-Dairy Whipping Cream (1 kg)', quantity: 60 }] },
  { key: 'kwality-2', supplier: 'Kwality Dairy Products', daysAgo: 6, invoice: 'KDP-2026-1004',
    lines: [{ item: 'Cream Cheese (1 kg)', quantity: 20 }, { item: 'Condensed Milk (400 g)', quantity: 96 }] },

  // Shree Ram (Maharashtra): inter-state, so IGST; part paid by UPI at purchase.
  { key: 'shreeram-1', supplier: 'Shree Ram Food Additives', daysAgo: 27, invoice: 'SRFA/26-27/0418', igst: true,
    lines: [{ item: 'Bread Improver (1 kg)', quantity: 50 }, { item: 'Baking Powder (1 kg)', quantity: 40 }, { item: 'Gelatin Powder - Food Grade (500 g)', quantity: 20 }],
    paidAtPurchase: { amount: 15000, method: 'upi', reference: 'UPI 6291 4473 0081' } },

  // Pack-Well: one paid in cash on the spot, one on credit.
  { key: 'packwell-1', supplier: 'Pack-Well Packaging Solutions', daysAgo: 31, invoice: 'PW/2026/3390',
    lines: [{ item: 'Cake Box 1 kg (pack of 25)', quantity: 40 }, { item: 'Butter Paper Sheets (pack of 500)', quantity: 20 }],
    paidAtPurchase: { amount: 'rest', method: 'cash' } },
  { key: 'packwell-2', supplier: 'Pack-Well Packaging Solutions', daysAgo: 16, invoice: 'PW/2026/3517',
    lines: [{ item: 'Silver Cake Board 10 inch (pack of 25)', quantity: 30 }, { item: 'Piping Bags - Disposable (pack of 100)', quantity: 40 }] },

  // Bakels: bought on credit, settled later in two payments.
  { key: 'bakels-1', supplier: 'Bakels India Pvt Ltd', daysAgo: 52, invoice: 'BAKELS/2026/1462',
    lines: [{ item: 'Dark Chocolate Compound (500 g)', quantity: 100 }, { item: 'Cocoa Powder - Alkalised (1 kg)', quantity: 30 }] },
];

/** Payments made after purchase, against the supplier (oldest invoice first). */
const LATER_PAYMENTS: Array<Payment & { supplier: string }> = [
  { supplier: 'Sunrise Flour Mills', daysAgo: 40, amount: 75000, method: 'bank', reference: 'NEFT N2604018817', note: 'July and August dues' },
  { supplier: 'Kwality Dairy Products', daysAgo: 20, amount: 20000, method: 'cheque', reference: 'CHQ 004512 (Canara Bank)' },
  { supplier: 'Bakels India Pvt Ltd', daysAgo: 35, amount: 15000, method: 'upi', reference: 'UPI 3381 2290 1745' },
  { supplier: 'Bakels India Pvt Ltd', daysAgo: 22, amount: 'rest', method: 'cash', note: 'Settled invoice BAKELS/2026/1462' },
];

// ---------------------------------------------------------------------------

initDb();

if (db.prepare('SELECT 1 FROM purchases WHERE notes = ?').get(DEMO_NOTE)) {
  console.log('Payments demo data is already in this database. Nothing added.');
  process.exit(0);
}

const backupDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `pos-before-payments-demo-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
console.log(`Backed up the database to ${backupPath}`);

const admin = db.prepare("SELECT id, name FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() as { id: number; name: string };
const supplierByName = (name: string) => {
  const supplier = db.prepare('SELECT * FROM suppliers WHERE name = ?').get(name) as any;
  if (!supplier) throw new Error(`Supplier not found: ${name}`);
  return supplier;
};
const itemByName = (name: string) => {
  const item = db.prepare('SELECT * FROM items WHERE name = ?').get(name) as any;
  if (!item) throw new Error(`Item not found: ${name}`);
  return item;
};

/** The next purchase number for that day, from the same counter the app uses. */
const nextPurchaseNumber = (dayKey: string) => {
  const scope = `PUR:${dayKey}`;
  db.prepare('INSERT OR IGNORE INTO document_counters (scope, last_value) VALUES (?, 0)').run(scope);
  const { last_value } = db.prepare('UPDATE document_counters SET last_value = last_value + 1 WHERE scope = ? RETURNING last_value').get(scope) as any;
  return `PUR-${dayKey}-${String(last_value).padStart(5, '0')}`;
};

const insertPurchase = db.prepare(`
  INSERT INTO purchases (purchase_number, supplier_id, supplier_name, supplier_phone, supplier_address, supplier_gstin,
    invoice_number, invoice_date, notes, user_id, subtotal_amount, tax_amount, total_amount, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertLine = db.prepare(`
  INSERT INTO purchase_items (purchase_id, item_id, item_name, hsn_code, metric, quantity, unit_cost,
    sgst_rate, cgst_rate, igst_rate, sgst_amount, cgst_amount, igst_amount, total_amount, selling_price, profit_percent)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertBatch = db.prepare(`
  INSERT INTO stock_batches (item_id, source, purchase_id, purchase_item_id, received_at, quantity_received, quantity_remaining, unit_cost, selling_price, created_at)
  VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertPayment = db.prepare(`
  INSERT INTO supplier_payments (supplier_id, amount, paid_on, method, reference, note, user_id, user_name, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertAllocation = db.prepare('INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount) VALUES (?, ?, ?)');
const insertAudit = db.prepare(`
  INSERT INTO audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, details, created_at)
  VALUES (?, ?, 'admin', ?, ?, ?, ?, ?)
`);

const paidSoFar = (purchaseId: number) =>
  (db.prepare('SELECT COALESCE(SUM(amount), 0) AS paid FROM supplier_payment_allocations WHERE purchase_id = ?').get(purchaseId) as any).paid as number;

/** Record a payment and settle the supplier's oldest unpaid demo-or-real purchases first, as the app does. */
const pay = (supplierId: number, supplierName: string, payment: Payment, onlyPurchaseId?: number) => {
  const when = at(payment.daysAgo, 16, 30);
  const outstanding = (db.prepare(`
    SELECT p.id, p.purchase_number, p.total_amount FROM purchases p
    WHERE p.supplier_id = ? ${onlyPurchaseId ? 'AND p.id = ?' : ''}
      AND p.created_at <= ?
    ORDER BY COALESCE(NULLIF(p.invoice_date, ''), date(datetime(p.created_at, '+5 hours', '+30 minutes'))), p.created_at, p.id
  `).all(...(onlyPurchaseId ? [supplierId, onlyPurchaseId, when.sqlite] : [supplierId, when.sqlite])) as any[])
    .map((p) => ({ ...p, due: round2(p.total_amount - paidSoFar(p.id)) }))
    .filter((p) => p.due > 0);
  const owed = round2(outstanding.reduce((acc, p) => acc + p.due, 0));
  const amount = payment.amount === 'rest' ? owed : round2(payment.amount);
  if (!(amount > 0) || amount > owed) throw new Error(`Demo payment of ${amount} to ${supplierName} does not fit ${owed} owed`);

  const paymentId = Number(insertPayment.run(
    supplierId, amount, when.day, payment.method, payment.reference ?? null, payment.note ?? null, admin.id, admin.name, when.sqlite
  ).lastInsertRowid);
  let left = amount;
  const settled: string[] = [];
  for (const p of outstanding) {
    if (left <= 0) break;
    const take = round2(Math.min(left, p.due));
    insertAllocation.run(paymentId, p.id, take);
    settled.push(`${p.purchase_number} ₹${take.toFixed(2)}`);
    left = round2(left - take);
  }
  insertAudit.run(admin.id, admin.name, 'supplier_payment', 'supplier', String(supplierId),
    `Paid ₹${amount.toFixed(2)} to ${supplierName} on ${when.day}, against ${settled.join(', ')}`, when.sqlite);
  return amount;
};

const seed = db.transaction(() => {
  const touchedItems = new Set<number>();
  const summary: string[] = [];

  // Purchases and later payments, interleaved in date order, so a later
  // payment only settles invoices that existed on the day it was made.
  const events = [
    ...PURCHASES.map((p) => ({ daysAgo: p.daysAgo, kind: 'purchase' as const, p })),
    ...LATER_PAYMENTS.map((p) => ({ daysAgo: p.daysAgo, kind: 'payment' as const, p })),
  ].sort((a, b) => b.daysAgo - a.daysAgo);

  for (const event of events) {
    if (event.kind === 'payment') {
      const supplier = supplierByName(event.p.supplier);
      const amount = pay(supplier.id, supplier.name, event.p);
      summary.push(`  paid     ${supplier.name.padEnd(30)} ₹${amount.toFixed(2).padStart(11)}  ${event.p.method ?? '-'}  (${event.p.daysAgo} days ago)`);
      continue;
    }

    const demo = event.p;
    const supplier = supplierByName(demo.supplier);
    const when = at(demo.daysAgo);
    const lines = demo.lines.map((line) => {
      const item = itemByName(line.item);
      const gstRate = saleGstRate(item);
      // Cost before GST: the selling price less GST and about an 18% margin.
      const unitCost = round2(item.price / (1 + gstRate / 100) / 1.18);
      const taxable = round2(line.quantity * unitCost);
      const half = gstRate / 2;
      const sgst = demo.igst ? 0 : round2((taxable * half) / 100);
      const cgst = demo.igst ? 0 : round2((taxable * half) / 100);
      const igst = demo.igst ? round2((taxable * gstRate) / 100) : 0;
      return { item, quantity: line.quantity, unitCost, gstRate, half, taxable, sgst, cgst, igst, total: round2(taxable + sgst + cgst + igst) };
    });
    const subtotal = round2(lines.reduce((acc, l) => acc + l.taxable, 0));
    const tax = round2(lines.reduce((acc, l) => acc + l.sgst + l.cgst + l.igst, 0));
    const total = round2(subtotal + tax);
    const number = nextPurchaseNumber(when.dayKey);

    const purchaseId = Number(insertPurchase.run(
      number, supplier.id, supplier.name, supplier.phone, supplier.address, supplier.gstin,
      demo.invoice, when.day, DEMO_NOTE, admin.id, subtotal, tax, total, when.sqlite
    ).lastInsertRowid);

    for (const line of lines) {
      const profit = profitPercentFromSellingPrice(line.unitCost, line.item.price, line.gstRate);
      const lineId = Number(insertLine.run(
        purchaseId, line.item.id, line.item.name, line.item.hsn_code, line.item.metric, line.quantity, line.unitCost,
        demo.igst ? 0 : line.half, demo.igst ? 0 : line.half, demo.igst ? line.gstRate : 0,
        line.sgst, line.cgst, line.igst, line.total, line.item.price, profit
      ).lastInsertRowid);
      insertBatch.run(line.item.id, purchaseId, lineId, when.sqlite, line.quantity, line.quantity, line.unitCost, line.item.price, when.sqlite);
      touchedItems.add(line.item.id);
    }

    insertAudit.run(admin.id, admin.name, 'create', 'purchase', String(purchaseId),
      `Created purchase ${number} from ${supplier.name} for amount ₹${total.toFixed(2)}`, when.sqlite);
    summary.push(`  purchase ${supplier.name.padEnd(30)} ₹${total.toFixed(2).padStart(11)}  ${number}  (${demo.daysAgo} days ago)`);

    if (demo.paidAtPurchase) {
      pay(supplier.id, supplier.name, { ...demo.paidAtPurchase, daysAgo: demo.daysAgo, note: demo.paidAtPurchase.note ?? `Paid at purchase ${number}` }, purchaseId);
    }
  }

  for (const itemId of touchedItems) syncItemStock(itemId);
  return summary;
});

const summary = seed();

const owed = db.prepare(`
  SELECT s.name, ROUND(SUM(p.total_amount - COALESCE((SELECT SUM(a.amount) FROM supplier_payment_allocations a WHERE a.purchase_id = p.id), 0)), 2) AS due
  FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
  GROUP BY s.id HAVING due > 0.005 ORDER BY due DESC
`).all() as Array<{ name: string; due: number }>;

console.log(`\nAdded:\n${summary.join('\n')}`);
console.log(`\nNow owed to suppliers:\n${owed.map((o) => `  ${o.name.padEnd(32)} ₹${o.due.toFixed(2)}`).join('\n')}`);
console.log(`  ${'Total'.padEnd(32)} ₹${owed.reduce((acc, o) => acc + o.due, 0).toFixed(2)}`);
