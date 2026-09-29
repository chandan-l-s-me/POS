/**
 * Main-thread handle onto the read-only query workers (see read-worker.mjs).
 *
 * Use these for anything that scans a lot of rows — analytics, reports, list
 * counts. Small, indexed lookups (a single bill, the settings row) are cheaper
 * to run inline than to round-trip through a thread.
 */
import path from 'path';
import { Worker } from 'worker_threads';

const WORKER_PATH = path.join(import.meta.dirname ?? __dirname, 'read-worker.mjs');
// Must resolve to the same file as db/index.ts, including the DB_PATH override.
const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(process.cwd(), 'pos.db');
// Two is plenty for a single shop: it lets a report and the dashboard overlap
// without spawning a thread per request.
const POOL_SIZE = 2;

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };

class ReadPool {
  private workers: Worker[] = [];
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private cursor = 0;

  private spawn(index: number) {
    const worker = new Worker(WORKER_PATH, { workerData: { dbPath: DB_PATH } });
    worker.on('message', (msg: any) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.json !== undefined ? msg.json : msg.result);
      else entry.reject(new Error(msg.error));
    });
    worker.on('error', (err) => {
      console.error('[read-worker] crashed, respawning:', err.message);
      for (const [id, entry] of this.pending) { entry.reject(err); this.pending.delete(id); }
      this.spawn(index);
    });
    worker.unref();
    this.workers[index] = worker;
  }

  private ensure() {
    if (this.workers.length === 0) {
      for (let i = 0; i < POOL_SIZE; i++) this.spawn(i);
    }
  }

  private send(sql: string, params: any[], mode: 'all' | 'get' | 'json', envelope?: any) {
    this.ensure();
    const id = this.nextId++;
    const worker = this.workers[this.cursor++ % this.workers.length];
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, sql, params, mode, envelope });
    });
  }

  /** Rows as objects. Fine for small/medium results. */
  all(sql: string, params: any[] = []): Promise<any[]> { return this.send(sql, params, 'all'); }
  /** A single row. */
  get(sql: string, params: any[] = []): Promise<any> { return this.send(sql, params, 'get'); }
  /**
   * A ready-made JSON string of `{ data: rows, ...envelope }`. Use for large
   * result sets — the main thread never materialises the rows at all.
   */
  json(sql: string, params: any[] = [], envelope?: Record<string, unknown>): Promise<string> {
    return this.send(sql, params, 'json', envelope);
  }

  close() { this.workers.forEach((w) => w.terminate()); this.workers = []; }
}

export const readPool = new ReadPool();
