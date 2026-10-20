import { Calendar, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { formatDay } from '../lib/supplierPayments';

/**
 * The "Filter by Date" button and the From / To panel it opens, shared by the
 * history and report pages. The button names the range once one is set, so
 * it is clear what the page is showing with the panel closed.
 */
export const DateFilterButton = ({ from, to, open, onClick }: {
  from: string;
  to: string;
  open: boolean;
  onClick: () => void;
}) => {
  const active = Boolean(from || to);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      className={cn(
        'flex items-center gap-2 px-4 py-3 bg-white border text-gray-600 font-bold rounded-2xl transition-all whitespace-nowrap',
        active ? 'border-orange-300 text-orange-700 bg-orange-50' : open ? 'border-gray-300 bg-gray-50' : 'border-gray-200 hover:bg-gray-50'
      )}
    >
      <Calendar size={20} />
      {active ? `${from ? formatDay(from) : 'Start'} – ${to ? formatDay(to) : 'Today'}` : 'Filter by Date'}
    </button>
  );
};

export const DateFilterPanel = ({ from, to, onFromChange, onToChange, description }: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  description?: string;
}) => (
  <div className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
    <div className="flex items-center justify-between gap-4 mb-4">
      <div>
        <h2 className="text-lg font-bold text-gray-900">Filter By Date</h2>
        {description && <p className="text-sm text-gray-500">{description}</p>}
      </div>
      {(from || to) && (
        <button
          type="button"
          onClick={() => { onFromChange(''); onToChange(''); }}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-2xl bg-gray-100 text-gray-700 font-semibold hover:bg-gray-200 transition-all"
        >
          <X size={16} /> Clear Filter
        </button>
      )}
    </div>
    <div className="grid gap-4 md:grid-cols-2">
      <label className="space-y-2">
        <span className="text-sm font-semibold text-gray-700">From Date</span>
        <input
          type="date"
          value={from}
          max={to || undefined}
          onChange={(e) => onFromChange(e.target.value)}
          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
        />
      </label>
      <label className="space-y-2">
        <span className="text-sm font-semibold text-gray-700">To Date</span>
        <input
          type="date"
          value={to}
          min={from || undefined}
          onChange={(e) => onToChange(e.target.value)}
          className="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none"
        />
      </label>
    </div>
  </div>
);
