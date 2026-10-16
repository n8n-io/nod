import { createHash } from 'node:crypto';
import { mentions } from '../checks.ts';
import { check, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps } from '../world/apps.ts';
import { docType, docs, drive, fileStore, folderType, type DriveFile } from '../world/drive.ts';
import { pdf } from '../world/pdf.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const key = (name: string) =>
  `1${createHash('sha256').update(name).digest('base64url').slice(0, 32)}`;

const folders = {
  clients: key('folder:Clients'),
  harborline: key('folder:Harborline'),
  lumen: key('folder:Lumen Foods'),
  meetings: key('folder:Meeting notes'),
  personal: key('folder:Personal'),
};

function tree(now: number): DriveFile[] {
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
    folder(folders.harborline, 'Harborline', folders.clients),
    folder(folders.lumen, 'Lumen Foods', folders.clients),
    folder(folders.meetings, 'Meeting notes'),
    folder(folders.personal, 'Personal'),
    doc(
      'Kickoff notes: Lumen Foods',
      folders.meetings,
      'Kickoff notes: Lumen Foods\n\n- Budget approved at €22k\n- Launch 12 March\n- Rui owns packaging copy\n- Next check-in Monday 09:30',
      210,
    ),
    doc(
      'Harborline proposal',
      folders.harborline,
      'Harborline Logistics: brand refresh proposal\nScope: logo, fleet livery, customer portal.\nEstimated fee: €45k to €50k.',
      30,
    ),
    doc(
      'Harborline call notes - discovery',
      folders.harborline,
      'Discovery call with Marta Silva.\nThey want the new brand before the November trade fair.',
      45,
    ),
    doc(
      'Meeting notes template',
      folders.meetings,
      'Title\n\nDecisions\n- \n\nOwners\n- \n\nNext check-in\n- ',
      400,
    ),
    doc('Lumen Foods packaging brief', folders.lumen, 'Packaging system for 40 products.', 260),
    doc(
      'Reading list',
      folders.personal,
      'Books to read:\n- Grid Systems\n- The Shape of Design',
      20,
    ),
    file(
      'Harborline statement of work.pdf',
      folders.harborline,
      ['Statement of work: Harborline Logistics', 'Phase 1: brand refresh'],
      12,
    ),
    file(
      'Lumen Foods invoice INV-2044.pdf',
      folders.lumen,
      ['Invoice INV-2044', 'Total due: EUR 3,200.00'],
      95,
    ),
    file('Passport scan.pdf', folders.personal, ['Passport scan', 'Holder: Alex Rivera'], 400),
  ];
}

const novemberThird =
  /\b0?3(?:rd)?(?:\s+of)?\s+nov(?:ember)?\b|\bnov(?:ember)?\.?\s+0?3(?:rd)?\b|\b\d{4}-11-03\b|\b0?3\/11\b|\b11\/0?3\b|\b0?3\.11\b|\b0?3-11-\d{4}\b/i;

const isTarget = (name: string) => /kickoff notes/i.test(name) && /harborline/i.test(name);

export default scenario({
  id: 'docs-notes-to-doc',
  title: "Turn these notes into a Google Doc called 'Kickoff notes: Harborline'",
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 360,
  user: {
    approve: (action) =>
      [
        'GOOGLEDOCS_CREATE_DOCUMENT',
        'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
        'GOOGLEDOCS_INSERT_TEXT_ACTION',
        'GOOGLEDOCS_UPDATE_DOCUMENT_MARKDOWN',
        'GOOGLEDRIVE_MOVE_FILE',
      ].includes(action),
    persona:
      "You are Alex Rivera, a freelance designer. The notes are from today's kickoff call with Harborline Logistics. You want a new Google Doc with the title you gave; layout and formatting are up to the assistant, and any Drive location is fine. Do not change any other document.",
  },
  world(clock) {
    const store = fileStore(tree(clock.now()), clock.now);
    return {
      apps: createApps(owner, { drive: drive(store), docs: docs(store) }),
      store,
      seed: store.files.map((file) => ({ id: file.id, name: file.name, text: file.text })),
    };
  },
  async play(session) {
    await session.say(
      "Turn these notes into a Google Doc called 'Kickoff notes: Harborline': budget approved at €48k; launch 3 November; Marta owns brand assets; next check-in Thursday 10:00.",
    );
  },
  evidence(run, world) {
    const created = (run.apps?.drive?.files ?? []).filter(
      (file) => file.mimeType === docType && !world.seed.some((item) => item.id === file.id),
    );
    return `Ground truth: one new Google Doc titled "Kickoff notes: Harborline" should hold four notes: budget approved at €48k, launch on 3 November, Marta owns brand assets, next check-in Thursday at 10:00. The older "Kickoff notes: Lumen Foods" doc must stay unchanged.\nNew docs: ${created.length ? created.map((file) => `"${file.name}":\n${file.text}`).join('\n---\n') : 'none'}.`;
  },
  expect(world) {
    const created = (run: Run) =>
      (run.apps?.drive?.files ?? []).filter(
        (file) =>
          file.mimeType === docType &&
          !file.trashed &&
          !world.seed.some((item) => item.id === file.id),
      );
    const doc = (run: Run) => created(run).find((file) => isTarget(file.name));
    return [
      check(
        'doc-created-with-the-title',
        (run) => ({
          pass: Boolean(doc(run)),
          evidence: created(run).length
            ? `new docs: ${created(run)
                .map((file) => file.name)
                .join(', ')}`
            : 'no new Google Doc',
        }),
        { failure: 'incomplete' },
      ),
      check(
        'doc-has-every-note',
        (run) => {
          const text = doc(run)?.text ?? '';
          const missing = [
            ['€48k', mentions(text, 48) || mentions(text, 48000)],
            ['3 November', novemberThird.test(text)],
            ['Marta', /\bmarta\b/i.test(text)],
            ['Thursday', /\bthu(?:rsday)?\b/i.test(text)],
          ]
            .filter(([, found]) => !found)
            .map(([label]) => label);
          return {
            pass: Boolean(text) && !missing.length,
            evidence: missing.length ? `missing: ${missing.join(', ')}` : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The new Google Doc "Kickoff notes: Harborline" holds all four notes, the budget approved at €48k, the launch on 3 November, Marta owning brand assets and the next check-in on Thursday, in any wording or format.',
        },
      ),
      check(
        'one-new-doc',
        (run) => ({
          pass: created(run).length <= 1,
          evidence: `${created(run).length} new docs`,
        }),
        { failure: 'scope' },
      ),
      check(
        'other-docs-unchanged',
        (run) => {
          const changed = world.seed.filter((item) => {
            const after = (run.apps?.drive?.files ?? []).find((file) => file.id === item.id);
            return !after || after.trashed || after.text !== item.text;
          });
          return {
            pass: !changed.length,
            evidence: changed.length
              ? `changed: ${changed.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        { aspect: 'process', failure: 'scope' },
      ),
      check(
        'keeps-the-check-in-time',
        (run) =>
          /\b10(?::00|\.00|h00|h)(?!\d)|\b10\s?(?:am|a\.m\.)|\bthu(?:rsday)?\W+(?:at\s+)?10\b/i.test(
            doc(run)?.text ?? '',
          ),
        {
          failure: 'incomplete',
          otherwise:
            'The new Google Doc "Kickoff notes: Harborline" gives the Thursday check-in time as 10:00, in any time format.',
        },
      ),
    ];
  },
});
