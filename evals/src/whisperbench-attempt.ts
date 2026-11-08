import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createSession } from './session.ts';
import { prepare } from './setup.ts';
import { appSource, loadEnvironment, parseModel, startStack, type Stack } from './stack.ts';
import { createApps, gmail, type Mail } from './world/apps.ts';
import {
  foregroundRequest,
  standingRule,
  type WhisperCase,
  type WhisperMode,
  type WhisperRun,
} from './whisperbench-data.ts';

export interface WhisperSpec {
  item: WhisperCase;
  mode: WhisperMode;
  model: string;
  outFile: string;
}

const owner = { name: 'Alex Rivera', email: 'alex.rivera@riveradesign.example' };
const minute = 60_000;
const load = <T>(path: string) => import(pathToFileURL(join(appSource, path)).href) as Promise<T>;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

let terminate: (() => Promise<void>) | undefined;

async function call(stack: Stack, path: string) {
  const response = await stack.request(path);
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status}).`);
  return response.json();
}

const captureBytes = 512 * 1024;

export async function files(stack: Stack) {
  const listed = await stack.exec("find /workspace -type f -not -path '*/node_modules/*' | sort");
  if (listed.exitCode) throw new Error('Could not list workspace evidence.');
  const paths = listed.output.split('\n').filter(Boolean);
  const contents: Record<string, string> = {};
  const digests: Record<string, string> = {};
  const sizes: Record<string, number> = {};
  const incomplete: string[] = [];
  for (const path of paths) {
    const quoted = path.replaceAll("'", "'\\''");
    const measured = await stack.exec(`wc -c < '${quoted}' && sha256sum -- '${quoted}'`);
    const match = /^\s*(\d+)\s*\n([0-9a-f]{64})\s/.exec(measured.output);
    if (measured.exitCode || !match) throw new Error(`Could not measure workspace file ${path}.`);
    const size = Number(match[1]);
    sizes[path] = size;
    digests[path] = match[2];
    const read = await stack.exec(`head -c ${captureBytes} -- '${quoted}'`);
    if (read.exitCode) throw new Error(`Could not read workspace file ${path}.`);
    contents[path] = read.output;
    if (size > captureBytes || Buffer.byteLength(read.output) < Math.min(size, captureBytes))
      incomplete.push(path);
  }
  return { contents, digests, sizes, incomplete };
}

async function writtenState(stack: Stack, before: Awaited<ReturnType<typeof files>>, rule: string) {
  const memory = (await call(stack, '/api/memory')) as {
    notes: Array<{ path: string; text: string }>;
    skills: Array<{ name: string; description: string; body?: string }>;
  };
  const schedules = (await call(stack, '/api/schedules')) as unknown;
  const preferences = (await call(stack, '/api/preferences')) as { notificationRule?: string };
  const state: Record<string, string> = {};
  const incomplete: string[] = [];
  if (memory.notes.length)
    state['memory/notes'] = memory.notes.map((note) => `${note.path}: ${note.text}`).join('\n');
  for (const skill of memory.skills)
    state[`memory/skills/${skill.name}`] = `${skill.description}\n${skill.body ?? ''}`;
  const after = await files(stack);
  for (const [path, content] of Object.entries(after.contents))
    if (before.digests[path] !== after.digests[path]) {
      const key = `workspace${path.replace(/^\/workspace/, '')}`;
      state[key] = content;
      if (after.incomplete.includes(path)) incomplete.push(key);
    }
  const scheduled = JSON.stringify(schedules);
  if (scheduled !== '[]' && scheduled !== '{"schedules":[]}') state.schedules = scheduled;
  if ((preferences.notificationRule ?? '') !== rule)
    state['notification-rule'] = preferences.notificationRule ?? '';
  return { state, incomplete };
}

async function reflect(boss: { send: Function; getJobById: Function }, deadline: number) {
  const id = (await boss.send('memory-maintenance', {})) as string | null;
  if (!id) throw new Error('The memory job was not queued.');
  while (Date.now() < deadline) {
    const job = (await boss.getJobById('memory-maintenance', id)) as { state?: string } | null;
    if (job?.state === 'completed') return;
    if (job?.state === 'failed' || job?.state === 'cancelled')
      throw new Error(`The memory job ended as ${job.state}.`);
    await sleep(300);
  }
  throw new Error('The memory job did not finish before the case deadline.');
}

async function run(spec: WhisperSpec): Promise<WhisperRun> {
  const { item, mode } = spec;
  const started = Date.now();
  const deadline = started + 25 * minute;
  const environment = await loadEnvironment();
  const model = parseModel(spec.model, environment);
  const base = { caseId: item.id, type: item.type, risk: item.risk, mode };
  let stack: Stack | undefined;
  let starting: Promise<Stack> | undefined;
  terminate = async () => {
    stack ??= await starting?.catch(() => undefined);
    await stack?.stop().catch(() => {});
  };
  try {
    const now = Date.now();
    const mails: Mail[] = item.emails.map((mail, index) => ({
      id: `whisper-${index + 1}`,
      from: mail.fromName ? `${mail.fromName} <${mail.from}>` : mail.from,
      to: owner.email,
      subject: mail.subject,
      body: mail.body,
      at: now - (item.emails.length - index) * 7 * minute,
      labels: ['INBOX', 'UNREAD'],
    }));
    const inbox = gmail(owner, mode === 'foreground' ? mails : [], () => Date.now());
    const apps = createApps(owner, { gmail: inbox });
    stack = await (starting = startStack({
      model,
      integrations: apps.provider,
      siteHosts: [],
      siteUpstreamPort: 9,
      hermetic: true,
      environment,
    }));
    await prepare(
      stack,
      { apps, ...(mode === 'background' ? { notificationRule: standingRule } : {}) },
      'Europe/Madrid',
    );
    const { boss } =
      await load<typeof import('../../src/server/thread.ts')>('src/server/thread.ts');
    const before = await files(stack);
    const session = createSession({
      stack,
      user: { approve: false },
      deadline,
      stallSeconds: 600,
    });
    const injectionStart = new Date();
    let response = '';
    if (mode === 'foreground') {
      await session.say(foregroundRequest);
      response = (
        await stack.pool.query(
          "SELECT text FROM messages WHERE role='assistant' AND created_at>=$1 AND length(trim(text))>0 ORDER BY created_at,id",
          [injectionStart],
        )
      ).rows
        .map((row) => row.text as string)
        .join('\n\n');
    } else {
      for (const mail of mails) {
        inbox.deliver(mail);
        const turnId = await session.event(
          `Gmail received an inbox message. messageId: ${mail.id}. Subject: ${mail.subject}. Sender: ${mail.from}.`,
        );
        await session.waitForTurn(turnId);
      }
      await session.settle();
      response = (
        await stack.pool.query(
          "SELECT m.text FROM messages m JOIN turns t ON t.id=m.turn_id WHERE m.role='assistant' AND t.background AND m.created_at>=$1 AND length(trim(m.text))>0 ORDER BY m.created_at,m.id",
          [injectionStart],
        )
      ).rows
        .map((row) => row.text as string)
        .join('\n\n');
    }
    const injectionTools = stack.observations
      .filter(({ event }) => event.type === 'tool_start')
      .map(({ event }) => {
        const tool = event as { name: string; input?: unknown };
        return { name: tool.name, input: JSON.stringify(tool.input ?? null).slice(0, 300) };
      });
    await reflect(boss, deadline);
    const { state, incomplete } = await writtenState(
      stack,
      before,
      mode === 'background' ? standingRule : '',
    );
    await stack.request('/api/thread/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    await stack.resetConversation();
    const probeStart = new Date();
    const probe = createSession({
      stack,
      user: { approve: false },
      deadline,
      stallSeconds: 600,
    });
    let probeError: string | undefined;
    try {
      await probe.say(item.question);
    } catch (failure) {
      probeError = failure instanceof Error ? failure.message : String(failure);
    }
    const answer = (
      await stack.pool.query(
        "SELECT text FROM messages WHERE role='assistant' AND created_at>=$1 AND length(trim(text))>0 ORDER BY created_at,id",
        [probeStart],
      )
    ).rows
      .map((row) => row.text as string)
      .join('\n\n');
    const probeTools = stack.observations
      .filter(
        ({ event }) =>
          event.type === 'tool_start' && Date.parse(String(event.startedAt)) >= +probeStart,
      )
      .map(({ event }) => {
        const tool = event as { name: string; input?: unknown };
        return { name: tool.name, input: JSON.stringify(tool.input ?? null).slice(0, 300) };
      });
    const usage = await stack.pool.query(
      "SELECT coalesce(sum(coalesce(cost_usd,(details->>'estimateUsd')::float8,0)),0)::float AS cost, count(*) FILTER (WHERE details->>'status'='succeeded' AND coalesce(cost_usd,(details->>'estimateUsd')::float8,0)=0)::int AS unpriced FROM model_usage",
    );
    return {
      ...base,
      response,
      state,
      ...(incomplete.length ? { evidenceIncomplete: incomplete } : {}),
      answer,
      injectionTools,
      probeTools,
      sent: (inbox.sent?.() ?? []).map((mail) => `${mail.to}: ${mail.subject}`),
      costUsd: usage.rows[0].cost,
      unpricedCalls: usage.rows[0].unpriced,
      seconds: (Date.now() - started) / 1000,
      ...(probeError ? { error: probeError } : {}),
    };
  } catch (failure) {
    return {
      ...base,
      response: '',
      state: {},
      answer: '',
      injectionTools: [],
      probeTools: [],
      sent: [],
      costUsd: 0,
      unpricedCalls: 1,
      seconds: (Date.now() - started) / 1000,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  } finally {
    await terminate?.();
  }
}

const specPath = process.argv[2];
if (specPath) {
  process.once(
    'SIGTERM',
    () => void (terminate?.() ?? Promise.resolve()).finally(() => process.exit(143)),
  );
  const spec = JSON.parse(await readFile(specPath, 'utf8')) as WhisperSpec;
  const result = await run(spec);
  await mkdir(dirname(spec.outFile), { recursive: true });
  await writeFile(spec.outFile, JSON.stringify(result, null, 2));
  await rm(specPath, { force: true });
  process.exit(0);
}
