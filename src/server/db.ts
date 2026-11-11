import { logFailure } from './failure-log.ts';
import pg from 'pg';
import { databaseUrl, ownerId } from './config.ts';
import { locksTable } from './locks.ts';
import { transaction } from './transaction.ts';

function poolSize(value: string | undefined, fallback: number) {
  const size = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(size) || size < 1)
    throw new Error('The database pool size must be a positive whole number.');
  return size;
}

function createPool(config: pg.PoolConfig) {
  const created = new pg.Pool({
    connectionTimeoutMillis: 10_000,
    ...config,
  });
  created.on('error', (error) => logFailure('database_idle_error', error));
  return created;
}

export const pool = createPool({
  connectionString: databaseUrl,
  max: poolSize(process.env.DATABASE_POOL_MAX, 12),
});

const cancellationQueues = new WeakMap<pg.Pool, Promise<void>>();

export async function cancellationTransaction<T>(
  action: (client: pg.PoolClient) => Promise<T>,
  database = pool,
) {
  const previous = cancellationQueues.get(database);
  let resume!: () => void;
  const queued = new Promise<void>((resolve) => {
    resume = resolve;
  });
  cancellationQueues.set(database, queued);
  await previous;
  try {
    const control = createPool({
      ...database.options,
      password: database.options.password,
      max: 1,
      min: 0,
    });
    try {
      return await transaction(action, control);
    } finally {
      await control.end();
    }
  } finally {
    resume();
    if (cancellationQueues.get(database) === queued) cancellationQueues.delete(database);
  }
}

export async function initializeDatabase() {
  if (!databaseUrl)
    throw new Error('Run pnpm run dev to configure the local database, or set DATABASE_URL.');
  await pool.query(`
    ${locksTable};
    CREATE TABLE IF NOT EXISTS threads (
      id uuid PRIMARY KEY, owner_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS threads_active_owner ON threads(owner_id) WHERE archived_at IS NULL;
    ALTER TABLE threads ADD COLUMN IF NOT EXISTS observer_session_id uuid NOT NULL DEFAULT gen_random_uuid();
    CREATE TABLE IF NOT EXISTS turns (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id),
      session_id uuid NOT NULL, source text NOT NULL, source_id text, message_id uuid, prompt text NOT NULL,
      channel text NOT NULL DEFAULT 'web', channel_source_id text, status text NOT NULL DEFAULT 'queued', waiting_reason text,
      background boolean NOT NULL DEFAULT false, error text,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    );
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS channel_source_id text;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS parent_turn_id uuid;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS proactive boolean NOT NULL DEFAULT false;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS start_after timestamptz;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS withdrawn boolean NOT NULL DEFAULT false;
    CREATE INDEX IF NOT EXISTS turns_withdrawn_message ON turns(message_id) WHERE withdrawn;
    CREATE OR REPLACE FUNCTION turns_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      NEW.session_id := COALESCE(NEW.session_id, CASE WHEN NEW.background THEN NEW.id ELSE NEW.thread_id END);
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS turns_session ON turns;
    CREATE TRIGGER turns_session BEFORE INSERT ON turns FOR EACH ROW EXECUTE FUNCTION turns_session();
    CREATE INDEX IF NOT EXISTS turns_session_queue ON turns(session_id,status);
    CREATE UNIQUE INDEX IF NOT EXISTS turns_owner_source ON turns(owner_id,source_id) WHERE source_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS turns_thread_queue ON turns(thread_id,status,created_at,id);
    CREATE INDEX IF NOT EXISTS turns_owner_time ON turns(owner_id,created_at,id);
    CREATE UNIQUE INDEX IF NOT EXISTS turns_proactive_queued ON turns(owner_id,thread_id) WHERE proactive AND source='event' AND status='queued';
    CREATE TABLE IF NOT EXISTS turn_events (
      id uuid PRIMARY KEY, turn_id uuid NOT NULL REFERENCES turns(id), type text NOT NULL,
      summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS turn_events_turn_time ON turn_events(turn_id,created_at);
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS run_id uuid;
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS parent_run_id uuid;
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS session_id uuid;
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS browser_id text;
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS call_id uuid;
    ALTER TABLE turn_events ADD COLUMN IF NOT EXISTS site text;
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, owner_id text NOT NULL, role text NOT NULL, text text NOT NULL,
      display_text text,
      thread_id uuid REFERENCES threads(id), turn_id uuid REFERENCES turns(id),
      attachments jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
      stream_id text, reaction text, assistant_reaction text, assistant_reacted_at timestamptz,
      reaction_revision integer NOT NULL DEFAULT 0, reply_to_message_id uuid REFERENCES messages(id),
      hidden_at timestamptz
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_quote text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS display_text text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_caption text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS suggestions jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS presentation jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS answer_choices jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS question_answer jsonb;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivered_channel text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS hidden_at timestamptz;
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS handoff_browser_id text;
    DROP INDEX IF EXISTS messages_hidden_thread;
    CREATE INDEX IF NOT EXISTS messages_hidden_thread_recent ON messages(owner_id,thread_id,hidden_at DESC,id DESC) WHERE hidden_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS messages_owner_agent_reaction_time ON messages(owner_id,assistant_reacted_at DESC) WHERE assistant_reacted_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS artifacts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id), name text NOT NULL,
      mime_type text NOT NULL, size integer NOT NULL, storage_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audio_messages (
      owner_id text NOT NULL, message_id uuid NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id),
      fingerprint text NOT NULL, response jsonb, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(owner_id,message_id)
    );
    CREATE TABLE IF NOT EXISTS preferences (
      owner_id text PRIMARY KEY, notification_rule text NOT NULL DEFAULT '', time_zone text,
      quiet_start text NOT NULL DEFAULT '22:00', quiet_end text NOT NULL DEFAULT '08:00',
      quiet_hours_enabled boolean NOT NULL DEFAULT true, locale text,
      hour_cycle text NOT NULL DEFAULT 'auto' CHECK (hour_cycle IN ('auto','h12','h23'))
    );
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS rules text NOT NULL DEFAULT '';
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS speech_voice text;
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS speech_reply text NOT NULL DEFAULT 'auto' CHECK (speech_reply IN ('auto','voice','always','never'));
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS proactive_paused boolean NOT NULL DEFAULT false;
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS local_keep_out text[] NOT NULL DEFAULT '{}';
    CREATE INDEX IF NOT EXISTS messages_owner_time ON messages(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_thread_time ON messages(thread_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_turn_time ON messages(turn_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_attachments ON messages USING gin (attachments jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS messages_text_search ON messages USING gin (to_tsvector('english',text));
  `);
  await pool.query(
    `UPDATE turns SET status='cancelled',finished_at=now()
     WHERE owner_id=$1 AND source='event' AND starts_with(source_id,'activity-check:') AND status='queued'`,
    [ownerId],
  );
  await transaction(async (artifacts) => {
    await artifacts.query('LOCK TABLE artifacts IN ACCESS EXCLUSIVE MODE');
    const existing = await artifacts.query(
      "SELECT 1 FROM pg_attribute WHERE attrelid='artifacts'::regclass AND attname='expires_at' AND NOT attisdropped",
    );
    await artifacts.query(`
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS expires_at timestamptz;
      ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS deleting_at timestamptz;
      CREATE INDEX IF NOT EXISTS artifacts_cleanup ON artifacts(owner_id,COALESCE(deleting_at,expires_at),id)
        WHERE expires_at IS NOT NULL OR deleting_at IS NOT NULL;
    `);
    if (!existing.rowCount)
      await artifacts.query(
        `UPDATE artifacts a SET expires_at=clock_timestamp()+interval '24 hours'
         WHERE a.owner_id=$1 AND a.thread_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.owner_id=$1
           AND m.attachments @> jsonb_build_array(jsonb_build_object('id',a.id::text)))`,
        [ownerId],
      );
  }, pool);
}
