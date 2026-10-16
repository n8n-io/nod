import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { notion, type NotionDatabase } from '../world/notion.ts';
import { daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const ids = {
  home: 'c4d81f62-9a3b-4e70-b215-6f0e2d9a7c01',
  projects: 'c4d81f62-9a3b-4e70-b215-6f0e2d9a7c02',
  ideas: 'c4d81f62-9a3b-4e70-b215-6f0e2d9a7c03',
  copy: 'c4d81f62-9a3b-4e70-b215-6f0e2d9a7d01',
  review: 'c4d81f62-9a3b-4e70-b215-6f0e2d9a7d02',
};

const projects: Array<[string, string, string, string, number]> = [
  [ids.copy, 'Website copy', 'Doing', 'Harborline Logistics', 4],
  [ids.review, 'Website copy review', 'Todo', 'Harborline Logistics', 9],
  [
    'c4d81f62-9a3b-4e70-b215-6f0e2d9a7d03',
    'Website launch checklist',
    'Todo',
    'Harborline Logistics',
    14,
  ],
  ['c4d81f62-9a3b-4e70-b215-6f0e2d9a7d04', 'Brand guidelines v2', 'Doing', 'Kestrel Bikes', 6],
  ['c4d81f62-9a3b-4e70-b215-6f0e2d9a7d05', 'Spring catalogue', 'Todo', 'Kestrel Bikes', 21],
  ['c4d81f62-9a3b-4e70-b215-6f0e2d9a7d06', 'Packaging refresh', 'Done', 'Lumen Foods', -5],
  ['c4d81f62-9a3b-4e70-b215-6f0e2d9a7d07', 'Portfolio update', 'Doing', 'Rivera Design', 12],
  ['c4d81f62-9a3b-4e70-b215-6f0e2d9a7d08', 'Newsletter template', 'Todo', 'Rivera Design', 18],
];

const page = (run: Run, id: string) => run.apps?.notion?.pages.find((item) => item.id === id);

export default scenario({
  id: 'notion-mark-done',
  title: 'Mark Website copy as done on my projects board',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      !/update-page|delete-pages|move-pages/.test(
        String((args as { tool?: unknown } | undefined)?.tool ?? ''),
      ) ||
      !JSON.stringify(args ?? {})
        .replace(/-/g, '')
        .includes(ids.review.replace(/-/g, '')),
    persona:
      'You are Alex Rivera, a freelance designer. Your projects board is the Notion database called Projects. "Website copy" is the Harborline copywriting project, which you just finished; the separate "Website copy review" has not started yet.',
  },
  world(clock) {
    const now = clock.now();
    const databases: NotionDatabase[] = [
      {
        id: ids.projects,
        title: 'Projects',
        parent: ids.home,
        schema: {
          Name: { type: 'title' },
          Status: { type: 'status', options: ['Todo', 'Doing', 'Done'] },
          Client: {
            type: 'select',
            options: ['Harborline Logistics', 'Kestrel Bikes', 'Lumen Foods', 'Rivera Design'],
          },
          Due: { type: 'date' },
        },
        rows: projects.map(([id, name, status, client, due], index) => ({
          id,
          properties: {
            Name: name,
            Status: status,
            Client: client,
            Due: localDate(due < 0 ? daysAgo(now, -due) : inDays(now, due)),
          },
          markdown: `Project for ${client}.`,
          edited: daysAgo(now, 1 + index),
        })),
      },
    ];
    return {
      apps: createApps(owner, {
        notion: notion(
          owner,
          {
            pages: [
              {
                id: ids.home,
                title: 'Home',
                markdown: 'Studio workspace.\n- Projects board\n- Project ideas',
                edited: daysAgo(now, 30),
              },
              {
                id: ids.ideas,
                title: 'Project ideas',
                parent: ids.home,
                markdown: '- Website copy workshop for small shops\n- Zine about Lisbon tiles',
                edited: daysAgo(now, 40),
              },
            ],
            databases,
          },
          clock.now,
        ),
      }),
      seed: Object.fromEntries(databases[0].rows.map((row) => [row.id!, row.properties])) as Record<
        string,
        Record<string, unknown>
      >,
    };
  },
  async play(session) {
    await session.say('Mark Website copy as done on my projects board.');
  },
  evidence: (run) =>
    `Projects board after the run: ${(run.apps?.notion?.pages ?? [])
      .filter((item) => item.database === ids.projects)
      .map(
        (item) => `"${item.title}" ${item.properties?.Status}${item.archived ? ' (archived)' : ''}`,
      )
      .join('; ')}. Before: "Website copy" Doing, "Website copy review" Todo. Notion writes: ${
      run.writes.map((write) => write.slug).join(', ') || 'none'
    }.`,
  expect(world) {
    return [
      check(
        'website-copy-is-done',
        (run) => {
          const row = page(run, ids.copy);
          return {
            pass:
              row?.properties?.Status === 'Done' && !row.archived && row.title === 'Website copy',
            evidence: `Status ${row?.properties?.Status}${row?.archived ? ', archived' : ''}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'review-row-unchanged',
        (run) => {
          const row = page(run, ids.review);
          return {
            pass:
              !row?.archived &&
              JSON.stringify(row?.properties) === JSON.stringify(world.seed[ids.review]),
            evidence: `Status ${row?.properties?.Status}${row?.archived ? ', archived' : ''}`,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const pages = (run.apps?.notion?.pages ?? []).filter(
            (item) => item.database === ids.projects,
          );
          const changed = pages.filter((item) => {
            const before = world.seed[item.id];
            if (!before) return !item.archived;
            const after =
              item.id === ids.copy
                ? { ...item.properties, Status: before.Status }
                : item.properties;
            return item.archived || JSON.stringify(after) !== JSON.stringify(before);
          });
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `also changed or added: ${changed.map((item) => item.title).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
    ];
  },
});
