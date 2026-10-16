import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const countries = [
  { name: 'Germany', completed: 28, base: 96, refunds: [18.4, 22.9] },
  { name: 'Netherlands', completed: 21, base: 91, refunds: [64.5, 71.2, 58.3] },
  { name: 'France', completed: 26, base: 86, refunds: [90.1, 77.7] },
  { name: 'Belgium', completed: 15, base: 81, refunds: [] },
  { name: 'Ireland', completed: 19, base: 78, refunds: [312.4, 289.9, 345, 298.75, 330.2] },
  { name: 'Spain', completed: 34, base: 74, refunds: [55, 61.4] },
  { name: 'Italy', completed: 24, base: 70, refunds: [44.9] },
  { name: 'Portugal', completed: 18, base: 66, refunds: [] },
];

interface Order {
  country: string;
  cents: number;
  status: 'completed' | 'refunded';
}

function orders() {
  const list: Order[] = [];
  countries.forEach((country, index) => {
    for (let item = 0; item < country.completed; item++)
      list.push({
        country: country.name,
        cents:
          (country.base + ((item * 29 + index * 13) % 61) - 30) * 100 +
          ((item * 37 + index * 53) % 100),
        status: 'completed',
      });
    for (const amount of country.refunds)
      list.push({ country: country.name, cents: Math.round(amount * 100), status: 'refunded' });
  });
  const rows = new Array<Order>(list.length);
  list.forEach((order, index) => (rows[(index * 73) % list.length] = order));
  return rows;
}

function ranking(rows: Order[], statuses: Order['status'][]) {
  return countries
    .map((country) => {
      const counted = rows.filter(
        (row) => row.country === country.name && statuses.includes(row.status),
      );
      const exact = counted.reduce((sum, row) => sum + row.cents, 0) / counted.length / 100;
      return { country: country.name, orders: counted.length, exact };
    })
    .sort((a, b) => b.exact - a.exact);
}

function exportCsv(rows: Order[]) {
  return [
    'order_id,order_date,country,amount,status',
    ...rows.map(
      (row, index) =>
        `ORD-${24001 + index},2026-09-${String(1 + Math.floor((index * 30) / rows.length)).padStart(2, '0')},${row.country},${(row.cents / 100).toFixed(2)},${row.status}`,
    ),
  ].join('\n');
}

const numbers = (text: string) =>
  [...text.matchAll(/(\d+(?:[,.  ]\d{3})*)(?:[.,](\d{1,2})(?!\d))?/g)].map((match) => ({
    at: match.index,
    value: Number(match[1].replace(/\D/g, '') + (match[2] ? `.${match[2]}` : '')),
  }));

function inOrder(positions: number[][]) {
  let after = -1;
  for (const options of positions) {
    const next = options.filter((at) => at > after).sort((a, b) => a - b)[0];
    if (next === undefined) return false;
    after = next;
  }
  return true;
}

function answers(text: string, top: Array<{ country: string; exact: number }>) {
  const names = top.map((item) =>
    [...text.matchAll(new RegExp(`\\b${item.country}\\b`, 'gi'))].map((match) => match.index),
  );
  const found = numbers(text);
  const values = top.map((item) =>
    found.filter((number) => Math.abs(number.value - item.exact) <= 0.0101).map((n) => n.at),
  );
  return inOrder(names) && inOrder(values);
}

export default scenario({
  id: 'csv-average-by-country',
  title: "What's the average completed order value by country? Give me the top three",
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached orders.csv is the September order export from your shop, with amounts in euros. You want the answer in chat, ranked by average completed order value, with each average to the cent.',
  },
  world() {
    const rows = orders();
    return {
      apps: createApps(owner, {}),
      csv: exportCsv(rows),
      top: ranking(rows, ['completed']).slice(0, 3),
      completed: ranking(rows, ['completed']),
      withRefunds: ranking(rows, ['completed', 'refunded']),
    };
  },
  async play(session, world) {
    const id = await session.upload('orders.csv', Buffer.from(world.csv), 'text/csv');
    await session.say(
      "Here's my orders export. What's the average completed order value by country, to the cent? Give me the top three.",
      { attach: [id] },
    );
  },
  evidence(_run, world) {
    const describe = (list: typeof world.completed) =>
      list
        .map((item) => `${item.country} €${item.exact.toFixed(4)} (${item.orders} orders)`)
        .join('; ');
    return `orders.csv has 200 orders: 185 completed and 15 refunded. Average completed order value by country, highest first: ${describe(world.completed)}. Correct top three: ${world.top.map((item) => `${item.country} €${item.exact.toFixed(2)}`).join(', ')}. If refunded orders were wrongly included, the ranking would be: ${describe(world.withRefunds)}.`;
  },
  expect(world) {
    return [
      check(
        'names-the-top-three-in-order-with-their-averages',
        (run: Run) => {
          const hit = run.replies.some((reply) => answers(reply, world.top));
          return {
            pass: hit,
            evidence: hit
              ? undefined
              : `expected ${world.top.map((item) => `${item.country} ${item.exact.toFixed(2)}`).join(', ')} in that order in one reply`,
          };
        },
        {
          failure: 'reasoning',
          otherwise: `One reply ranks the top three countries by average completed order value as ${world.top.map((item) => `${item.country} at €${item.exact.toFixed(2)}`).join(', then ')}, with each average to the cent in any wording or number format.`,
        },
      ),
    ];
  },
});
