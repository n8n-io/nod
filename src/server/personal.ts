import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createPreferencesStore } from './preferences.ts';
import type { MemoryService } from './memory.ts';
import type { MemoryUpdate, MemoryView } from '../shared/memory.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import { activeThreadSql } from './thread.ts';
import { createSchedules, type ScheduleDependencies } from './schedules.ts';

export function profileNotes(profile: Record<string, unknown>) {
  return Object.entries(profile).flatMap(([field, value]) => {
    if (typeof value !== 'string') return [];
    const area = field === 'preferences' ? ('preferences' as const) : ('about' as const);
    const label = area === 'about' ? `${field[0]!.toUpperCase()}${field.slice(1)}: ` : '';
    const budget = 120 - label.length;
    const notes: string[] = [];
    let current = '';
    const push = (unit: string) => {
      if (current && current.length + unit.length + 1 > budget) {
        notes.push(current);
        current = '';
      }
      current = current ? `${current} ${unit}` : unit;
    };
    for (const sentence of value.split(/\n+|(?<=[.!?])\s+/)) {
      const flat = sentence.replace(/[\s\p{Cc}]+/gu, ' ').trim();
      if (flat.length <= budget) {
        if (flat) push(flat);
      } else
        for (const word of flat.split(' '))
          for (let start = 0; start < word.length; start += budget)
            push(word.slice(start, start + budget));
    }
    if (current) notes.push(current);
    return notes.map((text) => ({ area, text: label + text }));
  });
}

type PersonalDependencies = ScheduleDependencies & {
  memory?: MemoryService;
};

export function createPersonalService(dependencies: PersonalDependencies) {
  const { pool, ownerId, refresh } = dependencies;
  const preferences = createPreferencesStore(pool, ownerId);
  const schedules = createSchedules(dependencies);
  const memory = dependencies.memory;

  async function initialize(options: { workers?: boolean } = {}) {
    if (memory && (await pool.query("SELECT to_regclass('profiles') AS name")).rows[0].name) {
      const { rows } = await pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]);
      if (await memory.adopt(profileNotes(rows[0]?.data ?? {})).catch(() => false))
        await pool.query('DROP TABLE IF EXISTS profiles');
    }
    await schedules.initialize(options);
  }

  async function validateReview(
    action: string,
    args: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<Record<string, unknown>> {
    function changed<T extends Record<string, unknown>>(input: T) {
      if (!Object.keys(input).length)
        throw Object.assign(new Error('Choose a detail to update.'), { statusCode: 400 });
      return input;
    }
    if (action === 'notification_preferences_update') return changed(preferences.validate(args));
    if (action === 'schedule_create') return schedules.validateCreate(args);
    if (action === 'schedule_update') {
      const { id: rawId, ...raw } = args;
      const id = z.uuid().parse(rawId);
      return { id, ...(await schedules.validateUpdate(id, raw, expectedRevision)) };
    }
    if (action === 'schedule_cancel') {
      const input = z.object({ id: z.uuid() }).strict().parse(args);
      await schedules.validateUpdate(input.id, { enabled: false }, expectedRevision);
      return input;
    }
    throw Object.assign(new Error('This personal-data action is not available for review.'), {
      statusCode: 400,
    });
  }

  async function manage(
    action: string,
    args: Record<string, unknown>,
    provenance?: {
      sourceMessageId: string | null;
      turnId?: string;
      expectedRevision?: number;
      ownerRooted?: boolean;
    },
  ) {
    if (action === 'notification_preferences_get') return preferences.get();
    if (action === 'notification_preferences_update') {
      const result = await preferences.update(args);
      refresh();
      return result;
    }
    if (action === 'schedule_list') return schedules.list();
    if (action === 'schedule_record_observation')
      return schedules.recordObservation(provenance?.turnId ?? '', args);
    if (action === 'schedule_create') return schedules.create(args, provenance);
    if (action === 'schedule_update') {
      const { id, ...input } = args;
      return schedules.update(String(id || ''), input, provenance);
    }
    if (action === 'schedule_cancel')
      return schedules.update(String(args.id || ''), { enabled: false }, provenance);
    if (action === 'memory_find') {
      if (!memory) throw new Error('Memory is unavailable.');
      return memory.find(args);
    }
    if (action === 'memory_read') {
      if (!memory) throw new Error('Memory is unavailable.');
      return memory.read(args);
    }
    if (action === 'memory_learn' || action === 'memory_control') {
      if (!memory) throw new Error('Memory is unavailable.');
      if ((args as { clear?: unknown }).clear === true && !provenance?.ownerRooted)
        throw new Error('Only a request from the owner can clear memory.');
      const source = {
        sourceMessageId: provenance?.sourceMessageId ?? null,
        turnId: z.uuid().parse(provenance?.turnId),
      };
      if (action === 'memory_learn') return memory.learn(args, source);
      const result = await memory.control(args, source);
      if (result.cleared) await pool.query('DROP TABLE IF EXISTS profiles');
      refresh();
      return result;
    }
    if (action === 'memory_forget') {
      if (!memory) throw new Error('Memory is unavailable.');
      if (!provenance?.sourceMessageId || !provenance.ownerRooted)
        throw new Error('Only a request from the owner can forget a note.');
      return memory.forget(args.path);
    }
    if (action === 'history_search') {
      const { query, before } = z
        .object({ query: z.string().min(1), before: z.uuid().optional() })
        .parse(args);
      const cursor = before
        ? (
            await pool.query<{ at: Date }>(
              'SELECT created_at AS at FROM messages WHERE id=$1 AND owner_id=$2 UNION ALL SELECT created_at FROM turns WHERE id=$1 AND owner_id=$2 LIMIT 1',
              [before, ownerId],
            )
          ).rows[0]
        : undefined;
      if (before && !cursor) throw new Error('This history result is unavailable.');
      const turns = await pool.query(
        `SELECT u.id,left(u.prompt,200) AS title,u.status,u.source,u.created_at,split_part(u.channel,':',1) AS channel FROM turns u WHERE u.owner_id=$1 AND ${activeThreadSql('u')} AND to_tsvector('simple',u.prompt) @@ plainto_tsquery('simple',$2) AND ($3::timestamptz IS NULL OR (u.created_at,u.id)<($3,$4::uuid)) ORDER BY u.created_at DESC,u.id DESC LIMIT 15`,
        [ownerId, query, cursor?.at ?? null, before ?? null],
      );
      const messages = await pool.query(
        `SELECT m.id,m.role,m.text,m.turn_id,m.created_at,split_part(COALESCE(u.channel,'web'),':',1) AS channel FROM messages m LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id WHERE m.owner_id=$1 AND ${activeThreadSql('m')} AND to_tsvector('simple',m.text) @@ plainto_tsquery('simple',$2) AND ($3::timestamptz IS NULL OR (m.created_at,m.id)<($3,$4::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT 15`,
        [ownerId, query, cursor?.at ?? null, before ?? null],
      );
      return { turns: turns.rows, messages: messages.rows };
    }
    throw new Error('This personal-data action is not available.');
  }

  async function memoryView(): Promise<MemoryView> {
    if (!memory) throw Object.assign(new Error('Memory is unavailable.'), { statusCode: 404 });
    return memory.view();
  }

  function registerRoutes(app: FastifyInstance) {
    const changed = async (change: Promise<unknown> | undefined): Promise<MemoryUpdate> => {
      const result = await change;
      refresh();
      return { ...(await memoryView()), ...(typeof result === 'string' ? { path: result } : {}) };
    };
    const notePath = (params: unknown) => {
      const { area, slug } = params as { area: string; slug: string };
      return `${area}/${slug}`;
    };
    app.get('/api/memory', memoryView);
    app.get('/api/memory/export', async (_request, reply) => {
      const now = new Date();
      return reply
        .header('Content-Type', 'text/markdown; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="${memoryFileName(now)}"`)
        .send(memoryMarkdown(await memoryView(), now));
    });
    app.patch('/api/memory', (request) => changed(memory?.settings(request.body)));
    app.post('/api/memory/notes', (request) => changed(memory?.add(request.body)));
    app.patch('/api/memory/notes/:area/:slug', (request) =>
      changed(memory?.change(notePath(request.params), request.body)),
    );
    app.delete('/api/memory/notes/:area/:slug', (request) =>
      changed(memory?.forget(notePath(request.params))),
    );
    app.post('/api/memory/archive/restore', (request) => changed(memory?.restore(request.body)));
    app.post('/api/memory/archive/forget', (request) =>
      changed(memory?.forgetArchived(request.body)),
    );
    schedules.registerRoutes(app);
  }

  return {
    initialize,
    listSchedules: schedules.list,
    getSchedule: schedules.get,
    manage,
    validateReview,
    memoryView,
    registerRoutes,
  };
}
