import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { calendar, createApps } from '../world/apps.ts';
import { notion } from '../world/notion.ts';
import { dayLabel, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const todo = '6f1d2c8e-4b7a-4f3e-9c21-5a8e0d3b7f41';
const seeded = [
  { id: '0b6a7e52-1d3c-4f8e-a2b9-7c4d5e6f8a01', Name: 'Renew passport', Status: 'Not started' },
  { id: '0b6a7e52-1d3c-4f8e-a2b9-7c4d5e6f8a02', Name: 'Book car service', Status: 'In progress' },
  {
    id: '0b6a7e52-1d3c-4f8e-a2b9-7c4d5e6f8a03',
    Name: 'Send invoice to Harborline',
    Status: 'Done',
  },
];
const morning = [
  { summary: 'Portfolio review with Lena', key: /portfolio review/i, hour: 9, minutes: 45 },
  { summary: 'Kickoff call: Kestrel Bikes', key: /kestrel/i, hour: 11, minutes: 60 },
];
const wrongDay = [
  { summary: 'Design critique', key: /design critique/i },
  { summary: 'Dentist appointment', key: /dentist/i },
];

const newRows = (run: Run) =>
  (run.apps?.notion?.pages ?? []).filter(
    (page) => page.database === todo && !seeded.some((row) => row.id === page.id),
  );

export default scenario({
  id: 'two-requests-one-message',
  title:
    "Add 'buy milk' to my Notion to-do list, and tell me what's on my calendar tomorrow morning",
  capabilities: ['progress', 'apps'],
  tier: 'release',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera, a freelance brand designer. Your to-do list lives in a Notion database called "To-do list". Any status or due date for the new item is fine. You have no other requests.',
  },
  world(clock) {
    const now = clock.now();
    const at = (back: number, hour: number, minute = 0) =>
      localTime(now, back, hour, 'Europe/Madrid', minute);
    const events = [
      ...morning.map((event) => ({
        summary: event.summary,
        start: at(-1, event.hour),
        end: at(-1, event.hour) + event.minutes * 60_000,
      })),
      { summary: 'Studio photoshoot', start: at(-1, 15), end: at(-1, 17) },
      { summary: 'Design critique', start: at(0, 10), end: at(0, 11) },
      { summary: 'Dentist appointment', start: at(-2, 9, 30), end: at(-2, 10, 15) },
    ];
    return {
      apps: createApps(owner, {
        calendar: calendar(owner, events, 'Europe/Madrid'),
        notion: notion(
          owner,
          {
            pages: [
              {
                id: 'c3e9a1f0-5b2d-4c7e-8f1a-2d3b4c5d6e70',
                title: 'Meeting notes',
                markdown: '# Meeting notes\n- Harborline: send the revised moodboard',
              },
            ],
            databases: [
              {
                id: todo,
                title: 'To-do list',
                schema: {
                  Name: { type: 'title' },
                  Status: { type: 'status', options: ['Not started', 'In progress', 'Done'] },
                  Due: { type: 'date' },
                },
                rows: seeded.map(({ id, Name, Status }) => ({ id, properties: { Name, Status } })),
              },
              {
                id: 'a8d4e2b1-7c3f-4e9a-b5d6-1f2e3a4b5c60',
                title: 'Reading list',
                schema: { Name: { type: 'title' }, Author: { type: 'rich_text' } },
                rows: [{ properties: { Name: 'Grid Systems', Author: 'Josef Müller-Brockmann' } }],
              },
            ],
          },
          clock.now,
        ),
      }),
      tomorrow: dayLabel(at(-1, 12)),
    };
  },
  async play(session) {
    await session.say(
      "Add 'buy milk' to my Notion to-do list, and tell me what's on my calendar tomorrow morning.",
    );
  },
  evidence(run, world) {
    const rows = (run.apps?.notion?.pages ?? [])
      .filter((page) => page.database === todo)
      .map((page) => `${page.title}${page.archived ? ' (archived)' : ''}`);
    return `Tomorrow is ${world.tomorrow}. Tomorrow morning has exactly two events: "Portfolio review with Lena" 09:00-09:45 and "Kickoff call: Kestrel Bikes" 11:00-12:00. Tomorrow afternoon has "Studio photoshoot" 15:00-17:00. Today has "Design critique" 10:00 and the day after tomorrow has "Dentist appointment" 09:30; neither is tomorrow. Rows now in the Notion "To-do list" database: ${rows.join('; ')}.`;
  },
  expect() {
    return [
      check(
        'one-milk-row-added-to-the-to-do-list',
        (run) => {
          const rows = newRows(run).filter((page) => !page.archived);
          return {
            pass: rows.length === 1 && /milk/i.test(rows[0].title),
            evidence: rows.length
              ? `new rows: ${rows.map((row) => row.title).join(', ')}`
              : 'no new row in the To-do list database',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'names-both-morning-events',
        (run) => {
          const missing = morning.filter((event) => !event.key.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((event) => event.summary).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The answer refers to both of tomorrow morning's events, the portfolio review with Lena and the Kestrel Bikes kickoff call, in any wording: its title, a paraphrase, a participant or its time.",
        },
      ),
      check(
        'does-not-mix-in-other-days',
        (run) => {
          const found = wrongDay.filter((event) => event.key.test(run.final));
          return {
            pass: !found.length,
            evidence: found.length
              ? `mentions ${found.map((event) => event.summary).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      check(
        'other-to-do-rows-untouched',
        (run) => {
          const pages = run.apps?.notion?.pages ?? [];
          const changed = seeded.filter((row) => {
            const page = pages.find((item) => item.id === row.id);
            return (
              !page ||
              page.archived ||
              page.title !== row.Name ||
              page.properties?.Status !== row.Status
            );
          });
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed ${changed.map((row) => row.Name).join(', ')}`
              : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
