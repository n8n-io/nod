import pg from 'pg';
import { databaseUrl } from './config.ts';

function poolSize(value: string | undefined, fallback: number) {
  const size = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(size) || size < 1 || size > 12)
    throw new Error('The database pool size must be between 1 and 12.');
  return size;
}

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: poolSize(process.env.DATABASE_POOL_MAX, 12),
  connectionTimeoutMillis: 10_000,
});

export function createInspectorPool() {
  return new pg.Pool({
    connectionString: databaseUrl,
    max: poolSize(process.env.INSPECTOR_DATABASE_POOL_MAX, 2),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 500,
    query_timeout: 750,
  });
}

export async function initializeDatabase() {
  if (!databaseUrl)
    throw new Error('Run npm run dev to configure the local database, or set DATABASE_URL.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tasks (
      id uuid PRIMARY KEY, owner_id text NOT NULL, title text NOT NULL, prompt text NOT NULL,
      status text NOT NULL DEFAULT 'queued', revision integer NOT NULL DEFAULT 0, error text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, owner_id text NOT NULL, role text NOT NULL, text text NOT NULL,
      task_id uuid REFERENCES tasks(id), attachments jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS conversation_revision integer NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS conversations (
      owner_id text NOT NULL, channel text NOT NULL, revision integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(owner_id,channel)
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS stream_id text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS assistant_reaction text;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS assistant_reacted_at timestamptz;
    UPDATE messages SET assistant_reacted_at=created_at WHERE assistant_reaction IS NOT NULL AND assistant_reacted_at IS NULL;
    CREATE INDEX IF NOT EXISTS messages_owner_agent_reaction_time ON messages(owner_id,assistant_reacted_at DESC) WHERE assistant_reacted_at IS NOT NULL;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reaction_revision integer NOT NULL DEFAULT 0;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_message_id uuid REFERENCES messages(id);
    CREATE TABLE IF NOT EXISTS task_events (
      id uuid PRIMARY KEY, task_id uuid NOT NULL REFERENCES tasks(id), type text NOT NULL,
      summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS artifacts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid REFERENCES tasks(id), name text NOT NULL,
      mime_type text NOT NULL, size integer NOT NULL, storage_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS memory_facts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, text text NOT NULL, source_message_id uuid REFERENCES messages(id),
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id,text)
    );
    CREATE TABLE IF NOT EXISTS preferences (
      owner_id text PRIMARY KEY, notification_rule text NOT NULL DEFAULT '', time_zone text NOT NULL DEFAULT 'Europe/Lisbon',
      quiet_start text NOT NULL DEFAULT '22:00', quiet_end text NOT NULL DEFAULT '08:00',
      quiet_hours_enabled boolean NOT NULL DEFAULT true
    );
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS quiet_hours_enabled boolean NOT NULL DEFAULT true;
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS locale text;
    ALTER TABLE preferences ADD COLUMN IF NOT EXISTS hour_cycle text NOT NULL DEFAULT 'auto' CHECK (hour_cycle IN ('auto','h12','h23'));
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY, event_id text UNIQUE NOT NULL, owner_id text NOT NULL, summary text NOT NULL,
      decision text NOT NULL, reason text NOT NULL, feedback text, task_id uuid REFERENCES tasks(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_owner_time ON messages(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_task_time ON messages(task_id,created_at);
    CREATE INDEX IF NOT EXISTS task_events_task_time ON task_events(task_id,created_at);
    CREATE TABLE IF NOT EXISTS inspector_records (
      id uuid PRIMARY KEY, owner_id text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      revision integer NOT NULL, kind text NOT NULL, name text NOT NULL, status text NOT NULL,
      input jsonb, output jsonb, error text, usage jsonb, duration_ms double precision,
      started_at timestamptz NOT NULL, finished_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS inspector_records_task_time ON inspector_records(owner_id,task_id,started_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS inspector_records_retention ON inspector_records(recorded_at);
  `);
}

export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await fn(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
