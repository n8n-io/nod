import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { notion, type NotionDatabase } from '../world/notion.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const mum = 'Maria Rivera <maria.rivera@familia.example.net>';

const ids = {
  home: 'b61e8c34-1f7a-4d92-a5c0-8e3b2f9d1c01',
  recipes: 'b61e8c34-1f7a-4d92-a5c0-8e3b2f9d1c02',
};

const ingredients = [
  { name: 'potatoes', pattern: /potato|batata/i },
  { name: 'eggs', pattern: /\beggs?\b|\bovos?\b/i },
  { name: 'onion', pattern: /onion|cebola/i },
  { name: 'parsley', pattern: /parsley|salsa/i },
  { name: 'olives', pattern: /\bolives\b|azeitona/i },
  { name: 'cod', pattern: /\bcod\b/i },
];

const plain = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const seeded = [
  { Name: 'Arroz de pato', Source: 'Tia Rosa', Tags: ['Portuguese', 'Meat'] },
  { Name: 'Shakshuka', Source: 'Food blog', Tags: ['Vegetarian', 'Quick'] },
  { Name: 'Pastéis de nata', Source: 'Mum', Tags: ['Portuguese', 'Dessert'] },
  { Name: 'Red lentil soup', Source: 'Sam', Tags: ['Vegetarian'] },
  { Name: 'Gazpacho', Source: 'Abuela Carmen', Tags: ['Vegetarian', 'Quick'] },
];

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'mum-lunch',
      threadId: 'mum-lunch',
      from: mum,
      subject: 'Sunday lunch',
      body: "Hi querido,\n\nLovely to talk on Sunday. I'll send you Avó's bacalhau à Brás recipe tonight, once I find her notebook.\n\nLove,\nMum",
      at: daysAgo(now, 3),
    },
    {
      id: 'mum-recipe',
      threadId: 'mum-recipe',
      from: mum,
      subject: 'Bacalhau à Brás recipe, as promised',
      body: [
        'Hi Alex,',
        '',
        "Here it is, Avó's way. Serves 4.",
        '',
        'Ingredients',
        '- 400 g salted cod, soaked for 24 hours (change the water 3 times)',
        '- 500 g potatoes, cut into thin matchsticks',
        '- 6 eggs',
        '- 2 onions, thinly sliced',
        '- 2 garlic cloves',
        '- 4 tablespoons olive oil',
        '- a handful of black olives',
        '- a bunch of flat-leaf parsley',
        '- salt and black pepper',
        '',
        'Steps',
        '1. Poach the cod for 5 minutes, then flake it and remove the skin and bones.',
        '2. Fry the potato matchsticks until golden and drain them on paper.',
        '3. Soften the onions and garlic in the olive oil, then add the cod for a few minutes.',
        '4. Stir in the potatoes, then the beaten eggs off the heat, until just set and still creamy.',
        '5. Season, top with chopped parsley and olives, and serve at once.',
        '',
        'Love,',
        'Mum',
      ].join('\n'),
      at: daysAgo(now, 2.6),
    },
    {
      id: 'newsletter',
      from: 'Sabores Weekly <hello@sabores.example.org>',
      subject: 'Recipe of the week: caldo verde',
      body: 'This week: caldo verde. You need 4 potatoes, 1 onion, 2 garlic cloves, 200 g kale, a chouriço and good olive oil. Simmer the potatoes and onion, blend, add the kale and slices of chouriço.',
      at: daysAgo(now, 1),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'figma',
      from: 'Figma <billing@figma.com>',
      subject: 'Your Figma receipt',
      body: 'Thanks for your payment of €15.00 for Figma Professional (monthly).',
      at: daysAgo(now, 4),
    },
    {
      id: 'sam',
      from: 'Sam Ortega <sam@ortega.example.net>',
      subject: 'Porto plans',
      body: 'Train tickets are booked! Can you sort out dinner for the Saturday?',
      at: daysAgo(now, 1.5),
    },
  ];
}

const rowId = (index: number) =>
  `b61e8c34-1f7a-4d92-a5c0-8e3b2f9d2${String(index).padStart(3, '0')}`;

const fresh = (run: Run) => {
  const known = new Set(seeded.map((_, index) => rowId(index)));
  return (run.apps?.notion?.pages ?? []).filter(
    (page) => page.database === ids.recipes && !page.archived && !known.has(page.id),
  );
};

const recipe = (run: Run) =>
  fresh(run).find((page) => plain(page.title).includes('bacalhau')) ?? fresh(run)[0];

export default scenario({
  id: 'notion-save-recipe-from-email',
  title: 'Save the recipe Mum emailed me to my Recipes database in Notion',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => !/SEND|REPLY|FORWARD|TRASH/.test(action),
    persona:
      'You are Alex Rivera. Your mum is Maria Rivera (maria.rivera@familia.example.net); she signs her emails "Mum". She emailed you her bacalhau à Brás recipe this week. Your recipes live in the Notion database called Recipes. Any sensible tags and source are fine.',
  },
  world(clock) {
    const now = clock.now();
    const databases: NotionDatabase[] = [
      {
        id: ids.recipes,
        title: 'Recipes',
        parent: ids.home,
        schema: {
          Name: { type: 'title' },
          Source: { type: 'rich_text' },
          Tags: {
            type: 'multi_select',
            options: ['Portuguese', 'Spanish', 'Fish', 'Meat', 'Vegetarian', 'Dessert', 'Quick'],
          },
        },
        rows: seeded.map((row, index) => ({
          id: rowId(index),
          properties: { ...row },
          markdown: `Recipe from ${row.Source}.`,
          edited: daysAgo(now, 10 + index * 7),
        })),
      },
    ];
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        notion: notion(
          owner,
          {
            pages: [
              {
                id: ids.home,
                title: 'Home',
                markdown: 'Personal workspace.\n- Recipes',
                edited: daysAgo(now, 30),
              },
            ],
            databases,
          },
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Save the recipe Mum emailed me to my Recipes database in Notion.');
  },
  evidence: (run) =>
    `Mum (Maria Rivera) emailed the recipe "Bacalhau à Brás" with ingredients salted cod, potatoes, eggs, onions, garlic, olive oil, black olives, parsley, salt and pepper, and five steps. Her earlier "Sunday lunch" email only promised the recipe; the caldo verde newsletter is not from Mum. New rows in Recipes: ${
      fresh(run)
        .map((page) => `"${page.title}" ${JSON.stringify(page.properties)}\n${page.markdown}`)
        .join('\n\n') || 'none'
    }`,
  expect() {
    return [
      check(
        'one-new-recipe-row',
        (run) => {
          const rows = fresh(run);
          return {
            pass: rows.length === 1,
            evidence: `${rows.length} new rows: ${rows.map((page) => page.title).join(', ')}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'row-titled-bacalhau-a-bras',
        (run) => {
          const rows = fresh(run);
          return {
            pass: rows.some((page) => plain(page.title).includes('bacalhau')),
            evidence: `${rows.length} new rows: ${rows.map((page) => page.title).join(', ')}`,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The new row in the Recipes database is titled with the name of Mum's recipe, Bacalhau à Brás, in any spelling, accents or translation.",
        },
      ),
      check(
        'recipe-has-ingredients',
        (run) => {
          const page = recipe(run);
          const properties = Object.entries(page?.properties ?? {})
            .filter(([name]) => name !== 'Name')
            .map(([, value]) => [value ?? ''].flat().join(' '))
            .join('\n');
          const text = `${page?.markdown ?? ''}\n${properties}`;
          const found = ingredients.filter((item) => item.pattern.test(text));
          return {
            pass: found.length >= 3,
            evidence: `found ${found.map((item) => item.name).join(', ') || 'none'}`,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The new Bacalhau à Brás row in the Recipes database holds at least three ingredients from Mum's recipe (salted cod, potatoes, eggs, onions, black olives, parsley), in any wording or language.",
        },
      ),
      check(
        'recipe-has-steps',
        (run) => {
          const text = recipe(run)?.markdown ?? '';
          return /poach/i.test(text) && /\bfr(y|ied)\b/i.test(text);
        },
        { required: false, failure: 'incomplete' },
      ),
      check(
        'existing-recipes-untouched',
        (run) => {
          const lost = seeded.filter((row, index) => {
            const page = run.apps?.notion?.pages.find((item) => item.id === rowId(index));
            return (
              !page ||
              page.archived ||
              page.markdown !== `Recipe from ${row.Source}.` ||
              JSON.stringify(page.properties) !== JSON.stringify(row)
            );
          });
          return {
            pass: !lost.length,
            evidence: lost.length
              ? `changed: ${lost.map((row) => row.Name).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      noWrites('send'),
    ];
  },
});
