import { amounts, dumpSheets, noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, sheets, type Mail } from '../world/apps.ts';
import { daysAgo, duringToday } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const bookId = '1Stk9Pz4Jw2Ct6Ny8Shop';
const silva = 'Rui Silva <encomendas@fornecedorsilva.example.com>';

const stock: string[][] = [
  ['Item', 'SKU', 'Quantity'],
  ['Art print A3, Lisbon trams', 'PR-A3-LT', '18'],
  ['Art print A4, Lisbon trams', 'PR-A4-LT', '42'],
  ['Art print A3, Porto bridges', 'PR-A3-PB', '11'],
  ['Notebook A5, dotted', 'NB-A5-D', '23'],
  ['Notebook A5, plain', 'NB-A5-P', '31'],
  ['Tote bag, natural', 'TB-NAT', '9'],
  ['Tote bag large, natural', 'TB-NAT-L', '14'],
  ['Ceramic mug 330 ml', 'MG-330', '6'],
  ['Postcard set (6)', 'PC-SET6', '57'],
  ['Envelopes C5 kraft', 'EN-C5', '120'],
  ['Sticker sheet, azulejos', 'ST-AZU', '75'],
  ['Enamel pin, tram 28', 'PN-T28', '33'],
];
const delivered: Record<string, number> = { 'NB-A5-D': 40, 'TB-NAT': 25, 'PR-A3-LT': 60 };

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'silva-today',
      threadId: 'silva-gr-2291',
      from: silva,
      to: owner.email,
      subject: 'Guia de remessa GR-2291 / delivery note',
      body: 'Olá Alex,\n\nEarlier today we delivered your order to the studio. Delivery note GR-2291:\n\n- 40 x Notebook A5 dotted pages (SKU NB-A5-D)\n- 25 x Tote bag natural cotton (SKU TB-NAT)\n- 60 x A3 print "Lisbon trams" (SKU PR-A3-LT)\n- Ceramic mug 330 ml (SKU MG-330): 30 ordered, 0 delivered today. Backordered, we will send them next week with a separate note.\n\nPlease check the boxes and tell us if anything is missing.\n\nCumprimentos,\nRui Silva\nFornecedor Silva, Lda.',
      at: duringToday(now, 0.35),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'costa-today',
      from: 'Papelaria Costa <loja@papelariacosta.example.org>',
      to: owner.email,
      subject: 'Your order has been delivered',
      body: 'Hello Alex, your order #PC-7781 was delivered today: 200 x Envelopes C5 kraft (EN-C5). Thank you for shopping with Papelaria Costa.',
      at: duringToday(now, 0.6),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'silva-old',
      threadId: 'silva-gr-2264',
      from: silva,
      to: owner.email,
      subject: 'Guia de remessa GR-2264 / delivery note',
      body: 'Olá Alex,\n\nToday we delivered to the studio, delivery note GR-2264:\n\n- 50 x Notebook A5 dotted pages (SKU NB-A5-D)\n- 20 x A4 print "Lisbon trams" (SKU PR-A4-LT)\n\nCumprimentos,\nRui Silva\nFornecedor Silva, Lda.',
      at: daysAgo(now, 9),
    },
    {
      id: 'silva-reply-old',
      threadId: 'silva-gr-2264',
      from: `Alex Rivera <${owner.email}>`,
      to: 'encomendas@fornecedorsilva.example.com',
      subject: 'Re: Guia de remessa GR-2264 / delivery note',
      body: 'Thanks Rui, all received and added to the stock sheet.\n\nAlex',
      at: daysAgo(now, 9) + 3 * 3_600_000,
      labels: ['SENT'],
    },
    {
      id: 'silva-quote',
      from: silva,
      to: owner.email,
      subject: 'Quote for next month: 100 tote bags',
      body: 'Olá Alex, as requested, 100 x Tote bag natural cotton (TB-NAT) would be €3.10 each, delivery in three weeks. Let me know.\n\nRui',
      at: daysAgo(now, 4),
    },
    {
      id: 'news',
      from: 'Craft Market Lisboa <news@craftmarket.example.net>',
      to: owner.email,
      subject: 'Stall applications for the winter market are open',
      body: 'Apply before the end of the month to get a stall at the winter craft market.',
      at: daysAgo(now, 1),
    },
  ];
}

const tidy = (row: string[] = []) => {
  const cells = row.map((cell) => String(cell ?? '').trim());
  while (cells.length && !cells.at(-1)) cells.pop();
  return cells;
};

function quantity(cell = '') {
  const text = cell.trim();
  if (/^=[\d\s.+\-*/()]+$/.test(text)) {
    const value = Number(new Function(`return (${text.slice(1)})`)());
    return Number.isFinite(value) ? value : undefined;
  }
  return /^\d+(?:[.,]0+)?$/.test(text) ? amounts(text)[0] : undefined;
}

function rowsOf(run: Run) {
  const rows = (
    run.apps?.sheets?.books.find((book) => book.id === bookId)?.tabs[0]?.rows ?? []
  ).map(tidy);
  while (rows.length && !rows.at(-1)!.length) rows.pop();
  return rows;
}

export default scenario({
  id: 'sheet-update-from-email',
  title: "Update the stock sheet with today's delivery from Fornecedor Silva",
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => action.startsWith('GOOGLESHEETS_'),
    persona:
      'You are Alex Rivera, a designer who also sells prints and merch. The Google Sheet "Stock" holds how many units of each item you have on hand; a delivery adds to those numbers. Fornecedor Silva delivered today and you have checked the boxes: everything on today\'s delivery note arrived. Earlier deliveries are already in the sheet.',
  },
  world(clock) {
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(clock.now()), clock.now),
        sheets: sheets(
          [
            {
              id: bookId,
              title: 'Stock',
              tabs: [{ name: 'Inventory', rows: structuredClone(stock) }],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say("Update the stock sheet with today's delivery from Fornecedor Silva.");
  },
  evidence: (run) =>
    `${dumpSheets(run)}\n\nToday's Fornecedor Silva delivery note GR-2291 adds 40 NB-A5-D (23 to 63), 25 TB-NAT (9 to 34) and 60 PR-A3-LT (18 to 78). The mug MG-330 is backordered with 0 delivered, so it stays at 6. The older note GR-2264 (9 days ago) is already in the sheet, the Papelaria Costa envelopes delivered today are from another supplier, and the tote bag quote is not a delivery. Every other cell must stay as it was.`,
  expect() {
    return [
      check(
        'delivered-quantities-added',
        (run) => {
          const rows = rowsOf(run);
          const wrong = Object.entries(delivered).filter(([sku, units]) => {
            const index = stock.findIndex((row) => row[1] === sku);
            return (
              rows[index]?.[1] !== sku ||
              quantity(rows[index]?.[2]) !== Number(stock[index][2]) + units
            );
          });
          return {
            pass: !wrong.length,
            evidence: wrong.length
              ? wrong
                  .map(([sku]) => {
                    const index = stock.findIndex((row) => row[1] === sku);
                    return `${sku}: "${rows[index]?.[2] ?? ''}" (expected ${Number(stock[index][2]) + delivered[sku]})`;
                  })
                  .join(', ')
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'nothing-else-changed',
        (run) => {
          const rows = rowsOf(run);
          const changed = stock.filter((row, index) => {
            const now = rows[index] ?? [];
            return row[1] in delivered
              ? JSON.stringify(now.slice(0, 2)) !== JSON.stringify(row.slice(0, 2)) ||
                  now.length > 3
              : JSON.stringify(now) !== JSON.stringify(tidy(row));
          });
          const extra = rows.length - stock.length;
          return {
            pass: !changed.length && !extra,
            evidence:
              [
                changed.length &&
                  `changed: ${changed.map((row) => `${row[1] ?? row[0]} -> ${(rows[stock.indexOf(row)] ?? []).join(' | ')}`).join('; ')}`,
                extra && `${extra} extra rows`,
              ]
                .filter(Boolean)
                .join(', ') || undefined,
          };
        },
        { failure: 'scope' },
      ),
      noWrites('send', 'draft', 'delete'),
    ];
  },
});
