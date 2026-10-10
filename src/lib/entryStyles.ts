/**
 * The look shared by Purchase Entry and Billing Entry, so the two screens read
 * as one: the same fields, the same table heading, the same row boxes.
 *
 * These are plain gray/orange Tailwind classes on purpose — index.css maps them
 * onto the app's theme, dark mode included.
 */

/** A field above the table: supplier, customer, item search. */
export const FORM_FIELD =
  'w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-2xl focus:ring-2 focus:ring-orange-500 outline-none';

export const FORM_LABEL = 'text-sm font-semibold text-gray-700';

/** A box in a table row — input, select or read-only value — all one height. */
export const ROW_FIELD =
  'block w-full h-9 px-2 bg-gray-50 border border-gray-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-orange-500';

/** The heading row of an entry table. */
export const TABLE_HEAD_ROW = 'align-bottom text-[11px] font-bold uppercase tracking-wide text-gray-500';

/** The small second line under a column heading, e.g. "incl. GST". */
export const HEADER_NOTE = 'block font-medium normal-case tracking-normal text-gray-400';
