import { check, judge, scenario } from '../scenario.ts';
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
    const header = `<header><h1>${item.name}</h1></header>`;
    if (url.pathname === '/products/halden-18v') {
      seen.add(item.host);
      return page(
        `Halden 18V cordless drill · ${item.name}`,
        `${header}<h2>Halden 18V cordless drill</h2><p>Price: <b>€${item.price}</b> including VAT</p>`,
      );
    }
    return page(
      item.name,
      `${header}<p><a href="/products/halden-18v">Halden 18V cordless drill</a></p>`,
    );
  };
}

export default scenario({
  id: 'language-follows-latest-message',
  title: 'A task started in German reports in English after the owner switches to English',
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
    await session.sayDuringWithAttachments(
      `Vergleiche bitte den Preis der Halden 18V Akku-Bohrmaschine bei ${shops.map((item) => item.host).join(', ')} und sag mir, wo sie am günstigsten ist.`,
      "Unrelated question while that runs: what's a good short name for a hardware newsletter? One suggestion is enough.",
      [],
    );
  },
  expect(world) {
    return [
      check(
        'compared-all-three-shops',
        () => ({ pass: world.seen.size === 3, evidence: [...world.seen].join(', ') || 'none' }),
        { failure: 'incomplete' },
      ),
      check(
        'names-the-cheapest-shop',
        (run) => ({ pass: /fix\s*it\s*depot/i.test(run.said) && /114[.,]50/.test(run.said) }),
        {
          failure: 'reasoning',
          otherwise: 'Nod names FixIt Depot at €114.50 as the cheapest, in any wording.',
        },
      ),
      judge(
        'speaks-the-latest-language',
        "The owner's last message is in English. Nod's drill price result from the task the owner started in German, and every other message Nod sent after the owner's English message, are written in English. The one exception is a short acknowledgement that starts the German request and was sent within a few seconds of the English message, because it was written before Nod read that message. Shop names, prices and quoted page text do not count. Any other German sentence from Nod after the owner's English message fails.",
        { failure: 'reasoning' },
      ),
    ];
  },
});
