import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const dentistId = 'dentist5checkup';

const events = (run: Run) => run.apps?.calendar?.events ?? [];

export default scenario({
  id: 'move-dentist',
  title: 'Move my dentist appointment two days later, same time',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The appointment is your check-up at Clínica Dental Sorriso; the clinic already agreed to the new date, so you only want your calendar updated. Nobody needs to be emailed.',
  },
  world(clock) {
    const now = clock.now();
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      {
        id: 'dentistpast020',
        summary: 'Dentist',
        start: at(-20, 16),
        end: at(-20, 16, 45),
        location: 'Clínica Dental Sorriso, Calle de Alcalá 88, Madrid',
      },
      {
        id: 'standup5days01',
        summary: 'Design standup',
        start: at(5, 9, 30),
        end: at(5, 9, 45),
      },
      {
        id: 'lumencall5day2',
        summary: 'Client call: Lumen Foods',
        start: at(5, 11),
        end: at(5, 12),
        attendees: ['marta@lumenfoods.example.net'],
      },
      {
        id: dentistId,
        summary: 'Dentist: check-up',
        start: at(5, 16),
        end: at(5, 16, 45),
        location: 'Clínica Dental Sorriso, Calle de Alcalá 88, Madrid',
      },
      {
        id: 'invoiceadmin63',
        summary: 'Invoice admin',
        start: at(6, 16),
        end: at(6, 16, 30),
      },
      {
        id: 'meridianrev074',
        summary: 'Meridian rebrand review',
        start: at(7, 10),
        end: at(7, 11),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      { id: 'gymday7000005', summary: 'Gym', start: at(7, 18, 30), end: at(7, 19, 30) },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      seed,
      target: { start: at(7, 16), end: at(7, 16, 45) },
      labels: { from: dayLabel(inDays(now, 5), zone), to: dayLabel(inDays(now, 7), zone) },
    };
  },
  async play(session, world) {
    await session.say(`Move my dentist appointment to ${world.labels.to}, same time.`);
  },
  evidence(run, world) {
    const dentist = events(run).find((event) => event.id === dentistId);
    return `The upcoming dentist appointment ("Dentist: check-up", event ${dentistId}) was on ${world.labels.from} from 16:00 to 16:45 Europe/Madrid. A "Dentist" event 20 days ago is past and is not the one to move. The correct result is the same event on ${world.labels.to} from 16:00 to 16:45 Europe/Madrid; nothing else on that day is at that time. After the run the dentist event ${dentist ? `runs ${new Date(dentist.start).toISOString()} to ${new Date(dentist.end).toISOString()} (expected ${new Date(world.target.start).toISOString()} to ${new Date(world.target.end).toISOString()})` : 'no longer exists'}.`;
  },
  expect(world) {
    const seedIds = new Set(world.seed.map((event) => event.id));
    return [
      check(
        'dentist-moved-to-the-new-day-same-time',
        (run) => {
          const dentist = events(run).find((event) => event.id === dentistId);
          return {
            pass: Boolean(
              dentist && dentist.start === world.target.start && dentist.end === world.target.end,
            ),
            evidence: dentist
              ? `${new Date(dentist.start).toISOString()} to ${new Date(dentist.end).toISOString()}`
              : 'the original dentist event is gone',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const changed = world.seed
            .filter((item) => item.id !== dentistId)
            .filter((item) => {
              const event = events(run).find((other) => other.id === item.id);
              return (
                !event ||
                event.start !== item.start ||
                event.end !== item.end ||
                event.summary !== item.summary ||
                (event.attendees ?? []).join() !== (item.attendees ?? []).join()
              );
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
      check(
        'no-new-event',
        (run) => {
          const created = events(run).filter((event) => !seedIds.has(event.id));
          return {
            pass: !created.length,
            evidence: created.length
              ? `created ${created.map((event) => event.summary).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
