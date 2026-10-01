import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import type { RuntimeContext } from '../src/ports/agent.ts';
import type { Computer, Workspace } from '../src/ports/computer.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { agentModels } from '../src/shared/model-defaults.ts';
import { scenarios as voiceScenarios, type VoiceScenario } from './voice-scenarios.ts';
import { taskScenarios } from './voice-tasks.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(repository, '.local/voice-evals');
const environment = {
  ...parse(await readFile(join(repository, '.env'), 'utf8').catch(() => '')),
  ...process.env,
};
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = option('label') ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const only = option('only')?.split(',');
const repeat = Number(option('repeat') ?? 1);
const compare = option('compare')?.split(',') ?? [];
const scenarios = [...voiceScenarios, ...taskScenarios];
const set = option('set') ?? 'voice';

type Entry =
  | { kind: 'message'; at: number; text: string; question?: boolean }
  | { kind: 'tool'; at: number; name: string; input: unknown };

interface Run {
  scenario: string;
  attempt: number;
  seconds: number;
  error?: string;
  timeline: Entry[];
  checks: Record<string, boolean>;
  metrics: { firstMessage: number | null; bubbles: number; maxWords: number; tools: number };
}

const catalog: Record<string, Record<string, string>> = {
  gmail: {
    GMAIL_FETCH_EMAILS: 'List recent emails. args {query?, max_results?}',
    GMAIL_CREATE_EMAIL_DRAFT: 'Create a draft. args {recipient_email, subject, body, thread_id?}',
    GMAIL_SEND_EMAIL: 'Send an email. args {recipient_email, subject, body}',
  },
  googlecalendar: {
    GOOGLECALENDAR_EVENTS_LIST: 'List events. args {timeMin?, timeMax?}',
  },
  slack: {
    SLACK_LIST_CONVERSATIONS: 'List channels and DMs.',
    SLACK_FETCH_CONVERSATION_HISTORY: 'Messages in a conversation. args {channel, oldest?}',
    SLACK_FETCH_MESSAGE_THREAD: 'Replies in a thread. args {channel, ts}',
    SLACK_SEND_MESSAGE: 'Post a message. args {channel, text}',
  },
  googlesheets: {
    GOOGLESHEETS_SEARCH_SPREADSHEETS: 'Find spreadsheets by name. args {query}',
    GOOGLESHEETS_BATCH_GET: 'Read ranges. args {spreadsheet_id, ranges}',
    GOOGLESHEETS_CREATE_GOOGLE_SHEET1: 'Create a spreadsheet. args {title}',
    GOOGLESHEETS_BATCH_UPDATE: 'Write values. args {spreadsheet_id, range, values}',
  },
};

const banned = [
  /\bcertainly\b/i,
  /i'd be (?:happy|glad) to/i,
  /let me know if/i,
  /happy to help/i,
  /great question/i,
  /feel free/i,
  /hope this helps/i,
  /anything else/i,
  /how can i (?:help|assist)/i,
  /no problem at all/i,
  /^absolutely\b/im,
];

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

function score(scenario: VoiceScenario, timeline: Entry[]): Pick<Run, 'checks' | 'metrics'> {
  const messages = timeline.filter((entry) => entry.kind === 'message');
  const tools = timeline.filter((entry) => entry.kind === 'tool');
  const text = messages.map((entry) => entry.text.replaceAll('’', "'")).join('\n');
  const maxWords = Math.max(0, ...messages.map((entry) => words(entry.text)));
  const checks: Record<string, boolean> = {
    short: maxWords <= (scenario.maxWords ?? (scenario.work ? 90 : 60)),
    noBoilerplate: !banned.some((pattern) => pattern.test(text)),
    noHeadingsOrEmDash: !/^#{1,6} /m.test(text) && !text.includes('—'),
  };
  if (scenario.work && tools.length) {
    checks.ackBeforeWork = Boolean(messages[0] && messages[0].at <= tools[0].at);
    checks.deliveredAfterWork = Boolean(messages.at(-1) && messages.at(-1)!.at >= tools.at(-1)!.at);
  }
  if (scenario.quiet)
    checks.backsOff =
      messages.length === 0 ||
      (messages.length === 1 && /quiet|less often|weekly|pause|fewer|back off/i.test(text));
  else checks.replied = messages.length > 0;
  if (scenario.maxLines)
    checks.fewLines = text.split('\n').filter((line) => line.trim()).length <= scenario.maxLines;
  for (const { name, pattern } of scenario.expect ?? [])
    checks[name] = new RegExp(pattern, 'im').test(text);
  return {
    checks,
    metrics: {
      firstMessage: messages[0]?.at ?? null,
      bubbles: messages.length,
      maxWords,
      tools: tools.length,
    },
  };
}

const webTools = new Set(['web_search', 'fetch_content', 'get_search_content', 'code_search']);
const turns = new Map<string, VoiceScenario>();
const browsers = new Map<string, { pages: Record<string, string>; url: string }>();
const computer: Computer = {
  act: async (threadId, input) => {
    await sleep(2000);
    const browser = browsers.get(threadId) ?? { pages: {}, url: 'about:blank' };
    if (input.url) browser.url = input.url;
    browsers.set(threadId, browser);
    const key = Object.keys(browser.pages).find((item) => browser.url.includes(item));
    return {
      text: key ? browser.pages[key] : 'Page loaded with no content relevant to this task.',
      url: browser.url,
      candidates: [],
    };
  },
  screenshot: async () => null,
  injectCredentials: async () => {},
  currentPage: async () => ({ origin: 'https://example.com', url: 'https://example.com' }),
  hold: async () => {},
  close: async () => {},
  dispose: async () => {},
  status: () => 'eval computer',
};

const workspace: Workspace = {
  open: () => ({
    path: '/workspace/eval',
    instructions: 'Evaluation workspace: commands run but return no output.',
    exec: async () => ({ exitCode: 0 }),
  }),
  status: () => 'eval workspace',
  dispose: () => {},
};

async function runScenario(
  runtime: ReturnType<typeof createAgentRuntime>,
  scenario: VoiceScenario,
  attempt: number,
): Promise<Run> {
  const started = Date.now();
  const at = () => Math.round((Date.now() - started) / 100) / 10;
  const timeline: Entry[] = [];
  const visible = new Map<string, number>();
  const latency = () => sleep(scenario.latencyMs ?? 1500);
  const apps = scenario.apps ?? [];
  const goals = (scenario.goals ?? []).map((goal) => ({
    ...goal,
    progress: 30,
    targetDate: '2026-10-14',
  }));
  const directory = await mkdtemp(join(tmpdir(), 'otto-voice-'));
  const threadId = randomUUID();
  const turnId = randomUUID();
  turns.set(turnId, scenario);
  browsers.set(threadId, { pages: scenario.pages ?? {}, url: 'about:blank' });
  const context = {
    threadId,
    turnId,
    prompt: scenario.prompt,
    background: scenario.background,
    channel: scenario.channel ?? 'web',
    timeZone: 'Europe/Prague',
    locale: 'en-GB',
    hourCycle: 'h23',
    account: { preferredName: 'Maya', fullName: 'Maya Horak', email: 'maya@beacon.example' },
    currentMessageId: randomUUID(),
    history: (scenario.history ?? []).map((item) => ({
      role: item.role,
      text: item.text,
      createdAt: new Date(started - item.hoursAgo * 3_600_000),
    })),
    personalContext: {
      profile: {
        name: 'Maya Horak',
        location: 'Prague',
        phone: '',
        preferences: scenario.preferences ?? '',
      },
      activeGoals: goals,
    },
    workspacePath: directory,
    signal: AbortSignal.timeout(240_000),
    attachments: [],
    emit: async () => {},
    observe: async (event) => {
      if (event.type === 'tool_start')
        timeline.push({ kind: 'tool', at: at(), name: event.name, input: event.input });
    },
    delta: (text, id) => {
      if (id && text && !visible.has(id)) visible.set(id, at());
    },
    reply: async (text, id) => {
      timeline.push({ kind: 'message', at: (id && visible.get(id)) ?? at(), text });
    },
    waitForUser: async (question) => {
      timeline.push({ kind: 'message', at: at(), text: question, question: true });
    },
    reactToMessage: async () => ({ status: 'reacted' }),
    publish: async (path, name) => ({ id: randomUUID(), name: name ?? path, url: '#' }),
    requestCredential: async () => ({}),
    connections: async (action, service) => {
      if (action === 'list')
        return apps.map((slug, index) => ({
          connectionId: `00000000-0000-4000-8000-00000000000${index}`,
          service: slug,
          accountEmail: 'maya@beacon.example',
          status: 'connected',
        }));
      return { name: service, url: 'https://otto.example/connect' };
    },
    integration: async (action, input) => {
      await latency();
      if (action === 'SEARCH_TOOLS')
        return {
          tools: Object.assign({}, ...apps.map((slug) => catalog[slug] ?? {})),
          accounts: apps.map((slug) => ({ service: slug, accountEmail: 'maya@beacon.example' })),
        };
      const prefix = action.split('_')[0];
      if (!apps.some((slug) => slug.toUpperCase() === prefix))
        return { status: 'rejected', message: 'No connected account for this service.' };
      if (/SEND|POST|DELETE|PAY/.test(action))
        return {
          requiresConfirmation: true,
          question: `Send this email to ${String(input.recipient_email)}?`,
        };
      if (scenario.data?.[action]) return scenario.data[action];
      if (/DRAFT/.test(action)) return { status: 'draft_created', draftId: randomUUID() };
      if (/CREATE|UPDATE|ADD|APPEND|INSERT/.test(action)) return { status: 'ok' };
      return scenario.data?.[prefix] ?? { items: [] };
    },
    manage: async (action) => {
      if (action === 'goal_list') return goals;
      if (action === 'profile_get') return context.personalContext.profile;
      if (action === 'history_search') return [];
      return { status: 'ok' };
    },
  } as RuntimeContext;
  let error: string | undefined;
  try {
    await runtime.runTurn(context);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  timeline.sort((a, b) => a.at - b.at);
  return {
    scenario: scenario.id,
    attempt,
    seconds: at(),
    ...(error ? { error } : {}),
    timeline,
    ...score(scenario, timeline),
  };
}

function escape(value: string) {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function writeReport(labels: string[]) {
  const runs: Record<string, Run[]> = {};
  for (const name of labels)
    runs[name] = JSON.parse(await readFile(join(outputDir, `${name}.json`), 'utf8')).runs;
  const cell = (run: Run | undefined) => {
    if (!run) return '<td class="empty">not run</td>';
    const chips = Object.entries(run.checks)
      .map(([name, ok]) => `<span class="chip ${ok ? 'ok' : 'bad'}">${name}</span>`)
      .join('');
    const lines = run.timeline
      .map((entry) =>
        entry.kind === 'tool'
          ? `<div class="tool"><b>${entry.at.toFixed(1)}s</b> ${escape(entry.name)} ${escape(JSON.stringify(entry.input)).slice(0, 90)}</div>`
          : `<div class="msg${entry.question ? ' q' : ''}"><b>${entry.at.toFixed(1)}s</b>${escape(entry.text)}</div>`,
      )
      .join('');
    const first = run.metrics.firstMessage === null ? 'none' : `${run.metrics.firstMessage}s`;
    return `<td><div class="meta">first msg ${first} · ${run.metrics.bubbles} bubbles · max ${run.metrics.maxWords} words · ${run.seconds}s</div><div>${chips}</div>${run.error ? `<div class="err">${escape(run.error)}</div>` : ''}${lines || '<div class="silent">(sent nothing)</div>'}</td>`;
  };
  const rows = scenarios
    .filter((scenario) =>
      labels.some((name) => runs[name].some((run) => run.scenario === scenario.id)),
    )
    .map((scenario) => {
      const attempts = Math.max(
        1,
        ...labels.map((name) => runs[name].filter((run) => run.scenario === scenario.id).length),
      );
      return Array.from({ length: attempts }, (_, attempt) => {
        const head =
          attempt === 0
            ? `<th rowspan="${attempts}"><div class="title">${escape(scenario.title)}</div><div class="prompt">${escape(scenario.prompt)}</div><div class="good">${escape(scenario.good)}</div></th>`
            : '';
        return `<tr>${head}${labels.map((name) => cell(runs[name].filter((run) => run.scenario === scenario.id)[attempt])).join('')}</tr>`;
      }).join('');
    })
    .join('');
  const totals = labels
    .map((name) => {
      const all = runs[name].flatMap((run) => Object.values(run.checks));
      return `<th>${escape(name)}<div class="meta">${all.filter(Boolean).length}/${all.length} checks pass</div></th>`;
    })
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Otto voice eval</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f6f6f3;color:#1b1b1b}
table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #ddd;padding:10px;vertical-align:top;background:#fff;text-align:left}
thead th{position:sticky;top:0;background:#fafafa}.title{font-weight:600}.prompt{margin:6px 0;font-family:ui-monospace,monospace;font-size:12px}
.good{color:#2d6a3e;font-weight:400;font-size:13px}.meta{color:#777;font-size:12px;font-weight:400}
.msg{background:#e8f0fe;border-radius:12px;padding:6px 10px;margin:6px 0;white-space:pre-wrap;max-width:95%}.msg.q{background:#fff4d6}
.msg b,.tool b{font-weight:500;color:#888;margin-right:6px;font-size:11px}.tool{color:#999;font-size:11px;font-family:ui-monospace,monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.chip{display:inline-block;font-size:11px;border-radius:4px;padding:1px 6px;margin:2px 3px 2px 0}.ok{background:#dff3e4;color:#1d6b35}.bad{background:#fbe1e1;color:#a02121}
.err{color:#a02121}.silent{color:#999;font-style:italic;margin-top:6px}
</style><h1>Otto voice eval</h1><table><thead><tr><th style="width:22%">Scenario</th>${totals}</tr></thead><tbody>${rows}</tbody></table>`;
  const path = join(outputDir, 'report.html');
  await writeFile(path, html);
  return path;
}

await mkdir(outputDir, { recursive: true });
if (args.includes('--report-only')) {
  console.log(await writeReport(compare));
  process.exit(0);
}
const provider = environment.LLM_PROVIDER || 'openai';
const apiKey =
  provider === 'anthropic'
    ? environment.ANTHROPIC_API_KEY
    : provider === 'openrouter'
      ? environment.OPENROUTER_API_KEY
      : environment.OPENAI_API_KEY;
const model = environment.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
const sessionRoot = await mkdtemp(join(tmpdir(), 'otto-voice-sessions-'));
const runtime = createAgentRuntime({
  agent: createPiAgent({ provider, model, apiKey, sessionRoot }),
  computer,
  workspace,
  withTool: <T>(turnId: string, _toolCallId: string, name: string, action: () => T): T => {
    if (!webTools.has(name)) return action();
    const results = Object.values(turns.get(turnId)?.search ?? {}).flat();
    return sleep(3000).then(() =>
      name === 'web_search'
        ? { source: 'eval', results }
        : 'Full page content is not available in this evaluation. Use the search results.',
    ) as T;
  },
});
const selected = (
  set === 'tasks' ? taskScenarios : set === 'all' ? scenarios : voiceScenarios
).filter((scenario) => !only || only.includes(scenario.id));
console.log(`${provider}/${model} · ${selected.length} scenarios × ${repeat} → ${label}`);
const runs: Run[] = [];
try {
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    const batch = await Promise.all(
      selected.map((scenario) => runScenario(runtime, scenario, attempt)),
    );
    runs.push(...batch);
  }
} finally {
  await runtime.dispose().catch(() => {});
  await rm(sessionRoot, { recursive: true, force: true });
}
await writeFile(
  join(outputDir, `${label}.json`),
  JSON.stringify({ label, provider, model, at: new Date().toISOString(), runs }, null, 2),
);
for (const run of runs) {
  const failed = Object.entries(run.checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);
  console.log(
    `${run.scenario.padEnd(20)} first ${String(run.metrics.firstMessage ?? '-').padStart(5)}s  bubbles ${run.metrics.bubbles}  max ${String(run.metrics.maxWords).padStart(3)}w  ${failed.length ? 'FAIL ' + failed.join(',') : 'ok'}${run.error ? '  ERROR ' + run.error : ''}`,
  );
}
const existing = (await readdir(outputDir))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -5));
console.log(await writeReport([...compare.filter((name) => existing.includes(name)), label]));
