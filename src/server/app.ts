import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
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
  cancelTask,
  reactToAssistantMessage,
  resetConversation,
  submitUserMessage,
  welcomeSourceId,
} from './tasks.ts';
import { conversationRevision, currentConversationSql } from './conversations.ts';
import { TaskReviewRequiredError } from './outcomes.ts';
import { isMessageReaction } from '../shared/emoji.ts';
import { registerLocalAccess } from './access.ts';
import { registerRuntimeAccess } from './runtime-auth.ts';
import { createMultipartReader } from './multipart.ts';
import type { SpeechService } from './speech.ts';
import { BrowserActionError, type Computer } from '../ports/computer.ts';
import { browserErrorMessage } from '../shared/browser-errors.ts';
import type {
  Configuration,
  Message,
  MessageHistoryPage,
  MessageReaction,
  Task,
} from '../shared/contracts.ts';
import type { AgentToolMetadata } from '../ports/agent.ts';
import { inspectorPayloadLimit, inspectorRetentionDays, type InspectorStore } from './inspector.ts';
import type { createChatVerification } from './chat-verification.ts';
import { registerTenantDrain } from './tenant-drain.ts';
import type { WorkAdmission } from './work-admission.ts';
import type { TenantDrain } from '../ports/deployment.ts';
import type { ProviderUsageStore } from './provider-usage.ts';

const messageFields = `m.id,m.role,m.text,m.task_id AS "taskId",m.created_at AS "createdAt",m.attachments,m.stream_id AS "streamId",m.reaction,m.assistant_reaction AS "assistantReaction",m.reply_to_message_id AS "replyToMessageId",
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
  speech?: SpeechService;
  computer?: Pick<Computer, 'screenshot' | 'status' | 'screenStatus' | 'currentSession'>;
  runtime?: {
    status(): { browser: string; workspace: string; activeTasks?: number };
    inspectTools?(): AgentToolMetadata[];
  };
  inspector?: Pick<InspectorStore, 'read'>;
  providerUsage?: Pick<ProviderUsageStore, 'taskCosts'>;
  configuration?: () => Configuration;
  onboard?: (timeZone?: string, conversationRevision?: number) => Promise<unknown>;
  startOnboarding?: (name?: string) => Promise<unknown>;
}

export async function createApp(dependencies: AppDependencies = {}) {
  const publicConfiguration = dependencies.configuration ?? configuration;
  const artifacts = dependencies.artifacts ?? localArtifacts;
  const speech = () => {
    if (!dependencies.speech)
      throw Object.assign(new Error('Speech is not configured.'), { statusCode: 503 });
    return dependencies.speech;
  };
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
    if (error instanceof TaskReviewRequiredError)
      return reply.code(409).send({
        error: error.message,
        code: error.code,
        taskId: error.taskId,
        summary: error.summary,
      });
    const known = error instanceof Error ? (error as Error & { statusCode?: number }) : undefined;
    const status = error instanceof z.ZodError ? 400 : known?.statusCode || 500;
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
  async function messageTasks(ids: string[]): Promise<Task[]> {
    if (!ids.length) return [];
    const result = await pool.query(
      `SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt",(source='user' OR source_id=$3) AS "showTyping" FROM tasks t WHERE owner_id=$1 AND channel='web' AND ${currentConversationSql()} AND id=ANY($2::uuid[])`,
      [ownerId, [...new Set(ids)], welcomeSourceId],
    );
    const costs = await dependencies.providerUsage
      ?.taskCosts(result.rows.map((task) => task.id))
      .catch(() => undefined);
    return result.rows.map((task) => ({ ...task, costUsd: costs?.[task.id] ?? null }));
  }
  app.get('/api/state', async () => {
    const revision = await conversationRevision(pool, ownerId);
    const [messages, tasks, verificationRequests] = await Promise.all([
      pool.query(
        `SELECT ${messageFields} FROM (SELECT m.* FROM messages m JOIN tasks t ON t.id=m.task_id WHERE m.owner_id=$1 AND t.owner_id=$1 AND t.channel='web' AND ${currentConversationSql()} ORDER BY date_trunc('milliseconds',m.created_at) DESC,m.id DESC LIMIT 151) m
         LEFT JOIN messages target ON target.id=m.reply_to_message_id AND target.owner_id=m.owner_id ORDER BY date_trunc('milliseconds',m.created_at),m.id`,
        [ownerId],
      ),
      pool.query(
        `SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt",(source='user' OR source_id=$2) AS "showTyping" FROM tasks t WHERE owner_id=$1 AND channel='web' AND ${currentConversationSql()} ORDER BY created_at DESC LIMIT 50`,
        [ownerId, welcomeSourceId],
      ),
      dependencies.verification?.pending() ?? [],
    ]);
    const hasEarlierMessages = messages.rows.length > 150;
    const visibleMessages = messages.rows.slice(hasEarlierMessages ? 1 : 0);
    const costs = await dependencies.providerUsage
      ?.taskCosts(tasks.rows.map((task) => task.id))
      .catch(() => undefined);
    const recentIds = new Set(tasks.rows.map((task) => task.id));
    const olderTasks = await messageTasks(
      visibleMessages.map((message) => message.taskId).filter((id) => id && !recentIds.has(id)),
    );
    return {
      conversationRevision: revision,
      hasEarlierMessages,
      messages: visibleMessages.map(messageView),
      tasks: [
        ...tasks.rows.map((task) => ({ ...task, costUsd: costs?.[task.id] ?? null })),
        ...olderTasks,
      ],
      verificationRequests,
      configuration: publicConfiguration(),
    };
  });
  app.get('/api/messages', async (request) => {
    const query = z
      .object({
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.uuid().optional(),
        conversationRevision: z
          .number()
          .int()
          .nonnegative()
          .or(z.string().regex(/^\d+$/).transform(Number))
          .optional(),
      })
      .parse(request.query);
    if (
      query.conversationRevision !== undefined &&
      query.conversationRevision !== (await conversationRevision(pool, ownerId))
    )
      throw Object.assign(
        new Error('This conversation has been reset. Reload it before continuing.'),
        { statusCode: 409 },
      );
    const rows = await pool.query(
      `SELECT ${messageFields} FROM messages m JOIN tasks t ON t.id=m.task_id
      LEFT JOIN messages target ON target.id=m.reply_to_message_id AND target.owner_id=m.owner_id
      WHERE m.owner_id=$1 AND t.owner_id=$1 AND t.channel='web' AND ${currentConversationSql()} AND ($2::timestamptz IS NULL OR date_trunc('milliseconds',m.created_at) < $2 OR (date_trunc('milliseconds',m.created_at) = $2 AND $3::uuid IS NOT NULL AND m.id < $3))
      ORDER BY date_trunc('milliseconds',m.created_at) DESC,m.id DESC LIMIT 61`,
      [ownerId, query.before ?? null, query.beforeId ?? null],
    );
    const page = rows.rows.slice(0, 60);
    const tasks = await messageTasks(page.map((message) => message.taskId).filter(Boolean));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    return {
      messages: page.reverse().map((row) => ({
        ...messageView(row),
        task: byId.get(row.taskId),
      })),
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
    return resetConversation();
  });
  app.post('/api/onboarding', async (request) => {
    const { timeZone, conversationRevision } = z
      .object({
        timeZone: z.string().max(100).optional(),
        conversationRevision: z.number().int().nonnegative().optional(),
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
    return dependencies.onboard(timeZone, conversationRevision);
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
        text: z.string().trim().max(24000).default(''),
        attachmentIds: z.array(z.uuid()).max(5).default([]),
        taskId: z.uuid().optional(),
        replyToMessageId: z.uuid().optional(),
        clientMessageId: z.uuid().optional(),
        conversationRevision: z.number().int().nonnegative().optional(),
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
        taskId: input.taskId,
        channel: 'web',
        replyToMessageId: input.replyToMessageId,
        conversationRevision: input.conversationRevision,
        clientMessageId,
      },
    );
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const result = await pool.query(
      `SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt",(channel='web' AND (source='user' OR source_id=$3)) AS "showTyping" FROM tasks t WHERE id=$1 AND owner_id=$2 AND ${currentConversationSql()}`,
      [z.uuid().parse(request.params.id), ownerId, welcomeSourceId],
    );
    return result.rows[0] ?? reply.code(404).send({ error: 'Task not found.' });
  });
  app.post<{ Params: { id: string } }>('/api/tasks/:id/cancel', async (request) => {
    await cancelTask(z.uuid().parse(request.params.id));
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
                taskId: event.taskId,
                text: event.text,
                streamId: event.streamId,
                done: event.done,
                conversationRevision: event.conversationRevision,
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
  app.post('/api/speech/transcribe', async (request) => {
    const file = await uploads.readFile(request);
    if (!file || !file.mimetype.startsWith('audio/'))
      throw Object.assign(new Error('Choose an audio recording.'), { statusCode: 400 });
    return {
      text: await speech().transcribe({
        bytes: file.bytes,
        mimeType: file.mimetype,
        fileName: file.filename || 'recording.webm',
      }),
    };
  });
  app.post('/api/speech/speak', async (request) => {
    const { text } = z.object({ text: z.string().min(1).max(3000) }).parse(request.body);
    const audio = await speech().synthesize(text);
    return artifacts.storeArtifact(audio.bytes, audio.fileName, audio.mimeType);
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
        taskId: z.uuid().optional(),
        before: z.iso.datetime({ offset: true }).optional(),
        beforeId: z.uuid().optional(),
        tool: z.string().min(1).max(160).optional(),
      })
      .refine((value) => Boolean(value.before) === Boolean(value.beforeId))
      .parse(request.query);
    const result = await dependencies.inspector?.read(query.taskId, query);
    return result ?? reply.code(404).send({ error: 'Task not found.' });
  });
  async function readCurrentBrowser() {
    const activeBrowser = dependencies.computer?.currentSession?.();
    const browser = await pool.query(
      activeBrowser
        ? 'SELECT id AS "taskId",title,status,$3::timestamptz AS "lastActivityAt" FROM tasks WHERE owner_id=$1 AND id=$2'
        : `SELECT t.id AS "taskId",t.title,t.status,e.created_at AS "lastActivityAt" FROM task_events e JOIN tasks t ON t.id=e.task_id
          WHERE t.owner_id=$1 AND e.type IN ('tool_start','tool_complete') AND e.summary IN ('browser','browser step','inspect login','request credentials')
          ORDER BY e.created_at DESC LIMIT 1`,
      activeBrowser ? [ownerId, activeBrowser.taskId, activeBrowser.lastActivityAt] : [ownerId],
    );
    return browser.rows[0];
  }
  app.get('/api/browser', async () => ({ currentBrowser: (await readCurrentBrowser()) ?? null }));
  app.get('/api/inspector', async (request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    const { taskId } = z.object({ taskId: z.uuid().optional() }).strict().parse(request.query);
    const tasks = await pool.query(
      'SELECT id,title,status,error,created_at AS "createdAt",updated_at AS "updatedAt" FROM tasks WHERE owner_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY created_at DESC LIMIT 50',
      [ownerId, taskId ?? null],
    );
    if (taskId && !tasks.rowCount) return reply.code(404).send({ error: 'Task not found.' });
    const events = await pool.query(
      'SELECT e.id,e.task_id AS "taskId",e.type,e.summary,e.created_at AS "createdAt" FROM task_events e JOIN tasks t ON t.id=e.task_id WHERE t.owner_id=$1 AND ($2::uuid IS NULL OR t.id=$2) ORDER BY e.created_at DESC LIMIT 200',
      [ownerId, taskId ?? null],
    );
    const runtime = dependencies.runtime?.status() ?? {
      browser: dependencies.computer?.status() ?? 'Not configured',
      workspace: 'Not configured',
    };
    const currentBrowser = await readCurrentBrowser();
    return {
      tasks: tasks.rows,
      events: events.rows,
      artifacts: (
        await pool.query(
          'SELECT * FROM artifacts WHERE owner_id=$1 AND task_id IS NOT NULL AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at DESC LIMIT 50',
          [ownerId, taskId ?? null],
        )
      ).rows.map((row) => ({ ...artifactView(row), taskId: row.task_id })),
      runtime: { ...runtime, database: 'PostgreSQL connected' },
      ...(currentBrowser ? { currentBrowser } : {}),
    };
  });
  async function readBrowserScreen(request: FastifyRequest, reply: FastifyReply) {
    const { taskId: id } = z.object({ taskId: z.uuid() }).parse(request.query);
    const task = await pool.query(
      'SELECT id,status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    if (!task.rowCount) return reply.code(404).send({ error: 'Task not found.' });
    if (task.rows[0].status === 'waiting_credentials')
      return reply
        .code(423)
        .send({ error: 'Browser observations are paused during credential entry.' });
    let screen: Buffer | null | undefined;
    try {
      screen = await dependencies.computer?.screenshot(id);
    } catch (error) {
      const message =
        error instanceof BrowserActionError ? browserErrorMessage(error.code) : undefined;
      if (message && error instanceof BrowserActionError)
        return reply.code(409).send({ code: error.code, error: message });
      throw error;
    }
    const current = await pool.query(
      'SELECT status,revision FROM tasks WHERE id=$1 AND owner_id=$2',
      [id, ownerId],
    );
    if (!current.rowCount) return reply.code(404).send({ error: 'Task not found.' });
    if (current.rows[0].status === 'waiting_credentials')
      return reply
        .code(423)
        .send({ error: 'Browser observations are paused during credential entry.' });
    if (current.rows[0].revision !== task.rows[0].revision)
      return reply.code(409).send({ error: 'The browser session changed. Request a new view.' });
    if (!screen) return reply.code(404).send({ error: 'This task has no browser screen yet.' });
    const screenStatus = dependencies.computer?.screenStatus?.(id);
    reply.header('X-Screen-State', screenStatus?.state ?? 'live');
    if (screenStatus?.capturedAt) reply.header('X-Screen-Captured-At', screenStatus.capturedAt);
    return reply.type('image/png').send(screen);
  }
  app.get('/api/browser/screen', readBrowserScreen);
  app.get('/api/inspector/screen', (request, reply) => {
    if (!publicConfiguration().inspectorEnabled)
      return reply.code(404).send({ error: 'Inspector is disabled.' });
    return readBrowserScreen(request, reply);
  });
  app.get(
    '/api/memory',
    async () =>
      (
        await pool.query(
          'SELECT id,text,source_message_id AS "sourceMessageId",created_at AS "createdAt" FROM memory_facts WHERE owner_id=$1 ORDER BY created_at DESC',
          [ownerId],
        )
      ).rows,
  );
  app.delete<{ Params: { id: string } }>('/api/memory/:id', async (request) => {
    await pool.query('DELETE FROM memory_facts WHERE id=$1 AND owner_id=$2', [
      z.uuid().parse(request.params.id),
      ownerId,
    ]);
    return { ok: true };
  });
  return app;
}
