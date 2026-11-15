/**
 * The Excel template for the item import: an Items sheet with headings in
 * English and Kannada, dropdowns for unit and GST %, and the HSN and barcode
 * columns kept as text, so 0402 keeps its zero and Excel does not show a
 * barcode as 8.90123E+12; and a sheet explaining each
 * column, with examples.
 */
import { kn } from '../i18n/kn';
import { GST_SLABS } from './billMath';
import { UNIT_OPTIONS } from './units';
import { IMPORT_COLUMNS, MAX_IMPORT_ROWS } from './itemImport';
import { writeXlsx } from './spreadsheet';

/** A heading with its Kannada after " / ", so whoever fills the sheet can read it. */
const bilingual = (english: string) => (kn[english] && kn[english] !== english ? `${english} / ${kn[english]}` : english);

const HELP: Array<[string, string]> = [
  ['One row per item. Write the item name in English, as it will be searched for when billing.', 'ಒಂದು ಸಾಲಿಗೆ ಒಂದು ಐಟಂ. ಐಟಂ ಹೆಸರನ್ನು ಇಂಗ್ಲಿಷ್‌ನಲ್ಲಿ ಬರೆಯಿರಿ — ಬಿಲ್ ಮಾಡುವಾಗ ಹಾಗೆಯೇ ಹುಡುಕುತ್ತೀರಿ.'],
  ['HSN code: 4, 6 or 8 digits, from the item’s purchase bill.', 'HSN ಕೋಡ್: 4, 6 ಅಥವಾ 8 ಅಂಕಿಗಳು, ಐಟಂನ ಖರೀದಿ ಬಿಲ್‌ನಿಂದ.'],
  ['Unit: choose piece, kg, packet, box or bag.', 'ಅಳತೆ: piece, kg, packet, box ಅಥವಾ bag ಆರಿಸಿ.'],
  ['GST %: choose 0, 5, 12, 18, 28 or 40.', 'GST %: 0, 5, 12, 18, 28 ಅಥವಾ 40 ಆರಿಸಿ.'],
  ['Quantity in stock: count what is in the shop now. 0 if none. Only kg can have a part quantity, like 12.5.', 'ಸ್ಟಾಕ್ ಪ್ರಮಾಣ: ಈಗ ಅಂಗಡಿಯಲ್ಲಿ ಇರುವುದನ್ನು ಎಣಿಸಿ. ಇಲ್ಲದಿದ್ದರೆ 0. kg ಗೆ ಮಾತ್ರ 12.5 ರಂತೆ ಭಾಗ ಪ್ರಮಾಣ.'],
  ['Cost price: what one unit cost you, before GST. Optional, but the profit report needs it.', 'ಖರೀದಿ ಬೆಲೆ: ಒಂದಕ್ಕೆ ನೀವು ಕೊಟ್ಟ ಬೆಲೆ, GST ಮೊದಲು. ಐಚ್ಛಿಕ, ಆದರೆ ಲಾಭದ ವರದಿಗೆ ಬೇಕು.'],
  ['Selling price: what you sell one unit for, including GST.', 'ಮಾರಾಟ ಬೆಲೆ: ಒಂದರ ಮಾರಾಟ ಬೆಲೆ, GST ಸೇರಿ.'],
  ['Kannada name: optional. Left empty, it is translated automatically.', 'ಕನ್ನಡ ಹೆಸರು: ಐಚ್ಛಿಕ. ಖಾಲಿ ಬಿಟ್ಟರೆ ತಾನಾಗಿಯೇ ಅನುವಾದವಾಗುತ್ತದೆ.'],
  ['Include in my GST: Yes or No. Yes (or empty) shows the item\u2019s sales in the report\u2019s \u201cIn my GST\u201d view. Bills show GST on every item either way.', 'ನನ್ನ ಜಿಎಸ್‌ಟಿಯಲ್ಲಿ ಸೇರಿಸಿ: Yes ಅಥವಾ No. Yes (ಅಥವಾ ಖಾಲಿ) ಆದರೆ ಈ ಐಟಂನ ಮಾರಾಟ ವರದಿಯ “ನನ್ನ ಜಿಎಸ್‌ಟಿಯಲ್ಲಿ” ನೋಟದಲ್ಲಿ ಕಾಣುತ್ತದೆ. ಯಾವುದೇ ಆದರೂ ಬಿಲ್‌ನಲ್ಲಿ ಪ್ರತಿ ಐಟಂಗೆ ಜಿಎಸ್‌ಟಿ ಇರುತ್ತದೆ.'],
  ['Barcode: optional. Click the cell and scan the pack, or type the number printed under the bars. Leave it empty for loose items.', 'ಬಾರ್‌ಕೋಡ್: ಐಚ್ಛಿಕ. ಸೆಲ್ ಕ್ಲಿಕ್ ಮಾಡಿ ಪ್ಯಾಕ್ ಸ್ಕ್ಯಾನ್ ಮಾಡಿ, ಅಥವಾ ಗೆರೆಗಳ ಕೆಳಗಿನ ಸಂಖ್ಯೆಯನ್ನು ಬರೆಯಿರಿ. ಬಿಡಿ ಸಾಮಾನುಗಳಿಗೆ ಖಾಲಿ ಬಿಡಿ.'],
  ['Do not change the headings in row 1. Save the file and upload it on the Import items page.', 'ಸಾಲು 1 ರ ಶೀರ್ಷಿಕೆಗಳನ್ನು ಬದಲಿಸಬೇಡಿ. ಫೈಲ್ ಉಳಿಸಿ, Import items ಪುಟದಲ್ಲಿ ಅಪ್‌ಲೋಡ್ ಮಾಡಿ.'],
];

const EXAMPLES: Array<Array<string | number>> = [
  ['Sugar loose', '1701', 'kg', 5, 48.5, 40, 46, '', '', 'Yes'],
  ['Glucose biscuit 100g', '1905', 'packet', 18, 120, 8.47, 10, '', '8901234567890', 'Yes'],
  ['Sunflower oil 1L', '1512', 'piece', 5, 24, 120, 140, 'ಸೂರ್ಯಕಾಂತಿ ಎಣ್ಣೆ 1L', '', 'No'],
];


/** The template workbook, as .xlsx bytes. */
export const buildItemTemplate = (): Uint8Array => {
  const headings = IMPORT_COLUMNS.map((column) => bilingual(column.header));
  return writeXlsx([
    {
      name: 'Items',
      headingRow: true,
      rows: [headings],
      widths: [34, 12, 12, 10, 18, 22, 22, 28, 20, 22],
      textColumns: [1, 8],
      lists: [
        { column: 2, choices: UNIT_OPTIONS.map((unit) => unit.value), rows: MAX_IMPORT_ROWS + 1, error: 'piece, kg, packet, box, bag' },
        { column: 3, choices: GST_SLABS.map(String), rows: MAX_IMPORT_ROWS + 1, error: GST_SLABS.join(', ') },
        { column: 9, choices: ['Yes', 'No'], rows: MAX_IMPORT_ROWS + 1, error: 'Yes, No' },
      ],
    },
    {
      name: 'How to fill',
      widths: [34, 12, 12, 10, 18, 22, 22, 28, 20, 22],
      rows: [
        [{ text: 'How to fill the Items sheet / Items ಶೀಟ್ ತುಂಬುವ ವಿಧಾನ', bold: true }],
        [],
        ...HELP.flatMap(([en, k]) => [[en], [k], []]),
        [{ text: 'Example / ಉದಾಹರಣೆ', bold: true }],
        IMPORT_COLUMNS.map((column) => ({ text: column.header, bold: true })),
        ...EXAMPLES,
      ],
    },
  ]);
};
