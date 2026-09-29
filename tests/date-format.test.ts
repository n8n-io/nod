import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dateFormatFrom,
  formatCalendarDate,
  formatClockTime,
  formatDateTime,
  formatDayLabel,
  formatNumber,
  formatRelativeTime,
  formatTime,
  isSameDay,
  type DateFormat,
} from '../src/web/lib/date-format.ts';
import { messagesAreGrouped } from '../src/web/lib/chat-messages.ts';
import type { Message } from '../src/shared/contracts.ts';

const now = new Date('2026-09-29T15:00:00Z');
const sent = '2026-09-29T13:05:00Z';
const format = (locale: string, hourCycle: DateFormat['hourCycle'] = 'auto'): DateFormat =>
  dateFormatFrom({ locale, hourCycle, timeZone: 'Europe/Lisbon' });

test('the region sets English date order, clock default and numbers without mixing languages', () => {
  assert.equal(format('pt-PT').locale, 'en-PT');
  assert.equal(format('de').locale, 'en-DE');
  assert.equal(format('pt-BR').locale, 'en-GB');
  assert.equal(format('not a region').locale, format('en').locale);
  for (const [locale, hourCycle, time] of [
    ['en-GB', 'auto', '14:05'],
    ['en-GB', 'h12', '2:05 pm'],
    ['en-US', 'auto', '2:05 PM'],
    ['en-US', 'h23', '14:05'],
    ['pt-PT', 'auto', '14:05'],
    ['pt-PT', 'h12', '2:05 pm'],
  ] as const)
    assert.equal(formatTime(sent, format(locale, hourCycle)), time, `${locale} ${hourCycle}`);
  assert.equal(formatClockTime('09:05', format('en-GB')), '09:05');
  assert.equal(formatClockTime('21:30', format('en-US')), '9:30 PM');
  assert.equal(formatTime(sent, format('en-GB'), { seconds: true }), '14:05:00');
  assert.equal(formatNumber(1234.5, {}, format('de-DE')), '1.234,5');
  assert.equal(formatNumber(1234.5, {}, format('en-US')), '1,234.5');
});

test('dates use the region order in English and the saved time zone', () => {
  assert.equal(formatDateTime(sent, format('en-GB'), { weekday: true, now }), 'Tue 29 Sept, 14:05');
  assert.equal(
    formatDateTime(sent, format('en-US'), { weekday: true, now }),
    'Tue, Sep 29, 2:05 PM',
  );
  assert.equal(
    formatDateTime(sent, format('pt-PT'), { weekday: true, now }),
    'Tue, 29 Sept, 14:05',
  );
  assert.equal(
    formatDateTime(sent, format('en-GB'), { timeZone: 'Asia/Tokyo', now }),
    '29 Sept, 22:05',
  );
  assert.equal(
    formatDateTime('2025-03-01T10:00:00Z', format('en-GB'), { now }),
    '1 Mar 2025, 10:00',
  );
  assert.equal(formatCalendarDate('2026-10-01', format('en-US')), 'Oct 1, 2026');
  assert.equal(formatCalendarDate('2026-10-01', format('de-DE')), '1 Oct 2026');
});

test('day labels and grouping use English words and the calendar day of the saved time zone', () => {
  assert.equal(formatDayLabel(sent, format('en-GB'), now), 'Today');
  assert.equal(formatDayLabel('2026-09-28T10:00:00Z', format('en-GB'), now), 'Yesterday');
  assert.equal(formatDayLabel('2026-09-28T10:00:00Z', format('pt-PT'), now), 'Yesterday');
  assert.equal(formatDayLabel('2026-09-25T10:00:00Z', format('pt-PT'), now), 'Friday');
  assert.equal(formatDayLabel('2026-09-01T10:00:00Z', format('en-GB'), now), '1 September');
  assert.equal(formatDayLabel('2025-01-02T10:00:00Z', format('en-US'), now), 'January 2, 2025');
  const lateEvening = '2026-09-28T23:30:00Z';
  const tokyo = { ...format('en-GB'), timeZone: 'Asia/Tokyo' };
  assert.equal(formatDayLabel(lateEvening, format('en-GB'), now), 'Today');
  assert.equal(isSameDay(lateEvening, '2026-09-28T22:30:00Z', format('en-GB')), false);
  assert.equal(isSameDay(lateEvening, '2026-09-28T22:30:00Z', tokyo), true);
  const message = (id: string, createdAt: string): Message =>
    ({ id, role: 'user', text: id, createdAt, attachments: [] }) as unknown as Message;
  assert.equal(
    messagesAreGrouped(
      message('a', '2026-09-28T22:58:00Z'),
      message('b', '2026-09-28T23:01:00Z'),
      format('en-GB'),
    ),
    false,
  );
  assert.equal(
    messagesAreGrouped(
      message('a', '2026-09-28T22:58:00Z'),
      message('b', '2026-09-28T23:01:00Z'),
      tokyo,
    ),
    true,
  );
});

test('relative times use the region language', () => {
  assert.equal(formatRelativeTime(now, format('en-GB'), now), 'Now');
  assert.equal(formatRelativeTime('2026-09-29T14:55:00Z', format('en-GB'), now), '5 min ago');
  assert.equal(formatRelativeTime('2026-09-29T12:00:00Z', format('pt-PT'), now), '3 hr ago');
  assert.equal(formatRelativeTime('2026-09-20T12:00:00Z', format('en-GB'), now), '20 Sept');
});

test('saved preferences keep a valid time zone', () => {
  assert.deepEqual(dateFormatFrom({ locale: 'pt-pt', hourCycle: 'h23', timeZone: 'Asia/Tokyo' }), {
    locale: 'en-PT',
    hourCycle: 'h23',
    timeZone: 'Asia/Tokyo',
  });
  assert.notEqual(
    dateFormatFrom({ locale: 'en-GB', hourCycle: 'auto', timeZone: 'Nowhere' }).timeZone,
    'Nowhere',
  );
});
