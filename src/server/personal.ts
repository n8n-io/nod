import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { createPreferencesStore } from './preferences.ts';
import type { MemoryService } from './memory.ts';
import { personalSecret } from './memory-tree.ts';
import { activeThreadSql } from './thread.ts';
import { createSchedules, type ScheduleDependencies } from './schedules.ts';

const profileSchema = z
  .object({
    name: z.string().max(100),
    location: z.string().max(200),
    phone: z.string().max(40),
    preferences: z.string().max(4000),
  })
  .strict();
const goalSchema = z
  .object({
    title: z.string().trim().min(1).max(150),
    description: z.string().max(6000).default(''),
    progress: z.number().int().min(0).max(100).default(0),
    nextAction: z.string().max(2000).default(''),
    status: z.enum(['active', 'paused', 'completed']).default('active'),
    targetDate: z.iso.date().nullable().optional(),
  })
  .strict();
const goalUpdateSchema = goalSchema
  .partial()
  .extend({
    description: z.string().max(6000).optional(),
    progress: z.number().int().min(0).max(100).optional(),
    nextAction: z.string().max(2000).optional(),
    status: z.enum(['active', 'paused', 'completed']).optional(),
  })
  .strict();
const declinedPersonalAnswer =
  /^(?:no(?: thanks)?\b|skip\b|pass\b|not now\b|none\b|n\/a\b|(?:i(?:'d| would) rather not|i (?:do not|don't|don’t) want to|prefer not to|let(?:'s| us) not)(?:\b|$)|(?:do not|don't|don’t) (?:save|store|remember|ask)|não\b|prefiro não\b|saltar\b)/i;
const goalColumns =
  'id,title,description,progress,status,next_action AS "nextAction",target_date AS "targetDate",updated_at AS "updatedAt"';
type PersonalDependencies = ScheduleDependencies & {
  memory?: MemoryService;
};

export function createPersonalService(dependencies: PersonalDependencies) {
  const { pool, ownerId, refresh } = dependencies;
  const preferences = createPreferencesStore(pool, ownerId);
  const schedules = createSchedules(dependencies);
  const memory = dependencies.memory;

  async function initialize(options: { workers?: boolean } = {}) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS profiles (owner_id text PRIMARY KEY, data jsonb NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS goals (
        id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, description text NOT NULL,
        progress integer NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'active', next_action text NOT NULL DEFAULT '',
        target_date text, updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await schedules.initialize(options);
  }

  async function getProfile() {
    const result = await pool.query('SELECT data FROM profiles WHERE owner_id=$1', [ownerId]);
    return { name: '', location: '', phone: '', preferences: '', ...result.rows[0]?.data };
  }

  async function setProfile(raw: unknown, sourceMessageId?: string | null) {
    if (memory && !(await memory.enabled())) throw new Error('Memory is turned off.');
    const data = profileSchema.parse(raw);
    await pool.query(
      'INSERT INTO profiles(owner_id,data) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET data=$2',
      [ownerId, data],
    );
    refresh();
    if (sourceMessageId) await memory?.saved(sourceMessageId);
    return data;
  }

  async function listGoals() {
    return (
      await pool.query(
        `SELECT ${goalColumns} FROM goals WHERE owner_id=$1 ORDER BY updated_at DESC,id`,
        [ownerId],
      )
    ).rows;
  }

  async function createGoal(raw: unknown) {
    const input = goalSchema.parse(raw);
    const result = await pool.query(
      `INSERT INTO goals(id,owner_id,title,description,target_date,progress,next_action,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${goalColumns}`,
      [
        randomUUID(),
        ownerId,
        input.title,
        input.description,
        input.targetDate ?? null,
        input.progress,
        input.nextAction,
        input.status,
      ],
    );
    refresh();
    return result.rows[0];
  }

  async function updateGoal(id: string, raw: unknown) {
    z.uuid().parse(id);
    const input = goalUpdateSchema.parse(raw);
    if (!Object.keys(input).length)
      throw Object.assign(new Error('Choose a goal detail to update.'), { statusCode: 400 });
    const result = await pool.query(
      `UPDATE goals SET title=COALESCE($3,title),description=COALESCE($4,description),
      progress=COALESCE($5,progress),next_action=COALESCE($6,next_action),status=COALESCE($7,status),
      target_date=CASE WHEN $8 THEN $9 ELSE target_date END,updated_at=now()
      WHERE id=$1 AND owner_id=$2 RETURNING ${goalColumns}`,
      [
        id,
        ownerId,
        input.title,
        input.description,
        input.progress,
        input.nextAction,
        input.status,
        'targetDate' in input,
        input.targetDate,
      ],
    );
    if (!result.rowCount) throw Object.assign(new Error('Goal not found.'), { statusCode: 404 });
    refresh();
    return result.rows[0];
  }

  async function removeGoal(id: string) {
    z.uuid().parse(id);
    const result = await pool.query('DELETE FROM goals WHERE id=$1 AND owner_id=$2 RETURNING id', [
      id,
      ownerId,
    ]);
    if (!result.rowCount) throw Object.assign(new Error('Goal not found.'), { statusCode: 404 });
    refresh();
    return { ok: true };
  }

  async function learnProfileFact(
    args: Record<string, unknown>,
    provenance?: { sourceMessageId: string | null; turnId?: string },
  ) {
    if (memory && !(await memory.enabled())) throw new Error('Memory is turned off.');
    const input = z
      .object({
        quote: z.string().trim().min(1).max(2000),
        field: z.enum(['name', 'location', 'phone']),
        value: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(args);
    const sourceMessageId = z.uuid().parse(provenance?.sourceMessageId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const source = (
        await client.query(
          "SELECT id,text,turn_id,thread_id,created_at FROM messages WHERE id=$1 AND owner_id=$2 AND role='user' FOR SHARE",
          [sourceMessageId, ownerId],
        )
      ).rows[0];
      const sourceText = String(source?.text ?? '').trim();
      if (
        !source ||
        (provenance?.turnId && source.turn_id !== provenance.turnId) ||
        sourceText !== input.quote ||
        input.quote.endsWith('?')
      )
        throw Object.assign(
          new Error(
            'The complete current user statement is required so its qualifications are preserved.',
          ),
          { statusCode: 400 },
        );
      if (personalSecret.test(input.quote))
        throw Object.assign(
          new Error('Sign-in details and payment secrets cannot be remembered.'),
          { statusCode: 400 },
        );
      const statements = {
        name: /^(?:my name is|call me|o meu nome é|chamo-me)\s+(.+?)\s*[.!]?$/i,
        location: /^(?:i live in|i am based in|i'm based in|vivo em|moro em)\s+(.+?)\s*[.!]?$/i,
        phone:
          /^(?:my (?:phone|mobile)(?: number)? is|o meu (?:número|numero)(?: de (?:telefone|telemóvel))? é)\s+(.+?)\s*[.!]?$/i,
      };
      let value = input.quote.match(statements[input.field])?.[1];
      if (!value && sourceText === input.quote && source.thread_id) {
        const previous =
          (
            await client.query(
              "SELECT text FROM messages WHERE owner_id=$1 AND thread_id=$2 AND role='assistant' AND created_at<=$3 ORDER BY created_at DESC,id DESC LIMIT 1",
              [ownerId, source.thread_id, source.created_at],
            )
          ).rows[0]?.text ?? '';
        const questions = {
          name: /(?:what (?:should|can) i call you|what(?:'s| is) your name|como te chamas|qual é o teu nome)/i,
          location: /(?:where do you live|where are you based|onde (?:vives|moras))/i,
          phone:
            /(?:what(?:'s| is) your (?:phone|mobile)(?: number)?|qual é o teu (?:número|numero)(?: de (?:telefone|telemóvel)))/i,
        };
        if (questions[input.field].test(previous) && !declinedPersonalAnswer.test(input.quote))
          value = input.quote;
      }
      const limit = input.field === 'name' ? 100 : input.field === 'phone' ? 40 : 200;
      if (
        value !== input.value ||
        input.value.length > limit ||
        (input.field === 'phone' && !/^\+?[\d ()-]{5,40}$/.test(input.value))
      )
        throw Object.assign(
          new Error('This profile value needs an explicit matching user statement.'),
          { statusCode: 400 },
        );
      await client.query(
        'INSERT INTO profiles(owner_id,data) VALUES($1,$2) ON CONFLICT(owner_id) DO UPDATE SET data=profiles.data || EXCLUDED.data',
        [ownerId, { [input.field]: input.value }],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    refresh();
    await memory?.saved(sourceMessageId);
    return { ok: true };
  }

  async function validateReview(
    action: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    function changed<T extends Record<string, unknown>>(input: T) {
      if (!Object.keys(input).length)
        throw Object.assign(new Error('Choose a detail to update.'), { statusCode: 400 });
      return input;
    }
    if (action === 'profile_update') return changed(profileSchema.partial().parse(args));
    if (action === 'notification_preferences_update') return changed(preferences.validate(args));
    if (action === 'goal_create') return goalSchema.parse(args);
    if (action === 'goal_update') {
      const { id: rawId, ...raw } = args;
      const id = z.uuid().parse(rawId);
      const input = changed(goalUpdateSchema.parse(raw));
      if (
        !(await pool.query('SELECT id FROM goals WHERE id=$1 AND owner_id=$2', [id, ownerId]))
          .rowCount
      )
        throw Object.assign(new Error('Goal not found.'), { statusCode: 404 });
      return { id, ...input };
    }
    if (action === 'schedule_create') return schedules.validateCreate(args);
    if (action === 'schedule_update') {
      const { id: rawId, ...raw } = args;
      const id = z.uuid().parse(rawId);
      return { id, ...(await schedules.validateUpdate(id, raw)) };
    }
    if (action === 'schedule_cancel') {
      const input = z.object({ id: z.uuid() }).strict().parse(args);
      await schedules.validateUpdate(input.id, { enabled: false });
      return input;
    }
    if (action === 'memory_save') {
      if (!memory) throw new Error('Memory is unavailable.');
      return memory.validate(args);
    }
    throw Object.assign(new Error('This personal-data action is not available for review.'), {
      statusCode: 400,
    });
  }

  async function manage(
    action: string,
    args: Record<string, unknown>,
    provenance?: { sourceMessageId: string | null; turnId?: string },
  ) {
    if (action === 'profile_learn') return learnProfileFact(args, provenance);
    if (action === 'notification_preferences_get') return preferences.get();
    if (action === 'notification_preferences_update') {
      const result = await preferences.update(args);
      refresh();
      return result;
    }
    if (action === 'profile_get') return getProfile();
    if (action === 'profile_update')
      return setProfile({ ...(await getProfile()), ...args }, provenance?.sourceMessageId);
    if (action === 'goal_list') return listGoals();
    if (action === 'goal_create') return createGoal(args);
    if (action === 'goal_update') {
      const { id, ...input } = args;
      return updateGoal(String(id || ''), input);
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
    if (action === 'memory_save') {
      if (!memory) throw new Error('Memory is unavailable.');
      return memory.save(args, {
        sourceMessageId: provenance?.sourceMessageId ?? null,
        turnId: z.uuid().parse(provenance?.turnId),
      });
    }
    if (action === 'memory_learn' || action === 'memory_control') {
      if (!memory) throw new Error('Memory is unavailable.');
      const source = {
        sourceMessageId: provenance?.sourceMessageId ?? null,
        turnId: z.uuid().parse(provenance?.turnId),
      };
      if (action === 'memory_learn') return memory.learn(args, source);
      const result = await memory.control(args, source);
      if (result.cleared)
        await pool.query("UPDATE profiles SET data='{}'::jsonb WHERE owner_id=$1", [ownerId]);
      refresh();
      return result;
    }
    if (action === 'memory_forget') {
      if (!memory) throw new Error('Memory is unavailable.');
      return memory.forget(args.path);
    }
    if (action === 'history_search') {
      const query = z.string().min(1).max(200).parse(args.query);
      const turns = await pool.query(
        `SELECT u.id,left(u.prompt,200) AS title,u.status,u.source,u.created_at,split_part(u.channel,':',1) AS channel FROM turns u WHERE u.owner_id=$1 AND ${activeThreadSql('u')} AND to_tsvector('simple',u.prompt) @@ plainto_tsquery('simple',$2) ORDER BY u.created_at DESC LIMIT 15`,
        [ownerId, query],
      );
      const messages = await pool.query(
        `SELECT m.role,m.text,m.turn_id,split_part(COALESCE(u.channel,'web'),':',1) AS channel FROM messages m LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id WHERE m.owner_id=$1 AND ${activeThreadSql('m')} AND to_tsvector('simple',m.text) @@ plainto_tsquery('simple',$2) ORDER BY m.created_at DESC LIMIT 15`,
        [ownerId, query],
      );
      return { turns: turns.rows, messages: messages.rows };
    }
    throw new Error('This personal-data action is not available.');
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/memory', () => memory?.view() ?? { areas: [], archive: [] });
    app.get('/api/goals', listGoals);
    app.post('/api/goals', (request) => createGoal(request.body));
    app.patch<{ Params: { id: string } }>('/api/goals/:id', (request) =>
      updateGoal(request.params.id, request.body),
    );
    app.delete<{ Params: { id: string } }>('/api/goals/:id', (request) =>
      removeGoal(request.params.id),
    );
    schedules.registerRoutes(app);
  }

  return {
    initialize,
    getProfile,
    listGoals,
    listSchedules: schedules.list,
    manage,
    validateReview,
    registerRoutes,
  };
}
