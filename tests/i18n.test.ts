/**
 * The Kannada screens: every English text the app looks up has a Kannada
 * entry with the same {placeholders}, server messages are matched and
 * translated, and printed or exported text stays English.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { kn } from '../src/i18n/kn.ts';
import { itemKannada, itemLabel, t, tn, unitLabel, useItemNamesStore, useLanguageStore, withEnglish } from '../src/i18n/index.ts';
import { SERVER_MESSAGES, translateServerMessage } from '../src/i18n/serverMessages.ts';
import { formatDateInIST } from '../src/lib/utils.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every literal passed to t(), tn() or tRich() under src/. */
const lookedUp = () => {
  const keys = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).isDirectory()) { walk(file); continue; }
      if (!/\.tsx?$/.test(name) || file.endsWith(`${path.sep}kn.ts`)) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(source);
          const args = callee === 'tn' ? node.arguments.slice(1, 3) : callee === 't' || callee === 'tRich' ? node.arguments.slice(0, 1) : [];
          for (const arg of args) {
            if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) keys.set(arg.text, path.relative(ROOT, file));
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  };
  walk(path.join(ROOT, 'src'));
  return keys;
};

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

const setLanguage = (lang: 'en' | 'kn') => useLanguageStore.setState({ lang });

afterEach(() => {
  setLanguage('en');
  useItemNamesStore.setState({ names: {} });
});

describe('Kannada dictionary', () => {
  it('has an entry for every text the screens look up', () => {
    const missing = [...lookedUp()].filter(([key]) => !(key in kn)).map(([key, file]) => `${file}: ${key}`);
    assert.deepEqual(missing, [], `no Kannada for:\n${missing.join('\n')}`);
  });

  it('has an entry for every server message', () => {
    assert.deepEqual(SERVER_MESSAGES.filter((message) => !(message in kn)), []);
  });

  it('keeps each entry’s {placeholders}', () => {
    const wrong = Object.entries(kn).filter(([en, k]) => placeholders(en).join() !== placeholders(k).join());
    assert.deepEqual(wrong, []);
  });

  it('is written in Kannada', () => {
    // Codes and names stay as they are (GSTIN, UPI, CSV …); everything else
    // should contain Kannada letters.
    const english = Object.entries(kn).filter(([en, k]) => !/[ಀ-೿]/.test(k) && /[a-z]{3}/.test(en.replace(/\{\w+\}/g, '')));
    assert.deepEqual(english.map(([en]) => en), ['Google Drive']);
  });
});

describe('t()', () => {
  it('shows English, with the values filled in', () => {
    assert.equal(t('{count} items', { count: 3 }), '3 items');
    assert.equal(tn(1, '1 item', '{count} items'), '1 item');
    assert.equal(tn(4, '1 item', '{count} items'), '4 items');
  });

  it('shows Kannada when the screen is in Kannada', () => {
    setLanguage('kn');
    assert.equal(t('Save'), 'ಉಳಿಸಿ');
    assert.equal(t('{count} items', { count: 3 }), '3 ಐಟಂಗಳು');
    assert.equal(unitLabel('kg'), 'ಕೆಜಿ');
  });

  it('falls back to English for text with no entry', () => {
    setLanguage('kn');
    assert.equal(t('Some text nobody translated'), 'Some text nobody translated');
  });

  it('shows item names in Kannada and English, and English where there is no Kannada', () => {
    setLanguage('kn');
    useItemNamesStore.setState({ names: { 'Sugar 1kg': 'ಸಕ್ಕರೆ 1 ಕೆಜಿ' } });
    assert.equal(itemLabel('Sugar 1kg'), 'ಸಕ್ಕರೆ 1 ಕೆಜಿ (Sugar 1kg)');
    assert.equal(itemKannada('Sugar 1kg'), 'ಸಕ್ಕರೆ 1 ಕೆಜಿ');
    assert.equal(itemKannada('Cardamom'), null);
    assert.equal(itemLabel('Cardamom'), 'Cardamom');
    setLanguage('en');
    assert.equal(itemLabel('Sugar 1kg'), 'Sugar 1kg');
  });

  it('stays in English inside withEnglish, for exports', () => {
    setLanguage('kn');
    useItemNamesStore.setState({ names: { 'Sugar 1kg': 'ಸಕ್ಕರೆ 1 ಕೆಜಿ' } });
    assert.deepEqual(withEnglish(() => [t('Save'), itemLabel('Sugar 1kg'), formatDateInIST('2026-11-03 04:30:00')]), ['Save', 'Sugar 1kg', '03 Nov 2026']);
    assert.equal(t('Save'), 'ಉಳಿಸಿ', 'and back to Kannada after');
  });

  it('dates show Kannada months on screen, English on a bill', () => {
    setLanguage('kn');
    assert.match(formatDateInIST('2026-11-03 04:30:00'), /ನವೆಂ/);
    assert.equal(formatDateInIST('2026-11-03 04:30:00', undefined, 'en-GB'), '03 Nov 2026');
  });
});

describe('server messages', () => {
  it('match what server.ts sends', () => {
    // A template's fixed parts must all appear in server.ts, so a reworded
    // server message is noticed here rather than showing in English.
    // Long messages are split over lines ('…' +\n '…'): join them back up.
    const server = fs.readFileSync(path.join(ROOT, 'server.ts'), 'utf8').replace(/[`'"]\s*\+\s*[`'"]/g, '');
    // A bare 401/403 is its status text; the supplier overpayment picks its
    // ending (" on this purchase" / " to this supplier") with a ternary.
    const notLiteral = new Set(['Unauthorized', 'Forbidden', '₹{amount} is more than the ₹{owed} owed on this purchase.', '₹{amount} is more than the ₹{owed} owed to this supplier.']);
    assert.ok(server.includes("owed${params.purchaseId ? ' on this purchase' : ' to this supplier'}."));
    const drifted = SERVER_MESSAGES.filter((template) => {
      if (notLiteral.has(template)) return false;
      return template.split(/\{\w+\}/).filter((part) => part.trim().length > 3).some((part) => !server.includes(part));
    });
    assert.deepEqual(drifted, []);
  });

  it('are shown in Kannada, values and field names included', () => {
    setLanguage('kn');
    useItemNamesStore.setState({ names: { 'Sugar 1kg': 'ಸಕ್ಕರೆ 1 ಕೆಜಿ' } });
    assert.equal(translateServerMessage('Phone is required'), 'ಫೋನ್ ಬೇಕು');
    assert.equal(translateServerMessage('Bill not found'), 'ಬಿಲ್ ಸಿಗಲಿಲ್ಲ');
    assert.equal(
      translateServerMessage('Insufficient stock for Sugar 1kg: requested 5, only 2 available'),
      'ಸಕ್ಕರೆ 1 ಕೆಜಿ (Sugar 1kg) ಸ್ಟಾಕ್ ಸಾಲದು: 5 ಕೇಳಿದ್ದೀರಿ, 2 ಮಾತ್ರ ಇದೆ'
    );
    assert.equal(translateServerMessage('Password must be at least 10 characters'), 'ಪಾಸ್‌ವರ್ಡ್ ಕನಿಷ್ಠ 10 ಅಕ್ಷರಗಳಿರಬೇಕು');
  });

  it('pass through unchanged when unknown, or on an English screen', () => {
    setLanguage('kn');
    assert.equal(translateServerMessage('Something brand new happened'), 'Something brand new happened');
    setLanguage('en');
    assert.equal(translateServerMessage('Phone is required'), 'Phone is required');
  });
});
