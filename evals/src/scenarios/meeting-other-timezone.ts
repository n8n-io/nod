import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localDate, localTime, nextWeekOn } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const newYork = 'America/New_York';
const priya = 'priya.nair@harbor.example.com';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

const wallClock = (at: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

export default scenario({
  id: 'meeting-other-timezone',
  title: 'Set up 30 minutes with Priya next Wednesday at 10am her time, she is in New York',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => action === 'GOOGLECALENDAR_CREATE_EVENT',
    persona:
      'You are Alex Rivera, based in Madrid. Priya Nair is a client at Harbor in New York; the call is to walk through the brand guidelines. Any title is fine, and the calendar invite is all she needs.',
  },
  world(clock) {
    const now = clock.now();
    const offset = nextWeekOn(now, 3);
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const target = localDate(inDays(now, offset), zone);
    const ahead =
      (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${localDate(now, newYork)}T00:00:00Z`)) /
      86_400_000;
    const start = localTime(now, -ahead, 10, newYork);
    const seed: CalendarEvent[] = [
      {
        id: 'standupwed0001',
        summary: 'Design standup',
        start: at(offset, 9, 30),
        end: at(offset, 9, 45),
      },
      {
        id: 'designrevwed02',
        summary: 'Design review: Meridian',
        start: at(offset, 10),
        end: at(offset, 11),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      {
        id: 'lunchwed000003',
        summary: 'Lunch with Joana',
        start: at(offset, 13),
        end: at(offset, 14),
      },
      { id: 'gymwed00000004', summary: 'Gym', start: at(offset, 19), end: at(offset, 20) },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      start,
      label: dayLabel(inDays(now, offset), zone),
      madrid: wallClock(start, zone),
    };
  },
  async play(session, world) {
    await session.say(
      `Set up 30 minutes with Priya (${priya}) next Wednesday, ${world.label}, at 10am her time, she's in New York.`,
    );
  },
  evidence(run, world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = events(run).filter((event) => !seedIds.has(event.id));
    return `10:00 in New York on ${world.label} is ${new Date(world.start).toISOString()}, which is ${world.madrid} in Madrid that day. The correct event runs 30 minutes from that instant with ${priya} invited. Existing events that day (Madrid time): Design standup 09:30, Design review: Meridian 10:00 to 11:00, Lunch with Joana 13:00 to 14:00, Gym 19:00 to 20:00. Events the assistant created: ${created.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()} attendees ${(event.attendees ?? []).join(', ') || 'none'}`).join('; ') || 'none'}.`;
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
        'starts-at-10-new-york-time',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(event && event.start === world.start),
            evidence: event
              ? `${new Date(event.start).toISOString()}, expected ${new Date(world.start).toISOString()}`
              : 'no event',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'thirty-minutes-with-priya',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event &&
              event.end - event.start === 30 * 60_000 &&
              (event.attendees ?? []).some((email) => email.toLowerCase() === priya),
            ),
            evidence: event
              ? `${Math.round((event.end - event.start) / 60_000)} min, attendees ${(event.attendees ?? []).join(', ') || 'none'}`
              : 'no event',
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
      judge(
        'states-the-time-correctly',
        `Any time the assistant gives for the new meeting is correct: 10:00 New York time on ${world.label} is ${world.madrid} in Madrid. Giving only one of the two is fine. It fails if it states a wrong Madrid or New York time for the meeting.`,
        { required: false, aspect: 'process', failure: 'hallucination' },
      ),
    ];
  },
});
