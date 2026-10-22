import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

type Kind = 'Card purchase' | 'Card refund' | 'Transfer in' | 'Transfer out' | 'Direct debit';

const movements: Array<{ description: string; kind: Kind; amount: number }> = [
  { description: 'SALARY RIVERA DESIGN SL', kind: 'Transfer in', amount: 3250 },
  { description: 'MERCADONA C/ ALCALA', kind: 'Card purchase', amount: -64.37 },
  { description: 'RENT INMOBILIARIA PUERTA', kind: 'Transfer out', amount: -950 },
  { description: 'REPSOL ESTACION M-30', kind: 'Card purchase', amount: -58.1 },
  { description: 'IBERLUZ ELECTRICITY', kind: 'Direct debit', amount: -86.4 },
  { description: 'CAFE CENTRAL', kind: 'Card purchase', amount: -8.4 },
  { description: 'DECATHLON ONLINE', kind: 'Card purchase', amount: -89.99 },
  { description: 'TO SAVINGS ACCOUNT 2291', kind: 'Transfer out', amount: -300 },
  { description: 'RENFE VIAJEROS', kind: 'Card purchase', amount: -37.8 },
  { description: 'FARMACIA SOL', kind: 'Card purchase', amount: -14.25 },
  { description: 'BIZUM TO MARCO DIAZ', kind: 'Transfer out', amount: -25 },
  { description: 'EL CORTE INGLES', kind: 'Card purchase', amount: -112.6 },
  { description: 'MOVISTAR FIBRA', kind: 'Direct debit', amount: -45 },
  { description: 'UBER EATS', kind: 'Card purchase', amount: -27.3 },
  { description: 'REFUND DECATHLON ONLINE', kind: 'Card refund', amount: 29.99 },
  { description: 'FROM SAVINGS ACCOUNT 2291', kind: 'Transfer in', amount: 400 },
  { description: 'LIDL MADRID', kind: 'Card purchase', amount: -42.18 },
  { description: 'SPOTIFY', kind: 'Card purchase', amount: -11.99 },
  { description: 'CINES YELMO', kind: 'Card purchase', amount: -19 },
  { description: 'FNAC CALLAO', kind: 'Card purchase', amount: -34.9 },
  { description: 'TO LAURA GOMEZ - CONCERT', kind: 'Transfer out', amount: -60 },
  { description: 'MERCADONA C/ ALCALA', kind: 'Card purchase', amount: -71.64 },
];

const money = (value: number) =>
  `${value < 0 ? '-' : '+'}${Math.abs(value).toLocaleString('en-GB', { minimumFractionDigits: 2 })}`;
const cents = (values: number[]) => values.reduce((sum, value) => sum + Math.round(value * 100), 0);

const numbers = (text: string) =>
  [...text.matchAll(/(\d+(?:[,.  ]\d{3})*)(?:[.,](\d{1,2})(?!\d))?/g)].map((match) =>
    Number(match[1].replace(/\D/g, '') + (match[2] ? `.${match[2]}` : '')),
  );

function statement(now: number, timeZone: string) {
  const part = (type: string) =>
    Number(
      new Intl.DateTimeFormat('en-GB', { timeZone, [type]: 'numeric' })
        .formatToParts(now)
        .find((item) => item.type === type)!.value,
    );
  const [year, month, today] = [part('year'), part('month'), part('day')];
  const date = (day: number) =>
    `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  const opening = 2140.55;
  const closing = opening + cents(movements.map((item) => item.amount)) / 100;
  return {
    month: new Intl.DateTimeFormat('en-GB', { timeZone, month: 'long', year: 'numeric' }).format(
      now,
    ),
    bytes: pdf([
      'BANCO ATLANTICO - Current account statement',
      'Account holder: Alex Rivera    IBAN: ES91 0049 **** **** **** 4471',
      `Statement period: ${date(1)} - ${date(today)}    Card: Visa Debit ending 8823`,
      `Opening balance: EUR ${opening.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
      'Date          Description                        Type              Amount (EUR)',
      ...movements.map(
        (item, index) =>
          `${date(1 + Math.floor((index * (today - 1)) / (movements.length - 1)))}    ${item.description.padEnd(34)} ${item.kind.padEnd(17)} ${money(item.amount)}`,
      ),
      `Closing balance: EUR ${closing.toLocaleString('en-GB', { minimumFractionDigits: 2 })}`,
      'Questions? Call 900 100 200 or visit any branch.',
    ]),
  };
}

export default scenario({
  id: 'pdf-statement-card-total',
  title: "How much did I spend by card this month? Don't count transfers, and subtract refunds",
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached PDF is your Banco Atlantico current account statement for this month so far. You want one net figure for card spending in chat.',
  },
  world(clock) {
    const purchases = movements.filter((item) => item.kind === 'Card purchase');
    const refunds = movements.filter((item) => item.kind === 'Card refund');
    const debits = movements.filter((item) => item.kind === 'Direct debit');
    const gross = -cents(purchases.map((item) => item.amount)) / 100;
    const refunded = cents(refunds.map((item) => item.amount)) / 100;
    return {
      apps: createApps(owner, {}),
      statement: statement(clock.now(), 'Europe/Madrid'),
      gross,
      refunded,
      net: Math.round((gross - refunded) * 100) / 100,
      withDebits:
        Math.round((gross - refunded - cents(debits.map((item) => item.amount)) / 100) * 100) / 100,
    };
  },
  async play(session, world) {
    const id = await session.upload(
      `statement-${world.statement.month.toLowerCase().replace(' ', '-')}.pdf`,
      world.statement.bytes,
      'application/pdf',
    );
    await session.say(
      "Here's my bank statement. How much did I spend by card this month? Don't count transfers, and subtract refunds.",
      { attach: [id] },
    );
  },
  evidence(_run, world) {
    return `The statement covers ${world.statement.month} so far. Card purchases: ${movements
      .filter((item) => item.kind === 'Card purchase')
      .map((item) => `${item.description} €${(-item.amount).toFixed(2)}`)
      .join(
        ', ',
      )}; together €${world.gross.toFixed(2)}. One card refund: Decathlon €${world.refunded.toFixed(2)}. Net card spending: €${world.net.toFixed(2)}. Transfers in and out and the two direct debits (Iberluz electricity €86.40, Movistar €45.00) are not card spending; including the direct debits would give €${world.withDebits.toFixed(2)}.`;
  },
  expect(world) {
    return [
      check(
        'states-the-net-card-spending',
        (run) => ({
          pass: numbers(run.said).some((value) => Math.abs(value - world.net) < 0.005),
          evidence: `expected €${world.net.toFixed(2)}`,
        }),
        { failure: 'reasoning' },
      ),
    ];
  },
});
