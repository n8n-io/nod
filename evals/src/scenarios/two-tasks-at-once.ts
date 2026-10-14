import { mentions, sessionMessages, tasksDone } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';
import { dayLabel, inDays, localDate, nextWeekday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const zone = 'Europe/Lisbon';
const restaurant = 'tables.casacedro.example.org';

const pricing: Record<string, Record<string, [string, string]>> = {
  'tasklane.example.org': {
    '/pricing': [
      'Pricing',
      '<table><tr><th>Plan</th><th>Billed monthly</th><th>Billed yearly</th></tr><tr><td>Starter</td><td>Free for up to 3 users</td><td>Free</td></tr><tr><td>Team</td><td>€9 per user per month</td><td>€84 per user per year</td></tr><tr><td>Business</td><td>€19 per user per month</td><td>€190 per user per year</td></tr></table><p>Prices exclude VAT.</p>',
    ],
  },
  'boardly.example.org': {
    '/pricing': [
      'Plans',
      '<div class="card"><h3>Team</h3><p>€49 per month, including 5 users. Each extra user is €12 per month.</p></div><div class="card"><h3>Scale</h3><p>€149 per month, including 20 users.</p></div><p><a href="/billing-faq">Billing questions</a></p>',
    ],
    '/billing-faq': [
      'Billing questions',
      '<h3>Is there a discount for paying yearly?</h3><p>Yes. Yearly billing takes 10% off the whole plan, extra users included.</p><h3>Can I add users during the year?</h3><p>Yes. We charge the extra users pro rata.</p>',
    ],
  },
  'sprintwise.example.org': {
    '/pricing': [
      'Simple pricing',
      '<p>Team: €11 per user per month.</p><p>Enterprise: talk to us.</p><p><a href="/pricing/yearly">Pay yearly</a></p>',
    ],
    '/pricing/yearly': [
      'Pay yearly',
      '<p>Pay for a year up front and get 2 months free: each user costs 10 months instead of 12.</p>',
    ],
  },
};

function vendor(host: string): Site {
  const name = host.split('.')[0].replace(/^./, (letter) => letter.toUpperCase());
  return ({ url }) => {
    const header = `<header><h1>${name}</h1><nav><a href="/">Home</a> <a href="/pricing">Pricing</a></nav></header>`;
    if (url.pathname === '/') return page(name, `${header}<h2>Plan, track and ship together.</h2>`);
    const found = pricing[host][url.pathname];
    return found
      ? page(`${found[0]} · ${name}`, `${header}<h2>${found[0]}</h2>${found[1]}`)
      : page('Not found', `${header}<p>Page not found.</p>`, 404);
  };
}

interface State {
  saturday: string;
  checked: boolean;
}

function casaCedro(state: State): Site {
  return ({ url }) => {
    if (url.pathname === '/api/slots') {
      const date = url.searchParams.get('date') ?? '';
      const guests = url.searchParams.get('guests') ?? '';
      if (date === state.saturday && guests === '4') state.checked = true;
      const times =
        date !== state.saturday
          ? ['13:00', '19:00', '20:00', '21:30']
          : guests === '4'
            ? ['13:30', '19:15', '21:45']
            : ['13:30', '19:15', '20:00', '20:30', '21:45'];
      return {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, guests, times }),
      };
    }
    if (url.pathname !== '/') return page('Not found', '<p>Page not found.</p>', 404);
    return page(
      'Casa Cedro · Book a table',
      `<header><h1>Casa Cedro</h1></header><h2>Find a table</h2><form id="find"><label>Date<input name="date" type="date" required></label><label>Guests<select name="guests">${[1, 2, 3, 4, 5, 6].map((count) => `<option>${count}</option>`).join('')}</select></label><button>Show free tables</button></form><div id="times"></div><noscript><p>Turn on JavaScript to see free tables.</p></noscript>
<script>document.getElementById('find').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await (await fetch('/api/slots?' + new URLSearchParams(new FormData(event.target)))).json();
  document.getElementById('times').innerHTML = '<h3>Free tables on ' + result.date + ' for ' + result.guests + '</h3>' + (result.times.length ? '<ul>' + result.times.map((time) => '<li>' + time + '</li>').join('') + '</ul>' : '<p>No free tables.</p>');
});</script>`,
    );
  };
}

const ids = { turnId: '', messageId: '' };

const taskOf = (run: Run, request: typeof ids) =>
  run.tasks.find((item) => item.sourceMessageId === request.messageId);

const resultOf = (run: Run, request: typeof ids) =>
  sessionMessages(run, taskOf(run, request)?.id)
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
    .join('\n');

export default scenario({
  id: 'two-tasks-at-once',
  title: 'Run research and a browser check as two tasks while the chat stays free',
  capabilities: ['tasks', 'research', 'browser', 'progress'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  timeZone: zone,
  calibration: 'pending',
  user: { approve: true },
  world(clock) {
    const at = inDays(clock.now(), nextWeekday(clock.now(), 6, 2, zone), zone);
    const state: State = { saturday: localDate(at, zone), checked: false };
    return {
      apps: createApps(owner, {}),
      sites: {
        ...Object.fromEntries(Object.keys(pricing).map((host) => [host, vendor(host)])),
        [restaurant]: casaCedro(state),
      },
      state,
      label: dayLabel(at, zone),
      research: { ...ids },
      browse: { ...ids },
      quick: { ...ids },
    };
  },
  async play(session, world) {
    world.research = await session.send(
      'Compare the Team plans of Tasklane, Boardly and Sprintwise for my team of 6 if we pay yearly. Their pricing pages are tasklane.example.org/pricing, boardly.example.org/pricing and sprintwise.example.org/pricing; read the fine print too. Tell me what each would cost us per year and which is cheapest.',
    );
    await session.waitForTurn(world.research.turnId);
    world.browse = await session.send(
      `Check on ${restaurant} which times Casa Cedro has free for 4 people on ${world.label} between 19:00 and 22:00. Don't book anything.`,
    );
    await session.waitForTurn(world.browse.turnId);
    world.quick = await session.send("Quick one while those run: what's 18% of 240 euros?");
    await session.waitForTurn(world.quick.turnId);
    await session.settle();
  },
  evidence(_run, world) {
    return `Yearly cost for 6 users: Tasklane €504 (€84 per user per year), Boardly €658.80 (€49 for 5 users plus €12 for the sixth, monthly, with 10% off for yearly billing from its billing FAQ), Sprintwise €660 (€11 per user per month for 10 months, from its yearly page). Tasklane is cheapest. Casa Cedro on ${world.label} for 4 people shows free tables at 13:30, 19:15 and 21:45; between 19:00 and 22:00 only 19:15 and 21:45 are free. The page shows times only after JavaScript runs. 18% of 240 euros is 43.20 euros. Availability for 4 on that day was ${world.state.checked ? '' : 'never '}looked up.`;
  },
  completion: () => tasksDone,
  expect(world) {
    return [
      check(
        'each-request-became-its-own-task',
        (run) => {
          const research = taskOf(run, world.research);
          const browse = taskOf(run, world.browse);
          return {
            pass: run.tasks.length === 2 && Boolean(research && browse && research !== browse),
            evidence: `${run.tasks.length} tasks: ${run.tasks.map((task) => task.title).join('; ') || 'none'}`,
          };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'the-two-tasks-ran-at-the-same-time',
        (run) => {
          const spans = [world.research, world.browse].map((request) =>
            run.turns.filter(
              (turn) =>
                turn.sessionId !== undefined &&
                turn.sessionId === taskOf(run, request)?.id &&
                turn.startedAt !== undefined &&
                turn.finishedAt !== undefined,
            ),
          );
          const overlap = spans[0].some((a) =>
            spans[1].some((b) => a.startedAt! < b.finishedAt! && b.startedAt! < a.finishedAt!),
          );
          return { pass: overlap, evidence: overlap ? undefined : 'the tasks never ran together' };
        },
        { aspect: 'process', failure: 'tool' },
      ),
      check(
        'the-chat-answered-the-quick-question-while-a-task-ran',
        (run) => {
          const turn = run.turns.find((item) => item.id === world.quick.turnId);
          const answer = run.messages
            .filter((message) => message.turnId === world.quick.turnId)
            .filter((message) => message.role === 'assistant')
            .map((message) => message.text)
            .join('\n');
          const lastTask = Math.max(
            0,
            ...run.turns
              .filter((item) => run.tasks.some((task) => task.id === item.sessionId))
              .map((item) => item.finishedAt ?? 0),
          );
          return {
            pass:
              turn?.background === false &&
              turn.finishedAt !== undefined &&
              turn.finishedAt < lastTask &&
              mentions(answer, 43.2),
            evidence: `chat answer: "${answer.slice(0, 160)}"`,
          };
        },
        { failure: 'tool' },
      ),
      check(
        'research-task-gives-each-yearly-cost-and-the-cheapest',
        (run) => {
          const text = resultOf(run, world.research);
          return {
            pass:
              /tasklane/i.test(text) &&
              mentions(text, 504) &&
              mentions(text, 658.8) &&
              mentions(text, 660),
            evidence: text.slice(-400) || 'the research task said nothing',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'browser-task-gives-the-free-evening-times',
        (run) => {
          const text = resultOf(run, world.browse);
          return {
            pass: world.state.checked && /19[:.]15/.test(text) && /21[:.]45/.test(text),
            evidence: text.slice(-400) || 'the browser task said nothing',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'the-chat-wrote-nothing-more-about-handed-off-work',
        (run) => {
          const extra = [world.research, world.browse].map(
            (request) =>
              run.messages.filter(
                (message) => message.turnId === request.turnId && message.role === 'assistant',
              ).length,
          );
          return { pass: extra.every((count) => count <= 1), evidence: extra.join(', ') };
        },
        { required: false, aspect: 'process', failure: 'format' },
      ),
    ];
  },
});
