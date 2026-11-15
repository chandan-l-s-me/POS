import { cn } from '../lib/utils';
import { t } from '../i18n';

/**
 * "Include in my GST" views: all items, only those ticked, or only the rest.
 * A view only — see items.in_my_gst. Used by Reports (sales) and Stock.
 */
export type GstScope = 'all' | 'mine' | 'other';

/** Ticked unless set to 0: items from before the option count as included. */
export const inMyGst = (row: { in_my_gst?: number | boolean | null }) => row.in_my_gst !== 0 && row.in_my_gst !== false;

export const matchesGstScope = (scope: GstScope, row: { in_my_gst?: number | boolean | null }) =>
  scope === 'all' || (scope === 'mine') === inMyGst(row);

/** For file names: '' for all, else in-my-gst- / not-in-my-gst-. */
export const gstScopeFilePart = (scope: GstScope) => (scope === 'mine' ? 'in-my-gst-' : scope === 'other' ? 'not-in-my-gst-' : '');

export const GstScopeSwitch = ({ value, onChange, className }: { value: GstScope; onChange: (scope: GstScope) => void; className?: string }) => (
  <div className={cn('flex flex-wrap gap-1 rounded-2xl bg-gray-100 p-1', className)} role="group" aria-label={t('Which items')}>
    {([
      ['all', t('All items')],
      ['mine', t('In my GST')],
      ['other', t('Not in my GST')],
    ] as Array<[GstScope, string]>).map(([scope, label]) => (
      <button
        key={scope}
        type="button"
        data-gst-scope={scope}
        aria-pressed={value === scope}
        onClick={() => onChange(scope)}
        className={cn(
          'rounded-xl px-4 py-2 text-sm font-bold transition-all',
          value === scope ? 'bg-white text-orange-700 shadow-sm' : 'text-gray-500 hover:text-gray-800'
        )}
      >
        {label}
      </button>
    ))}
  </div>
);
