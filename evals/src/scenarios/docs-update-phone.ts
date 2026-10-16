import { createHash } from 'node:crypto';
import { noWrites } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { docType, docs, drive, fileStore, folderType, type DriveFile } from '../world/drive.ts';
import { pdf } from '../world/pdf.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const key = (name: string) =>
  `1${createHash('sha256').update(name).digest('base64url').slice(0, 32)}`;

const oldPhone = '+34 611 222 333';
const newPhone = '+351 912 345 678';
const oldPattern = /611[\s.-]?222[\s.-]?333/;
const newPattern = /\+?351[\s.-]?912[\s.-]?345[\s.-]?678/g;

const folders = {
  career: key('folder:Career'),
  clients: key('folder:Clients'),
  personal: key('folder:Personal'),
  templates: key('folder:Templates'),
};

const cvId = key('doc:CV - Alex Rivera');
const cv = [
  'Alex Rivera',
  `Brand and web designer · Lisbon, Portugal · ${oldPhone} · alex.rivera@riveradesign.example`,
  'Portfolio: riveradesign.example/work',
  '',
  'Profile',
  'Independent designer with nine years of experience in brand identity, editorial and web design.',
  'I work with logistics, food and mobility companies from first sketch to launch.',
  '',
  'Experience',
  'Rivera Design Studio, Lisbon (2021 to present): founder and lead designer.',
  'Harborline Logistics: rebrand, fleet livery and customer portal (2024).',
  'Lumen Foods: packaging system for 40 products (2023).',
  'Kestrel Bikes: e-commerce redesign, conversion up 18% (2022).',
  'Atlas Creative, Madrid (2017 to 2021): senior designer.',
  'Nordlys Type Foundry, Barcelona (2015 to 2017): junior designer.',
  '',
  'Education',
  'BA in Communication Design, Instituto Aurora de Diseño, Madrid (2015).',
  'Certificate in UX Research, Escola Norte online programme (2020).',
  '',
  'Skills',
  'Figma, Adobe Creative Suite, Webflow, HTML and CSS, type design basics.',
  '',
  'Languages',
  'Spanish (native), Portuguese (fluent), English (fluent).',
  '',
  'Contact',
  'Email: alex.rivera@riveradesign.example',
  `Phone: ${oldPhone}`,
  'Studio: Rua das Flores 27, 1200-195 Lisbon',
  '',
  'References',
  'Marta Silva, Head of Brand, Harborline Logistics: +34 622 111 444',
  'Tom Becker, Founder, Kestrel Bikes: +49 151 2345 6789',
].join('\n');

const oldTemplate = [
  'Alex Rivera',
  `Senior designer · Madrid · ${oldPhone}`,
  '',
  'Experience',
  'Atlas Creative, Madrid (2017 to present): senior designer.',
  'Nordlys Type Foundry, Barcelona (2015 to 2017): junior designer.',
  '',
  'Contact',
  `Phone: ${oldPhone}`,
].join('\n');

const coverLetter = [
  'Dear Kestrel Bikes team,',
  'I would love to help with your next campaign.',
  `You can reach me on ${oldPhone} or by email.`,
  'Best regards,',
  'Alex Rivera',
].join('\n');

function tree(now: number): DriveFile[] {
  const folder = (id: string, name: string, parent = 'root'): DriveFile => ({
    id,
    name,
    mimeType: folderType,
    parents: [parent],
    modified: daysAgo(now, 800),
  });
  const doc = (id: string, name: string, parent: string, text: string, age: number): DriveFile => ({
    id,
    name,
    mimeType: docType,
    parents: [parent],
    text,
    modified: daysAgo(now, age),
  });
  const file = (name: string, parent: string, lines: string[], age: number): DriveFile => ({
    id: key(`pdf:${name}`),
    name,
    mimeType: 'application/pdf',
    parents: [parent],
    bytes: pdf(lines),
    text: lines.join('\n'),
    modified: daysAgo(now, age),
  });
  return [
    folder(folders.career, 'Career'),
    folder(folders.clients, 'Clients'),
    folder(folders.personal, 'Personal'),
    folder(folders.templates, 'Templates'),
    doc(cvId, 'CV - Alex Rivera', folders.career, cv, 160),
    doc(key('doc:CV - old template'), 'CV - old template', folders.templates, oldTemplate, 4),
    doc(
      key('doc:Cover letter - Kestrel Bikes'),
      'Cover letter - Kestrel Bikes',
      folders.career,
      coverLetter,
      90,
    ),
    doc(
      key('doc:Portfolio case studies'),
      'Portfolio case studies',
      folders.career,
      'Harborline: rebrand\nLumen Foods: packaging\nKestrel Bikes: e-commerce',
      70,
    ),
    doc(
      key('doc:Harborline proposal'),
      'Harborline proposal',
      folders.clients,
      'Harborline Logistics: brand refresh proposal\nFee: €14,800',
      30,
    ),
    doc(
      key('doc:Reading list'),
      'Reading list',
      folders.personal,
      'Books to read:\n- Grid Systems\n- The Shape of Design',
      20,
    ),
    file('CV - Alex Rivera (2023 export).pdf', folders.career, cv.split('\n').slice(0, 20), 700),
    file('Passport scan.pdf', folders.personal, ['Passport scan', 'Holder: Alex Rivera'], 400),
    file(
      'Harborline statement of work.pdf',
      folders.clients,
      ['Statement of work: Harborline Logistics'],
      12,
    ),
  ];
}

const lines = (text: string) =>
  text
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/\*{1,2}|_{1,2}/g, '')
        .replace(/\\(?=[^\w\s])/g, '')
        .trim(),
    )
    .filter(Boolean);

export default scenario({
  id: 'docs-update-phone',
  title: 'In my CV doc, change my phone number to +351 912 345 678',
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      action.startsWith('GOOGLEDOCS_') && JSON.stringify(args ?? {}).includes(cvId),
    answers: [
      {
        when: /old template|which (?:cv|doc|one)|both|cover letter|other (?:doc|file)s?/i,
        say: 'Only my current CV, "CV - Alex Rivera". Leave the old template and every other document as they are.',
      },
    ],
    persona:
      'You are Alex Rivera. You moved from Spain to Portugal and have a new Portuguese mobile number, +351 912 345 678. Your current CV is the Google Doc "CV - Alex Rivera"; "CV - old template" is an old draft you keep as is, and the PDF export from 2023 is an archive. Only the current CV doc should change.',
  },
  world(clock) {
    const store = fileStore(tree(clock.now()), clock.now);
    return {
      apps: createApps(owner, { drive: drive(store), docs: docs(store) }),
      store,
      seed: store.files.map((file) => ({
        id: file.id,
        name: file.name,
        text: file.text,
        bytes: file.bytes,
      })),
    };
  },
  async play(session) {
    await session.say(`In my CV doc, change my phone number to ${newPhone}.`);
  },
  evidence: (run) => {
    const doc = (run.apps?.drive?.files ?? []).find((file) => file.id === cvId);
    return `Ground truth: the Google Doc "CV - Alex Rivera" has the old number ${oldPhone} twice (header line and Contact section). Both must become ${newPhone}; every other line stays as it was, including the references' phone numbers. "CV - old template", "Cover letter - Kestrel Bikes" and the 2023 PDF export also contain the old number and must stay unchanged.\nThe CV now reads:\n${doc?.text ?? '(missing)'}\nChanges made: ${run.writes.map((write) => write.slug).join(', ') || 'none'}.`;
  },
  expect(world) {
    const stored = (run: Run, id: string) =>
      (run.apps?.drive?.files ?? []).find((file) => file.id === id);
    const text = (run: Run) => stored(run, cvId)?.text ?? '';
    return [
      check(
        'old-number-removed',
        (run) => ({
          pass: Boolean(text(run)) && !oldPattern.test(text(run)),
          evidence: oldPattern.test(text(run)) ? 'the CV still has the old number' : undefined,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'new-number-in-both-places',
        (run) => {
          const count = [...text(run).matchAll(newPattern)].length;
          return { pass: count >= 2, evidence: `${count} occurrences of the new number` };
        },
        { failure: 'incomplete' },
      ),
      check(
        'rest-of-cv-unchanged',
        (run) => {
          const expected = lines(cv.replaceAll(oldPhone, 'PHONE'));
          const actual = lines(text(run).replace(newPattern, 'PHONE'));
          const differences = expected.filter((line, index) => actual[index] !== line);
          return {
            pass: actual.length === expected.length && !differences.length,
            evidence:
              actual.length !== expected.length
                ? `${actual.length} lines instead of ${expected.length}`
                : differences.length
                  ? `changed: ${differences.slice(0, 3).join(' | ')}`
                  : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'other-documents-unchanged',
        (run) => {
          const changed = world.seed.filter((item) => {
            const after = stored(run, item.id);
            if (item.id === cvId) return !after || after.trashed;
            return (
              !after ||
              after.trashed ||
              after.name !== item.name ||
              after.text !== item.text ||
              (item.bytes !== undefined && !after.bytes?.equals(item.bytes))
            );
          });
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed: ${changed.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      noWrites('create', 'delete'),
    ];
  },
});
