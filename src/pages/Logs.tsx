import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { AuditLog } from '../types';
import { Search, Shield, Activity } from 'lucide-react';
import { formatDateTimeInIST } from '../lib/utils';

const PAGE_SIZE = 200;

export const Logs = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  // The audit trail is pruned on the server (see AUDIT_LOG_RETENTION_DAYS) and
  // paged here, so this screen no longer grows with the table.
  useEffect(() => {
    const handle = setTimeout(() => { setAppliedSearch(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  // `page` was in state but nothing ever changed it and no controls were
  // rendered, so only the newest 200 entries were reachable — on an audit trail
  // kept for 400 days, the rest of the record was simply unreadable.
  useEffect(() => {
    setLoading(true);
    // getAuditLogs unwraps to a bare array, which threw the row count away and
    // left the header showing the page size instead of the real total.
    api.getAuditLogsPage({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, search: appliedSearch || undefined })
      .then((res) => {
        setLogs(res?.data ?? []);
        setTotal(res?.total ?? 0);
        setLoadError('');
      })
      .catch((err: any) => setLoadError(err?.message || 'Failed to load logs.'))
      .finally(() => setLoading(false));
  }, [page, appliedSearch]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // The server already applied the search across all retained rows, not just
  // the page held in memory.
  const filteredLogs = logs;

  return (
    <div className="space-y-6">
      <div className="bg-white p-8 rounded-3xl shadow-sm border border-gray-100">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] uppercase text-sky-700">Audit Trail</p>
            <h1 className="mt-2 text-3xl font-bold text-gray-900">System Activity Logs</h1>
            <p className="mt-3 text-gray-500 max-w-2xl">
              Track who changed items, customers, shop settings, cashier accounts, and billing records.
            </p>
          </div>
          <div className="hidden sm:flex items-center gap-3 px-4 py-3 rounded-2xl bg-sky-50 text-sky-700">
            <Shield size={20} />
            <span className="font-semibold">Admin Only</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search logs by user, action, or details..."
            className="w-full pl-12 pr-4 py-3 bg-white border border-gray-200 rounded-2xl focus:ring-2 focus:ring-sky-500 outline-none shadow-sm"
          />
        </div>
        <div className="flex items-center gap-2 px-4 py-3 bg-white border border-gray-200 rounded-2xl text-gray-600 font-semibold whitespace-nowrap">
          <Activity size={18} />
          {total.toLocaleString('en-IN')} records
        </div>
      </div>

      <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-left">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-100">
              <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Time</th>
              <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">User</th>
              <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Action</th>
              <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Entity</th>
              <th className="px-6 py-4 text-xs font-bold text-gray-400 uppercase tracking-wider">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-gray-400">Loading logs...</td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-red-500">{loadError}</td>
              </tr>
            ) : filteredLogs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-6 py-12 text-center text-gray-400">No logs found</td>
              </tr>
            ) : (
              filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 text-sm text-gray-500 whitespace-nowrap">
                    {formatDateTimeInIST(log.created_at, { second: '2-digit' })}
                  </td>
                  <td className="px-6 py-4">
                    <p className="font-semibold text-gray-900">{log.user_name}</p>
                    <p className="text-xs text-gray-500 uppercase">{log.user_role}</p>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-[10px] font-black uppercase px-2 py-1 bg-sky-100 rounded-full text-sky-700">
                      {log.action}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">
                    {log.entity_type}
                    {log.entity_id ? ` #${log.entity_id}` : ''}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-700">{log.details}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
          <p className="text-sm text-gray-500">
            {total === 0
              ? 'No log entries match this filter'
              : `Showing ${page * PAGE_SIZE + 1}\u2013${Math.min((page + 1) * PAGE_SIZE, total)} of ${total.toLocaleString('en-IN')}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={page === 0 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Previous
            </button>
            <span className="px-2 text-sm font-semibold text-gray-500">
              Page {page + 1} of {pageCount.toLocaleString('en-IN')}
            </span>
            <button
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              disabled={page >= pageCount - 1 || loading}
              className="rounded-xl border border-gray-200 px-4 py-2 text-sm font-bold text-gray-600 transition-all hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
