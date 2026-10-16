import { mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const config =
  'Intel Core Ultra 7 155U, 32 GB RAM, 1 TB SSD, 14" 2.8K OLED display, Windows 11 Pro';
const hosts = {
  techshop: 'techshop-a.example.com',
  pcmundo: 'pcmundo.example.net',
  byteshop: 'byteshop.example.org',
};
const productPaths = {
  techshop: '/p/thinkpad-x1-carbon-gen-12',
  pcmundo: '/producto/thinkpad-x1-carbon-gen-12',
  byteshop: '/products/x1-carbon-gen12-32gb-1tb',
};

const techshop: Site = ({ url }) => {
  const header =
    '<header><h1>TechShop</h1><nav><a href="/">Laptops</a> <a href="/delivery">Delivery</a> <a href="/help">Help</a></nav></header>';
  const products = [
    ['/p/thinkpad-x1-carbon-gen-12', 'Lenovo ThinkPad X1 Carbon Gen 12', '€1,019.00'],
    ['/p/thinkpad-x1-carbon-gen-11', 'Lenovo ThinkPad X1 Carbon Gen 11', '€849.00'],
    ['/p/thinkpad-t14s-gen-5', 'Lenovo ThinkPad T14s Gen 5', '€1,149.00'],
  ];
  if (url.pathname === '/')
    return page(
      'TechShop · Business laptops',
      `${header}<main><h2>Business laptops</h2><p>All prices include VAT. We ship from Madrid to Spain, Portugal and France.</p><ul>${products
        .map(([href, name, price]) => `<li><a href="${href}">${name}</a>: ${price}</li>`)
        .join('')}</ul></main>`,
    );
  if (url.pathname === productPaths.techshop)
    return page(
      'Lenovo ThinkPad X1 Carbon Gen 12 · TechShop',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Carbon Gen 12</h2><p>${config}. New, sealed box, 3-year Lenovo Premier warranty.</p><p>Price: <b>€1,019.00</b> including VAT</p><p>In stock. Ships within 1 working day.</p><h3>Delivery</h3><table><tr><th>Destination</th><th>Delivery cost</th><th>Time</th></tr><tr><td>Spain</td><td>€9.00</td><td>1-2 working days</td></tr><tr><td>Portugal</td><td>€19.00</td><td>2-3 working days</td></tr><tr><td>France</td><td>€25.00</td><td>3-5 working days</td></tr></table><p><b>Free delivery to Spain and Portugal on orders over €1,000.</b> The free delivery is applied automatically at checkout.</p><p>See our <a href="/delivery">delivery page</a> for details.</p></article></main>`,
    );
  if (url.pathname === '/p/thinkpad-x1-carbon-gen-11')
    return page(
      'Lenovo ThinkPad X1 Carbon Gen 11 · TechShop',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Carbon Gen 11</h2><p>Intel Core i7-1355U, 16 GB RAM, 512 GB SSD, 14" WUXGA display. Previous generation.</p><p>Price: <b>€849.00</b> including VAT</p><p>See our <a href="/delivery">delivery page</a> for delivery costs.</p></article></main>`,
    );
  if (url.pathname === '/p/thinkpad-t14s-gen-5')
    return page(
      'Lenovo ThinkPad T14s Gen 5 · TechShop',
      `${header}<main><article><h2>Lenovo ThinkPad T14s Gen 5</h2><p>Intel Core Ultra 7 165U, 32 GB RAM, 1 TB SSD, 14" WUXGA display.</p><p>Price: <b>€1,149.00</b> including VAT</p></article></main>`,
    );
  if (url.pathname === '/delivery')
    return page(
      'Delivery · TechShop',
      `${header}<main><article><h2>Delivery</h2><p>We deliver to Spain, Portugal and France with tracked courier delivery. Orders placed before 14:00 on a working day leave our Madrid warehouse the same day.</p><table><tr><th>Destination</th><th>Delivery cost</th></tr><tr><td>Spain</td><td>€9.00</td></tr><tr><td>Portugal</td><td>€19.00</td></tr><tr><td>France</td><td>€25.00</td></tr></table><p>Orders over €1,000 ship free to Spain and Portugal. France always pays the delivery cost.</p></article></main>`,
    );
  if (url.pathname === '/help')
    return page(
      'Help · TechShop',
      `${header}<main><h2>Help</h2><p>Questions about an order? Write to help@techshop-a.example.com.</p></main>`,
    );
  return page('Not found · TechShop', `${header}<p>Page not found.</p>`, 404);
};

const pcmundo: Site = ({ url }) => {
  const header =
    '<header><h1>PCMundo</h1><nav><a href="/">Home</a> <a href="/envios">Shipping</a></nav><form action="/buscar" method="get"><label>Search<input name="q"></label><button type="submit">Search</button></form></header>';
  const products = [
    [
      productPaths.pcmundo,
      'Lenovo ThinkPad X1 Carbon Gen 12 (Core Ultra 7, 32 GB, 1 TB)',
      '999,00 €',
    ],
    [
      '/producto/thinkpad-x1-carbon-gen-11',
      'Lenovo ThinkPad X1 Carbon Gen 11 (i7, 16 GB, 512 GB)',
      '829,00 €',
    ],
    [
      '/producto/thinkpad-e14-gen-6',
      'Lenovo ThinkPad E14 Gen 6 (Core Ultra 5, 16 GB, 512 GB)',
      '689,00 €',
    ],
  ];
  const list = (items: string[][]) =>
    `<ul>${items
      .map(([href, name, price]) => `<li><a href="${href}">${name}</a>: ${price} VAT included</li>`)
      .join('')}</ul>`;
  if (url.pathname === '/')
    return page(
      'PCMundo · Laptops at the best price',
      `${header}<main><h2>Lenovo ThinkPad deals</h2><p>Prices include VAT. We ship from Valencia to Spain, Portugal and the rest of the EU.</p>${list(products)}</main>`,
    );
  if (url.pathname === '/buscar') {
    const words = (url.searchParams.get('q') ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const found = products.filter(([, name]) =>
      words.every((word) =>
        name
          .toLowerCase()
          .match(/[a-z0-9]+/g)!
          .includes(word),
      ),
    );
    return page(
      'Search · PCMundo',
      `${header}<main><h2>Results</h2>${found.length ? list(found) : '<p>No products match your search.</p>'}</main>`,
    );
  }
  if (url.pathname === productPaths.pcmundo)
    return page(
      'Lenovo ThinkPad X1 Carbon Gen 12 · PCMundo',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Carbon Gen 12</h2><p>${config}. New, 3-year manufacturer warranty.</p><p>Price: <b>999,00 €</b> VAT included</p><p>In stock in our Valencia warehouse.</p><h3>Shipping</h3><ul><li>Spain (mainland): 4,95 €. <b>Free shipping on orders over 50 € to mainland Spain.</b></li><li>Portugal: 29,00 €, 3-5 working days.</li><li>Rest of the EU: 39,00 €.</li></ul><p>Free shipping offers apply to mainland Spain only. Full details on our <a href="/envios">shipping page</a>.</p></article></main>`,
    );
  if (url.pathname === '/producto/thinkpad-x1-carbon-gen-11')
    return page(
      'Lenovo ThinkPad X1 Carbon Gen 11 · PCMundo',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Carbon Gen 11</h2><p>Intel Core i7-1365U, 16 GB RAM, 512 GB SSD. Previous generation.</p><p>Price: <b>829,00 €</b> VAT included</p></article></main>`,
    );
  if (url.pathname === '/producto/thinkpad-e14-gen-6')
    return page(
      'Lenovo ThinkPad E14 Gen 6 · PCMundo',
      `${header}<main><article><h2>Lenovo ThinkPad E14 Gen 6</h2><p>Intel Core Ultra 5 125U, 16 GB RAM, 512 GB SSD.</p><p>Price: <b>689,00 €</b> VAT included</p></article></main>`,
    );
  if (url.pathname === '/envios')
    return page(
      'Shipping · PCMundo',
      `${header}<main><article><h2>Shipping costs</h2><table><tr><th>Destination</th><th>Cost</th></tr><tr><td>Spain (mainland)</td><td>4,95 €, free over 50 €</td></tr><tr><td>Portugal</td><td>29,00 €</td></tr><tr><td>Rest of the EU</td><td>39,00 €</td></tr></table><p>The free shipping threshold only applies to mainland Spain. Portugal always pays 29,00 € whatever the order value.</p></article></main>`,
    );
  return page('Not found · PCMundo', `${header}<p>Page not found.</p>`, 404);
};

const byteshop: Site = ({ url }) => {
  const header =
    '<header><h1>ByteShop</h1><nav><a href="/">Shop</a> <a href="/shipping">Shipping</a> <a href="/plus">ByteShop Plus</a> <a href="/login">Sign in</a></nav></header>';
  if (url.pathname === '/')
    return page(
      'ByteShop · Laptops',
      `${header}<main><h2>Laptops</h2><p>Prices include VAT. Plus members get exclusive prices: <a href="/plus">learn about ByteShop Plus</a>.</p><ul><li><a href="${productPaths.byteshop}">Lenovo ThinkPad X1 Carbon Gen 12, 32 GB, 1 TB</a>: <b>Plus member price €979.00</b>, €1,049.00 for everyone else</li><li><a href="/products/x1-yoga-gen9">Lenovo ThinkPad X1 Yoga Gen 9</a>: €1,199.00</li></ul></main>`,
    );
  if (url.pathname === productPaths.byteshop)
    return page(
      'Lenovo ThinkPad X1 Carbon Gen 12 · ByteShop',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Carbon Gen 12</h2><p>${config}. New, 3-year warranty.</p><p>Price: <b>€1,049.00</b> including VAT</p><p>ByteShop Plus member price: <b>€979.00</b>. Only for signed-in customers with an active ByteShop Plus membership (€49 a year). The member price is applied at checkout after you sign in.</p><p>In stock. Delivery costs depend on the destination: see <a href="/shipping">shipping costs</a>.</p></article></main>`,
    );
  if (url.pathname === '/products/x1-yoga-gen9')
    return page(
      'Lenovo ThinkPad X1 Yoga Gen 9 · ByteShop',
      `${header}<main><article><h2>Lenovo ThinkPad X1 Yoga Gen 9</h2><p>Intel Core Ultra 7, 16 GB RAM, 512 GB SSD, 2-in-1.</p><p>Price: <b>€1,199.00</b> including VAT</p></article></main>`,
    );
  if (url.pathname === '/shipping')
    return page(
      'Shipping · ByteShop',
      `${header}<main><article><h2>Shipping costs</h2><p>We ship from Porto with tracked delivery.</p><table><tr><th>Destination</th><th>Standard delivery</th></tr><tr><td>Portugal</td><td>€9.90</td></tr><tr><td>Spain</td><td>€12.90</td></tr><tr><td>France</td><td>€19.90</td></tr></table><p>ByteShop Plus members get free standard delivery on every order. Customers without Plus pay the standard delivery cost above.</p></article></main>`,
    );
  if (url.pathname === '/plus')
    return page(
      'ByteShop Plus',
      `${header}<main><h2>ByteShop Plus</h2><p>€49 a year. Member prices on selected products and free standard delivery. Sign in with your Plus account to see member prices at checkout.</p></main>`,
    );
  if (url.pathname === '/login')
    return page(
      'Sign in · ByteShop',
      `${header}<main><h2>Sign in</h2><form><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button type="button">Sign in</button></form></main>`,
    );
  return page('Not found · ByteShop', `${header}<p>Page not found.</p>`, 404);
};

export default scenario({
  id: 'compare-three-laptops',
  title:
    'Which of these three shops sells the ThinkPad X1 Carbon Gen 12 cheapest including delivery to Portugal?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'medium',
  seconds: 600,
  user: {
    approve: true,
    answers: [
      {
        when: /member|\bplus\b|sign(?:ed)?[ -]?in/i,
        say: 'No, I am not a member of any of these shops and I have no account with them.',
      },
    ],
    persona:
      'You are Alex Rivera. You live in Lisbon, mainland Portugal, and want the laptop delivered there. You are not a member of any of these shops, have no account with them, and do not want to join a membership. You want the new Gen 12 exactly as listed, not a different model.',
  },
  world() {
    return {
      apps: createApps(owner, {}),
      sites: {
        [hosts.techshop]: techshop,
        [hosts.pcmundo]: pcmundo,
        [hosts.byteshop]: byteshop,
      },
    };
  },
  async play(session) {
    await session.say(
      `Which of these three shops sells the ThinkPad X1 Carbon Gen 12 cheapest including delivery to Portugal? https://${hosts.techshop}, https://${hosts.pcmundo}, https://${hosts.byteshop}`,
    );
  },
  evidence(run) {
    const opened = Object.entries(productPaths)
      .filter(([key, path]) =>
        run.visits.some(
          (visit) => visit.host === hosts[key as keyof typeof hosts] && visit.path === path,
        ),
      )
      .map(([key]) => key);
    return [
      'Ground truth for the same ThinkPad X1 Carbon Gen 12 (Core Ultra 7, 32 GB, 1 TB) delivered to Portugal for a customer with no membership:',
      '- TechShop (techshop-a.example.com): €1,019.00, Portugal delivery normally €19.00 but free on orders over €1,000, so the total is €1,019.00. This is the cheapest.',
      '- PCMundo (pcmundo.example.net): 999,00 € plus 29,00 € shipping to Portugal (its free shipping over 50 € is for mainland Spain only), total €1,028.00.',
      '- ByteShop (byteshop.example.org): €1,049.00 plus €9.90 delivery, total €1,058.90. The €979.00 price and the free delivery are only for signed-in ByteShop Plus members (€49 a year), which the user is not.',
      'Wrong answers this case is built to catch: PCMundo because of its lower sticker price (€999 without delivery, or with the Spain-only free shipping wrongly applied), TechShop at €1,038 (missing the free delivery over €1,000), ByteShop at €988.90 or €979 (applying the members-only price or delivery).',
      `Gen 12 product pages opened: ${opened.join(', ') || 'none'}.`,
    ].join('\n');
  },
  expect() {
    return [
      check(
        'names-techshop-and-its-total',
        (run) => ({
          pass: /tech\s*shop/i.test(run.said) && mentions(run.said, 1019),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer names TechShop with its total of €1,019 for the ThinkPad X1 Carbon Gen 12 delivered to Portugal, in any wording or price format.',
        },
      ),
      judge(
        'techshop-is-presented-as-the-cheapest',
        'The final answer presents TechShop (techshop-a.example.com) as the cheapest shop for the ThinkPad X1 Carbon Gen 12 delivered to Portugal, at a total of €1,019 (its delivery is free because the order is over €1,000). Any wording, order or currency format is fine, and listing the other shops with their totals is fine. It fails if any other shop is presented as the cheapest, for example PCMundo (€999 + €29 = €1,028) or ByteShop using the members-only price (€979, or €988.90 with delivery), if it gives the TechShop total as €1,038 (charging delivery that is free over €1,000), or if the answer leaves the choice open. Mentioning €1,038 only to explain the free delivery passes.',
        { failure: 'reasoning' },
      ),
      check(
        'opened-the-gen-12-page-on-every-shop',
        (run) => {
          const opened = Object.entries(productPaths).filter(([key, path]) =>
            run.visits.some(
              (visit) => visit.host === hosts[key as keyof typeof hosts] && visit.path === path,
            ),
          );
          return {
            pass: opened.length === 3,
            evidence: opened.map(([key]) => key).join(', ') || 'none',
          };
        },
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
