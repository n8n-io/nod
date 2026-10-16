import { mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'clinicas-lx.example.net';

const clinics = [
  { id: 'alvalade', name: 'Alvalade', wait: 20, lastWeek: 30 },
  { id: 'alfama', name: 'Alfama', wait: 35, lastWeek: 55 },
  { id: 'baixa', name: 'Baixa', wait: 15, lastWeek: 25 },
  { id: 'belem', name: 'Belém', wait: 50, lastWeek: 40 },
];
const alfama = clinics.find((clinic) => clinic.id === 'alfama')!;
const neighbours = clinics.filter((clinic) => clinic !== alfama);

const script = `(async () => {
  const app = document.getElementById('app');
  try {
    const response = await fetch('/api/waits', { headers: { accept: 'application/json' } });
    const data = await response.json();
    const rows = data.clinics
      .map((clinic) => '<tr><td>' + clinic.name + '</td><td>' + clinic.waitMinutes + ' min</td><td>' + (clinic.open ? 'Open' : 'Closed') + '</td></tr>')
      .join('');
    app.innerHTML = '<h2>Current waiting times</h2><table><tr><th>Clinic</th><th>Current wait</th><th>Status</th></tr>' + rows + '</table><p>' + data.note + '</p>';
  } catch {
    app.innerHTML = '<p class="error">Could not load waiting times. Please refresh.</p>';
  }
})();`;

interface State {
  shells: number;
  scripts: number;
  api: number;
}

function clinicas(state: State): Site {
  return ({ url }) => {
    if (url.pathname === '/') {
      state.shells++;
      return page(
        'Clínicas LX · Waiting times',
        `<header><h1>Clínicas LX</h1><p>Walk-in urgent care in Lisbon</p></header><main id="app"><p>Loading current waiting times…</p></main><section><h2>Last week's average waits</h2><ul>${clinics.map((clinic) => `<li>${clinic.name}: ${clinic.lastWeek} min</li>`).join('')}</ul></section><script src="/static/app.js" defer></script>`,
      );
    }
    if (url.pathname === '/static/app.js') {
      state.scripts++;
      return {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        body: script,
      };
    }
    if (url.pathname === '/api/waits') {
      state.api++;
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clinics: clinics.map((clinic) => ({
            id: clinic.id,
            name: clinic.name,
            waitMinutes: clinic.wait,
            open: true,
          })),
          note: 'Waiting times are estimates and refresh every few minutes.',
        }),
      };
    }
    return page('Not found', '<p>Page not found.</p>', 404);
  };
}

const sentences = (text: string) => text.split(/\n|(?<=[.!?])\s+/);
const others = [/alvalade/i, /baixa/i, /bel[eé]m/i];
const months = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const withoutClock = (line: string) =>
  line
    .replace(/\b\d{1,2}:\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${months})[a-z]*`, 'gi'), ' ')
    .replace(new RegExp(`\\b(?:${months})[a-z]*\\s+\\d{1,2}\\b`, 'gi'), ' ');
const aboutAlfamaOnly = (text: string) =>
  sentences(text).filter((line) => /alfama/i.test(line) && !others.some((name) => name.test(line)));

export default scenario({
  id: 'spa-rendered-data',
  title: "What's the current wait time at the Alfama clinic on clinicas-lx.example.net?",
  capabilities: ['browser', 'research'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera and are thinking of walking into the Alfama clinic of Clínicas LX now. You only want its current waiting time.',
  },
  world() {
    const state: State = { shells: 0, scripts: 0, api: 0 };
    return { apps: createApps(owner, {}), sites: { [host]: clinicas(state) }, state };
  },
  async play(session) {
    await session.say(
      "What's the current wait time at the Alfama clinic on clinicas-lx.example.net?",
    );
  },
  evidence(_run, world) {
    const s = world.state;
    return `The page HTML is an empty shell ("Loading current waiting times…"); a script fetches /api/waits and renders the current waits: ${clinics.map((clinic) => `${clinic.name} ${clinic.wait} min`).join(', ')}. So Alfama's current wait is ${alfama.wait} minutes. The static HTML also shows last week's averages (${clinics.map((clinic) => `${clinic.name} ${clinic.lastWeek} min`).join(', ')}), which are not current. Site requests: page ${s.shells}, script ${s.scripts}, data API ${s.api}.`;
  },
  expect() {
    return [
      check(
        'gives-alfamas-current-wait',
        (run) => ({
          pass: run.said
            .split(/\n\s*\n/)
            .some((paragraph) => /alfama/i.test(paragraph) && mentions(paragraph, alfama.wait)),
          evidence: run.final.slice(0, 300),
        }),
        {
          failure: 'reasoning',
          otherwise: `The answer gives the Alfama clinic's current wait as ${alfama.wait} minutes, in any format.`,
        },
      ),
      check(
        'no-other-clinics-wait-given-as-alfamas',
        (run) => {
          const wrong = aboutAlfamaOnly(run.final).filter((line) =>
            neighbours.some((clinic) => mentions(withoutClock(line), clinic.wait)),
          );
          return { pass: !wrong.length, evidence: wrong[0]?.slice(0, 200) };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'no-other-wait-given-as-alfamas',
        `The answer does not present another clinic's current wait (${neighbours.map((clinic) => `${clinic.name} ${clinic.wait} min`).join(', ')}) or last week's Alfama average (${alfama.lastWeek} min) as the Alfama clinic's current wait, which is ${alfama.wait} minutes. Mentioning other clinics, last week's averages, or comparisons such as "${alfama.lastWeek - alfama.wait} minutes less than last week" is fine.`,
        { failure: 'reasoning' },
      ),
    ];
  },
});
