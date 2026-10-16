import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import type { Run } from '../trace.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

interface Brand {
  host: string;
  name: string;
  headline: (week: number) => string;
  tagline: string;
  plans: (week: number) => Array<[string, string, string]>;
}

const brands: Brand[] = [
  {
    host: 'flowkite.example.net',
    name: 'Flowkite',
    headline: (week) =>
      week === 1 ? 'Automate the busywork' : 'Build AI agents that run your ops',
    tagline: 'Connect your apps and let workflows do the rest.',
    plans: () => [
      ['Free', '$0', '100 runs a month'],
      ['Pro', '$25', '10,000 runs a month'],
      ['Team', '$60', '50,000 runs a month and shared folders'],
    ],
  },
  {
    host: 'automata.example.net',
    name: 'Automata',
    headline: () => 'Workflows for busy teams',
    tagline: 'Build, schedule and monitor automations without code.',
    plans: (week) => [
      ['Starter', '$0', '500 tasks a month'],
      ['Pro', week === 1 ? '$29' : '$39', '5,000 tasks a month'],
      ['Business', '$99', 'Unlimited tasks and SSO'],
    ],
  },
  {
    host: 'relayroute.example.net',
    name: 'Relayroute',
    headline: () => 'Route every lead to the right person',
    tagline: 'Lead routing and scheduling for revenue teams.',
    plans: () => [
      ['Solo', '$19', '1 seat'],
      ['Growth', '$79', '5 seats'],
      ['Scale', 'Contact sales', 'Unlimited seats'],
    ],
  },
];

interface State {
  week: number;
  hits: Record<string, number>;
  marks: { setup: number; weekly: number; fired: number; firedAt: number };
}

const targets = brands.flatMap((brand) =>
  ['/', '/pricing', '/signup'].map((path) => `${brand.host}${path}`),
);

function screenshotted(run: Run, since: number, action: RegExp) {
  const seen = new Set<string>();
  for (const call of run.tools) {
    if (
      call.name !== 'browser' ||
      call.isError ||
      call.at < since ||
      !action.test(String(call.input?.action))
    )
      continue;
    const shown = run.visits
      .filter(
        (visit) =>
          visit.browser === call.browser &&
          visit.at <= call.at &&
          targets.includes(`${visit.host}${visit.path}`),
      )
      .at(-1);
    if (shown) seen.add(`${shown.host}${shown.path}`);
  }
  return [...seen];
}

function brandSite(brand: Brand, state: State): Site {
  let counter = 12_000 + Math.floor(Math.random() * 400);
  return ({ url }) => {
    counter += 7 + Math.floor(Math.random() * 20);
    const key = `${brand.host}${url.pathname}:${state.week}`;
    state.hits[key] = (state.hits[key] ?? 0) + 1;
    const nav = `<header><h1>${brand.name}</h1><nav><a href="/">Home</a> <a href="/pricing">Pricing</a> <a href="/signup">Sign up</a></nav></header>`;
    const footer = `<footer><p>Trusted by ${counter.toLocaleString('en-US')} teams · © 2026 ${brand.name}</p></footer>`;
    if (url.pathname === '/')
      return page(
        `${brand.name}: ${brand.headline(state.week)}`,
        `${nav}<h2>${brand.headline(state.week)}</h2><p>${brand.tagline}</p><p><a href="/signup">Start free</a></p>${footer}`,
      );
    if (url.pathname === '/pricing')
      return page(
        `${brand.name} pricing`,
        `${nav}<h2>Pricing</h2><table><tr><th>Plan</th><th>Price per month</th><th>Includes</th></tr>${brand
          .plans(state.week)
          .map(
            ([plan, price, includes]) =>
              `<tr><td>${plan}</td><td>${price}</td><td>${includes}</td></tr>`,
          )
          .join('')}</table>${footer}`,
      );
    if (url.pathname === '/signup')
      return page(
        `Create your ${brand.name} account`,
        `${nav}<h2>Create your account</h2><form><label>Work email<input type="email" name="email"></label><button type="button">Continue</button></form><p>No credit card required.</p>${footer}`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'competitor-digest',
  title: 'Weekly competitor digest with screenshots of what changed',
  linear: 'LAB-377',
  capabilities: ['browser', 'schedules', 'memory', 'files'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 2400,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The three competitor sites are flowkite.example.net, automata.example.net and relayroute.example.net. Use Monday 9:00 in your time zone. A short message with what changed is enough, plus screenshots of changed pages.',
  },
  world() {
    const state: State = {
      week: 1,
      hits: {},
      marks: { setup: 0, weekly: 0, fired: 0, firedAt: 0 },
    };
    return {
      apps: createApps(owner, {}),
      sites: Object.fromEntries(brands.map((brand) => [brand.host, brandSite(brand, state)])),
      state,
    };
  },
  async play(session, world) {
    const { state } = world;
    await session.say(
      'Every Monday at 9:00, go to the websites of Flowkite, Automata and Relayroute (flowkite.example.net, automata.example.net, relayroute.example.net), screenshot the homepage, pricing page and sign-up start page of each, and tell me what changed since last week.',
    );
    state.marks.setup = await session.assistantCount();
    state.week = 2;
    state.marks.firedAt = Date.now();
    state.marks.fired = await session.fireSchedules();
    state.marks.weekly = await session.assistantCount();
  },
  evidence(run, world) {
    const { marks } = world.state;
    const lines = (from: number, to: number) =>
      run.replies
        .slice(from, to)
        .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 900)}`)
        .join('\n') || '  (no message)';
    const week = (number: number) =>
      Object.entries(world.state.hits)
        .filter(([key]) => key.endsWith(`:${number}`))
        .map(([key]) => key.replace(/:\d$/, ''))
        .sort()
        .join(', ') || 'none';
    return [
      `Real changes made between the two weeks: Automata Pro price $29 to $39; Flowkite homepage headline "Automate the busywork" to "Build AI agents that run your ops". Relayroute did not change. Every page also shows a "Trusted by N teams" counter that changes on every visit and is not a real change.`,
      `Pages opened during setup (week 1): ${week(1)}`,
      `Pages opened during the Monday run (week 2): ${week(2)}`,
      `Pages screenshotted in the Monday run: ${screenshotted(run, marks.firedAt, /^(share_)?screenshot$/).join(', ') || 'none'}. Pages whose screenshot was shared with the user: ${screenshotted(run, marks.firedAt, /^share_screenshot$/).join(', ') || 'none'}.`,
      `Messages at setup:\n${lines(0, marks.setup)}`,
      `Messages after the Monday run:\n${lines(marks.setup, marks.weekly)}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const { state } = world;
    const opened = (week: number) =>
      targets.filter((target) => (state.hits[`${target}:${week}`] ?? 0) > 0);
    return [
      check(
        'schedule-is-monday-at-nine',
        (run) => {
          const schedule = run.schedules.find((item) => item.enabled && item.cron);
          const ok = Boolean(
            schedule &&
            /^0 9 \* \* (1|MON)$/i.test(schedule.cron!) &&
            schedule.timeZone === 'Europe/Madrid',
          );
          return {
            pass: ok,
            evidence: schedule ? `${schedule.cron} ${schedule.timeZone}` : 'no recurring schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'first-pass-opened-all-nine-pages',
        () => ({ pass: opened(1).length === 9, evidence: `opened ${opened(1).length} of 9` }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'monday-run-happened',
        () => ({ pass: state.marks.fired > 0, evidence: `${state.marks.fired} scheduled runs` }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'monday-run-opened-all-nine-pages',
        () => ({ pass: opened(2).length === 9, evidence: `opened ${opened(2).length} of 9` }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'took-screenshots-of-all-nine-pages-on-monday',
        (run) => {
          const taken = screenshotted(run, state.marks.firedAt, /^(share_)?screenshot$/);
          return {
            pass: taken.length === 9,
            evidence: `${taken.length} of 9 pages: ${taken.join(', ')}`,
          };
        },
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'shared-screenshots-of-both-changed-pages',
        (run) => {
          const shared = screenshotted(run, state.marks.firedAt, /^share_screenshot$/);
          return {
            pass:
              shared.includes('automata.example.net/pricing') &&
              shared.includes('flowkite.example.net/'),
            evidence: shared.join(', ') || 'no screenshot was shared with the user',
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'After the Monday run, the user received screenshots of both changed pages, the Automata pricing page and the Flowkite homepage, shared one by one or inside a file such as a ZIP or PDF whose contents the transcript shows.',
        },
      ),
      judge(
        'weekly-message-names-both-real-changes',
        'The messages after the Monday run (shown in the evidence) name both real changes with their new state: Automata Pro now costs $39 a month, and the Flowkite homepage headline now reads along the lines of "Build AI agents that run your ops". Any wording, order, list or prose form is fine, and the headline may be paraphrased as long as it is clearly the new Flowkite headline. It fails if either change is missing or attributed to the wrong competitor.',
        { failure: 'reasoning' },
      ),
      judge(
        'no-false-changes',
        'The messages after the Monday run (shown in the evidence) do not report anything else as a change. In particular it does not claim Relayroute changed, and it does not treat the "Trusted by N teams" counter, which differs on every visit, as a meaningful change. Saying that Relayroute had no changes is correct. If there is no message after the Monday run, this criterion does not apply.',
        { failure: 'hallucination' },
      ),
      judge(
        'screenshots-of-what-changed',
        'The messages after the Monday run include or share screenshots of the changed pages (at least the Automata pricing page and the Flowkite homepage), or clearly points to where they are, as the user asked for screenshots of what changed.',
        { required: false, failure: 'incomplete' },
      ),
    ];
  },
});
