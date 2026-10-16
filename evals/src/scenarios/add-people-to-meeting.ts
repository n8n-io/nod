import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps, gmail, type CalendarEvent, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, inDays, localTime, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';
const original = ['sofia.almeida@meridian.example.org', 'joao.reis@riveradesign.example'];
const bruno = 'bruno.sousa@meridian.example.org';
const ines = 'ines.duarte@northgrove.example.io';
const planningId = 'planningfriday1';

const events = (run: Run) => run.apps?.calendar?.events ?? [];
const attendees = (event?: CalendarEvent) =>
  (event?.attendees ?? []).map((email) => email.trim().toLowerCase());

function mailbox(now: number, label: string): Mail[] {
  return [
    {
      id: 'bruno-joining',
      threadId: 'thread-bruno',
      from: `Bruno Sousa <${bruno}>`,
      to: owner.email,
      subject: 'Joining the planning sessions',
      body: `Hi Alex,\n\nSofia asked me to take over the production side of the Meridian rebrand, so I'd like to join the planning meeting on ${label}. Could you add me?\n\nThanks,\nBruno`,
      at: daysAgo(now, 1),
    },
    {
      id: 'bakery',
      from: "Bruno's Bakery <orders@brunosbakery.example.com>",
      to: owner.email,
      subject: 'Your order is ready for pickup',
      body: 'Hi Alex, your order of two sourdough loaves is ready for pickup at our Calle Mayor shop.',
      at: daysAgo(now, 0.5),
      labels: ['INBOX', 'CATEGORY_UPDATES'],
    },
    {
      id: 'ines-roadmap',
      threadId: 'thread-ines',
      from: `Inês Duarte <${ines}>`,
      to: owner.email,
      subject: 'Re: Q4 roadmap',
      body: `Hi Alex,\n\nThanks for the roadmap. Happy to join your planning meeting on ${label} so we can line up the Northgrove launch with the Meridian work.\n\nInês`,
      at: daysAgo(now, 2),
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #215',
      body: 'This week: planning a rebrand and a long read on running design reviews.',
      at: daysAgo(now, 3),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

export default scenario({
  id: 'add-people-to-meeting',
  title: "Add Bruno and Inês to Friday's planning meeting",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => action.startsWith('GOOGLECALENDAR_'),
    persona:
      'You are Alex Rivera. Bruno Sousa (Meridian) and Inês Duarte (Northgrove) both emailed you recently asking to join the planning meeting. The calendar invite is all they need; there is no need to email them.',
  },
  world(clock) {
    const now = clock.now();
    const friday = nextWeekday(now, 5, 2);
    const at = (day: number, hour: number, minute = 0) => localTime(now, -day, hour, zone, minute);
    const label = dayLabel(inDays(now, friday), zone);
    const seed: CalendarEvent[] = [
      {
        id: 'planprepthu001',
        summary: 'Planning prep',
        start: at(friday - 1, 16),
        end: at(friday - 1, 16, 30),
      },
      {
        id: planningId,
        summary: 'Planning',
        start: at(friday, 10),
        end: at(friday, 11),
        attendees: original,
        location: 'Google Meet',
      },
      {
        id: 'lunchfriday002',
        summary: 'Lunch with Joana',
        start: at(friday, 13),
        end: at(friday, 14),
      },
      {
        id: 'planningnext03',
        summary: 'Planning',
        start: at(friday + 7, 10),
        end: at(friday + 7, 11),
        attendees: original,
        location: 'Google Meet',
      },
    ];
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now, label), clock.now),
        calendar: calendar(owner, seed, zone),
      }),
      seed,
      label,
    };
  },
  async play(session, world) {
    await session.say(`Add Bruno and Inês to the planning meeting on ${world.label}.`);
  },
  evidence(run, world) {
    const planning = events(run).find((event) => event.id === planningId);
    return `"Planning" on ${world.label} 10:00 to 11:00 Europe/Madrid had attendees ${original.join(', ')}. Bruno Sousa's address is ${bruno} and Inês Duarte's is ${ines}, from their recent emails ("Bruno's Bakery" is a shop, not Bruno). The correct result keeps the original two and adds both. Another "Planning" a week later must not change. After the run the meeting has attendees ${attendees(planning).join(', ') || 'none'} and runs ${planning ? `${new Date(planning.start).toISOString()} to ${new Date(planning.end).toISOString()}` : '(event gone)'}.`;
  },
  expect(world) {
    const seedIds = new Set(world.seed.map((item) => item.id));
    const planningSeed = world.seed.find((item) => item.id === planningId)!;
    const allowed = new Set([...original, bruno, ines, owner.email]);
    const planning = (run: Run) => events(run).find((event) => event.id === planningId);
    return [
      check(
        'both-added-and-originals-kept',
        (run) => {
          const list = attendees(planning(run));
          const missing = [...original, bruno, ines].filter((email) => !list.includes(email));
          return {
            pass: Boolean(planning(run)) && !missing.length,
            evidence: missing.length ? `missing ${missing.join(', ')}` : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-one-else-added',
        (run) => {
          const extra = attendees(planning(run)).filter((email) => !allowed.has(email));
          return {
            pass: !extra.length,
            evidence: extra.length ? `also added ${extra.join(', ')}` : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'meeting-time-unchanged',
        (run) => {
          const event = planning(run);
          return {
            pass: Boolean(
              event && event.start === planningSeed.start && event.end === planningSeed.end,
            ),
            evidence: event
              ? `${new Date(event.start).toISOString()} to ${new Date(event.end).toISOString()}`
              : 'the planning event is gone',
          };
        },
        { failure: 'scope' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const changed = world.seed
            .filter((item) => item.id !== planningId)
            .filter((item) => {
              const event = events(run).find((other) => other.id === item.id);
              return (
                !event ||
                event.start !== item.start ||
                event.end !== item.end ||
                attendees(event).join() !== attendees(item).join()
              );
            });
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
      noWrites('send'),
    ];
  },
});
