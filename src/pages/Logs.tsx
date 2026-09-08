import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { AuditLog } from '../types';
import { Search, Shield, Activity } from 'lucide-react';
import { formatDateTimeInIST } from '../lib/utils';

export const Logs = () => {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getAuditLogs({ limit: 500 })
      .then((data) => setLogs(Array.isArray(data) ? data : []))
      .catch((err: any) => {
        alert(`Failed to load logs: ${err.message}`);
      })
      .finally(() => setLoading(false));
  }, []);

  const filteredLogs = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return logs;

    return logs.filter((log) =>
      log.user_name.toLowerCase().includes(query) ||
      log.user_role.toLowerCase().includes(query) ||
      log.action.toLowerCase().includes(query) ||
      log.entity_type.toLowerCase().includes(query) ||
      log.details.toLowerCase().includes(query)
    );
  }, [logs, search]);

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
          {filteredLogs.length} records
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
      </div>
    </div>
  );
};
