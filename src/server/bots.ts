import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  botAvatarSchema,
  botInstructionsLimit,
  botJobLimit,
  botEmojis,
  botName,
  botNameLimit,
  type Bot,
  avatarUpload,
  type BotStatus,
} from '../shared/bots.ts';
import type { ModelSelection } from '../shared/models.ts';
import { modelSelectionInput } from './models.ts';
import { activeThreadSql } from './history.ts';
import { cancellationTransaction } from './db.ts';
import { afterCommit, transaction } from './transaction.ts';
import { cancelTurns, lockThread } from './thread.ts';
import { refresh } from './events.ts';
import { localArtifacts } from './artifacts.ts';
import { logFailure } from './failure-log.ts';

type Queryable = Pick<PoolClient, 'query'>;

export const botChange = z
  .object({
    name: z.string().optional(),
    job: z.string().trim().max(botJobLimit).optional(),
    instructions: z.string().trim().max(botInstructionsLimit).optional(),
    avatar: botAvatarSchema.optional(),
    model: modelSelectionInput.optional(),
  })
  .strict();

export const botAction = z
  .object({
    id: z.uuid(),
    name: z.string().optional(),
    job: z.string().trim().max(botJobLimit).optional(),
    instructions: z.string().trim().max(botInstructionsLimit).optional(),
    model: modelSelectionInput.optional(),
  })
  .strict();

export const botCreate = z
  .object({
    name: z.string(),
    job: z.string().trim().min(1).max(botJobLimit),
    instructions: z.string().trim().max(botInstructionsLimit).optional(),
    model: modelSelectionInput.optional(),
  })
  .strict();

type BotChange = z.infer<typeof botChange>;

function failure(message: string, statusCode = 400, code?: string) {
  return Object.assign(new Error(message), { statusCode, ...(code ? { code } : {}) });
}

const statusOf = (status: string | null): BotStatus =>
  status === 'queued' || status === 'running'
    ? 'working'
    : status === 'waiting'
      ? 'needs_you'
      : status === 'failed'
        ? 'failed'
        : 'idle';

const line = (text: string, limit: number) => {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
};

export function createBots(options: {
  pool: Pool;
  ownerId: string;
  validateModel?: (choice: ModelSelection) => void;
  nodModel?: () => ModelSelection | null;
  clearBrowser?: (id: string) => Promise<unknown>;
  removeSchedule?: (id: string) => Promise<unknown>;
  removeMemory?: (id: string) => Promise<unknown>;
  retireWorkspace?: (bot: { id: string; uid: number }) => Promise<unknown>;
}) {
  const { pool, ownerId } = options;

  async function list(db: Queryable = pool, id?: string): Promise<Bot[]> {
    const { rows } = await db.query<{
      id: string;
      name: string;
      job: string;
      instructions: string;
      avatar: string;
      model: ModelSelection;
      created_at: Date;
      status: string | null;
      question: string | null;
      last_role: string | null;
      last_text: string | null;
      latest_id: string | null;
      latest_at: Date | null;
    }>(
      `SELECT b.id,b.name,b.job,b.instructions,b.avatar,b.model,b.created_at,t.status,q.text AS question,
         last.role AS last_role,last.text AS last_text,latest.id AS latest_id,latest.created_at AS latest_at
       FROM bots b
       LEFT JOIN LATERAL (SELECT u.id,u.status FROM turns u WHERE u.owner_id=b.owner_id AND u.bot_id=b.id
         ORDER BY u.created_at DESC,u.id DESC LIMIT 1) t ON true
       LEFT JOIN LATERAL (SELECT m.text FROM messages m WHERE t.status='waiting' AND m.owner_id=b.owner_id
         AND m.turn_id=t.id AND m.role='assistant' AND m.hidden_at IS NULL AND m.text<>''
         ORDER BY m.created_at DESC,m.id DESC LIMIT 1) q ON true
       LEFT JOIN LATERAL (SELECT m.role,m.text FROM messages m WHERE m.owner_id=b.owner_id AND m.bot_id=b.id
         AND m.hidden_at IS NULL AND m.text<>'' AND ${activeThreadSql('m')}
         ORDER BY m.created_at DESC,m.id DESC LIMIT 1) last ON true
       LEFT JOIN LATERAL (SELECT m.id,m.created_at FROM messages m WHERE m.owner_id=b.owner_id AND m.bot_id=b.id
         AND m.role='assistant' AND m.hidden_at IS NULL AND ${activeThreadSql('m')}
         ORDER BY m.created_at DESC,m.id DESC LIMIT 1) latest ON true
       WHERE b.owner_id=$1 AND b.archived_at IS NULL AND ($2::uuid IS NULL OR b.id=$2)
       ORDER BY b.created_at,b.id`,
      [ownerId, id ?? null],
    );
    return rows.map((row) => {
      const status = statusOf(row.status);
      return {
        id: row.id,
        name: row.name,
        job: row.job,
        instructions: row.instructions,
        avatar: row.avatar,
        model: row.model,
        createdAt: row.created_at.toISOString(),
        status,
        question: status === 'needs_you' && row.question ? line(row.question, 400) : null,
        lastMessage: row.last_text
          ? { from: row.last_role === 'user' ? 'owner' : 'bot', text: line(row.last_text, 200) }
          : null,
        latestReply:
          row.latest_id && row.latest_at
            ? { id: row.latest_id, at: row.latest_at.toISOString() }
            : null,
      };
    });
  }

  async function get(db: Queryable, id: string) {
    const bot = (await list(db, id))[0];
    if (!bot) throw failure('This bot was removed.', 404);
    return bot;
  }

  async function freeName(db: Queryable, wanted: string, except?: string) {
    const name = botName(wanted);
    if (!name) throw failure(`A bot's name needs 1 to ${botNameLimit} characters.`);
    const taken = (
      await db.query<{ name: string }>(
        `SELECT name FROM bots WHERE owner_id=$1 AND archived_at IS NULL AND lower(name)=lower($2)
           AND id IS DISTINCT FROM $3::uuid`,
        [ownerId, name, except ?? null],
      )
    ).rows[0];
    if (taken || name.toLowerCase() === 'nod')
      throw failure(
        `${taken?.name ?? 'Nod'} is already taken. Pick another name.`,
        409,
        'bot_name_in_use',
      );
    return name;
  }

  async function keepAvatar(client: PoolClient, avatar: string) {
    const upload = avatarUpload(avatar);
    if (!upload) return;
    const image = (
      await client.query<{ mime_type: string }>(
        'SELECT mime_type FROM artifacts WHERE id=$1 AND owner_id=$2 AND deleting_at IS NULL',
        [upload, ownerId],
      )
    ).rows[0];
    if (!/^image\/(png|jpeg|webp)$/.test(image?.mime_type ?? ''))
      throw failure('Choose a PNG, JPG or WebP image for the avatar.');
    await localArtifacts.retainArtifacts([upload], client);
  }

  async function create(
    client: PoolClient,
    profile: {
      name: string;
      job?: string;
      instructions?: string;
      avatar?: string;
      model?: ModelSelection;
    },
  ) {
    const name = await freeName(client, profile.name);
    let avatar = profile.avatar;
    if (avatar === undefined) {
      const used = (
        await client.query<{ avatar: string }>(
          'SELECT avatar FROM bots WHERE owner_id=$1 AND archived_at IS NULL',
          [ownerId],
        )
      ).rows;
      const free = botEmojis.filter((emoji) => !used.some((row) => row.avatar === emoji));
      const choices = free.length ? free : botEmojis;
      avatar = choices[Math.floor(Math.random() * choices.length)]!;
    } else await keepAvatar(client, avatar);
    const model = profile.model ?? options.nodModel?.();
    if (!model) throw failure('Connect a model in Settings before you add a bot.', 409);
    options.validateModel?.(model);
    const id = randomUUID();
    await client.query(
      `INSERT INTO bots(id,owner_id,name,job,instructions,avatar,model,uid)
       VALUES($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(max(uid),99999)+1 FROM bots WHERE owner_id=$2))`,
      [
        id,
        ownerId,
        name,
        profile.job ?? '',
        profile.instructions ?? '',
        avatar,
        JSON.stringify(model),
      ],
    );
    return id;
  }

  async function update(client: PoolClient, id: string, change: BotChange) {
    const current = await client.query(
      'SELECT 1 FROM bots WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR UPDATE',
      [id, ownerId],
    );
    if (!current.rowCount) throw failure('This bot was removed.', 404);
    const name = change.name === undefined ? undefined : await freeName(client, change.name, id);
    if (change.avatar) await keepAvatar(client, change.avatar);
    if (change.model) options.validateModel?.(change.model);
    await client.query(
      `UPDATE bots SET name=COALESCE($3,name),job=COALESCE($4,job),instructions=COALESCE($5,instructions),
         avatar=COALESCE($6,avatar),model=COALESCE($7::jsonb,model),updated_at=now()
       WHERE id=$1 AND owner_id=$2`,
      [
        id,
        ownerId,
        name ?? null,
        change.job ?? null,
        change.instructions ?? null,
        change.avatar ?? null,
        change.model ? JSON.stringify(change.model) : null,
      ],
    );
  }

  async function remove(client: PoolClient, threadId: string, id: string) {
    const current = await client.query(
      'SELECT 1 FROM bots WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL',
      [id, ownerId],
    );
    if (!current.rowCount) throw failure('This bot was already removed.', 404);
    const { browsers } = await cancelTurns(client, threadId, { botId: id });
    await client.query(
      'UPDATE bots SET archived_at=now(),updated_at=now() WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    await client.query(
      "UPDATE tasks SET state='cancelled',closed_at=now(),updated_at=now() WHERE bot_id=$1 AND owner_id=$2 AND state='open'",
      [id, ownerId],
    );
    await client.query(
      'UPDATE schedules SET enabled=false,revision=revision+1 WHERE bot_id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    afterCommit(client, () => {
      for (const browser of browsers.filter((item) => item !== id))
        void options
          .clearBrowser?.(browser)
          ?.catch((error) => logFailure('bot_retire_failed', error));
      void retire().catch((error) => logFailure('bot_retire_failed', error));
    });
  }

  async function retire() {
    const { rows } = await pool.query<{ id: string; uid: number }>(
      'SELECT id,uid FROM bots WHERE owner_id=$1 AND archived_at IS NOT NULL AND retired_at IS NULL',
      [ownerId],
    );
    for (const bot of rows)
      try {
        const schedules = await pool.query<{ id: string }>(
          'SELECT id FROM schedules WHERE owner_id=$1 AND bot_id=$2',
          [ownerId, bot.id],
        );
        for (const schedule of schedules.rows) await options.removeSchedule?.(schedule.id);
        await options.retireWorkspace?.(bot);
        await options.clearBrowser?.(bot.id);
        await options.removeMemory?.(bot.id);
        await pool.query('UPDATE bots SET retired_at=now() WHERE id=$1 AND owner_id=$2', [
          bot.id,
          ownerId,
        ]);
      } catch (error) {
        logFailure('bot_retire_failed', error);
      }
  }

  function registerRoutes(app: FastifyInstance) {
    app.post('/api/bots', async (request) => {
      const profile = z
        .object({
          name: z.string(),
          avatar: botAvatarSchema.optional(),
          model: modelSelectionInput.optional(),
        })
        .strict()
        .parse(request.body ?? {});
      const id = await transaction(async (client) => {
        await lockThread(client, ownerId);
        return create(client, profile);
      }, pool);
      refresh();
      return get(pool, id);
    });
    app.patch<{ Params: { id: string } }>('/api/bots/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      const change = botChange.parse(request.body);
      await transaction(async (client) => {
        await lockThread(client, ownerId);
        await update(client, id, change);
      }, pool);
      refresh();
      return get(pool, id);
    });
    app.delete<{ Params: { id: string } }>('/api/bots/:id', async (request) => {
      const id = z.uuid().parse(request.params.id);
      await cancellationTransaction(async (client) => {
        await client.query('SELECT 1 FROM schedules WHERE owner_id=$1 AND bot_id=$2 FOR UPDATE', [
          ownerId,
          id,
        ]);
        await remove(client, (await lockThread(client, ownerId)).id, id);
      }, pool);
      refresh();
      return { ok: true };
    });
  }

  async function work(db: Queryable = pool) {
    const { rows } = await db.query<{
      bot_id: string;
      kind: 'task' | 'schedule';
      id: string;
      title: string;
      next: Date | null;
    }>(
      `SELECT bot_id,'task' AS kind,id,title,NULL::timestamptz AS next FROM tasks
         WHERE owner_id=$1 AND bot_id IS NOT NULL AND state='open'
       UNION ALL
       SELECT bot_id,'schedule',id,title,next_run_at FROM schedules
         WHERE owner_id=$1 AND bot_id IS NOT NULL AND enabled`,
      [ownerId],
    );
    return (botId: string) => ({
      openTasks: rows
        .filter((row) => row.bot_id === botId && row.kind === 'task')
        .map(({ id, title }) => ({ id, title })),
      schedules: rows
        .filter((row) => row.bot_id === botId && row.kind === 'schedule')
        .map(({ id, title, next }) => ({ id, title, nextRun: next?.toISOString() ?? null })),
    });
  }

  return { list, get, create, update, work, retire, registerRoutes };
}
