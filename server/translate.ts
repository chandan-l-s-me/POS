import type Database from 'better-sqlite3';

/**
 * Kannada names for items, from Google Translate.
 *
 * Items are typed and searched in English. For staff who read Kannada more
 * easily, each item also gets a Kannada name (items.name_kn), which the app
 * shows when its language is set to Kannada. A background pass fills in the
 * names that are missing: shortly after the server starts, soon after an item
 * is added or renamed, and every few minutes after that. Bills, stock and
 * search never wait on it, and with no internet the names simply stay English
 * until the next pass gets through.
 *
 * Two ways to reach Google:
 *   - GOOGLE_TRANSLATE_API_KEY set: the Cloud Translation API (billed to that
 *     key's Google Cloud project, official and dependable).
 *   - otherwise: the free endpoint Google's own web widgets use. No key and no
 *     cost, but not a published service: it can be slow, rate-limited or
 *     changed by Google at any time.
 * TRANSLATE_ITEM_NAMES=off turns it off. TRANSLATE_API_BASE points it at a
 * stand-in, for the tests.
 *
 * Customers' names (the person's and the bakery's) are written in Kannada
 * letters too, so "Sri Ganesh Bakery" reads ಶ್ರೀ ಗಣೇಶ್ ಬೇಕರಿ: spelt out, not
 * translated, because a name is a name. That uses Google's transliteration
 * (Google Input Tools), and sends those names, and nothing else about the
 * customer: no phone, address, GSTIN or balance. TRANSLATE_CUSTOMER_NAMES=off
 * keeps customer names on this computer (they then show in English).
 *
 * Only these names are sent: no prices, bills or anything else.
 *
 * In items.name_kn, NULL means "not translated yet"; an admin can type a name
 * in by hand instead (see PUT /api/items/:id), and renaming an item clears an
 * automatic name so it is translated again.
 */

export type Translator = (texts: string[]) => Promise<string[]>;

const TRANSLITERATE_BASE = () => process.env.TRANSLATE_API_BASE || 'https://inputtools.google.com';

const decodeEntities = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** Names spelt in Kannada letters, one request per name, gently. */
export const transliterator: Translator = async (texts) => {
  const out: string[] = [];
  for (const text of texts) {
    const url = `${TRANSLITERATE_BASE()}/request?text=${encodeURIComponent(text)}&itc=kn-t-i0-und&num=1&cp=0&cs=1&ie=utf-8&oe=utf-8`;
    const body = await getJson(url);
    // ["SUCCESS", [["Sri Ganesh", ["ಶ್ರೀ ಗಣೇಶ್"], ...]]]
    if (body?.[0] !== 'SUCCESS') throw new Error('Unexpected answer from Google Input Tools');
    const first = body?.[1]?.[0]?.[1]?.[0];
    out.push(typeof first === 'string' ? decodeEntities(first).trim() : '');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
};

const FREE_BASE = () => process.env.TRANSLATE_API_BASE || 'https://translate.googleapis.com';
const CLOUD_BASE = () => process.env.TRANSLATE_API_BASE || 'https://translation.googleapis.com';
const TIMEOUT_MS = 10_000;

const getJson = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Google Translate answered ${response.status}`);
  return response.json() as Promise<any>;
};

/** One request per name, gently, on the free endpoint. */
const freeTranslator: Translator = async (texts) => {
  const out: string[] = [];
  for (const text of texts) {
    const url = `${FREE_BASE()}/translate_a/single?client=gtx&sl=en&tl=kn&dt=t&q=${encodeURIComponent(text)}`;
    const body = await getJson(url);
    // [[["ಅನುವಾದ", "original", ...], ...], ...]: the sentences, in order.
    const sentences = Array.isArray(body?.[0]) ? body[0] : [];
    out.push(sentences.map((part: any) => (typeof part?.[0] === 'string' ? part[0] : '')).join('').trim());
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return out;
};

const cloudTranslator = (apiKey: string): Translator => async (texts) => {
  const body = await getJson(`${CLOUD_BASE()}/language/translate/v2?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: texts, source: 'en', target: 'kn', format: 'text' }),
  });
  const translations = body?.data?.translations;
  if (!Array.isArray(translations) || translations.length !== texts.length) throw new Error('Unexpected answer from Google Translate');
  return translations.map((entry: any) => String(entry?.translatedText ?? '').trim());
};

export const defaultTranslator = (): Translator => {
  const key = process.env.GOOGLE_TRANSLATE_API_KEY?.trim();
  return key ? cloudTranslator(key) : freeTranslator;
};

export interface TranslationStatus {
  enabled: boolean;
  /** Items still waiting for a Kannada name. */
  pending: number;
  /** Customers whose names are still to be written in Kannada. */
  customers_pending: number;
  /** Why the last pass failed, if it did. Cleared by the next one that works. */
  last_error: string | null;
  last_run_at: string | null;
}

export interface ItemNameTranslation {
  /** Ask for a pass soon: an item was added or renamed. */
  kick: () => void;
  /** A pass now; resolves when it is done. */
  runNow: () => Promise<{ translated: number }>;
  status: () => TranslationStatus;
  stop: () => void;
}

const BATCH = 25;
const SETTLE_MS = 2_000;
const EVERY_MS = 10 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

export const startItemNameTranslation = (
  db: Database.Database,
  options: { translator?: Translator; transliterate?: Translator; enabled?: boolean; customers?: boolean; firstDelayMs?: number } = {}
): ItemNameTranslation => {
  const enabled = options.enabled ?? process.env.TRANSLATE_ITEM_NAMES?.toLowerCase() !== 'off';
  const customersToo = options.customers ?? process.env.TRANSLATE_CUSTOMER_NAMES?.toLowerCase() !== 'off';
  const translator = options.translator ?? defaultTranslator();
  const spellInKannada = options.transliterate ?? transliterator;
  const waitingCustomers = `(name_kn IS NULL AND trim(coalesce(name, '')) <> '')
    OR (shop_name_kn IS NULL AND trim(coalesce(shop_name, '')) <> '')`;
  const customersPending = db.prepare(`SELECT COUNT(*) AS n FROM customers WHERE ${waitingCustomers}`);
  const nextCustomers = db.prepare(`SELECT id, name, shop_name, name_kn, shop_name_kn FROM customers WHERE ${waitingCustomers} ORDER BY id LIMIT ?`);
  // As for items: only if the name is still the one sent, and still empty.
  const saveCustomerName = db.prepare('UPDATE customers SET name_kn = ? WHERE id = ? AND name = ? AND name_kn IS NULL');
  const saveShopName = db.prepare('UPDATE customers SET shop_name_kn = ? WHERE id = ? AND shop_name = ? AND shop_name_kn IS NULL');
  const pendingCount = db.prepare('SELECT COUNT(*) AS n FROM items WHERE name_kn IS NULL');
  const nextBatch = db.prepare('SELECT id, name FROM items WHERE name_kn IS NULL ORDER BY id LIMIT ?');
  // Only if the item still has that name and nobody has filled it in since.
  const save = db.prepare('UPDATE items SET name_kn = ? WHERE id = ? AND name = ? AND name_kn IS NULL');

  let running: Promise<{ translated: number }> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let failures = 0;
  let lastError: string | null = null;
  let lastRunAt: string | null = null;
  let stopped = false;

  const pass = async () => {
    let translated = 0;
    // Keep going while there is work, a batch at a time.
    for (;;) {
      const rows = nextBatch.all(BATCH) as Array<{ id: number; name: string }>;
      if (!rows.length) break;
      const names = await translator(rows.map((row) => row.name));
      db.transaction(() => {
        rows.forEach((row, index) => {
          // An empty answer is stored as '' (tried, nothing usable), so the
          // same name is not asked for again on every pass; the app then
          // shows the English name.
          const result = save.run((names[index] ?? '').slice(0, 200), row.id, row.name);
          translated += result.changes;
        });
      })();
      if (rows.length < BATCH) break;
    }

    if (customersToo) {
      for (;;) {
        const rows = nextCustomers.all(BATCH) as Array<{ id: number; name: string | null; shop_name: string | null; name_kn: string | null; shop_name_kn: string | null }>;
        if (!rows.length) break;
        const wanted = [...new Set(rows.flatMap((row) => [
          row.name_kn == null && row.name?.trim() ? row.name : null,
          row.shop_name_kn == null && row.shop_name?.trim() ? row.shop_name : null,
        ]).filter((text): text is string => Boolean(text)))];
        const spelt = await spellInKannada(wanted);
        const kannadaOf = new Map(wanted.map((text, index) => [text, (spelt[index] ?? '').slice(0, 200)]));
        db.transaction(() => {
          for (const row of rows) {
            if (row.name_kn == null && row.name?.trim()) translated += saveCustomerName.run(kannadaOf.get(row.name) ?? '', row.id, row.name).changes;
            if (row.shop_name_kn == null && row.shop_name?.trim()) translated += saveShopName.run(kannadaOf.get(row.shop_name) ?? '', row.id, row.shop_name).changes;
          }
        })();
        if (rows.length < BATCH) break;
      }
    }
    return { translated };
  };

  const schedule = (delay: number) => {
    if (stopped || !enabled) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void run(), delay);
    timer.unref();
  };

  const run = (): Promise<{ translated: number }> => {
    if (!enabled) return Promise.resolve({ translated: 0 });
    if (running) return running;
    running = pass()
      .then((result) => {
        failures = 0;
        lastError = null;
        return result;
      })
      .catch((err: any) => {
        failures += 1;
        lastError = String(err?.message || err).slice(0, 300);
        console.warn(`[translate] Kannada item names not updated: ${lastError}`);
        return { translated: 0 };
      })
      .finally(() => {
        lastRunAt = new Date().toISOString();
        running = null;
        // Back off while Google is unreachable: 2, 4, 8 ... minutes, up to an hour.
        schedule(failures ? Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** failures) : EVERY_MS);
      });
    return running;
  };

  schedule(options.firstDelayMs ?? 15_000);

  return {
    kick: () => { if (!failures) schedule(SETTLE_MS); },
    runNow: run,
    status: () => ({
      enabled,
      pending: (pendingCount.get() as { n: number }).n,
      customers_pending: customersToo ? (customersPending.get() as { n: number }).n : 0,
      last_error: lastError,
      last_run_at: lastRunAt,
    }),
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
};
