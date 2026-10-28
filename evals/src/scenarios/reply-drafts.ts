import { dumpDrafts, noWrites } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, localTime, nextWeekOn } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const me = `Alex Rivera <${owner.email}>`;
const sofia = 'sofia.almeida@meridiancapital.example.org';
const daniel = 'daniel.ortiz@fieldnotes.example.net';

const samples: Array<{ to: string; subject: string; body: string; days: number }> = [
  {
    to: 'Daniel Ortiz <daniel.ortiz@fieldnotes.example.net>',
    subject: 'Re: Q3 files',
    body: "Hi Daniel,\n\nSounds good. I'll send the files over this afternoon. Let me know if anything's missing.\n\nThanks,\nAlex",
    days: 21,
  },
  {
    to: 'Nora Lindqvist <nora@lindqvist.example.org>',
    subject: 'Re: Logo options',
    body: 'Hi Nora,\n\nI like option two the most. The mark holds up well at small sizes. Can you send the vector file when you have a minute?\n\nThanks,\nAlex',
    days: 17,
  },
  {
    to: 'Tom Bailey <tom@kestrelbikes.example.net>',
    subject: 'Re: Site photos',
    body: "Hi Tom,\n\nThe photos are great. I'll pick the final set tomorrow and send you a link to review.\n\nThanks,\nAlex",
    days: 12,
  },
  {
    to: 'Priya Nair <priya@brightloom.example.org>',
    subject: 'Re: Friday?',
    body: "Hi Priya,\n\nFriday works for me. 10:00 is fine, I'll bring the updated moodboard.\n\nThanks,\nAlex",
    days: 8,
  },
];

function mailbox(now: number): Mail[] {
  const mails: Mail[] = samples.map((sample, index) => ({
    id: `sample-${index}`,
    from: me,
    to: sample.to,
    subject: sample.subject,
    body: sample.body,
    at: daysAgo(now, sample.days),
    labels: ['SENT'],
  }));
  mails.push(
    {
      id: 'proposal-sent',
      threadId: 'thread-proposal',
      from: me,
      to: `Sofia Almeida <${sofia}>`,
      subject: 'Proposal: Meridian rebrand',
      body: "Hi Sofia,\n\nHere's the proposal for the rebrand. The total is €4,500 and that covers two rounds of revisions. Extra rounds are €300 each. Happy to jump on a call if it helps.\n\nThanks,\nAlex",
      at: daysAgo(now, 6),
      labels: ['SENT'],
    },
    {
      id: 'sofia',
      threadId: 'thread-proposal',
      from: `Sofia Almeida <${sofia}>`,
      to: owner.email,
      subject: 'Re: Proposal: Meridian rebrand',
      body: 'Hi Alex, quick question on the proposal. Does the €4,500 include two rounds of revisions or three? I need to tell my board tomorrow morning.\n\nSofia',
      at: now - 5 * 3_600_000,
    },
    {
      id: 'daniel',
      threadId: 'thread-daniel',
      from: `Daniel Ortiz <${daniel}>`,
      to: owner.email,
      subject: 'Q4 plan, 30 minutes next week?',
      body: "Hi Alex, do you have 30 minutes next week to go over the Q4 plan? I'm free Tuesday or Wednesday afternoon.\n\nDaniel",
      at: now - 8 * 3_600_000,
    },
    {
      id: 'newsletter',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #213: the return of serif',
      body: 'This week: five serif revivals worth studying, a roundup of brand refreshes, and a long read on creative pricing.',
      at: now - 10 * 3_600_000,
    },
    {
      id: 'receipt',
      from: 'Figma <billing@figma.com>',
      to: owner.email,
      subject: 'Your Figma receipt',
      body: 'Thanks for your payment of €15.00 for Figma Professional (monthly).',
      at: now - 12 * 3_600_000,
    },
    {
      id: 'fyi',
      threadId: 'thread-fyi',
      from: 'Priya Nair <priya@brightloom.example.org>',
      to: owner.email,
      subject: 'FYI: updated brand guidelines',
      body: 'Hi Alex, I put the updated brand guidelines in the shared Drive folder. No action needed, just so you have the latest version.\n\nPriya',
      at: now - 14 * 3_600_000,
    },
  );
  return mails;
}

export default scenario({
  id: 'reply-drafts',
  title: 'Draft replies in my voice to the emails that need one',
  linear: 'LAB-382',
  capabilities: ['apps', 'memory', 'approvals'],
  tier: 'pr',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    persona:
      'You are Alex Rivera, a freelance designer. You write short, friendly emails. You want to see drafts before anything is sent and you never want an email sent in this conversation.',
  },
  world(clock) {
    const now = clock.now();
    const tuesday = nextWeekOn(now, 2);
    const wednesday = nextWeekOn(now, 3);
    const at = (offset: number, hour: number, minutes = 0) =>
      localTime(now + offset * 86_400_000, 0, hour, 'Europe/Madrid', minutes);
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now), clock.now),
        calendar: calendar(
          owner,
          [
            {
              summary: 'Client workshop: Harborline',
              start: at(tuesday, 14),
              end: at(tuesday, 17, 30),
              location: 'Harborline office',
            },
            { summary: 'Weekly standup', start: at(wednesday, 9, 30), end: at(wednesday, 10, 30) },
            { summary: 'Invoice admin', start: at(tuesday, 10), end: at(tuesday, 11) },
          ],
          'Europe/Madrid',
        ),
      }),
      days: {
        tuesday: dayLabel(now + tuesday * 86_400_000),
        wednesday: dayLabel(now + wednesday * 86_400_000),
      },
    };
  },
  async play(session) {
    await session.say(
      "Check the emails I got since yesterday and draft a reply to each one that needs one, in my voice. Show me the drafts here. Don't send anything.",
    );
  },
  evidence(run, world) {
    const style = samples.map((sample) => `To ${sample.to}:\n${sample.body}`).join('\n---\n');
    return `${dumpDrafts(run)}\n\nCalendar events: ${JSON.stringify(world.apps.calendar?.events.map((event) => world.apps.calendar!.view(event)))}\n\nThe user's real sent emails, for judging voice:\n${style}`;
  },
  expect(world) {
    return [
      check(
        'drafts-both-emails-that-need-a-reply',
        (run) => {
          const recipients = (run.apps?.gmail?.drafts() ?? []).map((draft) =>
            draft.to.toLowerCase(),
          );
          return {
            pass:
              recipients.some((to) => to.includes(sofia)) &&
              recipients.some((to) => to.includes(daniel)),
            evidence: `drafted for ${recipients.join(', ') || 'nobody'}`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'no-draft-for-newsletters-receipts-or-fyi',
        (run) => {
          const extra = (run.apps?.gmail?.drafts() ?? []).filter(
            (draft) =>
              !draft.to.toLowerCase().includes(sofia) && !draft.to.toLowerCase().includes(daniel),
          );
          return {
            pass: !extra.length,
            evidence: extra.length
              ? `also drafted to ${extra.map((d) => d.to).join(', ')}`
              : undefined,
          };
        },
        { failure: 'scope' },
      ),
      check(
        'drafts-are-replies-in-the-same-thread',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          const sofiaDraft = drafts.find((draft) => draft.to.toLowerCase().includes(sofia));
          const danielDraft = drafts.find((draft) => draft.to.toLowerCase().includes(daniel));
          return {
            pass:
              sofiaDraft?.threadId === 'thread-proposal' &&
              danielDraft?.threadId === 'thread-daniel',
            evidence: `threads ${sofiaDraft?.threadId ?? 'none'}, ${danielDraft?.threadId ?? 'none'}`,
          };
        },
        { failure: 'tool' },
      ),
      noWrites('send'),
      judge(
        'daniel-draft-offers-a-slot-that-is-free',
        `Daniel's draft proposes a specific free 30-minute afternoon slot on either ${world.days.tuesday} or ${world.days.wednesday}, in Europe/Madrid. It must not overlap the Tuesday client workshop from 14:00 to 17:30. Tuesday 17:30 to 18:00 is free and is acceptable, as is Wednesday afternoon. A promise to check later, or asking Daniel to repeat the availability he already supplied, does not complete the reply.`,
        { failure: 'reasoning' },
      ),
      judge(
        'sofia-draft-answers-the-question',
        "Sofia's draft answers her question directly from the earlier proposal: the €4,500 includes two rounds of revisions, and further rounds cost extra (€300 each). It does not claim three rounds are included. Any phrasing of the two rounds and the extra cost is fine.",
        { failure: 'reasoning' },
      ),
      judge(
        'sounds-like-alex',
        'Both drafts sound like the user\'s real sent emails shown in the evidence: short, a first-name greeting such as "Hi Sofia,", plain direct sentences, and a short sign-off with the name Alex as in those emails (the exact greeting and sign-off words are free). There is no corporate filler such as "I hope this email finds you well", no exclamation overload and no placeholder text.',
        { failure: 'format' },
      ),
      judge(
        'shows-the-drafts-and-says-nothing-was-sent',
        'Across the messages the user saw (the drafts may be in the final answer or an earlier message), the content of both drafts is shown in full or near-verbatim, not just that they exist, and it is clear nothing was sent (presenting them as unsent drafts counts). Quoted text, a list, a code block or prose are all fine.',
        { aspect: 'process', failure: 'incomplete' },
      ),
    ];
  },
});
