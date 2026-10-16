import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

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

const routines = [
  {
    name: 'plants',
    topic: /plant/i,
    timing: /\bsun(?:day)?s?\b/i,
    fits: (cron: NonNullable<ReturnType<typeof parse>>) =>
      only(cron.minute, 0) &&
      only(cron.hour, 10) &&
      cron.day.size === 31 &&
      cron.month.size === 12 &&
      only(cron.weekday, 0),
  },
  {
    name: 'rent',
    topic: /\brent\b/i,
    timing: /\b1st\b|\bfirst\b|\bday 1\b|\b1 (?:of|each|every)\b/i,
    fits: (cron: NonNullable<ReturnType<typeof parse>>) =>
      only(cron.minute, 0) &&
      only(cron.hour, 9) &&
      only(cron.day, 1) &&
      cron.month.size === 12 &&
      cron.weekday.size === 7,
  },
  {
    name: 'weekly review',
    topic: /\breview\b/i,
    timing: /\bfri(?:day)?s?\b/i,
    fits: (cron: NonNullable<ReturnType<typeof parse>>) =>
      only(cron.minute, 0) &&
      only(cron.hour, 16) &&
      cron.day.size === 31 &&
      cron.month.size === 12 &&
      only(cron.weekday, 5),
  },
];

const describe = (run: Run) =>
  run.schedules
    .map(
      (item) =>
        `"${item.title}" ${item.kind} ${item.cron ?? '-'} ${item.timeZone} ${item.enabled ? 'enabled' : 'disabled'}`,
    )
    .join('; ') || 'no schedule';

export default scenario({
  id: 'list-my-schedules',
  title: 'What do you have scheduled for me?',
  capabilities: ['schedules', 'memory'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. All three are simple reminders sent to you here in this chat, at the times you gave, in your own time zone (Europe/Madrid).',
  },
  world() {
    return { apps: createApps(owner, {}), marks: { before: 0 } };
  },
  async play(session, world) {
    await session.say('Every Sunday at 10:00, remind me to water the plants.');
    await session.say('On the 1st of every month at 9:00, remind me to pay the rent.');
    await session.say('Every Friday at 16:00, remind me to do my weekly review.');
    world.marks.before = await session.assistantCount();
    await session.reset();
    await session.say('What do you have scheduled for me?');
  },
  evidence(run) {
    return [
      'The conversation was reset before the last question, so the earlier chat is not in view; the saved schedules are.',
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const answer = (run: Run) => run.replies.slice(world.marks.before).join('\n');
    return [
      check(
        'three-reminders-saved',
        (run) => {
          const missing = routines.filter(
            (routine) =>
              !run.schedules.some((item) => {
                const cron = parse(item.cron);
                return (
                  item.enabled &&
                  item.timeZone === zone &&
                  routine.topic.test(`${item.title}\n${item.prompt}`) &&
                  cron !== undefined &&
                  routine.fits(cron)
                );
              }),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((routine) => routine.name).join(', ')}: ${describe(run)}`
              : undefined,
          };
        },
        { aspect: 'process' },
      ),
      check(
        'answer-names-all-three',
        (run) => {
          const text = answer(run);
          const missing = routines.filter((routine) => !routine.topic.test(text));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((routine) => routine.name).join(', ')}`
              : undefined,
          };
        },
        {
          otherwise:
            'In its answer to "What do you have scheduled for me?", the assistant refers to all three saved reminders, watering the plants, paying the rent and the weekly review, in any wording.',
        },
      ),
      check(
        'answer-gives-their-timing',
        (run) => {
          const text = answer(run);
          const missing = routines.filter((routine) => !routine.timing.test(text));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `no timing for ${missing.map((routine) => routine.name).join(', ')}`
              : undefined,
          };
        },
        {
          otherwise:
            'In its answer to "What do you have scheduled for me?", the assistant gives the right day for each reminder in any wording or format: Sundays for watering the plants, the 1st of every month for the rent and Fridays for the weekly review.',
        },
      ),
      judge(
        'answer-matches-the-saved-schedules',
        'In its answer to "What do you have scheduled for me?", the assistant lists exactly the three saved reminders with their timing: water the plants every Sunday at 10:00, pay the rent on the 1st of every month at 9:00, and the weekly review every Friday at 16:00 (any time format is fine). It does not invent other schedules or give a wrong day or time for any of them.',
        { required: false, failure: 'hallucination' },
      ),
    ];
  },
});
