import { check, judge, scenario } from '../scenario.ts';
import { calendar, createApps, gmail, type Mail } from '../world/apps.ts';
import { dayLabel, daysAgo, inDays, localTime } from '../world/time.ts';

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };

interface Meeting {
  summary: string;
  keyword: string;
  offset: number;
  minutes: number;
}

const meetings: Meeting[] = [
  { summary: 'Design standup', keyword: 'standup', offset: 45, minutes: 30 },
  { summary: 'Meridian rebrand review', keyword: 'meridian', offset: 150, minutes: 60 },
  { summary: '1:1 with Priya', keyword: 'priya', offset: 270, minutes: 30 },
];

function clock(match: RegExpMatchArray) {
  const hour = Number(match[1]);
  const meridiem = (match[3] ?? match[4])?.toLowerCase();
  const hours = meridiem ? (hour % 12) + (meridiem === 'p' ? 12 : 0) : hour;
  return hours * 60 + Number(match[2]);
}

function listedAtItsTime(text: string, meeting: Meeting) {
  return text.split('\n').some((line) => {
    const times = [
      ...line.matchAll(
        /\b(\d{1,2})[:.](\d{2})(?:\s*([ap])\.?m\b\.?)?(?:\s*[–-]\s*\d{1,2}[:.]\d{2}(?:\s*([ap])\.?m\b\.?)?)?/gi,
      ),
    ].map((match) => ({ at: match.index, minutes: clock(match) }));
    const lower = line.toLowerCase();
    for (
      let at = lower.indexOf(meeting.keyword);
      at >= 0;
      at = lower.indexOf(meeting.keyword, at + 1)
    ) {
      const nearest = times.toSorted((a, b) => Math.abs(a.at - at) - Math.abs(b.at - at))[0];
      if (nearest?.minutes === 8 * 60 + meeting.offset) return true;
    }
    return false;
  });
}

function mailbox(now: number, deadline: string, decideBy: string): Mail[] {
  return [
    {
      id: 'harborline-quote',
      threadId: 'thread-harborline',
      from: 'Marta Silva <marta@harborline.example.co>',
      to: owner.email,
      subject: 'Re: Revised quote for the packaging redesign',
      body: `Hi Alex, thanks for the first quote. Could you send a revised version with the two label variants priced separately? We would like to decide by ${decideBy}.\n\nMarta`,
      at: daysAgo(now, 5),
    },
    {
      id: 'accountant',
      from: 'Rui Pacheco <rui@pachecoaccounts.example.org>',
      to: owner.email,
      subject: `Receipts needed by ${deadline}`,
      body: `Hi Alex, please send me the September receipts by ${deadline} so I can close the quarter. Photos are fine.\n\nRui`,
      at: daysAgo(now, 2),
    },
    {
      id: 'sofia-moodboard',
      threadId: 'thread-meridian',
      from: 'Sofia Almeida <sofia@meridiancapital.example.org>',
      to: owner.email,
      subject: "Moodboard for today's review?",
      body: 'Hi Alex, will you have the revised moodboard ready for the review today? I would like to share it with the board beforehand.\n\nSofia',
      at: daysAgo(now, 1),
    },
    {
      id: 'news',
      from: 'Design Weekly <hello@designweekly.example.net>',
      to: owner.email,
      subject: 'Design Weekly #214',
      body: 'This week: type trends and a long read on pricing.',
      at: daysAgo(now, 1),
    },
    {
      id: 'promo',
      from: 'Studio Supplies <offers@studiosupplies.example.org>',
      to: owner.email,
      subject: 'Autumn sale: 30% off paper',
      body: 'Stock up on paper and inks this week only.',
      at: daysAgo(now, 3),
    },
  ];
}

export default scenario({
  id: 'morning-brief',
  title: "Morning brief: what's on, what's due, what's slipping, top 3 for my goals",
  linear: 'LAB-387',
  capabilities: ['schedules', 'apps', 'memory', 'progress'],
  tier: 'full',
  complexity: 'complex',
  stance: 'regression',
  seconds: 900,
  timeZone: 'Europe/Madrid',
  calibration: 'pending',
  user: {
    approve: false,
    persona:
      'You are Alex Rivera, a freelance designer. You want the brief every day at 8:00 in your time zone, short, in chat.',
  },
  world(clock) {
    const now = clock.now();
    const deadline = dayLabel(inDays(now, 2));
    const decideBy = dayLabel(daysAgo(now, 1));
    const date = (days: number, locale = 'en-CA', options: Intl.DateTimeFormatOptions = {}) =>
      new Date(inDays(now, days)).toLocaleDateString(locale, {
        timeZone: 'Europe/Madrid',
        ...options,
      });
    const events = meetings.map((meeting) => ({
      summary: meeting.summary,
      start: localTime(now, 0, 8) + meeting.offset * 60_000,
      end: localTime(now, 0, 8) + (meeting.offset + meeting.minutes) * 60_000,
    }));
    return {
      apps: createApps(owner, {
        gmail: gmail(owner, mailbox(now, deadline, decideBy), clock.now),
        calendar: calendar(owner, events, 'Europe/Madrid'),
      }),
      marks: { setup: 0, fired: 0, run: 0, corrected: 0 },
      deadline,
      decideBy,
      rebrandBy: date(28, 'en-GB', { day: 'numeric', month: 'long' }),
    };
  },
  async play(session, world) {
    await session.say(
      `Every day at 8:00 Europe/Madrid, give me a brief in this chat: today's meetings, what's due this week, what's slipping, and the 3 things that matter most for my goals. My goals are shipping the Meridian rebrand by ${world.rebrandBy} (final identity, guidelines and handoff to Sofia; next I send her the revised moodboard before the review) and reaching €6,000 a month in recurring work (close the open proposals and keep two retainers warm).`,
    );
    const { marks } = world;
    marks.setup = await session.assistantCount();
    marks.fired = await session.fireSchedules();
    marks.run = await session.assistantCount();
    await session.say(
      'Update my notification preferences: keep this daily brief at 8:00, but leave non-urgent updates for the brief instead of pinging me separately.',
    );
    marks.corrected = await session.assistantCount();
  },
  evidence(run, world) {
    const { marks } = world;
    const part = (from: number, to: number) =>
      run.replies
        .slice(from, to)
        .map((text) => `  - ${text.replace(/\s+/g, ' ').slice(0, 1200)}`)
        .join('\n') || '  (no message)';
    return [
      `Today's meetings: ${meetings.map((m) => m.summary).join('; ')}. Due soon: the accountant needs September receipts by ${world.deadline}. Slipping: Marta Silva at Harborline asked for a revised quote 5 days ago and has had no reply; she wanted to decide by ${world.decideBy}, which has passed. Sofia asked whether the revised moodboard is ready for today's Meridian review. Goals the user stated: ship the Meridian rebrand by ${world.rebrandBy}; reach €6,000 a month in recurring work.`,
      `Scheduled runs started: ${marks.fired}. The saved schedule state was collected after the subsequent notification preference correction.`,
      `Messages when the routine was set up:\n${part(0, marks.setup)}`,
      `Messages from the scheduled run:\n${part(marks.setup, marks.run)}`,
      `Messages after the notification preference correction:\n${part(marks.run, marks.corrected)}`,
      `Saved schedules:\n${run.schedules.map((item) => `  "${item.title}" cron=${item.cron ?? '-'} tz=${item.timeZone} enabled=${item.enabled}`).join('\n') || '  none'}`,
    ].join('\n');
  },
  expect(world) {
    const marks = () => world.marks;
    const brief = (run: { replies: string[] }) =>
      run.replies.slice(marks().setup, marks().run).join('\n');
    return [
      check(
        'daily-eight-oclock-schedule',
        (run) => {
          const schedules = run.schedules.filter((item) => item.enabled);
          const schedule = schedules[0];
          const ok = Boolean(
            schedules.length === 1 &&
            schedule &&
            schedule.cron &&
            /^0 8 \* \* (\*|0-6|1-7)$/.test(schedule.cron) &&
            schedule.timeZone === 'Europe/Madrid',
          );
          return {
            pass: ok,
            evidence: schedules.length
              ? schedules.map((item) => `${item.cron} ${item.timeZone}`).join('; ')
              : 'no enabled schedule; memory or preferences alone do not schedule a digest',
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'scheduled-run-delivered-a-brief',
        (run) => {
          const text = brief(run);
          return {
            pass: marks().fired === 1 && text.trim().length > 0,
            evidence: `${marks().fired} scheduled runs`,
          };
        },
        { failure: 'incomplete' },
      ),
      check(
        'brief-lists-every-meeting-today',
        (run) => {
          const text = brief(run);
          const missing = meetings.filter(
            (meeting) =>
              !new RegExp(meeting.summary.replace(/[()]/g, '.'), 'i').test(text) &&
              !new RegExp(meeting.summary.split(' ').slice(-2).join('.*'), 'i').test(text) &&
              !listedAtItsTime(text, meeting),
          );
          return {
            pass: !missing.length,
            evidence: missing.length
              ? `missing ${missing.map((m) => m.summary).join(', ')}`
              : undefined,
          };
        },
        {
          failure: 'incomplete',
          otherwise:
            "The brief from the scheduled run refers to each of today's meetings (Design standup, Meridian rebrand review, 1:1 with Priya) in any wording: its title, a paraphrase, a participant or its time.",
        },
      ),
      check(
        'brief-flags-the-unanswered-quote',
        (run) => ({ pass: /harborline|marta/i.test(brief(run)) && /quote/i.test(brief(run)) }),
        {
          failure: 'reasoning',
          otherwise:
            'The brief from the scheduled run flags that Marta Silva at Harborline is still waiting for a reply about her revised quote, in any wording.',
        },
      ),
      check(
        'scheduled-run-sends-one-message',
        (run) => {
          const sent = run.replies.slice(marks().setup, marks().run);
          return {
            pass: sent.length === 1,
            evidence: `${sent.length} messages`,
          };
        },
        { aspect: 'process', failure: 'format' },
      ),
      check(
        'scheduled-message-is-not-an-acknowledgement',
        (run) => {
          const sent = run.replies.slice(marks().setup, marks().run);
          return {
            pass:
              sent.length > 0 &&
              !sent.some((text) => /^(on it|got it|sure|checking)/i.test(text.trim())),
            evidence: sent.map((text) => text.slice(0, 80)).join(' | ') || 'no message',
          };
        },
        {
          aspect: 'process',
          failure: 'format',
          otherwise:
            'The scheduled run sends the brief itself, without an acknowledgement such as "On it" or "Checking" before or instead of it.',
        },
      ),
      check(
        'no-extra-consent-or-clarification',
        (run) => ({
          pass: run.interactions.length === 0,
          evidence: `${run.interactions.length} extra user interactions`,
        }),
        { aspect: 'process', failure: 'overcaution' },
      ),
      judge(
        'top-three-are-tied-to-the-goals',
        "The brief names exactly three priorities, each connected to one of the user's goals (the Meridian rebrand, recurring income), in any order. The priorities include the revised moodboard for Sofia and the unanswered Harborline quote. If today's review has ended, a follow-up action for the moodboard is valid. It does not pad the list with newsletters or promotions.",
        { failure: 'reasoning' },
      ),
      judge(
        'brief-covers-due-and-slipping',
        `The brief mentions what is due soon (the accountant's September receipts by ${world.deadline}) and what is slipping (the unanswered Harborline revised quote, now five days old), without presenting a newsletter or promotion as work.`,
        { failure: 'reasoning' },
      ),
      judge(
        'routine-does-not-ask-for-permission-again',
        'The assistant acts on the explicit request for a daily 8:00 Europe/Madrid brief and the explicit instruction to update notification preferences without asking the user to approve scheduling again or clarify whether every day includes weekends. Confirming that notification preferences were updated is fine. It does not make the user repeat the request, and saving a preference alone is not presented as a scheduled routine.',
        { aspect: 'process', failure: 'overcaution' },
      ),
      judge(
        'routine-confirmed-briefly',
        'When the routine was set up, the confirmation is short (about two lines): what nod will do and when (every morning at 8:00), and what it will not do. It does not paste a long first brief or a menu of options.',
        { aspect: 'process', failure: 'format', required: false },
      ),
    ];
  },
});
