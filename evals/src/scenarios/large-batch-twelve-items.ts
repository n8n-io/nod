import { dumpSheets, mentions } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, sheets, type Mail } from '../world/apps.ts';
import { daysAgo, localDate } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const book = '1Pq8xPurchasesLedgerRivera2026';
const zone = 'Europe/Madrid';

const orders = [
  {
    shop: 'Tinta & Papel',
    key: /tinta/i,
    sender: 'orders@tintaepapel.example.com',
    order: 'TP-48213',
    total: 38.4,
    days: 3,
  },
  {
    shop: 'Northwind Audio',
    key: /northwind/i,
    sender: 'shop@northwindaudio.example.net',
    order: 'NWA-1187',
    total: 129.9,
    days: 5,
  },
  {
    shop: 'Verde Garden Supply',
    key: /verde/i,
    sender: 'hello@verdegarden.example.org',
    order: 'VG-30552',
    total: 54.75,
    days: 7,
  },
  {
    shop: 'Kite & Co',
    key: /kite/i,
    sender: 'orders@kiteandco.example.com',
    order: 'KC-77120',
    total: 22.9,
    days: 9,
  },
  {
    shop: 'Atlas Outdoor',
    key: /atlas/i,
    sender: 'orders@atlasoutdoor.example.net',
    order: 'AO-904417',
    total: 189.99,
    days: 11,
  },
  {
    shop: 'Lumen Books',
    key: /lumen/i,
    sender: 'orders@lumenbooks.example.org',
    order: 'LB-2291',
    total: 31.5,
    days: 13,
  },
  {
    shop: 'Fernhill Coffee',
    key: /fernhill/i,
    sender: 'roastery@fernhill.example.com',
    order: 'FH-6034',
    total: 27.6,
    days: 15,
  },
  {
    shop: 'Pixel Forge',
    key: /pixel/i,
    sender: 'store@pixelforge.example.net',
    order: 'PF-55190',
    total: 74.2,
    days: 17,
  },
  {
    shop: 'Casa Barro',
    key: /barro/i,
    sender: 'loja@casabarro.example.org',
    order: 'CB-1408',
    total: 46.8,
    days: 19,
  },
  {
    shop: 'Oak & Thread',
    key: /oak/i,
    sender: 'orders@oakandthread.example.com',
    order: 'OT-73315',
    total: 112.35,
    days: 21,
  },
  {
    shop: 'Brisa Bikes',
    key: /brisa/i,
    sender: 'shop@brisabikes.example.net',
    order: 'BB-2087',
    total: 64.3,
    days: 24,
  },
  {
    shop: 'Saltwater Supply',
    key: /saltwater/i,
    sender: 'orders@saltwatersupply.example.org',
    order: 'SW-11942',
    total: 19.95,
    days: 27,
  },
];
const cancelled = orders[3];
const old = {
  shop: 'Moss & Stone',
  key: /moss/i,
  sender: 'orders@mossandstone.example.com',
  order: 'MS-5521',
  total: 88.1,
  days: 35,
};
const cart = { shop: 'Brava Shoes', key: /brava/i };
const counted = orders.filter((item) => item !== cancelled);

const euro = (value: number) => `€${value.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function hasDate(text: string, iso: string) {
  const [year, month, date] = iso.split('-').map(Number);
  const lower = text.toLowerCase();
  const years = `(?:${year}|${String(year).slice(2)})`;
  const name = months[month - 1];
  return (
    lower.includes(iso) ||
    new RegExp(`(^|\\D)${year}[/.]0?${month}[/.]0?${date}(\\D|$)`).test(lower) ||
    new RegExp(`(^|\\D)0?${date}[/.-]0?${month}[/.-]${years}(\\D|$)`).test(lower) ||
    new RegExp(`(^|\\D)0?${month}[/.-]0?${date}[/.-]${years}(\\D|$)`).test(lower) ||
    new RegExp(`(^|\\D)0?${date}(?:st|nd|rd|th)?[\\s-]+(?:of\\s+)?${name}`).test(lower) ||
    new RegExp(`${name}[a-z]*\\.?[\\s-]+0?${date}(\\D|$)`).test(lower)
  );
}

function confirmation(item: typeof old, at: number): Mail {
  return {
    id: `order-${item.order}`,
    from: `${item.shop} <${item.sender}>`,
    to: owner.email,
    subject: `Order confirmation #${item.order}`,
    body: `Hi Alex,\n\nThanks for shopping with ${item.shop}! We have received your order #${item.order}.\n\nOrder total: ${euro(item.total)} (VAT included)\n\nWe will email you again when it ships.\n\n${item.shop}`,
    at,
    labels: ['INBOX', 'CATEGORY_UPDATES'],
  };
}

function mailbox(now: number): Mail[] {
  const atlas = orders[4];
  return [
    ...orders.map((item) => confirmation(item, daysAgo(now, item.days))),
    confirmation(old, daysAgo(now, old.days)),
    {
      id: 'cancel-kite',
      from: `${cancelled.shop} <${cancelled.sender}>`,
      to: owner.email,
      subject: `Your order #${cancelled.order} has been cancelled`,
      body: `Hi Alex,\n\nAs requested, we have cancelled order #${cancelled.order}. A refund of ${euro(cancelled.total)} is on its way to your card and should arrive within 5 working days.\n\n${cancelled.shop}`,
      at: daysAgo(now, cancelled.days - 1),
      labels: ['INBOX', 'CATEGORY_UPDATES'],
    },
    {
      id: 'shipped-atlas',
      from: `${atlas.shop} <${atlas.sender}>`,
      to: owner.email,
      subject: `Your order #${atlas.order} is on its way`,
      body: `Good news, Alex! Order #${atlas.order} (${euro(atlas.total)}) has shipped and should arrive in 2 to 3 days.\n\n${atlas.shop}`,
      at: daysAgo(now, atlas.days - 2),
      labels: ['INBOX', 'CATEGORY_UPDATES'],
    },
    {
      id: 'cart-brava',
      from: 'Brava Shoes <hello@bravashoes.example.com>',
      to: owner.email,
      subject: 'You left something in your cart',
      body: 'Hi Alex, your Brava Trail Runner (€79.00) is still waiting in your cart. Complete your order before it sells out!',
      at: daysAgo(now, 4),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'promo-lumen',
      from: 'Lumen Books <news@lumenbooks.example.org>',
      to: owner.email,
      subject: '20% off everything this weekend',
      body: 'This weekend only: 20% off every book in the shop. No code needed.',
      at: daysAgo(now, 2),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214: packaging that sells',
      body: 'This week: packaging that sells, and a long read on pricing creative work.',
      at: daysAgo(now, 6),
    },
    {
      id: 'electric',
      from: 'Iberluz <facturas@iberluz.example.net>',
      to: owner.email,
      subject: 'Your electricity bill is ready: €86.40',
      body: 'Hello Alex, your electricity invoice for the last billing period is €86.40. It will be debited from your account in 6 days.',
      at: daysAgo(now, 8),
    },
    {
      id: 'recruiter',
      from: 'Nadia Perez <nadia@talentbridge.example.org>',
      to: owner.email,
      subject: 'Senior brand designer role in Lisbon',
      body: 'Hi Alex, would you have 15 minutes this week to hear about a role?',
      at: daysAgo(now, 10),
    },
    {
      id: 'quote',
      from: 'Ines Carvalho <ines@casavelha.example.org>',
      to: owner.email,
      subject: 'Quote request: restaurant menu redesign',
      body: 'Hello Alex, could you send me a quote for redesigning our menus?',
      at: daysAgo(now, 12),
    },
    {
      id: 'bank',
      from: 'Banco Atlântico <alerts@bancoatlantico.example.org>',
      to: owner.email,
      subject: 'You received a transfer of €760.00',
      body: 'Incoming transfer: €760.00 from OLIVE STUDIO LDA. Booked on your account ending 4471.',
      at: daysAgo(now, 14),
    },
  ];
}

const purchaseRows = (run: Run) =>
  (run.apps?.sheets?.books.find((item) => item.id === book)?.tabs ?? []).flatMap((tab) =>
    tab.rows.map((row) => row.join(' | ')).filter((row) => /\d/.test(row)),
  );

export default scenario({
  id: 'large-batch-twelve-items',
  title: 'Add every online order from the last 30 days to my Purchases sheet',
  capabilities: ['progress', 'apps', 'long-running'],
  tier: 'release',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  calibration: 'pending',
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. You track your online shopping in the Google Sheet called "Purchases". Any date and amount format is fine. A cancelled order can be left out or marked as cancelled, whichever the assistant prefers. Abandoned carts and promotions are not orders.',
  },
  world(clock) {
    const now = clock.now();
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        sheets: sheets(
          [
            {
              id: book,
              title: 'Purchases',
              tabs: [{ name: 'Purchases', rows: [['Shop', 'Date', 'Total']] }],
            },
          ],
          clock.now,
        ),
      }),
      dates: Object.fromEntries(
        orders.map((item) => [item.shop, localDate(daysAgo(now, item.days), zone)]),
      ) as Record<string, string>,
    };
  },
  async play(session) {
    await session.say(
      'Add every online order from the last 30 days to my Purchases sheet with shop, date and total.',
    );
  },
  evidence(run, world) {
    return `${dumpSheets(run)}\n\nThe 12 order confirmations from the last 30 days: ${orders.map((item) => `${item.shop} ${world.dates[item.shop]} ${euro(item.total)}`).join('; ')}. ${cancelled.shop}'s order was cancelled afterwards (leaving it out or marking it cancelled are both fine). ${old.shop} (${euro(old.total)}) is ${old.days} days old and outside the window. The Brava Shoes email is an abandoned cart, the Lumen Books promotion and the Atlas Outdoor shipping notice are not new orders.`;
  },
  expect(world) {
    return [
      check(
        'every-order-with-its-total',
        (run) => {
          const rows = purchaseRows(run);
          const missing = counted.filter(
            (item) => !rows.some((row) => item.key.test(row) && mentions(row, item.total)),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing or wrong total: ${missing.map((item) => item.shop).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'leaves-out-the-35-day-old-order',
        (run) => {
          const rows = purchaseRows(run);
          return {
            pass: rows.length > 0 && !rows.some((row) => old.key.test(row)),
            evidence: rows.some((row) => old.key.test(row))
              ? `${old.shop} was added`
              : `${rows.length} rows`,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'old-order-not-recorded-as-a-purchase',
        `The Purchases sheet does not record the ${old.shop} order (${old.order}, ${euro(old.total)}, ${old.days} days old) as one of the orders from the last 30 days. A note or separate tab that clearly marks it as excluded or outside the 30 days is fine; it fails if it appears as an ordinary purchase row.`,
        { failure: 'reasoning' },
      ),
      check(
        'no-cart-or-duplicate-rows',
        (run) => {
          const rows = purchaseRows(run);
          const repeated = orders.filter(
            (item) => rows.filter((row) => item.key.test(row)).length > 1,
          );
          const carted = rows.some((row) => cart.key.test(row));
          return {
            pass: !repeated.length && !carted,
            evidence: `${repeated.map((item) => item.shop).join(', ') || 'no'} duplicates; abandoned cart ${carted ? 'added' : 'left out'}`,
          };
        },
        { required: false, failure: 'reasoning' },
      ),
      judge(
        'abandoned-cart-not-recorded-as-a-purchase',
        `The Purchases sheet does not record the ${cart.shop} abandoned cart as an order. A note that clearly marks it as an abandoned cart or not an order is fine; it fails if it appears as an ordinary purchase row.`,
        { failure: 'reasoning' },
      ),
      check(
        'cancelled-order-left-out-or-marked',
        (run) => {
          const row = purchaseRows(run).find((line) => cancelled.key.test(line));
          return { pass: !row || /cancel|refund/i.test(row), evidence: row };
        },
        { required: false, failure: 'reasoning' },
      ),
      check(
        'order-dates-filled-in',
        (run) => {
          const rows = purchaseRows(run);
          const wrong = counted.filter((item) => {
            const row = rows.find((line) => item.key.test(line)) ?? '';
            return !hasDate(row, world.dates[item.shop]);
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? `no matching date: ${wrong.map((item) => item.shop).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
    ];
  },
});
