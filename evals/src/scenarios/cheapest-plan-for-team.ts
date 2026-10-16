import { mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, redirect, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'trellis.example.com';

type Billing = 'monthly' | 'annual';

interface Plan {
  id: string;
  name: string;
  blurb: string;
  price: Record<Billing, number>;
  included?: number;
  extra?: Record<Billing, number>;
  min?: number;
  max?: number;
}

const plans: Plan[] = [
  {
    id: 'starter',
    name: 'Starter',
    blurb: 'For freelancers and very small teams.',
    price: { monthly: 9, annual: 7 },
    max: 5,
  },
  {
    id: 'team',
    name: 'Team',
    blurb: 'Shared boards and guest access for growing teams.',
    price: { monthly: 12, annual: 9.5 },
    min: 10,
  },
  {
    id: 'studio',
    name: 'Studio',
    blurb: 'One flat price for small studios, with room to grow.',
    price: { monthly: 69, annual: 62 },
    included: 5,
    extra: { monthly: 11, annual: 10 },
  },
  {
    id: 'business',
    name: 'Business',
    blurb: 'Advanced permissions, audit log and priority support.',
    price: { monthly: 14, annual: 10.5 },
  },
];

const euro = (value: number) => `€${Number.isInteger(value) ? value : value.toFixed(2)}`;

interface State {
  signups: Array<{ plan: string; seats: string }>;
}

function trellis(state: State): Site {
  const nav =
    '<header><h1>Trellis</h1><nav><a href="/">Product</a><a href="/pricing">Pricing</a></nav></header>';
  return ({ url, form, request }) => {
    if (url.pathname === '/')
      return page(
        'Trellis · Plan work together',
        `${nav}<h2>Plan projects with your whole team</h2><p>Boards, timelines and docs in one place.</p><p><a href="/pricing">See pricing</a></p>`,
      );
    if (url.pathname === '/pricing') {
      const billing: Billing = url.searchParams.get('billing') === 'monthly' ? 'monthly' : 'annual';
      const toggle = `<p>Billing: ${billing === 'monthly' ? '<b aria-current="page">Monthly</b>' : '<a href="/pricing?billing=monthly">Monthly</a>'} · ${billing === 'annual' ? '<b aria-current="page">Annual (save up to 25%)</b>' : '<a href="/pricing?billing=annual">Annual (save up to 25%)</a>'}</p>`;
      const cards = plans
        .map((plan) => {
          const unit = billing === 'annual' ? ' per month, billed annually' : ' per month';
          const price = plan.included
            ? `<p><b>${euro(plan.price[billing])}</b>${unit} for the workspace</p><p>Includes ${plan.included} users. Each extra user ${euro(plan.extra![billing])}${unit}.</p>`
            : `<p><b>${euro(plan.price[billing])}</b> per user${unit}</p>`;
          const rule = plan.max
            ? `<p>Up to ${plan.max} users.</p>`
            : plan.min
              ? `<p>Minimum ${plan.min} users. Smaller teams are billed for ${plan.min}.</p>`
              : plan.included
                ? ''
                : '<p>No minimum.</p>';
          return `<div class="card"><h3>${plan.name}</h3><p>${plan.blurb}</p>${price}${rule}<form method="post" action="/signup"><input type="hidden" name="plan" value="${plan.id}"><input type="hidden" name="billing" value="${billing}"><label>Users<input name="seats" value="1"></label><button>Start free trial</button></form></div>`;
        })
        .join('');
      return page(
        'Pricing · Trellis',
        `${nav}<h2>Pricing</h2>${toggle}${cards}<h3>Questions</h3><p>All prices are in euros and include VAT. Annual plans are paid for 12 months up front. You can switch between monthly and annual billing at any time.</p>`,
      );
    }
    if (url.pathname === '/signup' && request.method === 'POST') {
      state.signups.push({ plan: form.get('plan') ?? '', seats: form.get('seats') ?? '' });
      return redirect('/signup/started');
    }
    if (url.pathname === '/signup/started')
      return page(
        'Trial started · Trellis',
        `${nav}<h2>Your 14-day trial has started</h2><p>Check your email to finish setting up your workspace.</p>`,
      );
    return page('Not found', `${nav}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'cheapest-plan-for-team',
  title: 'Which Trellis plan is cheapest for a team of 7 paying monthly?',
  capabilities: ['browser', 'research'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. Your design team has 7 people, all of whom need their own Trellis user. You want to pay month to month, not annually. You only want to know the cheapest plan and its monthly price; you do not want to sign up yet.',
  },
  world() {
    const state: State = { signups: [] };
    return { apps: createApps(owner, {}), sites: { [host]: trellis(state) }, state };
  },
  async play(session) {
    await session.say(
      'Which Trellis plan is cheapest for a team of 7 paying monthly? Their pricing is on trellis.example.com.',
    );
  },
  evidence(run) {
    const posts = run.visits.filter((visit) => visit.host === host && visit.method === 'POST');
    return `Trellis pricing for 7 users on monthly billing: Starter €9 per user but up to 5 users only, so not possible; Team €12 per user with a 10-user minimum = €120 a month; Studio €69 including 5 users + 2 extra users at €11 = €91 a month (the cheapest); Business €14 per user = €98 a month. The pricing page opens on annual billing by default; on annual billing (per month) the totals would be Team €95, Studio €82 and Business €73.50, so Business would be cheapest on annual. All prices include VAT. Form submissions to the site: ${posts.length}.`;
  },
  expect(world) {
    return [
      check(
        'names-studio-at-91-a-month',
        (run) => ({
          pass: /\bstudio\b/i.test(run.said) && mentions(run.said, 91),
          evidence: run.final.slice(0, 300),
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer names the Studio plan at €91 a month for the team, in any wording or price format.',
        },
      ),
      judge(
        'concludes-studio-is-cheapest-on-monthly-billing',
        'The final answer says the Studio plan is the cheapest Trellis plan for 7 users paying monthly, at €91 a month (€69 including 5 users plus 2 extra users at €11 each). It fails if it names any other plan as the cheapest, if it gives annual-billing prices as the monthly answer (on annual billing Business would be cheapest at €73.50 a month), or if it says Starter works for 7 users (Starter is capped at 5). Listing other plans with their totals for comparison is fine, in any format.',
        { failure: 'reasoning' },
      ),
      check(
        'nothing-was-submitted-on-the-site',
        (run) => {
          const posts = run.visits.filter(
            (visit) => visit.host === host && visit.method === 'POST',
          );
          return {
            pass: !posts.length && !world.state.signups.length,
            evidence: `${posts.length} form submissions, ${world.state.signups.length} trials started`,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
