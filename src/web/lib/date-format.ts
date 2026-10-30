import { useSyncExternalStore } from 'react';
import type { HourCycle, Preferences } from '../../shared/contracts';
import {
  clockOptions,
  formattingLocale,
  localeRegion,
  timeZoneRegion,
} from '../../shared/date-locale';

export interface DateFormat {
  locale: string;
  hourCycle: HourCycle;
  timeZone: string;
}

export const regions = [
  'GB',
  'US',
  'IE',
  'CA',
  'AU',
  'NZ',
  'IN',
  'ZA',
  'PT',
  'BR',
  'ES',
  'MX',
  'AR',
  'FR',
  'BE',
  'CH',
  'DE',
  'AT',
  'IT',
  'NL',
  'SE',
  'DK',
  'NO',
  'FI',
  'PL',
  'CZ',
  'RO',
  'HU',
  'GR',
  'TR',
  'UA',
  'IL',
  'JP',
  'KR',
  'CN',
  'TW',
];

const browserRegions = new Map<string, string | null>();

function browserRegion() {
  const region = browserRegions.get(Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (region) return region;
  const languages =
    typeof navigator === 'undefined' ? [] : [...navigator.languages, navigator.language];
  return languages.map(localeRegion).find(Boolean) ?? 'GB';
}

export function regionLocale(region: string) {
  return `en-${region}`;
}

function savedFormattingLocale(saved: string | null | undefined) {
  return formattingLocale(localeRegion(saved) ?? browserRegion());
}

function validTimeZone(value: string | null | undefined) {
  if (!value) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

let current: DateFormat = {
  locale: savedFormattingLocale(null),
  hourCycle: 'auto',
  timeZone: validTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC',
};
const listeners = new Set<() => void>();

export function resolveBrowserRegion() {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!browserRegions.has(timeZone)) browserRegions.set(timeZone, timeZoneRegion(timeZone));
  for (const listener of listeners) listener();
}

export function dateFormatFrom(
  preferences: Pick<Preferences, 'locale' | 'hourCycle' | 'timeZone'>,
): DateFormat {
  return {
    locale: savedFormattingLocale(preferences.locale),
    hourCycle: preferences.hourCycle ?? 'auto',
    timeZone: validTimeZone(preferences.timeZone) ?? current.timeZone,
  };
}

export function setDateFormat(preferences: Pick<Preferences, 'locale' | 'hourCycle' | 'timeZone'>) {
  const next = dateFormatFrom(preferences);
  if (
    next.locale === current.locale &&
    next.hourCycle === current.hourCycle &&
    next.timeZone === current.timeZone
  )
    return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDateFormat() {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
}

export function useBrowserRegion() {
  return useSyncExternalStore(subscribe, browserRegion, browserRegion);
}

export function formatNumber(
  value: number,
  options: Intl.NumberFormatOptions = {},
  format = current,
) {
  const key = JSON.stringify([format.locale, options]);
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(format.locale, options);
    numberFormatters.set(key, formatter);
  }
  return formatter.format(value);
}

const numberFormatters = new Map<string, Intl.NumberFormat>();
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(format: DateFormat, options: Intl.DateTimeFormatOptions, timeZone?: string) {
  const key = JSON.stringify([format, options, timeZone]);
  let value = formatters.get(key);
  if (!value) {
    value = new Intl.DateTimeFormat(format.locale, {
      ...options,
      timeZone: timeZone ?? format.timeZone,
      ...((options.hour || options.timeStyle) && format.hourCycle !== 'auto'
        ? { hourCycle: format.hourCycle }
        : {}),
    });
    formatters.set(key, value);
  }
  return value;
}

function date(value: string | number | Date) {
  return value instanceof Date ? value : new Date(value);
}

function capitalized(value: string, locale: string) {
  return value.charAt(0).toLocaleUpperCase(locale) + value.slice(1);
}

export function dayKey(value: string | number | Date, format: DateFormat) {
  return formatter(
    { ...format, locale: 'en-CA' },
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    },
  ).format(date(value));
}

function sameYear(value: string | number | Date, format: DateFormat, now: Date) {
  return dayKey(value, format).slice(0, 4) === dayKey(now, format).slice(0, 4);
}

function clock(format: DateFormat) {
  return clockOptions(format.locale, format.hourCycle);
}

export function formatTime(
  value: string | number | Date,
  format = current,
  options: { seconds?: boolean } = {},
) {
  return formatter(
    format,
    options.seconds ? { ...clock(format), second: '2-digit' } : clock(format),
  ).format(date(value));
}

export function formatClockTime(value: string, format = current) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return value;
  return formatter(format, clock(format), 'UTC').format(
    Date.UTC(2000, 0, 1, Number(match[1]), Number(match[2])),
  );
}

export function formatCalendarDate(value: string, format = current) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  return formatter(format, { day: 'numeric', month: 'short', year: 'numeric' }, 'UTC').format(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
  );
}

export function formatDateTime(
  value: string | number | Date,
  format = current,
  options: { timeZone?: string; weekday?: boolean; now?: Date } = {},
) {
  const zoned = options.timeZone ? { ...format, timeZone: options.timeZone } : format;
  return formatter(
    zoned,
    {
      ...(options.weekday ? { weekday: 'short' } : {}),
      day: 'numeric',
      month: 'short',
      ...(sameYear(value, zoned, options.now ?? new Date()) ? {} : { year: 'numeric' }),
      ...clock(zoned),
    },
    options.timeZone,
  ).format(date(value));
}

export function formatFullDateTime(value: string | number | Date, format = current) {
  return formatter(format, { dateStyle: 'full', timeStyle: 'short' }).format(date(value));
}

export function isSameDay(
  first: string | number | Date,
  second: string | number | Date,
  format = current,
) {
  return dayKey(first, format) === dayKey(second, format);
}

export function formatDayLabel(value: string | number | Date, format = current, now = new Date()) {
  const days = Math.round(
    (Date.parse(dayKey(now, format)) - Date.parse(dayKey(value, format))) / 86_400_000,
  );
  if (days === 0 || days === 1)
    return capitalized(
      new Intl.RelativeTimeFormat(format.locale, { numeric: 'auto' }).format(-days, 'day'),
      format.locale,
    );
  if (days > 1 && days < 7)
    return capitalized(formatter(format, { weekday: 'long' }).format(date(value)), format.locale);
  return formatter(format, {
    day: 'numeric',
    month: 'long',
    ...(sameYear(value, format, now) ? {} : { year: 'numeric' }),
  }).format(date(value));
}
