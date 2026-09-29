import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Where the database lives. Overridable so a deployment can put the file on a
// backed-up volume rather than inside the application directory, and so the
// test suite can run against a throwaway database instead of the real books.
export const dbPath = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), 'pos.db');

// Creating the database must not fail just because the parent directory does
// not exist yet — that is the normal case for DB_PATH=/var/lib/vyapara/pos.db.
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

// Enable foreign keys so orphaned bill/purchase rows can never be created.
db.pragma('foreign_keys = ON');

// WAL lets readers (reports, analytics, the dashboard) run concurrently with
// writers (billing) instead of blocking each other. At a few lakh transactions
// a week this is the difference between a responsive till and SQLITE_BUSY
// errors during the evening rush.
db.pragma('journal_mode = WAL');
// Wait up to 5s for a lock instead of instantly throwing SQLITE_BUSY.
db.pragma('busy_timeout = 5000');
// NORMAL is durable under application crashes (only a power loss at the wrong
// microsecond can lose the last commit) and much faster than FULL.
db.pragma('synchronous = NORMAL');
// Keep the WAL file from growing without bound.
db.pragma('wal_autocheckpoint = 1000');

const ensureColumn = (tableName: string, columnName: string, definition: string) => {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  const exists = columns.some((column) => column.name === columnName);

  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
};

const ensureIndex = (indexName: string, statement: string) => {
  db.exec(`CREATE INDEX IF NOT EXISTS ${indexName} ${statement}`);
};

// Initialize schema
export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT CHECK(role IN ('admin', 'cashier')) NOT NULL,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      barcode TEXT UNIQUE,
      hsn_code TEXT,
      price REAL NOT NULL,
      metric TEXT NOT NULL, -- kg, packet, box, piece
      is_loose INTEGER DEFAULT 0, -- 0 for false, 1 for true
      gst_applicable INTEGER DEFAULT 1,
      gst_mode TEXT DEFAULT 'split',
      gst_rate REAL DEFAULT 0,
      sgst_rate REAL DEFAULT 0,
      cgst_rate REAL DEFAULT 0,
      igst_rate REAL DEFAULT 0,
      image_url TEXT,
      stock_quantity REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      shop_name TEXT,
      address TEXT,
      gstin TEXT,
      credit_balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      phone TEXT,
      address TEXT,
      gstin TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      customer_id INTEGER,
      user_id INTEGER NOT NULL,
      subtotal_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      tax_amount REAL NOT NULL,
      discount_amount REAL DEFAULT 0,
      payment_method TEXT CHECK(payment_method IN ('cash', 'upi', 'credit', 'split')) NOT NULL,
      cash_amount REAL DEFAULT 0,
      upi_amount REAL DEFAULT 0,
      credit_amount REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity REAL NOT NULL,
      price REAL NOT NULL,
      sgst_amount REAL NOT NULL,
      cgst_amount REAL NOT NULL,
      igst_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      FOREIGN KEY (bill_id) REFERENCES bills(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_number TEXT UNIQUE NOT NULL,
      supplier_name TEXT NOT NULL,
      supplier_phone TEXT,
      supplier_address TEXT,
      supplier_gstin TEXT,
      invoice_number TEXT,
      invoice_date TEXT,
      notes TEXT,
      user_id INTEGER NOT NULL,
      subtotal_amount REAL NOT NULL,
      tax_amount REAL NOT NULL,
      total_amount REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      barcode TEXT,
      hsn_code TEXT,
      metric TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit_cost REAL NOT NULL,
      sgst_rate REAL NOT NULL DEFAULT 0,
      cgst_rate REAL NOT NULL DEFAULT 0,
      igst_rate REAL NOT NULL DEFAULT 0,
      sgst_amount REAL NOT NULL,
      cgst_amount REAL NOT NULL,
      igst_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      shop_name TEXT NOT NULL,
      shop_address TEXT NOT NULL,
      shop_phone TEXT NOT NULL,
      shop_gstin TEXT NOT NULL,
      bill_format TEXT CHECK(bill_format IN ('thermal', 'standard')) NOT NULL DEFAULT 'thermal',
      bill_header TEXT NOT NULL,
      bill_footer TEXT NOT NULL
    );

    -- Atomic per-day counters for bill/purchase numbers. Deriving the number
    -- from a wall-clock timestamp collides when two tills bill in the same
    -- second; a counter row bumped inside the write transaction cannot.
    CREATE TABLE IF NOT EXISTS document_counters (
      scope TEXT PRIMARY KEY,
      last_value INTEGER NOT NULL DEFAULT 0
    );

    -- Per-customer credit ledger: one row for every change to a customer's
    -- outstanding balance, so "when and how much" can be answered.
    --
    -- Deliberately NOT part of audit_logs, which is pruned after
    -- AUDIT_LOG_RETENTION_DAYS. This is a financial record of money owed to
    -- the shop and is never pruned.
    --
    -- amount is signed: positive increases what the customer owes (a credit
    -- sale), negative reduces it (a repayment). balance_after is stored
    -- rather than replayed, so a statement can be read straight off the table
    -- and a row still makes sense if an earlier one is ever corrected.
    CREATE TABLE IF NOT EXISTS customer_credit_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      bill_id INTEGER,
      entry_type TEXT NOT NULL CHECK(entry_type IN ('opening', 'sale', 'payment', 'adjustment')),
      amount REAL NOT NULL,
      balance_before REAL NOT NULL,
      balance_after REAL NOT NULL,
      note TEXT,
      user_id INTEGER,
      -- Snapshot of who did it, so the entry stays readable if the account is
      -- later renamed. The row must survive its author either way.
      user_name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES customers(id),
      FOREIGN KEY (bill_id) REFERENCES bills(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      user_name TEXT NOT NULL,
      user_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  ensureColumn('purchase_items', 'igst_rate', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('purchase_items', 'igst_amount', 'REAL NOT NULL DEFAULT 0');
  ensureColumn('items', 'hsn_code', 'TEXT');
  ensureColumn('purchase_items', 'hsn_code', 'TEXT');
  ensureColumn('items', 'gst_mode', "TEXT DEFAULT 'split'");
  ensureColumn('items', 'gst_rate', 'REAL DEFAULT 0');
  ensureColumn('items', 'igst_rate', 'REAL DEFAULT 0');
  ensureColumn('bill_items', 'igst_amount', 'REAL NOT NULL DEFAULT 0');
  // The taxable value of the bill. It used to be absent, so every screen that
  // needed it derived it independently — the receipt from the line items, the
  // history modal as `total - tax + discount` — and the two disagreed by the
  // paise the grand total drops when it is floored. Storing it once makes the
  // printed invoice, the on-screen summary and the GST return agree.
  ensureColumn('bills', 'subtotal_amount', 'REAL NOT NULL DEFAULT 0');
  db.exec(`UPDATE items SET hsn_code = barcode WHERE (hsn_code IS NULL OR hsn_code = '') AND barcode IS NOT NULL AND barcode != ''`);
  db.exec(`UPDATE purchase_items SET hsn_code = barcode WHERE (hsn_code IS NULL OR hsn_code = '') AND barcode IS NOT NULL AND barcode != ''`);
  db.exec(`UPDATE items SET gst_mode = 'split' WHERE gst_mode IS NULL OR gst_mode = ''`);
  db.exec(`UPDATE items SET gst_rate = COALESCE(sgst_rate, 0) + COALESCE(cgst_rate, 0) WHERE COALESCE(gst_rate, 0) = 0`);
  db.exec(`UPDATE items SET igst_rate = 0 WHERE igst_rate IS NULL`);
  // Bumped whenever a user's credentials change, so tokens issued before the
  // change stop validating instead of staying usable for the rest of their 12h.
  ensureColumn('users', 'token_version', 'INTEGER NOT NULL DEFAULT 0');
  // Lets an admin disable a cashier without deleting their historical bills.
  ensureColumn('users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');

  // Backfill the subtotal for bills written before the column existed, from
  // their own line items — the same derivation the receipt used to do at
  // render time, so a reprint of an old bill is unchanged.
  db.exec(`
    UPDATE bills SET subtotal_amount = ROUND(COALESCE((
      SELECT SUM(bi.total_amount - bi.sgst_amount - bi.cgst_amount - COALESCE(bi.igst_amount, 0))
      FROM bill_items bi WHERE bi.bill_id = bills.id
    ), 0), 2)
    WHERE subtotal_amount = 0
  `);

  // Seed the credit ledger for a database that predates it.
  //
  // Credit sales are recoverable exactly — bills records the customer, the
  // credit amount, the cashier and the timestamp. Everything else that moved a
  // balance (opening balances, repayments an admin entered by retyping the
  // number) left no itemised trace and cannot be reconstructed.
  //
  // So: list the real sales, then close with ONE reconciling entry for
  // whatever they do not explain.
  //
  // The reconciling entry goes LAST, not first. Putting it first produced a
  // negative opening balance for every customer whose past repayments exceeded
  // the sales still on file — a statement that opened at -10,514.98 and read
  // as though the shop owed the customer. Closing with it instead keeps the
  // running balance non-negative throughout (sales only ever add) and lands it
  // exactly on the stored balance. The pre-upgrade running figures are then
  // cumulative credit billed rather than true historical balances, which the
  // note on the entry says plainly.
  const ledgerSeeded = db.prepare('SELECT COUNT(*) AS c FROM customer_credit_entries').get() as { c: number };
  if (ledgerSeeded.c === 0) {
    const seed = db.transaction(() => {
      const customers = db.prepare('SELECT id, credit_balance, created_at FROM customers').all() as Array<{
        id: number; credit_balance: number; created_at: string;
      }>;
      const creditBills = db.prepare(`
        SELECT b.id, b.customer_id, b.credit_amount, b.bill_number, b.created_at,
               COALESCE(u.name, 'Unknown') AS user_name, b.user_id
        FROM bills b
        LEFT JOIN users u ON u.id = b.user_id
        WHERE b.customer_id IS NOT NULL AND b.credit_amount > 0
        ORDER BY b.created_at ASC, b.id ASC
      `).all() as Array<any>;

      const insert = db.prepare(`
        INSERT INTO customer_credit_entries
          (customer_id, bill_id, entry_type, amount, balance_before, balance_after, note, user_id, user_name, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
      // One timestamp for the whole reconciliation, in SQLite's format, so the
      // closing entries sort after every real sale.
      const migrationStamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

      const billsByCustomer = new Map<number, any[]>();
      for (const bill of creditBills) {
        const list = billsByCustomer.get(bill.customer_id) ?? [];
        list.push(bill);
        billsByCustomer.set(bill.customer_id, list);
      }

      for (const customer of customers) {
        const bills = billsByCustomer.get(customer.id) ?? [];
        const fromSales = round2(bills.reduce((acc, bill) => acc + bill.credit_amount, 0));
        const current = round2(customer.credit_balance || 0);
        const unexplained = round2(current - fromSales);

        let running = 0;
        for (const bill of bills) {
          const before = running;
          running = round2(running + bill.credit_amount);
          insert.run(
            customer.id, bill.id, 'sale', bill.credit_amount, before, running,
            `Credit sale on bill ${bill.bill_number}`,
            bill.user_id, bill.user_name, bill.created_at
          );
        }

        if (unexplained !== 0) {
          const before = running;
          running = round2(before + unexplained);
          insert.run(
            customer.id, null, 'adjustment', unexplained, before, running,
            'Reconciled when the credit ledger was introduced. Repayments and manual balance changes made before this date were never itemised, so they appear here as one figure. Running balances on rows above this one are cumulative credit billed, not the balance as it stood at the time.',
            null, 'System', migrationStamp
          );
        }
      }
    });
    seed();
  }

  // --- Indexes ---
  // Without these, every report/analytics query is a full table scan. At
  // ~4 lakh rows a week that degrades from milliseconds to seconds.
  ensureIndex('idx_items_hsn_code', 'ON items(hsn_code)');
  ensureIndex('idx_items_name', 'ON items(name)');
  ensureIndex('idx_bills_created_at', 'ON bills(created_at)');
  ensureIndex('idx_bills_customer_id', 'ON bills(customer_id)');
  ensureIndex('idx_bills_user_id', 'ON bills(user_id)');
  ensureIndex('idx_bill_items_bill_id', 'ON bill_items(bill_id)');
  ensureIndex('idx_bill_items_item_id', 'ON bill_items(item_id)');
  ensureIndex('idx_purchases_created_at', 'ON purchases(created_at)');
  ensureIndex('idx_purchase_items_purchase_id', 'ON purchase_items(purchase_id)');
  ensureIndex('idx_purchase_items_item_id', 'ON purchase_items(item_id)');
  ensureIndex('idx_audit_logs_created_at', 'ON audit_logs(created_at)');
  ensureIndex('idx_audit_logs_user_id', 'ON audit_logs(user_id)');
  ensureIndex('idx_customers_name', 'ON customers(name)');
  // A customer's statement is read newest-first and must stay fast as the
  // ledger grows.
  ensureIndex('idx_credit_entries_customer', 'ON customer_credit_entries(customer_id, created_at DESC, id DESC)');
  ensureIndex('idx_credit_entries_bill', 'ON customer_credit_entries(bill_id)');
  // Expression index so the IST-day analytics queries can use an index
  // instead of recomputing date(datetime(...)) for every row in the table.
  ensureIndex(
    'idx_bills_ist_date',
    "ON bills(date(datetime(created_at, '+5 hours', '+30 minutes')))"
  );

  // Demo/sample rows. A real shop should start with an empty catalogue and
  // customer list rather than fictional GSTINs and outstanding credit
  // balances that look like real receivables. Opt in with SEED_DEMO_DATA=true.
  if (process.env.SEED_DEMO_DATA === 'true') {
    // Seed items
    const items = [
      { name: 'White Bread', hsn_code: '8901234567890', price: 40, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 50 },
      { name: 'Brown Bread', hsn_code: '8901234567891', price: 50, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 30 },
      { name: 'Chocolate Cookies', hsn_code: '8901234567892', price: 120, metric: 'box', is_loose: 0, gst_applicable: 1, sgst_rate: 9, cgst_rate: 9, stock_quantity: 20 },
      { name: 'Milk (1L)', hsn_code: '8901234567893', price: 60, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 40 },
      { name: 'Fruit Cake', hsn_code: '8901234567894', price: 450, metric: 'piece', is_loose: 0, gst_applicable: 1, sgst_rate: 9, cgst_rate: 9, stock_quantity: 10 },
      { name: 'Burger Bun', hsn_code: '8901234567895', price: 15, metric: 'piece', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 100 },
      { name: 'Butter Croissant', hsn_code: '8901234567896', price: 80, metric: 'piece', is_loose: 0, gst_applicable: 1, sgst_rate: 9, cgst_rate: 9, stock_quantity: 15 },
      { name: 'Whole Wheat Flour (5kg)', hsn_code: '8901234567897', price: 250, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 20 },
      { name: 'Sugar (1kg)', hsn_code: '8901234567898', price: 45, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 100 },
      { name: 'Cooking Oil (1L)', hsn_code: '8901234567899', price: 180, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 60 },
      { name: 'Salt (1kg)', hsn_code: '8901234567900', price: 20, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 200 },
      { name: 'Tea Leaves (250g)', hsn_code: '8901234567901', price: 150, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 2.5, cgst_rate: 2.5, stock_quantity: 45 },
      { name: 'Coffee Powder (100g)', hsn_code: '8901234567902', price: 320, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 9, cgst_rate: 9, stock_quantity: 30 },
      { name: 'Pasta (500g)', hsn_code: '8901234567903', price: 95, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 6, cgst_rate: 6, stock_quantity: 25 },
      { name: 'Tomato Ketchup (1kg)', hsn_code: '8901234567904', price: 160, metric: 'packet', is_loose: 0, gst_applicable: 1, sgst_rate: 6, cgst_rate: 6, stock_quantity: 15 }
    ];

    const insertItem = db.prepare(`
      INSERT OR IGNORE INTO items (name, hsn_code, price, metric, is_loose, gst_applicable, gst_mode, gst_rate, sgst_rate, cgst_rate, igst_rate, stock_quantity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    items.forEach(item => {
      insertItem.run(
        item.name,
        item.hsn_code,
        item.price,
        item.metric,
        item.is_loose,
        item.gst_applicable,
        'split',
        Number(item.sgst_rate) + Number(item.cgst_rate),
        item.sgst_rate,
        item.cgst_rate,
        0,
        item.stock_quantity
      );
    });

    // Seed customers
    const customers = [
      { name: 'John Doe', phone: '9876543210', shop_name: 'Doe Corner', address: '123 Main St', gstin: '27AAAAA0000A1Z5', credit_balance: 500 },
      { name: 'Jane Smith', phone: '8765432109', shop_name: 'Smith Bakery', address: '456 Oak Ave', gstin: '27BBBBB1111B2Z6', credit_balance: 0 },
      { name: 'Local Cafe', phone: '7654321098', shop_name: 'The Daily Grind', address: '789 Pine Rd', gstin: '27CCCCC2222C3Z7', credit_balance: 1200 }
    ];

    const insertCustomer = db.prepare(`
      INSERT OR IGNORE INTO customers (name, phone, shop_name, address, gstin, credit_balance)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    customers.forEach(customer => {
      insertCustomer.run(customer.name, customer.phone, customer.shop_name, customer.address, customer.gstin, customer.credit_balance);
    });
  }

  // Seed admin user if not exists
  db.prepare(`
    INSERT OR IGNORE INTO settings (
      id,
      shop_name,
      shop_address,
      shop_phone,
      shop_gstin,
      bill_format,
      bill_header,
      bill_footer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    1,
    'Vyapar POS System',
    '123 Bakery Lane, Food City',
    '+91 98765 43210',
    '27AAAAA0000A1Z5',
    'thermal',
    'THANK YOU FOR VISITING!',
    'Visit again soon'
  );
}

export default db;
