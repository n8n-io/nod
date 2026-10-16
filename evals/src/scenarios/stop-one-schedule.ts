import { check, scenario } from '../scenario.ts';
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
const about = (item: Run['schedules'][number]) => `${item.title}\n${item.prompt}`;
const digest = (item: Run['schedules'][number]) => /news|digest/i.test(about(item));
const invoices = (item: Run['schedules'][number]) => /invoice/i.test(about(item)) && !digest(item);
const describe = (run: Run) =>
  run.schedules
    .map(
      (item) =>
        `"${item.title}" ${item.kind} ${item.cron ?? '-'} ${item.timeZone} ${item.enabled ? 'enabled' : 'disabled'}`,
    )
    .join('; ') || 'no schedule';

export default scenario({
  id: 'stop-one-schedule',
  title: 'Stop the daily news digest',
  capabilities: ['schedules'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer. The digest should cover graphic, brand and product design news from any reputable sources, delivered here in this chat. The Friday reminder is just a nudge in this chat to send your invoices. You want the Friday reminder to keep running.',
  },
  world() {
    return { apps: createApps(owner, {}) };
  },
  async play(session) {
    await session.say('Every morning at 7:00 send me a news digest about design.');
    await session.say('Every Friday at 17:00 remind me to send invoices.');
    await session.say('Stop the daily news digest.');
  },
  evidence(run) {
    return `Saved schedules at the end:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}\nStopping a schedule disables it; disabled schedules remain listed.`;
  },
  expect() {
    return [
      check('digest-stopped', (run) => {
        const found = run.schedules.filter(digest);
        return {
          pass: found.length >= 1 && found.every((item) => !item.enabled),
          evidence: describe(run),
        };
      }),
      check(
        'friday-invoice-reminder-still-on',
        (run) => {
          const kept = run.schedules.filter((item) => {
            const cron = parse(item.cron);
            return (
              invoices(item) &&
              item.enabled &&
              item.kind === 'recurring' &&
              item.timeZone === zone &&
              cron !== undefined &&
              only(cron.minute, 0) &&
              only(cron.hour, 17) &&
              cron.day.size === 31 &&
              cron.month.size === 12 &&
              only(cron.weekday, 5)
            );
          });
          return { pass: kept.length === 1, evidence: describe(run) };
        },
        { failure: 'unsafe' },
      ),
      check(
        'nothing-else-scheduled',
        (run) => ({
          pass: run.schedules.filter((item) => item.enabled).every(invoices),
          evidence: describe(run),
        }),
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
