import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const IST_TIME_ZONE = 'Asia/Kolkata';

/**
 * SQLite writes CURRENT_TIMESTAMP as "YYYY-MM-DD HH:MM:SS" in **UTC**, with no
 * timezone marker. That string is not valid ISO-8601 (ISO needs a "T"), so
 * `new Date(value)` falls back to implementation-specific parsing and every
 * major browser reads it as *local* time. On an IST machine that made the app
 * render the UTC clock reading as though it were already IST — every date and
 * time in the UI was 5 hours 30 minutes behind the real one.
 *
 * Normalising to "YYYY-MM-DDTHH:MM:SSZ" pins it to UTC so the Intl formatters
 * below can convert it to IST correctly.
 */
const SQLITE_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

function toDate(value: string | number | Date): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && SQLITE_DATETIME.test(value.trim())) {
    return new Date(`${value.trim().replace(' ', 'T')}Z`);
  }
  return new Date(value);
}

export function formatDateInIST(value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...options,
  }).format(toDate(value));
}

export function formatDateTimeInIST(value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...options,
  }).format(toDate(value));
}

export function formatDateTimeCompactInIST(value: string | number | Date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(toDate(value));

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

export function formatISTDateKeyLabel(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
  }).format(date);
}

export function getISTDateKey(value: string | number | Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(toDate(value));

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function getISTTimestampForFileName() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const get = (type: string) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}-${get('hour')}-${get('minute')}`;
}
