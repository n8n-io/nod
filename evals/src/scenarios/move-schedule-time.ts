import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps } from '../world/apps.ts';
import { localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
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

const only = (found: Set<number>, value: number) => found.size === 1 && found.has(value);
const weekdays = (found: Set<number>) =>
  found.size === 5 && [1, 2, 3, 4, 5].every((day) => found.has(day));
const describe = (run: Run) =>
  run.schedules
    .map(
      (item) =>
        `"${item.title}" ${item.kind} ${item.cron ?? '-'} ${item.timeZone} ${item.enabled ? 'enabled' : 'disabled'}`,
    )
    .join('; ') || 'no schedule';

export default scenario({
  id: 'move-schedule-time',
  title: 'Make the morning brief 7:30 instead',
  capabilities: ['schedules', 'apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer. You want the brief here in this chat, Monday to Friday, covering that day in your Google Calendar. No brief on weekends. Your time zone is Europe/Madrid.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    return {
      apps: createApps(owner, {
        calendar: calendar(
          owner,
          [
            {
              id: 'standup-tomorrow',
              summary: 'Design standup',
              start: at(1, 9, 30),
              end: at(1, 9, 45),
            },
            {
              id: 'meridian-review',
              summary: 'Meridian rebrand review',
              start: at(1, 11),
              end: at(1, 12),
              attendees: ['sofia@meridian.example.org'],
            },
            {
              id: 'lumen-kickoff',
              summary: 'Lumen Foods kickoff',
              start: at(2, 15),
              end: at(2, 16),
              attendees: ['ines@lumenfoods.example.com'],
            },
          ],
          zone,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Every weekday at 8:00 give me a morning brief of my calendar.');
    await session.say('Make the morning brief 7:30 instead.');
  },
  evidence(run) {
    return `Saved schedules at the end:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}\nA disabled schedule no longer runs.`;
  },
  expect() {
    return [
      check('one-brief-at-seven-thirty-on-weekdays', (run) => {
        const enabled = run.schedules.filter((item) => item.enabled);
        const cron = enabled.length === 1 ? parse(enabled[0].cron) : undefined;
        return {
          pass: Boolean(
            enabled.length === 1 &&
            enabled[0].kind === 'recurring' &&
            enabled[0].timeZone === zone &&
            cron &&
            only(cron.minute, 30) &&
            only(cron.hour, 7) &&
            cron.day.size === 31 &&
            cron.month.size === 12 &&
            weekdays(cron.weekday),
          ),
          evidence: describe(run),
        };
      }),
      check(
        'no-brief-left-at-eight',
        (run) => ({
          pass: !run.schedules.some((item) => {
            const cron = parse(item.cron);
            return item.enabled && cron !== undefined && cron.hour.has(8);
          }),
          evidence: describe(run),
        }),
        { failure: 'incomplete' },
      ),
      check(
        'kept-the-brief-instruction',
        (run) => {
          const enabled = run.schedules.filter((item) => item.enabled);
          return {
            pass:
              enabled.length === 1 &&
              /calendar|meeting|agenda|brief/i.test(`${enabled[0].title}\n${enabled[0].prompt}`),
            evidence: enabled.map((item) => `${item.title}: ${item.prompt}`).join(' | '),
          };
        },
        { required: false, aspect: 'process', failure: 'reasoning' },
      ),
    ];
  },
});
