import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const IST_TIME_ZONE = 'Asia/Kolkata';

export function formatDateInIST(value: string | number | Date, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...options,
  }).format(new Date(value));
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
  }).format(new Date(value));
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
  }).formatToParts(new Date(value));

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
  }).formatToParts(new Date(value));

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
