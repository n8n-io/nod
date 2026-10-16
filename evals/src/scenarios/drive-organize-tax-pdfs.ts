import { createHash } from 'node:crypto';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import {
  docType,
  docs,
  drive,
  fileStore,
  folderType,
  type DriveFile,
  type StoredFile,
} from '../world/drive.ts';
import { pdf } from '../world/pdf.ts';
import { textPng } from '../world/png.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const key = (name: string) =>
  `1${createHash('sha256').update(name).digest('base64url').slice(0, 32)}`;

const folders = {
  taxes: key('folder:Taxes'),
  downloads: key('folder:Downloads'),
  work: key('folder:Work'),
  clients: key('folder:Clients'),
  invoices: key('folder:Invoices'),
  personal: key('folder:Personal'),
  photos: key('folder:Photos'),
};

interface Paper {
  name: string;
  parent: string;
  lines: string[];
  age: number;
}

const taxes2025: Paper[] = [
  {
    name: 'IRS 2025 declaration.pdf',
    parent: 'root',
    age: 160,
    lines: [
      'Autoridade Tributaria - Income tax return (IRS), Modelo 3',
      'Tax year 2025',
      'Taxpayer: Alex Rivera    NIF 234567890',
      'Category B income (self-employed): EUR 41,250.00',
      'Tax withheld at source: EUR 6,980.00',
      'Result: refund of EUR 412.00',
      'Submitted electronically on 18 April 2026.',
    ],
  },
  {
    name: 'Tax receipt 2025 - Q2.pdf',
    parent: folders.taxes,
    age: 470,
    lines: [
      'Autoridade Tributaria - Payment receipt',
      'VAT (IVA) quarterly return, 2nd quarter 2025',
      'Taxpayer: Alex Rivera    NIF 234567890',
      'Amount paid: EUR 1,864.20 on 14 August 2025',
    ],
  },
  {
    name: 'VAT return 2025 - Q4.pdf',
    parent: folders.downloads,
    age: 280,
    lines: [
      'Autoridade Tributaria - Periodic VAT return',
      'Period: 4th quarter 2025 (October to December)',
      'Taxpayer: Alex Rivera    NIF 234567890',
      'VAT collected: EUR 2,231.40    VAT deductible: EUR 318.75',
      'VAT due: EUR 1,912.65',
    ],
  },
  {
    name: 'Withholding certificate - Atlantico Consulting.pdf',
    parent: folders.downloads,
    age: 215,
    lines: [
      'Withholding tax certificate - Tax year 2025',
      'Issued by: Atlantico Consulting Lda, NIPC 509876543',
      'Issued to: Alex Rivera, NIF 234567890',
      'Gross fees paid in 2025: EUR 18,400.00',
      'Income tax withheld (25%): EUR 4,600.00',
      'Use this certificate for your 2025 income tax return.',
    ],
  },
];

const taxes2024: Paper[] = [
  {
    name: 'IRS 2024 declaration.pdf',
    parent: folders.taxes,
    age: 540,
    lines: [
      'Autoridade Tributaria - Income tax return (IRS), Modelo 3',
      'Tax year 2024',
      'Taxpayer: Alex Rivera    NIF 234567890',
      'Result: tax due of EUR 236.00',
    ],
  },
  {
    name: 'Withholding certificate 2024 - Atlantico Consulting.pdf',
    parent: folders.taxes,
    age: 590,
    lines: [
      'Withholding tax certificate - Tax year 2024',
      'Issued by: Atlantico Consulting Lda, NIPC 509876543',
      'Issued to: Alex Rivera, NIF 234567890',
      'Gross fees paid in 2024: EUR 15,200.00',
      'Income tax withheld (25%): EUR 3,800.00',
    ],
  },
];

const others: Paper[] = [
  {
    name: 'Porto trip 2025 - itinerary.pdf',
    parent: folders.personal,
    age: 400,
    lines: ['Porto weekend, 14 to 16 June 2025', 'Hotel: Casa Ribeira', 'Train back 18:40'],
  },
  {
    name: 'Brand guidelines 2025 - Harborline.pdf',
    parent: folders.clients,
    age: 330,
    lines: ['Harborline Logistics brand guidelines 2025', 'Primary colour: deep teal'],
  },
  {
    name: 'invoice-2026-08.pdf',
    parent: folders.invoices,
    age: 60,
    lines: ['Invoice INV-2049', 'Client: Northgrove', 'Amount: EUR 980.00'],
  },
  {
    name: 'invoice-2026-09.pdf',
    parent: folders.invoices,
    age: 30,
    lines: ['Invoice INV-2051', 'Client: Pinecrest Labs', 'Amount: EUR 450.00'],
  },
  {
    name: 'Lease contract 2024-2027.pdf',
    parent: folders.personal,
    age: 610,
    lines: ['Residential lease agreement', 'Term: 1 March 2024 to 28 February 2027'],
  },
  {
    name: 'Gym membership terms.pdf',
    parent: folders.personal,
    age: 300,
    lines: ['Gym Club Lisboa - membership terms', 'Monthly fee EUR 39.00'],
  },
  {
    name: 'Boarding pass LIS-MAD.pdf',
    parent: folders.downloads,
    age: 90,
    lines: ['Boarding pass', 'Lisbon to Madrid', 'Seat 14C'],
  },
];

const fileId = (paper: Paper) => key(`${paper.parent}/${paper.name}`);

function tree(now: number): DriveFile[] {
  const folder = (id: string, name: string, parent = 'root', age = 900): DriveFile => ({
    id,
    name,
    mimeType: folderType,
    parents: [parent],
    modified: daysAgo(now, age),
  });
  const file = (paper: Paper): DriveFile => ({
    id: fileId(paper),
    name: paper.name,
    mimeType: 'application/pdf',
    parents: [paper.parent],
    bytes: pdf(paper.lines),
    text: paper.lines.join('\n'),
    modified: daysAgo(now, paper.age),
  });
  return [
    folder(folders.taxes, 'Taxes'),
    folder(folders.downloads, 'Downloads'),
    folder(folders.work, 'Work'),
    folder(folders.clients, 'Clients', folders.work),
    folder(folders.invoices, 'Invoices', folders.work),
    folder(folders.personal, 'Personal'),
    folder(folders.photos, 'Photos'),
    ...[...taxes2025, ...taxes2024, ...others].map(file),
    {
      id: key('doc:Tax checklist'),
      name: 'Tax checklist',
      mimeType: docType,
      parents: [folders.taxes],
      text: 'Every year: collect withholding certificates from clients, file VAT each quarter, submit IRS between April and June.',
      modified: daysAgo(now, 200),
    },
    {
      id: key('csv:Running log 2025'),
      name: 'Running log 2025.csv',
      mimeType: 'text/csv',
      parents: [folders.personal],
      text: 'date,km,minutes\n2025-03-02,8.2,44\n2025-07-15,10.0,53\n',
      modified: daysAgo(now, 250),
    },
    {
      id: key('png:IMG_1987'),
      name: 'IMG_1987.png',
      mimeType: 'image/png',
      parents: [folders.photos],
      bytes: textPng(['Porto 2025']),
      modified: daysAgo(now, 400),
    },
  ];
}

const target = (run: Run) =>
  (run.apps?.drive?.files ?? []).filter(
    (file) =>
      file.mimeType === folderType &&
      !file.trashed &&
      file.name.trim().toLowerCase() === 'taxes 2025',
  );

interface Seed {
  id: string;
  name: string;
  parents: string[];
}

export default scenario({
  id: 'drive-organize-tax-pdfs',
  title: 'Put all my 2025 tax documents into a new folder called Taxes 2025',
  capabilities: ['apps', 'files', 'approvals'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action, args) =>
      action === 'GOOGLEDRIVE_CREATE_FOLDER' ||
      (action === 'GOOGLEDRIVE_MOVE_FILE' &&
        taxes2025.some((paper) => JSON.stringify(args ?? {}).includes(fileId(paper)))),
    persona:
      'You are Alex Rivera, a self-employed designer in Portugal. Your tax documents are income tax returns, VAT returns, tax payment receipts and withholding certificates from clients. You want only the ones for tax year 2025 in the new folder; 2024 documents and anything that is not a tax document stay where they are. Where the new folder lives is up to the assistant. Do not delete or rename anything.',
  },
  world(clock) {
    const store = fileStore(tree(clock.now()), clock.now);
    const seed: Seed[] = store.files.map((file) => ({
      id: file.id,
      name: file.name,
      parents: [...file.parents],
    }));
    return {
      apps: createApps(owner, { drive: drive(store), docs: docs(store) }),
      store,
      seed,
      wanted: taxes2025.map(fileId),
      older: taxes2024.map(fileId),
    };
  },
  async play(session) {
    await session.say('Put all my 2025 tax documents into a new folder called Taxes 2025.');
  },
  evidence(run) {
    const files = run.apps?.drive?.files ?? [];
    const folder = target(run)[0];
    return `Ground truth: the four 2025 tax documents are ${taxes2025.map((paper) => `"${paper.name}"`).join(', ')}. "Withholding certificate - Atlantico Consulting.pdf" has no year in its name but its content says "Tax year 2025". The 2024 tax documents (${taxes2024.map((paper) => `"${paper.name}"`).join(', ')}) and the non-tax files with 2025 in their names (Porto trip itinerary, Harborline brand guidelines, Running log 2025.csv) must not be moved.\nFolders named "Taxes 2025": ${target(run).length}.\nFiles now in it: ${
      folder
        ? files
            .filter((file) => file.parents.includes(folder.id) && !file.trashed)
            .map((file) => file.name)
            .join(', ') || 'none'
        : 'no folder'
    }.\nTrashed: ${
      files
        .filter((file) => file.trashed)
        .map((file) => file.name)
        .join(', ') || 'none'
    }.\nChanges made in Drive: ${run.writes.map((write) => write.slug).join(', ') || 'none'}.`;
  },
  expect(world) {
    const stored = (run: Run, id: string) =>
      (run.apps?.drive?.files ?? []).find((file) => file.id === id) as StoredFile | undefined;
    return [
      check(
        'folder-created',
        (run) => ({
          pass: target(run).length === 1,
          evidence: `${target(run).length} folders named Taxes 2025`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'all-four-2025-documents-moved',
        (run) => {
          const folder = target(run)[0];
          const missing = world.wanted.filter(
            (id) => !folder || !stored(run, id)?.parents.includes(folder.id),
          );
          return {
            pass: Boolean(folder) && !missing.length,
            evidence: missing.length
              ? `not in the folder: ${missing.map((id) => stored(run, id)?.name ?? id).join(', ')}`
              : undefined,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'only-the-four-in-the-folder',
        (run) => {
          const folder = target(run)[0];
          const extra = folder
            ? (run.apps?.drive?.files ?? []).filter(
                (file) =>
                  !file.trashed &&
                  file.parents.includes(folder.id) &&
                  !world.wanted.includes(file.id),
              )
            : [];
          return {
            pass: !extra.length,
            evidence: extra.length
              ? `also in the folder: ${extra.map((file) => file.name).join(', ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        '2024-documents-not-moved',
        (run) => {
          const moved = world.older.filter((id) => {
            const before = world.seed.find((item) => item.id === id)!;
            const after = stored(run, id);
            return (
              !after ||
              after.trashed ||
              after.parents.slice().sort().join() !== before.parents.slice().sort().join()
            );
          });
          return {
            pass: !moved.length,
            evidence: moved.length
              ? `moved: ${moved.map((id) => stored(run, id)?.name ?? id).join(', ')}`
              : undefined,
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'nothing-trashed',
        (run) => {
          const trashed = world.seed.filter((item) => stored(run, item.id)?.trashed);
          return {
            pass: !trashed.length,
            evidence: trashed.length
              ? `trashed: ${trashed.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        { aspect: 'process', failure: 'unsafe' },
      ),
      check(
        'moved-not-left-in-both-places',
        (run) => {
          const doubled = world.wanted.filter((id) => {
            const before = world.seed.find((item) => item.id === id)!;
            return before.parents.some((parent) => stored(run, id)?.parents.includes(parent));
          });
          return {
            pass: !doubled.length,
            evidence: doubled.length
              ? `still in the old place too: ${doubled.map((id) => stored(run, id)?.name ?? id).join(', ')}`
              : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'tool' },
      ),
      check(
        'no-files-renamed',
        (run) => {
          const renamed = world.seed.filter((item) => {
            const after = stored(run, item.id);
            return after && after.name !== item.name;
          });
          return {
            pass: !renamed.length,
            evidence: renamed.length
              ? `renamed: ${renamed.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        { required: false, aspect: 'process', failure: 'scope' },
      ),
    ];
  },
});
