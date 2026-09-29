import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { createServer } from 'vite';
import { createGateway } from '../src/server/gateway.ts';
import type { AuthenticatedSession, AuthenticationProvider } from '../src/ports/authentication.ts';
import type { StoredAccount } from '../src/server/account-store.ts';
import { defaultPreferences, preferencesSchema } from '../src/server/preferences.ts';
import { welcomeGreeting } from '../src/server/welcome.ts';
import {
  integrationServiceIds,
  integrationServices,
  type IntegrationService,
} from '../src/shared/integrations.ts';
import type {
  Artifact,
  Goal,
  Message,
  Schedule,
  ScheduleRun,
  Task,
} from '../src/shared/contracts.ts';

const hour = 3_600_000;
const at = (offset: number) => new Date(Date.now() + offset).toISOString();
const timeZone = 'Europe/Lisbon';

const fixtureGoals: Goal[] = [
  {
    id: 'a1f0c3de-0000-4000-8000-000000000001',
    title: 'Run a half marathon',
    description: 'Build up to 21 km with three runs each week.',
    progress: 40,
    status: 'active',
    nextAction: 'Plan the long run for Sunday.',
    targetDate: '2026-12-06',
    updatedAt: at(-5 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000002',
    title: 'Read twelve books this year',
    description: 'One book each month, mostly fiction.',
    progress: 75,
    status: 'active',
    nextAction: 'Choose the October book.',
    targetDate: '2026-12-31',
    updatedAt: at(-30 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000003',
    title: 'Learn basic Portuguese grammar',
    description: 'Short lessons on weekday evenings.',
    progress: 20,
    status: 'paused',
    nextAction: 'Review verb tenses.',
    targetDate: null,
    updatedAt: at(-80 * hour),
  },
  {
    id: 'a1f0c3de-0000-4000-8000-000000000004',
    title: 'Plan the summer trip',
    description: 'Book flights and a place to stay.',
    progress: 100,
    status: 'completed',
    nextAction: '',
    targetDate: '2026-06-01',
    updatedAt: at(-900 * hour),
  },
];

const briefingMessage = 'b2e1d4ef-0000-4000-8000-000000000011';
const reviewMessage = 'b2e1d4ef-0000-4000-8000-000000000012';

const fixtureRuns: ScheduleRun[] = [
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000021',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000041',
    scheduledFor: at(-2 * hour),
    timeZone,
    createdAt: at(-2 * hour),
    status: 'succeeded',
    error: null,
    messageId: briefingMessage,
    messageText:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    messagePreview:
      'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30. Rain is likely after 17:00, so plan the run for the…',
    observation: null,
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000022',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000042',
    scheduledFor: at(-26 * hour),
    timeZone,
    createdAt: at(-26 * hour),
    status: 'succeeded',
    error: null,
    messageId: reviewMessage,
    messageText:
      'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    messagePreview:
      'Last week you ran 14 km and finished two chapters. Next step for the half marathon goal: plan the long run for Sunday.',
    observation: null,
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000023',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000043',
    scheduledFor: at(-50 * hour),
    timeZone,
    createdAt: at(-50 * hour),
    status: 'succeeded',
    error: null,
    messageId: null,
    messagePreview: null,
    messageText: null,
    observation: null,
  },
  {
    id: 'c3f2e5f0-0000-4000-8000-000000000024',
    scheduleId: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    taskId: 'e5b4a7b2-0000-4000-8000-000000000044',
    scheduledFor: at(-74 * hour),
    timeZone,
    createdAt: at(-74 * hour),
    status: 'failed',
    error: 'The task could not finish.',
    messageId: null,
    messagePreview: null,
    messageText: null,
    observation: null,
  },
];

const fixtureSchedules: Schedule[] = [
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000031',
    title: 'Morning briefing',
    prompt: 'Summarize my calendar, the weather and anything urgent.',
    kind: 'recurring',
    cron: '30 8 * * *',
    runAt: null,
    timeZone,
    enabled: true,
    revision: 0,
    nextRun: at(20 * hour),
    baselineObservation: null,
    lastRun: fixtureRuns[0],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000032',
    title: 'Send a reminder',
    prompt: 'Remind me to book the dentist.',
    kind: 'once',
    cron: null,
    runAt: at(50 * hour),
    timeZone,
    enabled: true,
    revision: 1,
    nextRun: at(50 * hour),
    baselineObservation: null,
    lastRun: fixtureRuns[3],
  },
  {
    id: 'd4a3f6a1-0000-4000-8000-000000000033',
    title: 'Weekly review',
    prompt: 'Review my goals and suggest one next step for each.',
    kind: 'recurring',
    cron: '0 18 * * 0',
    runAt: null,
    timeZone,
    enabled: false,
    revision: 2,
    nextRun: null,
    baselineObservation: null,
    lastRun: fixtureRuns[1],
  },
];

const message = (
  id: string,
  role: Message['role'],
  text: string,
  offset: number,
  taskId: string | null = null,
): Message => ({ id, role, text, taskId, createdAt: at(offset), attachments: [] });

const planMessages: Message[] = [
  message(
    'b2e1d4ef-0000-4000-8000-000000000001',
    'user',
    'Can you check my goals every Sunday evening?',
    -30 * hour,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000002',
    'assistant',
    'Done. I scheduled a weekly review every Sunday at 18:00.',
    -30 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000051',
  ),
  message(
    reviewMessage,
    'assistant',
    'Last week you ran 14 km and finished two chapters.\n\nNext step for the half marathon goal: plan the long run for Sunday.',
    -26 * hour,
    'e5b4a7b2-0000-4000-8000-000000000042',
  ),
  ...Array.from({ length: 8 }, (_, index) =>
    message(
      `b2e1d4ef-0000-4000-8000-0000000001${String(index).padStart(2, '0')}`,
      index % 2 ? 'assistant' : 'user',
      index % 2
        ? 'Here is a short answer with the details you asked for. I kept it brief so you can scan it quickly.'
        : 'One more question about my plans for this week.',
      -20 * hour + index * 20 * 60_000,
      'e5b4a7b2-0000-4000-8000-000000000052',
    ),
  ),
  message(
    briefingMessage,
    'assistant',
    'Good morning. You have two meetings today: design review at 10:00 and a call with Sam at 15:30.\n\nRain is likely after 17:00, so plan the run for the morning.',
    -2 * hour,
    'e5b4a7b2-0000-4000-8000-000000000041',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000003',
    'user',
    'Thanks. Move the call with Sam to 16:00.',
    -1 * hour,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
  message(
    'b2e1d4ef-0000-4000-8000-000000000004',
    'assistant',
    'The call with Sam is now at 16:00.',
    -1 * hour + 60_000,
    'e5b4a7b2-0000-4000-8000-000000000053',
  ),
];

const days: Record<string, string> = {
  weekdays: '1-5',
  weekends: '0,6',
  'every day': '*',
  daily: '*',
};

function createPlansFixture() {
  const goals: Goal[] = structuredClone(fixtureGoals);
  const schedules: Schedule[] = structuredClone(fixtureSchedules);
  const messages: Message[] = structuredClone(planMessages);
  const tasks: Task[] = [];
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  function reply(text: string) {
    const lower = text.toLowerCase();
    const schedule = schedules.find((item) => text.includes(`"${item.title}"`));
    const goal = goals.find((item) => text.includes(`"${item.title}"`));
    const time = /(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?/i.exec(text);
    if (schedule) {
      const [minute, cronHour, , , day] = (schedule.cron ?? '0 9 * * *').split(' ');
      const nextDay = Object.entries(days).find(([word]) => lower.includes(word))?.[1] ?? day;
      const suffix = time?.[3]?.toLowerCase();
      const nextHour = !time
        ? cronHour
        : String(suffix ? (Number(time[1]) % 12) + (suffix === 'pm' ? 12 : 0) : Number(time[1]));
      const nextMinute = time ? String(Number(time[2] ?? 0)) : minute;
      if (lower.includes('pause') || lower.includes('resume')) {
        schedule.enabled = lower.includes('resume');
        schedule.nextRun = schedule.enabled ? new Date(Date.now() + 20 * hour).toISOString() : null;
      } else if (schedule.kind === 'recurring')
        schedule.cron = `${nextMinute} ${nextHour} * * ${nextDay}`;
      schedule.revision += 1;
      return schedule.enabled
        ? `Done. ${schedule.title} now runs at ${nextHour.padStart(2, '0')}:${nextMinute.padStart(2, '0')}${nextDay === '1-5' ? ' on weekdays' : ''}.`
        : `Done. I paused ${schedule.title}.`;
    }
    if (goal) {
      const percent = /(\d{1,3})\s*%/.exec(text);
      if (percent) goal.progress = Math.min(100, Number(percent[1]));
      if (lower.includes('pause')) goal.status = 'paused';
      if (lower.includes('done') || lower.includes('complete')) goal.status = 'completed';
      const next = /next step[^:]*:\s*(.+)$/i.exec(text);
      if (next) goal.nextAction = next[1].trim();
      goal.updatedAt = new Date().toISOString();
      return `Done. I updated ${goal.title}${percent ? ` to ${goal.progress}%` : ''}.`;
    }
    if (lower.startsWith('new goal')) {
      const title = text.replace(/^new goal:\s*/i, '').slice(0, 80) || 'New goal';
      goals.unshift({
        ...fixtureGoals[0],
        id: randomUUID(),
        title,
        description: '',
        progress: 0,
        nextAction: 'Choose the first step.',
        targetDate: null,
      });
      return `Done. I added the goal ${title}.`;
    }
    if (lower.startsWith('new schedule')) {
      const title = text.replace(/^new schedule:\s*/i, '').slice(0, 80) || 'New schedule';
      schedules.unshift({
        ...fixtureSchedules[0],
        id: randomUUID(),
        title,
        prompt: title,
        lastRun: null,
      });
      return `Done. I scheduled ${title} every day at 08:30.`;
    }
    return 'I noted that. Tell me what to change and I will do it.';
  }
  async function handle(request: Request, url: URL): Promise<Response | null> {
    const patch = /^\/api\/(goals|schedules)\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET') {
      if (url.pathname === '/api/goals') return Response.json(goals);
      if (url.pathname === '/api/schedules') return Response.json(schedules);
      if (url.pathname === '/api/schedule-runs')
        return Response.json({ runs: fixtureRuns, nextCursor: null });
      if (url.pathname === '/api/messages') return Response.json([]);
      return null;
    }
    if (request.method === 'PATCH' && patch) {
      const list: Array<Goal | Schedule> = patch[1] === 'goals' ? goals : schedules;
      const item = list.find((entry) => entry.id === patch[2]);
      if (!item) return Response.json({ error: 'Not found.' }, { status: 404 });
      Object.assign(item, await request.json());
      if ('enabled' in item) {
        item.revision += 1;
        item.nextRun = item.enabled ? new Date(Date.now() + 20 * hour).toISOString() : null;
      }
      changed();
      return Response.json(item);
    }
    if (request.method === 'POST' && url.pathname === '/api/messages') {
      const body = (await request.json()) as { text: string; clientMessageId?: string };
      const taskId = randomUUID();
      const messageId = body.clientMessageId ?? randomUUID();
      const now = new Date().toISOString();
      messages.push({
        id: messageId,
        role: 'user',
        text: body.text,
        taskId,
        createdAt: now,
        attachments: [],
      });
      tasks.unshift({
        id: taskId,
        title: body.text.slice(0, 100),
        status: 'running',
        createdAt: now,
        updatedAt: now,
        showTyping: true,
      });
      changed();
      setTimeout(() => {
        const index = tasks.findIndex((task) => task.id === taskId);
        if (index < 0) return;
        const answer = reply(body.text);
        const done = new Date().toISOString();
        messages.push({
          id: randomUUID(),
          role: 'assistant',
          text: answer,
          taskId,
          createdAt: done,
          attachments: [],
        });
        Object.assign(tasks[index], {
          status: 'succeeded',
          updatedAt: done,
          showTyping: false,
        });
        changed();
      }, 1800);
      return Response.json({ taskId, messageId, continued: false });
    }
    return null;
  }
  function reset() {
    goals.splice(0, goals.length, ...structuredClone(fixtureGoals));
    schedules.splice(0, schedules.length, ...structuredClone(fixtureSchedules));
    messages.splice(0, messages.length, ...structuredClone(planMessages));
    tasks.splice(0, tasks.length);
    changed();
  }
  return {
    reset,
    handle,
    state: () => ({ messages, tasks }),
    listen(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

const repository = fileURLToPath(new URL('..', import.meta.url));
const fixturePort = Number(process.env.OTTO_UI_PORT || 4346);
if (!Number.isInteger(fixturePort) || fixturePort < 1024 || fixturePort > 65535)
  throw new Error('Use a valid local fixture port.');
const origin = `http://localhost:${fixturePort}`;
const attachments = process.env.OTTO_UI_ATTACHMENTS === 'true';
const plansEnabled = process.env.OTTO_UI_FIXTURE_DATA === 'plans';
const plans = new Map<string, ReturnType<typeof createPlansFixture>>();
function plansFor(owner: string) {
  if (!plansEnabled) return null;
  const current = plans.get(owner) ?? createPlansFixture();
  plans.set(owner, current);
  return current;
}
const cookieName = 'otto-ui-fixture';
const users = [
  { id: randomUUID(), name: 'Alex Morgan', email: 'alex@example.test', avatarUrl: null },
  { id: randomUUID(), name: 'Sam Rivera', email: 'sam@example.test', avatarUrl: null },
];
function png(width: number, height: number) {
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const sky = y < height * 0.62;
      const sun = Math.hypot(x - width * 0.7, y - height * 0.42) < height * 0.12;
      const t = y / height;
      const [r, g, b] = sun
        ? [255, 214, 150]
        : sky
          ? [250 - t * 120, 170 - t * 60, 150 + t * 40]
          : [40 + (1 - t) * 60, 70 + (1 - t) * 50, 110 + ((x + y) % 23)];
      rows.set([r, g, b], row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function pdf(pages: string[][]) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const lines of pages) {
    const text = lines
      .map((line, index) => {
        const size = index === 0 ? 22 : 12;
        const y = index === 0 ? 720 : 680 - index * 22;
        return `BT /F1 ${size} Tf 72 ${y} Td (${line}) Tj ET`;
      })
      .join('\n');
    const stream = `0.93 0.36 0.52 rg 72 752 60 6 re f\n0.1 0.1 0.14 rg\n${text}`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + (objects.length - 3)} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    );
  }
  let output = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 240" width="480" height="240">
<style>text { font: 600 15px system-ui, sans-serif; fill: #1b1924 }</style>
<rect x="20" y="80" width="120" height="64" rx="12" fill="#fceaec" stroke="#bc3666" stroke-width="2"/>
<rect x="180" y="80" width="120" height="64" rx="12" fill="#f2edf9" stroke="#7554a0" stroke-width="2"/>
<rect x="340" y="80" width="120" height="64" rx="12" fill="#edf5ef" stroke="#315c49" stroke-width="2"/>
<path d="M140 112h40M300 112h40" stroke="#6e697a" stroke-width="2"/>
<text x="80" y="117" text-anchor="middle">Request</text>
<text x="240" y="117" text-anchor="middle">Review</text>
<text x="400" y="117" text-anchor="middle">Deliver</text>
</svg>`;

const files = [
  {
    name: 'Harbour visit.png',
    mimeType: 'image/png',
    bytes: png(960, 640),
  },
  {
    name: 'Process diagram.svg',
    mimeType: 'image/svg+xml',
    bytes: Buffer.from(svg),
  },
  {
    name: 'Site sources.zip',
    mimeType: 'application/zip',
    bytes: Buffer.concat([Buffer.from('PK\x05\x06'), Buffer.alloc(18)]),
  },
  {
    name: 'Harbour renovation plan.pdf',
    mimeType: 'application/pdf',
    bytes: pdf([
      [
        'Harbour renovation plan',
        'Synthetic document for the Otto UI fixture.',
        '1. Survey the north pier and record damage.',
        '2. Replace the lighting along the promenade.',
        '3. Add seating near the ferry entrance.',
        '4. Review costs with the city team.',
      ],
      ['Schedule', 'Phase one starts in March.', 'Phase two starts in June.'],
      ['Budget', 'All numbers in this fixture are fictional.'],
    ]),
  },
].map((file, index) => ({
  ...file,
  id: `00000000-0000-4000-8000-0000000000a${index}`,
}));

const fixtureArtifacts = new Map(files.map((file) => [file.id, file]));

const artifact = (index: number): Artifact => ({
  id: files[index].id,
  name: files[index].name,
  mimeType: files[index].mimeType,
  size: files[index].bytes.length,
  url: `/api/artifacts/${files[index].id}`,
});

function fixtureMessages(): Message[] {
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return [
    {
      id: 'fixture-attachments-1',
      role: 'user',
      text: 'Here is a photo from the harbour visit. Can you make a short plan?',
      taskId: 'fixture-attachments-task',
      createdAt: at(12),
      attachments: [artifact(0)],
    },
    {
      id: 'fixture-attachments-2',
      role: 'assistant',
      text: 'I made a process diagram and put the source notes in an archive.',
      taskId: 'fixture-attachments-task',
      createdAt: at(10),
      attachments: [artifact(1), artifact(2)],
    },
    {
      id: 'fixture-attachments-3',
      role: 'assistant',
      text: '',
      taskId: 'fixture-attachments-task',
      createdAt: at(9),
      attachments: [artifact(3)],
    },
  ];
}
const sessions = new Map<string, AuthenticatedSession>();
const pending = new Set<string>();
const accounts = new Map<string, StoredAccount>();
const preferences = new Map<string, typeof defaultPreferences>();
const connections = new Map<string, Set<IntegrationService>>([
  [users[0].id, new Set<IntegrationService>(['gmail', 'googlecalendar', 'slack'])],
]);
const welcomes = new Map<
  string,
  { startedAt: number; taskId: string; messageId: string; archived?: boolean }
>();
const welcomeFindings: Partial<Record<IntegrationService, { text: string; start: string }>> = {
  gmail: {
    text: '**The Q4 vendor contract from Maria Lopez.** It has waited four days for your reply, and she asked again this morning. I can read the 12-page draft, list what changed and write a reply for you to approve.',
    start: 'the contract',
  },
  googlecalendar: {
    text: '**Tomorrow at 09:30, budget review with Finance.** You have no notes yet. I can pull the numbers from your thread with Tom and prepare a one-page brief.',
    start: 'the budget brief',
  },
  slack: {
    text: '**Six mentions in #launch since Friday.** Two ask you to decide the release date. I can summarize both threads and draft your answer.',
    start: 'the release date',
  },
};
function welcomeApps(owner: string) {
  return integrationServiceIds.filter((slug) => connections.get(owner)?.has(slug));
}
function welcomeMessages(owner: string, startedAt: number) {
  const apps = welcomeApps(owner);
  const greeting = welcomeGreeting(
    users.find((user) => user.id === owner)?.name,
    apps.map((slug) => integrationServices[slug].name),
  );
  const findings = apps.slice(0, 3).map(
    (slug) =>
      welcomeFindings[slug] ?? {
        text: `**New activity in ${integrationServices[slug].name}.** Four items changed this week. I can check which ones need you and list the next step for each.`,
        start: integrationServices[slug].name,
      },
  );
  return [
    { text: greeting, at: startedAt },
    ...(findings.length
      ? [
          {
            text: `${['One thing stands', 'Two things stand', 'Three things stand'][findings.length - 1]} out, and I can handle ${findings.length > 1 ? 'each one' : 'it'} for you:\n\n${findings
              .map((finding, index) => `${index + 1}. ${finding.text}`)
              .join('\n')}\n\nShould I start with ${findings[0].start}?`,
            at: startedAt + 6_000,
          },
        ]
      : []),
  ];
}
const consent = new Map<
  string,
  { ownerId: string; service: IntegrationService; returnTo: string }
>();
const telegramChannels = new Map<string, Record<string, unknown>>();
const telegramCodes = new Map<string, string>();
function startTelegramPairing(owner: string) {
  for (const [code, value] of telegramCodes) if (value === owner) telegramCodes.delete(code);
  const code = randomBytes(24).toString('base64url');
  telegramCodes.set(code, owner);
  const channel = {
    provider: 'telegram',
    enabled: true,
    mode: 'webhook',
    webhookStatus: 'registered',
    accountName: 'Otto fixture bot',
    accountHandle: '@otto_fixture_bot',
    pairingExpiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  telegramChannels.set(owner, channel);
  return { ok: true, channel, pairingUrl: `${origin}/fixture/telegram?start=${code}` };
}
const avatar = new Uint8Array(
  await readFile(new URL('../public/apple-touch-icon.png', import.meta.url)),
);
const account = (owner: string) =>
  accounts.get(owner) ?? {
    theme: 'system' as const,
    onboardingCompleted: plansEnabled,
    displayName: null,
  };
function session(headers: Headers) {
  const token = headers.get('cookie')?.match(/(?:^|;\s*)otto-ui-fixture=([^;]+)/)?.[1];
  if (!token) return null;
  const current = sessions.get(token);
  if (current && current.expiresAt.getTime() > Date.now()) return current;
  sessions.delete(token);
  return null;
}
function icon(background: number[], foreground: number[], round: boolean, dot: boolean) {
  const size = 32;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x - 15.5);
      const dy = Math.abs(y - 15.5);
      const outside = round
        ? Math.hypot(dx, dy) > 15.5
        : Math.hypot(Math.max(0, dx - 9), Math.max(0, dy - 9)) > 6.5;
      const inner = dot ? Math.hypot(dx, dy) < 6.5 : dx < 7 && dy < 2.5;
      rows.set(
        [...(inner ? foreground : background), outside ? 0 : 255],
        y * (size * 4 + 1) + 1 + x * 4,
      );
    }
  const chunk = (kind: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(kind, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const vaultIcons = new Map([
  ['https://mail.example.com', icon([234, 88, 12], [255, 255, 255], true, true)],
  ['https://work.example.com', icon([79, 70, 229], [224, 231, 255], false, false)],
  ['https://shop.example.net:8443', icon([22, 163, 74], [240, 253, 244], true, false)],
]);
const seedVault: Array<Record<string, unknown>> = [
  ['Personal email', 'https://mail.example.com', 'alex@example.test'],
  ['Work account', 'https://work.example.com', 'alex.morgan@work.example.com'],
  ['Admin account', 'https://work.example.com', 'admin@work.example.com'],
  ['Grocery orders', 'https://shop.example.net:8443', 'alex@example.test'],
  ['Library card', 'https://library.example.org', 'member-40219'],
]
  .map(([label, entryOrigin, username]) => ({
    kind: 'login',
    id: randomUUID(),
    label,
    origin: entryOrigin,
    username,
    usernameHint: `${username.slice(0, 2)}…`,
    updatedAt: '2026-09-20T10:00:00.000Z',
  }))
  .concat([
    {
      kind: 'card',
      id: randomUUID(),
      label: 'Everyday card',
      brand: 'Visa',
      last4: '4242',
      expiryMonth: 4,
      expiryYear: 2031,
      cardholder: 'Alex Morgan',
      hasSecurityCode: true,
      updatedAt: '2026-09-20T10:00:00.000Z',
    } as never,
  ]);
const vaults = new Map<string, Map<string, Record<string, unknown>>>();
function vaultFor(owner: string) {
  if (!vaults.has(owner))
    vaults.set(
      owner,
      new Map(
        seedVault.map((entry) => {
          const id = randomUUID();
          return [id, { ...entry, id }];
        }),
      ),
    );
  return vaults.get(owner)!;
}
const authentication: AuthenticationProvider = {
  configured: true,
  async initialize() {},
  async session(headers) {
    return session(headers);
  },
  async signIn() {
    const state = randomUUID();
    pending.add(state);
    return Response.json({ url: `${origin}/fixture/consent?state=${state}` });
  },
  async signOut(headers) {
    const current = session(headers);
    for (const [token, value] of sessions) if (value.id === current?.id) sessions.delete(token);
    return Response.json(
      { ok: true },
      { headers: { 'set-cookie': `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } },
    );
  },
  async callback() {
    return Response.redirect(`${origin}/login?error=sign-in`);
  },
  async avatar() {
    return { bytes: avatar, mimeType: 'image/png' };
  },
};
const app = await createGateway({
  origin,
  privacyNotice: [
    'This is a local interface preview with fictional accounts and app connections.',
    '## Preview data',
    'Names, settings and connections exist only in memory and reset when the preview server restarts.',
    '## Connected services',
    'This preview does not sign in to Google, access connected apps or send messages.',
  ].join('\n\n'),
  authentication,
  accounts: {
    async read(owner) {
      return account(owner);
    },
    async update(owner, change) {
      const previous = account(owner);
      const next = {
        ...previous,
        ...(change.theme ? { theme: change.theme } : {}),
        ...(change.onboardingCompleted !== undefined
          ? { onboardingCompleted: change.onboardingCompleted }
          : {}),
        ...(change.name ? { displayName: change.name } : {}),
      };
      accounts.set(owner, next);
      return next;
    },
  },
  runtimes: {
    async fetch(owner, request) {
      const url = new URL(request.url);
      if (['/api/account/prepare', '/api/account/profile'].includes(url.pathname))
        return Response.json({ ok: true });
      if (url.pathname === '/api/onboarding/start') {
        if (!welcomes.has(owner))
          welcomes.set(owner, {
            startedAt: Date.now(),
            taskId: randomUUID(),
            messageId: randomUUID(),
          });
        return Response.json({ ok: true });
      }
      const stored = welcomes.get(owner);
      const welcome = stored?.archived ? undefined : stored;
      const messages = welcome
        ? welcomeMessages(owner, welcome.startedAt).filter((message) => message.at <= Date.now())
        : [];
      const replied = welcome && (!welcomeApps(owner).length || messages.length > 1);
      const vault = vaultFor(owner);
      if (url.pathname === '/api/vault') {
        if (request.method === 'POST') {
          const input = (await request.json()) as Record<string, unknown>;
          const id = randomUUID();
          const entry =
            input.kind === 'card'
              ? {
                  kind: 'card',
                  id,
                  label: input.label,
                  brand: 'Visa',
                  last4: String(input.cardNumber).slice(-4),
                  expiryMonth: input.expiryMonth,
                  expiryYear: input.expiryYear,
                  cardholder: input.cardholder,
                  hasSecurityCode: Boolean(input.securityCode),
                  updatedAt: new Date().toISOString(),
                }
              : {
                  kind: 'login',
                  id,
                  label: input.label,
                  origin: /^https?:\/\//.test(String(input.origin))
                    ? String(input.origin)
                    : `https://${String(input.origin)}`,
                  username: input.username,
                  usernameHint: `${String(input.username).slice(0, 2)}…`,
                  updatedAt: new Date().toISOString(),
                };
          vault.set(id, entry);
          return Response.json(entry);
        }
        return Response.json(
          [...vault.values()].map(({ cardholder: _c, hasSecurityCode: _h, ...entry }) => entry),
        );
      }
      const item = /^\/api\/vault\/([^/]+)(?:\/([a-z-]+))?$/.exec(url.pathname);
      if (item && vault.has(item[1])) {
        const entry = vault.get(item[1])!;
        if (item[2] === 'icon') {
          const bytes = vaultIcons.get(String(entry.origin));
          return bytes
            ? new Response(bytes, { headers: { 'content-type': 'image/png' } })
            : Response.json({ error: 'The website icon is unavailable.' }, { status: 404 });
        }
        if (item[2] === 'details') return Response.json(entry);
        if (item[2] === 'password') return Response.json({ password: 'synthetic-password' });
        if (item[2] === 'card-number') return Response.json({ cardNumber: '4242424242424242' });
        if (item[2] === 'security-code') return Response.json({ securityCode: '123' });
        if (request.method === 'DELETE') {
          vault.delete(item[1]);
          return Response.json({ ok: true });
        }
        if (request.method === 'PATCH') {
          const input = (await request.json()) as Record<string, unknown>;
          const { password: _p, cardNumber: _n, securityCode: _s, ...change } = input;
          Object.assign(entry, change);
          return Response.json(entry);
        }
      }
      if (url.pathname === '/api/state')
        return Response.json({
          conversationRevision: 0,
          messages: [
            ...(plansFor(owner)?.state().messages ?? []),
            ...(attachments ? fixtureMessages() : []),
            ...messages.map((message, index) => ({
              id: `${welcome!.messageId}-${index}`,
              role: 'assistant',
              text: message.text,
              taskId: welcome!.taskId,
              attachments: [],
              createdAt: new Date(message.at).toISOString(),
            })),
          ],
          tasks: [
            ...(plansFor(owner)?.state().tasks ?? []),
            ...(welcome
              ? [
                  {
                    id: welcome.taskId,
                    title: 'Welcome',
                    status: replied ? 'succeeded' : 'queued',
                    showTyping: true,
                    createdAt: new Date(welcome.startedAt).toISOString(),
                    updatedAt: new Date(welcome.startedAt).toISOString(),
                  },
                ]
              : []),
          ],
          configuration: {
            provider: 'fixture',
            model: 'Synthetic UI fixture',
            llmReady: true,
            speechReady: false,
            integrationsReady: true,
            browserAssistReady: false,
            inspectorEnabled: false,
            localOnly: false,
          },
        });
      const file = attachments
        ? fixtureArtifacts.get(/^\/api\/artifacts\/([a-f0-9-]+)$/.exec(url.pathname)?.[1] ?? '')
        : undefined;
      if (file)
        return new Response(file.bytes, {
          headers: {
            'content-type': file.mimeType,
            'content-disposition': `${file.mimeType === 'application/zip' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
          },
        });
      if (url.pathname === '/api/events') {
        let timer: ReturnType<typeof setInterval>;
        let stop: (() => void) | undefined;
        return new Response(
          new ReadableStream({
            start(controller) {
              const refresh = () =>
                controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n'));
              refresh();
              stop = plansFor(owner)?.listen(refresh);
              timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode('data: {"type":"refresh"}\n\n')),
                2_000,
              );
            },
            cancel() {
              clearInterval(timer);
              stop?.();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (url.pathname === '/api/apps')
        return Response.json(
          integrationServiceIds.map((slug) => ({
            slug,
            name: integrationServices[slug].name,
            status: connections.get(owner)?.has(slug) ? 'connected' : 'disconnected',
            triggersEnabled: false,
            ...(connections.get(owner)?.has(slug)
              ? {
                  connectionId: `${owner}-${slug}`,
                  accountName: users.find((user) => user.id === owner)?.name,
                }
              : {}),
          })),
        );
      const connect = /^\/api\/apps\/([^/]+)\/connect$/.exec(url.pathname);
      if (
        connect &&
        request.method === 'POST' &&
        integrationServiceIds.includes(connect[1] as IntegrationService)
      ) {
        const input = (await request.json()) as { returnTo?: string };
        const token = randomBytes(32).toString('base64url');
        consent.set(token, {
          ownerId: owner,
          service: connect[1] as IntegrationService,
          returnTo:
            input.returnTo === 'window'
              ? '/connected.html'
              : input.returnTo === 'onboarding'
                ? '/onboarding'
                : '/apps',
        });
        return Response.json({
          url: `${origin}/fixture/connect?token=${token}`,
          ...(input.returnTo === 'window' ? { attempt: token } : {}),
        });
      }
      if (url.pathname === '/api/preferences') {
        const previous = preferences.get(owner) ?? { ...defaultPreferences };
        if (request.method === 'PATCH')
          preferences.set(owner, {
            ...previous,
            ...preferencesSchema.partial().parse(await request.json()),
          });
        return Response.json(preferences.get(owner) ?? previous);
      }
      if (url.pathname === '/api/channels')
        return Response.json({
          channels: ['telegram', 'whatsapp'].map((provider) => ({
            provider,
            status:
              provider === 'telegram' && telegramChannels.has(owner) ? 'configured' : 'disabled',
            missing: [],
          })),
          error: null,
        });
      if (url.pathname === '/api/channel-settings')
        return Response.json({
          ready: true,
          channels: telegramChannels.has(owner) ? [telegramChannels.get(owner)] : [],
        });
      if (url.pathname === '/api/channel-settings/telegram' && request.method === 'PUT') {
        const input = (await request.json()) as { botToken?: string };
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(input.botToken?.trim() ?? ''))
          return Response.json(
            {
              error: 'The account could not be verified. Check the token, account and permissions.',
            },
            { status: 400 },
          );
        return Response.json(startTelegramPairing(owner));
      }
      if (url.pathname === '/api/channel-settings/telegram/pairing' && request.method === 'POST')
        return telegramChannels.get(owner)?.pairingExpiresAt
          ? Response.json(startTelegramPairing(owner))
          : Response.json(
              {
                error:
                  'This Telegram setup step is no longer available. Refresh Channels and try again.',
              },
              { status: 400 },
            );
      if (
        ['/api/channel-settings/telegram/confirm', '/api/channel-settings/telegram/user'].includes(
          url.pathname,
        ) &&
        request.method === 'POST'
      ) {
        const channel = telegramChannels.get(owner);
        const input = (await request.json()) as { allowedUserId?: string };
        const candidate = channel?.pairingCandidate as { id: string; name: string } | undefined;
        const id = url.pathname.endsWith('/user') ? input.allowedUserId?.trim() : candidate?.id;
        if (
          !channel?.pairingExpiresAt ||
          (url.pathname.endsWith('/confirm') &&
            !(Date.parse(String(channel.pairingExpiresAt)) > Date.now())) ||
          !id ||
          !/^[1-9]\d{0,15}$/.test(id)
        )
          return Response.json(
            { error: 'Check the Telegram user ID. It is a positive number.' },
            { status: 400 },
          );
        delete channel.pairingExpiresAt;
        delete channel.pairingCandidate;
        channel.allowedUserId = id;
        if (url.pathname.endsWith('/confirm')) channel.pairedUser = candidate!.name;
        return Response.json({ ok: true, channel });
      }
      if (url.pathname === '/api/channel-settings/telegram' && request.method === 'DELETE') {
        telegramChannels.delete(owner);
        return Response.json({ ok: true, channel: { provider: 'telegram', enabled: false } });
      }
      const planned = await plansFor(owner)?.handle(request, url);
      if (planned) return planned;
      if (url.pathname === '/api/messages/history')
        return Response.json({ messages: [], hasMore: false });
      if (url.pathname === '/api/messages')
        return Response.json(
          { error: 'The UI fixture does not run an assistant.' },
          { status: 503 },
        );
      return Response.json(
        { error: 'This capability is unavailable in the UI fixture.' },
        { status: 404 },
      );
    },
    async close() {},
  },
});
const page = (heading: string, content: string) =>
  `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Otto UI fixture</title><body style="font:16px system-ui;margin:0;background:#f9f8f6;color:#242229"><main style="max-width:420px;margin:15vh auto;padding:28px"><p>Otto UI fixture</p><h1>${heading}</h1>${content}<p style="color:#666;font-size:13px">Synthetic accounts and permissions. No provider is contacted.</p></main></body></html>`;
app.get('/fixture/consent', async (request, reply) => {
  const state = new URL(request.url, origin).searchParams.get('state') ?? '';
  if (!pending.has(state)) return reply.code(400).send('This fixture sign-in has expired.');
  return reply
    .type('text/html')
    .send(
      page(
        'Choose a fixture account',
        users
          .map(
            (user, index) =>
              `<a role="button" href="/fixture/sign-in/${index}?state=${state}" style="display:block;padding:18px;margin:14px 0;background:white;border:1px solid #ddd;border-radius:12px;text-align:left;color:inherit;text-decoration:none">Continue as ${user.name}<br><small>${user.email}</small></a>`,
          )
          .join(''),
      ),
    );
});
app.get('/fixture/sign-in/:index', async (request, reply) => {
  const state = new URL(request.url, origin).searchParams.get('state') ?? '';
  const index = Number((request.params as { index: string }).index);
  if (!pending.delete(state) || !Number.isInteger(index) || !users[index])
    return reply.code(400).send('This fixture sign-in has expired.');
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, {
    id: randomUUID(),
    user: users[index],
    avatarSource: 'fixture:avatar',
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  return reply
    .header('set-cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax`)
    .redirect('/');
});
app.get('/fixture/chat', async (request, reply) => {
  const current = session(new Headers({ cookie: request.headers.cookie ?? '' }));
  if (!current) return reply.code(401).send('Sign in to use this fixture.');
  const search = new URL(request.url, origin).searchParams;
  welcomes.delete(current.user.id);
  if (search.get('state') === 'empty')
    welcomes.set(current.user.id, {
      startedAt: Date.now(),
      taskId: randomUUID(),
      messageId: randomUUID(),
      archived: true,
    });
  return reply.redirect('/');
});
app.get('/fixture/telegram', async (request, reply) => {
  const code = new URL(request.url, origin).searchParams.get('start') ?? '';
  if (!telegramCodes.has(code))
    return reply.code(400).send('This fixture start link is not valid.');
  return reply
    .type('text/html')
    .send(
      page(
        'Otto fixture bot',
        `<p>This page stands in for Telegram. Press Start to send the one-time code.</p><a role="button" href="/fixture/telegram/start?start=${code}" style="padding:12px 20px;display:inline-block">Start</a>`,
      ),
    );
});
app.get('/fixture/telegram/start', async (request, reply) => {
  const code = new URL(request.url, origin).searchParams.get('start') ?? '';
  const owner = telegramCodes.get(code);
  const channel = owner && telegramChannels.get(owner);
  if (!channel || Date.parse(String(channel.pairingExpiresAt)) <= Date.now())
    return reply.code(400).send('This fixture start link is not valid.');
  telegramCodes.delete(code);
  const name = users.find((user) => user.id === owner)?.name ?? 'Fixture';
  channel.pairingCandidate = {
    id: '123456789',
    name: `@${name.toLowerCase().replaceAll(' ', '_')}`,
  };
  return reply
    .type('text/html')
    .send(page('Start sent', '<p>Return to Otto and confirm that this is your account.</p>'));
});
app.get('/fixture/telegram/expire', async (request, reply) => {
  const owner = session(new Headers({ cookie: request.headers.cookie ?? '' }))?.user.id;
  const channel = owner && telegramChannels.get(owner);
  if (!channel?.pairingExpiresAt) return reply.code(400).send('No fixture start link is waiting.');
  channel.pairingExpiresAt = new Date(Date.now() - 1000).toISOString();
  return reply.type('text/html').send(page('Start link expired', '<p>Return to Otto.</p>'));
});
app.get('/fixture/plans/reset', async (_request, reply) => {
  for (const fixture of plans.values()) fixture.reset();
  return reply.send({ ok: plansEnabled });
});
app.get('/fixture/connect', async (request, reply) => {
  const token = new URL(request.url, origin).searchParams.get('token') ?? '';
  const attempt = consent.get(token);
  if (
    !attempt ||
    session(new Headers({ cookie: request.headers.cookie ?? '' }))?.user.id !== attempt.ownerId
  )
    return reply.code(401).send('Sign in to use this fixture.');
  return reply
    .type('text/html')
    .send(
      page(
        `Connect ${integrationServices[attempt.service].name}`,
        `<a role="button" href="/fixture/connected?token=${token}&result=connected" style="padding:12px 20px;display:inline-block">Connect</a> <a role="button" href="/fixture/connected?token=${token}&result=cancelled" style="padding:12px 20px;display:inline-block">Cancel</a>`,
      ),
    );
});
app.get('/fixture/connected', async (request, reply) => {
  const token = new URL(request.url, origin).searchParams.get('token') ?? '';
  const attempt = consent.get(token);
  if (
    !attempt ||
    session(new Headers({ cookie: request.headers.cookie ?? '' }))?.user.id !== attempt.ownerId
  )
    return reply.code(401).send('Sign in to use this fixture.');
  consent.delete(token);
  const result = new URL(request.url, origin).searchParams.get('result');
  if (result === 'connected') {
    const apps = connections.get(attempt.ownerId) ?? new Set();
    apps.add(attempt.service);
    connections.set(attempt.ownerId, apps);
  }
  return reply.redirect(
    `${attempt.returnTo}?connection=${result === 'connected' ? 'connected' : 'cancelled'}${attempt.returnTo === '/connected.html' ? `&service=${attempt.service}&attempt=${token}` : ''}`,
  );
});
const vite = await createServer({
  root: repository,
  server: {
    middlewareMode: true,
    hmr: { server: app.server },
    watch: { ignored: ['**/.local/**', '**/.env*'] },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '**/.git/**',
        '**/.local/**',
        '**/src/server/**',
        '**/src/providers/**',
        '**/src/runtime/**',
        '**/src/ports/**',
        '**/*.pem',
      ],
    },
  },
  appType: 'spa',
});
await app.register((await import('@fastify/middie')).default);
app.use((request, response, next) =>
  request.url?.startsWith('/api/') || request.url?.startsWith('/fixture/')
    ? next()
    : vite.middlewares(request, response, next),
);
app.addHook('preClose', async () => vite.close());
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (!closing) {
      closing = true;
      void app.close();
    }
  });
await app.listen({ host: '127.0.0.1', port: fixturePort });
console.log(`Synthetic hosted UI fixture is ready at ${origin}.`);
