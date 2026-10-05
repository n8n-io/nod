export interface VoiceScenario {
  id: string;
  issue?: string;
  expect?: Array<{ name: string; pattern: string }>;
  maxLines?: number;
  pages?: Record<string, string>;
  title: string;
  good: string;
  prompt: string;
  work?: boolean;
  background?: boolean;
  quiet?: boolean;
  maxWords?: number;
  channel?: string;
  history?: Array<{ role: 'user' | 'assistant'; text: string; hoursAgo: number }>;
  tasks?: Array<{ title: string; now: string; doneWhen: string }>;
  preferences?: string;
  profile?: { name: string; location: string; phone: string; preferences: string };
  memory?: string;
  personalData?: Record<string, unknown>;
  timeZone?: string;
  locale?: string;
  answer?: {
    version: number;
    holdout?: boolean;
    audit?: boolean;
    reads?: string[];
    sourceUrls?: string[];
    reject?: Array<{ name: string; pattern: string }>;
    review: string[];
  };
  apps?: string[];
  data?: Record<string, unknown>;
  search?: Record<string, Array<{ title: string; url: string; snippet: string }>>;
  latencyMs?: number;
}

const inbox = {
  messages: [
    {
      id: 'm1',
      from: 'Tomas Novak <tomas@northwind.example>',
      subject: 'Contract redlines, need your call by Thursday',
      date: 'yesterday 16:40',
      snippet:
        'Legal flagged clause 7.2 (liability cap). Can you confirm whether we accept 1x fees or push for 2x? Need it before Thursday.',
    },
    {
      id: 'm2',
      from: 'Billing <billing@cloudhost.example>',
      subject: 'Payment failed for invoice #4471',
      date: 'today 07:12',
      snippet:
        'We could not charge the card ending 4242 for 312.00 EUR. Service will be suspended on Oct 3 unless updated.',
    },
    {
      id: 'm3',
      from: 'Lena Weiss <lena@studio.example>',
      subject: 'Re: Launch video, v2 cut',
      date: 'today 09:05',
      snippet: 'Uploaded v2. Main question: keep the 20s intro or cut to 8s? Either works for me.',
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      id: `n${index}`,
      from: `Newsletter ${index} <news${index}@example.com>`,
      subject: `Weekly digest #${120 + index}`,
      date: 'this week',
      snippet: 'Top stories this week...',
    })),
  ],
};

const calendar = {
  events: [
    { title: 'Design review: onboarding v3', start: 'tomorrow 10:00', end: '11:00' },
    { title: 'Lunch with Tomas', start: 'tomorrow 12:30', end: '13:30' },
    { title: 'Launch go/no-go', start: 'tomorrow 16:00', end: '16:30', attendees: 7 },
  ],
};

const launchTask = {
  title: 'Launch Beacon beta to first 50 users',
  now: 'Finishing the onboarding flow and picking the 50 users',
  doneWhen:
    'Beacon, an open source meeting-notes agent, is live for 50 waitlist users with the launch post out on Oct 14.',
};

export const scenarios: VoiceScenario[] = [
  {
    id: 'quick-answer',
    title: 'Quick question, no tools',
    good: 'Answers in one line. No acknowledgement, no preamble, no offer of more help.',
    prompt: 'whats 18% of 240 eur',
    maxWords: 25,
  },
  {
    id: 'inbox-triage',
    title: 'Real work: triage the inbox',
    good: 'First message lands before any tool call and names the first step ("Checking your inbox now, starting with anything waiting on you."). Result leads with the 2-3 things that need a decision, in short bubbles, then one next step.',
    prompt: 'can you go through my inbox and tell me what actually needs me today',
    work: true,
    apps: ['gmail'],
    data: { GMAIL: inbox },
    latencyMs: 4000,
  },
  {
    id: 'research',
    title: 'Longer research task',
    good: 'Acknowledges with the plan in one line, then silence or one real update, then a short answer: the verdict first, detail after. No wall of text.',
    prompt:
      'look up how Viktor and Lindy price their plans and tell me what the real difference is for a team of 5',
    work: true,
    search: {
      viktor: [
        {
          title: 'Viktor pricing',
          url: 'https://viktor.example/pricing',
          snippet:
            'Starter free with 100 credits. Team 49 USD per seat per month, 16,000 credits pooled. Card check of 1 USD at signup.',
        },
      ],
      lindy: [
        {
          title: 'Lindy pricing',
          url: 'https://lindy.example/pricing',
          snippet:
            'Pro 29.99 USD per month per user after 7 day trial, 5,000 tasks. Business 299 USD per month for up to 10 users, shared credits.',
        },
      ],
    },
    latencyMs: 5000,
  },
  {
    id: 'vague-with-context',
    title: 'Vague ask, context already known',
    good: 'Uses the open task instead of asking what the launch is. Proposes one concrete move and asks at most one question.',
    prompt: 'help me with the launch',
    work: true,
    tasks: [launchTask],
    apps: ['gmail', 'googlecalendar'],
    data: { GMAIL: inbox, GOOGLECALENDAR: calendar },
  },
  {
    id: 'chit-chat',
    title: 'User is just chatting',
    good: 'Short and human, like a colleague. Does not offer more help or list what it can do.',
    prompt: 'haha nice, that saved me an hour honestly',
    history: [
      { role: 'user', text: 'draft a reply to Lena saying we cut the intro to 8s', hoursAgo: 0.2 },
      {
        role: 'assistant',
        text: 'Drafted in Gmail: "Hi Lena, let\'s go with the 8s intro. Thanks for the quick v2!" Want me to send it?',
        hoursAgo: 0.19,
      },
      { role: 'user', text: 'yes send', hoursAgo: 0.1 },
      { role: 'assistant', text: 'Sent.', hoursAgo: 0.09 },
    ],
    maxWords: 20,
  },
  {
    id: 'blocked',
    title: 'Blocked: app not connected',
    good: 'Says what is missing and the single next step in a sentence or two. No troubleshooting guide.',
    prompt: 'reply to everyone waiting on me in slack',
    work: true,
    apps: [],
    maxWords: 45,
  },
  {
    id: 'what-can-you-do',
    title: '"What can you do?"',
    good: 'Two or three offers grounded in what it can see (tasks, inbox, calendar), not a capability catalogue. Ends with one easy question.',
    prompt: 'what can u do for me',
    tasks: [launchTask],
    apps: ['gmail', 'googlecalendar'],
    data: { GMAIL: inbox, GOOGLECALENDAR: calendar },
    maxWords: 80,
  },
  {
    id: 'casual-calendar',
    title: 'Casual register, quick lookup',
    good: 'Mirrors the lowercase, casual tone. Short ack, then tomorrow in two or three lines.',
    prompt: 'yo anything important on my cal tmrw?',
    work: true,
    apps: ['googlecalendar'],
    data: { GOOGLECALENDAR: calendar },
    latencyMs: 3000,
  },
  {
    id: 'nudge-useful',
    title: 'Background: one useful nudge',
    good: 'One short message grounded in the event, with the concrete offer, easy to wave off. No greeting, no recap.',
    prompt:
      'Event wake from gmail: new email "Payment failed for invoice #4471" from billing@cloudhost.example. Service suspended on Oct 3 unless the card is updated. Work quietly; send a concise message only when there is a useful result or necessary question.',
    background: true,
    apps: ['gmail'],
    data: { GMAIL: inbox },
    maxWords: 50,
  },
  {
    id: 'nudge-ignored',
    title: 'Background: user has ignored the last pings',
    good: 'Sends nothing for a low-value update, or one short line offering to go quieter (like Viktor: "Slack has been quiet since Thursday, switch to weekly?").',
    prompt:
      'Heartbeat review: check current context and saved updates. New since last review: 2 newsletters, a calendar invite for a webinar next month. Work quietly; send a concise message only when there is a useful result or necessary question.',
    background: true,
    quiet: true,
    tasks: [launchTask],
    apps: ['gmail', 'googlecalendar'],
    data: {
      GMAIL: { messages: inbox.messages.slice(3, 5) },
      GOOGLECALENDAR: {
        events: [{ title: 'Webinar: AI agents in ops (invite)', start: 'in 5 weeks, 16:00' }],
      },
    },
    history: [
      { role: 'user', text: 'thanks', hoursAgo: 100 },
      {
        role: 'assistant',
        text: 'Three people on the waitlist replied to your launch email. Want me to add them to the first 50?',
        hoursAgo: 76,
      },
      {
        role: 'assistant',
        text: 'Your design review moved to Thursday 10:00. Want me to prep the notes?',
        hoursAgo: 52,
      },
      {
        role: 'assistant',
        text: 'Found two competitors launching this week. Want a quick comparison?',
        hoursAgo: 26,
      },
    ],
    maxWords: 40,
  },
];

const answerProfile = {
  name: 'Maya Horak',
  location: 'Prague',
  phone: '',
  preferences: 'Concise replies. Use EUR and metric units.',
};

const workMemory = {
  path: 'about/work',
  text: 'Maya is a product designer at Beacon Studio.',
  status: 'stated',
};

const preferenceMemory = {
  path: 'preferences/meetings',
  text: 'Maya prefers meetings after 10:00 and keeps Friday afternoons free.',
  status: 'stated',
};

const answerReview = [
  'The answer directly resolves the question with supported facts, without unnecessary setup questions.',
  'No unsolicited tool names, access routes, file paths, read counts or memory-search receipts appear.',
  'Source links support the adjacent claims; material uncertainty stays visible without generic disclaimers.',
];

export const answerScenarios: VoiceScenario[] = [
  {
    id: 'answer-profile',
    title: 'Saved profile and remembered work',
    prompt: 'What do you know about me?',
    good: 'Names Maya, Prague and her product-design work at Beacon Studio. Does not append a profile or memory-search receipt.',
    profile: answerProfile,
    memory: JSON.stringify({ about: ['work'] }),
    personalData: { memory_find: [workMemory], memory_read: workMemory },
    maxWords: 100,
    expect: [
      { name: 'knowsName', pattern: 'Maya' },
      { name: 'knowsLocation', pattern: 'Prague' },
      { name: 'knowsWork', pattern: 'product designer|product design' },
      { name: 'knowsEmployer', pattern: 'Beacon Studio' },
    ],
    answer: { version: 1, reads: ['memory_(find|read)'], review: answerReview },
  },
  {
    id: 'answer-preferences',
    title: 'Preferences without bookkeeping',
    prompt: 'What preferences have I asked you to remember?',
    good: 'Summarizes concise replies, EUR, metric units and meeting preferences. Does not count saved records or searches.',
    profile: answerProfile,
    memory: JSON.stringify({ preferences: ['meetings'] }),
    personalData: { memory_find: [preferenceMemory], memory_read: preferenceMemory },
    maxWords: 100,
    expect: [
      { name: 'concise', pattern: 'concise|short|brief' },
      { name: 'units', pattern: 'metric' },
      { name: 'currency', pattern: 'EUR|euros?|€' },
      { name: 'meetingTime', pattern: '10(?::00)?|ten' },
      { name: 'fridayFree', pattern: 'Friday' },
    ],
    answer: { version: 1, reads: ['memory_(find|read)'], review: answerReview },
  },
  {
    id: 'answer-schedules',
    title: 'Active and paused schedules',
    prompt: 'Which reminders are active, and when do they run?',
    good: 'Reports the active weekday standup reminder at 09:15 Europe/Prague and identifies the invoice review as paused.',
    personalData: {
      schedule_list: [
        {
          id: 'fixture-standup',
          title: 'Standup reminder',
          kind: 'recurring',
          cron: '15 9 * * 1-5',
          timeZone: 'Europe/Prague',
          enabled: true,
        },
        {
          id: 'fixture-invoices',
          title: 'Invoice review',
          kind: 'recurring',
          cron: '0 16 * * 5',
          timeZone: 'Europe/Prague',
          enabled: false,
        },
      ],
    },
    expect: [
      { name: 'activeReminder', pattern: 'standup' },
      { name: 'time', pattern: '0?9:15|9[.]15' },
      { name: 'weekdays', pattern: 'weekday|Monday.{0,20}Friday|Mon.{0,12}Fri' },
      { name: 'paused', pattern: 'paused|inactive|disabled|off' },
    ],
    answer: {
      version: 1,
      reads: ['schedule_list'],
      review: [
        ...answerReview,
        'The paused invoice review is not presented as active; local schedule time and zone are accurate.',
      ],
    },
  },
  {
    id: 'answer-inbox',
    title: 'Actionable inbox summary with a source link',
    prompt: 'What in my inbox needs a decision from me?',
    good: 'Leads with approving the Atlas print proof by 16:00 on 5 October, links the message and does not report how many emails were read or skipped.',
    apps: ['gmail'],
    data: {
      GMAIL: {
        messages: [
          {
            id: 'atlas-proof',
            from: 'Leah <leah@atlas.example>',
            subject: 'Approve the Atlas print proof',
            snippet:
              'Please approve the blue cover by 2026-10-05 16:00 Europe/Prague so we can print.',
            link: 'https://mail.example/messages/atlas-proof',
          },
          {
            id: 'digest',
            from: 'Digest <digest@example.com>',
            subject: 'Monthly design digest',
            snippet: 'News and inspiration. No action needed.',
          },
        ],
      },
    },
    maxWords: 90,
    expect: [
      { name: 'decision', pattern: 'approv' },
      { name: 'project', pattern: 'Atlas' },
      { name: 'deadline', pattern: '16:00|4(?::00)?\\s*p\\.?m' },
    ],
    answer: {
      version: 1,
      reads: ['GMAIL_FETCH_EMAILS'],
      sourceUrls: ['https://mail.example/messages/atlas-proof'],
      review: answerReview,
    },
  },
  {
    id: 'answer-calendar',
    title: 'Calendar answer with preparation detail',
    prompt: 'What is my first meeting on 5 October 2026, and what should I bring?',
    good: 'Names Atlas design review at 10:30 Europe/Prague, asks her to bring the revised blue-cover mockup, and links the event.',
    apps: ['googlecalendar'],
    data: {
      GOOGLECALENDAR: {
        events: [
          {
            id: 'atlas-review',
            title: 'Atlas design review',
            start: '2026-10-05T10:30:00+02:00',
            end: '2026-10-05T11:00:00+02:00',
            timeZone: 'Europe/Prague',
            description: 'Bring the revised blue-cover mockup.',
            htmlLink: 'https://calendar.example/events/atlas-review',
          },
          {
            id: 'team-sync',
            title: 'Team sync',
            start: '2026-10-05T14:00:00+02:00',
            end: '2026-10-05T14:30:00+02:00',
          },
        ],
      },
    },
    expect: [
      { name: 'firstMeeting', pattern: 'Atlas' },
      { name: 'startTime', pattern: '10:30' },
      { name: 'preparation', pattern: 'blue.{0,15}cover|mockup' },
    ],
    answer: {
      version: 1,
      reads: ['GOOGLECALENDAR_EVENTS_LIST'],
      sourceUrls: ['https://calendar.example/events/atlas-review'],
      review: answerReview,
    },
  },
  {
    id: 'answer-unavailable',
    title: 'Unavailable inbox remains unknown',
    prompt: 'Has Leah replied to my Atlas proof email?',
    apps: ['gmail'],
    data: {
      GMAIL: {
        status: 'unavailable',
        message: 'The mailbox read timed out. No messages were returned.',
      },
    },
    good: 'Says the mailbox could not be checked and the reply is unconfirmed. Does not turn a failed read into an empty inbox or a yes/no answer.',
    expect: [
      {
        name: 'honestLimitation',
        pattern: 'couldn.t|can.t|unable|unavailable|timed out|could not|cannot|unconfirmed|can not',
      },
    ],
    answer: {
      version: 1,
      reads: ['GMAIL_FETCH_EMAILS'],
      reject: [
        {
          name: 'noUnsupportedNegative',
          pattern:
            "Leah (?:has not|hasn't|did not|didn't) repl(?:y|ied)|no reply (?:from Leah|yet)|inbox is empty",
        },
      ],
      review: [
        ...answerReview,
        'No claim about whether Leah replied is inferred from the unavailable mailbox; any next step is proportionate.',
      ],
    },
  },
  {
    id: 'answer-audit',
    title: 'Explicit source audit',
    prompt:
      'How do you know my meeting preferences? Tell me which saved sources you checked and how many.',
    profile: answerProfile,
    memory: JSON.stringify({ preferences: ['meetings'] }),
    personalData: { memory_find: [preferenceMemory], memory_read: preferenceMemory },
    good: 'Answers the meeting-preference question and explains the saved source and count, matching the actual trace. Requested audit detail is allowed.',
    maxWords: 130,
    expect: [
      { name: 'meetingPreference', pattern: 'Friday|10(?::00)?' },
      { name: 'sourceExplanation', pattern: 'saved|remember|memory|preference' },
      { name: 'requestedCount', pattern: '\\b(?:1|2|3|one|two|three)\\b' },
    ],
    answer: {
      version: 1,
      audit: true,
      reads: ['memory_(find|read)'],
      review: [
        'Meeting preferences match the saved source.',
        'Reported sources and counts distinguish the supplied profile, memory entries and tool calls, matching the recorded trace.',
        'Requested provenance is answered directly without fabricated checks or a refusal to explain.',
      ],
    },
  },
  {
    id: 'answer-profile-pt',
    title: 'Holdout: Portuguese profile with an unconfirmed change',
    prompt: 'O que sabes sobre mim e sobre onde trabalho?',
    profile: {
      name: 'Inês Duarte',
      location: 'Coimbra',
      phone: '',
      preferences: 'Português europeu. Respostas curtas.',
    },
    timeZone: 'Europe/Lisbon',
    locale: 'pt-PT',
    memory: JSON.stringify({ about: ['work', 'possible-move'] }),
    personalData: {
      memory_find: [
        {
          path: 'about/work',
          text: 'Inês trabalha como designer na Maré Studio.',
          status: 'stated',
        },
        {
          path: 'about/possible-move',
          text: 'Inês está a ponderar mudar-se para o Porto. Ainda não decidiu.',
          status: 'tentative',
        },
      ],
      memory_read: {
        path: 'about',
        entries: [
          {
            path: 'about/work',
            text: 'Inês trabalha como designer na Maré Studio.',
            status: 'stated',
          },
          {
            path: 'about/possible-move',
            text: 'Inês está a ponderar mudar-se para o Porto. Ainda não decidiu.',
            status: 'tentative',
          },
        ],
      },
    },
    maxWords: 100,
    good: 'Answers in European Portuguese: Inês, Coimbra, designer at Maré Studio. A possible move to Porto stays tentative or is omitted; no internal receipts.',
    expect: [
      { name: 'name', pattern: 'Inês' },
      { name: 'location', pattern: 'Coimbra' },
      { name: 'work', pattern: 'Maré Studio' },
    ],
    answer: {
      version: 1,
      holdout: true,
      reads: ['memory_(find|read)'],
      review: [
        ...answerReview,
        'The reply is European Portuguese and does not claim the tentative move to Porto happened.',
      ],
    },
  },
];
