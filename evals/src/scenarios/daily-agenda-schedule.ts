import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

interface Item {
  summary: string;
  key: RegExp;
}

const today: Item[] = [
  { summary: 'Meridian rebrand review', key: /meridian/i },
  { summary: '1:1 with Priya', key: /priya/i },
  { summary: 'Supplier call: Papelaria Norte', key: /papelaria/i },
];
const monday: Item[] = [
  { summary: 'Lumen Foods kickoff', key: /lumen/i },
  { summary: 'Lunch with Joana', key: /joana/i },
  { summary: 'Portfolio review with Lena', key: /portfolio|lena/i },
];
const yesterday: Item = { summary: 'Kestrel brand sync', key: /kestrel/i };

function weekdaysAtEight(cron: string | null) {
  const fields = (cron ?? '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, day, month, weekday] = fields;
  return (
    Number(minute) === 0 &&
    /^\d+$/.test(minute) &&
    Number(hour) === 8 &&
    /^\d+$/.test(hour) &&
    day === '*' &&
    month === '*' &&
    ['1-5', 'MON-FRI', '1,2,3,4,5', 'MON,TUE,WED,THU,FRI'].includes(weekday.toUpperCase())
  );
}

export default scenario({
  id: 'daily-agenda-schedule',
  title: 'Every weekday at 8:00, send me my agenda for the day',
  capabilities: ['apps', 'schedules'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You want the agenda Monday to Friday at 8:00 your time, here in chat, as a short list with times. No agenda on weekends.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const weekday = new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: zone }).format(
      now,
    );
    const weekend = weekday === 'Sat' || weekday === 'Sun';
    const next = weekend ? nextWeekday(now, 1, 1) : 0;
    const seed: CalendarEvent[] = [
      {
        id: 'kestrelyester1',
        summary: yesterday.summary,
        start: at(-1, 10),
        end: at(-1, 11),
      },
      {
        id: 'meridiantoday2',
        summary: today[0].summary,
        start: at(0, 9),
        end: at(0, 9, 45),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      {
        id: 'priyatoday0003',
        summary: today[1].summary,
        start: at(0, 13),
        end: at(0, 13, 30),
        attendees: ['priya.nair@riveradesign.example'],
      },
      {
        id: 'papelariatday4',
        summary: today[2].summary,
        start: at(0, 17, 15),
        end: at(0, 17, 45),
      },
      ...(weekend
        ? [
            {
              id: 'lumenmonday005',
              summary: monday[0].summary,
              start: at(next, 9, 30),
              end: at(next, 10, 30),
            },
            {
              id: 'joanamonday006',
              summary: monday[1].summary,
              start: at(next, 13),
              end: at(next, 14),
            },
            {
              id: 'portfoliomon07',
              summary: monday[2].summary,
              start: at(next, 16),
              end: at(next, 17),
            },
          ]
        : []),
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      weekend,
      labels: {
        today: dayLabel(now, zone),
        next: weekend ? dayLabel(inDays(now, next), zone) : '',
      },
      marks: { setup: 0, fired: 0, after: 0 },
    };
  },
  async play(session, world) {
    await session.say('Every weekday at 8:00, send me my agenda for the day.');
    world.marks.setup = await session.assistantCount();
    world.marks.fired = await session.fireSchedules();
    world.marks.after = await session.assistantCount();
  },
  evidence(run, world) {
    const { marks } = world;
    const part = (from: number, to: number) =>
      run.replies
        .slice(from, to)
        .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 1200)}`)
        .join('\n') || '  (no message)';
    const line = (event: CalendarEvent) =>
      `"${event.summary}" ${new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(event.start)}`;
    return [
      'The harness fires the schedule immediately after it is created instead of waiting for 8:00, so the scheduled run happens at the current time of day.',
      `Today, ${world.labels.today}: ${world.seed
        .filter((event) => today.some((item) => item.summary === event.summary))
        .map(line)
        .join('; ')}. Yesterday: "${yesterday.summary}" (not today).`,
      world.weekend
        ? `Today is a weekend day; the next weekday, ${world.labels.next}, has ${monday.map((item) => `"${item.summary}"`).join(', ')}. An agenda for either today or that weekday is acceptable from this early run.`
        : '',
      `Scheduled runs started: ${marks.fired}.`,
      `Messages when the routine was set up:\n${part(0, marks.setup)}`,
      `Messages from the scheduled run:\n${part(marks.setup, marks.after)}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ]
      .filter(Boolean)
      .join('\n');
  },
  expect(world) {
    const { marks } = world;
    const agenda = (run: Run) => run.replies.slice(marks.setup, marks.after).join('\n');
    return [
      check(
        'weekday-eight-oclock-schedule',
        (run) => {
          const enabled = run.schedules.filter((item) => item.enabled);
          const schedule = enabled[0];
          return {
            pass: Boolean(
              enabled.length === 1 &&
              schedule.kind === 'recurring' &&
              weekdaysAtEight(schedule.cron) &&
              schedule.timeZone === zone,
            ),
            evidence:
              enabled
                .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
                .join('; ') || 'no enabled schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'scheduled-run-happened',
        (run) => ({
          pass: marks.fired >= 1 && run.scheduleRuns.length >= 1 && marks.after > marks.setup,
          evidence: `${marks.fired} fired, ${run.scheduleRuns.length} runs, ${marks.after - marks.setup} messages`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'agenda-lists-every-event',
        (run) => {
          const text = agenda(run);
          const sets = world.weekend ? [today, monday] : [today];
          const pass = sets.some((set) => set.every((item) => item.key.test(text)));
          const missing = today.filter((item) => !item.key.test(text));
          return {
            pass,
            evidence: pass
              ? undefined
              : `missing ${missing.map((item) => item.summary).join(', ')}`,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The scheduled agenda message refers to every event on the day it covers, in any wording: its title, a paraphrase, a participant or its time.',
        },
      ),
      check(
        'leaves-out-yesterday',
        (run) => ({
          pass: !yesterday.key.test(agenda(run)),
          evidence: yesterday.key.test(agenda(run)) ? `mentions ${yesterday.summary}` : undefined,
        }),
        { required: false, failure: 'reasoning' },
      ),
    ];
  },
});
