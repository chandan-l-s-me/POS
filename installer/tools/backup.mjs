// A consistent copy of the live database, safe while the server is running,
// checked before it is trusted. Used by Update Vyapara.bat before it touches
// anything.
//   node tools/backup.mjs <database> <copy to>
import { createRequire } from 'node:module';

const Database = createRequire(import.meta.url)('better-sqlite3');
const [source, target] = process.argv.slice(2);
if (!source || !target) {
  console.error('usage: node tools/backup.mjs <database> <copy to>');
  process.exit(2);
}

const db = new Database(source, { readonly: true, fileMustExist: true });
await db.backup(target);
db.close();

const copy = new Database(target, { readonly: true });
const check = copy.pragma('integrity_check', { simple: true });
const bills = copy.prepare('SELECT COUNT(*) AS n FROM bills').get().n;
copy.close();
if (check !== 'ok') {
  console.error(`backup failed its integrity check: ${check}`);
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, target, bills }));
