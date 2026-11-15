/**
 * Importing the items already on the shelves, with the stock on hand, when the
 * shop starts using the app. One set of rules for the import screen (which
 * checks rows as they are typed) and the server (which checks them again
 * before saving anything).
 *
 * Rows come from the Excel template, a CSV file, or cells pasted from a
 * spreadsheet. The stock goes in as opening stock: not a purchase, so it has
 * no supplier or payment and does not touch purchase reports or GST.
 *
 * Problems are English templates with {placeholders}; the screen shows them
 * through t(), so they are in the language on screen.
 */
import { GST_SLABS, round2, round3 } from './billMath';
import { isLooseUnit, UNIT_VALUES } from './units';
import { barcodeProblem, normalizeBarcode } from './barcode';

/** More than a shop's whole catalogue; keeps one request a sensible size. */
export const MAX_IMPORT_ROWS = 5000;

// Last, so a sheet without headings, read column by column, still lines up.
export const IMPORT_FIELDS = ['name', 'hsn_code', 'unit', 'gst', 'quantity', 'cost', 'price', 'name_kn', 'barcode', 'in_my_gst'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportRow = Record<ImportField, string>;

/** The template's columns, in order, and other headings that mean the same. */
export const IMPORT_COLUMNS: Array<{ field: ImportField; header: string; aliases: string[] }> = [
  { field: 'name', header: 'Item name', aliases: ['item', 'name', 'item name', 'product', 'product name', 'description', 'particulars'] },
  { field: 'hsn_code', header: 'HSN code', aliases: ['hsn', 'hsn code', 'hsn sac', 'hsn no', 'hsn number'] },
  { field: 'unit', header: 'Unit', aliases: ['unit', 'units', 'uom', 'metric'] },
  { field: 'gst', header: 'GST %', aliases: ['gst', 'gst %', 'gst rate', 'gst percent', 'tax', 'tax %', 'tax rate'] },
  { field: 'quantity', header: 'Quantity in stock', aliases: ['quantity', 'qty', 'stock', 'quantity in stock', 'opening stock', 'closing stock'] },
  { field: 'cost', header: 'Cost price (before GST)', aliases: ['cost', 'cost price', 'purchase price', 'purchase rate', 'buying price'] },
  { field: 'price', header: 'Selling price (with GST)', aliases: ['selling price', 'price', 'sale price', 'sales price', 'mrp', 'rate', 'sp'] },
  { field: 'name_kn', header: 'Kannada name (optional)', aliases: ['kannada', 'kannada name', 'name in kannada'] },
  { field: 'barcode', header: 'Barcode (optional)', aliases: ['barcode', 'bar code', 'barcode no', 'ean', 'ean code', 'upc'] },
  { field: 'in_my_gst', header: 'Include in my GST (Yes/No)', aliases: ['include in my gst', 'in my gst', 'my gst', 'include in gst'] },
];

/** "Yes", "Y", "No", "0" … → true or false; empty → true (included); anything else → null. */
export const readYesNo = (text: string): boolean | null => {
  const word = text.trim().toLowerCase().replace(/[.!]/g, '');
  if (!word) return true;
  if (['yes', 'y', 'true', '1', 'include', 'included', 'tick', 'ticked', '✓', '✔', 'ಹೌದು'].includes(word)) return true;
  if (['no', 'n', 'false', '0', 'exclude', 'excluded', 'ಇಲ್ಲ'].includes(word)) return false;
  return null;
};

export const emptyImportRow = (): ImportRow =>
  Object.fromEntries(IMPORT_FIELDS.map((field) => [field, ''])) as ImportRow;

export const isBlankRow = (row: ImportRow) => IMPORT_FIELDS.every((field) => !String(row[field] ?? '').trim());

/**
 * "Cost price (before GST)" → "cost price". The template's headings carry
 * Kannada after " / ", which is left out.
 */
const headingKey = (text: string) =>
  text.split(' / ')[0].toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9%]+/g, ' ').replace(/\s*%/, ' %').trim();

const HEADINGS = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  for (const name of [column.header, ...column.aliases]) HEADINGS.set(headingKey(name), column.field);
}

/**
 * Spreadsheet cells as import rows. A first row of headings (any order, the
 * template's or the usual alternatives) decides the columns; without one,
 * the columns are taken in the template's order. Blank rows are dropped.
 */
export const rowsFromCells = (cells: string[][]): { rows: ImportRow[]; headed: boolean } => {
  const lines = cells.filter((line) => line.some((cell) => String(cell ?? '').trim()));
  if (lines.length === 0) return { rows: [], headed: false };

  const mapped = lines[0].map((cell) => HEADINGS.get(headingKey(String(cell ?? ''))) ?? null);
  const headed = mapped.filter(Boolean).length >= 2;
  const fields: Array<ImportField | null> = headed ? mapped : IMPORT_FIELDS.slice();
  const body = headed ? lines.slice(1) : lines;

  const rows = body.map((line) => {
    const row = emptyImportRow();
    fields.forEach((field, index) => {
      if (field && !row[field]) row[field] = String(line[index] ?? '').trim();
    });
    // Excel turns 0402 into 402: show the code as it should be from the start.
    if (row.hsn_code) row.hsn_code = readHsn(row.hsn_code);
    if (row.barcode) row.barcode = normalizeBarcode(row.barcode);
    return row;
  });
  return { rows: rows.filter((row) => !isBlankRow(row)), headed };
};

// ---------------------------------------------------------------------------
// Reading each value

const UNIT_WORDS: Record<string, string> = {
  piece: 'piece', pieces: 'piece', pc: 'piece', pcs: 'piece', nos: 'piece', no: 'piece', number: 'piece',
  each: 'piece', ea: 'piece', unit: 'piece', units: 'piece', item: 'piece', items: 'piece', bottle: 'piece', bottles: 'piece',
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  packet: 'packet', packets: 'packet', pkt: 'packet', pkts: 'packet', pack: 'packet', packs: 'packet',
  box: 'box', boxes: 'box', carton: 'box', cartons: 'box',
  bag: 'bag', bags: 'bag', sack: 'bag', sacks: 'bag',
};

/** "Pcs", "KGS", "pkt" → the app's unit, or null. */
export const readUnit = (text: string): string | null => {
  const unit = UNIT_WORDS[text.trim().toLowerCase().replace(/[^a-z]/g, '')];
  return unit && (UNIT_VALUES as readonly string[]).includes(unit) ? unit : null;
};

/** "1,250.50", "₹ 48", "Rs.48" → a number; '' → null; anything else → NaN. */
export const readNumber = (text: string): number | null => {
  const cleaned = text.trim().replace(/^(rs\.?|inr|₹)\s*/i, '').replace(/[,\s₹]/g, '');
  if (!cleaned) return null;
  return /^-?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? Number(cleaned) : NaN;
};

/**
 * An HSN code. Excel drops a leading zero (0402 → 402), and codes are 4, 6 or
 * 8 digits, so an odd length gets its zero back.
 */
export const readHsn = (text: string): string => {
  const code = text.trim().replace(/[\s.]/g, '');
  return /^\d+$/.test(code) && code.length % 2 === 1 ? `0${code}` : code;
};

// ---------------------------------------------------------------------------
// Checking a row

export interface ImportItem {
  name: string;
  name_kn: string | null;
  hsn_code: string;
  metric: string;
  gst_rate: number;
  quantity: number;
  /** Before GST; null when not known. */
  unit_cost: number | null;
  /** GST-inclusive. */
  selling_price: number;
  /** Normalized; null when none was given. */
  barcode: string | null;
  /** Shown in the sales report's "In my GST" view. Yes unless the sheet says no. */
  in_my_gst: boolean;
}

export interface ImportProblem {
  field: ImportField;
  /** English, with {placeholders} filled from `vars`. */
  message: string;
  vars?: Record<string, string | number>;
  /** Worth a look, but does not stop the import. */
  warning?: boolean;
}

export interface CheckedRow {
  item: ImportItem | null;
  problems: ImportProblem[];
}

const nameKey = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

const checkRow = (row: ImportRow): CheckedRow => {
  const problems: ImportProblem[] = [];
  const problem = (field: ImportField, message: string, vars?: ImportProblem['vars']) => problems.push({ field, message, vars });

  const name = String(row.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) problem('name', 'Enter the item name');
  else if (name.length > 200) problem('name', 'Item name is too long (at most {max} letters)', { max: 200 });

  const nameKn = String(row.name_kn ?? '').trim();
  if (nameKn.length > 200) problem('name_kn', 'Kannada name is too long (at most {max} letters)', { max: 200 });

  const hsn = readHsn(String(row.hsn_code ?? ''));
  if (!hsn) problem('hsn_code', 'Enter the HSN code');
  else if (!/^\d{4}(\d{2}){0,2}$/.test(hsn)) problem('hsn_code', 'HSN code should be 4, 6 or 8 digits');

  const unitText = String(row.unit ?? '').trim();
  const metric = unitText ? readUnit(unitText) : null;
  if (!unitText) problem('unit', 'Choose the unit');
  else if (!metric) problem('unit', 'Unknown unit "{unit}". Use piece, kg, packet, box or bag', { unit: unitText });

  const gstText = String(row.gst ?? '').trim().replace(/%$/, '');
  const gst = readNumber(gstText);
  // A spreadsheet formatted as % stores 18% as 0.18.
  const gstRate = gst != null && gst > 0 && gst < 1 ? round2(gst * 100) : gst;
  if (gstRate == null) problem('gst', 'Choose the GST %');
  else if (!(GST_SLABS as readonly number[]).includes(gstRate)) {
    problem('gst', 'GST must be one of {slabs}', { slabs: GST_SLABS.join(', ') });
  }

  const quantity = readNumber(String(row.quantity ?? ''));
  if (quantity == null) problem('quantity', 'Enter the quantity in stock (0 if none)');
  else if (Number.isNaN(quantity) || quantity < 0 || quantity > 1_000_000) problem('quantity', 'Quantity must be a number, 0 or more');
  else if (metric && !isLooseUnit(metric) && !Number.isInteger(quantity)) problem('quantity', 'Only kg can have a part quantity; use a whole number');

  const cost = readNumber(String(row.cost ?? ''));
  if (cost != null && (Number.isNaN(cost) || cost < 0 || cost > 10_000_000)) problem('cost', 'Cost price must be a number');

  const barcode = normalizeBarcode(row.barcode);
  const badBarcode = barcodeProblem(barcode);
  if (badBarcode) problem('barcode', badBarcode);

  const inMyGst = readYesNo(String(row.in_my_gst ?? ''));
  if (inMyGst == null) problem('in_my_gst', 'Include in my GST should be Yes or No');

  const price = readNumber(String(row.price ?? ''));
  if (price == null) problem('price', 'Enter the selling price');
  else if (Number.isNaN(price) || price < 0.01 || price > 10_000_000) problem('price', 'Selling price must be more than 0');

  if (problems.length > 0) return { item: null, problems };

  const item: ImportItem = {
    name,
    name_kn: nameKn || null,
    hsn_code: hsn,
    metric: metric!,
    gst_rate: gstRate!,
    quantity: round3(quantity!),
    unit_cost: cost ? round2(cost) : null,
    selling_price: round2(price!),
    barcode: barcode || null,
    in_my_gst: inMyGst!,
  };
  if (item.unit_cost != null && item.selling_price / (1 + item.gst_rate / 100) < item.unit_cost) {
    problems.push({ field: 'price', message: 'Sells below cost — check the prices', warning: true });
  }
  return { item, problems };
};

/**
 * Check every row. `existingNames` are the items already in the app (lower
 * case); a name already there, or on an earlier row, is a problem: the same
 * item must not be added twice. `existingBarcodes` maps the barcodes already
 * in the app to their item's name: a barcode belongs to one item.
 */
export const checkImportRows = (
  rows: ImportRow[],
  existingNames: Set<string> = new Set(),
  existingBarcodes: Map<string, string> = new Map()
): CheckedRow[] => {
  const firstRow = new Map<string, number>();
  const firstBarcodeRow = new Map<string, number>();
  return rows.map((row, index) => {
    const checked = checkRow(row);
    const code = normalizeBarcode(row.barcode);
    if (code && !barcodeProblem(code)) {
      const owner = existingBarcodes.get(code);
      if (owner != null) {
        checked.problems.push({ field: 'barcode', message: 'This barcode is already on {item}', vars: { item: owner } });
        checked.item = null;
      } else if (firstBarcodeRow.has(code)) {
        checked.problems.push({ field: 'barcode', message: 'Same barcode as row {row}', vars: { row: firstBarcodeRow.get(code)! + 1 } });
        checked.item = null;
      } else {
        firstBarcodeRow.set(code, index);
      }
    }
    const key = nameKey(String(row.name ?? ''));
    if (!key) return checked;
    if (existingNames.has(key)) {
      checked.problems.unshift({ field: 'name', message: 'Already an item in the app. Add its stock from Items → Stock & prices' });
      checked.item = null;
    } else if (firstRow.has(key)) {
      checked.problems.unshift({ field: 'name', message: 'Entered twice — also on row {row}', vars: { row: firstRow.get(key)! + 1 } });
      checked.item = null;
    } else {
      firstRow.set(key, index);
    }
    return checked;
  });
};

export const blocking = (checked: CheckedRow) => checked.problems.filter((problem) => !problem.warning);

/** A raw row as sent by a client: only the known fields, as text. */
export const toImportRow = (value: unknown): ImportRow => {
  const row = emptyImportRow();
  if (value && typeof value === 'object') {
    for (const field of IMPORT_FIELDS) {
      const cell = (value as Record<string, unknown>)[field];
      row[field] = cell == null ? '' : String(cell).slice(0, 500);
    }
  }
  return row;
};

export const importNameKey = nameKey;
