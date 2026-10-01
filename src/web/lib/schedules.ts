import { formatClockTime, formatDateTime, type DateFormat } from './date-format';

export type ScheduleFrequency = 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'custom';
export const scheduleWeekDays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function readSchedule(cron: string) {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+(\*|\d{1,2})\s+\*\s+(\*|1-5|0,6|6,0|6-7|[0-7])$/.exec(
    cron.trim(),
  );
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    return { frequency: 'custom' as ScheduleFrequency, time: '09:00', day: '1' };
  const [, minute, hour, date, weekday] = match;
  const frequency: ScheduleFrequency =
    date !== '*'
      ? weekday === '*' && Number(date) >= 1 && Number(date) <= 31
        ? 'monthly'
        : 'custom'
      : weekday === '*'
        ? 'daily'
        : weekday === '1-5'
          ? 'weekdays'
          : ['0,6', '6,0', '6-7'].includes(weekday)
            ? 'weekends'
            : 'weekly';
  return {
    frequency,
    time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
    day:
      frequency === 'monthly'
        ? String(Number(date))
        : frequency === 'weekly'
          ? String(Number(weekday) % 7)
          : '1',
  };
}

export function scheduleExpression(
  frequency: ScheduleFrequency,
  time: string,
  day: string,
  original?: string,
) {
  if (frequency === 'custom') {
    if (original) return original;
    throw new Error('Choose how often this schedule repeats.');
  }
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error('Choose a valid time.');
  if (frequency === 'weekly' && !/^[0-6]$/.test(day)) throw new Error('Choose a day of the week.');
  if (frequency === 'monthly' && !/^([1-9]|[12]\d|3[01])$/.test(day))
    throw new Error('Choose a day of the month.');
  const weekday =
    frequency === 'weekly'
      ? day
      : frequency === 'weekdays'
        ? '1-5'
        : frequency === 'weekends'
          ? '0,6'
          : '*';
  return `${Number(match[2])} ${Number(match[1])} ${frequency === 'monthly' ? day : '*'} * ${weekday}`;
}

export function scheduleLabel(cron: string, format?: DateFormat) {
  const value = readSchedule(cron);
  if (value.frequency !== 'custom') {
    const frequency =
      value.frequency === 'daily'
        ? 'Every day'
        : value.frequency === 'weekdays'
          ? 'Every weekday'
          : value.frequency === 'weekends'
            ? 'Every Saturday and Sunday'
            : value.frequency === 'monthly'
              ? `Day ${value.day} of every month`
              : `Every ${scheduleWeekDays[Number(value.day)]}`;
    return `${frequency} at ${formatClockTime(value.time, format)}`;
  }
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return 'Custom timing';
  const [minute, hour, day, month, weekday] = fields;
  if (day === '*' && month === '*' && weekday === '*') {
    if (hour === '*') {
      const interval = minute === '*' ? 1 : Number(/^\*\/(\d{1,2})$/.exec(minute)?.[1]);
      if (interval > 0 && interval < 60 && 60 % interval === 0)
        return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
      if (/^\d{1,2}$/.test(minute) && Number(minute) < 60)
        return Number(minute) === 0 ? 'Every hour' : `Every hour at :${minute.padStart(2, '0')}`;
    }
    const interval = Number(/^\*\/(\d{1,2})$/.exec(hour)?.[1]);
    if (minute === '0' && interval > 0 && interval < 24 && 24 % interval === 0)
      return interval === 1 ? 'Every hour' : `Every ${interval} hours`;
  }
  return 'Custom timing';
}

export function scheduleLocalTime(value: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    time: `${part('hour')}:${part('minute')}`,
  };
}

export function scheduleRunAt(date: string, time: string, timeZone: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
    throw new Error('Choose a date and time.');
  const wallTime = `${date}T${time}:00.000Z`;
  const reference = Date.parse(wallTime);
  if (!Number.isFinite(reference) || new Date(reference).toISOString() !== wallTime)
    throw new Error('Choose a valid date and time.');
  const offsets = new Set<number>();
  for (const hours of [-36, 0, 36]) {
    const instant = reference + hours * 3_600_000;
    const local = scheduleLocalTime(new Date(instant).toISOString(), timeZone);
    offsets.add(Date.parse(`${local.date}T${local.time}:00.000Z`) - instant);
  }
  const matches = [...offsets]
    .map((offset) => new Date(reference - offset).toISOString())
    .filter((instant) => {
      const local = scheduleLocalTime(instant, timeZone);
      return local.date === date && local.time === time;
    });
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'This time occurs twice because the clocks change. Choose another time.'
        : 'This time does not exist because the clocks change. Choose another time.',
    );
  return matches[0];
}

export function scheduleDate(value: string, timeZone: string, format?: DateFormat) {
  try {
    if (!Number.isFinite(Date.parse(value))) throw new Error();
    return formatDateTime(value, format, { timeZone });
  } catch {
    return 'Time unavailable';
  }
}
