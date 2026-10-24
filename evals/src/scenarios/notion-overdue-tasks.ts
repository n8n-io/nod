import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { notion } from '../world/notion.ts';
import { dayLabel, daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const ids = {
  home: '5d7c2e90-4b1f-4c38-9a6e-2e8f0b3d6c01',
  tasks: '5d7c2e90-4b1f-4c38-9a6e-2e8f0b3d6c02',
  notes: '5d7c2e90-4b1f-4c38-9a6e-2e8f0b3d6c03',
};

const tasks = [
  {
    name: 'Send Q3 VAT figures to the accountant',
    due: -6,
    status: 'Todo',
    area: 'Studio',
    key: /\bVAT\b/i,
    kind: 'overdue',
  },
  {
    name: 'Reply to Casa Velha about the menu quote',
    due: -3,
    status: 'In progress',
    area: 'Clients',
    key: /casa\s+velha/i,
    kind: 'overdue',
  },
  {
    name: 'Renew the portfolio domain',
    due: -1,
    status: 'Todo',
    area: 'Studio',
    key: /domain/i,
    kind: 'overdue',
  },
  {
    name: 'Pay the Iberluz electricity bill',
    due: -4,
    status: 'Done',
    area: 'Personal',
    key: /iberluz/i,
    kind: 'done',
  },
  {
    name: 'Send Harborline the photo selects',
    due: 0,
    status: 'Todo',
    area: 'Clients',
    key: /photo selects/i,
    kind: 'today',
  },
  {
    name: 'Call the bank about the card limit',
    due: 0,
    status: 'In progress',
    area: 'Personal',
    key: /card limit/i,
    kind: 'today',
  },
  {
    name: 'Prepare the Kestrel Bikes invoice',
    due: 3,
    status: 'Todo',
    area: 'Clients',
    key: /kestrel/i,
    kind: 'future',
  },
  {
    name: 'Book the dentist',
    due: 7,
    status: 'Todo',
    area: 'Personal',
    key: /dentist/i,
    kind: 'future',
  },
  {
    name: 'Outline the Lisbon talk',
    due: 12,
    status: 'Todo',
    area: 'Studio',
    key: /lisbon talk/i,
    kind: 'future',
  },
];

const overdue = tasks.filter((task) => task.kind === 'overdue');

export default scenario({
  id: 'notion-overdue-tasks',
  title: 'Which of my Notion tasks are overdue?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. Your tasks live in the Notion database called Tasks. You only want to know which are overdue; nothing should be changed.',
  },
  world(clock) {
    const now = clock.now();
    const at = (offset: number) => (offset < 0 ? daysAgo(now, -offset) : inDays(now, offset));
    return {
      apps: createApps(owner, {
        notion: notion(
          owner,
          {
            pages: [
              {
                id: ids.home,
                title: 'Home',
                markdown: 'Studio workspace.\n- Tasks\n- Notes',
                edited: daysAgo(now, 30),
              },
              {
                id: ids.notes,
                title: 'Notes',
                parent: ids.home,
                markdown: 'Ideas: a zine about Lisbon tiles, a talk on quiet interfaces.',
                edited: daysAgo(now, 12),
              },
            ],
            databases: [
              {
                id: ids.tasks,
                title: 'Tasks',
                parent: ids.home,
                schema: {
                  Name: { type: 'title' },
                  Due: { type: 'date' },
                  Status: { type: 'status', options: ['Todo', 'In progress', 'Done'] },
                  Area: { type: 'select', options: ['Studio', 'Clients', 'Personal'] },
                },
                rows: tasks.map((task, index) => ({
                  properties: {
                    Name: task.name,
                    Due: localDate(at(task.due)),
                    Status: task.status,
                    Area: task.area,
                  },
                  edited: daysAgo(now, 1 + (index % 4)),
                })),
              },
            ],
          },
          clock.now,
        ),
      }),
      dates: Object.fromEntries(tasks.map((task) => [task.name, dayLabel(at(task.due))])) as Record<
        string,
        string
      >,
      today: dayLabel(now),
    };
  },
  async play(session) {
    await session.say('Which of my Notion tasks are overdue?');
  },
  evidence: (_run, world) =>
    `Today is ${world.today}. Tasks in Notion: ${tasks
      .map(
        (task) =>
          `"${task.name}" due ${world.dates[task.name]}, status ${task.status} (${
            task.kind === 'overdue'
              ? 'overdue'
              : task.kind === 'done'
                ? 'past its due date but Done, so not overdue'
                : task.kind === 'today'
                  ? 'due today, not overdue'
                  : 'due later'
          })`,
      )
      .join('; ')}.`,
  expect(world) {
    return [
      check(
        'names-the-three-overdue-tasks',
        (run) => {
          const missing = overdue.filter((task) => !task.key.test(run.said));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing: ${missing.map((task) => task.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'reasoning',
          otherwise:
            'The answer presents all three overdue tasks as overdue: sending the Q3 VAT figures to the accountant, replying to Casa Velha about the menu quote, and renewing the portfolio domain, in any wording.',
        },
      ),
      check(
        'done-task-absent-unless-called-done',
        (run) => {
          const named = /iberluz/i.test(run.final);
          const done =
            /\b(done|complete|completed|finished|ticked|checked off|paid|closed|resolved|sorted|handled|taken care of)\b/i.test(
              run.final,
            );
          return {
            pass: !named || done,
            evidence:
              named && !done ? 'names the Iberluz bill without saying it is done' : undefined,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      noWrites('create', 'update', 'delete', 'post', 'send', 'draft'),
      judge(
        'done-task-not-called-overdue',
        `The final answer does not present "Pay the Iberluz electricity bill" as overdue. It was due ${world.dates['Pay the Iberluz electricity bill']}, which is past, but its status is Done, so it is not overdue. Leaving it out passes. Mentioning it passes only when the answer makes clear it is already done and not counted as overdue. Listing it among the overdue tasks fails.`,
        { failure: 'reasoning' },
      ),
      judge(
        'due-today-not-called-overdue',
        `The final answer does not present "Send Harborline the photo selects" or "Call the bank about the card limit" as overdue. Both are due today (${world.today}), which is not overdue. Leaving them out passes, and so does mentioning them as due today. Listing either among the overdue tasks fails.`,
        { failure: 'reasoning' },
      ),
    ];
  },
});
