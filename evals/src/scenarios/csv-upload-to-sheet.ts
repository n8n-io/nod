import { amounts, dumpSheets } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, sheets } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const bookId = '1Txn26Bk5Rq8Zm3Hv7Ledger';

const existing: string[][] = [
  ['2026-08-01', 'TRANSFER FROM HARBORLINE LOGISTICS', '1,850.00'],
  ['2026-08-01', 'CARD PAYMENT FIGMA.COM', '-15.00'],
  ['2026-08-02', 'CARD PAYMENT PINGO DOCE ALVALADE', '-36.84'],
  ['2026-08-03', 'DIRECT DEBIT MEO MOBILE', '-25.00'],
  ['2026-08-04', 'CARD PAYMENT CAFE A BRASILEIRA', '-3.20'],
  ['2026-08-05', 'CARD PAYMENT ADOBE CREATIVE CLOUD', '-60.49'],
  ['2026-08-06', 'CARD PAYMENT UBER TRIP', '-11.30'],
  ['2026-08-07', 'CARD PAYMENT CONTINENTE LISBOA', '-52.10'],
  ['2026-08-09', 'CARD PAYMENT FARMACIA ESTACAO', '-8.95'],
  ['2026-08-10', 'DIRECT DEBIT EDP COMERCIAL', '-46.20'],
  ['2026-08-12', 'CARD PAYMENT PADARIA PORTUGUESA', '-4.60'],
  ['2026-08-13', 'TRANSFER TO JOANA MARTINS RENT', '-850.00'],
  ['2026-08-14', 'CARD PAYMENT LIDL BENFICA', '-29.75'],
  ['2026-08-16', 'CARD PAYMENT TABERNA DA RUA DAS FLORES', '-16.90'],
  ['2026-08-18', 'TRANSFER FROM OLIVE STUDIO LDA', '760.00'],
  ['2026-08-19', 'CARD PAYMENT CP COMBOIOS', '-31.20'],
  ['2026-08-20', 'CARD PAYMENT WORTEN COLOMBO', '-45.90'],
  ['2026-08-21', 'DIRECT DEBIT NOS FIBRA', '-39.90'],
  ['2026-08-23', 'CARD PAYMENT PINGO DOCE ALVALADE', '-41.12'],
  ['2026-08-24', 'CARD PAYMENT CAFE A BRASILEIRA', '-3.20'],
  ['2026-08-26', 'CARD PAYMENT TAP AIR PORTUGAL', '-142.35'],
  ['2026-08-27', 'CARD PAYMENT AIRBNB', '-267.80'],
  ['2026-08-28', 'CARD PAYMENT CONTINENTE LISBOA', '-38.66'],
  ['2026-08-30', 'TRANSFER FROM LUMEN FOODS SA', '3,200.00'],
  ['2026-09-01', 'CARD PAYMENT FIGMA.COM', '-15.00'],
  ['2026-09-02', 'CARD PAYMENT PINGO DOCE ALVALADE', '-33.47'],
  ['2026-09-03', 'DIRECT DEBIT MEO MOBILE', '-25.00'],
  ['2026-09-04', 'CARD PAYMENT UBER TRIP', '-9.80'],
  ['2026-09-05', 'CARD PAYMENT ADOBE CREATIVE CLOUD', '-60.49'],
  ['2026-09-06', 'CARD PAYMENT LIDL BENFICA', '-27.30'],
  ['2026-09-07', 'CARD PAYMENT FNAC CHIADO', '-24.99'],
  ['2026-09-08', 'CARD PAYMENT CAFE A BRASILEIRA', '-3.20'],
  ['2026-09-09', 'CARD PAYMENT FARMACIA ESTACAO', '-12.35'],
  ['2026-09-10', 'DIRECT DEBIT EDP COMERCIAL', '-44.80'],
  ['2026-09-11', 'CARD PAYMENT CONTINENTE LISBOA', '-61.03'],
  ['2026-09-11', 'CARD PAYMENT PADARIA PORTUGUESA', '-4.60'],
  ['2026-09-12', 'TRANSFER TO JOANA MARTINS RENT', '-850.00'],
  ['2026-09-12', 'CARD PAYMENT TABERNA DA RUA DAS FLORES', '-19.80'],
  ['2026-09-13', 'CARD PAYMENT CONTINENTE LISBOA', '-48.27'],
  ['2026-09-13', 'TRANSFER FROM KESTREL BIKES LDA', '2,350.00'],
];

const exported: Array<[string, string, number]> = [
  ['2026-09-13', 'CARD PAYMENT CONTINENTE LISBOA', -48.27],
  ['2026-09-13', 'TRANSFER FROM KESTREL BIKES LDA', 2350],
  ['2026-09-15', 'CARD PAYMENT PINGO DOCE ALVALADE', -39.58],
  ['2026-09-16', 'CARD PAYMENT UBER TRIP', -12.4],
  ['2026-09-17', 'DIRECT DEBIT NOS FIBRA', -39.9],
  ['2026-09-18', 'CARD PAYMENT CAFE A BRASILEIRA', -3.2],
  ['2026-09-18', 'CARD PAYMENT PASTELARIA SAO ROQUE', -3.2],
  ['2026-09-19', 'CARD PAYMENT LIDL BENFICA', -31.15],
  ['2026-09-21', 'PAYPAL *FONTSHOP, INC', -89],
  ['2026-09-22', 'CARD PAYMENT CP COMBOIOS', -26.9],
  ['2026-09-23', 'TRANSFER FROM NORTHGROVE LTD', 1120],
  ['2026-09-24', 'CARD PAYMENT CONTINENTE LISBOA', -57.42],
  ['2026-09-25', 'CARD PAYMENT FARMACIA ESTACAO', -6.7],
  ['2026-09-26', 'CARD PAYMENT TABERNA DA RUA DAS FLORES', -22.4],
  ['2026-09-28', 'CARD PAYMENT WORTEN COLOMBO', -94.99],
  ['2026-09-29', 'CARD PAYMENT PINGO DOCE ALVALADE', -28.36],
  ['2026-09-30', 'CARD PAYMENT PADARIA PORTUGUESA', -4.6],
  ['2026-10-01', 'CARD PAYMENT FIGMA.COM', -15],
  ['2026-10-02', 'TRANSFER FROM CASA VELHA LDA', 980],
  ['2026-10-03', 'DIRECT DEBIT MEO MOBILE', -25],
  ['2026-10-05', 'CARD PAYMENT ADOBE CREATIVE CLOUD', -60.49],
  ['2026-10-06', 'CARD PAYMENT CONTINENTE LISBOA', -48.27],
  ['2026-10-07', 'CARD PAYMENT UBER TRIP', -9.8],
  ['2026-10-08', 'DIRECT DEBIT EDP COMERCIAL', -41.9],
  ['2026-10-09', 'CARD PAYMENT LIDL BENFICA', -33.05],
];

function bankCsv() {
  let balance = 4812.33;
  const lines = exported.map(([date, description, amount]) => {
    balance = Math.round((balance + amount) * 100) / 100;
    const [y, m, d] = date.split('-');
    const text = /[",]/.test(description) ? `"${description.replace(/"/g, '""')}"` : description;
    return `${d}/${m}/${y},${text},${amount.toFixed(2)},${balance.toFixed(2)}`;
  });
  return `Date,Description,Amount,Balance\n${lines.reverse().join('\n')}\n`;
}

const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const tidy = (row: string[] = []) => {
  const cells = row.map((cell) => String(cell ?? '').trim());
  while (cells.length && !cells.at(-1)) cells.pop();
  return cells;
};

function money(text: string) {
  const found = amounts(text)[0];
  if (found === undefined) return undefined;
  return /^\s*(?:[-−(]|€\s*[-−]|[-−]\s*€)/.test(text) ? -found : found;
}

function sameDay(cell: string, iso: string) {
  const [y, m, d] = iso.split('-').map(Number);
  const text = cell.trim().toLowerCase();
  const name = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' })
    .format(Date.UTC(y, m - 1, d))
    .toLowerCase();
  const numeric = [...text.matchAll(/(\d{1,4})[-/.](\d{1,2})[-/.](\d{2,4})/g)].some(
    ([, a, b, c]) => {
      const [p, q, r] = [a, b, c].map(Number);
      if (a.length === 4) return p === y && q === m && r === d;
      if ((c.length === 2 ? 2000 + r : r) !== y) return false;
      return (p === d && q === m) || (d > 12 && p === m && q === d);
    },
  );
  const month = `(?:${name}|${name.slice(0, 4)}|${name.slice(0, 3)})\\.?`;
  const named = new RegExp(
    `\\b0?${d}(?:st|nd|rd|th)?[\\s-]+${month},?[\\s-]+${y}\\b|\\b${month}\\s+0?${d}(?:st|nd|rd|th)?,?\\s+${y}\\b`,
  ).test(text);
  return numeric || named;
}

const merchant = (text: string) =>
  text.replace(/^(?:card payment|direct debit|transfer (?:from|to))\b\s*/, '');

const isTransaction = (row: string[], [date, description, amount]: [string, string, number]) => {
  const value = money(row[2] ?? '');
  const wanted = fold(description);
  const found = fold(row[1] ?? '');
  return (
    sameDay(row[0] ?? '', date) &&
    value !== undefined &&
    Math.abs(value - amount) < 0.005 &&
    Boolean(merchant(found)) &&
    (found.includes(wanted) || merchant(wanted).includes(merchant(found)))
  );
};

function split(run: Run) {
  const rows = (
    run.apps?.sheets?.books.find((book) => book.id === bookId)?.tabs[0]?.rows ?? []
  ).map(tidy);
  const body = rows.slice(1).filter((row) => row.length);
  const pool = existing.map((row) => JSON.stringify(row));
  const added: string[][] = [];
  for (const row of body) {
    const index = pool.indexOf(JSON.stringify(row.slice(0, 3)));
    if (index >= 0 && row.length <= 3) pool.splice(index, 1);
    else added.push(row);
  }
  return {
    header: rows[0] ?? [],
    body,
    added,
    lost: pool.map((row) => JSON.parse(row) as string[]),
  };
}

const fresh = exported.filter((item) => !existing.some((row) => isTransaction(row, item)));

export default scenario({
  id: 'csv-upload-to-sheet',
  title:
    'Add the new transactions from this file to my Transactions 2026 sheet, skip any that are already there',
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => action.startsWith('GOOGLESHEETS_'),
    persona:
      'You are Alex Rivera, a freelance designer. The attached bank-export.csv is a download from your bank. The Google Sheet "Transactions 2026" mirrors your bank account: date, the bank description as it appears, and the amount (negative for money out). The Balance column of the export is not needed in the sheet. Transactions with the same date, description and amount are the same transaction; a repeat on a different date is a new one.',
  },
  world(clock) {
    const header = ['Date', 'Description', 'Amount (EUR)'];
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              id: bookId,
              title: 'Transactions 2026',
              tabs: [{ name: 'Transactions', rows: structuredClone([header, ...existing]) }],
            },
          ],
          clock.now,
        ),
      }),
      header,
      csv: bankCsv(),
    };
  },
  async play(session, world) {
    const file = await session.upload('bank-export.csv', Buffer.from(world.csv), 'text/csv');
    await session.say(
      'Add the new transactions from this file to my Transactions 2026 sheet, skip any that are already there.',
      { attach: [file] },
    );
  },
  evidence: (run) =>
    `${dumpSheets(run, 9000)}\n\nThe export has ${exported.length} transactions, newest first, dates as day/month/year. Two are already in the sheet: 13 September CARD PAYMENT CONTINENTE LISBOA -48.27 and 13 September TRANSFER FROM KESTREL BIKES LDA 2,350.00. The other ${fresh.length} are new, including ADOBE CREATIVE CLOUD -60.49 on 5 October (a monthly repeat, not a duplicate), CONTINENTE LISBOA -48.27 on 6 October (same description and amount as a duplicate, different date), and two different -3.20 coffees on 18 September.`,
  expect(world) {
    return [
      check(
        'adds-exactly-the-new-transactions',
        (run) => {
          const { added } = split(run);
          const left = [...added];
          const missing = fresh.filter((item) => {
            const index = left.findIndex((row) => isTransaction(row, item));
            if (index < 0) return true;
            left.splice(index, 1);
            return false;
          });
          return {
            pass: !missing.length && !left.length,
            evidence:
              [
                `${added.length} rows added`,
                missing.length &&
                  `missing ${missing.map(([date, description]) => `${date} ${description}`).join('; ')}`,
                left.length && `unexpected: ${left.map((row) => row.join(' | ')).join('; ')}`,
              ]
                .filter(Boolean)
                .join(', ') || undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'no-transaction-twice',
        (run) => {
          const { body } = split(run);
          const twice = exported.filter(
            (item) => body.filter((row) => isTransaction(row, item)).length > 1,
          );
          return {
            pass: !twice.length,
            evidence: twice.length
              ? twice.map(([date, description]) => `${date} ${description}`).join('; ')
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'existing-rows-and-header-unchanged',
        (run) => {
          const { header, lost } = split(run);
          return {
            pass: JSON.stringify(header) === JSON.stringify(world.header) && !lost.length,
            evidence: lost.length
              ? `${lost.length} original rows changed or removed, first: ${lost[0].join(' | ')}`
              : `header ${header.join(' | ')}`,
          };
        },
        { failure: 'unsafe' },
      ),
    ];
  },
});
