import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, sheets } from '../world/apps.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

const clients: string[][] = [
  ['Client', 'Contact', 'Email', 'City', 'Client since', 'Notes'],
  [
    'Harborline Logistics',
    'Tom Becker',
    'tom.becker@harborline.example.com',
    'Hamburg',
    '2023-04-12',
    'Annual report every March',
  ],
  [
    'Kestrel Bikes',
    'Mateo García',
    'mateo.garcia@kestrelbikes.example.net',
    'Lisbon, PT',
    '2024-01-08',
    'Invoices go to finance, not to Mateo',
  ],
  [
    'Lumen Foods',
    'Marta Gonçalves',
    'marta.goncalves@lumenfoods.example.com',
    'Porto',
    '2022-09-30',
    'Packaging refresh in Q4',
  ],
  [
    'Brightwave',
    'Jonas Weber',
    'jonas.weber@brightwave.example.org',
    'Berlin',
    '2023-11-02',
    'Prefers "final_v2" file names',
  ],
  ['Olive Studio', 'Ana Silva', 'ana.silva@olivestudio.example.com', 'Lisbon', '2021-06-15'],
  [
    'Northgrove',
    'Sam Patel',
    'sam@northgrove.example.org',
    'London',
    '2024-05-21',
    'Retainer: 10 h/month',
  ],
  [
    'Casa Velha',
    'Inês Carvalho',
    'ines@casavelha.example.net',
    'Porto',
    '2022-03-03',
    'Menus twice a year',
  ],
  [
    'Pinecrest Labs',
    'Miguel Santos',
    'miguel.santos@pinecrestlabs.example.com',
    'Lisbon',
    '2025-02-17',
  ],
  [
    'Ferro Studio',
    'Daniel Ortega',
    'd.ortega@ferrostudio.example.com',
    'Madrid',
    '2024-10-09',
    "Co-branding with Daniela's team",
  ],
  [
    'Bodega Ruiz',
    'Carlos Ruiz',
    'carlos.ruiz@bodegaruiz.example.com',
    'Seville',
    '2023-07-27',
    'Wine labels; 3 products',
  ],
  ['Maison Clara', 'Clara Dubois', 'clara.dubois@maisonclara.example.net', 'Paris', '2025-05-06'],
  [
    'Nordform',
    'Emma Johansson',
    'emma.j@nordform.example.org',
    'Gothenburg',
    '2024-08-19',
    'Quotes in EUR',
  ],
  [
    'Pixel Pine',
    'Julia Nowak',
    'julia.nowak@pixelpine.example.com',
    'Kraków',
    '2025-09-01',
    'New logo, phase 1 of 2',
  ],
  ['Okafor & Co', 'Grace Okafor', 'grace@okaforandco.example.com', 'Dublin', '2023-02-14'],
  [
    'Schmidt Verlag',
    'Hannah Schmidt',
    'hannah@schmidtverlag.example.org',
    'Cologne',
    '2022-12-01',
    'Book covers for a series of 6',
  ],
];
const leads: string[][] = [
  ['Name', 'Email', 'Company', 'Stage'],
  ['Noor Haddad', 'noor@haddadtextiles.example.net', 'Haddad Textiles', 'Proposal sent'],
  ['Elif Yilmaz', 'elif@yilmazstudio.example.com', 'Yilmaz Studio', 'First call'],
  ['Liam Byrne', 'liam.byrne@byrnefoods.example.com', 'Byrne Foods', 'Proposal sent'],
  ['Amara Diallo', 'amara@diallodesign.example.org', 'Diallo Design', 'Cold'],
  ['Piotr Kowalski', 'piotr@kowalskiwood.example.net', 'Kowalski Wood', 'First call'],
  ['Yuki Tanaka', 'yuki.tanaka@kumoink.example.com', 'Kumo Ink', 'Cold'],
];

function parseCsv(input: string) {
  const text = input.replace(/^﻿/, '');
  const first = text.split(/\r?\n/)[0] ?? '';
  const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const normal = (rows: string[][]) =>
  JSON.stringify(
    rows
      .map((row) => {
        const cells = row.map((cell) => cell.replace(/\r\n/g, '\n').trim());
        while (cells.length && !cells.at(-1)) cells.pop();
        return cells;
      })
      .filter((row) => row.length),
  );

async function matching(run: Run, path: string) {
  const bytes = await run.read(path);
  return Boolean(bytes) && normal(parseCsv(bytes!.toString('utf8'))) === normal(clients);
}

export default scenario({
  id: 'sheet-to-csv-file',
  title: 'Export the Clients tab as a CSV I can download',
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. Your client list is in the Google Sheet "CRM", tab "Clients". You want that tab as a CSV file sent to you here, header row included, every row as it is in the sheet. The sheet should not change.',
  },
  world(clock) {
    return {
      apps: createApps(owner, {
        sheets: sheets(
          [
            {
              title: 'CRM',
              tabs: [
                { name: 'Leads', rows: structuredClone(leads) },
                { name: 'Clients', rows: structuredClone(clients) },
              ],
            },
          ],
          clock.now,
        ),
      }),
    };
  },
  async play(session) {
    await session.say('Export the Clients tab as a CSV I can download.');
  },
  evidence: (run) =>
    `The Clients tab has a header and ${clients.length - 1} clients; Kestrel Bikes' city is "Lisbon, PT" and two notes contain commas, one contains double quotes, and four clients have no note. The Leads tab (${leads.length - 1} leads, listed first in the spreadsheet) must not be in the file.\nFiles sent with share_file: ${
      run.tools
        .filter((item) => item.name === 'share_file')
        .map((item) => `${String(item.input?.path ?? '')}${item.isError ? ' (failed)' : ''}`)
        .join(', ') || 'none'
    }.\nWorkspace files: ${run.files.join(', ') || 'none'}.`,
  expect() {
    return [
      check(
        'csv-matches-the-clients-tab',
        async (run) => {
          const csvs = run.files.filter((path) => /\.csv$/i.test(path));
          for (const path of csvs)
            if (await matching(run, path)) return { pass: true, evidence: path };
          return {
            pass: false,
            evidence: csvs.length
              ? `no CSV equals the Clients tab (${csvs.join(', ')})`
              : 'no CSV in the workspace',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'shares-the-csv',
        async (run) => {
          const shares = run.tools.filter((item) => item.name === 'share_file' && !item.isError);
          for (const call of shares) {
            const path = String(call.input?.path ?? '');
            const relative = path.replace(/^\.?\/+/, '').replace(/^workspace\//, '');
            const file = run.files.find((item) => item === path || item.endsWith(`/${relative}`));
            if (/\.csv$/i.test(path) && (await matching(run, file ?? path)))
              return { pass: true, evidence: file ?? path };
          }
          return {
            pass: false,
            evidence: `${shares.length} files shared, none is the Clients CSV (${shares.map((item) => String(item.input?.path ?? '')).join(', ') || 'no paths'})`,
          };
        },
        { failure: 'incomplete' },
      ),
      noWrites('create', 'update', 'delete', 'draft', 'send', 'post'),
    ];
  },
});
