/**
 * Read-only query worker.
 *
 * better-sqlite3 is synchronous, so every query runs on whichever thread calls
 * it. On the main thread that means a slow query blocks Node's event loop and
 * no other request is served. Measured on a 1.27M-bill database:
 *
 *   GET /api/settings, server idle            0.6 ms
 *   GET /api/settings, while Dashboard loads  5785 ms
 *   POST /api/bills,   while a report runs     647 ms
 *
 * Heavy analytical reads run here instead. WAL mode lets this connection read
 * concurrently with writes on the main thread, so billing keeps working at
 * full speed while a report or the dashboard is being built.
 *
 * The worker also does the JSON.stringify for large result sets and hands back
 * a finished string, so neither the query nor the serialisation touches the
 * main thread — it only pipes the string to the response.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const db = new Database(workerData.dbPath, { readonly: true });
db.pragma('busy_timeout = 5000');
// A larger page cache pays for itself on the aggregate queries.
db.pragma('cache_size = -32000');

parentPort.on('message', (msg) => {
  const { id, sql, params = [], mode = 'all', envelope } = msg;
  try {
    const stmt = db.prepare(sql);
    if (mode === 'get') {
      parentPort.postMessage({ id, ok: true, result: stmt.get(...params) });
      return;
    }
    const rows = stmt.all(...params);
    if (mode === 'json') {
      // Serialise here so the main thread never walks the row array.
      parentPort.postMessage({ id, ok: true, json: JSON.stringify({ data: rows, ...(envelope || {}) }) });
      return;
    }
    parentPort.postMessage({ id, ok: true, result: rows });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
  }
});
