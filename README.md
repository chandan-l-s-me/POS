# Vyapara Billing

Point-of-sale billing, inventory and GST records for a single retail shop.
React + Vite on the front, Express + SQLite on the back, served as one process.

---

## Running it

```bash
npm install
cp .env.example .env        # then edit it — see "Configuration" below
npm run build               # builds the front-end into dist/
npm start                   # serves dist/ + the API on http://127.0.0.1:3000
```

For development, `npm run dev` runs the same server with Vite in middleware
mode and hot reloading, and does not need a build first.

On the **first** start against an empty database the server creates one `admin`
account and prints its password to the console, once. Save it, sign in, and
change it under Settings. If you would rather set it yourself, put it in
`ADMIN_INITIAL_PASSWORD` before that first start.

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with hot reload |
| `npm run build` | Build the front-end bundle into `dist/` |
| `npm start` | Production server (requires a build) |
| `npm test` | Build, then run the full end-to-end suite |
| `npm run test:only` | Run the tests without rebuilding |
| `npm run lint` | TypeScript type check |
| `npm run seed:demo` | Load sample data (never on a real shop's database) |

---

## Configuration

Everything is set through `.env`; `.env.example` documents each variable. The
four that matter for a real deployment:

- **`JWT_SECRET`** — signing key for session tokens. The server refuses to
  start without it when `NODE_ENV=production`. Generate with
  `openssl rand -hex 32`. If it changes, everyone is signed out.
- **`NODE_ENV=production`** — enforces the secret, enables HSTS, tightens the
  Content-Security-Policy and serves the built bundle.
- **`DB_PATH`** — where the SQLite file lives. Put it somewhere your backups
  cover, not inside the application directory.
- **`HOST`** — defaults to `127.0.0.1`, which is the safe choice. See below.

### Exposing it to other tills

The app speaks **plain HTTP**. On `HOST=0.0.0.0` without TLS, anyone on the
shop's network can read passwords and session tokens off the wire. If more than
one machine needs it, put it behind a reverse proxy that terminates HTTPS and
leave the app itself on loopback.

---

## Full screen / kiosk

There is a full-screen button in the top bar (and on the sign-in screen, since
that is where a till usually sits between shifts). **Ctrl/Cmd+Shift+F** toggles
it, **Esc** leaves. If the page reloads while in full screen, the app goes
back into it on the cashier's next click or keypress — browsers only grant full
screen from a user gesture, so it cannot happen on load by itself. Leaving with
Esc is remembered as a choice and is not undone. The button hides itself where
the browser has no usable Fullscreen API, such as Safari on iPhone.

**Printing.** Chrome leaves full screen whenever it opens its print dialog, and
a web page cannot prevent that. The app notices when a print it started caused
the exit and puts full screen back afterwards: immediately if the print was
quick enough that the browser still counts the click that started it, otherwise
on the cashier's next tap or keypress — which does whatever it was meant to do
as well. Anything that prints must use `usePrint` (`src/hooks/usePrint.ts`)
rather than `useReactToPrint` directly, or it loses this.

For a machine that *only* runs the till, browser kiosk mode is better than the
in-page button: no chrome at all, no way to exit to other tabs, it survives a
restart — and with `--kiosk-printing` there is **no print dialog at all**: each
bill goes straight to the default printer, so full screen is never lost and the
cashier saves a click on every sale.

```bash
# Chrome / Chromium / Edge — no browser UI, bills print without a dialog
chrome --kiosk --kiosk-printing --app=http://127.0.0.1:3000

# ...or a normal window pinned to this one app
chrome --app=http://127.0.0.1:3000
```

For `--kiosk-printing`, make the receipt printer the machine's **default
printer** and set its paper size (80 mm roll, or A4 for the standard invoice)
in the printer's own settings, since there is no dialog to choose them in. Put
the command in the machine's startup items and the shop opens to the till.

---

## Data and backups

The database is a single SQLite file (WAL mode, so `-wal` and `-shm` files sit
beside it — they are part of the database, copy them together or use the backup
button). It holds customer names, phone numbers, addresses, GSTINs, outstanding
balances and hashed passwords.

Settings → **Local Disk Backup** writes a consistent snapshot into `backups/`
using `VACUUM INTO`. The result is a real `.db` file: to restore, stop the
server and put it at `DB_PATH`. Backups are written `0600`, and `backups/` is
git-ignored, as are `*.db` and `.env`. Keep it that way.

Schema changes apply automatically on start, in place, and are idempotent —
starting a newer build against an existing database is the whole upgrade. Take
a backup first anyway.

---

## How customers are named

This shop knows its customers by bakery or shop — "Sri Ganesh Bakery" — not
by the name of whoever comes to the counter. So a customer's **bakery / shop
name is their identity** everywhere: the billing picker, the customer list,
bill history, reports and the printed invoice ("Bill To", with the person on
an *Attn:* line). The person's name is shown beneath it as the contact. A
customer with no bakery or shop is shown by their own name.

A customer needs one or the other (plus a phone number); either alone is
enough. Lists sort by the display name. The rule lives in one place per side —
`customerDisplayName()` in `src/lib/customer.ts` for every screen, and
`CUSTOMER_DISPLAY_SQL` in `server.ts` for sorting — and the two must agree.

---

## Customer passbook

**Customers → Passbook** (or click the bakery name) opens `/customers/:id`:
every transaction with that customer in one timeline, like a bank passbook.
Every bill however it was paid — cash, UPI, credit or split — plus every
repayment, correction and opening balance. Each line shows what was **billed**,
what was **received**, and the **balance due** after it. Click a bill to see
its items. Payments are recorded from the same page.

A bill is one line, however it was settled: billed = its total, received =
the cash and UPI taken at the counter, and the difference is what went onto the
customer's account. Its credit-ledger `sale` entry is *not* shown separately —
it is the same money, and showing both would count it twice. So the balance
after the last line always equals `credit_balance`; `tests/passbook.test.ts`
holds it there.

Choose a period (last 30 days, 3 months, this year, all time, or custom). The
running balance is worked out over the whole history first, so a period that
starts part-way through opens with the balance actually owed on that day —
shown as *Balance brought forward* — and opening + billed − received = closing.

## Customer credit

`customers.credit_balance` is what a customer currently owes.
`customer_credit_entries` is the record of how it got there — one row per
change, with the timestamp, the signed amount, the balance before and after,
who did it, and why. The passbook above is built on it.

Four kinds of entry:

| Type | Raised by |
| --- | --- |
| `opening` | An opening balance set when the customer was created (admin only) |
| `sale` | The credit portion of a bill — linked to the bill number |
| `payment` | A repayment received, via **Record Payment** on the passbook |
| `adjustment` | An admin editing the balance directly, with an optional reason |

Every path that moves a balance goes through `recordCreditChange` in
`server.ts`, which updates the balance and writes the entry in one
transaction. **Do not change `credit_balance` with a bare UPDATE** — that is
exactly the drift this table exists to prevent, and
`tests/credit-ledger.test.ts` asserts the last entry's `balance_after` always
equals the stored balance.

The ledger is *not* part of `audit_logs` and is never pruned: it is a record of
money owed, not an activity trail.

### What the upgrade can and cannot reconstruct

On first start, existing databases get a ledger built from history. Credit
sales come back exactly — `bills` has the customer, amount, cashier and date.
Repayments and manual balance edits made before the upgrade were never
itemised anywhere, so they cannot be recovered; each customer's statement
closes with one `adjustment` entry covering whatever the sales do not explain,
labelled as such. Running balances on rows above that entry are cumulative
credit billed, not the balance as it stood on the day.

---

## How the money is calculated

Worth understanding before changing anything in this area, because two separate
pieces of code have to agree.

Item prices are **GST-inclusive**. For each line the server computes, in this
order:

```
line total   = round2(unit price x quantity)
sgst/cgst/igst = round2(unit tax x quantity)
line taxable = round2(line total - sgst - cgst - igst)     <- by subtraction
```

Deriving the taxable value by subtraction, rather than multiplying a rounded
unit base by the quantity, is what makes `taxable + tax === total` exactly true
for every line, so the invoice reconciles. The bill's payable is then
`floor(subtotal + tax - discount)` — the shop settles in whole rupees and the
dropped paise become the invoice's **Round Off** line.

The server recomputes all of this from the `items` table and ignores any
prices, tax amounts or totals in the request, so a tampered request cannot
under-record a sale. `src/store/useCartStore.ts` mirrors the same arithmetic so
the figure on the till matches the figure in the ledger; `tests/cart-parity.test.ts`
checks that across ~560 price/rate/quantity combinations. **If you change one,
change the other**, and run that test.

---

## Tests

```bash
npm test
```

236 tests. The server-facing files mock nothing: each boots the real
`server.ts` as a child process against a throwaway database and drives it over
HTTP. `fullscreen.test.ts` is the one exception — it drives the Fullscreen API
shim against fake documents, because the real thing needs a real browser and a
real user gesture.

| File | Covers |
| --- | --- |
| `auth.test.ts` | Login, throttling, token forgery, role gates, account management |
| `billing.test.ts` | Bill arithmetic, GST, rounding, stock, payment reconciliation, concurrency |
| `cart-parity.test.ts` | The till's displayed total vs. the recorded total |
| `catalogue.test.ts` | Items, customers, suppliers, settings |
| `customer-identity.test.ts` | Bakery-first naming: the shared rule, validation, sorting and search |
| `passbook.test.ts` | Every bill once, no double-counted credit, running balance, mid-history periods |
| `credit-ledger.test.ts` | Credit entries, repayments, and that the ledger never drifts from the balance |
| `fullscreen.test.ts` | Fullscreen shim: vendor prefixes, refusals, storage failures, restoring after printing |
| `purchases-reports.test.ts` | Purchases, reports, analytics, audit log, backups |
| `migration.test.ts` | Upgrading an existing database in place, including the ledger backfill |

They run sequentially (`--test-concurrency=1`); each spawns a server, so a
parallel run just fights itself for CPU.

---

## Layout

```
server.ts              API, auth, validation, all money calculations
db/index.ts            Schema, migrations, indexes
db/asyncRead.ts        Worker pool for heavy reads
db/read-worker.mjs     Read-only SQLite connection (keeps billing responsive)
src/pages/             One file per screen
src/store/             Zustand stores (cart, auth, catalogue cache, theme)
src/lib/fullscreen.ts  Fullscreen API shim (prefixes, preference storage)
src/components/Receipt.tsx   Thermal (80mm) and A4 tax invoice layouts
tests/                 End-to-end suite
```

Heavy reads — reports, the dashboard — run on worker threads. `better-sqlite3`
is synchronous, so running them on the main thread blocks every other request:
a dashboard load used to stall billing for several seconds. Keep analytical
queries on `readPool`.
