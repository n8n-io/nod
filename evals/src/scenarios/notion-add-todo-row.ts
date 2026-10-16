import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { notion, type NotionDatabase } from '../world/notion.ts';
import { dayLabel, daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const ids = {
  home: '7b2e9d41-3c6a-4f18-8d25-1a9e6c3b5f01',
  todo: '7b2e9d41-3c6a-4f18-8d25-1a9e6c3b5f02',
  reading: '7b2e9d41-3c6a-4f18-8d25-1a9e6c3b5f03',
};

const rows: Array<[string, number | null, string, string]> = [
  ['Renew car insurance', 12, 'Medium', 'Todo'],
  ['Get passport photos taken', -20, 'Low', 'Done'],
  ['Book dentist check-up', 5, 'Medium', 'Todo'],
  ['File Q3 VAT return', 2, 'High', 'Doing'],
  ['Call plumber about the boiler', -3, 'High', 'Done'],
  ['Buy birthday present for Inês', 8, 'Medium', 'Todo'],
  ['Cancel gym trial', 1, 'Low', 'Todo'],
  ['Update portfolio site', null, 'Low', 'Doing'],
  ['Return library books', -6, 'Low', 'Done'],
  ['Pick up dry cleaning', 3, 'Low', 'Todo'],
];

const rowId = (index: number) =>
  `7b2e9d41-3c6a-4f18-8d25-1a9e6c3b6${String(index).padStart(3, '0')}`;

function added(run: Run) {
  const seeded = new Set(rows.map((_, index) => rowId(index)));
  return (run.apps?.notion?.pages ?? []).filter(
    (page) => page.database === ids.todo && !seeded.has(page.id) && !page.archived,
  );
}

const target = (run: Run) => {
  const fresh = added(run);
  return fresh.find((page) => /passport/i.test(page.title)) ?? fresh[0];
};

export default scenario({
  id: 'notion-add-todo-row',
  title: "Add 'Renew passport' to my to-do list in Notion, due in 9 days, high priority",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action) => action === 'CONNECTED_MCP_CALL',
    persona:
      'You are Alex Rivera. Your personal to-do list lives in the Notion database called To-do. Renewing your passport is a new task; the old passport photos task is done and separate. You want the new task added, nothing else changed.',
  },
  world(clock) {
    const now = clock.now();
    const at = (offset: number | null) =>
      offset === null ? null : localDate(offset < 0 ? daysAgo(now, -offset) : inDays(now, offset));
    const databases: NotionDatabase[] = [
      {
        id: ids.todo,
        title: 'To-do',
        parent: ids.home,
        schema: {
          Name: { type: 'title' },
          Due: { type: 'date' },
          Priority: { type: 'select', options: ['High', 'Medium', 'Low'] },
          Status: { type: 'status', options: ['Todo', 'Doing', 'Done'] },
        },
        rows: rows.map(([name, due, priority, status], index) => ({
          id: rowId(index),
          properties: { Name: name, Due: at(due), Priority: priority, Status: status },
          edited: daysAgo(now, 1 + index),
        })),
      },
      {
        id: ids.reading,
        title: 'Reading list',
        parent: ids.home,
        schema: {
          Name: { type: 'title' },
          Author: { type: 'rich_text' },
          Status: { type: 'status', options: ['Want to read', 'Reading', 'Finished'] },
        },
        rows: [
          {
            properties: {
              Name: 'The Design of Everyday Things',
              Author: 'Don Norman',
              Status: 'Finished',
            },
          },
          {
            properties: {
              Name: 'Grid Systems',
              Author: 'Josef Müller-Brockmann',
              Status: 'Reading',
            },
          },
        ],
      },
    ];
    const due = inDays(now, 9);
    return {
      apps: createApps(owner, {
        notion: notion(
          owner,
          {
            pages: [
              {
                id: ids.home,
                title: 'Home',
                markdown: 'Personal workspace.\n- To-do\n- Reading list',
                edited: daysAgo(now, 30),
              },
            ],
            databases,
          },
          clock.now,
        ),
      }),
      expected: { due: localDate(due), label: dayLabel(due) },
      seed: Object.fromEntries(
        databases[0].rows.map((row) => [row.id!, JSON.stringify(row.properties)]),
      ) as Record<string, string>,
    };
  },
  async play(session, world) {
    await session.say(
      `Add 'Renew passport' to my to-do list in Notion, due ${world.expected.label}, high priority.`,
    );
  },
  evidence: (run, world) =>
    `Expected: one new row in the To-do database, titled with "Renew passport", Due ${world.expected.due} (${world.expected.label}), Priority High, Status Todo or empty. New rows: ${
      added(run)
        .map((page) => `"${page.title}" ${JSON.stringify(page.properties)}`)
        .join('; ') || 'none'
    }. Notion writes: ${run.writes.map((write) => write.slug).join(', ') || 'none'}.`,
  expect(world) {
    return [
      check(
        'exactly-one-new-row',
        (run) => {
          const fresh = added(run);
          return {
            pass: fresh.length === 1,
            evidence: `${fresh.length} new rows: ${fresh.map((page) => page.title).join(', ')}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'title-names-the-passport',
        (run) => ({
          pass:
            /passport/i.test(target(run)?.title ?? '') && /renew/i.test(target(run)?.title ?? ''),
          evidence: target(run)?.title,
        }),
        { failure: 'reasoning' },
      ),
      check(
        'due-date-is-right',
        (run) => {
          const value = String(target(run)?.properties?.Due ?? '');
          return { pass: value.slice(0, 10) === world.expected.due, evidence: value || 'no date' };
        },
        { failure: 'reasoning' },
      ),
      check(
        'priority-is-high',
        (run) => {
          const value = String(target(run)?.properties?.Priority ?? '');
          return { pass: /^high$/i.test(value.trim()), evidence: value || 'no priority' };
        },
        { failure: 'reasoning' },
      ),
      check(
        'status-is-todo-or-empty',
        (run) => {
          const row = target(run);
          const value = row?.properties?.Status;
          return {
            pass:
              Boolean(row) &&
              (value === null || value === undefined || value === '' || value === 'Todo'),
            evidence: String(value ?? 'empty'),
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'existing-rows-untouched',
        (run) => {
          const changed = (run.apps?.notion?.pages ?? []).filter(
            (page) =>
              page.id in world.seed &&
              (page.archived || JSON.stringify(page.properties) !== world.seed[page.id]),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed: ${changed.map((page) => page.title).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
