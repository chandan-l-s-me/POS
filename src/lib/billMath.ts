/**
 * Bill arithmetic and FIFO stock allocation — one copy, used by both the server
 * (server.ts, db/index.ts) and the till (src/store/useCartStore.ts).
 *
 * These used to be two copies kept in step by a test. With stock held in
 * batches at different prices, the amount on the till depends on exactly how a
 * quantity is split across batches; two copies of that logic would be two ways
 * for the screen and the ledger to disagree. tests/cart-parity.test.ts still
 * checks the result end to end.
 *
 * Nothing in here touches the DOM or the database.
 */

/** Money: round to paise, guarding against binary floating-point drift. */
export const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

/** Quantity: loose goods are sold by weight, so keep three decimals (grams). */
export const round3 = (value: number) => Math.round((value + Number.EPSILON) * 1000) / 1000;

/** The tax fields of an item. SQLite hands booleans back as 0/1. */
export interface TaxableItem {
  gst_applicable: boolean | number;
  gst_mode?: string | null;
  gst_rate?: number | null;
  sgst_rate: number;
  cgst_rate: number;
  igst_rate?: number | null;
}

const itemGstMode = (item: TaxableItem) => item.gst_mode || (item.igst_rate ? 'igst' : 'split');

/**
 * Tax inside one GST-inclusive unit price. Selling prices in this app include
 * GST, so tax is carved out of the price rather than added on top.
 */
export const unitTaxBreakdown = (item: TaxableItem, unitPrice: number) => {
  if (!item.gst_applicable) {
    return { sgstUnit: 0, cgstUnit: 0, igstUnit: 0, basePriceUnit: unitPrice };
  }
  if (itemGstMode(item) === 'igst') {
    const igstUnit = (unitPrice * (item.igst_rate || item.gst_rate || 0)) / 100;
    return { sgstUnit: 0, cgstUnit: 0, igstUnit, basePriceUnit: unitPrice - igstUnit };
  }
  const sgstUnit = (unitPrice * item.sgst_rate) / 100;
  const cgstUnit = (unitPrice * item.cgst_rate) / 100;
  return { sgstUnit, cgstUnit, igstUnit: 0, basePriceUnit: unitPrice - sgstUnit - cgstUnit };
};

export interface LineAmounts {
  quantity: number;
  /** GST-inclusive price per unit charged on this line. */
  unit_price: number;
  sgst_amount: number;
  cgst_amount: number;
  igst_amount: number;
  total_amount: number;
  taxable_amount: number;
  /** Taxable value per unit — what bill_items.price stores. */
  price: number;
}

/**
 * One bill line: `quantity` units at `unitPrice` (GST-inclusive).
 *
 * The taxable value is derived by SUBTRACTING the already-rounded taxes from
 * the already-rounded line total, so `taxable + tax === total` holds exactly on
 * every line and the printed invoice always reconciles. Rounding the taxable
 * value independently let it drift a paisa per line.
 */
export const computeLine = (item: TaxableItem, unitPrice: number, quantity: number): LineAmounts => {
  const { sgstUnit, cgstUnit, igstUnit } = unitTaxBreakdown(item, unitPrice);
  const sgst_amount = round2(sgstUnit * quantity);
  const cgst_amount = round2(cgstUnit * quantity);
  const igst_amount = round2(igstUnit * quantity);
  const total_amount = round2(unitPrice * quantity);
  const taxable_amount = round2(total_amount - sgst_amount - cgst_amount - igst_amount);
  return {
    quantity,
    unit_price: unitPrice,
    sgst_amount,
    cgst_amount,
    igst_amount,
    total_amount,
    taxable_amount,
    price: quantity > 0 ? round2(taxable_amount / quantity) : 0,
  };
};

/** The GST rate an item is sold at, as a percentage. */
export const saleGstRate = (item: TaxableItem): number => {
  if (!item.gst_applicable) return 0;
  if (itemGstMode(item) === 'igst') return Number(item.igst_rate || item.gst_rate || 0);
  return Number(item.sgst_rate || 0) + Number(item.cgst_rate || 0);
};

/**
 * What margin a GST-inclusive selling price gives on a cost. Null when the
 * cost is unknown.
 *
 * Profit is on the cost *before* GST: the shop claims purchase GST back as
 * input tax credit, so the pre-GST cost is what the goods really cost it, and
 * output GST is collected on top of the pre-GST selling price.
 */
export const profitPercentFromSellingPrice = (
  unitCost: number | null | undefined,
  sellingPrice: number,
  gstRate: number
): number | null => {
  if (unitCost == null || !(unitCost > 0)) return null;
  return round2(((sellingPrice / (1 + gstRate / 100)) / unitCost - 1) * 100);
};

// ---------------------------------------------------------------------------
// FIFO

/** A batch of stock as the allocator needs it. Callers pass them oldest first. */
export interface FifoBatch {
  id: number;
  quantity_remaining: number;
  /** GST-inclusive selling price for units from this batch. */
  selling_price: number;
}

export interface Allocation {
  batch_id: number;
  quantity: number;
  selling_price: number;
}

/**
 * Take `quantity` from batches in the order given — oldest first — so last
 * week's stock is sold, at last week's price, before this week's.
 *
 * Returns what could be allocated and how much could not (`shortfall`).
 */
export const allocateFifo = (batches: FifoBatch[], quantity: number) => {
  let need = round3(quantity);
  const allocations: Allocation[] = [];
  for (const batch of batches) {
    if (need <= 0) break;
    const available = round3(batch.quantity_remaining);
    if (available <= 0) continue;
    const take = round3(Math.min(available, need));
    allocations.push({ batch_id: batch.id, quantity: take, selling_price: batch.selling_price });
    need = round3(need - take);
  }
  return { allocations, shortfall: need > 0 ? need : 0 };
};

export interface PriceSegment {
  unit_price: number;
  quantity: number;
  allocations: Allocation[];
}

/**
 * Turn allocations into bill lines.
 *
 * Consecutive allocations at the same price become one line, so a sale that
 * crosses from a ₹89.25 batch into a ₹94.50 batch is two lines — the invoice
 * shows exactly what each unit was charged. Billing cannot change these
 * prices; they are set on the purchase.
 */
export const priceSegments = (allocations: Allocation[]): PriceSegment[] => {
  if (allocations.length === 0) return [];
  const segments: PriceSegment[] = [];
  for (const allocation of allocations) {
    const last = segments[segments.length - 1];
    if (last && last.unit_price === allocation.selling_price) {
      last.quantity = round3(last.quantity + allocation.quantity);
      last.allocations.push(allocation);
    } else {
      segments.push({ unit_price: allocation.selling_price, quantity: allocation.quantity, allocations: [allocation] });
    }
  }
  return segments;
};
