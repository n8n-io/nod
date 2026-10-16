import { createHash } from 'node:crypto';
import { noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { docType, docs, drive, fileStore, folderType, type DriveFile } from '../world/drive.ts';
import { pdf } from '../world/pdf.ts';
import { textPng } from '../world/png.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const key = (name: string) =>
  `1${createHash('sha256').update(name).digest('base64url').slice(0, 32)}`;

const folders = {
  home: key('folder:Home'),
  personal: key('folder:Personal'),
  work: key('folder:Work'),
  clients: key('folder:Clients'),
  invoices: key('folder:Invoices'),
  taxes: key('folder:Taxes'),
  photos: key('folder:Photos'),
};

const currentLease = [
  'RESIDENTIAL LEASE AGREEMENT',
  'Property: Rua das Flores 27, 3rd floor left, 1200-195 Lisbon',
  'Landlord: Helena Duarte    Tenant: Alex Rivera',
  'Term: 1 March 2024 to 28 February 2027',
  'Monthly rent: EUR 1,150.00, payable by the 8th of each month',
  'Deposit: EUR 2,300.00, returned after the final inspection',
  '',
  'Clause 4 - Use of the property',
  'The property is let as a private residence for the tenant only.',
  'Clause 5 - Repairs',
  'The landlord pays structural repairs; the tenant pays minor upkeep.',
  'Clause 6 - Utilities',
  'Electricity, water and internet are in the name of the tenant.',
  'Clause 7 - Pets',
  'One small pet is allowed with the written consent of the landlord.',
  'Clause 8 - Sublet',
  'The tenant may not sublet the property or any room in it.',
  'Clause 9 - Early termination by the tenant',
  'The tenant may end this lease at any time by giving the landlord at least',
  "60 days' written notice, by registered letter or by email to",
  'helena.duarte@example.net. Rent remains due until the notice period ends.',
  'Clause 10 - End of term',
  'This lease ends on 28 February 2027 unless both parties renew it in writing.',
  '',
  'Signed in Lisbon on 12 February 2024 by Helena Duarte and Alex Rivera.',
];

const oldLease = [
  'RESIDENTIAL LEASE AGREEMENT',
  'Property: Rua das Flores 27, 3rd floor left, 1200-195 Lisbon',
  'Landlord: Helena Duarte    Tenant: Alex Rivera',
  'Term: 1 March 2021 to 29 February 2024',
  'Monthly rent: EUR 980.00, payable by the 8th of each month',
  "Deposit: one month's rent (EUR 980.00)",
  '',
  'Clause 4 - Use of the property',
  'The property is let as a private residence for the tenant only.',
  'Clause 5 - Repairs',
  'The landlord pays structural repairs; the tenant pays minor upkeep.',
  'Clause 8 - Termination by the tenant',
  "The tenant may end this lease by giving the landlord 30 days' written notice.",
  'Clause 9 - End of term',
  'This lease ends on 29 February 2024.',
  '',
  'Signed in Lisbon on 20 February 2021 by Helena Duarte and Alex Rivera.',
];

function tree(now: number): DriveFile[] {
  const folder = (id: string, name: string, parent = 'root', age = 900): DriveFile => ({
    id,
    name,
    mimeType: folderType,
    parents: [parent],
    modified: daysAgo(now, age),
  });
  const file = (name: string, parent: string, lines: string[], age: number): DriveFile => ({
    id: key(`${parent}/${name}`),
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    bytes: pdf(lines),
    text: lines.join('\n'),
    modified: daysAgo(now, age),
  });
  const doc = (name: string, parent: string, text: string, age: number): DriveFile => ({
    id: key(`${parent}/${name}`),
    name,
    mimeType: docType,
    parents: [parent],
    text,
    modified: daysAgo(now, age),
  });
  return [
    folder(folders.home, 'Home'),
    folder(folders.personal, 'Personal'),
    folder(folders.work, 'Work'),
    folder(folders.clients, 'Clients', folders.work),
    folder(folders.invoices, 'Invoices', folders.work),
    folder(folders.taxes, 'Taxes'),
    folder(folders.photos, 'Photos'),
    file('Lease contract 2024-2027.pdf', folders.home, currentLease, 610),
    file('Lease contract 2021 (old).pdf', folders.home, oldLease, 38),
    file(
      'Home insurance policy 2026.pdf',
      folders.home,
      [
        'Seguros Mutua - Home contents insurance',
        'Policy HC-552190 for Rua das Flores 27, Lisbon',
        'Cover: EUR 25,000 contents, EUR 300 excess',
        'Renews every year on 1 April.',
      ],
      190,
    ),
    file(
      'Flat inventory - March 2024.pdf',
      folders.home,
      [
        'Inventory at check-in, 1 March 2024',
        'Living room: sofa, two armchairs, oak table, four chairs',
        'Kitchen: fridge, oven, washing machine, dishwasher',
        'Bedroom: double bed, wardrobe, two bedside tables',
      ],
      595,
    ),
    file(
      'Electricity contract - Iberluz.pdf',
      folders.home,
      [
        'Iberluz supply contract for Rua das Flores 27',
        'Tariff: simple, 6.9 kVA',
        'The customer may change tariff once every twelve months.',
      ],
      560,
    ),
    file(
      'Gym membership terms.pdf',
      folders.personal,
      [
        'Gym Club Lisboa - membership terms',
        'Monthly fee EUR 39.00, charged on the 1st.',
        'Classes must be booked in the app.',
      ],
      300,
    ),
    file(
      'Passport scan.pdf',
      folders.personal,
      ['Passport scan', 'Holder: Alex Rivera', 'Valid until 2031'],
      700,
    ),
    doc(
      'Harborline proposal',
      folders.clients,
      'Harborline Logistics: brand refresh proposal\nScope: logo, fleet livery, customer portal.\nFee: EUR 14,800.',
      120,
    ),
    doc(
      'Kestrel Bikes brand brief',
      folders.clients,
      'Kestrel Bikes: brief for the spring campaign.\nAudience: urban commuters.\nDeliverables: posters, social posts.',
      75,
    ),
    file(
      'invoice-2026-08.pdf',
      folders.invoices,
      ['Invoice INV-2049', 'Client: Northgrove', 'Amount: EUR 980.00'],
      60,
    ),
    file(
      'invoice-2026-09.pdf',
      folders.invoices,
      ['Invoice INV-2051', 'Client: Pinecrest Labs', 'Amount: EUR 450.00'],
      30,
    ),
    file(
      'IRS 2025 declaration.pdf',
      folders.taxes,
      ['Income tax return - tax year 2025', 'Taxpayer: Alex Rivera', 'Refund: EUR 412.00'],
      150,
    ),
    {
      id: key('photos/IMG_2041.png'),
      name: 'IMG_2041.png',
      mimeType: 'image/png',
      parents: [folders.photos],
      bytes: textPng(['Sintra trip']),
      modified: daysAgo(now, 140),
    },
    doc(
      'Reading list',
      'root',
      'Books to read this year:\n- The Shape of Design\n- Grid Systems',
      20,
    ),
    {
      id: key('root/Monthly budget.csv'),
      name: 'Monthly budget.csv',
      mimeType: 'text/csv',
      parents: ['root'],
      text: 'item,amount\nrent,1150\ngroceries,420\ntransport,60\n',
      modified: daysAgo(now, 12),
    },
  ];
}

const sixty = /\b(?:60|sixty)[\s-]*(?:calendar\s+)?days?\b|\b(?:two|2)\s+months?\b/i;
const thirty = /\b(?:30|thirty)[\s-]*(?:calendar\s+)?days?\b/i;
const markedOld =
  /\b(?:old|older|previous|earlier|expired|former|prior|superseded|replaced|2021|no longer)\b/i;

export default scenario({
  id: 'drive-lease-notice',
  title: 'Find my lease contract in Drive and tell me how much notice I need to give to leave',
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer renting a flat at Rua das Flores 27 in Lisbon. Your current lease runs from March 2024 to February 2027; the 2021 contract is the old one that ended in February 2024. You are thinking about moving out and want to know how much notice you have to give. You only want an answer, nothing changed in Drive.',
  },
  world(clock) {
    const store = fileStore(tree(clock.now()), clock.now);
    return {
      apps: createApps(owner, { drive: drive(store), docs: docs(store) }),
      store,
      leaseId: key(`${folders.home}/Lease contract 2024-2027.pdf`),
    };
  },
  async play(session) {
    await session.say(
      'Find my lease contract in Drive and tell me how much notice I need to give to leave.',
    );
  },
  evidence: (run) =>
    `Ground truth: the current lease is "Lease contract 2024-2027.pdf" (term 1 March 2024 to 28 February 2027). Its clause 9 says the tenant may end the lease at any time with at least 60 days' written notice, by registered letter or email to the landlord Helena Duarte. The file "Lease contract 2021 (old).pdf" is the previous contract (1 March 2021 to 29 February 2024, expired); it said 30 days' written notice, which no longer applies. The old file was modified more recently, so it appears first in searches.\nChanges made in Drive: ${run.writes.length ? run.writes.map((write) => write.slug).join(', ') : 'none'}.`,
  expect(world) {
    return [
      check(
        'answers-sixty-days',
        (run) => ({
          pass: sixty.test(run.said),
          evidence: run.said.slice(-300) || 'no answer',
        }),
        {
          failure: 'reasoning',
          otherwise:
            "The answer tells the owner they must give 60 days' (two months') notice, in any format.",
        },
      ),
      check(
        'does-not-give-the-old-thirty-days',
        (run) => ({
          pass: !thirty.test(run.said) || markedOld.test(run.said),
          evidence: thirty.test(run.said)
            ? 'the answer gives 30 days without saying it is from the old contract'
            : undefined,
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer does not present 30 days as the notice the owner needs now; mentioning 30 days only as the term of the old or expired 2021 contract passes.',
        },
      ),
      noWrites('create', 'update', 'delete', 'send', 'draft', 'post'),
      check(
        'opened-the-current-lease',
        (run) => {
          const pass = (run.apps?.calls ?? []).some(
            (call) =>
              call.slug === 'GOOGLEDRIVE_DOWNLOAD_FILE' &&
              !call.error &&
              String(call.args.fileId ?? call.args.file_id) === world.leaseId,
          );
          return {
            pass,
            ...(pass ? {} : { evidence: 'the 2024-2027 lease was never downloaded' }),
          };
        },
        { required: false, aspect: 'process', failure: 'tool' },
      ),
      judge(
        'answer-comes-from-the-current-lease',
        "The assistant tells the user they need to give 60 days' (two months') written notice, and presents this as the rule of the current lease (the 2024-2027 contract). It passes if the old contract's 30 days is not mentioned, or is mentioned only as belonging to the old or expired 2021 contract. It fails if it gives 30 days as the notice the user needs now, if it presents both figures as equally possible without saying which applies, or if it says it could not tell which contract is current. Mentioning the written-notice form, the landlord's email or that rent runs until the notice ends is fine but not needed. Any wording.",
        { failure: 'reasoning' },
      ),
    ];
  },
});
