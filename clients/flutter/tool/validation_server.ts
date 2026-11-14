import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { registerLocalAccess } from '../../../src/server/access.ts';

interface FixtureMessage {
  id: string;
  clientMessageId?: string;
  role: 'user' | 'assistant';
  text: string;
  turnId: string;
  createdAt: string;
  replyToMessageId?: string;
  answerChoices?: { multiple: boolean; options: { id: string; label: string }[] };
  answerChoicesPending?: boolean;
}

interface FixtureStore {
  messages: FixtureMessage[];
  turn: 'idle' | 'running' | 'waiting' | 'cancelled';
  parity?: {
    question: 'pending' | 'answered' | 'replaced';
    task: 'pending' | 'answered';
    source: boolean;
    privateStatus: 'pending' | 'filled' | 'expired';
    dispatches: number;
    taskDispatches: number;
    refusals: number;
    privateSubmissions: number;
    accountWrites: number;
    aroundReads: number;
    linkReady?: boolean;
    theme: 'light' | 'dark';
    usageData: boolean;
    traces: boolean;
  };
}

const port = Number(process.env.NOD_VALIDATION_PORT);
const token = process.env.NOD_VALIDATION_TOKEN ?? '';
const controlToken = process.env.NOD_VALIDATION_CONTROL_TOKEN ?? '';
const dataPath = process.env.NOD_VALIDATION_DATA ?? '';
const origin = `http://127.0.0.1:${port}`;
const threadId = '00000000-0000-4000-8000-000000000001';
const questionId = '00000000-0000-4000-8000-000000000101';
const choiceId = '00000000-0000-4000-8000-000000000102';
const taskQuestionId = '00000000-0000-4000-8000-000000000103';
const taskId = '00000000-0000-4000-8000-000000000104';
const preparedId = '00000000-0000-4000-8000-000000000105';
const privateId = 'synthetic_private_request_00000000000000000';
const taskQuestion: FixtureMessage = {
  id: taskQuestionId,
  role: 'assistant',
  text: 'Synthetic older task question: continue the draft?',
  turnId: taskId,
  createdAt: '2026-11-06T11:00:00.000Z',
};
const initialStore: FixtureStore = {
  turn: 'idle',
  messages: [
    {
      id: '00000000-0000-4000-8000-000000000002',
      role: 'assistant',
      text: 'Synthetic history ready',
      turnId: '00000000-0000-4000-8000-000000000003',
      createdAt: '2026-11-06T12:00:00.000Z',
    },
  ],
};

if (!Number.isInteger(port) || port < 1 || port > 65535 || !token || !controlToken || !dataPath)
  throw new Error('Invalid validation fixture configuration.');

const store = JSON.parse(
  await readFile(dataPath, 'utf8').catch(() => JSON.stringify(initialStore)),
) as FixtureStore;
let persistence = Promise.resolve();
const persist = () => {
  const snapshot = JSON.stringify(store);
  persistence = persistence.then(() => writeFile(dataPath, snapshot));
  return persistence;
};
const app = Fastify({ logger: false, trustProxy: false, forceCloseConnections: true });
const streams = new Set<ServerResponse>();
const frame = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`;
const emit = (payload: object) => {
  const event = frame(payload);
  for (const stream of streams) if (!stream.destroyed) stream.write(event);
};
const emitRefresh = () => emit({ type: 'refresh' });
const controlled = (headers: Record<string, unknown>) =>
  headers['x-fixture-control'] === controlToken;
const view = () => ({
  threadId,
  revision: `${store.messages.length}:${store.turn}:${JSON.stringify(store.parity)}`,
  pendingAnswerChoiceMessageIds: store.parity?.question === 'pending' ? [questionId] : [],
  configuration: { conversationResetEnabled: false },
  messages: store.messages,
  turns: [
    {
      id: '00000000-0000-4000-8000-000000000004',
      status: store.turn,
      createdAt: '2026-11-06T12:00:00.000Z',
    },
  ],
  turn: store.turn,
});

registerLocalAccess(app, port, { key: token, origin, bearer: true });
app.addHook('preClose', async () => {
  for (const stream of streams) stream.end();
});
app.get('/api/client/capabilities', async () => ({
  contractVersion: 1,
  authentication: { mode: 'bearer' },
}));
app.get('/api/session', async () => ({
  threadId,
  user: { id: '00000000-0000-4000-8000-000000000005' },
  settings: {
    onboardingCompleted: true,
    theme: store.parity?.theme ?? 'light',
    usageData: store.parity?.usageData ?? false,
    traces: store.parity?.traces ?? false,
  },
  capabilities: { traces: true },
}));
app.get('/fixture/info', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  return { fixture: 'nod-synthetic-validation-v1', syntheticOnly: true };
});
app.get('/api/schedules', async () => []);
app.get('/api/trust', async () => ({
  month: {
    start: '2026-11-01T00:00:00.000Z',
    days: 30,
    elapsedDays: 9,
    spentUsd: 0,
    forecastUsd: 0,
    planUsd: 0,
    planUsage: false,
    unpriced: false,
    daily: [0],
  },
  entries: [],
  next: null,
  limit: null,
}));
app.get('/api/state', async () => view());
app.get('/api/messages', async () => ({ messages: store.messages, hasMore: false }));
app.post('/api/messages', async (request, reply) => {
  const body = request.body as {
    clientMessageId?: unknown;
    text?: unknown;
    threadId?: unknown;
    replyToMessageId?: unknown;
    questionAnswer?: { choiceIds?: unknown };
  };
  if (
    typeof body?.clientMessageId !== 'string' ||
    typeof body.text !== 'string' ||
    (body.threadId !== undefined && body.threadId !== threadId)
  )
    return reply.code(400).send({ error: 'Invalid synthetic message.' });
  const existing = store.messages.find(
    (message) =>
      message.clientMessageId === body.clientMessageId || message.id === body.clientMessageId,
  );
  if (existing) return { messageId: existing.id, turnId: existing.turnId };
  const parity = store.parity;
  if (parity) {
    const choice = body.replyToMessageId === questionId;
    const task = body.replyToMessageId === taskQuestionId;
    const allowed =
      body.threadId === threadId &&
      ((choice &&
        parity.question === 'pending' &&
        body.text === 'Use synthetic draft' &&
        JSON.stringify(body.questionAnswer) === JSON.stringify({ choiceIds: [choiceId] })) ||
        (task &&
          parity.task === 'pending' &&
          body.text === 'Continue synthetic task' &&
          body.questionAnswer === undefined));
    if (!allowed) {
      parity.refusals++;
      await persist();
      return reply.code(409).send({ code: 'question_unavailable' });
    }
    if (choice) {
      parity.question = 'answered';
      parity.dispatches++;
      const question = store.messages.find((item) => item.id === questionId)!;
      question.answerChoicesPending = false;
    } else {
      parity.task = 'answered';
      parity.taskDispatches++;
    }
  }
  const message: FixtureMessage = {
    id: body.clientMessageId,
    clientMessageId: body.clientMessageId,
    role: 'user',
    text: body.text,
    ...(typeof body.replyToMessageId === 'string'
      ? { replyToMessageId: body.replyToMessageId }
      : {}),
    turnId: body.replyToMessageId === taskQuestionId ? taskId : randomUUID(),
    createdAt: new Date(Date.UTC(2026, 10, 6, 12, 0, store.messages.length)).toISOString(),
  };
  store.messages.push(message);
  store.turn = parity ? 'idle' : 'running';
  await persist();
  emitRefresh();
  return { messageId: message.id, turnId: message.turnId };
});
app.post('/api/thread/stop', async () => {
  store.turn = 'cancelled';
  await persist();
  emitRefresh();
  return { ok: true };
});
app.get('/api/events', async (_request, reply) => {
  reply.hijack();
  streams.add(reply.raw);
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  reply.raw.write(frame({ type: 'refresh' }));
  reply.raw.on('close', () => streams.delete(reply.raw));
});
app.post('/fixture/stream', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  emit({
    type: 'activity',
    items: [
      {
        turnId: '00000000-0000-4000-8000-000000000006',
        title: 'Synthetic validation work',
        since: '2026-11-06T12:01:00.000Z',
      },
    ],
  });
  emit({
    type: 'delta',
    threadId,
    turnId: '00000000-0000-4000-8000-000000000006',
    streamId: 'synthetic-validation-stream',
    text: 'Synthetic streamed reply',
    done: false,
  });
  return { ok: true };
});
app.post('/fixture/wait', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  store.turn = 'waiting';
  await persist();
  emitRefresh();
  return { ok: true };
});
app.post('/fixture/interrupt', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  const body = request.body as { id?: unknown; text?: unknown };
  if (typeof body?.id !== 'string' || typeof body.text !== 'string')
    return reply.code(400).send({ error: 'Invalid synthetic interruption.' });
  for (const stream of [...streams]) stream.end();
  if (!store.messages.some((message) => message.id === body.id)) {
    store.messages.push({
      id: body.id,
      role: 'assistant',
      text: body.text,
      turnId: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 10, 6, 12, 0, store.messages.length)).toISOString(),
    });
    await persist();
  }
  return { ok: true };
});
app.post('/fixture/reply', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  const body = request.body as { id?: unknown; text?: unknown };
  if (typeof body?.id !== 'string' || typeof body.text !== 'string')
    return reply.code(400).send({ error: 'Invalid synthetic reply.' });
  if (!store.messages.some((message) => message.id === body.id)) {
    store.messages.push({
      id: body.id,
      role: 'assistant',
      text: body.text,
      turnId: randomUUID(),
      createdAt: new Date(Date.UTC(2026, 10, 6, 12, 0, store.messages.length)).toISOString(),
    });
    await persist();
  }
  emitRefresh();
  return { ok: true };
});

app.post<{ Params: { action: string } }>('/fixture/parity/:action', async (request, reply) => {
  if (!controlled(request.headers)) return reply.code(401).send({ error: 'Unauthorized.' });
  const action = request.params.action;
  if (action === 'seed') {
    if (store.parity) return reply.code(409).send({ error: 'Use a fresh fixture directory.' });
    store.parity = {
      question: 'pending',
      task: 'pending',
      source: true,
      privateStatus: 'pending',
      dispatches: 0,
      taskDispatches: 0,
      refusals: 0,
      privateSubmissions: 0,
      accountWrites: 0,
      aroundReads: 0,
      theme: 'light',
      usageData: false,
      traces: false,
    };
    for (const [id, text] of [
      [questionId, 'Synthetic pending choice'],
      [preparedId, `Synthetic finding [View prepared result](/prepared/${preparedId})`],
      [privateId, `Synthetic private step [Open private entry](/credentials/${privateId})`],
    ]) {
      store.messages.push({
        id: id === privateId ? '00000000-0000-4000-8000-000000000106' : id,
        role: 'assistant',
        text,
        turnId: taskId,
        createdAt: '2026-11-06T12:02:00.000Z',
        ...(id === questionId
          ? {
              answerChoices: {
                multiple: false,
                options: [{ id: choiceId, label: 'Use synthetic draft' }],
              },
              answerChoicesPending: true,
            }
          : {}),
      });
    }
    store.turn = 'idle';
  } else if (!store.parity) {
    return reply.code(409).send({ error: 'Seed the synthetic workflows first.' });
  } else if (action === 'replace-question') {
    store.parity.question = 'replaced';
    store.messages.find((item) => item.id === questionId)!.answerChoicesPending = false;
  } else if (action === 'remove-source') {
    store.parity.source = false;
  } else if (action === 'expire-private') {
    store.parity.privateStatus = 'expired';
  } else if (action === 'link-ready') {
    store.parity.linkReady = true;
  } else if (action !== 'inspect') {
    return reply.code(404).send({ error: 'Unknown fixture action.' });
  }
  await persist();
  if (action !== 'inspect') emitRefresh();
  return {
    marker: 'synthetic-parity-v1',
    ...store.parity,
    chatSends: store.messages.filter((item) => item.role === 'user').length,
  };
});
app.get('/api/preferences', async () => ({
  hourCycle: 'auto',
  rules: '',
  locale: null,
  timeZone: null,
}));
app.patch('/api/account', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  const parity = store.parity;
  if (!parity || !body || Object.keys(body).length !== 1)
    return reply.code(400).send({ error: 'Invalid synthetic settings.' });
  if (body.theme === 'light' || body.theme === 'dark') parity.theme = body.theme;
  else if (typeof body.usageData === 'boolean') parity.usageData = body.usageData;
  else if (typeof body.traces === 'boolean') parity.traces = body.traces;
  else return reply.code(400).send({ error: 'Unsupported synthetic settings.' });
  parity.accountWrites++;
  await persist();
  return { ok: true };
});
const taskView = () => ({
  id: taskId,
  title: 'Synthetic saved task',
  status: store.parity?.task === 'answered' ? 'working' : 'needs_you',
  now: 'Synthetic task state',
  result: 'Synthetic task result',
  doneWhen: 'The draft is ready',
  waitingFor: [],
  question: taskQuestion.text,
  questionMessageId: taskQuestionId,
  messageId: questionId,
  createdAt: taskQuestion.createdAt,
});
app.get('/api/tasks', async () => (store.parity ? [taskView()] : []));
app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
  if (!store.parity || request.params.id !== taskId)
    return reply.code(404).send({ error: 'Unavailable.' });
  return { task: taskView(), events: [] };
});
app.get<{ Params: { id: string } }>('/api/messages/around/:id', async (request, reply) => {
  if (!store.parity || request.params.id !== taskQuestionId)
    return reply.code(404).send({ error: 'Unavailable.' });
  store.parity.aroundReads++;
  await persist();
  return [taskQuestion];
});
app.get<{ Params: { id: string } }>('/api/prepared/:id', async (request, reply) => {
  if (!store.parity?.source || request.params.id !== preparedId)
    return reply.code(404).send({ error: 'Source removed.' });
  return {
    id: preparedId,
    title: 'Synthetic prepared result',
    draft: 'Synthetic source-bound draft',
    state: 'offered',
    updatedAt: '2026-11-06T12:00:00.000Z',
    unknowns: [],
    sources: [
      {
        sourceId: 'synthetic-source',
        id: 'synthetic-record',
        version: '1',
        label: 'Synthetic source record',
        checkedAt: '2026-11-06T12:00:00.000Z',
      },
    ],
  };
});
app.get<{ Params: { id: string } }>('/api/credential-requests/:id', async (request, reply) => {
  if (!store.parity || request.params.id !== privateId)
    return reply.code(404).send({ error: 'Unavailable.' });
  return {
    id: privateId,
    status: store.parity.privateStatus,
    kind: 'method',
    origin: 'https://synthetic.example.test',
    methods: [{ id: 'synthetic-method', label: 'Synthetic sign-in method' }],
  };
});
app.get('/api/credential-requests/:id/flow', async () => ({ nextId: null }));
app.post<{ Params: { id: string } }>(
  '/api/credential-requests/:id/method',
  async (request, reply) => {
    const parity = store.parity;
    const body = request.body as { methodId?: unknown };
    if (
      !parity ||
      request.params.id !== privateId ||
      parity.privateStatus !== 'pending' ||
      body?.methodId !== 'synthetic-method'
    )
      return reply.code(409).send({ error: 'Request replaced.' });
    parity.privateStatus = 'filled';
    parity.privateSubmissions++;
    await persist();
    return { ok: true };
  },
);
app.get('/api/apps', async () => []);
app.get('/api/apps/catalog', async () => []);
app.get('/api/vault', async () => []);
app.get('/api/vault/sessions', async () => []);

await app.listen({ host: '127.0.0.1', port });
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const close = async () => {
  await app.close();
  await persistence;
};
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
process.once('SIGINT', () => void close().then(() => process.exit(0)));
