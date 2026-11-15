/**
 * Import items: how a shop that is already trading puts its shelves into the
 * app. The items and the stock on hand come from an Excel or CSV file, cells
 * pasted from a spreadsheet, or rows typed here. Every row is checked as it
 * changes; nothing is saved until all of them are right, and then all are
 * saved together as opening stock.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ClipboardPaste, Download, FileSpreadsheet, Plus, Trash2, Upload, X } from 'lucide-react';
import { api } from '../api';
import { useDataStore } from '../store/useDataStore';
import { t, tn, unitLabel } from '../i18n';
import { cn } from '../lib/utils';
import { GST_SLABS, round2 } from '../lib/billMath';
import { UNIT_OPTIONS } from '../lib/units';
import {
  blocking, checkImportRows, emptyImportRow, IMPORT_COLUMNS, IMPORT_FIELDS, importNameKey, isBlankRow,
  MAX_IMPORT_ROWS, readHsn, readNumber, readUnit, readYesNo, rowsFromCells,
  type CheckedRow, type ImportField, type ImportProblem, type ImportRow,
} from '../lib/itemImport';
import { parseDelimited, readSpreadsheetFile } from '../lib/spreadsheet';
import { buildItemTemplate } from '../lib/itemImportTemplate';
import { normalizeBarcode } from '../lib/barcode';

interface Line { id: number; values: ImportRow }

const DRAFT_KEY = 'item-import-draft';
const PAGE_SIZE = 100;
let nextId = 1;
const line = (values: ImportRow = emptyImportRow()): Line => ({ id: nextId++, values });

const loadDraft = (): Line[] => {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '[]');
    return Array.isArray(saved) ? saved.map((values) => line({ ...emptyImportRow(), ...values })) : [];
  } catch {
    return [];
  }
};

const saveDraft = (lines: Line[]) => {
  try {
    const kept = lines.filter((l) => !isBlankRow(l.values)).map((l) => l.values);
    if (kept.length) localStorage.setItem(DRAFT_KEY, JSON.stringify(kept));
    else localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* private window or storage blocked: the draft just isn't kept */
  }
};

const problemText = (problem: ImportProblem) => t(problem.message, problem.vars);

const money = (value: number) => `₹${value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const downloadTemplate = () => {
  const blob = new Blob([buildItemTemplate() as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'vasavi-items-template.xlsx';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

const inputClass = 'w-full min-w-0 px-2 py-1.5 bg-white border rounded-lg text-sm outline-none focus:ring-2 focus:ring-orange-500';

export const ImportItems: React.FC = () => {
  const refreshItems = useDataStore((state) => state.refreshItems);
  const [lines, setLines] = useState<Line[]>(() => loadDraft());
  const [existing, setExisting] = useState<Set<string>>(new Set());
  // Barcodes already on items, with the item's name.
  const [existingBarcodes, setExistingBarcodes] = useState<Map<string, string>>(new Map());
  // Problems only the server can see (an item added since the page opened),
  // by line, until that line is edited.
  const [serverProblems, setServerProblems] = useState<Map<number, ImportProblem[]>>(new Map());
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [page, setPage] = useState(0);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ count: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api.getItemsPage({ limit: 1000 })
      .then((res) => {
        const items: Array<{ name: string; barcode?: string | null }> = res?.data ?? [];
        setExisting(new Set(items.map((item) => importNameKey(item.name))));
        setExistingBarcodes(new Map(items.filter((item) => item.barcode).map((item) => [item.barcode!, item.name])));
      })
      .catch(() => { /* the server checks again on import */ });
  }, []);

  useEffect(() => { saveDraft(lines); }, [lines]);

  const checked: CheckedRow[] = useMemo(() => {
    const result = checkImportRows(lines.map((l) => l.values), existing, existingBarcodes);
    return result.map((row, index) => {
      const extra = serverProblems.get(lines[index].id);
      return extra ? { item: null, problems: [...extra, ...row.problems] } : row;
    });
  }, [lines, existing, existingBarcodes, serverProblems]);

  const filled = lines.map((l, index) => ({ line: l, index, check: checked[index] })).filter((entry) => !isBlankRow(entry.line.values));
  const withProblems = filled.filter((entry) => blocking(entry.check).length > 0);
  const ready = filled.length - withProblems.length;
  const totals = filled.reduce(
    (acc, { check }) => {
      if (!check.item) return acc;
      acc.atPrice += check.item.quantity * check.item.selling_price;
      if (check.item.unit_cost != null) acc.atCost += check.item.quantity * check.item.unit_cost;
      else acc.noCost += 1;
      return acc;
    },
    { atPrice: 0, atCost: 0, noCost: 0 }
  );

  const shown = onlyProblems ? withProblems.map((entry) => entry.index) : lines.map((_, index) => index);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const visible = shown.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const forget = (ids: number[]) => {
    if (!ids.some((id) => serverProblems.has(id))) return;
    setServerProblems((current) => {
      const next = new Map(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  };

  const setCell = (id: number, field: ImportField, value: string) => {
    setLines((current) => current.map((l) => (l.id === id ? { ...l, values: { ...l.values, [field]: value } } : l)));
    forget([id]);
  };

  /** Rows read from a file or pasted: replace what is on screen, or add to it. */
  const takeCells = (cells: string[][], source: 'file' | 'paste') => {
    const { rows, headed } = rowsFromCells(cells);
    if (rows.length === 0) {
      setNotice({ ok: false, text: t('No items found in it. Check that each item is on its own row.') });
      return;
    }
    const kept = lines.filter((l) => !isBlankRow(l.values));
    let replace = kept.length === 0;
    if (!replace && source === 'file') {
      replace = window.confirm(t('Replace the {count} rows on screen with this file? Cancel adds the file’s rows after them.', { count: kept.length }));
    }
    const incoming = rows.map((row) => line(row));
    const next = replace ? incoming : [...kept, ...incoming];
    if (next.length > MAX_IMPORT_ROWS) {
      setNotice({ ok: false, text: t('At most {max} items can be imported at once. Split the list into parts.', { max: MAX_IMPORT_ROWS }) });
      return;
    }
    setLines(next);
    setServerProblems(new Map());
    setPage(0);
    setDone(null);
    setNotice({
      ok: true,
      text: tn(rows.length, '1 row read.', '{count} rows read.') +
        (headed ? '' : ` ${t('No headings found, so the columns were read in the template’s order.')}`),
    });
  };

  const openFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      takeCells(await readSpreadsheetFile(file), 'file');
    } catch (err: any) {
      setNotice({
        ok: false,
        text: err?.message === 'OLD_EXCEL'
          ? t('This is an old Excel file (.xls). In Excel, use Save As → Excel Workbook (.xlsx), then choose it again.')
          : t('Could not read this file. Use the Excel template (.xlsx) or a CSV file.'),
      });
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim()) takeCells(parseDelimited(text), 'paste');
      else setNotice({ ok: false, text: t('Nothing copied. Select the cells in Excel or Google Sheets, copy them, then press this again.') });
    } catch {
      setNotice({ ok: false, text: t('Could not read the clipboard. Click a cell in the table below and press Ctrl+V instead.') });
    }
  };

  /** Several cells pasted into one: fill across and down from there, like a spreadsheet. */
  const pasteIntoCell = (event: React.ClipboardEvent, index: number, field: ImportField) => {
    const text = event.clipboardData.getData('text/plain');
    if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;
    event.preventDefault();
    const cells = parseDelimited(text.replace(/\r?\n$/, ''));
    const startColumn = IMPORT_FIELDS.indexOf(field);
    setLines((current) => {
      const next = current.slice();
      cells.forEach((cellRow, r) => {
        const at = index + r;
        if (at >= MAX_IMPORT_ROWS) return;
        while (next.length <= at) next.push(line());
        const values = { ...next[at].values };
        cellRow.forEach((cell, c) => {
          const target = IMPORT_FIELDS[startColumn + c];
          if (target) values[target] = cell.trim();
        });
        next[at] = { ...next[at], values };
      });
      return next;
    });
    setServerProblems(new Map());
  };

  const addRows = (count: number) => {
    setLines((current) => [...current, ...Array.from({ length: count }, () => line())].slice(0, MAX_IMPORT_ROWS));
    setOnlyProblems(false);
    setPage(Math.floor(lines.length / PAGE_SIZE));
  };

  const removeLine = (id: number) => {
    setLines((current) => current.filter((l) => l.id !== id));
    forget([id]);
  };

  const clearAll = () => {
    if (!window.confirm(t('Remove all {count} rows from this page?', { count: filled.length }))) return;
    setLines([]);
    setServerProblems(new Map());
    setNotice(null);
    setPage(0);
  };

  const runImport = async () => {
    if (filled.length === 0 || withProblems.length > 0) return;
    if (!window.confirm(tn(filled.length, 'Add 1 item with its stock to the app?', 'Add {count} items with their stock to the app?'))) return;
    setBusy(true);
    setNotice(null);
    try {
      const sentLines = filled.map((entry) => entry.line);
      const result = await api.importItems({ rows: sentLines.map((l) => l.values) });
      if (!result.saved) {
        const byLine = new Map<number, ImportProblem[]>();
        for (const problem of result.problems ?? []) {
          const target = sentLines[problem.row];
          if (!target || problem.warning) continue;
          byLine.set(target.id, [...(byLine.get(target.id) ?? []), problem]);
        }
        setServerProblems(byLine);
        setOnlyProblems(true);
        setPage(0);
        setNotice({ ok: false, text: t('Nothing was saved. Fix the rows marked in red and import again.') });
        return;
      }
      setDone({ count: result.count });
      setLines([]);
      setServerProblems(new Map());
      await refreshItems().catch(() => undefined);
    } catch (err: any) {
      setNotice({ ok: false, text: err?.message || t('Import failed. Nothing was saved.') });
    } finally {
      setBusy(false);
    }
  };

  const problemFields = (check: CheckedRow) => new Set(blocking(check).map((problem) => problem.field));

  return (
    <div
      className="space-y-6"
      onPaste={(event) => {
        // Pasted anywhere outside the table's cells: read it as rows.
        if ((event.target as HTMLElement).closest('input, select, textarea')) return;
        const text = event.clipboardData.getData('text/plain');
        if (text.trim()) { event.preventDefault(); takeCells(parseDelimited(text), 'paste'); }
      }}
    >
      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-6 border-b border-gray-100 bg-gradient-to-r from-orange-50 to-amber-50 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('Import items')}</h1>
            <p className="text-sm text-gray-600 mt-1 max-w-3xl">
              {t('Add the items already in the shop, with the stock you have now. It is saved as opening stock — not a purchase, so purchase reports and GST are not affected.')}
            </p>
          </div>
          <Link to="/items" className="text-sm font-bold text-orange-600 hover:underline">{t('← Back to Items')}</Link>
        </div>

        <div className="p-6 grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 space-y-3">
            <p className="text-xs font-bold text-orange-600 uppercase">{t('Step 1')}</p>
            <p className="font-bold text-gray-900">{t('Fill the Excel template')}</p>
            <p className="text-sm text-gray-600">
              {t('One row per item. Unit and GST % have dropdowns. The second sheet explains each column, in Kannada too.')}
            </p>
            <button type="button" onClick={downloadTemplate} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-gray-200 font-bold text-gray-700 hover:bg-gray-50">
              <Download size={16} /> {t('Download template')}
            </button>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 space-y-3">
            <p className="text-xs font-bold text-orange-600 uppercase">{t('Step 2')}</p>
            <p className="font-bold text-gray-900">{t('Upload it, or paste the rows')}</p>
            <p className="text-sm text-gray-600">
              {t('Excel (.xlsx) or CSV. Or copy the rows in Excel or Google Sheets and paste them here. You can also type rows in the table.')}
            </p>
            <div className="flex flex-wrap gap-2">
              <input ref={fileInput} type="file" accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className="hidden" onChange={(e) => openFile(e.target.files?.[0])} />
              <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-orange-600 text-white font-bold hover:bg-orange-700">
                <Upload size={16} /> {t('Choose file')}
              </button>
              <button type="button" onClick={pasteFromClipboard} className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-gray-200 font-bold text-gray-700 hover:bg-gray-50">
                <ClipboardPaste size={16} /> {t('Paste rows')}
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-5 space-y-3">
            <p className="text-xs font-bold text-orange-600 uppercase">{t('Step 3')}</p>
            <p className="font-bold text-gray-900">{t('Check and import')}</p>
            <p className="text-sm text-gray-600">
              {t('Rows with a problem are marked in red; fix them in the table. Nothing is saved until every row is right.')}
            </p>
            <button
              type="button"
              onClick={runImport}
              disabled={busy || filled.length === 0 || withProblems.length > 0}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckCircle2 size={16} />
              {busy ? t('Importing…') : tn(ready, 'Import 1 item', 'Import {count} items')}
            </button>
          </div>
        </div>

        {notice && (
          <div className={cn('mx-6 mb-6 flex items-start gap-3 rounded-2xl px-4 py-3 text-sm font-medium', notice.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700')}>
            {notice.ok ? <FileSpreadsheet size={18} className="shrink-0 mt-0.5" /> : <AlertTriangle size={18} className="shrink-0 mt-0.5" />}
            <p className="flex-1">{notice.text}</p>
            <button type="button" onClick={() => setNotice(null)} className="text-current opacity-60 hover:opacity-100" aria-label={t('Close')}><X size={16} /></button>
          </div>
        )}

        {done && (
          <div className="mx-6 mb-6 rounded-2xl bg-emerald-50 border border-emerald-100 px-5 py-4 flex flex-wrap items-center gap-3">
            <CheckCircle2 className="text-emerald-600" size={22} />
            <p className="flex-1 font-bold text-emerald-800">
              {tn(done.count, '1 item added with its stock.', '{count} items added with their stock.')}{' '}
              <span className="font-normal">{t('Kannada names are filled in automatically over the next few minutes.')}</span>
            </p>
            <Link to="/items" className="px-4 py-2 rounded-xl bg-emerald-600 text-white font-bold hover:bg-emerald-700">{t('Go to Items')}</Link>
          </div>
        )}
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <span className="px-3 py-1.5 rounded-full bg-gray-100 font-bold text-gray-700">{tn(filled.length, '1 row', '{count} rows')}</span>
            <span className="px-3 py-1.5 rounded-full bg-emerald-50 font-bold text-emerald-700">{t('{count} ready', { count: ready })}</span>
            {withProblems.length > 0 && (
              <span className="px-3 py-1.5 rounded-full bg-red-50 font-bold text-red-700">{tn(withProblems.length, '1 needs fixing', '{count} need fixing')}</span>
            )}
          </div>
          <div className="text-sm text-gray-600 mr-auto">
            {t('Stock value: {price} at selling price incl. GST · {cost} at cost before GST', { price: money(round2(totals.atPrice)), cost: money(round2(totals.atCost)) })}
            {totals.noCost > 0 && <span className="text-amber-700"> · {tn(totals.noCost, '1 item has no cost price', '{count} items have no cost price')}</span>}
          </div>
          <label className="inline-flex items-center gap-2 text-sm font-semibold text-gray-700">
            <input type="checkbox" checked={onlyProblems} onChange={(e) => { setOnlyProblems(e.target.checked); setPage(0); }} className="rounded" />
            {t('Only rows that need fixing')}
          </label>
          <button type="button" onClick={() => addRows(10)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-bold text-gray-700 hover:bg-gray-50">
            <Plus size={15} /> {t('Add 10 rows')}
          </button>
          {filled.length > 0 && (
            <button type="button" onClick={clearAll} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-gray-200 text-sm font-bold text-red-600 hover:bg-red-50">
              <Trash2 size={15} /> {t('Clear all')}
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[1600px]">
            <thead className="bg-gray-50">
              <tr className="text-xs font-bold text-gray-500 uppercase">
                <th className="px-3 py-3 w-12">#</th>
                <th className="px-2 py-3 w-[22%]">{t('Item name')}</th>
                <th className="px-2 py-3 w-28">{t('HSN code')}</th>
                <th className="px-2 py-3 w-32">{t('Unit')}</th>
                <th className="px-2 py-3 w-24">{t('GST %')}</th>
                <th className="px-2 py-3 w-28">{t('Quantity in stock')}</th>
                <th className="px-2 py-3 w-28">{t('Cost price (before GST)')}</th>
                <th className="px-2 py-3 w-28">{t('Selling price (with GST)')}</th>
                <th className="px-2 py-3">{t('Kannada name (optional)')}</th>
                <th className="px-2 py-3 w-40">{t('Barcode (optional)')}</th>
                <th className="px-2 py-3 w-28">{t('Include in my GST')}</th>
                <th className="px-2 py-3 w-10" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-6 py-14 text-center text-gray-400">
                    {t('Upload the filled template, paste rows from a spreadsheet, or press “Add 10 rows” to type them here.')}
                  </td>
                </tr>
              ) : visible.length === 0 ? (
                <tr>
                  <td colSpan={12} className="px-6 py-10 text-center text-emerald-600 font-semibold">{t('Every row is ready.')}</td>
                </tr>
              ) : (
                visible.map((index) => {
                  const l = lines[index];
                  const check = checked[index];
                  const blank = isBlankRow(l.values);
                  const bad = blank ? new Set<ImportField>() : problemFields(check);
                  const cellClass = (field: ImportField) => cn(inputClass, bad.has(field) ? 'border-red-400 bg-red-50' : 'border-gray-200');
                  const text = (field: ImportField, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
                    <input
                      value={l.values[field]}
                      onChange={(e) => setCell(l.id, field, e.target.value)}
                      onPaste={(e) => pasteIntoCell(e, index, field)}
                      className={cellClass(field)}
                      {...extra}
                    />
                  );
                  const unit = readUnit(l.values.unit);
                  const typedGst = readNumber(l.values.gst.trim().replace(/%$/, ''));
                  // As the checker reads it: a cell formatted as % holds 18% as 0.18.
                  const gst = typedGst != null && typedGst > 0 && typedGst < 1 ? round2(typedGst * 100) : typedGst;
                  const gstKnown = gst != null && (GST_SLABS as readonly number[]).includes(gst);
                  const shownProblems = blank ? [] : check.problems;
                  return (
                    <React.Fragment key={l.id}>
                      <tr className={cn('align-top', !blank && blocking(check).length > 0 && 'bg-red-50/30')}>
                        <td className="px-3 py-2 text-xs text-gray-400 tabular-nums pt-3.5">{index + 1}</td>
                        <td className="px-2 py-2">{text('name', { placeholder: t('e.g. Sugar loose'), className: cn(cellClass('name'), 'min-w-[15rem]') })}</td>
                        <td className="px-2 py-2">
                          {text('hsn_code', {
                            inputMode: 'numeric',
                            onBlur: () => { const fixed = readHsn(l.values.hsn_code); if (fixed !== l.values.hsn_code) setCell(l.id, 'hsn_code', fixed); },
                          })}
                        </td>
                        <td className="px-2 py-2">
                          <select
                            value={unit ?? l.values.unit}
                            onChange={(e) => setCell(l.id, 'unit', e.target.value)}
                            className={cn(cellClass('unit'), 'min-w-[7rem]')}
                          >
                            <option value="">—</option>
                            {UNIT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{unitLabel(option.value)}</option>)}
                            {!unit && l.values.unit && <option value={l.values.unit}>{l.values.unit} ?</option>}
                          </select>
                        </td>
                        <td className="px-2 py-2">
                          <select
                            value={gstKnown ? String(gst) : l.values.gst}
                            onChange={(e) => setCell(l.id, 'gst', e.target.value)}
                            className={cn(cellClass('gst'), 'min-w-[5.5rem]')}
                          >
                            <option value="">—</option>
                            {GST_SLABS.map((slab) => <option key={slab} value={String(slab)}>{slab}%</option>)}
                            {!gstKnown && l.values.gst && <option value={l.values.gst}>{l.values.gst} ?</option>}
                          </select>
                        </td>
                        <td className="px-2 py-2">{text('quantity', { inputMode: 'decimal', className: cn(cellClass('quantity'), 'text-right tabular-nums') })}</td>
                        <td className="px-2 py-2">{text('cost', { inputMode: 'decimal', className: cn(cellClass('cost'), 'text-right tabular-nums') })}</td>
                        <td className="px-2 py-2">{text('price', { inputMode: 'decimal', className: cn(cellClass('price'), 'text-right tabular-nums') })}</td>
                        <td className="px-2 py-2">{text('name_kn', { placeholder: t('Translated if left empty') })}</td>
                        <td className="px-2 py-2">
                          {text('barcode', {
                            spellCheck: false,
                            autoComplete: 'off',
                            className: cn(cellClass('barcode'), 'font-mono min-w-[9rem]'),
                            onBlur: () => { const tidy = normalizeBarcode(l.values.barcode); if (tidy !== l.values.barcode) setCell(l.id, 'barcode', tidy); },
                          })}
                        </td>
                        <td className="px-2 py-2">
                          {/* Empty means Yes: an item is in my GST unless the sheet says no. */}
                          {(() => {
                            const yes = readYesNo(l.values.in_my_gst);
                            return (
                              <select
                                value={yes == null ? l.values.in_my_gst : yes ? 'Yes' : 'No'}
                                onChange={(e) => setCell(l.id, 'in_my_gst', e.target.value)}
                                aria-label={t('Include in my GST')}
                                className={cn(cellClass('in_my_gst'), 'min-w-[5.5rem]')}
                              >
                                <option value="Yes">{t('Yes')}</option>
                                <option value="No">{t('No')}</option>
                                {yes == null && <option value={l.values.in_my_gst}>{l.values.in_my_gst} ?</option>}
                              </select>
                            );
                          })()}
                        </td>
                        <td className="px-2 py-2">
                          <button type="button" onClick={() => removeLine(l.id)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg" title={t('Remove this row')}>
                            <Trash2 size={15} />
                          </button>
                        </td>
                      </tr>
                      {shownProblems.length > 0 && (
                        <tr className="bg-red-50/30">
                          <td />
                          <td colSpan={11} className="px-2 pb-2 -mt-1">
                            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold">
                              {shownProblems.map((problem, i) => (
                                <li key={i} className={problem.warning ? 'text-amber-700' : 'text-red-600'}>
                                  {problem.warning ? '⚠ ' : '✕ '}{problemText(problem)}
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="px-6 py-4 border-t border-gray-100 flex items-center justify-between text-sm">
            <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} className="px-3 py-2 rounded-xl border border-gray-200 font-bold disabled:opacity-40">{t('Previous')}</button>
            <span className="text-gray-600">{t('Page {page} of {pages}', { page: currentPage + 1, pages })}</span>
            <button type="button" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)} className="px-3 py-2 rounded-xl border border-gray-200 font-bold disabled:opacity-40">{t('Next')}</button>
          </div>
        )}
      </div>
    </div>
  );
};
