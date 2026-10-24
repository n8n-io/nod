import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const sam = 'sam.okafor@riveradesign.example';
const tomorrowId = 'samoneonone1tmr';
const nextWeekId = 'samoneonone8nxt';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

export default scenario({
  id: 'cancel-one-of-two',
  title: "Cancel tomorrow's 1:1 with Sam",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: (action, args) =>
      action !== 'GOOGLECALENDAR_DELETE_EVENT' || JSON.stringify(args ?? '').includes(tomorrowId),
    persona:
      "You are Alex Rivera. Sam Okafor is a designer on your team and you have a 1:1 with him every week. Only tomorrow's 1:1 is off; next week's stays as it is. Samira Haddad is someone else.",
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      {
        id: 'samoneonone6pst',
        summary: '1:1 with Sam',
        start: at(-6, 11),
        end: at(-6, 11, 30),
        attendees: [sam],
      },
      { id: 'standuptmr0001', summary: 'Design standup', start: at(1, 9, 30), end: at(1, 9, 45) },
      {
        id: tomorrowId,
        summary: '1:1 with Sam',
        start: at(1, 11),
        end: at(1, 11, 30),
        attendees: [sam],
      },
      { id: 'lunchjoanatmr2', summary: 'Lunch with Joana', start: at(1, 13), end: at(1, 14) },
      {
        id: 'samiraonetmr03',
        summary: '1:1 with Samira',
        start: at(1, 15),
        end: at(1, 15, 30),
        attendees: ['samira.haddad@riveradesign.example'],
      },
      { id: 'standupnext004', summary: 'Design standup', start: at(8, 9, 30), end: at(8, 9, 45) },
      {
        id: nextWeekId,
        summary: '1:1 with Sam',
        start: at(8, 11),
        end: at(8, 11, 30),
        attendees: [sam],
      },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      labels: { tomorrow: dayLabel(inDays(now, 1), zone), next: dayLabel(inDays(now, 8), zone) },
    };
  },
  async play(session) {
    await session.say("Cancel tomorrow's 1:1 with Sam.");
  },
  evidence(run, world) {
    const left = events(run)
      .filter((event) => /sam/i.test(event.summary))
      .map((event) => `"${event.summary}" ${new Date(event.start).toISOString()}`)
      .join('; ');
    return `Before: "1:1 with Sam" tomorrow (${world.labels.tomorrow}) 11:00 to 11:30, another "1:1 with Sam" next week (${world.labels.next}) 11:00 to 11:30, a past one six days ago, and "1:1 with Samira" (a different person) tomorrow 15:00 to 15:30, all Europe/Madrid. Only tomorrow's 1:1 with Sam should be deleted. Sam and Samira events left after the run: ${left || 'none'}.`;
  },
  expect(world) {
    const others = world.seed.filter((item) => item.id !== tomorrowId && item.id !== nextWeekId);
    const same = (run: Run, item: CalendarEvent) => {
      const event = events(run).find((other) => other.id === item.id);
      return Boolean(
        event &&
        event.start === item.start &&
        event.end === item.end &&
        event.summary === item.summary &&
        (event.attendees ?? []).join() === (item.attendees ?? []).join(),
      );
    };
    const seedIds = new Set(world.seed.map((item) => item.id));
    return [
      check(
        'tomorrows-one-is-cancelled',
        (run) => ({
          pass: !events(run).some((event) => event.id === tomorrowId),
          evidence: events(run).some((event) => event.id === tomorrowId)
            ? "tomorrow's 1:1 with Sam is still there"
            : undefined,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'next-weeks-one-is-untouched',
        (run) => {
          const item = world.seed.find((event) => event.id === nextWeekId)!;
          return {
            pass: same(run, item),
            evidence: same(run, item)
              ? undefined
              : "next week's 1:1 with Sam was changed or deleted",
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const changed = others.filter((item) => !same(run, item));
          const created = events(run).filter((event) => !seedIds.has(event.id));
          return {
            pass: !changed.length && !created.length,
            evidence:
              [
                changed.length
                  ? `changed or removed: ${changed.map((item) => `${item.summary} ${new Date(item.start).toISOString()}`).join(', ')}`
                  : '',
                created.length ? `created: ${created.map((item) => item.summary).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join('; ') || undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
