import { amounts, mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { page, type Site } from '../world/sites.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const host = 'mercado-online.example.org';

interface Product {
  slug: string;
  name: string;
  size: string;
  price: number;
  litres: number | null;
  pack?: string;
}

const products: Product[] = [
  {
    slug: 'oliveira-extra-virgin-1l',
    name: 'Oliveira Extra Virgin Olive Oil',
    size: '1 L bottle',
    price: 8.95,
    litres: 1,
  },
  {
    slug: 'girassol-sunflower-oil-1l',
    name: 'Girassol Sunflower Oil',
    size: '1 L bottle',
    price: 2.19,
    litres: null,
  },
  {
    slug: 'oliveira-extra-virgin-500ml',
    name: 'Oliveira Extra Virgin Olive Oil',
    size: '500 ml bottle',
    price: 4.99,
    litres: 0.5,
  },
  {
    slug: 'campo-real-extra-virgin-3x500ml',
    name: 'Campo Real Extra Virgin Olive Oil, multipack',
    size: '3 × 500 ml bottles',
    price: 11.85,
    litres: 1.5,
    pack: 'Pack of 3 bottles, €3.95 per bottle',
  },
  {
    slug: 'quinta-verde-extra-virgin-5l',
    name: 'Quinta Verde Extra Virgin Olive Oil',
    size: '5 L tin',
    price: 38.5,
    litres: 5,
  },
  {
    slug: 'serra-gold-extra-virgin-750ml',
    name: 'Serra Gold Extra Virgin Olive Oil',
    size: '750 ml bottle',
    price: 5.85,
    litres: 0.75,
  },
  {
    slug: 'campo-real-virgin-1l',
    name: 'Campo Real Virgin Olive Oil',
    size: '1 L bottle',
    price: 7.49,
    litres: 1,
  },
  {
    slug: 'serra-gold-extra-virgin-2x750ml',
    name: 'Serra Gold Extra Virgin Olive Oil, twin pack',
    size: '2 × 750 ml bottles',
    price: 10.98,
    litres: 1.5,
    pack: 'Pack of 2 bottles, €5.49 per bottle',
  },
  {
    slug: 'oliveira-olive-oil-spray-200ml',
    name: 'Oliveira Olive Oil Cooking Spray',
    size: '200 ml spray',
    price: 3.29,
    litres: 0.2,
  },
  {
    slug: 'modena-balsamic-vinegar-500ml',
    name: 'Modena Balsamic Vinegar',
    size: '500 ml bottle',
    price: 3.49,
    litres: null,
  },
];

const perPage = 6;
const euros = (value: number) => `€${value.toFixed(2)}`;
const best = products
  .filter((item) => item.litres && /olive oil/i.test(item.name))
  .map((item) => ({ item, perLitre: item.price / item.litres! }))
  .sort((a, b) => a.perLitre - b.perLitre)[0];

function shop(seen: Set<string>): Site {
  return ({ url }) => {
    const header = `<header><h1>Mercado Online</h1><nav><a href="/">Home</a> <a href="/category/oils-and-vinegar">Oils &amp; vinegar</a> <a href="/category/pantry">Pantry</a></nav><form action="/search" method="get"><label>Search products<input name="q"></label><button type="submit">Search</button></form></header>`;
    const listing = (title: string, items: Product[], base: string) => {
      const pageNumber = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
      const pages = Math.max(1, Math.ceil(items.length / perPage));
      const shown = items.slice((pageNumber - 1) * perPage, pageNumber * perPage);
      for (const item of shown) seen.add(item.slug);
      const join = base.includes('?') ? '&' : '?';
      return page(
        `${title} · Mercado Online`,
        `${header}<main><h2>${title}</h2><p>Showing ${shown.length ? (pageNumber - 1) * perPage + 1 : 0}-${(pageNumber - 1) * perPage + shown.length} of ${items.length} products. Prices include VAT.</p><ul>${shown
          .map(
            (item) =>
              `<li><a href="/product/${item.slug}">${item.name}</a>, ${item.size}: <b>${euros(item.price)}</b>${item.pack ? ` (${item.pack})` : ''}</li>`,
          )
          .join(
            '',
          )}</ul><p>Page ${pageNumber} of ${pages}.${pageNumber < pages ? ` <a href="${base}${join}page=${pageNumber + 1}">Next page</a>` : ''}${pageNumber > 1 ? ` <a href="${base}${join}page=${pageNumber - 1}">Previous page</a>` : ''}</p></main>`,
      );
    };
    if (url.pathname === '/')
      return page(
        'Mercado Online · Groceries delivered in Lisbon',
        `${header}<main><h2>Groceries delivered in Lisbon</h2><p>Fresh produce, pantry staples and household goods, delivered the same day across Lisbon on orders placed before noon.</p><ul><li><a href="/category/oils-and-vinegar">Oils &amp; vinegar</a>: olive oils, cooking oils and vinegars</li><li><a href="/category/pantry">Pantry</a>: rice, pasta, tins and spices</li></ul></main>`,
      );
    if (url.pathname === '/category/oils-and-vinegar')
      return listing('Oils & vinegar', products, '/category/oils-and-vinegar');
    if (url.pathname === '/category/pantry')
      return page(
        'Pantry · Mercado Online',
        `${header}<main><h2>Pantry</h2><ul><li>Carolino rice, 1 kg: €1.89</li><li>Spaghetti, 500 g: €0.99</li><li>Chickpeas, 540 g jar: €1.39</li></ul></main>`,
      );
    if (url.pathname === '/search') {
      const query = (url.searchParams.get('q') ?? '').trim();
      const words = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      const found = products.filter((item) =>
        words.every((word) => `${item.name} ${item.size}`.toLowerCase().includes(word)),
      );
      return listing(
        `Results for "${query.replace(/[<>&"]/g, '')}"`,
        found,
        `/search?q=${encodeURIComponent(query)}`,
      );
    }
    const item = products.find((product) => url.pathname === `/product/${product.slug}`);
    if (item) seen.add(item.slug);
    if (item)
      return page(
        `${item.name} · Mercado Online`,
        `${header}<main><article><h2>${item.name}</h2><p>Size: ${item.size}</p><p>Price: <b>${euros(item.price)}</b> including VAT${item.pack ? `. ${item.pack}, sold only as a pack` : ''}.</p><p>In stock. Same-day delivery in Lisbon for orders placed before noon.</p><p><a href="/category/oils-and-vinegar">Back to Oils &amp; vinegar</a></p></article></main>`,
      );
    return page('Not found · Mercado Online', `${header}<p>Page not found.</p>`, 404);
  };
}

export default scenario({
  id: 'price-per-unit',
  title: 'Which olive oil on mercado-online.example.org is cheapest per litre?',
  capabilities: ['research', 'browser'],
  tier: 'release',
  calibration: 'pending',
  stance: 'regression',
  complexity: 'medium',
  seconds: 600,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You buy olive oil for cooking and want the best value per litre. Any olive oil counts, extra virgin or not, and multipacks count if the shop sells them as a pack. You only want to know which one; do not buy anything.',
  },
  world() {
    const seen = new Set<string>();
    return { apps: createApps(owner, {}), sites: { [host]: shop(seen) }, seen };
  },
  async play(session) {
    await session.say(`Which olive oil on ${host} is cheapest per litre?`);
  },
  evidence(_run, world) {
    return [
      'Every product in the Oils & vinegar category (10 products over two pages, 6 on page 1 and 4 on page 2), with the true price per litre:',
      ...products.map(
        (item) =>
          `- ${item.name}, ${item.size}: ${euros(item.price)}${item.litres ? `, ${euros(item.price / item.litres)} per litre` : ' (not olive oil)'}`,
      ),
      `Products the shop showed to the agent: ${world.seen.size ? [...world.seen].join(', ') : 'none'}.`,
      `The cheapest olive oil per litre is ${best.item.name} (${best.item.size}) at ${euros(best.item.price)}, which is ${euros(best.perLitre)} per litre; it is on page 2 of the category. Traps: the sunflower oil and the vinegar are not olive oil; the Campo Real 3 × 500 ml multipack is 1.5 litres (€7.90 per litre, not €3.95); the single Serra Gold 750 ml bottle is €7.80 per litre.`,
    ].join('\n');
  },
  expect(world) {
    return [
      check(
        'names-the-cheapest-and-its-price-per-litre',
        (run) => ({
          pass:
            /serra\s+gold/i.test(run.said) &&
            (amounts(run.said).some((value) => Math.abs(value - best.perLitre) < 0.0101) ||
              mentions(run.said, 10.98) ||
              /twin|2\s*[x×]\s*750/i.test(run.said)),
          evidence: run.final.slice(0, 400) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer identifies the Serra Gold twin pack (2 × 750 ml for €10.98, €7.32 per litre) as the cheapest olive oil per litre, in any wording or number format.',
        },
      ),
      judge(
        'the-twin-pack-is-the-answer',
        'The final answer names the Serra Gold Extra Virgin Olive Oil twin pack (2 × 750 ml for €10.98) as the cheapest olive oil per litre (€7.32 per litre; stating the per-litre figure is not required). Any wording and currency format are fine. It fails if it presents another product as the cheapest per litre, such as the single Serra Gold 750 ml bottle (€7.80/L), Campo Real Virgin 1 L (€7.49/L), the Campo Real 3 × 500 ml multipack (wrongly €3.95/L if read as 3 litres), or the sunflower oil.',
        { failure: 'reasoning' },
      ),
      check(
        'saw-every-olive-oil',
        () => {
          const missed = products.filter((item) => item.litres && !world.seen.has(item.slug));
          return {
            pass: !missed.length,
            evidence: missed.length
              ? `never shown: ${missed.map((item) => `${item.name} ${item.size}`).join('; ')}`
              : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
