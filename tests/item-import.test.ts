/**
 * Importing a shop's items with the stock on hand: reading spreadsheets,
 * checking rows, and saving them all at once as opening stock.
 */
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { after, before, describe, it } from 'node:test';
import { ADMIN_PASSWORD, client, startServer, type Client, type TestServer } from './helpers.ts';
import { checkImportRows, emptyImportRow, readHsn, readUnit, rowsFromCells, type ImportRow } from '../src/lib/itemImport.ts';
import { parseDelimited, readXlsx, writeXlsx } from '../src/lib/spreadsheet.ts';
import { buildItemTemplate } from '../src/lib/itemImportTemplate.ts';

const row = (values: Partial<ImportRow>): ImportRow => ({ ...emptyImportRow(), ...values });
const good = (name: string, extra: Partial<ImportRow> = {}) =>
  row({ name, hsn_code: '1701', unit: 'kg', gst: '5', quantity: '10', cost: '40', price: '46', ...extra });

describe('reading spreadsheets', () => {
  it('reads CSV with quotes, and cells pasted from Excel', () => {
    assert.deepEqual(parseDelimited('﻿Item name,Price\r\n"Rice, sona ""special""",55\r\n'), [
      ['Item name', 'Price'],
      ['Rice, sona "special"', '55'],
    ]);
    assert.deepEqual(parseDelimited('Sugar\t1701\tkg\nDal\t0713\tkg'), [['Sugar', '1701', 'kg'], ['Dal', '0713', 'kg']]);
    assert.deepEqual(parseDelimited('Item name;Price\nOil;140'), [['Item name', 'Price'], ['Oil', '140']]);
  });

  it('reads back the .xlsx it writes', async () => {
    const bytes = writeXlsx([
      { name: 'Items', headingRow: true, textColumns: [1], rows: [['Item name', 'HSN code', 'Quantity'], ['Toor dal & co <1kg>', '0713', 12.5]] },
      { name: 'Help', rows: [['ignored']] },
    ]);
    assert.deepEqual(await readXlsx(bytes), [['Item name', 'HSN code', 'Quantity'], ['Toor dal & co <1kg>', '0713', '12.5']]);
  });

  it('reads an .xlsx as Excel saves it: compressed, shared strings, gaps', async () => {
    // A minimal workbook the way Excel writes one: deflated parts, text in
    // sharedStrings.xml, numbers with float noise, and an empty cell skipped.
    const files: Record<string, string> = {
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Stock" sheetId="1" r:id="rId7"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId7" Type="x" Target="worksheets/stock.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Item name</t></si><si><r><t>Sun</t></r><r><t xml:space="preserve">flower oil</t></r><rPh><t>x</t></rPh></si><si><t>Price</t></si></sst>',
      'xl/worksheets/stock.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>2</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="C3"><v>139.99999999999997</v></c></row></sheetData></worksheet>',
    };
    const parts: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
      const data = zlib.deflateRawSync(Buffer.from(text));
      const nameBytes = Buffer.from(name);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18); local.writeUInt32LE(text.length, 22); local.writeUInt16LE(nameBytes.length, 26);
      const dir = Buffer.alloc(46);
      dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(8, 10);
      dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(text.length, 24); dir.writeUInt16LE(nameBytes.length, 28); dir.writeUInt32LE(offset, 42);
      parts.push(local, nameBytes, data);
      central.push(dir, nameBytes);
      offset += 30 + nameBytes.length + data.length;
    }
    const centralSize = central.reduce((acc, b) => acc + b.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(4, 8); end.writeUInt16LE(4, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
    const zip = new Uint8Array(Buffer.concat([...parts, ...central, end]));

    assert.deepEqual(await readXlsx(zip), [['Item name', '', 'Price'], [], ['Sunflower oil', '', '140']]);
  });
});

describe('the Excel template', () => {
  it('reads back as a headed sheet with every column, in English and Kannada', async () => {
    const cells = await readXlsx(buildItemTemplate());
    assert.equal(cells.length, 1, 'just the headings: the help sheet is second');
    assert.equal(cells[0][0], 'Item name / ಐಟಂ ಹೆಸರು');
    const { headed } = rowsFromCells([...cells, ['Sugar', '1701', 'kg', '5', '10', '40', '46', '']]);
    assert.equal(headed, true);
    const { rows } = rowsFromCells([...cells, ['Sugar', '0402', 'kg', '5', '10', '40', '46', 'ಸಕ್ಕರೆ']]);
    assert.deepEqual(rows[0], { name: 'Sugar', hsn_code: '0402', unit: 'kg', gst: '5', quantity: '10', cost: '40', price: '46', name_kn: 'ಸಕ್ಕರೆ', barcode: '', in_my_gst: '' });
  });
});

describe('import rows', () => {
  it('finds columns by their headings, in any order, the template’s Kannada included', () => {
    const { rows, headed } = rowsFromCells([
      ['Selling price (with GST) / ಮಾರಾಟ ಬೆಲೆ (GST ಸೇರಿ)', 'Qty', 'Item Name', 'HSN', 'UOM', 'GST %'],
      ['46', '10', 'Sugar', '1701', 'Kgs', '5%'],
      ['', '', '', '', '', ''],
    ]);
    assert.equal(headed, true);
    assert.deepEqual(rows, [row({ price: '46', quantity: '10', name: 'Sugar', hsn_code: '1701', unit: 'Kgs', gst: '5%' })]);
  });

  it('takes the template’s column order when there are no headings', () => {
    const { rows, headed } = rowsFromCells([['Sugar', '1701', 'kg', '5', '10', '40', '46']]);
    assert.equal(headed, false);
    assert.equal(rows[0].price, '46');
  });

  it('understands everyday units and HSN codes Excel cut short', () => {
    assert.equal(readUnit('Pcs'), 'piece');
    assert.equal(readUnit('KGS'), 'kg');
    assert.equal(readUnit('pkt'), 'packet');
    assert.equal(readUnit('litre'), null);
    assert.equal(readHsn('402'), '0402', 'Excel drops the leading zero');
    assert.equal(readHsn('19053100'), '19053100');
  });

  it('accepts a good row, and reads ₹, commas and 18% formatted as 0.18', () => {
    const [checked] = checkImportRows([good('Atta 10kg', { unit: 'bag', gst: '0.05', quantity: '3', cost: '₹ 1,250', price: 'Rs.1,400.50' })]);
    assert.deepEqual(checked.problems, []);
    assert.deepEqual(checked.item, {
      name: 'Atta 10kg', name_kn: null, hsn_code: '1701', metric: 'bag', gst_rate: 5, quantity: 3, unit_cost: 1250, selling_price: 1400.5, barcode: null, in_my_gst: true,
    });
  });

  it('says what is wrong with each field', () => {
    const [checked] = checkImportRows([row({ name: 'Soap', hsn_code: '34', unit: 'litre', gst: '15', quantity: '2.5', unit_cost: '', price: '' } as any)]);
    assert.deepEqual(checked.problems.map((p) => [p.field, p.message]), [
      ['hsn_code', 'HSN code should be 4, 6 or 8 digits'],
      ['unit', 'Unknown unit "{unit}". Use piece, kg, packet, box or bag'],
      ['gst', 'GST must be one of {slabs}'],
      ['price', 'Enter the selling price'],
    ]);
    const [whole] = checkImportRows([good('Soap', { unit: 'piece', quantity: '2.5' })]);
    assert.deepEqual(whole.problems.map((p) => p.field), ['quantity'], 'only kg takes a part quantity');
  });

  it('flags a name already in the app or entered twice, and warns on selling below cost', () => {
    const checked = checkImportRows(
      [good('Sugar'), good('Salt'), good('  SALT '), good('Jaggery', { cost: '60', price: '50' })],
      new Set(['sugar'])
    );
    assert.match(checked[0].problems[0].message, /Already an item/);
    assert.deepEqual(checked[1].problems, []);
    assert.deepEqual(checked[2].problems[0], { field: 'name', message: 'Entered twice — also on row {row}', vars: { row: 2 } });
    assert.equal(checked[3].problems[0].warning, true);
    assert.ok(checked[3].item, 'a warning does not stop the row');
  });
});

describe('POST /api/items/import', () => {
  let server: TestServer;
  let admin: Client;

  before(async () => {
    server = await startServer();
    admin = client(server.baseUrl);
    assert.equal((await admin.login('admin', ADMIN_PASSWORD)).status, 200);
  });
  after(async () => { await server?.stop(); });

  const find = async (name: string) => (await admin.get(`/api/items?search=${encodeURIComponent(name)}`)).body.data.find((i: any) => i.name === name);

  it('adds every item with its stock as opening stock, ready to bill', async () => {
    const res = await admin.post('/api/items/import', {
      rows: [
        good('Import Sugar', { quantity: '12.5' }),
        good('Import Biscuit', { hsn_code: '1905', unit: 'packet', gst: '18', quantity: '0', cost: '', price: '10', name_kn: 'ಬಿಸ್ಕತ್' }),
        emptyImportRow(),
      ],
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.count, 2);

    const sugar = await find('Import Sugar');
    assert.equal(sugar.stock_quantity, 12.5);
    assert.equal(sugar.price, 46);
    assert.equal(sugar.is_loose, 1);
    assert.deepEqual([sugar.gst_applicable, sugar.gst_mode, sugar.sgst_rate, sugar.cgst_rate], [1, 'split', 2.5, 2.5]);
    const batches = (await admin.get(`/api/items/${sugar.id}/batches`)).body;
    const list = batches.data;
    assert.deepEqual(list.map((b: any) => [b.source, b.quantity_remaining, b.unit_cost, b.selling_price]), [['opening', 12.5, 40, 46]]);

    const biscuit = await find('Import Biscuit');
    assert.equal(biscuit.stock_quantity, 0, 'listed with no stock yet');
    assert.equal(biscuit.price, 10);
    assert.equal(biscuit.name_kn, 'ಬಿಸ್ಕತ್', 'the Kannada name given is kept');

    // Billable straight away.
    const bill = await admin.post('/api/bills', { items: [{ id: sugar.id, quantity: 2 }], payment_method: 'cash' });
    assert.equal(bill.status, 200, JSON.stringify(bill.body));
    assert.equal((await find('Import Sugar')).stock_quantity, 10.5);

    // Not a purchase.
    assert.equal((await admin.get('/api/purchases?search=Import%20Sugar')).body.total, 0);
  });

  it('saves nothing when any row has a problem, and says which', async () => {
    const res = await admin.post('/api/items/import', {
      rows: [good('Import Rice'), good('Import Sugar'), good('Import Dal', { gst: '7' })],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.saved, false);
    assert.deepEqual(res.body.problems.map((p: any) => [p.row, p.field]), [[1, 'name'], [2, 'gst']]);
    assert.equal(await find('Import Rice'), undefined, 'not even the good row');
  });

  it('can only check', async () => {
    const res = await admin.post('/api/items/import', { rows: [good('Import Check Only')], check_only: true });
    assert.deepEqual([res.status, res.body.ok, res.body.saved, res.body.count], [200, true, false, 1]);
    assert.equal(await find('Import Check Only'), undefined);
  });

  it('takes a whole shop’s list in one go', async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => good(`Bulk item number ${String(i).padStart(4, '0')} with a longer name`));
    const res = await admin.post('/api/items/import', { rows });
    assert.equal(res.status, 201, JSON.stringify(res.body).slice(0, 300));
    assert.equal(res.body.count, 3000);
  });

  it('is for admins only, and refuses an empty list', async () => {
    assert.equal((await admin.post('/api/cashiers', { name: 'Imp', username: 'imp-cashier', password: 'cashier-pass-1' })).status, 201);
    const cashier = client(server.baseUrl);
    assert.equal((await cashier.login('imp-cashier', 'cashier-pass-1')).status, 200);
    assert.equal((await cashier.post('/api/items/import', { rows: [good('Nope')] })).status, 403);
    assert.equal((await admin.post('/api/items/import', { rows: [emptyImportRow()] })).status, 400);
  });
});
