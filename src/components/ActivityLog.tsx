import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { api } from '../api';
import type { AuditLog } from '../types';
import { formatDateTimeInIST } from '../lib/utils';

const PAGE_SIZE = 200;

/**
 * The audit trail: who changed items, customers, settings, staff accounts and
 * bills. Shown under Settings → Activity log.
 */
export const ActivityLog = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The audit trail is pruned on the server (see AUDIT_LOG_RETENTION_DAYS) and
  // paged here, so this screen does not grow with the table.
  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  useEffect(() => {
    setLoading(true);
    // The server applies the search across every retained row, not just this page.
    api.getAuditLogsPage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, search: appliedSearch || undefined })
      .then((res) => {
        setLogs(res?.data ?? []);
        setTotal(res?.total ?? 0);
        setLoadError('');
      })
      .catch((err: any) => setLoadError(err?.message || 'Could not load the activity log.'))
      .finally(() => setLoading(false));
  }, [page, appliedSearch]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageButton =
    'rounded-xl border border-gray-200 bg-white px-3.5 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-50 disabled:pointer-events-none disabled:opacity-40';

  return (
    <section className="rounded-2xl border border-gray-200 bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <h2 className="text-base font-bold text-gray-900">Activity log</h2>
          <p className="mt-0.5 text-sm text-gray-500">
            Who signed in and who changed items, customers, settings, staff and bills. {total.toLocaleString('en-IN')} entries.
          </p>
        </div>
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by person, action or details"
            className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-3.5 text-sm outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          />
        </div>
      </header>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50 text-xs font-semibold uppercase tracking-wide text-gray-400">
              <th className="px-5 py-3 sm:px-6">Time</th>
              <th className="px-4 py-3">Who</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">On</th>
              <th className="px-4 py-3 sm:pr-6">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr><td colSpan={5} className="px-6 py-12 text-center text-gray-400">Loading…</td></tr>
            ) : loadError ? (
              <tr><td colSpan={5} className="px-6 py-12 text-center text-red-600">{loadError}</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={5} className="px-6 py-12 text-center text-gray-400">No entries found</td></tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="align-top hover:bg-gray-50">
                  <td className="whitespace-nowrap px-5 py-3 text-gray-500 sm:px-6">
                    {formatDateTimeInIST(log.created_at, { second: '2-digit' })}
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-gray-900">{log.user_name}</p>
                    <p className="text-xs capitalize text-gray-500">{log.user_role}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-bold capitalize text-gray-700">{log.action}</span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-gray-600">
                    {log.entity_type}
                    {log.entity_id ? ` #${log.entity_id}` : ''}
                  </td>
                  <td className="min-w-[16rem] px-4 py-3 text-gray-700 sm:pr-6">{log.details}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-5 py-3 sm:px-6">
        <p className="text-sm text-gray-500">
          {total === 0
            ? 'Nothing matches this search'
            : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')}`}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || loading} className={pageButton}>
            Previous
          </button>
          <span className="px-1 text-sm font-semibold text-gray-500">
            {page + 1} / {pageCount.toLocaleString('en-IN')}
          </span>
          <button onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page >= pageCount - 1 || loading} className={pageButton}>
            Next
          </button>
        </div>
      </footer>
    </section>
  );
};
