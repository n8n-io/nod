import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const leo = 'leo.martins@kestrel.example.net';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

export default scenario({
  id: 'book-call-in-window',
  title: "Book a 30-minute call with Leo tomorrow between 10 and 12, wherever I'm free",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action) => action === 'GOOGLECALENDAR_CREATE_EVENT',
    persona:
      'You are Alex Rivera. Leo Martins at Kestrel wants to talk about the new catalogue. Any title is fine, the calendar invite is all he needs, and your other meetings stay where they are.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      { id: 'standuptmr0001', summary: 'Design standup', start: at(1, 9, 30), end: at(1, 9, 45) },
      {
        id: 'meridianchk002',
        summary: 'Meridian check-in',
        start: at(1, 10),
        end: at(1, 10, 30),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      {
        id: 'portfoliorev03',
        summary: 'Portfolio review',
        start: at(1, 10, 45),
        end: at(1, 11, 30),
      },
      { id: 'lunchjoana0004', summary: 'Lunch with Joana', start: at(1, 12), end: at(1, 13) },
      {
        id: 'lumencalltmr05',
        summary: 'Client call: Lumen Foods',
        start: at(1, 15),
        end: at(1, 16),
        attendees: ['marta@lumenfoods.example.net'],
      },
      { id: 'invoicestoday6', summary: 'Invoice admin', start: at(0, 11), end: at(0, 11, 30) },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      range: { from: at(1, 10), to: at(1, 12) },
      label: dayLabel(inDays(now, 1), zone),
    };
  },
  async play(session) {
    await session.say(
      `Book a 30-minute call with Leo (${leo}) tomorrow between 10 and 12, wherever I'm free.`,
    );
  },
  evidence(run, world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = events(run).filter((event) => !seedIds.has(event.id));
    return `Tomorrow, ${world.label}, Europe/Madrid: Design standup 09:30 to 09:45, Meridian check-in 10:00 to 10:30, Portfolio review 10:45 to 11:30, Lunch with Joana 12:00 to 13:00, Client call 15:00 to 16:00. Between 10:00 and 12:00 the only free 30 minutes are 11:30 to 12:00 (10:30 to 10:45 is only 15 minutes). Events the assistant created: ${created.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()} attendees ${(event.attendees ?? []).join(', ') || 'none'}`).join('; ') || 'none'}.`;
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
        'thirty-minutes-with-leo',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event &&
              event.end - event.start === 30 * 60_000 &&
              (event.attendees ?? []).some((email) => email.toLowerCase() === leo),
            ),
            evidence: event
              ? `${Math.round((event.end - event.start) / 60_000)} min, attendees ${(event.attendees ?? []).join(', ') || 'none'}`
              : 'no event',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'inside-ten-to-twelve',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(event && event.start >= world.range.from && event.end <= world.range.to),
            evidence: event
              ? `${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()}`
              : 'no event',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'overlaps-nothing',
        (run) => {
          const event = created(run)[0];
          const clash = event
            ? world.seed.find((other) => event.start < other.end && event.end > other.start)
            : undefined;
          return {
            pass: Boolean(event) && !clash,
            evidence: clash ? `overlaps "${clash.summary}"` : event ? undefined : 'no event',
          };
        },
        { failure: 'reasoning' },
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
    ];
  },
});
