import { check, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { textPng } from '../world/png.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const items: Array<[string, number]> = [
  ['2 CERVEZA', 4.8],
  ['1 PATATAS BRAVAS', 6.9],
  ['1 CROQUETAS JAMON', 8.5],
  ['1 PULPO A LA GALLEGA', 18.9],
  ['1 TARTA DE QUESO', 6.8],
  ['2 CAFE SOLO', 3.2],
];
const subtotal = items.reduce((sum, [, price]) => sum + Math.round(price * 100), 0) / 100;
const iva = Math.round((subtotal - subtotal / 1.1) * 100) / 100;
const tip = 5.9;
const total = Math.round((subtotal + tip) * 100) / 100;

const line = (label: string, value: number) => `${label.padEnd(24)}${value.toFixed(2).padStart(6)}`;
const rule = '-'.repeat(30);

const receipt = [
  'TABERNA LA ENCINA',
  'C. DEL PEZ 14 - MADRID',
  'MESA 6   CAMARERA: LUCIA',
  'FECHA 12-10-2026   21:47',
  rule,
  ...items.map(([label, price]) => line(label, price)),
  rule,
  line('SUBTOTAL', subtotal),
  line('IVA 10 INCLUIDO', iva),
  line('PROPINA', tip),
  line('TOTAL', total),
  rule,
  line('PAGADO CON TARJETA', total),
  'GRACIAS POR SU VISITA',
];

const numbers = (text: string) =>
  [...text.matchAll(/(\d+(?:[,.  ]\d{3})*)(?:[.,](\d{1,2})(?!\d))?/g)].map((match) =>
    Number(match[1].replace(/\D/g, '') + (match[2] ? `.${match[2]}` : '')),
  );

export default scenario({
  id: 'receipt-photo-tip',
  title: 'How much tip did I leave on this receipt?',
  capabilities: ['files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 300,
  user: {
    approve: true,
    persona:
      'You are Alex Rivera. The attached photo is the receipt from your dinner at Taberna La Encina in Madrid, paid by card. You just want the tip amount.',
  },
  world() {
    return { apps: createApps(owner, {}), image: textPng(receipt) };
  },
  async play(session, world) {
    const id = await session.upload('receipt.png', world.image, 'image/png');
    await session.say('How much tip did I leave on this receipt?', { attach: [id] });
  },
  evidence() {
    return `The receipt photo shows, line by line: ${receipt.filter((text) => text !== rule).join(' | ')}. "Propina" is Spanish for tip, so the tip was €${tip.toFixed(2)}. IVA (€${iva.toFixed(2)}) is the tax already included in the subtotal; the total of €${total.toFixed(2)} is the subtotal plus the tip.`;
  },
  expect() {
    return [
      check(
        'states-the-tip',
        (run) => ({
          pass: numbers(run.said).some((value) => Math.abs(value - tip) < 0.005),
          evidence: `expected €${tip.toFixed(2)}`,
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The assistant tells the user the tip on the Taberna La Encina receipt was €5.90, in any format.',
        },
      ),
    ];
  },
});
