import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type pg from 'pg';
import type { Stack } from './stack.ts';
import type { UserScript } from './scenario.ts';
import type { Simulator } from './judge.ts';

export interface Interaction {
  kind: 'question' | 'chat' | 'approval' | 'secret' | 'unanswered' | 'stalled';
  text: string;
  reply?: string;
  action?: string;
  requestKind?: 'otp' | 'payment';
  at: number;
}

export interface Session {
  followUp(): Promise<void>;
  say(text: string, options?: { attach?: string[] }): Promise<void>;
  sayTogether(texts: string[]): Promise<void>;
  interruptWhen(first: string, ready: () => Promise<boolean>): Promise<void>;
  sayDuringWithAttachments(first: string, interjection: string, attach: string[]): Promise<void>;
  upload(name: string, bytes: Buffer, mimeType?: string): Promise<string>;
  api(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>;
  fireSchedules(): Promise<number>;
  event(summary: string): Promise<string>;
  waitForTurn(turnId: string): Promise<void>;
  settle(): Promise<void>;
  reset(): Promise<void>;
  assistantCount(): Promise<number>;
  lastReply(): Promise<string>;
  workspace: {
    exec: Stack['exec'];
    read(path: string): Promise<Buffer | undefined>;
    list(): Promise<string[]>;
  };
  interactions: Interaction[];
  userMessages: Array<{ at: number; text: string }>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function waitUntil(ready: () => Promise<boolean>, deadline: number) {
  while (Date.now() < deadline) {
    if (await ready()) return;
    await sleep(250);
  }
  throw new Error('The test condition was not reached before the case deadline.');
}

export function createSession(options: {
  stack: Stack;
  user: UserScript;
  simulator?: Simulator;
  deadline: number;
  world?: unknown;
  stallSeconds?: number;
}): Session {
  const { stack, user, deadline } = options;
  const stallMs = (options.stallSeconds ?? 240) * 1000;
  const pool: pg.Pool = stack.pool;
  const interactions: Interaction[] = [];
  const userMessages: Array<{ at: number; text: string }> = [];
  let secretIndex = 0;
  let threadId: string | undefined;

  async function post(path: string, body: unknown) {
    const response = await stack.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(`POST ${path} failed (${response.status}): ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : {};
  }

  async function thread() {
    if (threadId) return threadId;
    const state = await (await stack.request('/api/state')).json();
    threadId = state.threadId as string;
    return threadId;
  }

  async function activity() {
    const id = await thread();
    const result = await pool.query(
      `SELECT (SELECT count(*) FROM turn_events e JOIN turns t ON t.id=e.turn_id WHERE t.thread_id=$1) AS events,
              (SELECT count(*) FROM messages WHERE thread_id=$1) AS messages,
              (SELECT count(*) FROM turns WHERE thread_id=$1) AS turns`,
      [id],
    );
    return JSON.stringify(result.rows[0]);
  }

  async function settle() {
    const id = await thread();
    let seen = await activity();
    let changed = Date.now();
    for (;;) {
      const busy = await pool.query(
        "SELECT 1 FROM turns WHERE thread_id=$1 AND status IN ('queued','running') LIMIT 1",
        [id],
      );
      if (!busy.rowCount) return;
      const now = Date.now();
      if (now > deadline) {
        await post('/api/thread/stop', {});
        throw new Error('The scenario exceeded its time limit.');
      }
      const current = await activity();
      if (current !== seen) {
        seen = current;
        changed = now;
      } else if (now - changed > stallMs) {
        interactions.push({ kind: 'stalled', text: 'No progress was recorded.', at: now });
        await post('/api/thread/stop', {});
        throw new Error('The agent made no progress and was stopped.');
      }
      await sleep(250);
    }
  }

  async function lastAssistantText() {
    const id = await thread();
    const result = await pool.query(
      "SELECT text FROM messages WHERE thread_id=$1 AND role='assistant' ORDER BY created_at DESC, id DESC LIMIT 1",
      [id],
    );
    return (result.rows[0]?.text as string | undefined) ?? '';
  }

  async function waiting(scheduled = false) {
    const id = await thread();
    const turn = (
      await pool.query(
        'SELECT id,status,waiting_reason FROM turns WHERE thread_id=$1 AND ($2 OR NOT background) ORDER BY created_at DESC, id DESC LIMIT 1',
        [id, scheduled],
      )
    ).rows[0];
    if (turn?.status !== 'waiting') return undefined;
    const approval = (
      await pool.query(
        "SELECT id,action,args,confirmation_message_id FROM approvals WHERE turn_id=$1 AND status='pending' ORDER BY expires_at DESC LIMIT 1",
        [turn.id],
      )
    ).rows[0];
    const text = await lastAssistantText();
    if (approval) return { kind: 'approval' as const, approval, text };
    if (turn.waiting_reason === 'credentials') {
      const state = await (await stack.request('/api/state')).json();
      return { kind: 'secret' as const, request: state.verificationRequests?.[0], text };
    }
    return { kind: 'question' as const, text };
  }

  async function respond(scheduled = false): Promise<boolean> {
    const pending = await waiting(scheduled);
    if (!pending) return false;
    const at = Date.now();
    if (pending.kind === 'approval') {
      const approve =
        typeof user.approve === 'function'
          ? user.approve(pending.approval.action, pending.approval.args)
          : (user.approve ?? true);
      const reply = approve ? 'Yes' : 'No';
      interactions.push({
        kind: 'approval',
        action: pending.approval.action,
        text: pending.text,
        reply,
        at,
      });
      userMessages.push({ at, text: reply });
      await post('/api/messages', {
        text: reply,
        replyToMessageId: pending.approval.confirmation_message_id,
      });
      return true;
    }
    if (pending.kind === 'secret') {
      const value =
        typeof user.secrets === 'function'
          ? user.secrets(pending.text, options.world)
          : user.secrets?.[secretIndex++];
      if (!value || !pending.request) {
        interactions.push({ kind: 'unanswered', text: pending.text, at });
        return false;
      }
      interactions.push({
        kind: 'secret',
        requestKind: pending.request.kind,
        text: pending.text,
        at,
      });
      await post('/api/messages', { text: value, verificationRequestId: pending.request.id });
      return true;
    }
    const scripted = user.answers?.find((answer) => answer.when.test(pending.text));
    const reply =
      scripted?.say ??
      (user.persona && options.simulator
        ? await options.simulator.reply(user.persona, pending.text)
        : undefined);
    if (!reply) {
      interactions.push({ kind: 'unanswered', text: pending.text, at });
      return false;
    }
    interactions.push({ kind: 'question', text: pending.text, reply, at });
    userMessages.push({ at, text: reply });
    await post('/api/messages', { text: reply });
    return true;
  }

  async function converse() {
    await settle();
    for (let round = 0; round < 12 && (await respond()); round++) await settle();
  }

  const answered = new Set<string>();
  let taskFrom = 0;

  async function chat(): Promise<boolean> {
    const text = await lastAssistantText();
    if (!text.trim() || answered.has(text) || !user.persona || !options.simulator) return false;
    answered.add(text);
    const at = Date.now();
    const generated = await options.simulator.followUp(
      user.persona,
      userMessages[taskFrom]?.text ?? '',
      text,
    );
    if (!generated) return false;
    const reply = user.answers?.find((answer) => answer.when.test(text))?.say ?? generated;
    interactions.push({ kind: 'chat', text, reply, at });
    userMessages.push({ at, text: reply });
    await post('/api/messages', { text: reply });
    return true;
  }

  return {
    interactions,
    userMessages,
    async followUp() {
      for (let round = 0; round < 3 && (await chat()); round++) await converse();
    },
    async say(text, sendOptions) {
      userMessages.push({ at: Date.now(), text });
      await post('/api/messages', { text, attachmentIds: sendOptions?.attach ?? [] });
      await converse();
    },
    async sayTogether(texts) {
      for (const text of texts) {
        userMessages.push({ at: Date.now(), text });
        await post('/api/messages', { text, attachmentIds: [] });
      }
      await converse();
    },
    async interruptWhen(first, ready) {
      userMessages.push({ at: Date.now(), text: first });
      await post('/api/messages', { text: first, attachmentIds: [] });
      await waitUntil(ready, deadline);
      await post('/api/thread/stop', {});
      await settle();
    },
    async sayDuringWithAttachments(first, interjection, attach) {
      userMessages.push({ at: Date.now(), text: first });
      await post('/api/messages', { text: first, attachmentIds: attach });
      const id = await thread();
      await waitUntil(async () => {
        const result = await pool.query(
          "SELECT 1 FROM turn_events e JOIN turns t ON t.id=e.turn_id WHERE t.thread_id=$1 AND NOT t.background AND t.status='running' AND e.type='tool_start' LIMIT 1",
          [id],
        );
        return Boolean(result.rowCount);
      }, deadline);
      userMessages.push({ at: Date.now(), text: interjection });
      await post('/api/messages', { text: interjection, attachmentIds: [] });
      await converse();
    },
    async upload(name, bytes, mimeType = 'application/octet-stream') {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), name);
      const response = await stack.request('/api/uploads', {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      return (await response.json()).id as string;
    },
    async api(method, path, body) {
      if (new URL(path, stack.origin).origin !== stack.origin)
        throw new Error('Scenario API calls must stay on the Otto server.');
      const response = await stack.request(path, {
        method,
        headers: { 'content-type': 'application/json', origin: stack.origin },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : {} };
    },
    async fireSchedules() {
      const id = await thread();
      const before = (
        await pool.query(
          "SELECT count(*)::int AS n FROM turns WHERE thread_id=$1 AND source='schedule'",
          [id],
        )
      ).rows[0].n as number;
      const due = await pool.query(
        `UPDATE ${stack.bossSchema}.job SET start_after=now() WHERE name='scheduled-task' AND state IN ('created','retry') RETURNING id`,
      );
      const expected = due.rowCount ?? 0;
      const limit = Math.min(Date.now() + 60_000, deadline);
      let fired = 0;
      while (expected) {
        fired =
          (
            await pool.query(
              "SELECT count(*)::int AS n FROM turns WHERE thread_id=$1 AND source='schedule'",
              [id],
            )
          ).rows[0].n - before;
        if (fired >= expected || Date.now() >= limit) break;
        await sleep(500);
      }
      if (fired < expected)
        throw new Error(
          Date.now() >= deadline
            ? 'The scenario exceeded its time limit.'
            : `Scheduled tasks did not run: ${fired} of ${expected} started a turn.`,
        );
      await settle();
      for (let round = 0; round < 6 && (await respond(true)); round++) await settle();
      return expected;
    },
    settle,
    event: stack.event,
    async waitForTurn(turnId) {
      while (Date.now() < deadline) {
        const result = await pool.query('SELECT status FROM turns WHERE id=$1', [turnId]);
        const status = result.rows[0]?.status;
        if (!status) throw new Error('The observed turn does not exist.');
        if (status !== 'queued' && status !== 'running') return;
        await sleep(250);
      }
      throw new Error('The scenario exceeded its time limit.');
    },
    async reset() {
      taskFrom = userMessages.length;
      await stack.resetConversation();
      threadId = undefined;
    },
    lastReply: lastAssistantText,
    async assistantCount() {
      const id = await thread();
      const result = await pool.query(
        "SELECT count(*)::int AS n FROM messages WHERE thread_id=$1 AND role='assistant' AND length(trim(text))>0",
        [id],
      );
      return result.rows[0].n as number;
    },
    workspace: {
      exec: stack.exec,
      async read(path) {
        return promisify(execFile)(
          'docker',
          ['exec', '--user', 'node', stack.container, 'cat', '--', `/workspace/${path}`],
          { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
        ).then(
          ({ stdout }) => stdout,
          () => undefined,
        );
      },
      async list() {
        const result = await stack.exec(
          "find /workspace -type f -not -path '*/.otto/*' -not -path '*/node_modules/*' | sort",
        );
        return result.output.split('\n').filter(Boolean);
      },
    },
  };
}
