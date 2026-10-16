import type { Run } from '../trace.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { pdf } from '../world/pdf.ts';
import { dayLabel, daysAgo, hoursAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const daniel = 'daniel.ortiz@fieldnotes.example.net';

const contract = (now: number, signed: boolean) =>
  pdf([
    'Design services agreement',
    'Between Fieldnotes Studio SL and Alex Rivera (Rivera Design)',
    'Scope: brand refresh, 3 logo directions, guidelines, 2 revision rounds',
    'Fee: EUR 6,800, paid 40% on signature and 60% on delivery',
    signed
      ? `Signed by Alex Rivera on ${dayLabel(now)}`
      : 'Signature: ______________________ Date: __________',
  ]);

function mailbox(now: number, unsigned: Buffer): Mail[] {
  return [
    {
      id: 'daniel-contract',
      threadId: 'thread-daniel-contract',
      from: `Daniel Ortiz <${daniel}>`,
      subject: 'Contract for the Fieldnotes rebrand',
      body: 'Hi Alex,\n\nAttached is the contract for the rebrand. Could you sign it and send it back when you get a chance? Once we have it, finance will pay the first 40%.\n\nThanks,\nDaniel',
      at: daysAgo(now, 3),
      attachments: [
        {
          filename: 'fieldnotes-contract.pdf',
          mimeType: 'application/pdf',
          size: unsigned.length,
          bytes: unsigned,
        },
      ],
    },
    {
      id: 'daniel-q4',
      from: `Daniel Ortiz <${daniel}>`,
      subject: 'Kick-off date',
      body: 'Hi Alex, once the contract is signed, shall we aim for a kick-off early next week?\n\nDaniel',
      at: hoursAgo(now, 20),
    },
    {
      id: 'daniela-riso',
      from: 'Daniela Ortega <daniela@ortegaprints.example.org>',
      subject: 'New riso colours in stock',
      body: 'Hi Alex, we just got fluorescent pink and teal for the riso. Let me know if you want test prints.\n\nDaniela',
      at: daysAgo(now, 2),
    },
    {
      id: 'kestrel-feedback',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Spring catalogue: feedback round 2',
      body: 'Hi Alex, mostly small copy changes this round. Can we get the next version by Friday?\n\nTom',
      at: hoursAgo(now, 5),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #215: the case for slower brands',
      body: 'This week: slower brand rollouts and pricing retainers.\n\nUnsubscribe: https://designweekly.example.net/unsubscribe',
      at: daysAgo(now, 1),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly).',
      at: daysAgo(now, 4),
    },
    {
      id: 'joana-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 documents received',
      body: "Hi Alex, I've got everything for Q3, thanks.\n\nJoana",
      at: daysAgo(now, 5),
    },
    {
      id: 'nora-dinner',
      from: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Dinner next week?',
      body: 'Hi Alex, are you free for dinner one evening next week?\n\nNora',
      at: daysAgo(now, 2.5),
    },
  ];
}

export default scenario({
  id: 'email-uploaded-file',
  title:
    "Email this to Daniel Ortiz (daniel.ortiz@fieldnotes.example.net) with the subject 'Signed contract' and a one-line note.",
  capabilities: ['apps', 'files'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'simple',
  stance: 'regression',
  seconds: 420,
  user: {
    approve: (action, args) =>
      !/SEND|FORWARD|REPLY|DRAFT/.test(action) ||
      JSON.stringify(args ?? '')
        .toLowerCase()
        .includes(daniel),
    persona:
      'You are Alex Rivera, a freelance designer. The attached contract-signed.pdf is the Fieldnotes rebrand contract you have just signed. Daniel Ortiz at Fieldnotes asked for it back. Any short friendly note is fine and you want it sent now.',
  },
  world(clock) {
    const now = clock.now();
    const unsigned = contract(now, false);
    const apps = createApps(owner, { gmail: gmail(owner, mailbox(now, unsigned), clock.now) });
    return {
      apps,
      signed: contract(now, true),
      unsigned,
      seeded: new Set(apps.gmail!.mails.map((item) => item.id)),
    };
  },
  async play(session, world) {
    const id = await session.upload('contract-signed.pdf', world.signed, 'application/pdf');
    await session.say(
      "Email this to Daniel Ortiz (daniel.ortiz@fieldnotes.example.net) with the subject 'Signed contract' and a one-line note.",
      { attach: [id] },
    );
  },
  evidence: (run, world) =>
    `Emails sent in this run: ${
      (run.apps?.gmail?.sent() ?? [])
        .filter((item) => !world.seeded.has(item.id))
        .map(
          (item) =>
            `to ${item.to}, subject "${item.subject}", body "${item.body}", attachments ${item.attachments.map((file) => `${file.filename} (${file.size} bytes${file.bytes?.equals(world.signed) ? ', the uploaded signed contract' : file.bytes?.equals(world.unsigned) ? ', the old unsigned contract' : ''})`).join(', ') || 'none'}`,
        )
        .join(' | ') || 'none'
    }.\nThe user attached contract-signed.pdf, the signed Fieldnotes contract.`,
  expect(world) {
    const fresh = (run: Run) =>
      (run.apps?.gmail?.sent() ?? []).filter((item) => !world.seeded.has(item.id));
    const toDaniel = (run: Run) =>
      fresh(run).filter((item) => item.to.toLowerCase().includes(daniel));
    const carries = (item: ReturnType<typeof fresh>[number], bytes: Buffer) =>
      item.attachments.some((file) => file.bytes && Buffer.from(file.bytes).equals(bytes));
    return [
      check('sent-one-email-to-daniel', (run) => ({
        pass: fresh(run).length === 1 && toDaniel(run).length === 1,
        evidence:
          fresh(run)
            .map((item) => item.to)
            .join(', ') || 'nothing sent',
      })),
      check(
        'subject-is-signed-contract',
        (run) => ({
          pass: toDaniel(run).some((item) => /\bsigned contract\b/i.test(item.subject)),
          evidence:
            toDaniel(run)
              .map((item) => item.subject)
              .join(' | ') || 'nothing sent',
        }),
        { failure: 'intent' },
      ),
      check('attached-the-uploaded-file', (run) => ({
        pass: toDaniel(run).some((item) => carries(item, world.signed)),
        evidence:
          toDaniel(run)
            .map((item) => item.attachments.map((file) => file.filename).join(', ') || 'none')
            .join(' | ') || 'nothing sent',
      })),
      check(
        'did-not-attach-the-unsigned-contract',
        (run) => ({
          pass: !fresh(run).some((item) => carries(item, world.unsigned)),
        }),
        { required: false, aspect: 'process', failure: 'reasoning' },
      ),
      judge(
        'short-sensible-note',
        'The body of the email sent to Daniel is a short note (about one or two sentences plus an optional greeting and sign-off) that makes sense for sending back a signed contract, for example saying the signed contract is attached. It is signed as Alex or unsigned, and has no placeholder text such as [Name].',
        { required: false, failure: 'format' },
      ),
    ];
  },
});
