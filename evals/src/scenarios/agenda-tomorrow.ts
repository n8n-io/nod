import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, type CalendarEvent } from '../world/apps.ts';
import { dayLabel, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

interface Slot {
  id: string;
  summary: string;
  key: RegExp;
  day: number;
  hour: number;
  minute: number;
  minutes: number;
  location?: string;
  attendees?: string[];
}

const slots: Slot[] = [
  {
    id: 'todayinvoices01',
    summary: 'Invoice admin',
    key: /invoice admin/i,
    day: 0,
    hour: 10,
    minute: 0,
    minutes: 30,
  },
  { id: 'todaygym0002', summary: 'Gym', key: /\bgym\b/i, day: 0, hour: 19, minute: 0, minutes: 60 },
  {
    id: 'tmrsupplier03',
    summary: 'Supplier call: Papelaria Norte',
    key: /papelaria/i,
    day: 1,
    hour: 8,
    minute: 30,
    minutes: 30,
  },
  {
    id: 'tmrportfolio04',
    summary: 'Portfolio review with Lena',
    key: /portfolio/i,
    day: 1,
    hour: 11,
    minute: 0,
    minutes: 60,
    location: 'Café Comercial, Glorieta de Bilbao 7, Madrid',
  },
  {
    id: 'tmrkestrel005',
    summary: 'Kestrel brand sync',
    key: /kestrel/i,
    day: 1,
    hour: 14,
    minute: 0,
    minutes: 45,
    attendees: ['tom.hale@kestrelbikes.example.net', 'mia.chen@kestrelbikes.example.net'],
  },
  {
    id: 'tmrprints0006',
    summary: 'Pick up framed prints',
    key: /framed|prints/i,
    day: 1,
    hour: 17,
    minute: 30,
    minutes: 30,
    location: 'Marcos Alba, Calle del Pez 14, Madrid',
  },
  {
    id: 'aftrhaircut07',
    summary: 'Haircut at Barbería Sol',
    key: /barber[ií]a|haircut/i,
    day: 2,
    hour: 9,
    minute: 0,
    minutes: 45,
  },
  {
    id: 'aftrcarsvc008',
    summary: 'Car service at Talleres Ruiz',
    key: /talleres|car service/i,
    day: 2,
    hour: 16,
    minute: 0,
    minutes: 60,
  },
];

const tomorrow = slots.filter((slot) => slot.day === 1);
const dayAfter = slots.filter((slot) => slot.day === 2);
const hhmm = (slot: Slot, offset = 0) => {
  const total = slot.hour * 60 + slot.minute + offset;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

export default scenario({
  id: 'agenda-tomorrow',
  title: "What's on my calendar tomorrow?",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You only want to know what is on your calendar tomorrow; you do not want anything changed.',
  },
  world(clock) {
    const now = clock.now();
    const events: CalendarEvent[] = slots.map((slot) => {
      const start = localTime(now, -slot.day, slot.hour, zone, slot.minute);
      return {
        id: slot.id,
        summary: slot.summary,
        start,
        end: start + slot.minutes * 60_000,
        ...(slot.location ? { location: slot.location } : {}),
        ...(slot.attendees ? { attendees: slot.attendees } : {}),
      };
    });
    return {
      apps: createApps(owner, { calendar: calendar(owner, events, zone) }),
      labels: {
        today: dayLabel(now, zone),
        tomorrow: dayLabel(inDays(now, 1), zone),
        dayAfter: dayLabel(inDays(now, 2), zone),
      },
    };
  },
  async play(session) {
    await session.say("What's on my calendar tomorrow?");
  },
  evidence(_run, world) {
    const line = (slot: Slot) =>
      `"${slot.summary}" ${hhmm(slot)} to ${hhmm(slot, slot.minutes)}${slot.location ? `, at ${slot.location}` : ''}${slot.attendees ? `, with ${slot.attendees.join(', ')}` : ''}`;
    return [
      `Calendar (Europe/Madrid). Today, ${world.labels.today}: ${slots
        .filter((slot) => slot.day === 0)
        .map(line)
        .join('; ')}.`,
      `Tomorrow, ${world.labels.tomorrow}: ${tomorrow.map(line).join('; ')}. These four are the whole answer.`,
      `Day after tomorrow, ${world.labels.dayAfter}: ${dayAfter.map(line).join('; ')}. These are not tomorrow.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'names-all-four-of-tomorrows-events',
        (run) => {
          const missing = tomorrow.filter((slot) => !slot.key.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((slot) => slot.summary).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The answer refers to each of tomorrow's four events, Supplier call: Papelaria Norte, Portfolio review with Lena, Kestrel brand sync and Pick up framed prints, in any wording: its title, a paraphrase, a participant, its place or its time.",
        },
      ),
      check(
        'leaves-out-the-day-after-tomorrow',
        (run) => {
          const extra = dayAfter.filter((slot) => slot.key.test(run.final));
          return {
            pass: !extra.length,
            evidence: extra.length
              ? `also named ${extra.map((slot) => slot.summary).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'scope' },
      ),
      judge(
        'only-tomorrow-is-presented-as-tomorrow',
        `The answer presents only these four events as tomorrow's: ${tomorrow.map((slot) => `"${slot.summary}"`).join(', ')}. It fails if it presents any of these as happening tomorrow: ${[...dayAfter].map((slot) => `"${slot.summary}"`).join(', ')} (they are the day after tomorrow) or any of today's events. Mentioning them clearly as another day passes.`,
        { failure: 'reasoning' },
      ),
      noWrites('create', 'update', 'delete'),
      judge(
        'times-are-right',
        `The answer gives the start time of each of tomorrow's four events, and every time it gives is correct in Europe/Madrid time: ${tomorrow.map((slot) => `"${slot.summary}" starts ${hhmm(slot)} and ends ${hhmm(slot, slot.minutes)}`).join('; ')}. End times are optional, but any end time given must match. Any time format passes (8:30, 08:30, 8.30 am). It fails if an event is missing a start time or any stated time is wrong.`,
        { failure: 'reasoning' },
      ),
    ];
  },
});
