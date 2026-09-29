/**
 * Demo data seeder — bakery raw-materials distributor.
 *
 * Populates a realistic-looking dataset for client demos: a catalogue of
 * bakery ingredients, bakery-owner customers, suppliers, ~2 months of sales
 * history, purchase entries, and matching audit logs.
 *
 *   npx tsx scripts/seed-demo.ts           # seed an empty database
 *   npx tsx scripts/seed-demo.ts --reset   # wipe existing data first
 *
 * NOT for production. It creates demo staff logins with known passwords
 * (printed at the end) so the role-based screens can be shown. Delete the
 * database, or deactivate those accounts, before the shop goes live.
 *
 * Prices are indicative wholesale rates for the Indian market and GST rates
 * follow the GST 2.0 structure effective 22 Sep 2025 (12% and 28% slabs
 * removed; most food inputs at 5%, essences/colours/packaging at 18%).
 * Verify HSN codes and rates with your accountant before real billing.
 */
import bcrypt from 'bcryptjs';
import db, { initDb } from '../db/index';

const RESET = process.argv.includes('--reset');

// --- Deterministic PRNG, so repeated runs produce identical demo data ---
let seedState = 20260908;
const rand = () => {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
};
const randInt = (min: number, max: number) => Math.floor(rand() * (max - min + 1)) + min;
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)];
const chance = (p: number) => rand() < p;

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

// --- IST-aware timestamps -------------------------------------------------
// The app renders every date by shifting created_at by +5:30, so timestamps
// are stored in UTC. Build the IST wall-clock time we want, then convert back.
const IST_OFFSET = 5.5 * 60 * 60 * 1000;

const makeTimestamp = (daysAgo: number, hour: number, minute: number) => {
  const istNow = new Date(Date.now() + IST_OFFSET);
  const istWall = new Date(
    Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate() - daysAgo, hour, minute, randInt(0, 59))
  );
  const utc = new Date(istWall.getTime() - IST_OFFSET);
  return {
    sqlite: utc.toISOString().slice(0, 19).replace('T', ' '),
    dayKey: `${String(istWall.getUTCDate()).padStart(2, '0')}${String(istWall.getUTCMonth() + 1).padStart(2, '0')}${istWall.getUTCFullYear()}`,
    sortKey: utc.getTime(),
  };
};

// --- Catalogue ------------------------------------------------------------
// price is the GST-inclusive rate charged to the bakery, matching how the
// billing screen and receipt treat item.price.
type SeedItem = {
  name: string;
  hsn: string;
  price: number;
  metric: string;
  gst: number;
  loose?: boolean;
  /** Typical units moved per sale, used to keep demo quantities believable. */
  qty: [number, number];
};

const CATALOGUE: SeedItem[] = [
  // Sugars & syrups
  { name: 'Icing Sugar (1 kg)', hsn: '17019990', price: 78, metric: 'packet', gst: 5, qty: [2, 10] },
  { name: 'Castor Sugar (1 kg)', hsn: '17019990', price: 68, metric: 'packet', gst: 5, qty: [2, 8] },
  { name: 'Liquid Glucose (5 kg)', hsn: '17023090', price: 430, metric: 'box', gst: 5, qty: [1, 3] },
  { name: 'Fondant - White (1 kg)', hsn: '17049090', price: 295, metric: 'packet', gst: 5, qty: [1, 4] },

  // Flours & starches
  { name: 'Refined Maida - Bakers Grade (25 kg)', hsn: '11010000', price: 880, metric: 'bag', gst: 5, qty: [1, 6] },
  { name: 'Whole Wheat Atta (25 kg)', hsn: '11010000', price: 960, metric: 'bag', gst: 5, qty: [1, 4] },
  { name: 'Corn Flour (1 kg)', hsn: '11081200', price: 88, metric: 'packet', gst: 5, qty: [2, 8] },
  { name: 'Custard Powder - Vanilla (1 kg)', hsn: '19019090', price: 190, metric: 'packet', gst: 5, qty: [1, 4] },
  { name: 'Bread Improver (1 kg)', hsn: '19019090', price: 245, metric: 'packet', gst: 5, qty: [1, 3] },

  // Leavening
  { name: 'Instant Dry Yeast (500 g)', hsn: '21021000', price: 210, metric: 'packet', gst: 5, qty: [2, 10] },
  { name: 'Fresh Compressed Yeast (500 g)', hsn: '21021000', price: 85, metric: 'packet', gst: 5, qty: [2, 12] },
  { name: 'Baking Powder (1 kg)', hsn: '21023000', price: 180, metric: 'packet', gst: 5, qty: [1, 5] },
  { name: 'Baking Soda - Food Grade (1 kg)', hsn: '28363000', price: 65, metric: 'packet', gst: 5, qty: [1, 6] },
  { name: 'Cake Gel / Emulsifier (1 kg)', hsn: '38249900', price: 215, metric: 'packet', gst: 18, qty: [1, 4] },

  // Essences & colours (18% slab)
  { name: 'Vanilla Essence (500 ml)', hsn: '33021090', price: 165, metric: 'packet', gst: 18, qty: [1, 6] },
  { name: 'Pineapple Essence (500 ml)', hsn: '33021090', price: 155, metric: 'packet', gst: 18, qty: [1, 5] },
  { name: 'Butterscotch Essence (500 ml)', hsn: '33021090', price: 172, metric: 'packet', gst: 18, qty: [1, 5] },
  { name: 'Rose Essence (500 ml)', hsn: '33021090', price: 148, metric: 'packet', gst: 18, qty: [1, 4] },
  { name: 'Food Colour Gel - Assorted (100 g)', hsn: '32041990', price: 95, metric: 'piece', gst: 18, qty: [2, 10] },
  { name: 'Gelatin Powder - Food Grade (500 g)', hsn: '35030020', price: 390, metric: 'packet', gst: 18, qty: [1, 3] },

  // Cocoa & chocolate
  { name: 'Cocoa Powder - Alkalised (1 kg)', hsn: '18050000', price: 520, metric: 'packet', gst: 5, qty: [1, 5] },
  { name: 'Dark Chocolate Compound (500 g)', hsn: '18069010', price: 230, metric: 'packet', gst: 5, qty: [2, 10] },
  { name: 'Milk Chocolate Compound (500 g)', hsn: '18069010', price: 245, metric: 'packet', gst: 5, qty: [2, 8] },
  { name: 'Choco Chips - Bake Stable (1 kg)', hsn: '18063100', price: 385, metric: 'packet', gst: 5, qty: [1, 5] },

  // Fats & dairy
  { name: 'Bakery Shortening (15 kg)', hsn: '15179090', price: 1850, metric: 'box', gst: 5, qty: [1, 3] },
  { name: 'Unsalted Table Butter (500 g)', hsn: '04051000', price: 288, metric: 'packet', gst: 5, qty: [2, 12] },
  { name: 'Dairy Whitener / Milk Powder (1 kg)', hsn: '04022100', price: 425, metric: 'packet', gst: 5, qty: [1, 6] },
  { name: 'Condensed Milk (400 g)', hsn: '04029990', price: 135, metric: 'piece', gst: 5, qty: [3, 15] },
  { name: 'Non-Dairy Whipping Cream (1 kg)', hsn: '21069099', price: 385, metric: 'packet', gst: 5, qty: [2, 10] },
  { name: 'Cream Cheese (1 kg)', hsn: '04061000', price: 645, metric: 'packet', gst: 5, qty: [1, 4] },

  // Fruit, nuts & garnish (sold loose by weight)
  { name: 'Tutti Frutti - Mixed', hsn: '20060000', price: 145, metric: 'kg', gst: 5, loose: true, qty: [1, 5] },
  { name: 'Glazed Cherries', hsn: '20060000', price: 325, metric: 'kg', gst: 5, loose: true, qty: [1, 3] },
  { name: 'Almonds - Whole', hsn: '08021200', price: 785, metric: 'kg', gst: 5, loose: true, qty: [1, 3] },
  { name: 'Cashew Nuts W320', hsn: '08013220', price: 925, metric: 'kg', gst: 5, loose: true, qty: [1, 3] },
  { name: 'Desiccated Coconut', hsn: '08011100', price: 265, metric: 'kg', gst: 5, loose: true, qty: [1, 4] },
  { name: 'Mixed Dry Fruits - Cake Mix', hsn: '08062010', price: 545, metric: 'kg', gst: 5, loose: true, qty: [1, 4] },

  // Packaging (18% slab)
  { name: 'Cake Box 1 kg (pack of 25)', hsn: '48191010', price: 345, metric: 'packet', gst: 18, qty: [1, 6] },
  { name: 'Silver Cake Board 10 inch (pack of 25)', hsn: '48191010', price: 425, metric: 'packet', gst: 18, qty: [1, 4] },
  { name: 'Butter Paper Sheets (pack of 500)', hsn: '48064000', price: 285, metric: 'packet', gst: 18, qty: [1, 5] },
  { name: 'Piping Bags - Disposable (pack of 100)', hsn: '39232990', price: 195, metric: 'packet', gst: 18, qty: [1, 6] },
];

// --- Bakery-owner customers ----------------------------------------------
const CUSTOMERS = [
  { name: 'Anitha Rao', phone: '9845012345', shop: 'Sri Ganesh Bakery', addr: '14, 4th Cross, Malleshwaram, Bengaluru 560003', gstin: '29AABCS1234A1Z5' },
  { name: 'Mohammed Irfan', phone: '9886123456', shop: 'New Crescent Bakery & Confectionery', addr: '82, Shivajinagar Main Road, Bengaluru 560051', gstin: '29AACFN5678B1Z2' },
  { name: 'Suresh Kumar', phone: '9448023456', shop: 'Sri Lakshmi Cake House', addr: '7, Gandhi Bazaar, Basavanagudi, Bengaluru 560004', gstin: '29AADCL9012C1Z8' },
  { name: 'Priya Menon', phone: '9900234567', shop: 'Sweet Symphony Patisserie', addr: '221, 100 Ft Road, Indiranagar, Bengaluru 560038', gstin: '29AAECS3456D1Z4' },
  { name: 'Ramesh Shetty', phone: '9741034567', shop: 'Udupi Fresh Bakes', addr: '45, Car Street, Udupi 576101', gstin: '29AAFCU7890E1Z9' },
  { name: 'Fathima Begum', phone: '9535045678', shop: 'Al-Noor Bakery', addr: '3, Mosque Road, Frazer Town, Bengaluru 560005', gstin: '29AAGCA2345F1Z6' },
  { name: 'Vinod Hegde', phone: '9448156789', shop: 'Malnad Bakery Works', addr: '18, B H Road, Shivamogga 577201', gstin: '29AAHCM6789G1Z1' },
  { name: 'Deepa Nair', phone: '9611267890', shop: 'Cocoa Bloom Cake Studio', addr: '9, Sarjapur Road, Bengaluru 560035', gstin: '29AAJCC0123H1Z7' },
  { name: 'Karthik Reddy', phone: '9880378901', shop: 'Golden Crust Bakers', addr: '66, Vijayanagar Main Road, Bengaluru 560040', gstin: '29AAKCG4567I1Z3' },
  { name: 'Shalini Gupta', phone: '9964489012', shop: 'Butter & Bloom Home Bakery', addr: '12, HSR Layout Sector 2, Bengaluru 560102', gstin: '' },
  { name: 'Imran Pasha', phone: '9845590123', shop: 'Bismillah Bakery', addr: '27, Tannery Road, Bengaluru 560005', gstin: '29AALCB8901J1Z5' },
  { name: 'Latha Krishnan', phone: '9483601234', shop: 'Annapoorna Sweets & Bakery', addr: '5, Temple Street, Mysuru 570001', gstin: '29AAMCA2345K1Z0' },
];

const SUPPLIERS = [
  { name: 'Bakels India Pvt Ltd', phone: '08028394050', addr: 'Plot 14, Peenya Industrial Area, Bengaluru 560058', gstin: '29AABCB1111A1Z3' },
  { name: 'Zeelac Food Ingredients', phone: '08041225566', addr: '22, Rajajinagar Industrial Estate, Bengaluru 560010', gstin: '29AACFZ2222B1Z9' },
  { name: 'Sunrise Flour Mills', phone: '08182223344', addr: 'NH-206, Davangere Road, Shivamogga 577205', gstin: '29AADCS3333C1Z6' },
  { name: 'Kwality Dairy Products', phone: '08026677889', addr: '8, KIADB Industrial Area, Hosur Road, Bengaluru 560099', gstin: '29AAECK4444D1Z2' },
  { name: 'Shree Ram Food Additives', phone: '02226554433', addr: 'Unit 3, MIDC Andheri East, Mumbai 400093', gstin: '27AAFCS5555E1Z8' },
  { name: 'Pack-Well Packaging Solutions', phone: '08033445566', addr: '51, Bommasandra Industrial Area, Bengaluru 560099', gstin: '29AAGCP6666F1Z4' },
];

// --- Guard against clobbering real data ----------------------------------
initDb();

const existingBills = (db.prepare('SELECT COUNT(*) c FROM bills').get() as any).c;
const existingItems = (db.prepare('SELECT COUNT(*) c FROM items').get() as any).c;

if ((existingBills > 0 || existingItems > 0) && !RESET) {
  console.error(
    `\nRefusing to run: the database already has ${existingItems} item(s) and ${existingBills} bill(s).\n` +
    `Re-run with --reset to erase them and reseed:\n\n    npx tsx scripts/seed-demo.ts --reset\n`
  );
  process.exit(1);
}

const seed = db.transaction(() => {
  if (RESET) {
    // Child rows first — foreign keys are enforced.
    for (const table of ['bill_items', 'purchase_items', 'bills', 'purchases', 'audit_logs', 'items', 'customers', 'suppliers', 'document_counters']) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    db.prepare("DELETE FROM sqlite_sequence WHERE name NOT IN ('users')").run();
    db.prepare("DELETE FROM users WHERE role = 'cashier'").run();
  }

  // --- Shop identity ---
  db.prepare(`
    UPDATE settings SET shop_name = ?, shop_address = ?, shop_phone = ?, shop_gstin = ?,
      bill_format = ?, bill_header = ?, bill_footer = ? WHERE id = 1
  `).run(
    'Vyapara Bakery Supplies',
    '38, 2nd Main, Yeshwanthpur Industrial Suburb, Bengaluru 560022',
    '+91 80 2337 4400',
    '29AAACV1234M1ZK',
    'thermal',
    'BAKERY RAW MATERIALS - WHOLESALE',
    'Goods once sold will not be taken back. Thank you!'
  );

  // --- Demo logins ---
  // The admin password is reset to a known value so the demo can actually be
  // driven. This is the whole reason this script is demo-only: real installs
  // get a random admin password printed once at first startup.
  const ADMIN_DEMO_PASSWORD = 'DemoAdmin2026';
  db.prepare('UPDATE users SET password = ?, token_version = token_version + 1 WHERE role = ?')
    .run(bcrypt.hashSync(ADMIN_DEMO_PASSWORD, 12), 'admin');

  const demoStaff = [
    { username: 'priya', password: 'DemoPriya2026', name: 'Priya Shetty' },
    { username: 'arun', password: 'DemoArun2026', name: 'Arun Kumar' },
  ];
  for (const staff of demoStaff) {
    db.prepare('INSERT OR IGNORE INTO users (username, password, role, name) VALUES (?, ?, ?, ?)')
      .run(staff.username, bcrypt.hashSync(staff.password, 12), 'cashier', staff.name);
  }

  const users = db.prepare("SELECT id, name, role FROM users").all() as any[];
  const admin = users.find((u) => u.role === 'admin');
  const cashiers = users.filter((u) => u.role === 'cashier');
  const billingStaff = [admin, ...cashiers];

  // --- Items ---
  const insertItem = db.prepare(`
    INSERT INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
    VALUES (?, ?, ?, ?, ?, 1, 'split', ?, ?, ?, 0, 0)
  `);
  const itemIds: number[] = [];
  for (const item of CATALOGUE) {
    const half = item.gst / 2;
    const res = insertItem.run(item.name, item.hsn, item.price, item.metric, item.loose ? 1 : 0, item.gst, half, half);
    itemIds.push(Number(res.lastInsertRowid));
  }
  const items = db.prepare('SELECT * FROM items ORDER BY id').all() as any[];

  // --- Customers & suppliers ---
  const insertCustomer = db.prepare(`
    INSERT INTO customers (name, phone, shop_name, address, gstin, credit_balance, created_at)
    VALUES (?, ?, ?, ?, ?, 0, ?)
  `);
  for (const c of CUSTOMERS) {
    insertCustomer.run(c.name, c.phone, c.shop, c.addr, c.gstin || null, makeTimestamp(randInt(60, 90), 10, 30).sqlite);
  }
  const customers = db.prepare('SELECT * FROM customers ORDER BY id').all() as any[];

  for (const s of SUPPLIERS) {
    db.prepare('INSERT INTO suppliers (name, phone, address, gstin, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(s.name, s.phone, s.addr, s.gstin, makeTimestamp(randInt(60, 90), 11, 0).sqlite);
  }

  // --- Plan sales, so purchases can be sized to cover them ---
  const DAYS = 60;
  type PlannedBill = {
    ts: ReturnType<typeof makeTimestamp>;
    customer: any | null;
    staff: any;
    lines: { item: any; quantity: number }[];
    discount: number;
    method: string;
  };

  const planned: PlannedBill[] = [];
  const soldPerItem = new Map<number, number>();

  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
    const weekday = new Date(Date.now() + IST_OFFSET - daysAgo * 86400000).getUTCDay();
    // Sunday is quiet for a wholesale supplier; weekdays are busy.
    // Tuned so weekly turnover lands in the ₹3-4 lakh range.
    const billCount = weekday === 0 ? randInt(1, 4) : randInt(7, 17);

    // Today's bills must not land later than the current time, or the demo
    // shows invoices dated in the future.
    const istNowHour = new Date(Date.now() + IST_OFFSET).getUTCHours();
    const latestHour = daysAgo === 0 ? Math.max(8, Math.min(19, istNowHour)) : 19;

    for (let n = 0; n < billCount; n++) {
      const ts = makeTimestamp(daysAgo, randInt(8, latestHour), randInt(0, 59));
      const lineCount = randInt(2, 6);
      const chosen = new Set<number>();
      const lines: { item: any; quantity: number }[] = [];

      while (lines.length < lineCount) {
        const idx = randInt(0, items.length - 1);
        if (chosen.has(idx)) continue;
        chosen.add(idx);
        const item = items[idx];
        const spec = CATALOGUE[idx];
        const quantity = item.is_loose
          ? Number((randInt(spec.qty[0] * 2, spec.qty[1] * 2) / 2).toFixed(1))
          : randInt(spec.qty[0], spec.qty[1]);
        lines.push({ item, quantity });
        soldPerItem.set(item.id, (soldPerItem.get(item.id) || 0) + quantity);
      }

      // Wholesale buyers are mostly registered; a few are walk-in cash sales.
      let customer = chance(0.78) ? pick(customers) : null;
      let method = chance(0.34) ? 'upi' : chance(0.5) ? 'cash' : chance(0.55) ? 'credit' : 'split';
      if (method === 'credit' && !customer) customer = pick(customers);

      planned.push({
        ts,
        customer,
        staff: pick(billingStaff),
        lines,
        discount: chance(0.18) ? randInt(1, 12) * 25 : 0,
        method,
      });
    }
  }

  planned.sort((a, b) => a.ts.sortKey - b.ts.sortKey);

  // --- Purchases: stock up ahead of sales, leaving healthy closing stock ---
  const purchasedPerItem = new Map<number, number>();
  const dayCounters = new Map<string, number>();
  const nextNumber = (prefix: string, dayKey: string) => {
    const scope = `${prefix}:${dayKey}`;
    const next = (dayCounters.get(scope) || 0) + 1;
    dayCounters.set(scope, next);
    return `${prefix}-${dayKey}-${String(next).padStart(5, '0')}`;
  };

  const insertPurchase = db.prepare(`
    INSERT INTO purchases (purchase_number, supplier_name, supplier_phone, supplier_address, supplier_gstin,
      invoice_number, invoice_date, notes, user_id, subtotal_amount, tax_amount, total_amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertPurchaseItem = db.prepare(`
    INSERT INTO purchase_items (purchase_id, item_id, item_name, hsn_code, metric, quantity, unit_cost,
      sgst_rate, cgst_rate, igst_rate, sgst_amount, cgst_amount, igst_amount, total_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const purchaseAudits: any[] = [];
  // Six restocking runs across the window, each covering a slice of the catalogue.
  const purchaseDays = [58, 47, 36, 25, 14, 5];

  purchaseDays.forEach((daysAgo, runIndex) => {
    const supplier = SUPPLIERS[runIndex % SUPPLIERS.length];
    const ts = makeTimestamp(daysAgo, randInt(9, 16), randInt(0, 59));
    // Each item is restocked in 2 of the 6 runs, so the purchase history looks
    // like real periodic replenishment rather than one bulk buy per product.
    const slice = items.filter((_, idx) => idx % 3 === runIndex % 3);
    if (slice.length === 0) return;

    const lines = slice.map((item) => {
      const catalogueIndex = items.findIndex((i) => i.id === item.id);
      const spec = CATALOGUE[catalogueIndex];
      // Each item is bought across RUNS_PER_ITEM runs, so each run must cover
      // its share of the period's sales plus a margin that becomes closing stock.
      const RUNS_PER_ITEM = 2;
      const needed = (soldPerItem.get(item.id) || 0) / RUNS_PER_ITEM;
      // 1.12 leaves ~12% of the period's volume as closing stock — enough to
      // show real inventory without making purchases swallow the gross margin.
      const quantity = Math.max(spec.qty[1] * 2, Math.ceil(needed * 1.12));
      // Distributors buy at roughly 70-78% of their selling rate, giving the
      // ~22-30% gross margin typical of bakery-ingredient wholesale.
      const unitCost = round2(item.price * (0.70 + rand() * 0.08));
      const taxable = round2(quantity * unitCost);
      const half = item.gst_rate / 2;
      const sgst = round2((taxable * half) / 100);
      const cgst = round2((taxable * half) / 100);
      purchasedPerItem.set(item.id, (purchasedPerItem.get(item.id) || 0) + quantity);
      return { item, quantity, unitCost, taxable, half, sgst, cgst, total: round2(taxable + sgst + cgst) };
    });

    const subtotal = round2(lines.reduce((a, l) => a + l.taxable, 0));
    const tax = round2(lines.reduce((a, l) => a + l.sgst + l.cgst, 0));
    const purchaseNumber = nextNumber('PUR', ts.dayKey);

    const res = insertPurchase.run(
      purchaseNumber, supplier.name, supplier.phone, supplier.addr, supplier.gstin,
      `${supplier.name.split(' ')[0].toUpperCase()}/${2026}/${1000 + runIndex}`,
      ts.sqlite.slice(0, 10), 'Stock replenishment', admin.id,
      subtotal, tax, round2(subtotal + tax), ts.sqlite
    );
    const purchaseId = Number(res.lastInsertRowid);

    for (const l of lines) {
      insertPurchaseItem.run(
        purchaseId, l.item.id, l.item.name, l.item.hsn_code, l.item.metric,
        l.quantity, l.unitCost, l.half, l.half, 0, l.sgst, l.cgst, 0, l.total
      );
    }

    purchaseAudits.push({
      ts: ts.sqlite, user: admin, action: 'create', entity: 'purchase', id: purchaseId,
      details: `Created purchase ${purchaseNumber} from ${supplier.name} for amount ₹${round2(subtotal + tax).toFixed(2)}`,
    });
  });

  // --- Bills ---
  const insertBill = db.prepare(`
    INSERT INTO bills (bill_number, customer_id, user_id, total_amount, tax_amount, discount_amount,
      payment_method, cash_amount, upi_amount, credit_amount, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertBillItem = db.prepare(`
    INSERT INTO bill_items (bill_id, item_id, quantity, price, sgst_amount, cgst_amount, igst_amount, total_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const creditPerCustomer = new Map<number, number>();
  const billAudits: any[] = [];

  for (const bill of planned) {
    let subtotal = 0;
    let tax = 0;
    const lines = bill.lines.map(({ item, quantity }) => {
      // Mirrors computeUnitTaxBreakdown in server.ts: price is GST-inclusive.
      const sgstUnit = (item.price * item.sgst_rate) / 100;
      const cgstUnit = (item.price * item.cgst_rate) / 100;
      const baseUnit = item.price - sgstUnit - cgstUnit;
      const lineSgst = round2(sgstUnit * quantity);
      const lineCgst = round2(cgstUnit * quantity);
      const lineTotal = round2(item.price * quantity);
      // Same derivation as server.ts: taxable = line total - rounded taxes, so
      // line amounts always sum to the printed subtotal.
      const lineTaxable = round2(lineTotal - lineSgst - lineCgst);
      subtotal += lineTaxable;
      tax += lineSgst + lineCgst;
      return {
        item_id: item.id, quantity,
        price: quantity > 0 ? round2(lineTaxable / quantity) : 0,
        sgst: lineSgst, cgst: lineCgst, total: lineTotal,
      };
    });

    subtotal = round2(subtotal);
    tax = round2(tax);
    const discount = Math.min(bill.discount, Math.floor((subtotal + tax) * 0.1));
    const total = round2(subtotal + tax - discount);

    let cash = 0, upi = 0, credit = 0;
    if (bill.method === 'cash') cash = total;
    else if (bill.method === 'upi') upi = total;
    else if (bill.method === 'credit') credit = total;
    else {
      cash = round2(total * (0.3 + rand() * 0.3));
      upi = round2(total - cash);
    }

    const billNumber = nextNumber('INV', bill.ts.dayKey);
    const res = insertBill.run(
      billNumber, bill.customer?.id ?? null, bill.staff.id, total, tax, discount,
      bill.method, cash, upi, credit, bill.ts.sqlite
    );
    const billId = Number(res.lastInsertRowid);

    for (const l of lines) {
      insertBillItem.run(billId, l.item_id, l.quantity, l.price, l.sgst, l.cgst, 0, l.total);
    }

    if (bill.customer && credit > 0) {
      creditPerCustomer.set(bill.customer.id, round2((creditPerCustomer.get(bill.customer.id) || 0) + credit));
    }

    billAudits.push({
      ts: bill.ts.sqlite, user: bill.staff, action: 'create', entity: 'bill', id: billId,
      details: `Created bill ${billNumber} for amount ₹${total.toFixed(2)}`,
    });
  }

  // --- Outstanding credit, and closing stock ---
  for (const [customerId, amount] of creditPerCustomer) {
    // Most bakeries have settled part of their dues; leave a realistic balance.
    const outstanding = round2(amount * (0.35 + rand() * 0.5));
    db.prepare('UPDATE customers SET credit_balance = ? WHERE id = ?').run(outstanding, customerId);
  }

  const setStock = db.prepare('UPDATE items SET stock_quantity = ? WHERE id = ?');
  let understocked = 0;
  for (const item of items) {
    const closing = round2((purchasedPerItem.get(item.id) || 0) - (soldPerItem.get(item.id) || 0));
    // Should never trigger: purchases are sized to cover sales. Counted rather
    // than silently clamped, so a sizing regression is visible in the output.
    if (closing < 0) understocked++;
    setStock.run(Math.max(closing, 0), item.id);
  }
  if (understocked > 0) {
    console.warn(`[warn] ${understocked} item(s) sold more than was purchased; stock floored at 0.`);
  }

  // --- Document counters, so the next real bill continues the sequence ---
  for (const [scope, value] of dayCounters) {
    db.prepare('INSERT OR REPLACE INTO document_counters (scope, last_value) VALUES (?, ?)').run(scope, value);
  }

  // --- Audit log ---
  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (user_id, user_name, user_role, action, entity_type, entity_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const audits = [...billAudits, ...purchaseAudits].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  for (const a of audits) {
    insertAudit.run(a.user.id, a.user.name, a.user.role, a.action, a.entity, String(a.id), a.details, a.ts);
  }
  // A few sign-in events so the Logs screen isn't uniform.
  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo -= 3) {
    const staff = pick(billingStaff);
    const ts = makeTimestamp(daysAgo, 8, randInt(0, 45));
    insertAudit.run(staff.id, staff.name, staff.role, 'login', 'auth', String(staff.id), `${staff.name} signed in`, ts.sqlite);
  }

  return {
    items: items.length,
    customers: customers.length,
    suppliers: SUPPLIERS.length,
    bills: planned.length,
    purchases: purchaseDays.length,
    audits: audits.length,
    demoStaff: [{ username: 'admin', password: ADMIN_DEMO_PASSWORD, name: 'System Admin (admin)' }, ...demoStaff],
  };
});

const summary = seed();

const revenue = (db.prepare('SELECT SUM(total_amount) t FROM bills').get() as any).t || 0;
const outstanding = (db.prepare('SELECT SUM(credit_balance) t FROM customers').get() as any).t || 0;

console.log(`
Demo data seeded.

  Items          ${summary.items}
  Customers      ${summary.customers} bakery owners
  Suppliers      ${summary.suppliers}
  Bills          ${summary.bills}  (last 60 days)
  Purchases      ${summary.purchases}
  Audit entries  ${summary.audits}

  Total sales    ₹${revenue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
  Outstanding    ₹${outstanding.toLocaleString('en-IN', { maximumFractionDigits: 2 })}

Demo logins — CHANGE THESE before the shop goes live:
${summary.demoStaff.map((s) => `  ${s.username} / ${s.password}   (${s.name})`).join('\n')}
`);

db.close();
