import { check, judge, scenario } from '../scenario.ts';
import { pageText } from '../html.ts';
import type { Run } from '../trace.ts';

const data = [
  'Data as of Monday 23 November 2026, from the project tracker:',
  '- Harbor Freight rebrand: on track, 70% done, due 11 Dec, owner Mina.',
  '- Northwind Bakery website: at risk, 40% done, due 4 Dec, owner Jonas. Client has not sent menu content.',
  '- Tern docs refresh: on track, 90% done, due 30 Nov, owner Priya.',
].join('\n');

async function pages(run: Run) {
  const listed = (await run.api('GET', '/api/pages')).body?.pages ?? [];
  return Promise.all(
    listed.map(async (page: { id: string; version: number; title: string }) => ({
      ...page,
      versions: (await run.api('GET', `/api/pages/${page.id}`)).body?.versions ?? [],
    })),
  );
}

export default scenario({
  id: 'page-update-in-place',
  title: 'Change a dashboard page and keep it as one page with two versions',
  capabilities: ['files'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  calibration: 'pending',
  seconds: 600,
  user: { approve: false },
  world() {
    return {};
  },
  async play(session) {
    await session.say(
      `Give me a dashboard page of our client projects that I can open here.\n\n${data}`,
    );
    await session.say(
      'Northwind sent the menu content this morning, so it is back on track at 55% done. Update the dashboard.',
    );
  },
  expect() {
    return [
      check(
        'keeps-one-page',
        async (run) => {
          const found = await pages(run);
          return {
            pass: found.length === 1,
            evidence: JSON.stringify(found.map(({ title, version }) => ({ title, version }))),
          };
        },
        { failure: 'format' },
      ),
      check(
        'saves-a-second-version',
        async (run) => {
          const found = await pages(run);
          return {
            pass: found.some((page) => page.version === 2 && page.versions.length === 2),
            evidence:
              found.map((page) => `${page.title}: version ${page.version}`).join('; ') || 'no page',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'latest-version-has-the-change',
        async (run) => {
          const shared = run.tools
            .filter((call) => call.name === 'share_file' && !call.isError)
            .map((call) => String(call.input?.path ?? '').replace(/^(\.\/)+/, ''))
            .filter((path) => /\.html?$/i.test(path));
          const file = run.files.find(
            (item) => item === shared.at(-1) || item.endsWith(`/${shared.at(-1)}`),
          );
          const html = file ? await run.text(file) : '';
          const text = pageText(html);
          const updated = /northwind[\s\S]{0,400}?55\s?%|55\s?%[\s\S]{0,400}?northwind/i.test(text);
          return {
            pass: updated,
            evidence: html ? `Northwind shown at 55%: ${updated}` : 'no page file',
          };
        },
        { failure: 'incomplete' },
      ),
      judge(
        'second-message-reports-the-change',
        'The assistant message after the owner asked for the update says the dashboard was updated and what changed (Northwind Bakery is back on track at 55%). It does not present the result as a new, separate page, repeat the whole dashboard in chat or claim to have seen the rendered page.',
        { aspect: 'process', failure: 'format' },
      ),
    ];
  },
  evidence() {
    return `The owner first asked for a dashboard page from this data: ${data} Then the owner said Northwind Bakery sent the menu content, is back on track at 55% done, and asked to update the dashboard. Nod keeps each page with versions: sharing the same file again saves a new version of the same page. A correct result is one HTML page with two versions, the second showing Northwind Bakery on track at 55%. No account is connected.`;
  },
});
