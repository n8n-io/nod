import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type pg from 'pg';
import type { Stack } from './stack.ts';
import type { UserScript } from './scenario.ts';
import type { Simulator } from './judge.ts';

export interface Interaction {
  kind: 'question' | 'approval' | 'secret' | 'unanswered' | 'stalled';
  text: string;
  reply?: string;
  at: number;
}

export interface Session {
  say(text: string, options?: { attach?: string[] }): Promise<void>;
  sayDuring(first: string, interjection: string, afterMs: number): Promise<void>;
  interruptAfter(first: string, afterMs: number): Promise<void>;
  sayDuringWithAttachments(
    first: string,
    interjection: string,
    afterMs: number,
    attach: string[],
  ): Promise<void>;
  upload(name: string, bytes: Buffer, mimeType?: string): Promise<string>;
  fireSchedules(): Promise<number>;
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
    const response = await fetch(new URL(path, stack.baseUrl), {
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
    const state = await (await fetch(new URL('/api/state', stack.baseUrl))).json();
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

  async function waiting() {
    const id = await thread();
    const turn = (
      await pool.query(
        'SELECT id,status,waiting_reason FROM turns WHERE thread_id=$1 AND NOT background ORDER BY created_at DESC, id DESC LIMIT 1',
        [id],
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
      const state = await (await fetch(new URL('/api/state', stack.baseUrl))).json();
      return { kind: 'secret' as const, request: state.verificationRequests?.[0], text };
    }
    return { kind: 'question' as const, text };
  }

  async function respond(): Promise<boolean> {
    const pending = await waiting();
    if (!pending) return false;
    const at = Date.now();
    if (pending.kind === 'approval') {
      const approve =
        typeof user.approve === 'function'
          ? user.approve(pending.approval.action, pending.approval.args)
          : (user.approve ?? true);
      const reply = approve ? 'Yes' : 'No';
      interactions.push({ kind: 'approval', text: pending.text, reply, at });
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
      interactions.push({ kind: 'secret', text: pending.text, at });
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

  return {
    interactions,
    userMessages,
    async say(text, sendOptions) {
      userMessages.push({ at: Date.now(), text });
      await post('/api/messages', { text, attachmentIds: sendOptions?.attach ?? [] });
      await converse();
    },
    async interruptAfter(first, afterMs) {
      userMessages.push({ at: Date.now(), text: first });
      await post('/api/messages', { text: first, attachmentIds: [] });
      await sleep(afterMs);
      await post('/api/thread/stop', {});
      await settle();
    },
    async sayDuring(first, interjection, afterMs) {
      return this.sayDuringWithAttachments(first, interjection, afterMs, []);
    },
    async sayDuringWithAttachments(first, interjection, afterMs, attach) {
      userMessages.push({ at: Date.now(), text: first });
      await post('/api/messages', { text: first, attachmentIds: attach });
      await sleep(afterMs);
      userMessages.push({ at: Date.now(), text: interjection });
      await post('/api/messages', { text: interjection, attachmentIds: [] });
      await converse();
    },
    async upload(name, bytes, mimeType = 'application/octet-stream') {
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), name);
      const response = await fetch(new URL('/api/uploads', stack.baseUrl), {
        method: 'POST',
        body: form,
      });
      if (!response.ok) throw new Error(`Upload failed (${response.status}).`);
      return (await response.json()).id as string;
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
      return expected;
    },
    settle,
    async reset() {
      await post('/api/conversation/reset', {});
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
        return readFile(join(stack.workspaceRoot, path)).catch(() => undefined);
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
