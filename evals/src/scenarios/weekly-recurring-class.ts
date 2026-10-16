import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime, nextWeekOn } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

function weeklyOnTuesdays(rules: string[]) {
  const text = rules.join(';').toUpperCase();
  const byDay = /BYDAY=([^;\s]+)/.exec(text)?.[1];
  const interval = /INTERVAL=(\d+)/.exec(text)?.[1];
  return (
    /FREQ=WEEKLY/.test(text) &&
    (!byDay || byDay === 'TU') &&
    (!interval || interval === '1') &&
    !/COUNT=|UNTIL=/.test(text)
  );
}

export default scenario({
  id: 'weekly-recurring-class',
  title: 'Add yoga every Tuesday at 19:00 for an hour, starting next week',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: (action) => action === 'GOOGLECALENDAR_CREATE_EVENT',
    persona:
      'You are Alex Rivera. Yoga is a weekly class at Estudio Prana with no end date. Any title is fine and you do not need a reminder or a location.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const tuesday = nextWeekOn(now, 2);
    const monday = nextWeekOn(now, 1);
    const wednesday = nextWeekOn(now, 3);
    const seed: CalendarEvent[] = [
      {
        id: 'spanishclass01',
        summary: 'Spanish class',
        start: at(monday, 19),
        end: at(monday, 20),
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      },
      {
        id: 'lumencalltue02',
        summary: 'Client call: Lumen Foods',
        start: at(tuesday, 10),
        end: at(tuesday, 11),
        attendees: ['marta@lumenfoods.example.net'],
      },
      {
        id: 'invoicesadmin3',
        summary: 'Invoice admin',
        start: at(tuesday, 17),
        end: at(tuesday, 17, 30),
      },
      {
        id: 'gymweekly00004',
        summary: 'Gym',
        start: at(wednesday, 19),
        end: at(wednesday, 20),
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
      },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      first: { start: at(tuesday, 19), end: at(tuesday, 20) },
      label: dayLabel(inDays(now, tuesday), zone),
    };
  },
  async play(session, world) {
    await session.say(
      `Add yoga every Tuesday at 19:00 for an hour, starting next week, so the first one is ${world.label}.`,
    );
  },
  evidence(run, world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = events(run).filter((event) => !seedIds.has(event.id));
    return `The correct result is one recurring event whose first occurrence is ${world.label} 19:00 to 20:00 Europe/Madrid, repeating weekly on Tuesdays (RRULE FREQ=WEEKLY, optionally BYDAY=TU) with no end. Events the assistant created: ${created.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()} recurrence ${(event.recurrence ?? []).join(' ') || 'none'}`).join('; ') || 'none'}.`;
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
        'first-one-is-next-tuesday-at-19-for-an-hour',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event && event.start === world.first.start && event.end === world.first.end,
            ),
            evidence: event
              ? `${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()}, expected ${new Date(world.first.start).toISOString()}`
              : 'no event',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'repeats-every-tuesday',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(event && weeklyOnTuesdays(event.recurrence ?? [])),
            evidence: event ? (event.recurrence ?? []).join(' ') || 'no recurrence' : 'no event',
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
    ];
  },
});
