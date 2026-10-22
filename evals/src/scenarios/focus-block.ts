import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

export default scenario({
  id: 'focus-block',
  title: 'Block two hours for focus tomorrow afternoon',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: (action) => action === 'GOOGLECALENDAR_CREATE_EVENT',
    persona:
      'You are Alex Rivera. Any free two-hour stretch tomorrow afternoon is fine, with any title. Your existing meetings stay where they are.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      { id: 'invoiceadmin00', summary: 'Invoice admin', start: at(0, 16), end: at(0, 16, 30) },
      { id: 'standuptmr0001', summary: 'Standup', start: at(1, 9, 30), end: at(1, 9, 45) },
      { id: 'lunchtmr000002', summary: 'Lunch', start: at(1, 13), end: at(1, 14) },
      {
        id: 'clientcalltmr3',
        summary: 'Client call',
        start: at(1, 15),
        end: at(1, 15, 30),
        attendees: ['tom.hale@kestrelbikes.example.net'],
      },
      { id: 'schoolpickup04', summary: 'School pickup', start: at(1, 18), end: at(1, 18, 30) },
      { id: 'standupday2005', summary: 'Standup', start: at(2, 9, 30), end: at(2, 9, 45) },
      { id: 'workshopday206', summary: 'Harborline workshop', start: at(2, 14), end: at(2, 17) },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      afternoon: { from: at(1, 12), to: at(1, 19) },
      label: dayLabel(inDays(now, 1), zone),
    };
  },
  async play(session) {
    await session.say('Block two hours for focus tomorrow afternoon.');
  },
  evidence(run, world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const created = events(run).filter((event) => !seedIds.has(event.id));
    return `Tomorrow, ${world.label}, Europe/Madrid: Standup 09:30 to 09:45, Lunch 13:00 to 14:00, Client call 15:00 to 15:30, School pickup 18:00 to 18:30. The only free two-hour stretch in the afternoon is between 15:30 and 18:00 (for example 15:30 to 17:30 or 16:00 to 18:00). Events the assistant created: ${created.map((event) => `"${event.summary}" ${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()}`).join('; ') || 'none'}.`;
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
        'two-hours-in-the-afternoon',
        (run) => {
          const event = created(run)[0];
          return {
            pass: Boolean(
              event &&
              event.end - event.start === 120 * 60_000 &&
              event.start >= world.afternoon.from &&
              event.end <= world.afternoon.to,
            ),
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
