/**
 * Item barcodes: the code printed on the pack (EAN-13 on most Indian goods,
 * 890…), or one the shop prints itself. A USB scanner is a keyboard: it types
 * the code and presses Enter.
 *
 * One rule set for every screen and for the server, so a code entered on a
 * purchase, on the Items page or in an import is stored the same way and a
 * scan finds it.
 */

export const BARCODE_MIN_LENGTH = 4;
export const BARCODE_MAX_LENGTH = 48;

/**
 * A barcode as stored and compared: no spaces, upper case. A scanner with
 * Caps Lock on types the letters of a code in the other case, so case must
 * not matter.
 */
export const normalizeBarcode = (text: unknown): string =>
  String(text ?? '').replace(/\s+/g, '').toUpperCase();

/** What is wrong with a (normalized) barcode, or null. '' is no barcode, which is fine. */
export const barcodeProblem = (code: string): string | null => {
  if (!code) return null;
  if (code.length < BARCODE_MIN_LENGTH || code.length > BARCODE_MAX_LENGTH) {
    return 'A barcode must be 4 to 48 characters long';
  }
  // A scanner types plain ASCII. Anything else is a typing slip (or a
  // Kannada keyboard), and would never match a scan.
  if (!/^[\x21-\x7E]+$/.test(code)) return 'A barcode can have only English letters, numbers and symbols';
  // A 13-digit EAN in a General-format column is saved to CSV as 8.90123E+12:
  // its last digits are gone, and it would match no scan.
  if (/^\d+(\.\d+)?E\+\d+$/.test(code)) {
    return 'Excel has shortened this barcode. Format the column as Text, type the barcode again and save.';
  }
  return null;
};

/**
 * Text that is almost certainly a scanned product code rather than an item
 * name: 8 to 14 digits (EAN-8, UPC-A, EAN-13, GTIN-14). Lets a name box that
 * was scanned into tell the two apart.
 */
export const looksLikeBarcode = (text: string) => /^\d{8,14}$/.test(text.trim());

/** The item carrying this code, from a list (the catalogue cache). */
export const findByBarcode = <T extends { barcode?: string | null }>(items: T[], code: string): T | undefined => {
  const wanted = normalizeBarcode(code);
  if (!wanted) return undefined;
  return items.find((item) => item.barcode != null && normalizeBarcode(item.barcode) === wanted);
};
