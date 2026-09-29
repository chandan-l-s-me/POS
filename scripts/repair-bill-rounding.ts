/**
 * One-off repair: reconcile stored bill totals with their line items.
 *
 *   npx tsx scripts/repair-bill-rounding.ts --dry-run   # report only
 *   npx tsx scripts/repair-bill-rounding.ts             # apply
 *
 * Bills written before the rounding fix in server.ts derived the taxable value
 * by rounding (base-price-per-unit x qty) independently of the rounded line
 * total. The two could disagree by a paisa, so on those bills:
 *
 *   sum(bill_items.total_amount) - discount  !=  bills.total_amount
 *
 * which made the printed invoice fail to add up (line amounts did not sum to
 * the Subtotal, and Subtotal + Tax did not equal the Grand Total).
 *
 * The line items are correct; only the bill header drifted. This recomputes
 * the header from the lines, rebalances the tender split so it still equals
 * the total, and shifts each affected customer's credit balance by the same
 * net delta so receivables stay consistent.
 *
 * The payable is floored to whole rupees, matching how server.ts now writes
 * new bills, so running this repeatedly is a no-op after the first pass.
 */
import db from '../db/index';

const DRY_RUN = process.argv.includes('--dry-run');
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

type BillRow = {
  id: number; bill_number: string; customer_id: number | null;
  total_amount: number; tax_amount: number; discount_amount: number;
  payment_method: string; cash_amount: number; upi_amount: number; credit_amount: number;
};

const bills = db.prepare(`
  SELECT id, bill_number, customer_id, total_amount, tax_amount, discount_amount,
         payment_method, cash_amount, upi_amount, credit_amount
  FROM bills ORDER BY id
`).all() as BillRow[];

const lineAgg = db.prepare(`
  SELECT ROUND(SUM(total_amount), 2) AS lineTotal,
         ROUND(SUM(sgst_amount + cgst_amount + COALESCE(igst_amount, 0)), 2) AS lineTax
  FROM bill_items WHERE bill_id = ?
`);

const updateBill = db.prepare(`
  UPDATE bills SET total_amount = ?, tax_amount = ?, cash_amount = ?, upi_amount = ?, credit_amount = ?
  WHERE id = ?
`);
const bumpCredit = db.prepare('UPDATE customers SET credit_balance = credit_balance + ? WHERE id = ?');

let repaired = 0;
let totalDrift = 0;
const creditDelta = new Map<number, number>();

const run = db.transaction(() => {
  for (const bill of bills) {
    const agg = lineAgg.get(bill.id) as { lineTotal: number | null; lineTax: number | null };
    if (agg.lineTotal == null) continue;

    // Floor to whole rupees — the same rule server.ts applies on creation.
    const nextTotal = Math.floor(round2(agg.lineTotal - bill.discount_amount));
    const nextTax = round2(agg.lineTax || 0);
    const delta = round2(nextTotal - bill.total_amount);

    if (delta === 0 && round2(bill.tax_amount) === nextTax) continue;

    // Keep the tender split equal to the total. Single-method bills take the
    // whole amount; a split bill absorbs the delta into its largest component
    // so no tender can be pushed negative.
    let { cash_amount: cash, upi_amount: upi, credit_amount: credit } = bill;
    if (bill.payment_method === 'cash') { cash = nextTotal; upi = 0; credit = 0; }
    else if (bill.payment_method === 'upi') { upi = nextTotal; cash = 0; credit = 0; }
    else if (bill.payment_method === 'credit') { credit = nextTotal; cash = 0; upi = 0; }
    else {
      const largest = Math.max(cash, upi, credit);
      if (largest === cash) cash = round2(cash + delta);
      else if (largest === upi) upi = round2(upi + delta);
      else credit = round2(credit + delta);
    }

    const creditShift = round2(credit - bill.credit_amount);
    if (creditShift !== 0 && bill.customer_id) {
      creditDelta.set(bill.customer_id, round2((creditDelta.get(bill.customer_id) || 0) + creditShift));
    }

    if (!DRY_RUN) updateBill.run(nextTotal, nextTax, cash, upi, credit, bill.id);
    repaired++;
    totalDrift = round2(totalDrift + Math.abs(delta));
  }

  for (const [customerId, shift] of creditDelta) {
    if (shift === 0) continue;
    if (!DRY_RUN) bumpCredit.run(shift, customerId);
  }

  if (DRY_RUN) throw new Error('__dry_run__');
});

try {
  run();
} catch (err: any) {
  if (err?.message !== '__dry_run__') throw err;
}

console.log(`
${DRY_RUN ? 'DRY RUN — nothing written' : 'Repair applied'}

  bills scanned      ${bills.length}
  bills reconciled   ${repaired}
  total drift        Rs ${totalDrift.toFixed(2)}
  customers adjusted ${[...creditDelta.values()].filter((v) => v !== 0).length}
`);

db.close();
