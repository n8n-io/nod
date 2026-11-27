export type ScheduleFrequency =
  'minutes' | 'hours' | 'daily' | 'weekdays' | 'weekends' | 'weekly' | 'monthly' | 'custom';
export const scheduleWeekDays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export type ScheduleTiming = {
  frequency: ScheduleFrequency;
  time: string;
  day: string;
  interval: string;
  cron: string;
};

function intervalOf(field: string, limit: number) {
  if (field === '*') return 1;
  const value = Number(/^\*\/(\d{1,2})$/.exec(field)?.[1]);
  return value > 0 && value < limit && limit % value === 0 ? value : 0;
}

export function readSchedule(cron: string): ScheduleTiming {
  const expression = cron.trim();
  const base = { time: '09:00', day: '1', interval: '1', cron: expression };
  const fields = expression.split(/\s+/);
  if (fields.length === 5 && fields[2] === '*' && fields[3] === '*' && fields[4] === '*') {
    const [minute, hour] = fields;
    const everyMinutes = intervalOf(minute, 60);
    if (hour === '*' && everyMinutes)
      return { ...base, frequency: 'minutes', interval: String(everyMinutes) };
    const everyHours = intervalOf(hour, 24);
    if (everyHours && /^\d{1,2}$/.test(minute) && Number(minute) < 60)
      return {
        ...base,
        frequency: 'hours',
        interval: String(everyHours),
        time: `00:${minute.padStart(2, '0')}`,
      };
  }
  const match = /^(\d{1,2})\s+(\d{1,2})\s+(\*|\d{1,2})\s+\*\s+(\*|1-5|0,6|6,0|6-7|[0-7])$/.exec(
    expression,
  );
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    return { ...base, frequency: 'custom' };
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
    ...base,
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

export function scheduleLabel(
  cron: string,
  formatClock: (value: string) => string = (value) => value,
) {
  const value = readSchedule(cron);
  const interval = Number(value.interval);
  if (value.frequency === 'custom') return 'Custom timing';
  if (value.frequency === 'minutes')
    return interval === 1 ? 'Every minute' : `Every ${interval} minutes`;
  if (value.frequency === 'hours') {
    const minute = value.time.slice(3);
    const every = interval === 1 ? 'Every hour' : `Every ${interval} hours`;
    return minute === '00' ? every : `${every} at :${minute}`;
  }
  const frequency =
    value.frequency === 'daily'
      ? 'Every day'
      : value.frequency === 'weekdays'
        ? 'Every weekday'
        : value.frequency === 'weekends'
          ? 'Every Saturday and Sunday'
          : value.frequency === 'monthly'
            ? `Day ${value.day} of ${Number(value.day) > 28 ? 'each month that has that day' : 'every month'}`
            : `Every ${scheduleWeekDays[Number(value.day)]}`;
  return `${frequency} at ${formatClock(value.time)}`;
}
