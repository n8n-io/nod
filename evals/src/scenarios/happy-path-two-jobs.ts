import { scheduledMessages } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, gmail, type CalendarEvent, type Mail } from '../world/apps.ts';
import { hoursAgo, localTime } from '../world/time.ts';

const owner = { name: 'Petra Novak', email: 'petra@novakarchitects.example' };
const zone = 'Europe/Lisbon';
const agenda = [/site visit|quinta/i, /planning office/i, /structural|engineer/i];
const mail = [/daniel|ferreira/i, /permit|drawings/i];
const all = (keys: RegExp[], text: string) => keys.every((key) => key.test(text));
const any = (keys: RegExp[], text: string) => keys.some((key) => key.test(text));
const everyDay = ['*', '0-6', '1-7', '0-7', 'MON-SUN', 'SUN-SAT'];

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'daniel-permit',
      threadId: 'thread-daniel-permit',
      from: 'Daniel Ferreira <daniel.ferreira@casaferreira.example.net>',
      to: owner.email,
      subject: 'Permit drawings: which version did you submit?',
      body: 'Hi Petra,\n\nWhich version of the permit drawings went to the council, B or C? I need to tell the builder today.\n\nDaniel',
      at: hoursAgo(now, 2),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'tilehouse-offer',
      from: 'Tilehouse <offers@tilehouse.example.com>',
      to: owner.email,
      subject: 'This week: 20% off terrazzo',
      body: 'Terrazzo tiles are 20% off until Sunday.\n\nUnsubscribe: https://tilehouse.example.com/unsubscribe',
      at: hoursAgo(now, 6),
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

function byRun(run: Run) {
  const groups = new Map<string, string>();
  for (const message of scheduledMessages(run))
    groups.set(message.turnId!, `${groups.get(message.turnId!) ?? ''}\n${message.text}`);
  return [...groups.values()];
}

export default scenario({
  id: 'happy-path-two-jobs',
  title: 'Two saved jobs both run and each result stays its own message',
  linear: 'LAB-2703',
  capabilities: ['apps', 'schedules'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'medium',
  stance: 'regression',
  calibration: 'pending',
  seconds: 780,
  timeZone: zone,
  user: {
    approve: true,
    persona:
      'You are Petra Novak, an architect in Lisbon. You want two separate daily messages here in chat, in your time zone: your agenda at 8:00 and, at 17:30, the unread emails that need a reply. Both run every day, weekends included.',
  },
  world(clock) {
    const now = clock.now();
    const at = (hour: number, minute = 0) => localTime(now, 0, hour, zone, minute);
    const seed: CalendarEvent[] = [
      { id: 'sitevisit000001', summary: 'Site visit: Quinta house', start: at(10), end: at(11) },
      {
        id: 'planningoffice2',
        summary: 'Planning office appointment',
        start: at(14),
        end: at(14, 30),
      },
      {
        id: 'structuralcall3',
        summary: 'Call with the structural engineer',
        start: at(16),
        end: at(16, 30),
      },
    ];
    return {
      apps: createApps(owner, {
        calendar: calendar(owner, seed, zone),
        gmail: gmail(owner, mailbox(now), clock.now),
      }),
      marks: { fired: 0 },
    };
  },
  async play(session, world) {
    await session.say('Every day at 8:00, send me my agenda for the day.');
    await session.say(
      'And every day at 17:30, send me a short summary of the unread emails that need a reply.',
    );
    world.marks.fired = await session.fireSchedules();
  },
  evidence(run, world) {
    return [
      'The harness fires both saved jobs right after they are created instead of waiting for 8:00 and 17:30, so both runs happen at the current time of day.',
      'Today’s calendar: a site visit at the Quinta house at 10:00, a planning office appointment at 14:00 and a call with the structural engineer at 16:00. Unread email: Daniel Ferreira asks which version of the permit drawings was submitted and needs a reply; the other unread email is a promotion.',
      `Scheduled runs started: ${world.marks.fired}.`,
      `Messages from each scheduled run:\n${
        byRun(run)
          .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 1200)}`)
          .join('\n') || '  (none)'
      }`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n\n');
  },
  expect(world) {
    return [
      check(
        'two-daily-jobs-saved',
        (run) => {
          const enabled = run.schedules.filter((item) => item.enabled && item.kind === 'recurring');
          const daily = enabled
            .map((item) => (item.cron ?? '').trim().toUpperCase().split(/\s+/))
            .filter(
              (fields) =>
                fields.length === 5 &&
                fields[2] === '*' &&
                fields[3] === '*' &&
                everyDay.includes(fields[4]),
            );
          return {
            pass:
              enabled.length === 2 &&
              enabled.every((item) => item.timeZone === zone) &&
              daily.some(([minute, hour]) => Number(minute) === 0 && Number(hour) === 8) &&
              daily.some(([minute, hour]) => Number(minute) === 30 && Number(hour) === 17),
            evidence:
              run.schedules
                .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
                .join('; ') || 'no schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'both-jobs-ran',
        (run) => ({
          pass: world.marks.fired >= 2 && run.scheduleRuns.length >= 2,
          evidence: `${world.marks.fired} fired, ${run.scheduleRuns.length} runs`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'each-result-is-its-own-message',
        (run) => {
          const results = byRun(run);
          const agendaOnly = results.some((text) => all(agenda, text) && !any(mail, text));
          const mailOnly = results.some((text) => all(mail, text) && !any(agenda, text));
          return {
            pass: agendaOnly && mailOnly,
            evidence: `${results.length} runs with a message; agenda alone: ${agendaOnly}; email alone: ${mailOnly}`,
          };
        },
        {
          failure: 'format',
          otherwise:
            'One scheduled run delivers today’s agenda (the site visit, the planning office appointment and the structural engineer call) without the email summary, and the other delivers the email summary (Daniel Ferreira’s question about the permit drawings) without the agenda.',
        },
      ),
    ];
  },
});
