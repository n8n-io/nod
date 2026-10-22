export const hoursAgo = (now: number, hours: number) => now - hours * 3_600_000;

export const localDate = (at: number, timeZone = 'Europe/Madrid') =>
  new Date(at).toLocaleDateString('en-CA', { timeZone });

export function dayLabel(at: number, timeZone = 'Europe/Madrid') {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(at);
}

const wall = (at: number, timeZone: string) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(at)
      .map((part) => [part.type, Number(part.value)]),
  );

export function localTime(
  now: number,
  back: number,
  hour: number,
  timeZone = 'Europe/Madrid',
  minute = 0,
) {
  const today = wall(now, timeZone);
  const wanted = Date.UTC(today.year, today.month - 1, today.day - back, hour, minute);
  const seen = wall(wanted, timeZone);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - wanted;
  return wanted - offset;
}

export function duringToday(now: number, share: number, timeZone = 'Europe/Madrid') {
  const start = localTime(now, 0, 0, timeZone);
  return Math.floor(start + (now - start) * share);
}

export function daysAgo(now: number, days: number, timeZone = 'Europe/Madrid') {
  const today = wall(now, timeZone);
  const whole = Math.floor(days);
  return localTime(now, whole, today.hour, timeZone, today.minute) - (days - whole) * 86_400_000;
}

export const inDays = (now: number, days: number, timeZone = 'Europe/Madrid') =>
  daysAgo(now, -days, timeZone);

export function nextWeekday(
  now: number,
  weekday: number,
  minimumDays = 3,
  timeZone = 'Europe/Madrid',
) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let offset = minimumDays; offset < minimumDays + 8; offset++) {
    const at = inDays(now, offset, timeZone);
    const name = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(at);
    if (name === names[weekday]) return offset;
  }
  throw new Error('No matching weekday.');
}

export function nextWeekOn(now: number, weekday: number, timeZone = 'Europe/Madrid') {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)
    throw new Error(`Weekday must be 0 to 6, not ${weekday}.`);
  let offset = 1;
  while (
    new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(
      inDays(now, offset, timeZone),
    ) !== 'Monday'
  )
    offset++;
  while (
    new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(
      inDays(now, offset, timeZone),
    ) !== names[weekday]
  )
    offset++;
  return offset;
}

export function mondayOf(now: number, timeZone = 'Europe/Madrid') {
  for (let back = 0; back < 7; back++) {
    const at = localTime(now, back, 0, timeZone);
    if (
      new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(at + 3_600_000) ===
      'Monday'
    )
      return at;
  }
  throw new Error('No Monday found.');
}
