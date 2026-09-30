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
  goals?: Array<{ title: string; description: string; nextAction: string }>;
  preferences?: string;
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

const launchGoal = {
  title: 'Launch Beacon beta to first 50 users',
  description:
    'Beacon is an open source meeting-notes agent. Beta goes to 50 users from the waitlist; launch post on Oct 14.',
  nextAction: 'Finish onboarding flow and pick the 50 users',
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
    good: 'Uses the saved goal instead of asking what the launch is. Proposes one concrete move and asks at most one question.',
    prompt: 'help me with the launch',
    work: true,
    goals: [launchGoal],
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
    good: 'Two or three offers grounded in what it can see (goal, inbox, calendar), not a capability catalogue. Ends with one easy question.',
    prompt: 'what can u do for me',
    goals: [launchGoal],
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
      'Heartbeat review: check active goals and saved updates. New since last review: 2 newsletters, a calendar invite for a webinar next month. Work quietly; send a concise message only when there is a useful result or necessary question.',
    background: true,
    quiet: true,
    goals: [launchGoal],
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
