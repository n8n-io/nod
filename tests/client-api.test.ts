import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Fastify from 'fastify';
import { accessCookie, registerLocalAccess } from '../src/server/access.ts';
import { registerClientApi } from '../src/server/client-api.ts';
import {
  clientCapabilities,
  clientCapabilitiesSchema,
  clientHistoryQuerySchema,
  clientHistorySchema,
  clientSendRequestSchema,
  clientSendResponseSchema,
  clientSessionSchema,
  clientSseEventSchema,
  clientStateSchema,
  clientStopResponseSchema,
  type ClientHistory,
  type ClientSendResponse,
  type ClientSession,
  type ClientSseEvent,
  type ClientState,
} from '../src/shared/client-api.ts';

const fixtureRoot = new URL('../clients/flutter/test/fixtures/client-api/', import.meta.url);

async function fixture(name: string) {
  return JSON.parse(await readFile(new URL(name, fixtureRoot), 'utf8')) as unknown;
}

test('Flutter client fixtures match the shared server contract', async () => {
  const session: ClientSession = clientSessionSchema.parse(await fixture('session.json'));
  const state: ClientState = clientStateSchema.parse(await fixture('state.json'));
  const history: ClientHistory = clientHistorySchema.parse(await fixture('history.json'));
  const events = (await fixture('sse-events.json')) as unknown[];
  const parsedEvents: ClientSseEvent[] = events.map((event) => clientSseEventSchema.parse(event));

  assert.equal(session.user?.id, 'synthetic-owner');
  assert.equal(state.messages.length, 2);
  assert.equal(history.hasMore, false);
  assert.deepEqual(
    parsedEvents.map((event) => event.type),
    ['refresh', 'delta', 'delta', 'activity'],
  );

  clientHistoryQuerySchema.parse({
    threadId: state.threadId,
    before: history.messages[0]!.createdAt,
    beforeId: history.messages[0]!.id,
  });
  clientSendRequestSchema.parse({
    text: 'Send a synthetic message.',
    clientMessageId: 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004',
    threadId: state.threadId,
  });
  const response: ClientSendResponse = clientSendResponseSchema.parse({
    threadId: state.threadId,
    turnId: '538a7c2d-a2a1-42a3-bc84-c98b777d87cc',
    messageId: 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004',
  });
  assert.equal(response.messageId, 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004');
  assert.deepEqual(clientStopResponseSchema.parse({ ok: true }), { ok: true });
});

test('native rich result payloads survive state serialization with safety-critical details', async () => {
  const state = clientStateSchema.parse(await fixture('state.json'));
  const visuals = (await fixture('rich-results.json')) as unknown[];
  const parsed = clientStateSchema.parse({
    ...state,
    messages: visuals.map((presentation) => ({ ...state.messages[1], presentation })),
  });
  assert.deepEqual(
    parsed.messages.map((message) => message.presentation),
    visuals,
  );
});

test('native question state and addressed replies preserve the server contract', async () => {
  const state = clientStateSchema.parse(await fixture('state.json'));
  const message = state.messages[1]!;
  const choiceId = 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004';
  const question = {
    ...message,
    answerChoices: {
      options: [{ id: choiceId, label: 'Use the draft', description: 'Keep it private' }],
      multiple: false,
    },
    answerChoicesPending: true,
  };
  const parsed = clientStateSchema.parse({
    ...state,
    messages: [question],
    pendingAnswerChoiceMessageIds: [question.id],
  });
  assert.deepEqual(parsed.messages[0]!.answerChoices, question.answerChoices);
  const reply = {
    text: 'Use the draft: Keep it private',
    threadId: state.threadId,
    clientMessageId: choiceId,
    replyToMessageId: question.id,
    questionAnswer: { choiceIds: [choiceId] },
  };
  assert.deepEqual(clientSendRequestSchema.parse(reply), reply);
  assert.equal(
    clientSendRequestSchema.safeParse({ ...reply, replyToMessageId: undefined }).success,
    false,
  );
  assert.equal(
    clientSendRequestSchema.safeParse({ ...reply, questionAnswer: { approved: true } }).success,
    false,
  );
  assert.equal(
    clientSendRequestSchema.safeParse({ ...reply, questionAnswer: { custom: true } }).success,
    true,
  );
});

test('native send contract accepts attachment-only messages but rejects empty and invalid attachment payloads', () => {
  const base = {
    text: '',
    clientMessageId: 'c5ed5115-813d-4d3d-a6ce-94b6d36ce004',
    threadId: '538a7c2d-a2a1-42a3-bc84-c98b777d87cc',
  };
  assert.equal(clientSendRequestSchema.safeParse(base).success, false);
  assert.equal(
    clientSendRequestSchema.safeParse({ ...base, attachmentIds: ['foreign-path'] }).success,
    false,
  );
  assert.deepEqual(
    clientSendRequestSchema.parse({ ...base, attachmentIds: [base.clientMessageId] }),
    { ...base, attachmentIds: [base.clientMessageId] },
  );
});

test('client capabilities require bearer auth without weakening host or origin controls', async (t) => {
  const key = randomBytes(32).toString('base64url');
  const app = Fastify({ trustProxy: false });
  t.after(() => app.close());
  registerLocalAccess(app, 4310, { key, origin: 'https://nod.example', bearer: true });
  registerClientApi(app);

  const authorized = { host: 'nod.example', authorization: `Bearer ${key}` };
  const response = await app.inject({
    url: '/api/client/capabilities',
    headers: authorized,
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(clientCapabilitiesSchema.parse(response.json()), clientCapabilities);
  assert.equal(response.body.includes(key), false);

  for (const headers of [
    { host: 'nod.example' },
    { host: 'nod.example', cookie: `${accessCookie(4310)}=${key}` },
    { host: 'nod.example', authorization: 'Bearer wrong' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 401);

  for (const headers of [
    { ...authorized, host: 'attacker.example', 'x-forwarded-host': 'nod.example' },
    { ...authorized, origin: 'https://attacker.example' },
    { ...authorized, 'sec-fetch-site': 'cross-site' },
  ])
    assert.equal((await app.inject({ url: '/api/client/capabilities', headers })).statusCode, 403);
});
