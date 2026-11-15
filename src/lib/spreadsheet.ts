/**
 * Reading and writing simple spreadsheets: CSV, cells pasted from Excel or
 * Google Sheets, and .xlsx files. Only what the item import needs — the
 * first sheet's cell values going in; plain sheets with bold headings, column
 * widths, text columns and dropdown lists going out. No library: an .xlsx is
 * a zip of XML files, and the browser can inflate the zip.
 */

// ---------------------------------------------------------------------------
// CSV and pasted cells

/** CSV (comma, semicolon or tab separated) or pasted cells, as rows of text. */
export const parseDelimited = (text: string): string[][] => {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const count = (ch: string) => firstLine.split(ch).length - 1;
  const delimiter = count('\t') > 0 ? '\t' : count(';') > count(',') ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
};

// ---------------------------------------------------------------------------
// Zip

interface ZipEntry { name: string; method: number; data: Uint8Array }

const readZip = (bytes: Uint8Array): ZipEntry[] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('not a zip');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    entries.push({ name, method, data: bytes.subarray(start, start + size) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

const inflate = async (entry: ZipEntry): Promise<string> => {
  if (entry.method === 0) return new TextDecoder().decode(entry.data);
  if (entry.method !== 8) throw new Error(`unsupported compression ${entry.method}`);
  const stream = new Blob([entry.data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (data: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/** A zip of the given files, stored uncompressed: small, and every reader opens it. */
const writeZip = (files: Array<{ name: string; text: string }>): Uint8Array => {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // names are UTF-8
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true);
    central.setUint32(42, offset, true);
    parts.push(new Uint8Array(local.buffer), name, data);
    directory.push(new Uint8Array(central.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const directorySize = directory.reduce((acc, part) => acc + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, directorySize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...directory, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((acc, part) => acc + part.length, 0));
  let at = 0;
  for (const part of all) { out.set(part, at); at += part.length; }
  return out;
};

// ---------------------------------------------------------------------------
// .xlsx

const decodeXml = (text: string) =>
  text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const escapeXml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The text of every <t> in a fragment (rich text has several), phonetic hints left out. */
const textOf = (xml: string) =>
  [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1])).join('');

const attr = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];

const columnIndex = (ref: string) => {
  let index = 0;
  for (const ch of ref.replace(/\d+$/, '').toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
};

/** A number as Excel stored it, without float noise: 42.000000000000007 → "42". */
const numberText = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 1e6) / 1e6) : value;
};

/** The first sheet of an .xlsx file, as rows of text. */
export const readXlsx = async (bytes: Uint8Array): Promise<string[][]> => {
  const entries = new Map(readZip(bytes).map((entry) => [entry.name.replace(/^\//, ''), entry]));
  const read = async (name: string) => {
    const entry = entries.get(name);
    return entry ? inflate(entry) : null;
  };

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const workbook = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const firstSheet = workbook && /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const relId = firstSheet && attr(firstSheet, 'r:id');
  if (rels && relId) {
    const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]).find((tag) => attr(tag, 'Id') === relId);
    const target = rel && attr(rel, 'Target');
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  }

  const sharedXml = await read('xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];

  const sheet = await read(sheetPath);
  if (!sheet) throw new Error('no worksheet');
  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rowMatch[1], 'r')) || rows.length + 1;
    const cells: string[] = [];
    let position = 0;
    for (const cellMatch of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cellMatch[1], 'r');
      const index = ref ? columnIndex(ref) : position;
      position = index + 1;
      const type = attr(cellMatch[1], 't');
      const inner = cellMatch[2] ?? '';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's') value = shared[Number(raw)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str') value = decodeXml(raw ?? '');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : '';
      else if (type === 'e') value = '';
      else if (raw != null) value = numberText(raw);
      cells[index] = value.trim();
    }
    rows[rowNumber - 1] = Array.from(cells, (cell) => cell ?? '');
  }
  return Array.from(rows, (row) => row ?? []);
};

export type SheetCell = string | number | { text: string; bold?: boolean };

export interface SheetSpec {
  name: string;
  rows: SheetCell[][];
  /** Column widths, in characters. */
  widths?: number[];
  /** Columns (0-based) kept as text, so a code like 0402 keeps its zero. */
  textColumns?: number[];
  /** Style the first row as headings and keep it in view when scrolling. */
  headingRow?: boolean;
  /** Dropdown lists: a column (0-based) and its choices, for rows 2 to `rows`. */
  lists?: Array<{ column: number; choices: string[]; rows: number; error?: string }>;
}

const columnName = (index: number) => {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Cell styles (styles.xml): 0 normal, 1 heading (bold, shaded), 2 text, 3 bold.
const STYLES = `${XML_HEAD}<styleSheet xmlns="${MAIN}">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFDE7D2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

const sheetXml = (sheet: SheetSpec) => {
  const text = new Set(sheet.textColumns ?? []);
  const widths = sheet.widths ?? [];
  const columnCount = Math.max(widths.length, ...sheet.rows.map((row) => row.length));
  const cols = Array.from({ length: columnCount }, (_, i) => {
    const width = widths[i] ?? 12;
    return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"${text.has(i) ? ' style="2"' : ''}/>`;
  }).join('');
  const rows = sheet.rows.map((row, r) => {
    const cells = row.map((cell, c) => {
      const ref = `${columnName(c)}${r + 1}`;
      const heading = sheet.headingRow && r === 0;
      if (typeof cell === 'number') return `<c r="${ref}"${heading ? ' s="1"' : ''}><v>${cell}</v></c>`;
      const value = typeof cell === 'string' ? cell : cell.text;
      const style = heading ? 1 : typeof cell === 'object' && cell.bold ? 3 : text.has(c) ? 2 : 0;
      return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  }).join('');
  const view = sheet.headingRow
    ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  const lists = sheet.lists?.length
    ? `<dataValidations count="${sheet.lists.length}">${sheet.lists.map((list) => {
        const col = columnName(list.column);
        const error = list.error ? ` showErrorMessage="1" errorStyle="warning" error="${escapeXml(list.error)}"` : '';
        return `<dataValidation type="list" allowBlank="1"${error} sqref="${col}2:${col}${list.rows}"><formula1>"${escapeXml(list.choices.join(','))}"</formula1></dataValidation>`;
      }).join('')}</dataValidations>`
    : '';
  return `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${RELS}">${view}<cols>${cols}</cols><sheetData>${rows}</sheetData>${lists}</worksheet>`;
};

/** An .xlsx workbook of the given sheets. */
export const writeXlsx = (sheets: SheetSpec[]): Uint8Array => {
  const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  return writeZip([
    {
      name: '[Content_Types].xml',
      text: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="${sheetType}"/>`).join('')}</Types>`,
    },
    {
      name: '_rels/.rels',
      text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${RELS}"><sheets>${sheets.map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RELS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${RELS}/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', text: STYLES },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, text: sheetXml(sheet) })),
  ]);
};

/** Rows of text from a chosen file: .xlsx, or .csv / .txt. */
export const readSpreadsheetFile = async (file: File): Promise<string[][]> => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) return readXlsx(bytes);
  if (/\.xls$/i.test(file.name) || (bytes[0] === 0xd0 && bytes[1] === 0xcf)) throw new Error('OLD_EXCEL');
  return parseDelimited(new TextDecoder().decode(bytes));
};
