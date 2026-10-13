/**
 * One-off repair: recompute the GST on bills written before the
 * GST-inclusive fix.
 *
 *   npx tsx scripts/repair-bill-gst.ts --dry-run   # report only
 *   npx tsx scripts/repair-bill-gst.ts             # apply
 *
 * Item prices are GST-inclusive, but bills written before the fix in
 * computeUnitTaxBreakdown (server.ts) took the tax as price x rate / 100
 * instead of price x rate / (100 + total rate). What the customer paid was
 * right; the split between taxable value and GST was not. Rs 785 at 5%
 * recorded Rs 39.26 of GST on Rs 745.74, where it should be Rs 37.38 on
 * Rs 747.62, and the invoice printed the rate as 2.63% + 2.63%.
 *
 * For each line still carrying the old figures, this recomputes the tax from
 * the line total and the rate recorded on the line, re-derives the taxable
 * value by subtraction exactly as server.ts does, and rebuilds the bill's
 * subtotal and tax from its lines. Line totals do not change, so no bill
 * total, tender split or customer balance moves.
 *
 * A line is only rewritten when its amounts match the old formula at its
 * recorded rate. A line that matches neither formula — say, an item whose
 * rate was changed after the sale, so the backfilled rate is not the one that
 * was charged — is listed and left alone. Running this again is a no-op.
 */
import db, { initDb } from '../db/index';

const DRY_RUN = process.argv.includes('--dry-run');
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
// The old code rounded (unit tax x qty), not (line total x rate), so its
// figures can sit a paisa either side of what is recomputed here.
const PAISA_TOLERANCE = 0.011;

// Adds and backfills bill_items' rate columns on a database the current
// server has not opened yet.
initDb();

type Line = {
  id: number; bill_id: number; bill_number: string; quantity: number; total_amount: number;
  sgst_amount: number; cgst_amount: number; igst_amount: number;
  sgst_rate: number; cgst_rate: number; igst_rate: number;
};
type Taxes = { sgst: number; cgst: number; igst: number };

const lines = db.prepare(`
  SELECT bi.id, bi.bill_id, b.bill_number, bi.quantity, bi.total_amount,
         bi.sgst_amount, bi.cgst_amount, COALESCE(bi.igst_amount, 0) AS igst_amount,
         COALESCE(bi.sgst_rate, 0) AS sgst_rate, COALESCE(bi.cgst_rate, 0) AS cgst_rate,
         COALESCE(bi.igst_rate, 0) AS igst_rate
  FROM bill_items bi
  JOIN bills b ON b.id = bi.bill_id
  ORDER BY bi.id
`).all() as Line[];

const taxesAt = (line: Line, divisor: number): Taxes => ({
  sgst: round2((line.total_amount * line.sgst_rate) / divisor),
  cgst: round2((line.total_amount * line.cgst_rate) / divisor),
  igst: round2((line.total_amount * line.igst_rate) / divisor),
});
const distance = (line: Line, t: Taxes) =>
  Math.max(
    Math.abs(line.sgst_amount - t.sgst),
    Math.abs(line.cgst_amount - t.cgst),
    Math.abs(line.igst_amount - t.igst),
  );

const updateLine = db.prepare(`
  UPDATE bill_items SET sgst_amount = ?, cgst_amount = ?, igst_amount = ?, price = ? WHERE id = ?
`);
const billRow = db.prepare('SELECT subtotal_amount, tax_amount, discount_amount, total_amount FROM bills WHERE id = ?');
const lineAgg = db.prepare(`
  SELECT ROUND(SUM(total_amount - sgst_amount - cgst_amount - COALESCE(igst_amount, 0)), 2) AS subtotal,
         ROUND(SUM(sgst_amount + cgst_amount + COALESCE(igst_amount, 0)), 2) AS tax
  FROM bill_items WHERE bill_id = ?
`);
const updateBill = db.prepare('UPDATE bills SET subtotal_amount = ?, tax_amount = ? WHERE id = ?');

let repairedLines = 0;
let taxBefore = 0;
let taxAfter = 0;
const touchedBills = new Set<number>();
const unrecognised: string[] = [];
const totalsThatWouldMove: string[] = [];

const run = db.transaction(() => {
  for (const line of lines) {
    const totalRate = line.sgst_rate + line.cgst_rate + line.igst_rate;
    if (totalRate === 0) continue;

    const correct = taxesAt(line, 100 + totalRate);
    const old = taxesAt(line, 100);
    const fromCorrect = distance(line, correct);
    const fromOld = distance(line, old);

    // Already right (or close enough to right that it was not the old formula).
    if (fromCorrect <= fromOld) {
      if (fromCorrect > PAISA_TOLERANCE) {
        unrecognised.push(`${line.bill_number} line ${line.id}: matches neither formula at ${totalRate}%`);
      }
      continue;
    }
    if (fromOld > PAISA_TOLERANCE) {
      unrecognised.push(`${line.bill_number} line ${line.id}: matches neither formula at ${totalRate}%`);
      continue;
    }

    const taxable = round2(line.total_amount - correct.sgst - correct.cgst - correct.igst);
    const price = line.quantity > 0 ? round2(taxable / line.quantity) : 0;
    updateLine.run(correct.sgst, correct.cgst, correct.igst, price, line.id);
    touchedBills.add(line.bill_id);
    repairedLines++;
  }

  for (const billId of touchedBills) {
    const bill = billRow.get(billId) as { subtotal_amount: number; tax_amount: number; discount_amount: number; total_amount: number };
    const agg = lineAgg.get(billId) as { subtotal: number; tax: number };
    // Line totals are untouched, so the floored payable must come out the same.
    // If it would not, something else is wrong with this bill; say so.
    if (Math.floor(round2(agg.subtotal + agg.tax - (bill.discount_amount || 0))) !== bill.total_amount) {
      totalsThatWouldMove.push(`bill id ${billId}`);
    }
    taxBefore = round2(taxBefore + bill.tax_amount);
    taxAfter = round2(taxAfter + agg.tax);
    updateBill.run(agg.subtotal, agg.tax, billId);
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

  lines scanned        ${lines.length}
  lines corrected      ${repairedLines}
  bills corrected      ${touchedBills.size}
  GST on those bills   Rs ${taxBefore.toFixed(2)}  ->  Rs ${taxAfter.toFixed(2)}
  lines left alone     ${unrecognised.length} (match neither formula)
`);
if (unrecognised.length) console.log(unrecognised.slice(0, 20).map((s) => `  ${s}`).join('\n'));
if (totalsThatWouldMove.length) {
  console.log(`\n  WARNING: stored total no longer reconciles on ${totalsThatWouldMove.length} bill(s): ${totalsThatWouldMove.slice(0, 20).join(', ')}`);
}

db.close();
