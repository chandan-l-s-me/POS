# Vasavi Billing

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
| `npm run package` | Build the installable package for a shop (see below) |

### Giving it to a shop

A shop never runs a command. `npm run package` builds
`release/VasaviBilling-<version>.zip`, which contains everything the shop's
computer needs: the built app, the server bundled into one file, the Node.js
runtime, and WinSW (MIT) to run it as a Windows service. Nothing has to be
installed first.

On the shop's computer, unzip it and double-click **Install Vasavi.bat**
(one administrator prompt). It asks for the shop name, an admin password and an
optional second backup folder, then:

- copies the program to `C:\Program Files\VyaparaBilling`;
- creates the data folder `C:\VyaparaData` (database, backups, logs), readable
  only by administrators and the service;
- writes a fresh `.env` with a new `JWT_SECRET` and nothing of yours (no Google
  or Cloudflare settings);
- registers the **Vasavi Billing** service: starts with Windows, restarts
  itself if it stops, runs without anyone signed in;
- creates the admin, removes the one-time password from `.env`, sets the shop
  name, and adds a desktop / Start-menu icon that opens the app.

A new version: build a new package and run **Update Vasavi.bat** from the new
folder. It backs up the database (checked copy), swaps the program, and puts
the previous version back if the new one does not start. **Uninstall
Vasavi.bat** (or Settings > Apps) removes the program and keeps the data;
installing again picks the data up. Every question can also be given as a
parameter for unattended installs — see the top of `installer/scripts/install.ps1`.
Records of each run go to `%TEMP%\VasaviBilling-install.log` (and `-update`,
`-uninstall`). `installer/README.txt` is the shop-facing version of this.

The Cloudflare tunnel is not part of the installer: it needs the shop's own
Cloudflare account and token (see *Remote access* below).

**Give the shop the zip, not this repository.** `installer/` in the source tree
holds only the scripts; the app, Node and the service wrapper exist only in
the built package, which is not committed (`release/` is git-ignored). Run from
a clone, `Install Vasavi.bat` stops and says where to get the package. Publish
each build as a GitHub Release: Releases > *Draft a new release*, tag it with
the version (e.g. `v1.0.0`), and attach `release/VasaviBilling-<version>.zip`.

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

### Kannada

Every screen can be shown in Kannada: the **EN | ಕನ್ನಡ** switch in the top bar,
on the sign-in screen and in Quick Bill's ⚙ settings. Each computer or phone
keeps its own choice. Printed and shared bills, CSV exports and the activity
log's details stay in English. The screen text lives in `src/i18n/kn.ts`,
looked up by the English; `tests/i18n.test.ts` fails if any is missing.

Items are still typed and searched in English. Their Kannada names come from
Google Translate, filled in by the server in the background a few seconds
after an item is added or renamed. An admin can correct one under Items →
Edit, and Settings → Language shows how many are still waiting. Without
internet the names stay English until the next attempt.

Customers' names (the bakery's and the person's) are written in Kannada
letters the same way, with Google Input Tools: spelt, not translated, so
"Sri Ganesh Bakery" shows as ಶ್ರೀ ಗಣೇಶ್ ಬೇಕರಿ, with the English underneath.
A renamed customer gets a new spelling. Search finds them by either.

Only names are sent to Google: never phone numbers, addresses, GSTINs,
prices or bills.

- **`GOOGLE_TRANSLATE_API_KEY`** — optional. Uses Google's paid Cloud
  Translation API. Without it, the free endpoint behind Google's web widgets
  is used: no key or cost, but not an official service, so Google may slow it
  down or change it.
- **`TRANSLATE_ITEM_NAMES=off`** — never contact Google; items then show in
  English on Kannada screens unless a Kannada name is typed in.
- **`TRANSLATE_CUSTOMER_NAMES=off`** — keep customers' names on this
  computer; they then show in English, while items are still translated.

Every search box forgives a slip of the finger. What was typed is looked for
inside the names first, as before; only when nothing contains it are the
closest names shown instead, allowing one wrong, missing, extra or swapped
letter per word (two in a word of seven letters or more): "suger" finds Sugar,
"ganseh" finds Sri Ganesh Bakery. The Items and Customers pages say when they
are showing the closest names. Codes (HSN, barcode, phone, GSTIN) match only
as typed. The rules are in `src/lib/fuzzy.ts`, shared by the screens and the
server.

### Exposing it to other tills

The app speaks **plain HTTP**. On `HOST=0.0.0.0` without TLS, anyone on the
shop's network can read passwords and session tokens off the wire. If more than
one machine needs it, put it behind a reverse proxy that terminates HTTPS and
leave the app itself on loopback.

### Remote access through a Cloudflare Tunnel

The intended way to reach the app from outside the shop. `cloudflared` runs on
the same machine and connects to `http://127.0.0.1:3000`, so the app stays on
loopback and Cloudflare provides HTTPS. No router ports are opened.

1. `NODE_ENV=production` in `.env`, then `npm run build` and `npm start`. In
   development mode the app refuses tunnel traffic (503) so the Vite dev server
   is never exposed.
2. Change every password first. Accounts still on a demo password from
   `scripts/seed-demo.ts` are refused from the internet and can only sign in at
   the counter; demo passwords cannot be set again.
3. Install `cloudflared` as a service and route a hostname to
   `http://localhost:3000`.
4. Put **Cloudflare Access** (Zero Trust, free up to 50 users) in front of that
   hostname, allowing only the owner's and staff's email addresses. Visitors
   then prove their email before they ever see the sign-in page.

How the app treats tunnel traffic: a request from loopback carrying
`CF-Connecting-IP` is a tunnel visitor, identified by that address (the header
is trusted only from loopback). Sign-in is throttled per visitor (5 failures →
15 minutes), and remote failures on one account are also counted together
(20 → remote sign-in to that account blocked for 15 minutes). Sign-in at the
counter is never blocked by remote failures, so nobody can lock the shop out of
its own till.

**Admin accounts work only at the counter.** From the tunnel (the website or
the phone app) only cashier accounts can sign in. An admin signing in from
there gets "Admin accounts can be used only on the shop computer", and an admin
session taken off the counter stops working at once. Anything that is not
loopback counts as outside, so a till on the shop network (`HOST=0.0.0.0`) is
also cashier-only. Set `ALLOW_REMOTE_ADMIN=on` in `.env` and restart to lift
this, for example for remote support.

**One admin from the internet.** The owner can have an admin account that
works from anywhere, set in `.env`:

```
REMOTE_ADMIN_USERNAME="owner"
REMOTE_ADMIN_PASSWORD="<at least 12 characters, long and random>"
```

It is created when the app starts. Every other admin stays at the counter. The
account is managed only in `.env`: change the password there and restart to
replace it (its open sessions are signed out); remove both lines and restart to
turn it off. The app cannot reset, deactivate or delete it; Settings → Staff
shows it with an *Internet access* tag. It is refused, and the console says
why, if the password is under 12 characters or a published demo password, or
if the username already belongs to another account. Its sign-ins are throttled
like any other and logged with the visitor's address. On an installed shop the
file is `C:\Program Files\VyaparaBilling\app\.env`; restart the *Vasavi Billing*
service after editing it.

### Phone app (Android): Quick Bill

Cashiers can bill on a phone with the **Vasavi Billing** Android app. The app
is a native shell (Capacitor, in `android/`) that opens the Quick Bill screen
(`/m`) from the shop server, so it always runs the same billing code as the
counter — a change to the screen needs only the server updated, not a new APK.
Quick Bill also works in Chrome on any phone at `https://<your-host>/m`, minus
Bluetooth printing.

- **Printing.** Each phone chooses in ⚙: *Counter printer* (the bill is queued
  and the counter computer prints it — turn on **Settings → Print Bills From
  Phones** there, and start its Chrome with `--kiosk-printing` so no dialog
  appears), *My Bluetooth printer* (any ESC/POS thermal printer paired in
  Android's Bluetooth settings, 58 or 80 mm), or *Don't print*.
- **Build the APK:** `npm run android:build` (needs the Android SDK and JDK 21;
  see `capacitor.config.ts` for the server address). Output:
  `android/build.nosync/app/outputs/apk/release/app-release.apk`.
- **Signing key:** `android/vyapara-release.keystore` and
  `android/keystore.properties` (both git-ignored). Every update must be signed
  with this key or phones refuse to install it — **back both up**.
- **Install on a phone:** copy the APK over (WhatsApp/USB), open it, allow
  "Install unknown apps" for that one source, install. First open shows the
  Cloudflare Access email check, then the sign-in page.
- **Stays signed in.** A cashier who signs in on the app stays signed in when
  it is closed and reopened (a 90-day session, `STAY_SIGNED_IN_EXPIRY`). Each
  time the app opens or comes back to the front it asks `POST /api/auth/session`:
  a deactivated cashier, or one whose password was reset, is signed out there
  and then; otherwise the 90 days start again. Admins, and cashiers in a
  browser, keep the 12-hour sign-in.
- **Icon:** the website's logo, the white V on indigo
  (`drawable/ic_launcher_logo.xml` for the adaptive icon and splash screen; the
  `mipmap-*/ic_launcher*.png` files for Android 7).

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

The app backs itself up automatically once a day while it runs (and shortly
after starting, if the last one is older than that), keeping automatic backups
for 30 days; set `BACKUP_COPY_DIR` to have each one copied to a USB drive or a
cloud-synced folder as well. See the backup settings in `.env.example`.
Settings → **Local Disk Backup** shows when the last one ran, and **Backup
Now** writes one on demand. Both write a consistent snapshot into `backups/`
(or `BACKUP_DIR`) using `VACUUM INTO`. The result is a real `.db` file: to restore, stop the
server and put it at `DB_PATH`. Backups are written `0600`, and `backups/` is
git-ignored, as are `*.db` and `.env`. Keep it that way.

Schema changes apply automatically on start, in place, and are idempotent —
starting a newer build against an existing database is the whole upgrade. Take
a backup first anyway.

### Starting fresh after a trial

A shop can practise with made-up bills for its first days, then erase them and
start for real. There is deliberately no button for this: it is done from
`.env`, by someone at the shop computer. Add:

```
START_FRESH="transactions"
START_FRESH_CONFIRM="ERASE-TRIAL-1"
```

and restart the app (on an installed shop, the *Vasavi Billing* service). On
that start, before anything is served, it saves a full backup to the backups
folder and then erases bills, purchases, supplier payments, customer credit,
stock and the activity log. Items (stock 0, selling price kept), customers and
suppliers stay, so the catalogue entered during the trial is not lost; count
the real stock and add it under Items → *Stock & prices* → Add stock, or enter
the purchases. `START_FRESH="everything"` also erases items, customers and
suppliers. Staff logins and shop settings are always kept, and bill numbers
start again at 0001. The console and the activity log say what was erased.

It runs once per `START_FRESH_CONFIRM` word (kept in the `fresh_starts` table),
so the lines can stay in `.env` afterwards without erasing anything again. To
undo it, stop the app and put the backup it made back at `DB_PATH`.

### Google Drive backup

Once connected, every backup — the daily automatic one and **Backup Now** — is
also gzipped and uploaded to a **Vasavi Billing Backups** folder in the
owner's Google Drive, and automatic ones older than `BACKUP_KEEP_DAYS` are
removed there too. The app asks only for Google's `drive.file` permission: it
can see and change the files it uploads, nothing else in the Drive. The
connection (a refresh token) is kept in `google-drive.json` beside the
database, not in it, so backups never contain it.

**One-time setup** (about 10 minutes, with the Google account that should hold
the backups):

1. <https://console.cloud.google.com> → create a project (e.g. "Vasavi Billing").
2. *APIs & Services → Library* → enable **Google Drive API**.
3. *APIs & Services → OAuth consent screen* (Google Auth Platform): user type
   **External**, app name "Vasavi Billing", your email as support and
   developer contact. Under *Data access* add the scopes `…/auth/drive.file`,
   `openid` and `email`. Then under *Audience* press **Publish app** ("In
   production") — while it stays in "Testing", Google expires the connection
   every 7 days. These scopes need no Google review; on connecting you may see
   "Google hasn't verified this app": choose *Advanced → Go to Vasavi Billing*.
4. *Clients* (Credentials) → **Create client** → type **Web application** →
   authorised redirect URI: `https://pos.chandanls.in/api/backups/google/callback`
   (your `PUBLIC_URL` + `/api/backups/google/callback`).
5. Put the client ID and secret in the shop laptop's `.env` with
   `PUBLIC_URL=https://pos.chandanls.in`, restart the app.
6. Settings → **Google Drive Backup** → **Connect Google Drive**, sign in and
   allow. Then press **Backup Now** once to check the first upload.

**Restoring from Drive:** download the `.db.gz` file, unzip it (double-click on
a Mac; 7-Zip on Windows) to get the `.db` file, stop the app, put it at
`DB_PATH` (moving the old `pos.db`, `pos.db-wal` and `pos.db-shm` aside), and
start the app.

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

## Stock, purchases and FIFO pricing

**Items exist only because they were bought**, or because they were already
on the shelves when the shop started using the app (see *Importing the shop's
items* below). There is no other "add item", and no API to create one on its
own. On the Purchases screen, typing a
name that isn't in the catalogue makes that row a *new item*: its HSN code and
unit (a dropdown) are filled in right in the row. The item is created only
when the purchase is saved, in the same transaction, and it takes its sale GST
from the line it was bought on. An abandoned purchase leaves nothing behind.
Duplicate names are refused. The unit list is `src/lib/units.ts`.

Each purchase line records the
cost (before GST), the GST it was bought at, and a **selling price**
(GST-inclusive) that the owner types in. The cost can be typed **before or
after GST**: the other box is worked out from the GST dropdown, and changing
the GST moves the box that wasn't typed. A cost worked back from an after-GST
figure is sent with six decimals (₹100 incl. 18% is ₹84.745763), so the line
totals exactly what was typed. Picking an existing item starts from
the selling price set on its last purchase. A price that doesn't cover the cost
is flagged "Below cost" but allowed. The GST type and slab are one dropdown
(*No GST*, *GST 5–28%* for CGST + SGST, *IGST 5–28%*).

The **profit %** each line makes is worked out and stored on save
(`purchase_items.profit_percent`, next to `selling_price`). It is never shown
on screen. It appears only in the purchase report download (Reports →
Purchase items CSV). Profit is on the cost *before* GST, because the shop
claims purchase GST back: ₹70.80 incl. 18% is ₹60.00, which is 20% on a ₹50.00
cost. Purchases made before this existed get both filled in on upgrade, from
their stock batch.

**Stock is held in batches** (`stock_batches`): one per purchase line, each
with its own quantity left, cost and selling price. **Billing takes from the
oldest batch first, at that batch's price.** If yeast was bought last week at
₹85 and this week at ₹90, last week's stock is sold first at last week's price.
This week's price applies only once that stock runs out. A sale that runs past
the old stock becomes two lines on the bill, e.g. 3 @ ₹107.10 + 2 @ ₹113.40.

**The unit price cannot be changed at billing**, by a cashier or an admin. The
till shows it read-only. It is the selling price set on the purchase, and the
way to change it is to reprice the batch in Items → *Stock & prices*. The
server refuses a bill that asks for any other price (400, naming the price the
stock sells at), so this holds even for requests that bypass the screen.
`bill_items.price_overridden` is kept for lines written before this, and is 0
on every new line.

**Bulk prices** give a lower price for buying in quantity, e.g. 10 or more at
₹110 each and 25 or more at ₹105 each. An admin sets them per item under Items →
*Stock & prices* → *Bulk prices*, as a quantity and a price including GST. When
the bill has at least that quantity of the item (counted over the whole bill,
even across two lines), every unit is charged the bulk price. With several bulk
prices, the largest quantity reached wins. A batch that already sells for less
keeps its own price, so buying more never costs more per unit. The till shows
"Bulk price · 10+" on the line, or "10+ at ₹110.00" while the quantity is still
short of it. The server works out the same price (`applyBulkPrice` in
`src/lib/billMath.ts`, shared with the till), so `expected_total` still matches.
A bigger quantity cannot have a higher bulk price, and each quantity must be
more than 1. Cashiers can see bulk prices but not change them. Every change is
in the activity log. Rules are in `item_bulk_prices`.

**Stock only moves three ways:** purchases add a batch; sales draw down batches
oldest first (`bill_item_batches` records which); and **stock adjustments** add
or remove stock with a reason (Items → *Stock & prices*). The item form can no
longer set a price or a stock figure. `items.stock_quantity` and `items.price`
are a cache — total left, and the price of the batch that sells next. They are
written only by `syncItemStock()` in `db/index.ts`, after every batch change, so
they cannot drift. `tests/fifo.test.ts` checks that against the batches after
every kind of change.

**Prices can change while a bill is open.** Another sale can use up the batch a
cart line was priced from. The till therefore sends the total it showed
(`expected_total`). If the server now works out a different total, it refuses
with `409 PRICE_CHANGED`, and the till re-prices the bill and shows a notice.
The customer is never charged an amount that wasn't on screen.

**On upgrade**, existing stock is rebuilt into batches from purchase history.
Each item's current stock is assigned to its newest purchases first, which is
what FIFO would have left on the shelf. Anything the purchases don't explain
becomes one 'opening' batch with an unknown cost. Every rebuilt batch keeps the
item's current selling price, so nothing changes at the counter.

**Purchases without a supplier.** The supplier is optional (for stock bought
for cash at a market, say). Such a purchase must be paid in full: with no
supplier there is no one to owe, so *On credit* and *Part paid* are off. Its
payment is a `supplier_payments` row with no supplier, so it counts in the
payment-method totals and appears in Payments Done. It cannot be removed, as
that would leave the purchase owing no one. It shows as "No supplier".

### Importing the shop's items

A shop that is already trading starts with Items → **Import items**
(`/items/import`, admin only). Its steps are:

1. Download the Excel template. Its headings are in English and Kannada,
   Unit and GST % are dropdowns, the HSN column is text (so 0402 keeps its
   zero), and a second sheet explains each column.
2. Fill it in, then upload it. A CSV file, or cells copied from Excel or
   Google Sheets and pasted onto the page, works too. Rows can also be
   typed into the table.
3. Every row is checked as it changes. A problem is shown under its row and
   blocks the import. Selling below cost is only a warning.

Saving is all or nothing. Each row becomes an item plus one `'opening'`
batch holding its quantity, cost (optional) and selling price. It is not a
purchase, so purchase reports and GST input tax are untouched. A quantity of 0
lists the item with its price and no stock.

- **Headings:** any order works, and common alternatives (Qty, MRP, UOM,
  HSN/SAC…) are recognised. Without headings, the template's column order is
  assumed.
- **Values that are read:** units like Pcs, Kgs and pkt; prices like ₹1,250;
  GST typed as `18%` or stored as `0.18`. HSN codes Excel cut short (402) are
  restored (0402).
- **Names:** a name already in the app, or entered twice, is refused.
- **Kannada names:** a Kannada name in the sheet is kept; otherwise it is
  translated automatically.

The draft stays in the browser until it is imported or cleared. The rules are
in `src/lib/itemImport.ts`, shared by the page and `POST /api/items/import`.
The .xlsx reading and writing (no library) is in `src/lib/spreadsheet.ts`.
The template's last column is an optional barcode, kept as text so Excel does
not show it as 8.90123E+12.

### Barcodes

An item can have one barcode: the code on the pack (EAN-13 on most Indian
goods) or one the shop prints. It is optional; loose goods have none. Any USB
or Bluetooth scanner that types like a keyboard works, with no setup.

- **Purchases:** each row has a Barcode column.
  - Scanning a code an item already has fills the row with that item. If the
    item is already on another row, the cursor goes to that row's quantity.
  - A code no item has stays on the row and is saved with it. That works for
    a new item, or an existing item that has no barcode yet.
  - An item that already has a barcode shows it read-only. It is changed in
    Items.
- **Items:**
  - Each card shows its barcode. **Add barcode** / **Change** sets it there:
    click, scan, done.
  - The Edit form has a Barcode field.
  - Filter buttons show All items, With barcode, Without barcode, Low stock
    and Out of stock, each with its count. To label a shop's existing stock,
    choose **Without barcode** and work down the list.
- **Billing:** a scan adds the item to the bill.
  - A code no item has shows a message, instead of doing nothing.
  - The search box and Quick Bill's search also find items by barcode.

Scans are read by `src/hooks/useBarcodeScanner.ts`, which Billing, Purchases
and Items mount, so a scan on any other page does nothing.

- A scanner types far faster than a person, so a burst of keys ending in
  Enter is read as a code.
- If the cursor was in some other box, like a quantity, the code is taken
  back out of that box. Only bursts of 8 or more characters count there, so
  fast typing is never mistaken for a scan.

Codes are stored without spaces and in upper case, so a scanner with Caps
Lock on still matches. A code belongs to one item; a unique index enforces
it. The rules are in `src/lib/barcode.ts`, shared by the screens and the
server.

On upgrade:

- The old `items.barcode` column, which held HSN codes, is cleaned once.
  `PRAGMA user_version` 0 → 1 marks it done.
- Anything that was really an HSN code moves to `hsn_code` and is removed
  from `barcode`.

---

## How the money is calculated

Worth understanding before changing anything in this area.

Item prices are **GST-inclusive**. For each bill line (one per price segment,
see above) the computation is, in this order:

```
unit taxable = unit price x 100 / (100 + total GST rate)
unit tax     = unit taxable x rate / 100                   <- each of sgst/cgst/igst
line total   = round2(unit price x quantity)
sgst/cgst/igst = round2(unit tax x quantity)
line taxable = round2(line total - sgst - cgst - igst)     <- by subtraction
```

Each rate applies to the taxable value, never to the inclusive price: ₹105 at
5% is ₹100 + ₹2.50 CGST + ₹2.50 SGST. Bills saved before 13 Oct 2026 took the
rate of the inclusive price, which overstated the tax (₹2.63 each side on ₹105)
and printed slabs like 2.63% on the invoice. Each bill line also stores the
rates it was charged at (`bill_items.sgst_rate` etc.), and the invoice prints
those.

Deriving the taxable value by subtraction, rather than multiplying a rounded
unit base by the quantity, is what makes `taxable + tax === total` exactly true
for every line, so the invoice reconciles. The bill's payable is then
`floor(subtotal + tax - discount)` — the shop settles in whole rupees and the
dropped paise become the invoice's **Round Off** line.

**Every till keeps up live.** Billing and Quick Bill search, price and show
stock from a copy of the catalogue on the device. Every 4 seconds while the
app is on screen, the device asks the server what changed since it last asked
(`GET /api/items/changes?since=N`) and merges just those items. An item
bought, repriced, edited or sold on another computer shows within seconds,
without a reload, and open bills holding it are re-priced. Each check is a few
bytes when nothing changed, which suits phones on mobile data. Database
triggers number every change to an item (`items.change_seq`, see
`trackItemChanges` in `db/index.ts`), so no write path can be missed.

**Editing a bill** (History → bill → *Edit Bill*, admins only) opens it in its
own Billing tab with its items, customer, discount and payment. Saving that tab
(`PUT /api/bills/:id`) replaces the bill in one transaction: it keeps its number
and date, its stock goes back to the batches it came from and the new lines are
rung up from them (oldest first, at today's prices), and the customer's credit
moves to match. The credit sale's own ledger entry changes amount, keeping its
date, so the passbook and ageing stay right; it is refused if the customer has
already paid more than the new amount. While editing, the till counts the
bill's own units as in stock (`?excluding_bill=`). The bill shows who edited it
and when, and the activity log keeps what it was before.

**Invoice numbers** run 0001, 0002, 0003 … one count that never resets
(10000 follows 9999). Bills from before this change keep their old
`INV-DDMMYYYY-NNNNN` numbers. A deleted bill leaves its number unused.
Purchases keep `PUR-DDMMYYYY-NNNNN`.

**Discount.** Billing and Quick Bill take one rupee amount off the whole bill
(`discount_amount`). It comes off after GST: GST is charged on the full
prices, and the customer pays `floor(subtotal + GST − discount)`. The till
shows how it gets there, under the grand total: Subtotal + GST, − Discount, and
the Round off. A discount bigger than the bill is flagged and refused. Every
printed and shared bill shows Discount and Round Off lines, and each item's own
GST rate and amount (a GST column on the A5 invoice, a line under each item on
the receipts).

**Include in my GST.** Each item has an *Include in my GST* tick (Items → edit,
and a Yes/No column in the import, empty meaning Yes). It is a **report view
only**: the sales report can show all items, only the ticked ones, or only the
rest, and its totals and CSV follow the choice. In those views the totals are
of the item lines, before any bill discount or round off, since those belong
to the whole bill. Bills charge and print GST on every item either way, and
nothing else in the app looks at the tick. It is `items.in_my_gst` (1 unless
unticked), and the report reads the item's current setting.

The server recomputes all of this from the batches. It ignores any amounts,
taxes or totals in the request, and refuses a per-line `unit_price` that is not
exactly the price the stock sells at. The arithmetic and the FIFO allocation live in
**one place**, `src/lib/billMath.ts`. The server and the till's cart store both
import it, so they cannot drift apart. `tests/cart-parity.test.ts` still checks
the end result across ~560 price/rate/quantity combinations, a line split
across batches, and a typed price.

---

## Tests

```bash
npm test
```

279 tests. The server-facing files mock nothing: each boots the real
`server.ts` as a child process against a throwaway database and drives it over
HTTP. `fullscreen.test.ts` is the one exception — it drives the Fullscreen API
shim against fake documents, because the real thing needs a real browser and a
real user gesture.

| File | Covers |
| --- | --- |
| `auth.test.ts` | Login, throttling, token forgery, role gates, account management |
| `billing.test.ts` | Bill arithmetic, GST, rounding, stock, payment reconciliation, concurrency |
| `fifo.test.ts` | Batches, oldest-first selling, split lines, prices not changeable at billing, adjustments, stock always adding up |
| `cart-parity.test.ts` | The till's displayed total vs. the recorded total |
| `my-gst-discount.test.ts` | Include in my GST (form, import, report), discount and round off, GST on every receipt line |
| `live-catalogue.test.ts` | Every till sees items bought, repriced, sold or edited elsewhere |
| `bill-edit.test.ts` | Editing a saved bill: items, payment, stock, credit, refusals |
| `bulk-prices.test.ts` | Bulk prices: the rules, setting them, who may, billing at them, till/server agreement |
| `catalogue.test.ts` | Items, customers, suppliers, settings |
| `customer-identity.test.ts` | Bakery-first naming: the shared rule, validation, sorting and search |
| `passbook.test.ts` | Every bill once, no double-counted credit, running balance, mid-history periods |
| `credit-ledger.test.ts` | Credit entries, repayments, and that the ledger never drifts from the balance |
| `fullscreen.test.ts` | Fullscreen shim: vendor prefixes, refusals, storage failures, restoring after printing |
| `purchases-reports.test.ts` | Purchases, reports, analytics, audit log, backups |
| `migration.test.ts` | Upgrading an existing database in place: subtotals, the credit ledger, stock batches |

They run sequentially (`--test-concurrency=1`); each spawns a server, so a
parallel run just fights itself for CPU.

---

## Layout

```
server.ts              API, auth, validation, billing and purchase routes
db/index.ts            Schema, migrations, indexes, syncItemStock()
db/asyncRead.ts        Worker pool for heavy reads
db/read-worker.mjs     Read-only SQLite connection (keeps billing responsive)
src/pages/             One file per screen
src/store/             Zustand stores (cart, auth, catalogue cache, theme)
src/lib/billMath.ts    Bill arithmetic + FIFO allocation, shared by server and till
src/lib/cartActions.ts Adding to the bill: reads batches, refuses missing stock
src/lib/fullscreen.ts  Fullscreen API shim (prefixes, preference storage)
src/components/StockPanel.tsx  An item's batches, repricing, stock adjustments
src/components/Receipt.tsx   Thermal (80mm) and A4 tax invoice layouts
tests/                 End-to-end suite
```

Heavy reads — reports, the dashboard — run on worker threads. `better-sqlite3`
is synchronous, so running them on the main thread blocks every other request:
a dashboard load used to stall billing for several seconds. Keep analytical
queries on `readPool`.
