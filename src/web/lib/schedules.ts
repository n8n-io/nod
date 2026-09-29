import { formatClockTime, formatDateTime, type DateFormat } from './date-format';

export type ScheduleFrequency = 'daily' | 'weekly' | 'custom';
const weekDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function readSchedule(cron: string) {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|[0-7])$/.exec(cron.trim());
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    return { frequency: 'custom' as ScheduleFrequency, time: '09:00', day: '1' };
  return {
    frequency: (match[3] === '*' ? 'daily' : 'weekly') as ScheduleFrequency,
    time: `${match[2].padStart(2, '0')}:${match[1].padStart(2, '0')}`,
    day: String(Number(match[3]) % 7 || 0),
  };
}

export function scheduleExpression(
  frequency: ScheduleFrequency,
  time: string,
  day: string,
  original?: string,
) {
  if (frequency === 'custom' && original) return original;
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
    throw new Error('Choose a valid time.');
  if (frequency === 'weekly' && !/^[0-6]$/.test(day)) throw new Error('Choose a day of the week.');
  return `${Number(match[2])} ${Number(match[1])} * * ${frequency === 'weekly' ? day : '*'}`;
}

export function scheduleLabel(cron: string, format?: DateFormat) {
  const value = readSchedule(cron);
  if (value.frequency !== 'custom')
    return `${value.frequency === 'daily' ? 'Every day' : `Every ${weekDays[Number(value.day)]}`} at ${formatClockTime(value.time, format)}`;
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
  const hasTime =
    /^\d{1,2}$/.test(minute) && /^\d{1,2}$/.test(hour) && Number(minute) < 60 && Number(hour) < 24;
  if (hasTime && month === '*') {
    const time = formatClockTime(`${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`, format);
    if (day === '*' && weekday === '1-5') return `Every weekday at ${time}`;
    if (day === '*' && ['0,6', '6,0', '6-7'].includes(weekday))
      return `Every Saturday and Sunday at ${time}`;
    if (weekday === '*' && /^\d{1,2}$/.test(day) && Number(day) > 0 && Number(day) <= 31)
      return `Day ${Number(day)} of every month at ${time}`;
  }
  return 'Custom timing';
}

export function scheduleDate(value: string, timeZone: string, format?: DateFormat) {
  try {
    if (!Number.isFinite(Date.parse(value))) throw new Error();
    return formatDateTime(value, format, { timeZone });
  } catch {
    return 'Time unavailable';
  }
}
