import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import type {
  AgentToolResult,
  ModelUsageObservation,
  RuntimeContext,
  RuntimeObservation,
  RuntimeResult,
} from '../src/ports/agent.ts';
import type { Computer, Workspace } from '../src/ports/computer.ts';
import { createPiAgent } from '../src/providers/pi/index.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { agentModels } from '../src/shared/model-defaults.ts';
import { systemPrompt } from '../src/runtime/prompt.ts';
import {
  answerScenarios,
  scenarios as voiceScenarios,
  type VoiceScenario,
} from './voice-scenarios.ts';
import { taskScenarios } from './voice-tasks.ts';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(repository, '.local/voice-evals');
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const label = option('label') ?? new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const only = option('only')?.split(',');
const set = option('set') ?? 'voice';
const repeat = Number(option('repeat') ?? (set === 'answers' ? 2 : 1));
const compare = option('compare')?.split(',') ?? [];
const scenarios = [...voiceScenarios, ...taskScenarios, ...answerScenarios];
const sets: Record<string, VoiceScenario[]> = {
  voice: voiceScenarios,
  tasks: taskScenarios,
  answers: answerScenarios,
  all: scenarios,
};
if (!sets[set]) throw new Error('Choose --set voice, tasks, answers or all.');
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
  throw new Error('--repeat must be between 1 and 10.');
if ([label, ...compare].some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)))
  throw new Error('Labels must be simple file names.');
const selected = sets[set].filter((scenario) => !only || only.includes(scenario.id));
if (!selected.length || only?.some((id) => !selected.some((scenario) => scenario.id === id)))
  throw new Error('No matching scenario or an unknown --only case.');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const overridePath = option('system-prompt');
const promptOverride = overridePath ? await readFile(resolve(overridePath), 'utf8') : undefined;
if (promptOverride !== undefined && !promptOverride.trim())
  throw new Error('The system-prompt override is empty.');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repository,
  encoding: 'utf8',
}).trim();

type Entry =
  | { kind: 'message'; at: number; text: string; question?: boolean }
  | { kind: 'tool'; at: number; name: string; input: unknown }
  | { kind: 'result'; at: number; name: string; status: string; output?: unknown };

interface FixtureCall {
  action: string;
  input: unknown;
  output: unknown;
}

interface Run {
  scenario: string;
  attempt: number;
  seconds: number;
  error?: string;
  status?: RuntimeResult['status'];
  calls: FixtureCall[];
  violations: string[];
  usage: ModelUsageObservation[];
  costUsd: number | null;
  inputHash: string;
  promptHash: string;
  systemPromptHash?: string;
  review?: Array<{ check: string; status: 'pending' }>;
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

function score(
  scenario: VoiceScenario,
  timeline: Entry[],
  calls: FixtureCall[],
): Pick<Run, 'checks' | 'metrics'> {
  const messages = timeline.filter((entry) => entry.kind === 'message');
  const tools = timeline.filter((entry) => entry.kind === 'tool');
  const text = messages.map((entry) => entry.text.replaceAll('’', "'")).join('\n');
  const maxWords = Math.max(0, ...messages.map((entry) => words(entry.text)));
  const checks: Record<string, boolean> = {
    short: maxWords <= (scenario.maxWords ?? (scenario.work ? 90 : 60)),
    noBoilerplate: !banned.some((pattern) => pattern.test(text)),
    ...(scenario.answer
      ? {}
      : { noHeadingsOrEmDash: !/^#{1,6} /m.test(text) && !text.includes('—') }),
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
  if (scenario.answer) {
    checks.noUnnecessaryQuestion = !messages.some((entry) => entry.question);
    if (!scenario.answer.audit) {
      checks.noOperationalReceipt =
        !/(?:\b(?:read|checked|searched|scanned|reviewed|consulted)|\b(?:li|consultei|pesquisei|verifiquei))[^\n.!?]{0,100}\b(?:\d+|one|two|three|um|uma|dois|duas)\s+(?:saved\s+)?(?:profiles?|memories|memory|searches?|sources?|messages?|emails?|tools?|perfi(?:l|s)|pesquisas?|mem[oó]rias?|fontes?|mensagens?)\b|\b(?:\d+|one|two|three)\s+(?:profile|memory)\s+(?:reads?|searches?|checks?)\b/iu.test(
          text,
        );
      checks.noToolTrace =
        !/\b(?:manage_personal_context|manage_apps|memory_find|memory_read|profile_get|schedule_list|SEARCH_TOOLS|GMAIL_[A-Z_]+|GOOGLECALENDAR_[A-Z_]+)\b|\b(?:via|using|through) (?:MCP|Composio|HTTP API)\b/i.test(
          text,
        );
    }
    for (const action of scenario.answer.reads ?? [])
      checks[`read:${action}`] = calls.some((call) =>
        new RegExp(`^(?:${action})$`).test(call.action),
      );
    for (const url of scenario.answer.sourceUrls ?? [])
      checks[`source:${url}`] =
        text.includes(url) && calls.some((call) => JSON.stringify(call.output).includes(url));
    for (const { name, pattern } of scenario.answer.reject ?? [])
      checks[name] = !new RegExp(pattern, 'im').test(text);
  }
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

const webTools = new Set([
  'web_search',
  'fetch_content',
  'get_search_content',
  'code_search',
  'source_check',
]);
const turns = new Map<string, VoiceScenario>();
const violations = new Map<string, string[]>();
const observers = new Map<string, (event: RuntimeObservation | ModelUsageObservation) => void>();
const promptHashes = new Map<string, string>();
const answerTools = new Set([
  'codemode',
  'apps',
  'manage_apps',
  'manage_personal_context',
  'send_message',
  'ask_user',
]);
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
  bindProfile: async () => {},
  deleteProfile: async () => {},
  download: async () => {
    throw new Error('Downloads are unavailable in this evaluation.');
  },
  upload: async () => {
    throw new Error('Uploads are unavailable in this evaluation.');
  },
  screenshot: async () => null,
  control: async () => {},
  view: async function* () {},
  screenStatus: () => ({ state: 'unavailable' }),
  injectCredentials: async () => {},
  fillCard: async () => {},
  cardDestinations: async () => ({ document: '', destinations: {} }),
  checkoutImage: async () => new Uint8Array(),
  currentPage: async () => ({ origin: 'https://example.com', url: 'https://example.com' }),
  hold: async () => {},
  close: async () => {},
  discard: async () => {},
  dispose: async () => {},
};

const workspace: Workspace = {
  open: () => ({
    path: '/workspace/eval',
    instructions: 'Evaluation workspace: commands run but return no output.',
    exec: async () => ({ exitCode: 0 }),
  }),
  writeArtifact: async () => {},
  readArtifact: async () => new Uint8Array(),
  dispose: () => {},
};

function profileMemory(profile: NonNullable<VoiceScenario['profile']>, memory = '{}') {
  const index = JSON.parse(memory) as Record<string, string[]>;
  const about = [
    ['name', 'Name', profile.name],
    ['location', 'Location', profile.location],
    ['phone', 'Phone', profile.phone],
  ].flatMap(([slug, label, value]) => (value ? [`${slug}: ${label}: ${value}`] : []));
  return JSON.stringify({
    ...index,
    about: [...about, ...(index.about ?? [])],
    ...(profile.preferences
      ? { preferences: [`profile: ${profile.preferences}`, ...(index.preferences ?? [])] }
      : {}),
  });
}

async function runScenario(
  runtime: ReturnType<typeof createAgentRuntime>,
  scenario: VoiceScenario,
  attempt: number,
): Promise<Run> {
  const started = Date.now();
  const at = () => Math.round((Date.now() - started) / 100) / 10;
  const timeline: Entry[] = [];
  const calls: FixtureCall[] = [];
  const usage = new Map<string, ModelUsageObservation>();
  const record = (action: string, input: unknown, output: unknown) => {
    calls.push({ action, input, output });
    return output;
  };
  const visible = new Map<string, number>();
  const latency = () => sleep(scenario.latencyMs ?? 1500);
  const apps = scenario.apps ?? [];
  const tasks: Array<Record<string, unknown>> = (scenario.tasks ?? []).map((task) => ({
    id: randomUUID(),
    title: task.title,
    now: task.now,
    doneWhen: task.doneWhen,
    status: 'scheduled',
    waitingFor: [],
    nextCheck: '2026-10-14T09:00:00.000Z',
    question: null,
  }));
  const directory = await mkdtemp(join(tmpdir(), 'nod-voice-'));
  const threadId = randomUUID();
  const turnId = randomUUID();
  turns.set(turnId, scenario);
  observers.set(turnId, (event) => {
    if (event.type === 'tool_start')
      timeline.push({ kind: 'tool', at: at(), name: event.name, input: event.input });
    if (event.type === 'tool_end')
      timeline.push({
        kind: 'result',
        at: at(),
        name: event.name,
        status: event.status,
        output: event.output ?? event.error,
      });
    if (event.type === 'model_usage') usage.set(event.id, event);
  });
  violations.set(turnId, []);
  browsers.set(threadId, { pages: scenario.pages ?? {}, url: 'about:blank' });
  const context: RuntimeContext = {
    sessionId: threadId,
    threadId,
    turnId,
    prompt: scenario.prompt,
    background: scenario.background,
    channel: scenario.channel ?? 'web',
    timeZone: scenario.timeZone ?? 'Europe/Prague',
    locale: scenario.locale ?? 'en-GB',
    hourCycle: 'h23',
    account: {
      preferredName: scenario.profile?.name.split(' ')[0] ?? 'Maya',
      fullName: scenario.profile?.name ?? 'Maya Horak',
      email: 'maya@beacon.example',
    },
    currentMessageId: randomUUID(),
    history: (scenario.history ?? []).map((item) => ({
      role: item.role,
      text: item.text,
      createdAt: new Date(started - item.hoursAgo * 3_600_000),
    })),
    memory: profileMemory(
      scenario.profile ?? {
        name: 'Maya Horak',
        location: 'Prague',
        phone: '',
        preferences: scenario.preferences ?? '',
      },
      scenario.memory,
    ),
    workspacePath: directory,
    signal: AbortSignal.timeout(scenario.answer ? 90_000 : 240_000),
    ...(scenario.answer ? { limits: { maxToolCalls: 12, timeoutMs: 90_000 } } : {}),
    attachments: [],
    emit: async () => {},
    delta: (text, id) => {
      if (id && text && !visible.has(id)) visible.set(id, at());
    },
    reply: async (text, id) => {
      timeline.push({ kind: 'message', at: (id ? visible.get(id) : undefined) ?? at(), text });
    },
    reactToMessage: async () => ({ status: 'updated' }),
    publish: async (path, name) => ({
      id: randomUUID(),
      name: name ?? path,
      url: '#',
      mimeType: 'application/octet-stream',
      size: 0,
    }),
    requestCredential: async () => ({ url: '#' }),
    connections: async (action, service) => {
      if (action === 'list')
        return apps.map((slug, index) => ({
          connectionId: `00000000-0000-4000-8000-00000000000${index}`,
          service: slug,
          accountEmail: 'maya@beacon.example',
          status: 'connected',
        }));
      if (scenario.answer) {
        violations.get(turnId)!.push(`connection:${action}`);
        return { status: 'rejected', message: 'This evaluation permits reads only.' };
      }
      return { name: service, url: 'https://nod.example/connect' };
    },
    integration: async (action, input) => {
      await latency();
      if (action === 'SEARCH_TOOLS')
        return {
          tools: Object.assign({}, ...apps.map((slug) => catalog[slug] ?? {})),
          accounts: apps.map((slug) => ({ service: slug, accountEmail: 'maya@beacon.example' })),
        };
      const prefix = action.split('_')[0];
      if (!apps.some((slug) => slug.toUpperCase() === prefix)) {
        if (scenario.answer) violations.get(turnId)!.push(`app:${action}`);
        return { status: 'rejected', message: 'No connected account for this service.' };
      }
      if (scenario.answer) {
        if (!['GMAIL_FETCH_EMAILS', 'GOOGLECALENDAR_EVENTS_LIST'].includes(action)) {
          violations.get(turnId)!.push(`app:${action}`);
          return {
            status: 'rejected',
            message: 'This action is not available in the read-only fixture.',
          };
        }
        return record(
          action,
          input,
          scenario.data?.[action] ?? scenario.data?.[prefix] ?? { items: [] },
        );
      }
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
    task: async (input) => {
      const { action, id, status, ...fields } = input as Record<string, unknown>;
      if (action === 'list')
        return record('task', input, { tasks: tasks.filter((task) => !task.closedAt) });
      const open = tasks.find((item) =>
        action === 'start'
          ? item.title === fields.title && !item.closedAt
          : item.id === id && !item.closedAt,
      );
      const task =
        open ??
        (action === 'start'
          ? { id: randomUUID(), status: 'working', waitingFor: [], nextCheck: null, question: null }
          : undefined);
      if (!task) throw new Error('This task is not open. Use task list for open tasks.');
      if (!open) tasks.push(task);
      Object.assign(
        task,
        fields,
        action === 'finish' ? { status, closedAt: new Date().toISOString() } : {},
      );
      return record('task', input, task);
    },
    manage: async (action, input) => {
      if (action === 'history_search') return record(action, input, []);
      if (['memory_find', 'memory_read', 'schedule_list'].includes(action))
        return record(action, input, scenario.personalData?.[action] ?? []);
      if (scenario.answer) {
        violations.get(turnId)!.push(`personal:${action}`);
        return { status: 'rejected', message: 'This evaluation permits reads only.' };
      }
      return { status: 'ok' };
    },
  };
  let error: string | undefined;
  let status: RuntimeResult['status'] | undefined;
  try {
    const result = await runtime.runTurn(context);
    status = result.status;
    if (result.message)
      timeline.push({
        kind: 'message',
        at: at(),
        text: result.message,
        question: status === 'waiting_user',
      });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  timeline.sort((a, b) => a.at - b.at);
  const scored = score(scenario, timeline, calls);
  if (scenario.answer) {
    scored.checks.completed = status === 'succeeded' && !error;
    scored.checks.fixtureReadsOnly = violations.get(turnId)!.length === 0;
  }
  const usageEvents = [...usage.values()];
  return {
    scenario: scenario.id,
    attempt,
    seconds: at(),
    ...(error ? { error } : {}),
    status,
    calls,
    violations: violations.get(turnId)!,
    usage: usageEvents,
    costUsd:
      usageEvents.length && usageEvents.every((event) => event.costUsd !== null)
        ? usageEvents.reduce((sum, event) => sum + event.costUsd!, 0)
        : null,
    inputHash: hash(JSON.stringify(scenario)),
    promptHash: hash(scenario.prompt),
    systemPromptHash: promptHashes.get(turnId),
    ...(scenario.answer
      ? { review: scenario.answer.review.map((check) => ({ check, status: 'pending' as const })) }
      : {}),
    timeline,
    ...scored,
  };
}

function escape(value: string) {
  return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

async function writeReport(labels: string[]) {
  const runs: Record<string, Run[]> = {};
  const planned: Record<string, { ids: string[]; repeat: number; finished: boolean }> = {};
  for (const name of labels) {
    const record = JSON.parse(await readFile(join(outputDir, `${name}.json`), 'utf8'));
    runs[name] = record.runs;
    const ids = [...new Set(runs[name].map((run) => run.scenario))];
    planned[name] = {
      ids: record.matrix?.map((scenario: VoiceScenario) => scenario.id) ?? ids,
      repeat:
        record.repeat ??
        Math.max(1, ...ids.map((id) => runs[name].filter((run) => run.scenario === id).length)),
      finished: !('finishedAt' in record) || Boolean(record.finishedAt),
    };
  }
  const cell = (run: Run | undefined) => {
    if (!run) return '<td class="empty">not run</td>';
    const chips = Object.entries(run.checks)
      .map(([name, ok]) => `<span class="chip ${ok ? 'ok' : 'bad'}">${name}</span>`)
      .join('');
    const lines = run.timeline
      .map((entry) =>
        entry.kind === 'tool'
          ? `<div class="tool"><b>${entry.at.toFixed(1)}s</b> ${escape(entry.name)} ${escape(JSON.stringify(entry.input)).slice(0, 90)}</div>`
          : entry.kind === 'result'
            ? `<details class="tool"><summary>${entry.at.toFixed(1)}s ${escape(entry.name)} ${escape(entry.status)}</summary><pre>${escape(JSON.stringify(entry.output) ?? '')}</pre></details>`
            : `<div class="msg${entry.question ? ' q' : ''}"><b>${entry.at.toFixed(1)}s</b>${escape(entry.text)}</div>`,
      )
      .join('');
    const first = run.metrics.firstMessage === null ? 'none' : `${run.metrics.firstMessage}s`;
    const review =
      run.review
        ?.map((item) => `<li>${escape(item.check)} — ${escape(item.status)}</li>`)
        .join('') ?? '';
    return `<td><div class="meta">first msg ${first} · ${run.metrics.bubbles} bubbles · max ${run.metrics.maxWords} words · ${run.seconds}s · cost ${run.costUsd == null ? 'unknown' : `$${run.costUsd.toFixed(4)}`}</div><div>${chips}</div>${run.error ? `<div class="err">${escape(run.error)}</div>` : ''}${lines || '<div class="silent">(sent nothing)</div>'}${review ? `<details><summary>Semantic review pending</summary><ul>${review}</ul><pre>${escape(JSON.stringify(run.calls, null, 2))}</pre></details>` : ''}</td>`;
  };
  const rows = scenarios
    .filter((scenario) => labels.some((name) => planned[name].ids.includes(scenario.id)))
    .map((scenario) => {
      const attempts = Math.max(
        1,
        ...labels.map((name) =>
          planned[name].ids.includes(scenario.id) ? planned[name].repeat : 0,
        ),
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
      const plan = planned[name];
      const groups = plan.ids.map((id) => runs[name].filter((run) => run.scenario === id));
      const passed = (run: Run) => !run.error && Object.values(run.checks).every(Boolean);
      const once = groups.filter((group) => group.some(passed)).length;
      const completed = groups.map((group) => new Set(group.map((run) => run.attempt)).size);
      const missing = completed.reduce((sum, count) => sum + Math.max(0, plan.repeat - count), 0);
      const every = groups.filter(
        (group, index) => completed[index] === plan.repeat && group.every(passed),
      ).length;
      const missingCases = groups.filter((group) => group.length === 0).length;
      const state =
        plan.finished && !missing
          ? 'complete'
          : `incomplete: ${missing} planned attempts missing across ${missingCases} unrun cases`;
      return `<th>${escape(name)}<div class="meta">${state} · ${all.filter(Boolean).length}/${all.length} recorded checks pass · automatic pass at least once ${once}/${groups.length} · every planned attempt ${every}/${groups.length}</div></th>`;
    })
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><title>Nod voice eval</title><style>
body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f6f6f3;color:#1b1b1b}
table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{border:1px solid #ddd;padding:10px;vertical-align:top;background:#fff;text-align:left}
thead th{position:sticky;top:0;background:#fafafa}.title{font-weight:600}.prompt{margin:6px 0;font-family:ui-monospace,monospace;font-size:12px}
.good{color:#2d6a3e;font-weight:400;font-size:13px}.meta{color:#777;font-size:12px;font-weight:400}
.msg{background:#e8f0fe;border-radius:12px;padding:6px 10px;margin:6px 0;white-space:pre-wrap;max-width:95%}.msg.q{background:#fff4d6}
.msg b,.tool b{font-weight:500;color:#888;margin-right:6px;font-size:11px}.tool{color:#999;font-size:11px;font-family:ui-monospace,monospace;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.chip{display:inline-block;font-size:11px;border-radius:4px;padding:1px 6px;margin:2px 3px 2px 0}.ok{background:#dff3e4;color:#1d6b35}.bad{background:#fbe1e1;color:#a02121}
.err{color:#a02121}.silent{color:#999;font-style:italic;margin-top:6px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px}details.tool{white-space:normal}
</style><h1>Nod voice eval</h1><table><thead><tr><th style="width:22%">Scenario</th>${totals}</tr></thead><tbody>${rows}</tbody></table>`;
  const path = join(outputDir, 'report.html');
  await writeFile(path, html);
  return path;
}

const evaluatedPrompt =
  promptOverride ??
  systemPrompt(
    workspace.open({
      threadId: 'manifest',
      workspacePath: '/workspace/eval',
      signal: new AbortController().signal,
    }),
  );
const matrix = selected.map((scenario) => ({
  ...scenario,
  inputHash: hash(JSON.stringify(scenario)),
  promptHash: hash(scenario.prompt),
  timeoutMs: scenario.answer ? 90_000 : 240_000,
  ...(scenario.answer ? { maxToolCalls: 12 } : {}),
}));
if (args.includes('--dry-run')) {
  console.log(
    JSON.stringify(
      {
        set,
        commit,
        repeat,
        turns: selected.length * repeat,
        systemPromptHash: hash(evaluatedPrompt),
        cases: matrix,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (args.includes('--report-only')) {
  console.log(await writeReport(compare));
  process.exit(0);
}
if (selected.some((scenario) => scenario.answer) && !args.includes('--live'))
  throw new Error(
    'Answer evaluations require --live after explicit authorization for manual model evaluation. Use --dry-run to review without model calls.',
  );
await mkdir(outputDir, { recursive: true });
const environment = {
  ...parse(await readFile(join(repository, '.env'), 'utf8').catch(() => '')),
  ...process.env,
};
const provider = environment.LLM_PROVIDER || 'openai';
const apiKey =
  provider === 'anthropic'
    ? environment.ANTHROPIC_API_KEY
    : provider === 'openrouter'
      ? environment.OPENROUTER_API_KEY
      : environment.OPENAI_API_KEY;
const model = environment.LLM_MODEL || agentModels[provider as keyof typeof agentModels];
if (!apiKey)
  throw new Error('Configure the selected real model key before running the manual evaluation.');
const runs: Run[] = [];
const recordPath = join(outputDir, `${label}.json`);
const runRecord = {
  label,
  set,
  commit,
  provider,
  model,
  thinkingLevel: 'high',
  repeat,
  systemPromptHash: hash(evaluatedPrompt),
  matrix,
  startedAt: new Date().toISOString(),
  finishedAt: null as string | null,
  runs,
};
await writeFile(recordPath, JSON.stringify(runRecord, null, 2), { flag: 'wx' });
const sessionRoot = await mkdtemp(join(tmpdir(), 'nod-voice-sessions-'));
const agent = createPiAgent({ provider, model, apiKey, sessionRoot });
const refused = (turnId: string, name: string) =>
  Boolean(turns.get(turnId)?.answer) && !answerTools.has(name);
const intercept = async (turnId: string, name: string, run: () => Promise<AgentToolResult>) => {
  if (refused(turnId, name)) {
    violations.get(turnId)!.push(name);
    throw new Error('Only the supplied read-only fixtures are available in this evaluation.');
  }
  if (turns.get(turnId)?.answer || !webTools.has(name)) return run();
  const results = Object.values(turns.get(turnId)?.search ?? {}).flat();
  await sleep(3000);
  return (name === 'web_search'
    ? { source: 'eval', results }
    : 'Full page content is not available in this evaluation. Use the search results.') as unknown as AgentToolResult;
};
const runtime = createAgentRuntime({
  agent: {
    open: (input) => {
      const prompt = promptOverride ?? input.systemPrompt;
      promptHashes.set(input.turnId, hash(prompt));
      return agent.open({
        ...input,
        systemPrompt: prompt,
        tools: input.tools.map((tool) => ({
          ...tool,
          execute: (args) =>
            refused(input.turnId, tool.name)
              ? input.runTool(tool.name, args, () =>
                  intercept(input.turnId, tool.name, () => tool.execute(args)),
                )
              : tool.execute(args),
        })),
        runTool: (name, params, run, options) =>
          input.runTool(name, params, () => intercept(input.turnId, name, run), options),
        onEvent: (event) => {
          if (event.type === 'model_usage') observers.get(input.turnId)?.(event);
          input.onEvent(event);
        },
      });
    },
    dispose: () => agent.dispose(),
  },
  computer,
  workspace,
  observe: (turnId, event) => observers.get(turnId)?.(event),
});
console.log(`${provider}/${model} · ${selected.length} scenarios × ${repeat} → ${label}`);
try {
  for (let attempt = 0; attempt < repeat; attempt += 1) {
    if (selected.some((scenario) => scenario.answer)) {
      for (const scenario of selected) {
        runs.push(await runScenario(runtime, scenario, attempt));
        await writeFile(recordPath, JSON.stringify(runRecord, null, 2));
        console.log(`${scenario.id} attempt ${attempt + 1}/${repeat} recorded`);
      }
    } else {
      const batch = await Promise.all(
        selected.map((scenario) => runScenario(runtime, scenario, attempt)),
      );
      runs.push(...batch);
      await writeFile(recordPath, JSON.stringify(runRecord, null, 2));
    }
  }
} finally {
  await runtime.dispose().catch(() => {});
  await rm(sessionRoot, { recursive: true, force: true });
}
runRecord.finishedAt = new Date().toISOString();
await writeFile(recordPath, JSON.stringify(runRecord, null, 2));
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
