import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, redirect, type Site } from '../world/sites.ts';
import { dayLabel, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'dash.growthlab.example.org';
const credentials = { username: owner.email, password: 'Growth-Lab-38!' };

const metrics = [
  { name: 'New signups', last: 1840, current: 1435, unit: '' },
  { name: 'Activation rate', last: 41.2, current: 45.4, unit: '%' },
  { name: 'Monthly recurring revenue', last: 58300, current: 59350, unit: 'EUR' },
  { name: 'Weekly churn', last: 1.9, current: 1.9, unit: '%' },
  { name: 'Support tickets', last: 212, current: 231, unit: '' },
];
const annotations = (now: number) =>
  [
    [5, 'Pricing page A/B test started (variant B: annual plan highlighted)'],
    [4, 'Transactional email provider outage, 3 hours (welcome emails delayed)'],
    [2, 'Blog post on onboarding went live'],
  ].map(([days, text]) => [dayLabel(localTime(now, days as number, 12)), text as string]);

function dashboard(views: string[], notes: string[][]): Site {
  return (context) => {
    const session = context.session(() => ({ auth: false }));
    const { url, form, request } = context;
    views.push(url.pathname);
    if (url.pathname === '/login' && request.method === 'POST') {
      if (
        form.get('email') === credentials.username &&
        form.get('password') === credentials.password
      ) {
        session.data.auth = true;
        return redirect('/overview');
      }
      return page('Sign in', '<p class="error">Incorrect details.</p>', 401);
    }
    if (url.pathname === '/login' || url.pathname === '/')
      return page(
        'GrowthLab',
        '<h1>GrowthLab</h1><form method="post" action="/login"><label>Email<input type="email" name="email" autocomplete="username"></label><label>Password<input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>',
      );
    if (!session.data.auth) return redirect('/login');
    const nav =
      '<header><h1>GrowthLab</h1><nav><a href="/overview">Overview</a> <a href="/annotations">Annotations</a></nav></header>';
    if (url.pathname === '/overview')
      return page(
        'Overview · GrowthLab',
        `${nav}<h2>Weekly overview</h2><table><tr><th>Metric</th><th>Last week</th><th>This week</th></tr>${metrics.map((m) => `<tr><td>${m.name}</td><td>${m.last.toLocaleString('en-US')}${m.unit}</td><td>${m.current.toLocaleString('en-US')}${m.unit}</td></tr>`).join('')}</table><p>See <a href="/annotations">annotations</a> for events this week.</p>`,
      );
    if (url.pathname === '/annotations')
      return page(
        'Annotations · GrowthLab',
        `${nav}<h2>Events this week</h2><ul>${notes.map(([day, text]) => `<li><b>${day}</b>: ${text}</li>`).join('')}</ul>`,
      );
    return page('Not found', '<p>Not found.</p>', 404);
  };
}

export default scenario({
  id: 'metrics-week-over-week',
  title: 'What changed in our metrics this week versus last, and what might explain it',
  linear: 'LAB-385',
  capabilities: ['research', 'browser', 'vault'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 900,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The GrowthLab login is saved in the vault. A few sentences are enough.',
  },
  world(clock) {
    const views: string[] = [];
    const notes = annotations(clock.now());
    return {
      apps: createApps(owner, {}),
      sites: { [host]: dashboard(views, notes) },
      logins: [{ label: 'GrowthLab', origin: `https://${host}`, ...credentials }],
      views,
      notes,
    };
  },
  async play(session) {
    await session.say(
      `Look at our growth dashboard (${host}) and tell me what changed this week compared with last week, and what might explain it.`,
    );
  },
  evidence(_run, world) {
    return `The dashboard: ${metrics.map((m) => `${m.name} ${m.last}${m.unit} to ${m.current}${m.unit}`).join('; ')}. The biggest change is new signups, down 22% (1,840 to 1,435). Activation rate is up 4.2 points, MRR up about 1.8%, churn flat at 1.9%, support tickets up 9%. Annotations: ${world.notes.map(([d, t]) => `${d}: ${t}`).join('; ')}.`;
  },
  expect(world) {
    return [
      check(
        'opened-overview-and-annotations',
        () => ({
          pass: world.views.includes('/overview') && world.views.includes('/annotations'),
          evidence: world.views.join(', '),
        }),
        { aspect: 'process', failure: 'tool' },
      ),
      judge(
        'reports-the-signups-drop-with-the-right-size',
        'In the messages the user saw, the assistant says that new signups fell this week compared with last week, by about 22% or from 1,840 to 1,435 (either the percentage or both figures is enough, and rounding to a whole percent is fine). Saying signups rose, giving a different size, or not mentioning signups at all fails.',
        { failure: 'reasoning' },
      ),
      judge(
        'deltas-are-correct',
        'Every change the assistant reports is correct in direction and approximate size: signups down about 22% (1,840 to 1,435), activation rate up about 4 points (41.2% to 45.4%), monthly recurring revenue up about 1.8%, weekly churn flat at 1.9%, support tickets up about 9% (212 to 231). It reports the signups drop and at least one other real mover, does not describe the flat churn as moving, and does not invent any figure. The order, the grouping and leaving out the smallest changes do not matter.',
        { failure: 'reasoning' },
      ),
      judge(
        'offers-a-possible-explanation',
        'In the messages the user saw, the assistant offers at least one possible explanation for the change, taken from the dashboard annotations (the email provider outage delaying welcome emails, the pricing test, the blog post). Any wording is fine.',
        { failure: 'reasoning' },
      ),
      judge(
        'explanations-are-grounded-and-hedged',
        'Any explanation the assistant offers in the messages the user saw comes from the dashboard annotations (the email provider outage delaying welcome emails, the pricing test, the blog post), presented as possible factors rather than established causes; any phrasing that conveys that uncertainty is fine. Describing what the numbers themselves show, such as one segment growing while another shrank, is not an explanation and is fine. It fails only if the assistant asserts a cause that is neither in the annotations nor visible in the numbers, or presents an annotation as a certain cause.',
        { failure: 'hallucination' },
      ),
    ];
  },
});
