import { check, judge, scenario } from '../scenario.ts';
import { noWrites } from '../checks.ts';
import { calendar, createApps } from '../world/apps.ts';
import { dayLabel, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Pacific/Auckland';
const eventId = 'release-handoff-local-date';

export default scenario({
  id: 'calendar-next-local-day',
  title: 'Read a meeting whose local date differs from its UTC date',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  timeZone: zone,
  user: { approve: false },
  world(clock) {
    const start = localTime(clock.now(), -3, 0, zone, 20);
    return {
      start,
      label: dayLabel(start, zone),
      apps: createApps(owner, {
        calendar: calendar(
          owner,
          [
            {
              id: eventId,
              summary: 'Release handoff',
              start,
              end: start + 30 * 60_000,
            },
          ],
          zone,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('What date and time is Release handoff in my calendar? Use my local time.');
  },
  evidence(_run, world) {
    return `The owner uses ${zone}. Release handoff starts on ${world.label} at 00:20 local time (12:20 a.m.) and ends at 00:50. Its stored UTC start is ${new Date(world.start).toISOString()}, on the previous date. No calendar changes are requested.`;
  },
  expect(world) {
    return [
      check(
        'read-the-calendar-record',
        (run) =>
          run.tools.some(
            (call) =>
              !call.isError &&
              String(call.input?.action).startsWith('GOOGLECALENDAR_') &&
              call.output.includes(eventId),
          ),
        { aspect: 'process', failure: 'tool' },
      ),
      judge(
        'reports-the-local-date-and-time',
        `The answer gives Release handoff on ${world.label} at 00:20 (12:20 a.m.) in the owner's ${zone} time zone. It must not present the stored UTC date or UTC clock time as the owner's local time. Any clear date and time format passes.`,
        { failure: 'reasoning' },
      ),
      noWrites('create', 'update', 'delete', 'send'),
    ];
  },
});
