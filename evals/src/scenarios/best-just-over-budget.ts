import { mentions } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'soundhouse.example.com';
const products = [
  {
    path: '/p/sony-wh-1000xm5',
    name: 'Sony WH-1000XM5',
    price: 342,
    score: '9.6',
    note: 'Our best wireless headphones overall: class-leading noise cancelling, sound and call quality, 30-hour battery.',
  },
  {
    path: '/p/sennheiser-momentum-4',
    name: 'Sennheiser Momentum 4 Wireless',
    price: 299,
    score: '9.1',
    note: 'Excellent sound and a 60-hour battery, with strong noise cancelling.',
  },
  {
    path: '/p/bose-quietcomfort-45',
    name: 'Bose QuietComfort 45',
    price: 249,
    score: '8.7',
    note: 'Very comfortable, with good noise cancelling.',
  },
  {
    path: '/p/jabra-evolve2-65-flex',
    name: 'Jabra Evolve2 65 Flex',
    price: 144,
    score: '8.0',
    note: 'A foldable work headset with a boom microphone for calls.',
  },
  {
    path: '/p/soundcore-space-q45',
    name: 'Soundcore Space Q45',
    price: 99,
    score: '7.8',
    note: 'Good value noise cancelling.',
  },
];

const soundhouse: Site = ({ url }) => {
  const header =
    '<header><h1>SoundHouse</h1><nav><a href="/">Headphones</a> <a href="/delivery">Delivery</a></nav></header>';
  if (url.pathname === '/')
    return page(
      'SoundHouse · Wireless headphones',
      `${header}<main><h2>Wireless headphones</h2><p>Every pair is tested by our sound team and scored out of 10. Prices include VAT, and delivery to Portugal is free.</p><table><tr><th>Headphones</th><th>Sound team score</th><th>Price</th></tr>${products
        .map(
          (product) =>
            `<tr><td><a href="${product.path}">${product.name}</a></td><td>${product.score}/10</td><td>€${product.price}.00</td></tr>`,
        )
        .join('')}</table></main>`,
    );
  const product = products.find((item) => item.path === url.pathname);
  if (product)
    return page(
      `${product.name} · SoundHouse`,
      `${header}<main><article><h2>${product.name}</h2><p>Sound team score: <b>${product.score}/10</b>. ${product.note}</p><p>Price: <b>€${product.price}.00</b> including VAT. In stock, free delivery to Portugal in 2-3 working days.</p></article></main>`,
    );
  if (url.pathname === '/delivery')
    return page(
      'Delivery · SoundHouse',
      `${header}<main><h2>Delivery</h2><p>Free tracked delivery to Portugal and Spain on every order.</p></main>`,
    );
  return page('Not found · SoundHouse', `${header}<p>Page not found.</p>`, 404);
};

export default scenario({
  id: 'best-just-over-budget',
  title: 'What are the best headphones I can get from SoundHouse for €340?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'simple',
  seconds: 420,
  user: {
    answers: [
      {
        when: /budget|stretch|over|more than|extra/i,
        say: 'Tell me what you recommend.',
      },
    ],
    persona:
      'You are Alex Rivera in Lisbon. You want the best wireless headphones overall from SoundHouse, for music and everyday use, and your budget is €340. You have not decided whether you would pay a little more.',
  },
  world() {
    return { apps: createApps(owner, {}), sites: { [host]: soundhouse } };
  },
  async play(session) {
    await session.say(`What are the best headphones I can get from https://${host} for €340?`);
  },
  evidence(run) {
    return [
      'Ground truth from the shop, all prices with free delivery to Portugal:',
      '- Sony WH-1000XM5: 9.6/10, €342. The best pair overall, €2 over the €340 budget.',
      '- Sennheiser Momentum 4 Wireless: 9.1/10, €299. The best pair within the budget.',
      '- Bose QuietComfort 45: 8.7/10, €249. Jabra Evolve2 65 Flex: 8.0/10, €144, a work headset. Soundcore Space Q45: 7.8/10, €99.',
      'The miss this case is built to catch: recommending within the budget without saying that the best pair, the Sony at €342, is just over it.',
      `Product pages opened: ${products.filter((product) => run.visits.some((visit) => visit.host === host && visit.path === product.path)).length} of ${products.length}.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'names-the-best-pair-just-over-budget',
        (run) => ({
          pass: /sony|wh-?\s?1000\s?xm5/i.test(run.said) && mentions(run.said, 342),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer names the Sony WH-1000XM5 with its €342 price, so the owner learns that the best pair is just over the €340 budget.',
        },
      ),
      check(
        'recommends-the-best-pair-within-budget',
        (run) => ({
          pass: /momentum\s?4|sennheiser/i.test(run.said),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer recommends the Sennheiser Momentum 4 Wireless (€299) as the best pair within the €340 budget.',
        },
      ),
    ];
  },
});
