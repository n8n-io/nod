import { dumpDrafts, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { daysAgo } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const sam = 'sam.patel@harborline.example.net';
const lena = 'lena.fischer@oakhouse.example.org';

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'sent-nora',
      from: me,
      to: 'Nora Lindqvist <nora@lindqvist.example.org>',
      subject: 'Re: Logo options',
      body: 'Hi Nora,\n\nI like option two the most. Can you send the vector file when you have a minute?\n\nThanks,\nAlex',
      at: daysAgo(now, 9),
      labels: ['SENT'],
    },
    {
      id: 'sent-tom',
      from: me,
      to: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: 'Re: Site photos',
      body: "Hi Tom,\n\nThe photos are great. I'll pick the final set tomorrow and send you a link.\n\nThanks,\nAlex",
      at: daysAgo(now, 5),
      labels: ['SENT'],
    },
    {
      id: 'sam',
      threadId: 'thread-sam',
      from: `Sam Patel <${sam}>`,
      to: owner.email,
      subject: 'Logo files still not here?',
      body: "Hi Alex, we were promised the final logo files on Monday and haven't got them. Our print deadline is Friday. When will they arrive?\n\nSam",
      at: now - 3 * 3_600_000,
    },
    {
      id: 'lena',
      threadId: 'thread-lena',
      from: `Lena Fischer <${lena}>`,
      to: owner.email,
      subject: 'Brochure layout update?',
      body: 'Hi Alex, any news on the brochure layout? You mentioned the end of last week.\n\nLena',
      at: now - 2 * 3_600_000,
    },
  ];
}

export default scenario({
  id: 'standing-offer-after-one-off',
  title: 'After a one-off job that will recur, offer once to keep doing it',
  linear: 'LAB-508',
  capabilities: ['apps', 'progress'],
  tier: 'pr',
  complexity: 'simple',
  stance: 'gap',
  calibration: 'pending',
  seconds: 480,
  timeZone: 'Europe/Madrid',
  user: {
    persona:
      'You are Alex Rivera, a freelance designer. Clients often chase you about deliveries. You want to see drafts before anything is sent and you never want an email sent in this conversation.',
  },
  world: (clock) => ({
    apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
  }),
  async play(session) {
    await session.say(
      "Another client chasing a late delivery. Draft a reply to Sam's email: the final logo files go out Thursday morning. Don't send it.",
    );
    await session.say("And Lena's, the brochure layout goes out Friday. Draft only.");
  },
  evidence(run) {
    return dumpDrafts(run);
  },
  expect() {
    return [
      check(
        'drafts-reply-in-each-thread',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          const forSam = drafts.find((draft) => draft.to.toLowerCase().includes(sam));
          const forLena = drafts.find((draft) => draft.to.toLowerCase().includes(lena));
          return {
            pass: forSam?.threadId === 'thread-sam' && forLena?.threadId === 'thread-lena',
            evidence: JSON.stringify(drafts.map(({ to, threadId }) => ({ to, threadId }))),
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'drafts-give-the-promised-days',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          const forSam = drafts.find((draft) => draft.to.toLowerCase().includes(sam));
          const forLena = drafts.find((draft) => draft.to.toLowerCase().includes(lena));
          return {
            pass: Boolean(
              forSam && /thursday/i.test(forSam.body) && forLena && /friday/i.test(forLena.body),
            ),
            evidence: JSON.stringify(
              drafts.map(({ to, body }) => ({ to, body: body.slice(0, 200) })),
            ),
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'The draft reply to Sam says the final logo files go out Thursday morning and the draft reply to Lena says the brochure layout goes out Friday, in any wording or date format.',
        },
      ),
      noWrites('send', 'post'),
      check('no-standing-setup-without-a-yes', (run) => run.schedules.length === 0, {
        aspect: 'process',
        failure: 'scope',
      }),
      judge(
        'offers-once-to-keep-doing-it',
        "After the first draft, the assistant offers once, in one short separate message, to keep helping with this kind of email from now on, such as drafting replies whenever a client chases a delivery or writes in. The offer is specific to client emails, not a list of other things it can do. The reply to the owner's second request does not repeat the offer.",
        { failure: 'format' },
      ),
    ];
  },
});
