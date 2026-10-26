import { isDeepStrictEqual } from 'node:util';
import { check, judge, scenario } from '../scenario.ts';
import { presentations } from '../world/inline-visuals.ts';
import { page } from '../world/sites.ts';

const host = 'reports.visual-fixture.example.net';
const source = `https://${host}/revenue/2026`;
const data = [
  ['January', 12000, 10000],
  ['February', 9000, 10000],
  ['March', 0, 10000],
  ['April', 15000, 10000],
] as const;

export default scenario({
  id: 'inline-visual-chart',
  title: 'Show how actual revenue compares with the target over time',
  capabilities: ['research', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 420,
  user: { approve: false },
  world: () => ({
    sites: {
      [host]: () =>
        page(
          'Studio Aurora revenue',
          `<h1>Revenue, January–April 2026</h1><p>All amounts in EUR. March revenue was zero because the studio paused client work. Figures are final.</p><table><tr><th>Month</th><th>Actual revenue</th><th>Target revenue</th></tr>${data.map(([month, actual, target]) => `<tr><td>${month}</td><td>${actual}</td><td>${target}</td></tr>`).join('')}</table>`,
        ),
    },
  }),
  async play(session) {
    await session.say(
      `Show how actual revenue compares with the target over January to April in ${source}, directly in this chat, so I can see the trend quickly. Explain the main change and how far we are above or below the total target. Keep March visible even though its revenue was zero. Don't change the report.`,
    );
  },
  evidence: (run) =>
    `Source: ${source}. Each row is [month, actual EUR, target EUR]: ${JSON.stringify(data)}. Actual total EUR 36,000; target EUR 40,000; shortfall EUR 4,000. March zero is an observed value, not missing data. Saved visual data: ${JSON.stringify(presentations(run))}.`,
  expect() {
    return [
      check('delivers-a-chart-in-chat', async (run) => {
        const saved = presentations(run).filter((item) => item.type === 'chart');
        if (!saved.length) return { pass: false, evidence: 'No persisted chart.' };
        const response = await run.api('GET', '/api/state');
        return {
          pass:
            response.status === 200 &&
            (response.body.messages ?? []).some((message: { presentation?: unknown }) =>
              saved.some((item) => isDeepStrictEqual(item, message.presentation)),
            ),
          evidence: `${saved.length} saved charts; chat API status ${response.status}.`,
        };
      }),
      check('reads-and-cites-the-source', (run) => ({
        pass:
          run.visits.some((visit) => visit.host === host && visit.path === '/revenue/2026') &&
          run.visits.every((visit) => ['GET', 'HEAD'].includes(visit.method)) &&
          run.writes.length === 0 &&
          presentations(run).some(
            (item) =>
              item.type === 'chart' &&
              Array.isArray(item.sources) &&
              item.sources.some((entry) => entry?.url === source),
          ),
        evidence: `${run.visits.length} source requests; ${run.writes.length} external writes; ${JSON.stringify(presentations(run).map((item) => item.sources))}.`,
      })),
      judge(
        'shows-the-observed-values-and-the-zero',
        'The chart compares actual and target revenue over January, February, March and April in order. Actual EUR values are 12000, 9000, 0 and 15000; each target is EUR 10000. All four months and both series remain represented, with March zero shown rather than omitted or imputed. Labels and units make the comparison understandable. Equivalent bar or line presentation is acceptable. No projected months, invented values or percentage substitution.',
      ),
      judge(
        'explains-the-trend-and-shortfall-in-text',
        'The text itself explains the March pause/zero and April rebound to the highest monthly revenue, and says total actual revenue was EUR 36000 against a EUR 40000 target, EUR 4000 below. The text remains understandable without the chart. It must not contain raw presentation JSON or claim the report was changed.',
      ),
    ];
  },
});
