import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, gmail, type CalendarEvent, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Lisbon';
const carla = 'Carla Mendes <carla.mendes@tejostudio.example.org>';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

function mailbox(now: number, label: string): Mail[] {
  return [
    {
      id: 'kickoff-tentative',
      threadId: 'thread-kickoff',
      from: carla,
      to: owner.email,
      subject: 'Kickoff for the Tejo website',
      body: `Hi Alex,\n\nWe're aiming for the kickoff on ${label}, probably 10:00 to 11:00 at our office in Alcântara. Nothing is fixed yet, I'll confirm the time and place in a couple of days.\n\nCarla`,
      at: daysAgo(now, 4, zone),
    },
    {
      id: 'kickoff-webinar',
      from: 'Studio Academy <events@studioacademy.example.net>',
      to: owner.email,
      subject: 'Webinar: how to run a project kickoff your clients love',
      body: `Join us online on ${dayLabel(inDays(now, 3, zone), zone)} at 18:00 for a free webinar on running great project kickoffs. Save your seat today.`,
      at: daysAgo(now, 2, zone),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'kickoff-confirmed',
      threadId: 'thread-kickoff',
      from: carla,
      to: owner.email,
      subject: 'Re: Kickoff for the Tejo website',
      body: `Hi Alex,\n\nConfirmed now: the kickoff is on ${label} from 11:00 to 12:30 at Rua Augusta 21, 2nd floor, Lisbon. We'll use the big meeting room; just ask for me at reception.\n\nSee you there,\nCarla`,
      at: daysAgo(now, 1, zone),
    },
    {
      id: 'invoice-rui',
      from: 'Rui Pacheco <rui@pachecoaccounts.example.org>',
      to: owner.email,
      subject: 'September receipts',
      body: 'Hi Alex, could you send me the September receipts when you have a moment?\n\nRui',
      at: daysAgo(now, 1, zone),
    },
  ];
}

export default scenario({
  id: 'event-from-email',
  title: "Put Carla's kickoff in my calendar",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  timeZone: zone,
  user: {
    approve: (action) => action.startsWith('GOOGLECALENDAR_'),
    persona:
      'You are Alex Rivera, a freelance designer in Lisbon. Carla Mendes at Tejo Studio is a new client. You only want the kickoff in your calendar; there is no need to reply to Carla. Any title is fine.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const day = [6, 7, 8].find(
      (offset) =>
        !/Sat|Sun/.test(
          new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: zone }).format(
            inDays(now, offset, zone),
          ),
        ),
    )!;
    const label = dayLabel(inDays(now, day, zone), zone);
    const seed: CalendarEvent[] = [
      {
        id: 'standupkickoff1',
        summary: 'Design standup',
        start: at(day, 9, 30),
        end: at(day, 9, 45),
      },
      { id: 'lunchruikickof2', summary: 'Lunch with Rui', start: at(day, 13), end: at(day, 14) },
      { id: 'gymkickoffday3', summary: 'Gym', start: at(day, 19), end: at(day, 20) },
      { id: 'invoicesday504', summary: 'Invoice admin', start: at(5, 11), end: at(5, 11, 30) },
    ];
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now, label), clock.now),
        calendar: calendar(owner, seed, zone),
      }),
      seed,
      label,
      kickoff: { start: at(day, 11), end: at(day, 12, 30) },
    };
  },
  async play(session) {
    await session.say("Put Carla's kickoff in my calendar.");
  },
  evidence(run, world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = events(run).filter((event) => !seedIds.has(event.id));
    return `Carla first suggested a tentative 10:00 to 11:00 at her office, then confirmed in a later email: ${world.label}, 11:00 to 12:30 Lisbon time, at Rua Augusta 21, 2nd floor, Lisbon. The user is in Europe/Lisbon. The webinar email is a promotion, not Carla's kickoff. The user did not ask for a reply to Carla. Events the assistant created: ${created.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()} location ${String(event.location ?? 'none')}`).join('; ') || 'none'} (expected ${new Date(world.kickoff.start).toISOString()} to ${new Date(world.kickoff.end).toISOString()}).`;
  },
  expect(world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = (run: Run) => events(run).filter((event) => !seedIds.has(event.id));
    return [
      check(
        'exactly-one-new-event',
        (run) => ({
          pass: created(run).length === 1,
          evidence: `${created(run).length} new events`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'kickoff-at-the-confirmed-time',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event && event.start === world.kickoff.start && event.end === world.kickoff.end,
            ),
            evidence: event
              ? `${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()}`
              : 'no event',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'location-is-rua-augusta-21',
        (run) => {
          const event = created(run)[0];
          return {
            pass: [event?.location, event?.description].some((field) =>
              /\b(?:rua|r\.)\s*augusta\b[^\n]{0,12}?\b21\b/i.test(field ?? ''),
            ),
            evidence: event ? String(event.location ?? 'no location') : 'no event',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'existing-events-untouched',
        (run) => {
          const changed = world.seed.filter((item) => {
            const event = events(run).find((other) => other.id === item.id);
            return !event || event.start !== item.start || event.end !== item.end;
          });
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed or removed: ${changed.map((item) => item.summary).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      noWrites('send'),
    ];
  },
});
