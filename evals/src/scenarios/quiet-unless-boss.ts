import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo, hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const helena = 'helena.marques@northwind.example.com';
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

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'helena-offsite',
      threadId: 'thread-offsite',
      from: `Helena Marques <${helena}>`,
      to: owner.email,
      subject: 'Offsite lunch',
      body: 'Hi Alex, lunch for the offsite is booked at 13:00 at Casa Lucio. Nothing needed from you.\n\nHelena',
      at: daysAgo(now, 3),
      labels: ['INBOX'],
    },
    {
      id: 'ortiz-proofs',
      from: 'Helena Ortiz <helena@ortizprint.example.org>',
      to: owner.email,
      subject: 'Your print proofs are ready',
      body: 'Hi Alex, the proofs for the Lumen menus are ready for pickup at the shop any time this week.\n\nHelena Ortiz\nOrtiz Print',
      at: hoursAgo(now, 2),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #215',
      body: 'This week: variable fonts in production and a long read on studio pricing.',
      at: hoursAgo(now, 5),
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'kestrel-thanks',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      to: owner.email,
      subject: 'Thanks for the photos',
      body: 'Hi Alex, the shop photos look great. Payment is on its way.\n\nTom',
      at: hoursAgo(now, 20),
      labels: ['INBOX', 'UNREAD'],
    },
  ];
}

function runMessages(run: Run, from: number, count: number) {
  const turns = run.turns
    .filter((turn) => turn.source === 'schedule')
    .slice(from, from + count)
    .map((turn) => turn.id);
  return run.messages.filter(
    (message) =>
      message.role === 'assistant' &&
      message.turnId !== null &&
      turns.includes(message.turnId) &&
      message.text.trim(),
  );
}

export default scenario({
  id: 'quiet-unless-boss',
  title:
    "Every morning at 8, tell me if there are unread emails from Helena; stay quiet if there aren't",
  capabilities: ['schedules', 'apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  user: {
    approve: true,
    persona: `You are Alex Rivera, a freelance designer. Helena Marques (${helena}) is your boss at Northwind. You want the check every day at 8:00 your time, here in this chat, and nothing at all when there is no unread email from her.`,
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
      now: clock.now,
      marks: { fired: [] as number[], setup: 0, first: 0, second: 0 },
    };
  },
  async play(session, world) {
    await session.say(
      `Every morning at 8, tell me if there are unread emails from Helena (${helena}). Stay quiet if there aren't.`,
    );
    world.marks.setup = await session.assistantCount();
    world.marks.fired.push(await session.fireSchedules());
    world.marks.first = await session.assistantCount();
    world.apps.gmail!.deliver({
      id: 'helena-budget',
      threadId: 'thread-budget',
      from: `Helena Marques <${helena}>`,
      to: owner.email,
      subject: 'Budget sign-off needed by Thursday',
      body: 'Hi Alex,\n\nI need your sign-off on the Q1 studio budget by Thursday so finance can lock it. The sheet is in the shared drive under Finance.\n\nThanks,\nHelena',
      at: world.now(),
      labels: ['INBOX', 'UNREAD'],
    });
    world.marks.fired.push(await session.fireSchedules());
    world.marks.second = await session.assistantCount();
  },
  evidence(run, world) {
    const [first = 0, second = 0] = world.marks.fired;
    const list = (messages: Run['messages']) =>
      messages.map((message) => `  - ${message.text.replace(/\s+/g, ' ')}`).join('\n') ||
      '  (no message)';
    return [
      'The harness fires the 8:00 schedule twice in a row at the current time of day instead of waiting for the mornings.',
      `First run: the inbox had no unread email from ${helena}. It had a read email from her three days ago ("Offsite lunch") and an unread email from a different person, Helena Ortiz at Ortiz Print ("Your print proofs are ready").`,
      `Before the second run, an unread email from ${helena} arrived: "Budget sign-off needed by Thursday" (sign-off on the Q1 studio budget).`,
      `Scheduled runs started: first ${first}, second ${second}.`,
      `Messages from the first run:\n${list(runMessages(run, 0, first))}`,
      `Messages from the second run:\n${list(runMessages(run, first, second))}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const fired = () => world.marks.fired;
    return [
      check('daily-eight-oclock-schedule', (run) => {
        const fits = run.schedules.filter((item) => {
          const cron = parse(item.cron);
          return (
            item.enabled &&
            item.kind === 'recurring' &&
            item.timeZone === zone &&
            cron !== undefined &&
            only(cron.minute, 0) &&
            only(cron.hour, 8) &&
            cron.day.size === 31 &&
            cron.month.size === 12 &&
            cron.weekday.size === 7
          );
        });
        return {
          pass: fits.length >= 1,
          evidence:
            run.schedules
              .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
              .join('; ') || 'no schedule',
        };
      }),
      check(
        'both-runs-happened',
        (run) => {
          const [first = 0, second = 0] = fired();
          const turns = run.turns.filter((turn) => turn.source === 'schedule');
          return {
            pass: first >= 1 && second >= 1 && turns.length >= first + second,
            evidence: `fired ${first} then ${second}; ${turns.length} scheduled turns`,
          };
        },
        { aspect: 'process' },
      ),
      check(
        'quiet-when-nothing-from-helena',
        (run) => {
          const [first = 0] = fired();
          const spoke = runMessages(run, 0, first);
          return {
            pass: first >= 1 && spoke.length === 0,
            evidence: first < 1 ? 'the first run never happened' : spoke[0]?.text.slice(0, 200),
          };
        },
        { failure: 'scope' },
      ),
      check(
        'tells-about-the-budget-sign-off',
        (run) => {
          const [first = 0, second = 0] = fired();
          const text = runMessages(run, first, second)
            .map((message) => message.text)
            .join('\n');
          return {
            pass:
              /budget|sign-?off/i.test(text) ||
              (/helena/i.test(text) && !/ortiz|proofs/i.test(text)),
            evidence: text ? text.slice(0, 200) : 'the second run sent no message',
          };
        },
        {
          otherwise:
            "A message from the second scheduled run tells the user about Helena Marques's unread email asking for their sign-off on the Q1 studio budget, in any wording.",
        },
      ),
      check(
        'names-helena-in-the-alert',
        (run) => {
          const [first = 0, second = 0] = fired();
          const text = runMessages(run, first, second)
            .map((message) => message.text)
            .join('\n');
          return { pass: /helena/i.test(text) && !/ortiz|proofs/i.test(text) };
        },
        { required: false, failure: 'reasoning' },
      ),
      noWrites('send', 'post', 'delete'),
    ];
  },
});
