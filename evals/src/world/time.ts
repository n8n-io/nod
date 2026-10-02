export const hoursAgo = (now: number, hours: number) => now - hours * 3_600_000;

export function dayLabel(at: number, timeZone = 'Europe/Madrid') {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone,
  }).format(at);
}

export const inDays = (now: number, days: number) => now + days * 86_400_000;

export function localTime(
  now: number,
  daysAgo: number,
  hour: number,
  timeZone = 'Europe/Madrid',
  minute = 0,
) {
  const parts = (at: number) =>
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
  const today = parts(now);
  const wanted = Date.UTC(today.year, today.month - 1, today.day - daysAgo, hour, minute);
  const seen = parts(wanted);
  const offset = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - wanted;
  return wanted - offset;
}

export const daysAgo = (now: number, days: number) => now - days * 86_400_000;

export function nextWeekday(
  now: number,
  weekday: number,
  minimumDays = 3,
  timeZone = 'Europe/Madrid',
) {
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  for (let offset = minimumDays; offset < minimumDays + 8; offset++) {
    const at = now + offset * 86_400_000;
    const name = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone }).format(at);
    if (name === names[weekday]) return offset;
  }
  throw new Error('No matching weekday.');
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
