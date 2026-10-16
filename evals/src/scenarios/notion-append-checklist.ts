import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { notion, type NotionPage } from '../world/notion.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const ids = {
  home: 'a83f6d25-7c0e-4b9a-8f14-3d2c5e7a9b01',
  travel: 'a83f6d25-7c0e-4b9a-8f14-3d2c5e7a9b02',
  porto: 'a83f6d25-7c0e-4b9a-8f14-3d2c5e7a9b03',
  seville: 'a83f6d25-7c0e-4b9a-8f14-3d2c5e7a9b04',
  packing: 'a83f6d25-7c0e-4b9a-8f14-3d2c5e7a9b05',
};

const porto = [
  'Long weekend in Porto with Sam. Train from Madrid via Vigo.',
  'Hotel: Casa do Cais, Ribeira, booking ref PRT-48213.',
  '## Ideas',
  '- Bookshop crawl early in the morning',
  '- Port tasting in Vila Nova de Gaia',
  '## Checklist',
  '- [x] Book the hotel',
  '- [ ] Buy train tickets',
  '- [ ] Reserve dinner at Taberna do Rio',
].join('\n');

const items = [
  { label: 'ask about parking', pattern: /\bask\b.*\bparking\b/i },
  { label: 'book the ferry', pattern: /\bbook\b.*\bferry\b/i },
];

const portoPage = (run: Run) => run.apps?.notion?.pages.find((page) => page.id === ids.porto);
const lines = (markdown = '') => markdown.split('\n').map((line) => line.trim());

export default scenario({
  id: 'notion-append-checklist',
  title: "Add 'ask about parking' and 'book the ferry' to the checklist on my Porto trip page",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      !/update-page|create-pages|delete-pages|move-pages|create-comment/.test(
        String((args as { tool?: unknown } | undefined)?.tool ?? ''),
      ) ||
      JSON.stringify(args ?? {})
        .replace(/-/g, '')
        .includes(ids.porto.replace(/-/g, '')),
    persona:
      'You are Alex Rivera. You are planning a long weekend in Porto with Sam, and the plan lives on the Notion page "Trip to Porto". The two new items belong on that page\'s checklist as unticked items. Leave your other trip pages alone.',
  },
  world(clock) {
    const now = clock.now();
    const pages: NotionPage[] = [
      {
        id: ids.home,
        title: 'Home',
        markdown: 'Personal workspace.\n- Travel',
        edited: daysAgo(now, 30),
      },
      {
        id: ids.travel,
        title: 'Travel',
        parent: ids.home,
        markdown: 'Trip plans and the packing list.',
        edited: daysAgo(now, 10),
      },
      {
        id: ids.porto,
        title: 'Trip to Porto',
        parent: ids.travel,
        markdown: porto,
        edited: daysAgo(now, 2),
      },
      {
        id: ids.seville,
        title: 'Trip to Seville',
        parent: ids.travel,
        markdown: [
          'Spring trip with the family.',
          '## Checklist',
          '- [x] Book flights',
          '- [ ] Rent a car',
          '- [ ] Buy Alcázar tickets',
        ].join('\n'),
        edited: daysAgo(now, 1),
      },
      {
        id: ids.packing,
        title: 'Packing list',
        parent: ids.travel,
        markdown: [
          '- [ ] Passport',
          '- [ ] Chargers',
          '- [ ] Rain jacket',
          '- [ ] Reading book',
        ].join('\n'),
        edited: daysAgo(now, 4),
      },
    ];
    return {
      apps: createApps(owner, { notion: notion(owner, { pages }, clock.now) }),
      before: Object.fromEntries(
        pages.map((page) => [page.id!, `${page.title}\n${page.markdown}`]),
      ) as Record<string, string>,
    };
  },
  async play(session) {
    await session.say(
      "Add 'ask about parking' and 'book the ferry' to the checklist on my Porto trip page.",
    );
  },
  evidence: (run) =>
    `Trip to Porto content after the run:\n${portoPage(run)?.markdown ?? '(missing)'}\n\nIt started with the checklist items "Book the hotel" (ticked), "Buy train tickets" and "Reserve dinner at Taberna do Rio". The Seville trip and the Packing list must stay unchanged. Notion writes: ${
      run.writes.map((write) => write.slug).join(', ') || 'none'
    }.`,
  expect(world) {
    return [
      check(
        'porto-has-both-items',
        (run) => {
          const content = lines(portoPage(run)?.markdown);
          const missing = items.filter(
            (item) =>
              !content.some((line) => item.pattern.test(line) && !/^[-*+]?\s*\[x\]/i.test(line)),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing or ticked: ${missing.map((item) => item.label).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'existing-items-kept',
        (run) => {
          const page = portoPage(run);
          const content = lines(page?.markdown);
          const lost = lines(porto).filter((line) => line && !content.includes(line));
          return {
            pass:
              Boolean(page) && !page!.archived && page!.title === 'Trip to Porto' && !lost.length,
            evidence: page?.archived
              ? 'the Porto page was archived'
              : lost.length
                ? `lost: ${lost.join(' | ')}`
                : undefined,
          };
        },
        { failure: 'unsafe' },
      ),
      check(
        'other-pages-unchanged',
        (run) => {
          const pages = run.apps?.notion?.pages ?? [];
          const commented = new Set((run.apps?.notion?.comments ?? []).map((item) => item.page));
          const changed = pages.filter(
            (page) =>
              page.id !== ids.porto &&
              (commented.has(page.id) ||
                (page.id in world.before
                  ? page.archived || `${page.title}\n${page.markdown}` !== world.before[page.id]
                  : !page.archived)),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `also changed, commented on or created: ${changed.map((page) => page.title).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'added-as-unticked-checklist-items',
        (run) => {
          const content = lines(portoPage(run)?.markdown);
          return items.every((item) =>
            content.some((line) => /^- \[ \]/.test(line) && item.pattern.test(line)),
          );
        },
        { required: false, failure: 'format' },
      ),
    ];
  },
});
