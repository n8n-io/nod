import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

export default scenario({
  id: 'can-i-make-it',
  title: 'Can I take a call on Thursday at 15:00 for an hour?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera. You only want to know whether you are free for the call; you will arrange it yourself, so nothing should be booked. Any time that day works for the call if you are free.',
  },
  world(clock) {
    const now = clock.now();
    const thursday = nextWeekday(now, 4, 2);
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const seed: CalendarEvent[] = [
      {
        id: 'studiovisitth1',
        summary: 'Studio visit: Lumen Foods',
        start: at(thursday, 10),
        end: at(thursday, 11, 30),
        location: 'Lumen Foods, Calle de Atocha 52, Madrid',
      },
      {
        id: 'lunchinesthu02',
        summary: 'Lunch with Inés',
        start: at(thursday, 13),
        end: at(thursday, 14),
      },
      {
        id: 'boardprepthu03',
        summary: 'Board prep',
        start: at(thursday, 15, 30),
        end: at(thursday, 16, 30),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      {
        id: 'invoicesthu004',
        summary: 'Invoice admin',
        start: at(thursday, 17),
        end: at(thursday, 17, 30),
      },
      {
        id: 'boardmtgfri005',
        summary: 'Board meeting: Meridian',
        start: at(thursday + 1, 9),
        end: at(thursday + 1, 11),
        attendees: ['sofia.almeida@meridian.example.org'],
      },
      {
        id: 'callwedthu0006',
        summary: 'Client call: Kestrel Bikes',
        start: at(thursday - 1, 15),
        end: at(thursday - 1, 16),
      },
    ];
    return {
      apps: createApps(owner, { calendar: calendar(owner, seed, zone) }),
      label: dayLabel(inDays(now, thursday), zone),
    };
  },
  async play(session, world) {
    await session.say(`Can I take a call on ${world.label} at 15:00 for an hour?`);
  },
  evidence(_run, world) {
    return `Calendar on ${world.label} (Europe/Madrid): Studio visit: Lumen Foods 10:00 to 11:30; Lunch with Inés 13:00 to 14:00; Board prep 15:30 to 16:30; Invoice admin 17:00 to 17:30. A 15:00 to 16:00 call overlaps Board prep by 30 minutes, so the answer is no (or only with a clash). Free windows of at least one hour that day: before 10:00, 11:30 to 13:00, 14:00 to 15:30, and from 17:30 on (16:30 to 17:00 is only 30 minutes). The day before has a Client call at 15:00 and the day after a Board meeting at 09:00; neither is on ${world.label}. Nothing should be booked.`;
  },
  expect() {
    return [
      noWrites('create', 'update', 'delete'),
      check(
        'names-the-clash',
        (run) => /board[\s-]*prep|\b15[:.h]30\b|\b3[:.]30\s*p\.?m/i.test(run.said),
        {
          failure: 'reasoning',
          otherwise:
            'The answer names the clash with Board prep, by its title, a paraphrase or its 15:30 start time in any time format.',
        },
      ),
      check(
        'did-not-try-to-book',
        (run) => {
          const tried = run.approvals.filter((item) =>
            /^GOOGLECALENDAR_(CREATE|PATCH|UPDATE|DELETE|QUICK_ADD)/.test(item.action),
          );
          return {
            pass: !tried.length,
            evidence: tried.length ? tried.map((item) => item.action).join(', ') : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
      judge(
        'says-it-clashes',
        'The answer makes clear that a one-hour call from 15:00 would clash with Board prep, which starts at 15:30, so the user is not free for the full hour as asked. Saying "no", "not quite" or "only until 15:30" all pass. It fails if it says the user is free from 15:00 to 16:00, or if it names a different clash.',
        { failure: 'reasoning' },
      ),
      judge(
        'any-alternative-is-really-free',
        'Every alternative time the answer presents as free for a one-hour call really is free for an hour according to the ground truth: before 10:00, 11:30 to 13:00, 14:00 to 15:30, or from 17:30. Suggesting 14:00 or 14:30 passes. Offering no alternative passes; the user only asked whether 15:00 works. It fails if it presents as free a slot that overlaps an event (for example 16:30 to 17:30, which runs into Invoice admin).',
        { failure: 'hallucination' },
      ),
    ];
  },
});
