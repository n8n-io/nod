import { z } from 'zod';
import type { PoolClient } from 'pg';
import type { FastifyInstance } from 'fastify';
import { afterCommit } from './transaction.ts';
import { createPreferencesStore } from './preferences.ts';
import { controlInput, forgetInput, forgetReview, type MemoryService } from './memory.ts';
import type { LearnedSkills } from './learned-skills.ts';
import type { MemoryUpdate, MemoryView } from '../shared/memory.ts';
import { memoryFileName, memoryMarkdown } from '../shared/memory-export.ts';
import { activeThreadSql, createHistorySearch } from './history.ts';
import { withdrawnSql } from './turn-chain.ts';
import { createSchedules, type ScheduleDependencies } from './schedules.ts';
import type { MemoryChange } from './analytics.ts';
import { modelSelectionInput, type createModelService } from './models.ts';

type PersonalDependencies = ScheduleDependencies & {
  memory?: MemoryService;
  learnedSkills?: LearnedSkills;
  models?: ReturnType<typeof createModelService>;
};

export function createPersonalService(dependencies: PersonalDependencies) {
  const { pool, ownerId, refresh } = dependencies;
  const preferences = createPreferencesStore(pool, ownerId, dependencies.analytics);
  const schedules = createSchedules(dependencies);
  const memory = dependencies.memory;
  const searchHistory = createHistorySearch({ pool, ownerId });
  const learnedSkills = dependencies.learnedSkills;
  const remembered = (
    operation: MemoryChange['operation'],
    actor: MemoryChange['actor'],
    kind: MemoryChange['kind'] = 'note',
  ) =>
    dependencies.analytics?.({
      event: 'memory_changed',
      properties: { kind, operation, actor },
    });

  async function initialize(options: { workers?: boolean } = {}) {
    await schedules.initialize(options);
  }

  async function validateReview(
    action: string,
    args: Record<string, unknown>,
    expectedRevision?: number,
    client?: PoolClient,
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
      return { id, ...(await schedules.validateUpdate(id, raw, expectedRevision, client)) };
    }
    if (action === 'schedule_pause' || action === 'schedule_cancel') {
      const input = z.object({ id: z.uuid() }).strict().parse(args);
      await schedules.validateUpdate(input.id, { enabled: false }, expectedRevision, client);
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
    options?: { expectedRules?: string; client?: PoolClient },
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
      await dependencies.models!.select(input, 'agent');
      dependencies.analytics?.({
        event: 'settings_updated',
        properties: { section: 'models', operation: 'update' },
      });
      afterCommit(options?.client ?? pool, refresh);
      return { selection: dependencies.models!.view().selection };
    }
    if (action === 'notification_preferences_update') {
      const result = await preferences.update(
        args,
        'agent',
        options?.expectedRules,
        options?.client,
      );
      afterCommit(options?.client ?? pool, refresh);
      return result;
    }
    if (action === 'schedule_list') return schedules.list();
    if (action === 'schedule_record_observation')
      return schedules.recordObservation(provenance?.turnId ?? '', args);
    if (action === 'schedule_create') return schedules.create(args, provenance, options?.client);
    if (action === 'schedule_update') {
      const { id, ...input } = args;
      return schedules.update(String(id || ''), input, provenance, undefined, options?.client);
    }
    if (action === 'schedule_pause' || action === 'schedule_cancel')
      return schedules.update(
        String(args.id || ''),
        { enabled: false },
        provenance,
        undefined,
        options?.client,
      );
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
      if (result.cleared) remembered('clear', 'agent');
      afterCommit(options?.client ?? pool, refresh);
      return result;
    }
    if (action === 'memory_forget') {
      if (!memory) throw new Error('Memory is unavailable.');
      const input = forgetReview.parse(args);
      const result = await memory.forget(input.path, input.note);
      remembered('forget', 'agent');
      return result;
    }
    if (action === 'history_search') return searchHistory(args);
    throw new Error('This personal-data action is not available.');
  }

  async function recall(text: string, before: Date | undefined, exclude: string | null) {
    const { rows } = await pool.query(
      `WITH terms AS (SELECT replace(plainto_tsquery('english',$2)::text,'&','|')::tsquery AS q),
       docs AS (
         SELECT m.id,m.role,m.text,m.created_at,to_tsvector('english',m.text) AS v FROM messages m CROSS JOIN terms
         WHERE m.owner_id=$1 AND m.role='user' AND ${activeThreadSql('m')} AND m.id IS DISTINCT FROM $4::uuid AND NOT ${withdrawnSql('m')}
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
    app.post('/api/memory/notes/:area/:slug/archive', (request) =>
      changed(memory?.archiveNote(notePath(request.params)), 'archive'),
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
