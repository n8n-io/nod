import { mentions } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { notion, type NotionPage } from '../world/notion.ts';
import { daysAgo, inDays, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Madrid';

const ids = {
  home: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a01',
  meetings: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a02',
  clients: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a03',
  harborline: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a04',
  kickoff: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a05',
  sync: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a06',
  kestrel: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a07',
  lumen: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a08',
  kestrelClient: '9e5a3b17-2f4c-4a86-a0d3-5c7e1b8f4a09',
};

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function mentionsDate(text: string, iso: string) {
  const [year, month, day] = iso.split('-').map(Number);
  const name = months[month - 1];
  const d = `0?${day}(?:st|nd|rd|th)?`;
  const m = `(?:${name}|${name.slice(0, 3)}\\.?)`;
  return [
    `(?<!\\d)${d}\\s+(?:of\\s+)?${m}`,
    `${m}\\s+${d}(?!\\d)`,
    `${year}-0?${month}-0?${day}(?!\\d)`,
    `(?<![\\d/.])0?${day}/0?${month}(?!\\d)`,
    `(?<![\\d/.])0?${day}\\.0?${month}\\.`,
  ].some((pattern) => new RegExp(pattern, 'i').test(text));
}

const short = (at: number) =>
  new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: zone }).format(at);

const created = (run: Run, seed: Set<string>) =>
  (run.apps?.notion?.pages ?? []).filter((page) => !seed.has(page.id) && !page.archived);

const notes = (run: Run, seed: Set<string>) =>
  created(run, seed).find(
    (page) => page.parent === ids.meetings && /harborline/i.test(page.title),
  ) ?? created(run, seed).find((page) => page.parent === ids.meetings);

export default scenario({
  id: 'notion-meeting-notes-page',
  title: "Create a page under Meetings with notes from today's call with Harborline",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => action === 'CONNECTED_MCP_CALL',
    persona:
      'You are Alex Rivera, a freelance designer. Harborline Logistics is a client; Marta Silva is your contact there. Your meeting notes go in the Notion page called Meetings, one page per call. Any sensible title and layout is fine.',
  },
  world(clock) {
    const now = clock.now();
    const launch = inDays(now, 18);
    const pages: NotionPage[] = [
      {
        id: ids.home,
        title: 'Home',
        markdown:
          'Studio workspace.\n- Meetings: one page per call\n- Clients: one page per client',
        edited: daysAgo(now, 30),
      },
      {
        id: ids.meetings,
        title: 'Meetings',
        parent: ids.home,
        markdown: 'Notes from client and team calls. One page per meeting, newest first.',
        edited: daysAgo(now, 3),
      },
      {
        id: ids.kickoff,
        title: `${short(daysAgo(now, 15))} · Harborline kickoff`,
        parent: ids.meetings,
        markdown: [
          'Attendees: Alex, Marta Silva (Harborline)',
          '- Scope: new website and launch campaign',
          '- Budget proposal for Q4 sent, waiting for approval',
          `- Launch planned for ${short(inDays(now, 4))}`,
        ].join('\n'),
        edited: daysAgo(now, 15),
      },
      {
        id: ids.sync,
        title: `${short(daysAgo(now, 7))} · Weekly studio sync`,
        parent: ids.meetings,
        markdown: '- Portfolio update moves to next month\n- Invoice Kestrel for the catalogue',
        edited: daysAgo(now, 7),
      },
      {
        id: ids.kestrel,
        title: `${short(daysAgo(now, 5))} · Kestrel Bikes catalogue review`,
        parent: ids.meetings,
        markdown: '- Tom wants a lighter cover\n- Final files due end of month',
        edited: daysAgo(now, 5),
      },
      {
        id: ids.lumen,
        title: `${short(daysAgo(now, 3))} · Lumen Foods packaging`,
        parent: ids.meetings,
        markdown: '- Packaging approved\n- Send print-ready PDFs to the printer',
        edited: daysAgo(now, 3),
      },
      {
        id: ids.clients,
        title: 'Clients',
        parent: ids.home,
        markdown: 'One page per client with contacts and contracts.',
        edited: daysAgo(now, 20),
      },
      {
        id: ids.harborline,
        title: 'Harborline Logistics',
        parent: ids.clients,
        markdown:
          'Contact: Marta Silva, marketing lead (marta.silva@harborline.example.com)\nContract: website and launch campaign, signed last month.',
        edited: daysAgo(now, 16),
      },
      {
        id: ids.kestrelClient,
        title: 'Kestrel Bikes',
        parent: ids.clients,
        markdown: 'Contact: Tom Becker (tom@kestrelbikes.example.net)',
        edited: daysAgo(now, 25),
      },
    ];
    return {
      apps: createApps(owner, { notion: notion(owner, { pages }, clock.now) }),
      seed: new Set(pages.map((page) => page.id!)),
      before: Object.fromEntries(
        pages.map((page) => [page.id!, `${page.title}\n${page.markdown}`]),
      ) as Record<string, string>,
      launch: {
        iso: localDate(launch),
        label: new Intl.DateTimeFormat('en-GB', {
          day: 'numeric',
          month: 'long',
          timeZone: zone,
        }).format(launch),
      },
    };
  },
  async play(session, world) {
    await session.say(
      `Create a page under Meetings with notes from today's call with Harborline: they approved the Q4 budget of €48,000, the launch moves to ${world.launch.label}, and Marta will send the brand assets by Friday.`,
    );
  },
  evidence: (run, world) =>
    `Expected: one new page whose parent is the Meetings page, titled with Harborline, holding three facts: Q4 budget of €48,000 approved, launch moves to ${world.launch.label} (${world.launch.iso}), Marta sends the brand assets by Friday. New pages: ${
      created(run, world.seed)
        .map(
          (page) =>
            `"${page.title}" under ${page.parent === ids.meetings ? 'Meetings' : page.parent}:\n${page.markdown}`,
        )
        .join('\n\n') || 'none'
    }`,
  expect(world) {
    const text = (run: Run) => {
      const page = notes(run, world.seed);
      return page ? `${page.title}\n${page.markdown}` : '';
    };
    return [
      check(
        'page-under-meetings',
        (run) => {
          const page = notes(run, world.seed);
          return {
            pass: Boolean(page),
            evidence: page
              ? `"${page.title}"`
              : `new pages elsewhere: ${
                  created(run, world.seed)
                    .map((item) => `"${item.title}" under ${item.parent}`)
                    .join(', ') || 'none'
                }`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'page-names-harborline',
        (run) => {
          const page = notes(run, world.seed);
          return {
            pass: Boolean(page && /harborline/i.test(`${page.title}\n${page.markdown}`)),
            evidence: page
              ? `"${page.title}"`
              : `new pages elsewhere: ${
                  created(run, world.seed)
                    .map((item) => `"${item.title}" under ${item.parent}`)
                    .join(', ') || 'none'
                }`,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The new page Nod created under Meetings says, in its title or notes, that the call was with Harborline, in any wording.',
        },
      ),
      check(
        'notes-hold-budget',
        (run) => mentions(text(run), 48000) || /\b48\s?k\b|\b48\s+thousand\b/i.test(text(run)),
        {
          failure: 'incomplete',
          otherwise:
            'The new Harborline call notes page under Meetings records the approved Q4 budget as €48,000, in any number format.',
        },
      ),
      check('notes-hold-launch-date', (run) => mentionsDate(text(run), world.launch.iso), {
        failure: 'incomplete',
        otherwise: `The new Harborline call notes page under Meetings records that the launch moves to ${world.launch.label}, in any date format.`,
      }),
      check('notes-hold-marta', (run) => /\bMarta\b/.test(text(run)), {
        failure: 'incomplete',
        otherwise:
          'The new Harborline call notes page under Meetings records that Marta Silva will send the brand assets by Friday, in any wording.',
      }),
      check(
        'exactly-one-new-page',
        (run) => {
          const fresh = created(run, world.seed);
          return {
            pass: fresh.length === 1,
            evidence: `${fresh.length} new pages: ${fresh.map((page) => page.title).join(', ')}`,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'other-pages-untouched',
        (run) => {
          const changed = (run.apps?.notion?.pages ?? []).filter(
            (page) =>
              page.id in world.before &&
              (page.archived || `${page.title}\n${page.markdown}` !== world.before[page.id]),
          );
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed: ${changed.map((page) => page.title).join(', ')}`
              : undefined,
          };
        },
        { required: false, failure: 'scope' },
      ),
    ];
  },
});
