import type { Message } from '../../../src/shared/contracts.ts';
import { presentationText } from '../../../src/shared/presentation.ts';
import { dumpDrafts, noWrites, weekdaysAt } from '../checks.ts';
import { check, judge, scenario } from '../scenario.ts';
import type { Run } from '../trace.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { hoursAgo } from '../world/time.ts';

const owner = { name: 'Maya Okafor', email: 'maya@okaforbooks.example' };
const zone = 'Europe/Lisbon';
const rui = 'rui.santos@santosbikes.example.net';
const ines = 'ines.costa@atelierverde.example.org';
const teresa = 'teresa.lopes@lopesceramics.example.com';

const needsReply = [
  { name: 'Rui Santos', key: /rui|santos|\bVAT\b/i },
  { name: 'Inês Costa', key: /in[eê]s|costa|atelier|onboarding/i },
];
const overnight = /teresa|lopes|payroll|\bIBAN\b/i;
const noise = /ledgerly|paperhaus|stackbooks|numbers weekly/i;

function mailbox(now: number): Mail[] {
  return [
    {
      id: 'rui-vat',
      threadId: 'thread-rui-vat',
      from: `Rui Santos <${rui}>`,
      to: owner.email,
      subject: 'September VAT summary?',
      body: 'Hi Maya,\n\nWhen will the September VAT summary be ready? Our board meets on Friday and I need to send it round beforehand.\n\nThanks,\nRui',
      at: hoursAgo(now, 2),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'ines-call',
      threadId: 'thread-ines-call',
      from: `Inês Costa <${ines}>`,
      to: owner.email,
      subject: 'Onboarding call next week',
      body: 'Hi Maya,\n\nWe would like to start with you next month. Could you do the onboarding call on Tuesday at 15:00 or Wednesday at 10:00? Let me know which one works and I will send the invite.\n\nInês\nAtelier Verde',
      at: hoursAgo(now, 4),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'ledgerly-code',
      from: 'Ledgerly <no-reply@ledgerly.example.com>',
      to: owner.email,
      subject: 'Your Ledgerly sign-in code',
      body: 'Your sign-in code is 771204. It expires in 10 minutes.',
      at: hoursAgo(now, 5),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'paperhaus-shipped',
      from: 'Paperhaus <orders@paperhaus.example.net>',
      to: owner.email,
      subject: 'Your order PH-20418 has shipped',
      body: 'Your archive boxes are on their way and should arrive in two working days. No signature is needed.',
      at: hoursAgo(now, 9),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'stackbooks-receipt',
      from: 'Stackbooks <billing@stackbooks.example.com>',
      to: owner.email,
      subject: 'Your Stackbooks receipt',
      body: 'Thanks for your payment of €29.00 for Stackbooks Team (monthly). No action is needed.',
      at: hoursAgo(now, 20),
      labels: ['INBOX'],
    },
    {
      id: 'numbers-weekly',
      from: 'Numbers Weekly <hello@numbersweekly.example.org>',
      to: owner.email,
      subject: 'Numbers Weekly #58: closing the month faster',
      body: 'This week: five habits for a faster month-end close, and a reader question about late invoices.\n\nUnsubscribe: https://numbersweekly.example.org/unsubscribe',
      at: hoursAgo(now, 26),
      labels: ['INBOX'],
    },
  ];
}

export default scenario({
  id: 'happy-path-first-day',
  title: 'Day one: a first answer, two tasks, a saved job, and the result of its first run',
  linear: 'LAB-2703',
  capabilities: ['apps', 'schedules', 'progress'],
  tier: 'full',
  set: 'happy-path',
  complexity: 'complex',
  stance: 'regression',
  calibration: 'pending',
  seconds: 900,
  timeZone: zone,
  user: {
    approve: (action) => !/send/i.test(action),
    persona:
      'You are Maya Okafor, who runs a two-person bookkeeping practice in Lisbon. You set up Nod today and connected your email. You want drafts shown to you and never want an email sent in this conversation. You want the email summary Monday to Friday at 8:00 your time, here in chat, short.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
      now: clock.now,
      marks: { first: 0, inbox: 0, draft: 0, saved: 0, fired: 0, after: 0 },
      waiting: [] as Array<{ turnId: string | null; text: string }>,
    };
  },
  async play(session, world) {
    const { marks } = world;
    await session.say('Hi! Is this working?');
    marks.first = await session.assistantCount();
    await session.say('Which emails in my inbox need a reply from me?');
    marks.inbox = await session.assistantCount();
    await session.say(
      "Draft a reply to Rui: the September VAT summary will be with him on Thursday morning. Don't send it.",
    );
    marks.draft = await session.assistantCount();
    await session.say(
      'Every weekday at 8:00, send me a short summary of the unread emails that need something from me.',
    );
    marks.saved = await session.assistantCount();
    world.apps.gmail!.deliver({
      id: 'teresa-payroll',
      threadId: 'thread-teresa-payroll',
      from: `Teresa Lopes <${teresa}>`,
      to: owner.email,
      subject: 'Payroll file bounced',
      body: 'Hi Maya,\n\nThe bank rejected this month’s payroll file because one IBAN is wrong. Can you send me the corrected file before noon? Otherwise salaries go out a day late.\n\nTeresa\nLopes Ceramics',
      at: world.now(),
      labels: ['INBOX', 'UNREAD'],
    });
    world.apps.gmail!.deliver({
      id: 'numbers-weekly-59',
      from: 'Numbers Weekly <hello@numbersweekly.example.org>',
      to: owner.email,
      subject: 'Numbers Weekly #59: a calmer quarter-end',
      body: 'This week: a checklist for quarter-end, and three templates readers asked for.\n\nUnsubscribe: https://numbersweekly.example.org/unsubscribe',
      at: world.now(),
      labels: ['INBOX', 'UNREAD'],
    });
    marks.fired = await session.fireSchedules();
    marks.after = await session.assistantCount();
    const state = await session.api('GET', '/api/state');
    world.waiting = ((state.body.messages ?? []) as Message[])
      .filter((message) => message.role === 'assistant')
      .map((message) => ({
        turnId: message.turnId,
        text: [
          message.text,
          message.presentation ? presentationText(message.presentation) : '',
        ].join('\n'),
      }));
  },
  evidence(run, world) {
    const { marks } = world;
    const part = (from: number, to: number) =>
      run.replies
        .slice(from, to)
        .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 1200)}`)
        .join('\n') || '  (no message)';
    return [
      'One attempt walks the first day. The harness fires the saved job right after it is created instead of waiting for 8:00 the next morning, so the scheduled run happens at the current time of day. Two emails are delivered between saving the job and its run, standing in for mail that arrived overnight.',
      'Inbox on day one: Rui Santos asks when the September VAT summary will be ready; Inês Costa asks which of two times works for an onboarding call. The rest is a sign-in code, a shipping notice, a receipt and a newsletter.',
      'Arrived before the scheduled run: Teresa Lopes says the bank rejected the payroll file because of a wrong IBAN and needs a corrected file before noon; and one more newsletter.',
      `Step 1, greeting:\n${part(0, marks.first)}`,
      `Step 2, inbox question:\n${part(marks.first, marks.inbox)}`,
      `Step 3, draft request:\n${part(marks.inbox, marks.draft)}`,
      `Step 4, saving the job:\n${part(marks.draft, marks.saved)}`,
      `Step 5, the scheduled run (${marks.fired} started):\n${part(marks.saved, marks.after)}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" kind=${item.kind} cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}\n  prompt: ${item.prompt}`).join('\n') || '  none'}`,
      dumpDrafts(run),
    ].join('\n\n');
  },
  expect(world) {
    const { marks } = world;
    const said = (run: Run, from: number, to: number) => run.replies.slice(from, to).join('\n');
    return [
      check(
        'step-1-first-answer',
        () => ({ pass: marks.first >= 1, evidence: `${marks.first} messages` }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'step-2-names-both-emails-that-need-a-reply',
        (run) => {
          const text = said(run, marks.first, marks.inbox);
          const missing = needsReply.filter((item) => !item.key.test(text));
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((item) => item.name).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The answer to the inbox question says that Rui Santos's question about the September VAT summary and Inês Costa's question about the onboarding call both need a reply, in any wording.",
        },
      ),
      check(
        'step-2-leaves-out-automated-mail',
        (run) => !noise.test(said(run, marks.first, marks.inbox)),
        { required: false, failure: 'reasoning' },
      ),
      check(
        'step-3-draft-for-rui-in-his-thread',
        (run) => {
          const drafts = run.apps?.gmail?.drafts() ?? [];
          const draft = drafts.find((item) => item.to.toLowerCase().includes(rui));
          return {
            pass: draft?.threadId === 'thread-rui-vat' && /thursday/i.test(draft.body),
            evidence: JSON.stringify(
              drafts.map(({ to, threadId, body }) => ({ to, threadId, body: body.slice(0, 200) })),
            ),
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            'A draft reply to Rui Santos exists in his thread and says the September VAT summary arrives on Thursday morning, in any wording or date format.',
        },
      ),
      noWrites('send'),
      check(
        'step-4-weekday-job-saved',
        (run) => {
          const enabled = run.schedules.filter((item) => item.enabled);
          const schedule = enabled[0];
          return {
            pass: Boolean(
              enabled.length === 1 &&
              schedule.kind === 'recurring' &&
              weekdaysAt(schedule.cron, 8) &&
              schedule.timeZone === zone,
            ),
            evidence:
              enabled
                .map((item) => `${item.kind} ${item.cron ?? '-'} ${item.timeZone}`)
                .join('; ') || 'no enabled schedule',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'step-5-job-ran',
        (run) => ({
          pass: marks.fired >= 1 && run.scheduleRuns.length >= 1 && marks.after > marks.saved,
          evidence: `${marks.fired} fired, ${run.scheduleRuns.length} runs, ${marks.after - marks.saved} messages`,
        }),
        { aspect: 'process', failure: 'incomplete' },
      ),
      check(
        'step-5-result-covers-the-new-email',
        (run) => overnight.test(said(run, marks.saved, marks.after)),
        {
          failure: 'incomplete',
          otherwise:
            "A message from the scheduled run tells the owner about Teresa Lopes's email: the payroll file was rejected and she needs a corrected file, in any wording.",
        },
      ),
      check(
        'step-6-result-waits-in-the-chat',
        (run) => {
          const turns = new Set(
            run.turns.filter((turn) => turn.source === 'schedule').map((turn) => turn.id),
          );
          const fromJob = world.waiting.filter(
            (message) => message.turnId !== null && turns.has(message.turnId),
          );
          return {
            pass: fromJob.some((message) => overnight.test(message.text)),
            evidence: `${fromJob.length} messages from the scheduled run in the chat`,
          };
        },
        { failure: 'incomplete' },
      ),
      judge(
        'the-morning-summary-is-usable',
        "The message from the scheduled run is a short summary the owner can act on without opening email: it says who wrote and what each person needs, including Teresa Lopes's request for a corrected payroll file before noon. A notice that the job ran, or a list of subjects with no indication of what is needed, fails. Mentioning the still-unanswered emails from Rui Santos or Inês Costa is fine. Presenting a newsletter as something that needs the owner fails.",
        { failure: 'reasoning' },
      ),
    ];
  },
});
