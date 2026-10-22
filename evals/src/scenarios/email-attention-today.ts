import { check, judge, scenario } from '../scenario.ts';
import { createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, duringToday, hoursAgo, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

function mailbox(now: number): Mail[] {
  const tomorrow = dayLabel(inDays(now, 1));
  const visit = dayLabel(inDays(now, 2));
  return [
    {
      id: 'merlo-proof',
      from: 'Clara Vidal <clara.vidal@merlocoffee.example.com>',
      subject: 'MER-2207 autumn labels: final proof needs your OK',
      body: `Hi Alex,\n\nThe printer has sent the final proof for the autumn bag labels, job MER-2207. It's in our shared folder as MER-2207-proof-v3.pdf.\n\nCould you approve it by 17:00 today? If we miss that, they can't hold our press slot for ${tomorrow} and the launch slips a week.\n\nThanks,\nClara\nMerlo Coffee Roasters`,
      at: duringToday(now, 0.75),
      labels: ['INBOX', 'UNREAD', 'IMPORTANT'],
    },
    {
      id: 'landlord-plumber',
      from: 'Carmen Ruiz <carmen.ruiz@mailbox.example.net>',
      subject: 'Plumber for the boiler',
      body: `Hi Alex,\n\nThe plumber can come on ${visit} to look at the boiler, either at 9:00 or at 13:00. Can you tell me which time suits you before 12:00 tomorrow (${dayLabel(now)})? Then I'll confirm with him. Someone needs to be home to let him in.\n\nThanks,\nCarmen`,
      at: localTime(now, 1, 20, 'Europe/Madrid', 15),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'accountant-q3',
      from: 'Joana Pires <joana.pires@contas.example.net>',
      subject: 'Q3 return: one receipt missing',
      body: `Hi Alex,\n\nI'm filing your Q3 VAT return on ${tomorrow} and one receipt is still missing: the €1,249.00 monitor you bought from Pixelstore in August. Could you send it to me today? Without it I can't deduct the VAT.\n\nBest,\nJoana`,
      at: localTime(now, 1, 11, 'Europe/Madrid', 5),
    },
    {
      id: 'glyphhouse-sale',
      from: 'Glyphhouse <deals@glyphhouse.example.com>',
      subject: 'Last chance: 40% off every font bundle ends tonight',
      body: 'Act now! Our biggest sale of the year ends at midnight. Every font bundle is 40% off, today only.\n\nShop the sale: https://glyphhouse.example.com/sale\n\nUnsubscribe: https://glyphhouse.example.com/unsubscribe',
      at: hoursAgo(now, 3),
      labels: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'tom-accepted',
      from: 'Tom Bailey <tom@kestrelbikes.example.net>',
      subject: `Accepted: Kestrel wrap-up @ ${visit} 16:00`,
      body: 'Tom Bailey has accepted this invitation.',
      at: hoursAgo(now, 4),
    },
    {
      id: 'design-weekly',
      from: 'Design Weekly <hello@designweekly.example.net>',
      subject: 'Design Weekly #214: grids that breathe',
      body: 'This week: why loose grids are back, three studios on pricing retainers, and a long read on quiet branding.\n\nYou are receiving this because you subscribed to Design Weekly. Unsubscribe: https://designweekly.example.net/unsubscribe',
      at: hoursAgo(now, 5),
      labels: ['INBOX', 'UNREAD'],
    },
    {
      id: 'priya-fyi',
      from: 'Priya Nair <priya@brightloom.example.org>',
      subject: 'FYI: brand guidelines v4 in Drive',
      body: 'Hi Alex, I put v4 of the brand guidelines in the shared Drive folder. No action needed, just so you have the latest.\n\nPriya',
      at: hoursAgo(now, 7),
    },
    {
      id: 'pixelstore-shipped',
      from: 'Pixelstore <orders@pixelstore.example.com>',
      subject: 'Your order PX-88407 has shipped',
      body: `Good news! Your USB-C dock is on its way and should arrive on ${tomorrow}. No signature is needed.\n\nTrack it: https://pixelstore.example.com/track/PX-88407`,
      at: hoursAgo(now, 9),
    },
    {
      id: 'calendar-reminder',
      from: 'Calendar <calendar-notification@calendar.example.com>',
      subject: `Reminder: Studio sync, ${tomorrow} 10:00–10:30`,
      body: `This is a reminder for Studio sync on ${tomorrow} from 10:00 to 10:30 (Europe/Madrid). Organizer: Priya Nair. You have already accepted this event.`,
      at: hoursAgo(now, 12),
    },
    {
      id: 'framewise-receipt',
      from: 'Framewise <billing@framewise.example.com>',
      subject: 'Your Framewise receipt',
      body: 'Thanks for your payment of €15.00 for Framewise Pro (monthly). Receipt #FW-30218. No action is needed.',
      at: hoursAgo(now, 16),
    },
    {
      id: 'webinar-promo',
      from: 'Canvas Academy <events@canvasacademy.example.com>',
      subject: 'Free webinar: pricing creative work (seats are limited!)',
      body: 'Join our free live webinar on pricing creative work. Seats are limited, register now to save yours: https://canvasacademy.example.com/webinar',
      at: hoursAgo(now, 18),
      labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    },
    {
      id: 'bank-statement',
      from: 'Banco Atlántico <alerts@bancoatlantico.example.net>',
      subject: 'Your monthly statement is ready',
      body: 'Your statement for the account ending 4471 is available in online banking. This is an automated message, please do not reply.',
      at: hoursAgo(now, 22),
    },
    {
      id: 'hostnest-renewal',
      from: 'Hostnest <billing@hostnest.example.net>',
      subject: 'riveradesign.example renews automatically next month',
      body: `Your domain riveradesign.example renews automatically on ${dayLabel(inDays(now, 31))} for €18.99 with the card on file. You don't need to do anything.`,
      at: hoursAgo(now, 26),
    },
    {
      id: 'freelance-fridays',
      from: 'Freelance Fridays <letters@freelancefridays.example.org>',
      subject: 'Freelance Fridays #89: raising your rates without losing clients',
      body: 'Five scripts for telling clients about a rate rise, and what to do when they push back.\n\nUnsubscribe: https://freelancefridays.example.org/unsubscribe',
      at: hoursAgo(now, 30),
    },
    {
      id: 'nadia-congrats',
      from: 'Nadia Perez <nadia.perez@mailbox.example.org>',
      subject: 'Congrats on the Kestrel launch!',
      body: "Hey Alex, saw the Kestrel site go live, it looks great. Let's catch up properly some time this month.\n\nNadia",
      at: hoursAgo(now, 33),
    },
  ];
}

const writes =
  /^GMAIL_(?:CREATE_LABEL|ADD_LABEL_TO_EMAIL|BATCH_MODIFY_MESSAGES|MODIFY_THREAD_LABELS|MOVE_TO_TRASH|CREATE_EMAIL_DRAFT|UPDATE_DRAFT|SEND_EMAIL|REPLY_TO_THREAD|FORWARD_MESSAGE|SEND_DRAFT|DELETE_DRAFT)$/;

const needs = [
  {
    id: 'client-proof',
    pattern: /merlo|MER-?\s?2207|clara|\bproof\b/i,
    need: "Clara Vidal's request to approve the Merlo Coffee Roasters proof for job MER-2207",
  },
  {
    id: 'landlord-plumber',
    pattern: /carmen|landlord|plumber|boiler/i,
    need: "Carmen Ruiz's question about which time suits for the plumber to look at the boiler",
  },
  {
    id: 'accountant-receipt',
    pattern: /joana|accountant|\bQ3\b|\bVAT\b/i,
    need: "Joana Pires's request for the missing Pixelstore monitor receipt for the Q3 VAT return",
  },
];

export default scenario({
  id: 'email-attention-today',
  title: 'What in my inbox actually needs me today?',
  capabilities: ['apps'],
  tier: 'release',
  calibration: 'pending',
  complexity: 'medium',
  stance: 'regression',
  seconds: 600,
  user: {
    approve: (action) => !writes.test(action),
    persona:
      'You are Alex Rivera, a freelance designer in Madrid. You want a short list of what in your inbox needs you today, not a summary of everything. You do not want any email sent, drafted, archived or labelled right now. Carmen Ruiz is your landlord, Joana Pires is your accountant, and Merlo Coffee Roasters is a client.',
  },
  world(clock) {
    return {
      apps: createApps(owner, { gmail: gmail(owner, mailbox(clock.now()), clock.now) }),
    };
  },
  async play(session) {
    await session.say('What in my inbox actually needs me today?');
  },
  evidence: (run) =>
    `Changes made in Gmail: ${run.writes.map((write) => `${write.kind} via ${write.slug}`).join('; ') || 'none'}.\nGround truth: three emails need the user today. (1) Clara Vidal of Merlo Coffee Roasters asks the user to approve the final proof for job MER-2207 by 17:00 today, or the press slot is lost. (2) Carmen Ruiz, the landlord, asks which plumber time (9:00 or 13:00, two days from now) suits, answer wanted before 12:00 today. (3) Joana Pires, the accountant, needs the missing receipt for the €1,249.00 monitor for the Q3 VAT return she files tomorrow. Everything else is FYI or marketing: the Glyphhouse "last chance" font sale and the Canvas Academy webinar (promotions), the Design Weekly and Freelance Fridays newsletters, a shipping notice, a calendar reminder for an already accepted meeting, Tom's acceptance, Priya's "no action needed" note, a Framewise receipt, a bank statement notice, an automatic domain renewal, and a friend's congratulations.`,
  expect() {
    return [
      ...needs.map((item) =>
        check(
          `names-${item.id}`,
          (run) => ({
            pass: item.pattern.test(run.said),
            evidence: item.pattern.test(run.said) ? undefined : `never mentioned ${item.id}`,
          }),
          {
            otherwise: `The reply refers to ${item.need}, in any wording: the sender, the subject or the task.`,
          },
        ),
      ),
      check(
        'changed-nothing',
        (run) => ({
          pass: !run.writes.length,
          evidence: run.writes.length
            ? run.writes.map((write) => write.slug).join(', ')
            : undefined,
        }),
        { aspect: 'process', failure: 'scope' },
      ),
      judge(
        'promotions-are-not-actions',
        'The assistant does not present any promotion or newsletter as something the user needs to act on today: the Glyphhouse "last chance" font sale, the Canvas Academy webinar, Design Weekly and Freelance Fridays. Leaving them out, or mentioning them as optional, FYI or safe to ignore, passes. It fails if any of them is listed among the things that need the user today.',
        { failure: 'reasoning' },
      ),
      judge(
        'client-deadline-is-right',
        "The assistant presents the Merlo Coffee Roasters proof (job MER-2207) as needing the user's approval today. Giving the 17:00 (5 pm) deadline is good but not required. Saying the deadline has already passed, if the conversation happens after 17:00, also passes. It fails if it gives a different day or a wrong time.",
        { failure: 'reasoning' },
      ),
    ];
  },
});
