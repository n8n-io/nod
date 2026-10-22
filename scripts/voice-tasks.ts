import type { VoiceScenario } from './voice-scenarios.ts';

const said = (name: string, pattern: string) => ({ name, pattern });
const slack = {
  SLACK_LIST_CONVERSATIONS: {
    channels: [
      { id: 'C1', name: 'n8n-labs' },
      { id: 'D1', name: 'dm-albert' },
      { id: 'D2', name: 'dm-david' },
    ],
  },
  SLACK_FETCH_CONVERSATION_HISTORY: {
    note: 'Messages since yesterday 18:00 across requested conversations',
    messages: [
      {
        channel: '#n8n-labs',
        user: 'Filipe',
        ts: 'yesterday 18:40',
        text: 'Vault 2FA flow merged, PostHog test next',
        reply_count: 3,
        permalink: 'https://slack.example/p1',
      },
      {
        channel: '#n8n-labs',
        user: 'Albert',
        ts: 'yesterday 19:05',
        text: 'YouTube task passes on default model now (yt-dlp PR #56)',
        permalink: 'https://slack.example/p2',
      },
      {
        channel: '#n8n-labs',
        user: 'David',
        ts: 'today 08:10',
        text: 'Reminder: capability review Friday 14:00',
        reply_count: 2,
        permalink: 'https://slack.example/p3',
      },
      ...Array.from({ length: 8 }, (_, index) => ({
        channel: '#n8n-labs',
        user: ['Jan', 'Filipe', 'Albert'][index % 3],
        ts: 'today',
        text: `standup note ${index + 1}`,
        permalink: `https://slack.example/n${index}`,
      })),
      {
        channel: 'DM Albert',
        user: 'Albert',
        ts: 'today 09:30',
        text: 'PR #47 is ready for your review when you have a sec',
        permalink: 'https://slack.example/d1',
      },
      {
        channel: 'DM David',
        user: 'David',
        ts: 'today 11:02',
        text: 'lunch at 13?',
        permalink: 'https://slack.example/d2',
      },
    ],
  },
  SLACK_FETCH_MESSAGE_THREAD: {
    replies: [
      {
        parent: 'https://slack.example/p1',
        user: 'Filipe',
        text: '@maya can you confirm we demo the vault flow on Friday? I need to know by tomorrow',
        permalink: 'https://slack.example/p1r1',
      },
      {
        parent: 'https://slack.example/p1',
        user: 'Jan',
        text: 'nice work',
        permalink: 'https://slack.example/p1r2',
      },
      {
        parent: 'https://slack.example/p3',
        user: 'Jan',
        text: 'I will bring the Reddit numbers',
        permalink: 'https://slack.example/p3r1',
      },
    ],
  },
};

const newEmails = {
  messages: [
    {
      id: 'e1',
      from: 'Clara Diaz <clara@northwind.example>',
      subject: 'Question about the pilot scope',
      snippet:
        'Does the pilot include the Slack connector, or only Gmail? We need to tell legal by Friday.',
    },
    {
      id: 'e2',
      from: 'Ben Okafor <ben@acme.example>',
      subject: 'Meeting next week?',
      snippet:
        'Could we do 30 minutes next Tuesday or Wednesday afternoon to go through the roadmap?',
    },
    {
      id: 'e3',
      from: 'The Batch <news@batch.example>',
      subject: 'This week in AI',
      snippet: 'Top stories...',
    },
    {
      id: 'e4',
      from: 'GitHub <noreply@github.example>',
      subject: '[nod] CI passed on main',
      snippet: 'All checks have passed',
    },
    {
      id: 'e5',
      from: 'Lena Weiss <lena@studio.example>',
      subject: 'FYI: final video exported',
      snippet: 'No action needed, just letting you know the final cut is in the shared folder.',
    },
  ],
  sentSamples: [
    'Hi Tomas, sounds good, let us do Thursday. Maya',
    'Thanks Ben! Will check and revert today. M',
  ],
};

const invoices = {
  messages: [
    {
      id: 'i1',
      from: 'maya@beacon.example',
      to: 'ops@lumen.example',
      subject: 'Invoice #2026-031 Lumen GmbH',
      snippet: 'Amount 1,200.00 EUR, due 2026-08-31.',
    },
    {
      id: 'i2',
      from: 'maya@beacon.example',
      to: 'finance@kite.example',
      subject: 'Invoice #2026-034 Kite Labs',
      snippet: 'Amount 850.00 EUR, due 2026-09-10.',
    },
    {
      id: 'i3',
      from: 'maya@beacon.example',
      to: 'ap@oakridge.example',
      subject: 'Invoice #2026-036 Oakridge',
      snippet: 'Amount 2,400.00 EUR, due 2026-09-20.',
    },
    {
      id: 'i4',
      from: 'maya@beacon.example',
      to: 'billing@fjord.example',
      subject: 'Invoice #2026-039 Fjord AS',
      snippet: 'Amount 600.00 EUR, due 2026-10-10.',
    },
    {
      id: 'i5',
      from: 'maya@beacon.example',
      to: 'pay@milano.example',
      subject: 'Invoice #2026-041 Studio Milano',
      snippet: 'Amount 1,000.00 EUR, due 2026-10-15.',
    },
    {
      id: 'i6',
      from: 'maya@beacon.example',
      to: 'ap@delta.example',
      subject: 'Invoice #2026-028 Delta Co',
      snippet: 'Amount 500.00 EUR, due 2026-08-15.',
    },
    {
      id: 'p6',
      from: 'ap@delta.example',
      subject: 'Re: Invoice #2026-028 Delta Co',
      snippet: 'Payment of 500.00 EUR sent today, ref DC-5521.',
    },
    {
      id: 'i7',
      from: 'maya@beacon.example',
      to: 'hello@pine.example',
      subject: 'Invoice #2026-030 Pine Studio',
      snippet: 'Amount 300.00 EUR, due 2026-08-25.',
    },
    {
      id: 'p7',
      from: 'hello@pine.example',
      subject: 'Re: Invoice #2026-030 Pine Studio',
      snippet: 'Paid, see attached remittance.',
    },
    { id: 'x1', from: 'news@saas.example', subject: 'Your weekly metrics', snippet: '...' },
  ],
};

const calendarToday = {
  events: [
    { title: 'Standup', start: 'today 09:30', end: '09:45' },
    {
      title: 'Northwind contract call',
      start: 'today 11:00',
      end: '11:30',
      attendees: ['tomas@northwind.example'],
    },
    { title: 'Beta invite review', start: 'today 15:00', end: '16:00' },
  ],
};

const slipping = {
  messages: [
    {
      id: 's1',
      from: 'Tomas Novak <tomas@northwind.example>',
      subject: 'Contract redlines, need your call by Monday',
      date: '5 days ago',
      snippet: 'Need your decision on clause 7.2 by Monday or we slip signature to November.',
      repliedByUser: false,
    },
    {
      id: 's2',
      from: 'Lena Weiss <lena@studio.example>',
      subject: 'Launch video final',
      date: 'yesterday',
      snippet: 'Final cut is up.',
    },
    {
      id: 's3',
      from: 'Waitlist bot <bot@beacon.example>',
      subject: '312 people on the waitlist',
      date: 'today',
      snippet: 'Weekly count.',
    },
  ],
};

const budgetSheet = {
  GOOGLESHEETS_SEARCH_SPREADSHEETS: {
    files: [
      {
        id: 'sheet-1',
        name: 'Spending 2026',
        url: 'https://docs.google.example/spreadsheets/d/sheet-1',
      },
    ],
  },
  GOOGLESHEETS_BATCH_GET: {
    spreadsheet: 'Spending 2026',
    tabs: {
      Transactions: [
        ['Date', 'Category', 'Amount EUR', 'Note'],
        ['2026-09-28', 'Groceries', '64.10', 'Albert'],
        ['2026-09-28', 'Eating out', '38.00', 'Lokal'],
        ['2026-09-29', 'Transport', '36.00', 'Monthly pass top-up'],
        ['2026-09-29', 'Groceries', '78.20', 'Billa'],
        ['2026-09-29', 'Subscriptions', '61.97', 'Figma, Notion, Spotify'],
        ['2026-09-29', 'Eating out', '80.00', 'Team dinner'],
      ],
      Budget: [
        ['Category', 'Monthly budget EUR', 'Spent this month EUR'],
        ['Groceries', '400', '318.40'],
        ['Eating out', '150', '171.00'],
        ['Transport', '80', '36.00'],
        ['Subscriptions', '50', '61.97'],
      ],
    },
  },
};

const adminInbox = {
  messages: [
    {
      id: 'a1',
      from: 'PRE Energie <billing@pre.example>',
      subject: 'Electricity bill September',
      snippet: '84.20 EUR due 8 Oct. Pay online with the link below.',
    },
    {
      id: 'a2',
      from: 'Dental Care Vinohrady <info@dental.example>',
      subject: 'Please confirm your appointment',
      snippet: 'Check-up on 7 Oct at 08:30. Reply YES to confirm or call to reschedule.',
    },
    {
      id: 'a3',
      from: 'Kooperativa <renewals@koop.example>',
      subject: 'Car insurance renewal',
      snippet: 'Your policy renews on 20 Oct at 412 EUR/year. No action needed to renew.',
    },
    {
      id: 'a4',
      from: 'ZS Londynska <school@zs.example>',
      subject: 'School trip consent form',
      snippet: 'Please sign and return the attached form by 5 Oct.',
      attachment: 'consent-form.pdf',
    },
    { id: 'a5', from: 'Zalando <news@zalando.example>', subject: 'Autumn sale', snippet: '...' },
  ],
};

export const taskScenarios: VoiceScenario[] = [
  {
    id: 'lab-376-slack-catchup',
    issue: 'LAB-376',
    title: 'Slack catch-up: what did I miss, what needs my reply',
    good: 'Briefly acknowledges the task. Summary in 15 lines or fewer, stays within the requested channels and time window, and lists the seeded question from Filipe under "needs your reply" with links.',
    prompt:
      'Summarise what I missed in #n8n-labs and my DMs since yesterday 18:00. What needs a reply from me?',
    work: true,
    apps: ['slack'],
    data: slack,
    maxWords: 140,
    maxLines: 15,
    expect: [
      said('catchesSeededQuestion', 'Filipe[^\\n]{0,120}(demo|vault|Friday)'),
      said('links', 'slack\\.example'),
    ],
  },
  {
    id: 'lab-382-setup',
    issue: 'LAB-382',
    title: 'Set up: draft replies to new emails, never send',
    good: 'Confirms the routine in a line or two: what counts as "needs a reply", where drafts go, that it never sends. No wall of text.',
    prompt:
      "When a new email arrives that needs a reply from me, draft one in my voice and show it to me. Don't send.",
    apps: ['gmail'],
    data: { GMAIL: newEmails },
    maxWords: 70,
    expect: [
      said('promisesNoSend', "(won't|will not|never|not)\\s+send|nothing (gets|goes) (sent|out)"),
    ],
  },
  {
    id: 'lab-382-event',
    issue: 'LAB-382',
    title: 'Background: 5 new emails arrive, 2 need a reply',
    good: 'One short heads-up, then the two drafts (Clara, Ben) shown whole. Nothing for the newsletter, CI mail or FYI.',
    prompt:
      "Event wake from gmail: 5 new emails (ids e1-e5). Saved instruction: When a new email arrives that needs a reply from me, draft one in my voice and show it to me. Don't send. Work quietly; send a concise message only when there is a useful result or necessary question.",
    background: true,
    apps: ['gmail'],
    data: { GMAIL: newEmails },
    maxWords: 160,
    expect: [said('draftsBoth', 'Clara[\\s\\S]*Ben|Ben[\\s\\S]*Clara')],
  },
  {
    id: 'lab-386-invoices',
    issue: 'LAB-386',
    title: 'Who owes me money: sheet plus reminder drafts',
    good: 'Acks with the plan. Headline: how much is owed and how much is overdue. Sheet link, drafts named, the 2 paid ones left out with the reason, nothing sent, offers a weekly check.',
    prompt:
      "Find invoices and payments people owe me in my email from the last 90 days. Put them in a sheet and draft friendly reminders for anything overdue. Don't send yet.",
    work: true,
    apps: ['gmail', 'googlesheets'],
    data: {
      GMAIL: invoices,
      GOOGLESHEETS_CREATE_GOOGLE_SHEET1: {
        spreadsheetId: 'owed-1',
        url: 'https://docs.google.example/spreadsheets/d/owed-1',
      },
    },
    maxWords: 130,
    expect: [
      said('sheetLink', 'docs\\.google\\.example'),
      said(
        'leavesOutPaid',
        '(Delta|Pine)[^\\n]{0,100}(paid|payment|remittance)|(paid|payment)[^\\n]{0,100}(Delta|Pine)',
      ),
    ],
  },
  {
    id: 'lab-387-brief',
    issue: 'LAB-387',
    title: 'Background: the 8:00 morning brief',
    good: 'Twelve lines or fewer. Today, due this week, what is slipping (Tomas, past deadline, no reply), and a top 3 tied to named goals. Reads like a colleague, not a report.',
    prompt:
      "Scheduled run: Morning brief. Saved instruction: Every morning at 8:00, give me a brief: today's meetings, what's due this week, what's slipping, and the 3 things that matter most for my goals.",
    background: true,
    apps: ['gmail', 'googlecalendar'],
    data: { GMAIL: slipping, GOOGLECALENDAR: calendarToday },
    tasks: [
      {
        title: 'Launch Beacon beta to first 50 users',
        now: 'Picking the 50 users',
        doneWhen: 'Launch post is out on Oct 14.',
      },
      {
        title: 'Close Northwind contract',
        now: 'Deciding clause 7.2',
        doneWhen: 'Contract signed by Oct 15.',
      },
    ],
    maxWords: 150,
    maxLines: 12,
    expect: [
      said('flagsSlipping', 'Tomas|7\\.2|past (the )?deadline'),
      said('namesGoal', 'Beacon|Northwind'),
    ],
  },
  {
    id: 'lab-388-triage',
    issue: 'LAB-388',
    title: 'Triage Gmail, Slack and LinkedIn into one ranked list',
    good: 'Acks. LinkedIn hits a login wall: says so in one line and delivers from the other two. Acme is on top, appears once, every item has a why and a link.',
    prompt:
      'Go through my Gmail, Slack and LinkedIn messages from the last 2 days and turn them into one to-do list, ordered by what matters most for closing deals this month.',
    work: true,
    apps: ['gmail', 'slack'],
    data: {
      GMAIL: {
        messages: [
          {
            id: 'g1',
            from: 'Priya <priya@acmeretail.example>',
            subject: 'Acme Retail: legal approved, need pricing sign-off by Friday',
            snippet:
              'EUR 180k ARR. Legal approved. Need your sign-off on the volume discount by Friday.',
            link: 'https://mail.example/g1',
          },
          {
            id: 'g2',
            from: 'Oskar <oskar@brightfin.example>',
            subject: 'Security questionnaire',
            snippet: 'Can you send the SOC2 report? We are in procurement.',
            link: 'https://mail.example/g2',
          },
          { id: 'g3', from: 'news@crm.example', subject: 'Pipeline tips', snippet: '...' },
        ],
      },
      SLACK_LIST_CONVERSATIONS: {
        channels: [
          { id: 'C9', name: 'deals' },
          { id: 'D9', name: 'dm-nina' },
        ],
      },
      SLACK_FETCH_CONVERSATION_HISTORY: {
        messages: [
          {
            channel: '#deals',
            user: 'Marco',
            text: 'Acme Retail wants the discount answer by Friday, can you approve?',
            permalink: 'https://slack.example/s1',
          },
          {
            channel: 'DM Nina',
            user: 'Nina',
            text: 'Can you join the Brightfin call Thursday?',
            permalink: 'https://slack.example/s2',
          },
        ],
      },
    },
    pages: { linkedin: 'Sign in to LinkedIn. Email or phone. Password. New to LinkedIn? Join now' },
    maxWords: 140,
    expect: [said('saysLinkedInFailed', 'LinkedIn'), said('acmeFirst', '^[\\s\\S]{0,400}Acme')],
  },
  {
    id: 'lab-380-budget',
    issue: 'LAB-380',
    title: 'Spending by category vs budget, plus a morning check',
    good: 'Names the exact sheet before answering. Leads with what is over budget (eating out, subscriptions), totals match, says no transactions today, confirms the morning check in a line.',
    prompt:
      "Using my spending Google Sheet, tell me what I spent this week by category and how that compares with my monthly budget. Then check it every morning and tell me if I'm over.",
    work: true,
    apps: ['googlesheets'],
    data: budgetSheet,
    maxWords: 120,
    expect: [
      said('namesSheet', 'Spending 2026'),
      said(
        'flagsOver',
        'Eating out[\\s\\S]{0,200}(over|171)|Subscriptions[\\s\\S]{0,200}(over|61\\.97)',
      ),
    ],
  },
  {
    id: 'lab-383-youtube',
    issue: 'LAB-383',
    title: 'YouTube: n8n videos from the last 30 days, grouped into topics',
    good: 'Briefly acknowledges the task. Short summary with the growing topics first, backed by topic metrics and relevant sources; the table goes in a file or one message. States any material coverage limitation.',
    prompt:
      'Find the YouTube videos about n8n from the last 30 days, group them into topics, and tell me which topics are growing. Leave out the official n8n channel.',
    work: true,
    search: {
      youtube: [
        {
          title: 'n8n AI agent with MCP in 10 minutes',
          url: 'https://youtube.example/v1',
          snippet: 'Nate Herk · 12 days ago · 84K views',
        },
        {
          title: 'Build a RAG chatbot with n8n and Supabase',
          url: 'https://youtube.example/v2',
          snippet: 'Cole Medin · 20 days ago · 51K views',
        },
        {
          title: 'n8n vs Make in 2026',
          url: 'https://youtube.example/v3',
          snippet: 'Automation Andy · 8 days ago · 22K views',
        },
        {
          title: 'n8n 2.0 release walkthrough',
          url: 'https://youtube.example/v4',
          snippet: 'n8n (official) · 5 days ago · 40K views',
        },
        {
          title: 'Selling n8n automations to clients',
          url: 'https://youtube.example/v5',
          snippet: 'Liam Ottley · 15 days ago · 63K views',
        },
        {
          title: 'MCP servers in n8n explained',
          url: 'https://youtube.example/v6',
          snippet: 'Leon van Zyl · 3 days ago · 18K views',
        },
      ],
    },
    maxWords: 160,
  },
  {
    id: 'lab-393-dinner',
    issue: 'LAB-393',
    title: 'Book a dinner: find options, book on go',
    good: 'Acks. Two or three real options with checked availability, says plainly which one is phone-only and which is behind a bot wall, recommends one and waits for "go".',
    prompt:
      'Book a table for 2 this Friday at 20:00, somewhere Italian within 15 minutes of Rua Augusta 120, Lisbon, under €60 a head.',
    work: true,
    search: {
      italian: [
        {
          title: 'Osteria Lupa · Chiado',
          url: 'https://osteria-lupa.example',
          snippet: 'Italian, €35-50 per head, 8 min walk from Rua Augusta. Online booking.',
        },
        {
          title: 'Trattoria da Enzo',
          url: 'https://trattoria-enzo.example',
          snippet: 'Italian, €30-45, Baixa. Reservations by phone.',
        },
        {
          title: 'Forno Nero on TheFork',
          url: 'https://thefork.example/forno-nero',
          snippet: 'Italian, €40-55, 12 min.',
        },
      ],
    },
    pages: {
      'osteria-lupa':
        'Osteria Lupa. Book a table. Friday 20:00, 2 guests: available. Also 19:30, 21:00. Continue to booking.',
      'trattoria-enzo': 'Trattoria da Enzo. Reservations only by phone: +351 21 000 0000.',
      thefork: 'Access denied. Our systems detected unusual activity from your browser.',
    },
    maxWords: 120,
    expect: [
      said(
        'waitsForGo',
        'go ahead|want me to book|shall i book|should i book|ok to book|book it\\?|say go|confirm the booking',
      ),
      said('explainsBlocks', 'phone|blocked|bot|access denied'),
    ],
  },
  {
    id: 'lab-381-hotel',
    issue: 'LAB-381',
    title: 'Set up: watch a hotel price twice a day',
    good: 'Checks the current price first, then confirms the watch in one or two lines: when it checks, what triggers an alert, that it stays quiet otherwise.',
    prompt:
      'I booked Hotel Aurora Lisbon for 16–18 Oct at €240 with free cancellation (https://hotel-aurora.example/rooms). Check the price twice a day and tell me if it drops by more than €20.',
    work: true,
    pages: {
      'hotel-aurora':
        'Hotel Aurora Lisbon. 16–18 Oct, 2 nights, Deluxe Double: €238 total. Free cancellation until 14 Oct.',
    },
    maxWords: 70,
    expect: [
      said('statesCurrentPrice', '238'),
      said('confirmsSchedule', 'twice|09:00|9:00|morning|evening|18:00'),
    ],
  },
  {
    id: 'lab-394-admin',
    issue: 'LAB-394',
    title: 'Private admin from email: handle what you can, ask before paying',
    good: 'Acks. Headline: what needs her and by when. Handles safe bits (drafts the dentist YES), asks before paying the bill or signing, and ignores the renewal that needs nothing.',
    prompt:
      'Find the admin tasks in my personal email from the last 2 weeks (bills, appointments, forms, renewals) and handle what you can. Ask me before paying or sending anything.',
    work: true,
    apps: ['gmail'],
    data: { GMAIL: adminInbox },
    maxWords: 130,
    expect: [said('asksBeforePaying', '(pay|send|sign)[^.\\n]{0,80}\\?|want me to|ok to|shall i')],
  },
];
