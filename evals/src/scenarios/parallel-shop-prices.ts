import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const shops = [
  { host: 'toolbarn.example.org', name: 'ToolBarn', price: '129.00' },
  { host: 'fixitdepot.example.org', name: 'FixIt Depot', price: '114.50' },
  { host: 'boltandnut.example.org', name: 'Bolt and Nut', price: '121.90' },
];

function shop(item: (typeof shops)[number], seen: Set<string>): Site {
  return ({ url }) => {
    const header = `<header><h1>${item.name}</h1><nav><a href="/">Home</a></nav></header>`;
    if (url.pathname === '/')
      return page(
        item.name,
        `${header}<h2>Tools and hardware</h2><form action="/search" method="get"><label>Search the shop<input name="q"></label><button type="submit">Search</button></form>`,
      );
    if (url.pathname === '/search')
      return page(
        `Search · ${item.name}`,
        `${header}<h2>Results</h2><div class="card"><h3><a href="/products/halden-18v">Halden 18V cordless drill</a></h3><p>See the product page for the price.</p></div><div class="card"><h3><a href="/products/halden-12v">Halden 12V compact drill</a></h3><p>€79.00</p></div>`,
      );
    if (url.pathname === '/products/halden-18v') {
      seen.add(item.host);
      return page(
        `Halden 18V cordless drill · ${item.name}`,
        `${header}<h2>Halden 18V cordless drill</h2><p>Price: <b>€${item.price}</b> including VAT</p><p>In stock. Ships in 2 days.</p>`,
      );
    }
    if (url.pathname === '/products/halden-12v')
      return page(
        `Halden 12V compact drill · ${item.name}`,
        `${header}<h2>Halden 12V compact drill</h2><p>Price: <b>€79.00</b> including VAT</p>`,
      );
    return page('Not found', '<p>Page not found.</p>', 404);
  };
}

export default scenario({
  id: 'parallel-shop-prices',
  title: 'Check three shops at the same time and name the cheapest',
  capabilities: ['browser', 'progress'],
  tier: 'full',
  complexity: 'medium',
  stance: 'regression',
  seconds: 900,
  calibration: 'pending',
  user: { approve: true },
  world() {
    const seen = new Set<string>();
    return {
      apps: createApps(owner, {}),
      sites: Object.fromEntries(shops.map((item) => [item.host, shop(item, seen)])),
      seen,
    };
  },
  async play(session) {
    await session.say(
      `Check the price of the Halden 18V cordless drill on ${shops.map((item) => item.host).join(', ')}. Check all three shops at the same time, then tell me which one is cheapest and how much less it costs than the most expensive one.`,
    );
  },
  expect(world) {
    return [
      check(
        'opened-the-drill-on-all-three-shops',
        () => ({ pass: world.seen.size === 3, evidence: [...world.seen].join(', ') || 'none' }),
        { failure: 'incomplete' },
      ),
      check(
        'names-the-cheapest-shop-and-price',
        (run) => ({ pass: /fix\s*it\s*depot/i.test(run.final) && /114[.,]50/.test(run.final) }),
        {
          failure: 'reasoning',
          otherwise:
            'The final answer names FixIt Depot as the cheapest shop and gives its price as €114.50, in any wording or number format.',
        },
      ),
      check('states-the-difference', (run) => ({ pass: /\b14[.,]50\b/.test(run.final) }), {
        failure: 'reasoning',
        otherwise:
          'The final answer states that the cheapest shop costs €14.50 less than the most expensive one (ToolBarn at €129.00), in any wording or number format.',
      }),
      check(
        'checked-the-shops-in-parallel',
        (run) => {
          const delegated = run.tools.filter((tool) => tool.name === 'delegate').length;
          return { pass: delegated >= 2, evidence: `${delegated} delegate calls` };
        },
        { aspect: 'process', failure: 'tool', required: false },
      ),
    ];
  },
});
