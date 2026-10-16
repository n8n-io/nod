import { dumpDrafts, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const marta = 'marta.silva@harborline.example.com';
const preference = "I always sign my emails 'Un abrazo, Alex'.";
const request = `Draft a thank-you email to Marta (${marta}) for the referral.`;
const signoff = /un\s+abrazo\s*[,!.]?\s*alex\b/i;

const plain = (body: string) =>
  body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
const drafts = (run: Run) => run.apps?.gmail?.drafts() ?? [];
const toMarta = (run: Run) => drafts(run).filter((draft) => draft.to.toLowerCase().includes(marta));

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'referral',
      threadId: 'thread-referral',
      from: `Marta Silva <${marta}>`,
      to: owner.email,
      subject: 'Passed your name to Lumen Foods',
      body: "Hi Alex,\n\nQuick heads-up: I passed your name to Daniel Okafor at Lumen Foods. They're redoing the packaging for their olive oil range and I told him you're the person for it. He'll be in touch this week.\n\nMarta",
      at: daysAgo(now, 3),
    },
    {
      id: 'daniel',
      threadId: 'thread-daniel',
      from: 'Daniel Okafor <daniel.okafor@lumenfoods.example.com>',
      to: owner.email,
      subject: 'Packaging redesign: Marta Silva suggested I get in touch',
      body: 'Hi Alex,\n\nMarta Silva at Harborline recommended you. We are redesigning the labels for our olive oil range and would love to talk. Could we have a call next week?\n\nBest,\nDaniel',
      at: daysAgo(now, 1),
    },
    {
      id: 'brochure',
      threadId: 'thread-brochure',
      from: me,
      to: `Marta Silva <${marta}>`,
      subject: 'Harborline brochure: final files',
      body: 'Hi Marta,\n\nHere are the final brochure files, print-ready. Let me know if the printer needs anything else.\n\nCheers,\nAlex',
      at: daysAgo(now, 70),
      labels: ['SENT'],
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #215: packaging that sells',
      body: 'This week: shelf tests for food packaging, a type foundry interview and ten label redesigns.',
      at: daysAgo(now, 2),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
  ];
}

export default scenario({
  id: 'memory-signoff-in-draft',
  title: 'Draft a thank-you to Marta, signed the way I told you I sign my emails',
  capabilities: ['memory', 'apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => !/SEND|REPLY_TO_THREAD|FORWARD/.test(action),
    persona:
      'You are Alex Rivera, a freelance designer. Marta Silva at Harborline referred a new client to you: Daniel Okafor at Lumen Foods, who needs olive oil packaging. Any sensible subject, length and tone are fine. You want a draft only, not a sent email. If the assistant asks how you sign your emails, say you already told it.',
  },
  world: (clock) => ({
    apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
  }),
  async play(session) {
    await session.say(preference);
    await session.reset();
    await session.say(request);
  },
  evidence: (run) =>
    `The owner said, in an earlier conversation that was then reset: "${preference}". The new conversation asked for a draft to Marta Silva (${marta}). Marta referred Daniel Okafor of Lumen Foods (olive oil packaging) to Alex. An old sent email to Marta from 70 days ago was signed "Cheers, Alex"; the saved preference is newer and explicit, so the draft should be signed "Un abrazo, Alex".\n\n${dumpDrafts(run)}\nEmails sent: ${run.writes.filter((write) => write.kind === 'send').length}\n\nSaved memory:\n${run.memory.slice(0, 2000)}`,
  expect() {
    return [
      check(
        'draft-to-marta',
        (run) => ({
          pass: toMarta(run).length > 0,
          evidence: `${drafts(run).length} drafts: ${drafts(run)
            .map((draft) => draft.to)
            .join(', ')}`,
        }),
        { failure: 'incomplete' },
      ),
      check(
        'signed-with-saved-signoff',
        (run) => {
          const found = toMarta(run);
          const unsigned = found.filter((draft) => !signoff.test(plain(draft.body)));
          return {
            pass: found.length > 0 && !unsigned.length,
            evidence: found.length
              ? unsigned.length
                ? `unsigned draft ends: ${plain(unsigned[0].body).trim().slice(-120)}`
                : undefined
              : 'no draft to Marta',
          };
        },
        { failure: 'reasoning' },
      ),
      check(
        'only-drafts-to-marta',
        (run) => {
          const extra = drafts(run).filter((draft) => !draft.to.toLowerCase().includes(marta));
          return {
            pass: !extra.length,
            evidence: extra.length
              ? `also drafted to ${extra.map((d) => d.to).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      noWrites('send'),
      check('signoff-remembered', (run) => /un abrazo/i.test(run.memory), {
        required: false,
        aspect: 'process',
        failure: 'incomplete',
      }),
      judge(
        'thanks-marta-for-the-referral',
        'The saved draft to Marta Silva thanks her for referring or recommending Alex to a new client (the referral was Daniel Okafor at Lumen Foods; naming him or the company is welcome but not required). It contains no placeholder text such as [Name] or [Client]. Subject, length, tone and language are free.',
        { failure: 'reasoning' },
      ),
    ];
  },
});
