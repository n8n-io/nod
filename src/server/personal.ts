import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createPreferencesStore } from './preferences.ts';
import { controlInput, forgetInput, forgetReview, type MemoryService } from './memory.ts';
import type { LearnedSkills } from './learned-skills.ts';
import type { MemoryUpdate, MemoryView } from '../shared/memory.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import { activeThreadSql } from './thread.ts';
import { createSchedules, type ScheduleDependencies } from './schedules.ts';
import type { MemoryChange } from './analytics.ts';
import { modelSelectionInput, type createModelService } from './models.ts';

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
  learnedSkills?: LearnedSkills;
  models?: ReturnType<typeof createModelService>;
};

export function createPersonalService(dependencies: PersonalDependencies) {
  const { pool, ownerId, refresh } = dependencies;
  const preferences = createPreferencesStore(pool, ownerId);
  const schedules = createSchedules(dependencies);
  const memory = dependencies.memory;
  const learnedSkills = dependencies.learnedSkills;
  const remembered = (
    operation: MemoryChange['operation'],
    actor: MemoryChange['actor'],
    kind: MemoryChange['kind'] = 'note',
  ) =>
    dependencies.analytics?.({
      event: 'nod_memory_changed',
      properties: { kind, operation, actor },
    });

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
    if (action === 'model_select') {
      const input = modelSelectionInput.parse(args);
      const connection = dependencies.models
        ?.view()
        .connections.find((item) => item.id === input.connectionId && item.status === 'connected');
      const model = connection?.models.find((item) => item.id === input.modelId);
      if (!model?.efforts.includes(input.effort))
        throw new Error('Choose an available model and effort from models_get.');
      return input;
    }
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
    if (action === 'memory_forget') {
      const input = forgetReview.parse(args);
      if ((await memory?.note(input.path)) !== input.note)
        throw Object.assign(new Error('The note changed. Review it before asking again.'), {
          statusCode: 409,
        });
      return input;
    }
    if (action === 'memory_control') return controlInput.parse(args);
    throw Object.assign(new Error('This personal-data action is not available for review.'), {
      statusCode: 400,
    });
  }

  async function reviewMemory(
    action: string,
    args: Record<string, unknown>,
    provenance: { sourceMessageId: string | null; turnId: string; ownerRooted: boolean },
  ): Promise<Record<string, unknown>> {
    if (!memory) throw new Error('Memory is unavailable.');
    if (action === 'memory_forget') {
      if (!provenance.sourceMessageId || !provenance.ownerRooted)
        throw new Error('Only a request from the owner can forget a note.');
      const { path } = forgetInput.parse(args);
      const note = await memory.note(path);
      if (note === undefined) throw new Error('This note is no longer in memory.');
      return { path, note };
    }
    const { quote, ...change } = args;
    const input = controlInput.parse(change);
    if (input.clear && !provenance.ownerRooted)
      throw new Error('Only a request from the owner can clear memory.');
    await memory.currentSource(provenance, z.string().trim().min(1).parse(quote));
    return input;
  }

  async function manage(
    action: string,
    args: Record<string, unknown>,
    provenance?: {
      sourceMessageId: string | null;
      turnId?: string;
      expectedRevision?: number;
    },
  ) {
    if (action === 'notification_preferences_get') return preferences.get();
    if (action === 'models_get') {
      if (!dependencies.models) throw new Error('Model settings are unavailable.');
      const { connections, selection } = dependencies.models.view();
      return {
        connections: connections.map(
          ({ id, provider, method, label, status, managed, models }) => ({
            id,
            provider,
            method,
            label,
            status,
            managed,
            models,
          }),
        ),
        selection,
      };
    }
    if (action === 'model_select') {
      const input = modelSelectionInput.parse(await validateReview(action, args));
      await dependencies.models!.select(input);
      dependencies.analytics?.({
        event: 'nod_settings_updated',
        properties: { section: 'models', operation: 'update' },
      });
      refresh();
      return { selection: dependencies.models!.view().selection };
    }
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
    if (action === 'memory_control') {
      if (!memory) throw new Error('Memory is unavailable.');
      const result = await memory.control(args);
      if (result.cleared) {
        await pool.query('DROP TABLE IF EXISTS profiles');
        remembered('clear', 'agent');
      }
      refresh();
      return result;
    }
    if (action === 'memory_forget') {
      if (!memory) throw new Error('Memory is unavailable.');
      const input = forgetReview.parse(args);
      const result = await memory.forget(input.path, input.note);
      remembered('forget', 'agent');
      return result;
    }
    if (action === 'history_search') {
      const { query, before, from, to, around } = z
        .object({
          query: z.string().trim().min(1).optional(),
          before: z.uuid().optional(),
          from: z.iso.date().optional(),
          to: z.iso.date().optional(),
          around: z.uuid().optional(),
        })
        .refine((input) => input.query || input.around || input.from || input.to, {
          message: 'Search with query, from or to, or read around a result id.',
        })
        .parse(args);
      if (around) {
        const { rows } = await pool.query(
          `WITH hit AS (SELECT m.created_at,m.id FROM messages m WHERE m.id=$2 AND m.owner_id=$1 AND ${activeThreadSql('m')}),
           nearby AS (
             (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND ${activeThreadSql('m')} AND (m.created_at,m.id)<(hit.created_at,hit.id) ORDER BY m.created_at DESC,m.id DESC LIMIT 5)
             UNION ALL (SELECT m.* FROM messages m,hit WHERE m.id=hit.id)
             UNION ALL (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND ${activeThreadSql('m')} AND (m.created_at,m.id)>(hit.created_at,hit.id) ORDER BY m.created_at,m.id LIMIT 5))
           SELECT id,role,CASE WHEN id=$2 THEN text ELSE left(text,6000) END AS text,id<>$2 AND length(text)>6000 AS shortened,turn_id,created_at FROM nearby ORDER BY created_at,id`,
          [ownerId, around],
        );
        if (!rows.length) throw new Error('This history result is unavailable.');
        return { messages: rows };
      }
      const cursor = before
        ? (
            await pool.query<{ at: Date }>(
              'SELECT created_at AS at FROM messages WHERE id=$1 AND owner_id=$2 UNION ALL SELECT created_at FROM turns WHERE id=$1 AND owner_id=$2 LIMIT 1',
              [before, ownerId],
            )
          ).rows[0]
        : undefined;
      if (before && !cursor) throw new Error('This history result is unavailable.');
      const terms = `WITH terms AS (SELECT replace(plainto_tsquery('english',coalesce($2,''))::text,'&','|')::tsquery AS q,
        coalesce((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC') AS zone)`;
      const where = (alias: string, column: string) =>
        `${alias}.owner_id=$1 AND ${activeThreadSql(alias)} AND ($2::text IS NULL OR to_tsvector('english',${column}) @@ terms.q) AND ($3::timestamptz IS NULL OR (${alias}.created_at,${alias}.id)<($3,$4::uuid)) AND ($5::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date>=$5) AND ($6::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date<=$6)`;
      const order = (alias: string, column: string) =>
        `${query ? `ts_rank_cd(to_tsvector('english',${column}),terms.q,1) DESC,` : ''}${alias}.created_at DESC,${alias}.id DESC`;
      const values = [
        ownerId,
        query ?? null,
        cursor?.at ?? null,
        before ?? null,
        from ?? null,
        to ?? null,
      ];
      const turns = await pool.query(
        `${terms} SELECT u.id,left(u.prompt,200) AS title,u.status,u.source,u.created_at,split_part(u.channel,':',1) AS channel FROM turns u CROSS JOIN terms WHERE ${where('u', 'u.prompt')} ORDER BY ${order('u', 'u.prompt')} LIMIT 15`,
        values,
      );
      const messages = await pool.query(
        `${terms}, docs AS (
           SELECT m.id,m.created_at,to_tsvector('english',m.text) AS v FROM messages m CROSS JOIN terms
           WHERE ${where('m', 'm.text')}),
         weights AS (
           SELECT w,ln(1+((SELECT count(*) FROM messages m WHERE m.owner_id=$1 AND ${activeThreadSql('m')})-count(*)+0.5)/(count(*)+0.5)) AS idf
           FROM (SELECT DISTINCT lexeme AS w FROM unnest(tsvector_to_array(to_tsvector('english',coalesce($2,'')))) lexeme) words
           JOIN docs ON docs.v @@ quote_literal(w)::tsquery GROUP BY w),
         hits AS (
           SELECT d.id,row_number() OVER (ORDER BY coalesce(sum(weights.idf),0) DESC,d.created_at DESC,d.id DESC) AS place
           FROM docs d LEFT JOIN weights ON d.v @@ quote_literal(weights.w)::tsquery
           GROUP BY d.id,d.created_at ORDER BY place LIMIT 20),
         thread AS (
           SELECT m.id,m.role,m.text,m.turn_id,m.created_at,row_number() OVER (ORDER BY m.created_at,m.id) AS n
           FROM messages m WHERE m.owner_id=$1 AND ${activeThreadSql('m')}),
         picked AS (SELECT t.n,h.place,h.id FROM hits h JOIN thread t ON t.id=h.id),
         shown AS (
           SELECT t.*,bool_or(p.id=t.id) AS match,min(p.place) AS place FROM thread t
           JOIN picked p ON t.n BETWEEN p.n-${query ? 1 : 0} AND p.n+${query ? 1 : 0} GROUP BY t.id,t.role,t.text,t.turn_id,t.created_at,t.n)
         SELECT s.id,s.role,CASE WHEN length(s.text)<=1200 THEN s.text
             ELSE ts_headline('english',s.text,terms.q,'StartSel="",StopSel="",MaxWords=60,MinWords=20,MaxFragments=3,FragmentDelimiter=" … "') END AS text,
           length(s.text)>1200 AS shortened,s.turn_id,s.created_at,split_part(COALESCE(u.channel,'web'),':',1) AS channel,s.match
         FROM shown s CROSS JOIN terms LEFT JOIN turns u ON u.id=s.turn_id AND u.owner_id=$1 ORDER BY s.place,s.n`,
        values,
      );
      return { turns: turns.rows, messages: messages.rows };
    }
    throw new Error('This personal-data action is not available.');
  }

  async function recall(text: string, before: Date | undefined, exclude: string | null) {
    const { rows } = await pool.query(
      `WITH terms AS (SELECT replace(plainto_tsquery('english',$2)::text,'&','|')::tsquery AS q),
       docs AS (
         SELECT m.id,m.role,m.text,m.created_at,to_tsvector('english',m.text) AS v FROM messages m CROSS JOIN terms
         WHERE m.owner_id=$1 AND m.role='user' AND ${activeThreadSql('m')} AND m.id IS DISTINCT FROM $4::uuid
           AND ($3::timestamptz IS NULL OR m.created_at<$3) AND to_tsvector('english',m.text) @@ terms.q),
       weights AS (
         SELECT w,ln(1+((SELECT count(*) FROM messages m WHERE m.owner_id=$1 AND ${activeThreadSql('m')})-count(*)+0.5)/(count(*)+0.5)) AS idf
         FROM (SELECT DISTINCT lexeme AS w FROM unnest(tsvector_to_array(to_tsvector('english',$2))) lexeme) words
         JOIN docs ON docs.v @@ quote_literal(w)::tsquery GROUP BY w),
       best AS (
         SELECT d.id,d.role,d.text,d.created_at FROM docs d LEFT JOIN weights ON d.v @@ quote_literal(weights.w)::tsquery
         GROUP BY d.id,d.role,d.text,d.created_at ORDER BY coalesce(sum(weights.idf),0) DESC,d.created_at DESC LIMIT 6)
       SELECT best.id,best.role,length(best.text)>400 AS shortened,CASE WHEN length(best.text)<=400 THEN best.text
           ELSE ts_headline('english',best.text,terms.q,'StartSel="",StopSel="",MaxWords=50,MinWords=15,MaxFragments=2,FragmentDelimiter=" … "') END AS text,
         best.created_at AS "createdAt"
       FROM best CROSS JOIN terms ORDER BY best.created_at`,
      [ownerId, text, before ?? null, exclude],
    );
    return rows as Array<{
      id: string;
      role: string;
      text: string;
      shortened: boolean;
      createdAt: Date;
    }>;
  }

  async function memoryView(): Promise<MemoryView> {
    if (!memory) throw Object.assign(new Error('Memory is unavailable.'), { statusCode: 404 });
    return memory.view();
  }

  function registerRoutes(app: FastifyInstance) {
    const changed = async (
      change: Promise<unknown> | undefined,
      operation?: MemoryChange['operation'],
    ): Promise<MemoryUpdate> => {
      const result = await change;
      if (change && operation && result !== false) remembered(operation, 'owner');
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
    app.post('/api/memory/notes', (request) => changed(memory?.add(request.body), 'save'));
    app.post('/api/memory/import', async (request): Promise<MemoryUpdate> => {
      if (!memory) return memoryView();
      const { saved, ...imported } = await memory.importNotes(request.body);
      if (saved) remembered('save', 'owner');
      refresh();
      return { ...(await memoryView()), imported };
    });
    app.patch('/api/memory/notes/:area/:slug', (request) =>
      changed(memory?.change(notePath(request.params), request.body), 'save'),
    );
    app.delete('/api/memory/notes/:area/:slug', (request) =>
      changed(memory?.forget(notePath(request.params)), 'forget'),
    );
    app.post('/api/memory/archive/restore', (request) =>
      changed(memory?.restore(request.body), 'save'),
    );
    app.post('/api/memory/archive/forget', (request) =>
      changed(memory?.forgetArchived(request.body), 'forget'),
    );
    const skillName = (params: unknown) => (params as { name: string }).name;
    app.patch('/api/memory/skills/:name', (request) =>
      changed(learnedSkills?.change(skillName(request.params), request.body)),
    );
    app.delete('/api/memory/skills/:name', (request) =>
      changed(learnedSkills?.forget(skillName(request.params))),
    );
    schedules.registerRoutes(app);
  }

  return {
    initialize,
    listSchedules: schedules.list,
    getSchedule: schedules.get,
    manage,
    recall,
    validateReview,
    reviewMemory,
    memoryView,
    registerRoutes,
  };
}
