import { createHash } from 'node:crypto';
import { mentions, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps } from '../world/apps.ts';
import { docType, docs, drive, fileStore, folderType, type DriveFile } from '../world/drive.ts';
import { pdf } from '../world/pdf.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const key = (name: string) =>
  `1${createHash('sha256').update(name).digest('base64url').slice(0, 32)}`;

const folders = {
  clients: key('folder:Clients'),
  meridian: key('folder:Meridian'),
  harborline: key('folder:Harborline'),
  personal: key('folder:Personal'),
};

function deadlineYear(now: number) {
  const year = Number(
    new Date(now).toLocaleDateString('en-CA', { timeZone: 'Europe/Madrid' }).slice(0, 4),
  );
  return now > Date.UTC(year, 11, 12, 22) ? year + 1 : year;
}

function brief(year: number) {
  return [
    'Meridian project brief',
    'Client: Meridian Hotels',
    'Project: autumn campaign and booking-site refresh',
    'Version 2, approved by the client',
    '',
    'Objective',
    'Lift direct bookings on the Meridian website by 15% over the winter season.',
    '',
    'Scope',
    '- Campaign concept, key visual and six social formats',
    '- Booking flow redesign (search, room choice, checkout)',
    '- Handover of design files and a short style guide',
    '',
    'Milestones',
    `- Concept review: 7 November ${year}`,
    `- First booking-flow designs: 21 November ${year}`,
    `- Deadline for final delivery: 12 December ${year}`,
    '',
    'Budget',
    'Fixed fee of €36,500, excluding VAT, invoiced 40% at start and 60% on delivery.',
    '',
    'Approvals',
    'Day-to-day contact: Duarte Neves, Marketing Manager.',
    'Sign-off on every deliverable: Teresa Lobo, Head of Marketing.',
  ].join('\n');
}

function superseded(year: number) {
  return [
    'Meridian brief v1',
    'Client: Meridian Hotels',
    'Project: autumn campaign, website refresh and video',
    'Version 1, draft for discussion',
    '',
    'Scope',
    '- Campaign concept and key visual',
    '- Full website redesign',
    '- Two 30-second videos',
    '',
    `Deadline: 28 November ${year}`,
    'Budget: €42,000, excluding VAT',
    'Sign-off: Rui Matos, Brand Director',
  ].join('\n');
}

function tree(now: number): DriveFile[] {
  const year = deadlineYear(now);
  const folder = (id: string, name: string, parent = 'root'): DriveFile => ({
    id,
    name,
    mimeType: folderType,
    parents: [parent],
    modified: daysAgo(now, 500),
  });
  const doc = (name: string, parent: string, text: string, age: number): DriveFile => ({
    id: key(`doc:${name}`),
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
    folder(folders.clients, 'Clients'),
    folder(folders.meridian, 'Meridian', folders.clients),
    folder(folders.harborline, 'Harborline', folders.clients),
    folder(folders.personal, 'Personal'),
    doc('Meridian project brief', folders.meridian, brief(year), 21),
    doc('Meridian brief v1 (superseded)', folders.meridian, superseded(year), 2),
    doc(
      'Meridian moodboard notes',
      folders.meridian,
      'Warm winter light, coastal textures, handwritten accents.\nAvoid stock photos of pools.',
      15,
    ),
    doc(
      'Harborline project brief',
      folders.harborline,
      'Harborline project brief\nDeadline: 30 January\nBudget: €14,800\nSign-off: Marta Silva, Head of Brand',
      60,
    ),
    doc('Reading list', folders.personal, 'Books to read:\n- Grid Systems', 20),
    file(
      'Meridian Hotels proposal.pdf',
      folders.meridian,
      ['Proposal for Meridian Hotels', 'Estimated fee: EUR 35,000 to 45,000'],
      40,
    ),
    file(
      'Harborline statement of work.pdf',
      folders.harborline,
      ['Statement of work: Harborline Logistics'],
      12,
    ),
    file('Passport scan.pdf', folders.personal, ['Passport scan', 'Holder: Alex Rivera'], 400),
  ];
}

const twelfthOfDecember =
  /\b12(?:th)?(?:\s+of)?\s+dec(?:ember)?\b|\bdec(?:ember)?\.?\s+12(?:th)?\b|\b\d{4}-12-12\b|\b12\/12\b|\b12\.12\b/i;

export default scenario({
  id: 'docs-brief-summary',
  title: "From the Meridian project brief, what's the deadline, the budget and who signs off?",
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer working on the Meridian Hotels project. You want three facts from the current project brief, nothing changed.',
  },
  world(clock) {
    const store = fileStore(tree(clock.now()), clock.now);
    return {
      apps: createApps(owner, { drive: drive(store), docs: docs(store) }),
      year: deadlineYear(clock.now()),
    };
  },
  async play(session) {
    await session.say(
      "From the Meridian project brief, what's the deadline, the budget and who signs off?",
    );
  },
  evidence: (run, world) =>
    `Ground truth from the Google Doc "Meridian project brief" (version 2, the current one): deadline for final delivery 12 December ${world.year}; budget €36,500 fixed fee excluding VAT; sign-off by Teresa Lobo, Head of Marketing (Duarte Neves is only the day-to-day contact). The doc "Meridian brief v1 (superseded)" has outdated figures that must not be given as the answer: deadline 28 November, budget €42,000, sign-off Rui Matos. It was edited more recently, so it appears first in searches. The concept review (7 November) and first designs (21 November) are milestones, not the deadline.\nChanges made: ${run.writes.map((write) => write.slug).join(', ') || 'none'}.`,
  expect() {
    return [
      check(
        'gives-the-budget',
        (run) => ({
          pass: mentions(run.said, 36500) || /\b36[.,]5\s?k\b/i.test(run.said),
          evidence: run.said.slice(-300),
        }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer gives the Meridian project budget as €36,500, in any wording or number format.',
        },
      ),
      check(
        'gives-the-deadline',
        (run) => ({ pass: twelfthOfDecember.test(run.said), evidence: run.said.slice(-300) }),
        {
          failure: 'reasoning',
          otherwise:
            'The answer gives the Meridian project deadline as 12 December, in any wording or date format.',
        },
      ),
      check('names-who-signs-off', (run) => /\bteresa\s+lobo\b/i.test(run.said), {
        failure: 'reasoning',
        otherwise:
          'The answer names Teresa Lobo as the person who signs off the Meridian project, in any wording.',
      }),
      noWrites('create', 'update', 'delete', 'send', 'draft', 'post'),
      judge(
        'does-not-use-the-superseded-brief',
        'The assistant answers from the current brief: deadline 12 December, budget €36,500 and sign-off by Teresa Lobo. It fails if it presents any figure from the superseded v1 brief (deadline 28 November, budget €42,000, sign-off by Rui Matos) as the answer, if it gives Duarte Neves as the person who signs off, or if it gives a milestone date (7 or 21 November) as the deadline. Mentioning the v1 figures only as outdated or superseded is fine. Any wording and format.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
