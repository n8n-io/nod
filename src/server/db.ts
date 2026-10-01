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
    CREATE TABLE IF NOT EXISTS threads (
      id uuid PRIMARY KEY, owner_id text NOT NULL, status text NOT NULL DEFAULT 'idle',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      archived_at timestamptz
    );
    CREATE UNIQUE INDEX IF NOT EXISTS threads_active_owner ON threads(owner_id) WHERE archived_at IS NULL;
    CREATE TABLE IF NOT EXISTS turns (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid NOT NULL REFERENCES threads(id),
      source text NOT NULL, source_id text, message_id uuid, prompt text NOT NULL,
      channel text NOT NULL DEFAULT 'web', channel_source_id text, status text NOT NULL DEFAULT 'queued', waiting_reason text,
      background boolean NOT NULL DEFAULT false, read_only boolean NOT NULL DEFAULT false,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz
    );
    ALTER TABLE turns ADD COLUMN IF NOT EXISTS channel_source_id text;
    CREATE UNIQUE INDEX IF NOT EXISTS turns_owner_source ON turns(owner_id,source_id) WHERE source_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS turns_thread_queue ON turns(thread_id,status,created_at,id);
    CREATE TABLE IF NOT EXISTS turn_events (
      id uuid PRIMARY KEY, turn_id uuid NOT NULL REFERENCES turns(id), type text NOT NULL,
      summary text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS turn_events_turn_time ON turn_events(turn_id,created_at);
    CREATE TABLE IF NOT EXISTS messages (
      id uuid PRIMARY KEY, owner_id text NOT NULL, role text NOT NULL, text text NOT NULL,
      thread_id uuid REFERENCES threads(id), turn_id uuid REFERENCES turns(id),
      attachments jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT now(),
      stream_id text, reaction text, assistant_reaction text, assistant_reacted_at timestamptz,
      reaction_revision integer NOT NULL DEFAULT 0, reply_to_message_id uuid REFERENCES messages(id)
    );
    CREATE INDEX IF NOT EXISTS messages_owner_agent_reaction_time ON messages(owner_id,assistant_reacted_at DESC) WHERE assistant_reacted_at IS NOT NULL;
    CREATE TABLE IF NOT EXISTS artifacts (
      id uuid PRIMARY KEY, owner_id text NOT NULL, thread_id uuid REFERENCES threads(id), name text NOT NULL,
      mime_type text NOT NULL, size integer NOT NULL, storage_path text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS preferences (
      owner_id text PRIMARY KEY, notification_rule text NOT NULL DEFAULT '', time_zone text,
      quiet_start text NOT NULL DEFAULT '22:00', quiet_end text NOT NULL DEFAULT '08:00',
      quiet_hours_enabled boolean NOT NULL DEFAULT true, locale text,
      hour_cycle text NOT NULL DEFAULT 'auto' CHECK (hour_cycle IN ('auto','h12','h23'))
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='preferences'::regclass AND attname='time_zone' AND attnotnull) THEN
        ALTER TABLE preferences ALTER COLUMN time_zone DROP NOT NULL, ALTER COLUMN time_zone DROP DEFAULT;
        UPDATE preferences SET time_zone=NULL WHERE time_zone='Europe/Lisbon';
      END IF;
    END $$;
    CREATE TABLE IF NOT EXISTS notifications (
      id uuid PRIMARY KEY, event_id text UNIQUE NOT NULL, owner_id text NOT NULL, summary text NOT NULL,
      decision text NOT NULL, reason text NOT NULL, feedback text, turn_id uuid REFERENCES turns(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      kind text NOT NULL DEFAULT 'external' CHECK (kind IN ('external','review'))
    );
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT 'classify'
      CHECK (intent IN ('classify','inspect_message'));
    CREATE TABLE IF NOT EXISTS app_activity_checks (
      owner_id text NOT NULL,connection_id uuid NOT NULL,turn_id uuid REFERENCES turns(id),
      attempted_at timestamptz NOT NULL,checked_at timestamptz,recorded_at timestamptz,
      value text NOT NULL DEFAULT '',summary text NOT NULL DEFAULT '',
      PRIMARY KEY(owner_id,connection_id)
    );
    CREATE INDEX IF NOT EXISTS messages_owner_time ON messages(owner_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_thread_time ON messages(thread_id,created_at);
    CREATE INDEX IF NOT EXISTS messages_turn_time ON messages(turn_id,created_at);
    CREATE TABLE IF NOT EXISTS inspector_records (
      id uuid PRIMARY KEY, owner_id text NOT NULL,
      thread_id uuid REFERENCES threads(id) ON DELETE CASCADE, turn_id uuid REFERENCES turns(id) ON DELETE CASCADE,
      kind text NOT NULL, name text NOT NULL, status text NOT NULL,
      input jsonb, output jsonb, error text, usage jsonb, duration_ms double precision,
      started_at timestamptz NOT NULL, finished_at timestamptz, recorded_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS inspector_records_turn_time ON inspector_records(owner_id,turn_id,started_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS inspector_records_thread_time ON inspector_records(owner_id,thread_id,started_at DESC,id DESC);
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
