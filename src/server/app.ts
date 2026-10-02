import Fastify, { type FastifyReply } from 'fastify';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { pool } from './db.ts';
import {
  configuration,
  ownerId,
  port,
  runtimeMode,
  runtimeSecret,
  runtimeEnvironment,
  runtimeGeneration,
} from './config.ts';
import { events, type ServerEvent } from './events.ts';
import { artifactView, maxFileSize, localArtifacts, type ArtifactService } from './artifacts.ts';
import {
  activeThread,
  reactToAssistantMessage,
  resetThread,
  stopThread,
  submitUserMessage,
  welcomeSourceId,
} from './thread.ts';
import { isMessageReaction } from '../shared/emoji.ts';
import { registerLocalAccess } from './access.ts';
import { logFailure } from './failure-log.ts';
import { inspectorPayloadLimit, inspectorRetentionDays, type InspectorStore } from './inspector.ts';
import type { AgentToolMetadata } from '../ports/agent.ts';
import { registerRuntimeAccess } from './runtime-auth.ts';
import { createMultipartReader } from './multipart.ts';
import { BrowserActionError, type Computer } from '../ports/computer.ts';
import { browserErrorMessage } from '../shared/browser-errors.ts';
import { browserHandoffInput } from '../shared/browser-handoff.ts';
import type {
  Configuration,
  Message,
  MessageHistoryPage,
  MessageReaction,
  Turn,
} from '../shared/contracts.ts';
import type { createChatVerification } from './chat-verification.ts';
import { registerTenantDrain } from './tenant-drain.ts';
import type { WorkAdmission } from './work-admission.ts';
import type { TenantDrain } from '../ports/deployment.ts';

const messageFields = `m.id,m.role,m.text,m.turn_id AS "turnId",m.created_at AS "createdAt",m.attachments,m.stream_id AS "streamId",m.reaction,m.assistant_reaction AS "assistantReaction",m.reply_to_message_id AS "replyToMessageId",
 CASE WHEN target.id IS NULL THEN NULL ELSE json_build_object('id',target.id,'role',target.role,'text',left(target.text,1000)) END AS "replyTo"`;
function messageView(row: Message & { assistantReaction?: MessageReaction | null }): Message {
  const { assistantReaction, ...message } = row;
  return {
    ...message,
    reactions: [
      ...(message.reaction ? [{ actor: 'user' as const, reaction: message.reaction }] : []),
      ...(assistantReaction ? [{ actor: 'assistant' as const, reaction: assistantReaction }] : []),
    ],
  };
}

export interface AppDependencies {
  admission?: WorkAdmission;
  deploymentDrain?: TenantDrain;
  artifacts?: ArtifactService;
  submitMessage?: typeof submitUserMessage;
  verification?: Awaited<ReturnType<typeof createChatVerification>>;
  computer?: Pick<
    Computer,
    'screenshot' | 'control' | 'status' | 'screenStatus' | 'currentSession' | 'discard'
  >;
  runtime?: {
    status(): { browser: string; workspace: string; activeThreads?: number };
    inspectTools?(): AgentToolMetadata[];
  };
  inspector?: Pick<InspectorStore, 'read'>;
  configuration?: () => Configuration;
  onboard?: (timeZone?: string, threadId?: string) => Promise<unknown>;
  startOnboarding?: (name?: string) => Promise<unknown>;
}

export async function createApp(dependencies: AppDependencies = {}) {
  const publicConfiguration = dependencies.configuration ?? configuration;
  const artifacts = dependencies.artifacts ?? localArtifacts;
  const app = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    trustProxy: false,
    forceCloseConnections: true,
  });
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => {
    for (const stream of streams) stream.end();
  });
  const runtimeAccess =
    runtimeMode === 'tenant'
      ? registerRuntimeAccess(app, {
          secret: runtimeSecret,
          ownerId,
          environment: runtimeEnvironment,
          generation: runtimeGeneration,
        })
      : undefined;
  if (!runtimeAccess) registerLocalAccess(app, port);
  if (runtimeAccess && dependencies.admission && dependencies.deploymentDrain)
    registerTenantDrain(app, {
      admission: dependencies.admission,
      drain: dependencies.deploymentDrain,
      generation: runtimeGeneration,
    });
  const uploads = createMultipartReader({
    maxFileSize,
    verifiedBody: runtimeAccess?.takeBody,
  });
  app.setErrorHandler((error, _request, reply) => {
    const known = error instanceof Error ? (error as Error & { statusCode?: number }) : undefined;
    const status = error instanceof z.ZodError ? 400 : known?.statusCode || 500;
    if (status >= 500) logFailure('request_failed', error);
    reply.code(status).send({
      error:
        error instanceof z.ZodError
          ? 'Check the supplied values.'
          : status < 500
            ? known?.message
            : 'This request could not be completed. Check the local service and try again.',
    });
  });
  await app.register(multipart, { limits: uploads.limits });
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    const release = process.env.OTTO_IMAGE_RELEASE || process.env.OTTO_RELEASE;
    return { ok: true, ...(release ? { release } : {}) };
  });
  const turnFields = `u.id,u.status,u.source,u.error,u.created_at AS "createdAt",u.finished_at AS "finishedAt",(NOT u.background OR u.source_id=$2) AS "showTyping"`;
  async function messageTurns(threadId: string, ids: string[]): Promise<Turn[]> {
    if (!ids.length) return [];
    const result = await pool.query(
      `SELECT ${turnFields} FROM turns u WHERE u.owner_id=$1 AND u.thread_id=$3 AND u.id=ANY($4::uuid[])`,
      [ownerId, welcomeSourceId, threadId, [...new Set(ids)]],
    );
    return result.rows;
  }
  app.get('/api/state', async () => {
    const thread = await activeThread(pool);
    const [messages, turns, verificationRequests] = await Promise.all([
      pool.query(
        `SELECT ${messageFields} FROM (SELECT m.* FROM messages m WHERE m.owner_id=$1 AND m.thread_id=$2 ORDER BY date_trunc('milliseconds',m.created_at) DESC,m.id DESC LIMIT 151) m
         LEFT JOIN messages target ON target.id=m.reply_to_message_id AND target.owner_id=m.owner_id ORDER BY date_trunc('milliseconds',m.created_at),m.id`,
        [ownerId, thread.id],
      ),
      pool.query(
        `SELECT ${turnFields} FROM turns u WHERE u.owner_id=$1 AND u.thread_id=$3 ORDER BY u.created_at DESC LIMIT 50`,
        [ownerId, welcomeSourceId, thread.id],
      ),
      dependencies.verification?.pending() ?? [],
    ]);
    const hasEarlierMessages = messages.rows.length > 150;
    const visibleMessages = messages.rows.slice(hasEarlierMessages ? 1 : 0);
    const recentIds = new Set(turns.rows.map((turn) => turn.id));
    const olderTurns = await messageTurns(
      thread.id,
      visibleMessages.map((message) => message.turnId).filter((id) => id && !recentIds.has(id)),
    );
    return {
      threadId: thread.id,
      threadStatus: thread.status,
      hasEarlierMessages,
      messages: visibleMessages.map(messageView),
      turns: [...turns.rows, ...olderTurns],
      verificationRequests,
      configuration: publicConfiguration(),
    };
  });
  app.get('/api/messages', async (request) => {
    const query = z
      .object({
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.uuid().optional(),
        threadId: z.uuid().optional(),
      })
      .parse(request.query);
    const thread = await activeThread(pool);
    if (query.threadId !== undefined && query.threadId !== thread.id)
      throw Object.assign(
        new Error('This conversation has been reset. Reload it before continuing.'),
        { statusCode: 409 },
      );
    const rows = await pool.query(
      `SELECT ${messageFields} FROM messages m
      LEFT JOIN messages target ON target.id=m.reply_to_message_id AND target.owner_id=m.owner_id
      WHERE m.owner_id=$1 AND m.thread_id=$4 AND ($2::timestamptz IS NULL OR date_trunc('milliseconds',m.created_at) < $2 OR (date_trunc('milliseconds',m.created_at) = $2 AND $3::uuid IS NOT NULL AND m.id < $3))
      ORDER BY date_trunc('milliseconds',m.created_at) DESC,m.id DESC LIMIT 61`,
      [ownerId, query.before ?? null, query.beforeId ?? null, thread.id],
    );
    const page = rows.rows.slice(0, 60);
    return {
      messages: page.reverse().map(messageView),
      hasMore: rows.rows.length > 60,
    } satisfies MessageHistoryPage;
  });
  app.post<{ Params: { id: string } }>('/api/messages/:id/reaction', async (request, reply) => {
    const { reaction } = z
      .object({ reaction: z.string().max(64).refine(isMessageReaction).nullable() })
      .strict()
      .parse(request.body);
    return reactToAssistantMessage(
      z.uuid().parse(request.params.id),
      reaction,
      publicConfiguration().llmReady,
    );
  });
  app.post('/api/conversation/reset', async (request) => {
    z.object({})
      .strict()
      .parse(request.body ?? {});
    const { previousThreadId, ...reset } = await resetThread();
    void dependencies.computer?.discard?.(previousThreadId).catch(() => {});
    return reset;
  });
  app.post('/api/onboarding', async (request) => {
    const { timeZone, threadId } = z
      .object({
        timeZone: z.string().max(100).optional(),
        threadId: z.uuid().optional(),
      })
      .strict()
      .parse(request.body);
    if (timeZone) {
      try {
        new Intl.DateTimeFormat('en', { timeZone });
      } catch {
        throw Object.assign(new Error('Choose a valid time zone.'), { statusCode: 400 });
      }
    }
    if (!dependencies.onboard)
      throw Object.assign(new Error('Setup is unavailable.'), { statusCode: 503 });
    return dependencies.onboard(timeZone, threadId);
  });
  app.post('/api/onboarding/start', async (request) => {
    const { name } = z
      .object({ name: z.string().trim().max(100).optional() })
      .strict()
      .parse(request.body ?? {});
    if (!dependencies.startOnboarding)
      throw Object.assign(new Error('Setup is unavailable.'), { statusCode: 503 });
    await dependencies.startOnboarding(name);
    return { ok: true };
  });
  app.post('/api/messages', async (request) => {
    const input = z
      .object({
        text: z.string().trim().max(100_000).default(''),
        attachmentIds: z.array(z.uuid()).max(20).default([]),
        replyToMessageId: z.uuid().optional(),
        clientMessageId: z.uuid().optional(),
        threadId: z.uuid().optional(),
        verificationRequestId: z.uuid().optional(),
      })
      .strict()
      .refine((value) => value.text.length > 0 || value.attachmentIds.length > 0)
      .parse(request.body);
    const clientMessageId = input.clientMessageId ?? randomUUID();
    const verification = await dependencies.verification?.accept(input.text, {
      ...input,
      clientMessageId,
      channel: 'web',
    });
    if (verification) return verification;
    if (input.verificationRequestId)
      throw Object.assign(new Error('This verification request is no longer available.'), {
        statusCode: 409,
      });
    if (!publicConfiguration().llmReady)
      throw Object.assign(
        new Error('Configure an agent provider before starting a conversation.'),
        { statusCode: 503 },
      );
    const result = await pool.query(
      'SELECT * FROM artifacts WHERE id=ANY($1::uuid[]) AND owner_id=$2',
      [input.attachmentIds, ownerId],
    );
    if (result.rowCount !== input.attachmentIds.length)
      throw Object.assign(new Error('An attachment is unavailable.'), { statusCode: 400 });
    const prompt =
      input.text || 'Review the attached files and briefly describe what they contain.';
    return (dependencies.submitMessage ?? submitUserMessage)(
      prompt,
      input.attachmentIds.map((id) =>
        artifactView(result.rows.find((artifact) => artifact.id === id)!),
      ),
      {
        channel: 'web',
        replyToMessageId: input.replyToMessageId,
        threadId: input.threadId,
        clientMessageId,
      },
    );
  });
  app.post('/api/thread/stop', async () => {
    await stopThread();
    return { ok: true };
  });
  app.get('/api/events', async (request, reply) => {
    reply.hijack();
    streams.add(reply.raw);
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: ServerEvent) => {
      const payload =
        event.type === 'refresh'
          ? { type: 'refresh' }
          : event.type === 'delta' && event.ownerId === ownerId && event.channel === 'web'
            ? {
                type: 'delta',
                threadId: event.threadId,
                turnId: event.turnId,
                text: event.text,
                streamId: event.streamId,
                done: event.done,
              }
            : undefined;
      if (payload && !reply.raw.destroyed) reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send({ type: 'refresh' });
    events.on('event', send);
    const timer = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    reply.raw.on('close', () => {
      streams.delete(reply.raw);
      clearInterval(timer);
      events.off('event', send);
    });
  });
  app.post('/api/uploads', async (request) => {
    const file = await uploads.readFile(request);
    if (!file) throw Object.assign(new Error('Choose a file to upload.'), { statusCode: 400 });
    return artifacts.storeArtifact(file.bytes, file.filename, file.mimetype);
  });
  app.get<{ Params: { id: string } }>('/api/artifacts/:id', async (request, reply) => {
    const result = await pool.query('SELECT * FROM artifacts WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(request.params.id),
      ownerId,
    ]);
    const file = result.rows[0];
    if (!file) return reply.code(404).send({ error: 'File not found.' });
    const inline =
      /^(image\/(png|jpeg|webp|gif|avif|bmp|svg\+xml)|audio\/(mpeg|wav|x-wav|webm|ogg|mp4|aac|flac)|video\/(mp4|webm|ogg)|application\/pdf)$/.test(
        file.mime_type,
      );
    reply
      .header('Content-Type', file.mime_type)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Accept-Ranges', 'bytes')
      .header(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      )
      .header('Content-Security-Policy', "default-src 'none'; sandbox");
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, file.size - Number(match?.[2]));
      const end =
        match?.[1] && match[2] ? Math.min(Number(match[2]), file.size - 1) : file.size - 1;
      if (
        !match ||
        (!match[1] && !match[2]) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        start > end ||
        start >= file.size
      )
        return reply.code(416).header('Content-Range', `bytes */${file.size}`).send();
      return reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${file.size}`)
        .header('Content-Length', end - start + 1)
        .send((await artifacts.readArtifact(file.id)).subarray(start, end + 1));
    }
    reply.header('Content-Length', file.size);
    return reply.send(await artifacts.readArtifact(file.id));
  });
  app.get('/api/inspector/tools', async (_request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    return {
      tools: dependencies.runtime?.inspectTools?.() ?? [],
      captureEnabled: Boolean(dependencies.inspector),
      retentionDays: inspectorRetentionDays,
      payloadLimitBytes: inspectorPayloadLimit,
    };
  });
  app.get('/api/inspector/observations', async (request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    const query = z
      .object({
        turnId: z.uuid().optional(),
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.uuid().optional(),
        tool: z.string().min(1).max(160).optional(),
      })
      .refine((value) => Boolean(value.before) === Boolean(value.beforeId))
      .parse(request.query);
    const result = await dependencies.inspector?.read(query.turnId, query);
    return result ?? reply.code(404).send({ error: 'Turn not found.' });
  });
  async function readCurrentBrowser() {
    const thread = await activeThread(pool);
    const activeBrowser = dependencies.computer?.currentSession?.();
    if (activeBrowser && activeBrowser.threadId !== thread.id) return undefined;
    const latest = await pool.query(
      `SELECT left(COALESCE(m.text,u.prompt),100) AS title,u.status,COALESCE(e.created_at,u.created_at) AS "lastActivityAt"
       FROM turns u LEFT JOIN messages m ON m.id=u.message_id
       LEFT JOIN LATERAL (SELECT created_at FROM turn_events WHERE turn_id=u.id AND type IN ('tool_start','tool_complete') AND summary='browser' ORDER BY created_at DESC LIMIT 1) e ON true
       WHERE u.owner_id=$1 AND u.thread_id=$2 ${activeBrowser ? '' : 'AND e.created_at IS NOT NULL'}
       ORDER BY e.created_at IS NULL,COALESCE(e.created_at,u.created_at) DESC LIMIT 1`,
      [ownerId, thread.id],
    );
    const row = latest.rows[0];
    if (!row) return undefined;
    return {
      threadId: thread.id,
      title: row.title,
      status: row.status,
      lastActivityAt: activeBrowser?.lastActivityAt ?? row.lastActivityAt,
    };
  }
  app.get('/api/browser', async () => ({ currentBrowser: (await readCurrentBrowser()) ?? null }));
  app.get('/api/inspector', async (request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    const { turnId } = z.object({ turnId: z.uuid().optional() }).strict().parse(request.query);
    const thread = await activeThread(pool);
    const turns = await pool.query(
      `SELECT u.id,u.status,u.source,u.error,u.created_at AS "createdAt",u.finished_at AS "finishedAt" FROM turns u
       WHERE u.owner_id=$1 AND u.thread_id=$2 AND ($3::uuid IS NULL OR u.id=$3) ORDER BY u.created_at DESC LIMIT 50`,
      [ownerId, thread.id, turnId ?? null],
    );
    if (turnId && !turns.rowCount) return reply.code(404).send({ error: 'Turn not found.' });
    const events = await pool.query(
      `SELECT e.id,e.turn_id AS "turnId",e.type,e.summary,e.created_at AS "createdAt" FROM turn_events e JOIN turns u ON u.id=e.turn_id
       WHERE u.owner_id=$1 AND u.thread_id=$2 AND ($3::uuid IS NULL OR u.id=$3) ORDER BY e.created_at DESC LIMIT 200`,
      [ownerId, thread.id, turnId ?? null],
    );
    const runtime = dependencies.runtime?.status() ?? {
      browser: dependencies.computer?.status() ?? 'Not configured',
      workspace: 'Not configured',
    };
    const currentBrowser = await readCurrentBrowser();
    return {
      turns: turns.rows,
      events: events.rows,
      artifacts: (
        await pool.query(
          'SELECT * FROM artifacts WHERE owner_id=$1 AND thread_id=$2 ORDER BY created_at DESC LIMIT 50',
          [ownerId, thread.id],
        )
      ).rows.map((row) => ({ ...artifactView(row), threadId: row.thread_id })),
      runtime: { ...runtime, database: 'PostgreSQL connected' },
      ...(currentBrowser ? { currentBrowser } : {}),
    };
  });
  async function credentialEntryOpen(threadId: string) {
    const latest = await pool.query(
      "SELECT status,waiting_reason FROM turns WHERE owner_id=$1 AND thread_id=$2 AND status<>'queued' ORDER BY created_at DESC,id DESC LIMIT 1",
      [ownerId, threadId],
    );
    return latest.rows[0]?.status === 'waiting' && latest.rows[0].waiting_reason === 'credentials';
  }
  async function handoffOpen(threadId: string) {
    const latest = await pool.query(
      'SELECT status,waiting_reason FROM turns WHERE owner_id=$1 AND thread_id=$2 AND NOT background ORDER BY created_at DESC,id DESC LIMIT 1',
      [ownerId, threadId],
    );
    if (latest.rows[0]?.status !== 'waiting' || latest.rows[0].waiting_reason !== 'question')
      return false;
    const running = await pool.query(
      "SELECT 1 FROM turns WHERE owner_id=$1 AND thread_id=$2 AND status='running' LIMIT 1",
      [ownerId, threadId],
    );
    return !running.rowCount;
  }
  const handoffClosed = 'The browser opens here only while Otto is waiting for you.';
  async function readBrowserScreen(reply: FastifyReply, handoff = false) {
    const thread = await activeThread(pool);
    const blocked = async () =>
      handoff ? !(await handoffOpen(thread.id)) : await credentialEntryOpen(thread.id);
    if (await blocked())
      return reply.code(423).send({
        error: handoff ? handoffClosed : 'Browser observations are paused during credential entry.',
      });
    let screen: Buffer | null | undefined;
    try {
      screen = await dependencies.computer?.screenshot(thread.id);
    } catch (error) {
      const message =
        error instanceof BrowserActionError ? browserErrorMessage(error.code) : undefined;
      if (message && error instanceof BrowserActionError)
        return reply.code(409).send({ code: error.code, error: message });
      throw error;
    }
    const current = await activeThread(pool);
    if (current.id !== thread.id)
      return reply.code(409).send({ error: 'The browser session changed. Request a new view.' });
    if (await blocked())
      return reply.code(423).send({
        error: handoff ? handoffClosed : 'Browser observations are paused during credential entry.',
      });
    if (!screen) return reply.code(404).send({ error: 'There is no browser screen yet.' });
    const screenStatus = dependencies.computer?.screenStatus?.(thread.id);
    reply.header('X-Screen-State', screenStatus?.state ?? 'live');
    if (screenStatus?.capturedAt) reply.header('X-Screen-Captured-At', screenStatus.capturedAt);
    return reply.type('image/png').send(screen);
  }
  app.get('/api/browser/screen', (_request, reply) => readBrowserScreen(reply));
  app.get('/api/inspector/screen', (_request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    return readBrowserScreen(reply);
  });
  app.get('/api/browser-handoff/screen', (_request, reply) => readBrowserScreen(reply, true));
  app.post('/api/browser-handoff', async (request, reply) => {
    const input = browserHandoffInput.safeParse(request.body);
    if (!input.success)
      return reply.code(400).send({ error: 'Send a click, scroll, key or text.' });
    const control = dependencies.computer?.control;
    if (!control) return reply.code(404).send({ error: 'The browser is unavailable.' });
    const thread = await activeThread(pool);
    if (!(await handoffOpen(thread.id))) return reply.code(423).send({ error: handoffClosed });
    try {
      await control(thread.id, input.data);
    } catch (error) {
      if (error instanceof BrowserActionError)
        return reply.code(409).send({ code: error.code, error: browserErrorMessage(error.code) });
      throw error;
    }
    return { ok: true };
  });
  return app;
}
