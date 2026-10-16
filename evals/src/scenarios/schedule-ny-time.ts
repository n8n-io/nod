import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const newYork = 'America/New_York';
const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function expand(field: string, min: number, max: number) {
  const found = new Set<number>();
  for (const part of field.toUpperCase().split(',')) {
    const [span, step = '1'] = part.split('/');
    const value = (text: string) => (days.includes(text) ? days.indexOf(text) : Number(text));
    const [from, to] =
      span === '*' || span === '?'
        ? [min, max]
        : span.includes('-')
          ? span.split('-').map(value)
          : [value(span), part.includes('/') ? max : value(span)];
    for (let n = from; n <= to; n += Math.max(1, Number(step) || 0))
      found.add(max === 7 ? n % 7 : n);
  }
  return found;
}

function parse(text: string | null) {
  const fields = (text ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minute, hour, day, month, weekday] = fields;
  return {
    minute: expand(minute, 0, 59),
    hour: expand(hour, 0, 23),
    day: expand(day, 1, 31),
    month: expand(month, 1, 12),
    weekday: expand(weekday, 0, 7),
  };
}

const wall = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

function newYorkTime(item: Run['schedules'][number], now: number) {
  const cron = parse(item.cron);
  if (!cron || cron.minute.size !== 1 || cron.hour.size !== 1) return undefined;
  try {
    const at = localTime(now, 0, [...cron.hour][0], item.timeZone, [...cron.minute][0]);
    return wall(at, newYork);
  } catch {
    return undefined;
  }
}

export default scenario({
  id: 'schedule-ny-time',
  title: 'Every day at 9am New York time, remind me to check the US market open',
  capabilities: ['schedules'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You live in Madrid but follow the US markets. You want a short reminder here in this chat at 9:00 New York time, every day.',
  },
  world(clock) {
    return { apps: createApps(owner, {}), now: clock.now };
  },
  async play(session) {
    await session.say('Every day at 9am New York time, remind me to check the US market open.');
  },
  evidence(run, world) {
    const now = world.now();
    return [
      `9:00 in New York today is ${wall(localTime(now, 0, 9, newYork), 'Europe/Madrid')} in Madrid (the user's own time zone) and ${wall(localTime(now, 0, 9, newYork), 'UTC')} UTC. A schedule saved in America/New_York at 9:00 also stays right when either side changes daylight saving time.`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled} (fires at ${newYorkTime(item, now) ?? '?'} New York time)\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const fits = (run: Run) =>
      run.schedules.filter((item) => {
        const cron = parse(item.cron);
        return (
          item.enabled &&
          item.kind === 'recurring' &&
          cron !== undefined &&
          cron.day.size === 31 &&
          cron.month.size === 12 &&
          cron.weekday.size === 7 &&
          newYorkTime(item, world.now()) === '09:00'
        );
      });
    return [
      check('fires-at-nine-new-york-time', (run) => ({
        pass: fits(run).length >= 1,
        evidence:
          run.schedules
            .map(
              (item) =>
                `${item.kind} ${item.cron ?? '-'} ${item.timeZone} → ${newYorkTime(item, world.now()) ?? '?'} New York`,
            )
            .join('; ') || 'no schedule',
      })),
      check(
        'saved-in-new-york-time',
        (run) => ({
          pass: fits(run).some((item) => item.timeZone === newYork),
          evidence: run.schedules.map((item) => item.timeZone).join(', ') || 'no schedule',
        }),
        { required: false, aspect: 'process', failure: 'reasoning' },
      ),
      check(
        'reminder-is-about-the-market',
        (run) => ({
          pass: fits(run).some((item) =>
            /market|stock|nyse|nasdaq/i.test(`${item.title}\n${item.prompt}`),
          ),
          evidence: run.schedules.map((item) => item.title).join(', ') || 'no schedule',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The title or saved prompt of the daily 9:00 New York time schedule says it reminds the user to check the US market open, in any wording.',
        },
      ),
    ];
  },
});
