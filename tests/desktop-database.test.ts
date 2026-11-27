import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import pg from 'pg';

type HostDatabase = { url: string; pendingMove: boolean; close(): Promise<void> };
const { moveDatabase, openDatabase } = (await import(
  '../desktop/runtime/database.mjs' as string
)) as {
  moveDatabase(options: {
    source: string;
    target: string;
    schema(section: string): Promise<string>;
    signal?: AbortSignal;
    space?(bytes: number): Promise<void>;
  }): Promise<void>;
  openDatabase(options: { dataRoot: string; resourcesPath: string }): Promise<HostDatabase>;
};
const binaries = join(
  process.cwd(),
  'postgres',
  'bin',
  process.platform === 'win32' ? 'postgres.exe' : 'postgres',
);

const pre = `\\restrict synthetic
CREATE SCHEMA jobs;
CREATE TABLE public.threads (
  id bigint GENERATED ALWAYS AS IDENTITY,
  title text NOT NULL,
  meta jsonb,
  at timestamptz NOT NULL,
  raw bytea
);
CREATE TABLE jobs.queue (id serial, thread_id bigint NOT NULL, state text);
\\unrestrict synthetic`;
const post = `ALTER TABLE ONLY public.threads ADD CONSTRAINT threads_pkey PRIMARY KEY (id);
ALTER TABLE ONLY jobs.queue ADD CONSTRAINT queue_pkey PRIMARY KEY (id);
ALTER TABLE ONLY jobs.queue ADD CONSTRAINT queue_thread FOREIGN KEY (thread_id) REFERENCES public.threads(id);
CREATE INDEX threads_at ON public.threads (at);`;

const snapshot = `SELECT
  (SELECT md5(string_agg(concat_ws('|', id, title, meta::text, to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US'), encode(raw, 'hex')), ',' ORDER BY id)) FROM public.threads) AS threads,
  (SELECT md5(string_agg(concat_ws('|', id, thread_id, state), ',' ORDER BY id)) FROM jobs.queue) AS queue,
  (SELECT count(*)::int FROM pg_indexes WHERE indexname = 'threads_at') AS indexes`;

test(
  'moving the database copies every row, sequence and constraint, or nothing',
  { skip: !process.env.TEST_DATABASE_URL && !existsSync(binaries) },
  async (t) => {
    const cleanup: (() => Promise<unknown>)[] = [];
    t.after(async () => {
      for (const step of cleanup.reverse()) await step().catch(() => {});
    });
    let url = process.env.TEST_DATABASE_URL;
    if (!url) {
      const root = await mkdtemp(join(tmpdir(), 'nod-move-server-'));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const server = await openDatabase({ dataRoot: root, resourcesPath: process.cwd() });
      cleanup.push(() => server.close());
      url = server.url;
    }
    const databaseUrl = (name: string) => {
      const address = new URL(url);
      address.pathname = `/${name}`;
      return address.toString();
    };
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const names = ['from', 'to', 'busy', 'broken'].map((name) => `move_${name}_${suffix}`);
    const [source, target, busy, broken] = names;
    const admin = new pg.Client({ connectionString: url });
    const clients: pg.Client[] = [];
    cleanup.push(async () => {
      await Promise.all(clients.map((client) => client.end()));
      for (const name of names) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    });
    await admin.connect();
    for (const name of names) await admin.query(`CREATE DATABASE ${name}`);
    const open = async (name: string) => {
      const client = new pg.Client({ connectionString: databaseUrl(name) });
      await client.connect();
      clients.push(client);
      return client;
    };
    const tables = async (client: pg.Client) =>
      (
        await client.query(
          "SELECT tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema')",
        )
      ).rows;
    const original = await open(source);
    await original.query(pre.replace(/^\\(?:un)?restrict .+$/gm, ''));
    await original.query(post);
    for (let index = 0; index < 40; index++)
      await original.query(
        `INSERT INTO public.threads (title, meta, at, raw)
         VALUES ($1, $2, '2026-11-27T09:00:00Z'::timestamptz + make_interval(secs => $3), $4)`,
        [
          `Synthetic thread ${index}\nwith ünïcödé, a tab\tand a \\ backslash`,
          { index, nested: { list: [index, null, 'x'] } },
          index * 1.234567,
          Buffer.from([0, index, 255, 0]),
        ],
      );
    await original.query(
      'INSERT INTO jobs.queue (thread_id, state) SELECT id, $1 FROM public.threads WHERE id % 3 = 0',
      ['queued'],
    );
    const expected = (await original.query(snapshot)).rows[0];
    const schema = async (section: string) => (section === 'pre-data' ? pre : post);

    await moveDatabase({ source: databaseUrl(source), target: databaseUrl(target), schema });

    const moved = await open(target);
    assert.deepEqual((await moved.query(snapshot)).rows[0], expected);
    assert.equal(
      (
        await moved.query(
          "INSERT INTO public.threads (title, at) VALUES ('next', now()) RETURNING id::int",
        )
      ).rows[0].id,
      41,
    );
    assert.equal(
      (await moved.query('INSERT INTO jobs.queue (thread_id) VALUES (1) RETURNING id')).rows[0].id,
      14,
    );
    await assert.rejects(
      moved.query('INSERT INTO jobs.queue (thread_id) VALUES (999)'),
      /queue_thread/,
    );
    await assert.rejects(
      moved.query(
        "INSERT INTO public.threads (id, title, at) OVERRIDING SYSTEM VALUE VALUES (1, 'twin', now())",
      ),
      /threads_pkey/,
    );
    await assert.rejects(moved.query('INSERT INTO public.threads (at) VALUES (now())'), /not-null/);

    const current = (await moved.query(snapshot)).rows[0];
    await moveDatabase({
      source: databaseUrl(source),
      target: databaseUrl(target),
      schema,
      space: async () => {
        throw new Error('A committed move must not need disk space again.');
      },
    });
    assert.deepEqual((await moved.query(snapshot)).rows[0], current);

    const occupied = await open(busy);
    await occupied.query('CREATE SCHEMA jobs');
    await assert.rejects(
      moveDatabase({ source: databaseUrl(source), target: databaseUrl(busy), schema }),
      /already exists/,
    );
    assert.deepEqual(await tables(occupied), []);

    let needed = 0;
    await assert.rejects(
      moveDatabase({
        source: databaseUrl(source),
        target: databaseUrl(broken),
        schema,
        space: async (bytes) => {
          needed = bytes;
          throw Object.assign(new Error('Synthetic disk is full.'), {
            code: 'NOD_DATABASE_STORAGE_FULL',
          });
        },
      }),
      { code: 'NOD_DATABASE_STORAGE_FULL' },
    );
    assert.ok(needed > 0);
    assert.deepEqual(await tables(await open(broken)), []);

    await assert.rejects(
      moveDatabase({
        source: databaseUrl(source),
        target: databaseUrl(broken),
        schema: async (section) => (section === 'pre-data' ? pre : `${post}\nSELECT missing();`),
      }),
      /missing/,
    );
    assert.deepEqual(await tables(await open(broken)), []);
  },
);

test(
  'the host database restarts after a crash, quits cleanly and keeps its data',
  { skip: !existsSync(binaries) },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-host-database-ü-'));
    const opened: HostDatabase[] = [];
    let pool: pg.Pool | undefined;
    t.after(async () => {
      await pool?.end().catch(() => {});
      for (const database of opened.reverse()) await database.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    });
    const open = async () => {
      const database = await openDatabase({ dataRoot: root, resourcesPath: process.cwd() });
      opened.push(database);
      return database;
    };
    const postmaster = () =>
      Number(readFileSync(join(root, 'database', 'data', 'postmaster.pid'), 'utf8').split('\n')[0]);
    const database = await open();
    assert.equal(database.pendingMove, false);
    pool = new pg.Pool({ connectionString: database.url, max: 2 });
    pool.on('error', () => {});
    await pool.query('CREATE TABLE synthetic (value text)');
    await pool.query("INSERT INTO synthetic VALUES ('kept')");
    const crashed = postmaster();
    process.kill(crashed, 'SIGKILL');
    let value: string | undefined;
    for (let attempt = 0; attempt < 60 && !value; attempt++) {
      await delay(500);
      value = await pool.query('SELECT value FROM synthetic').then(
        (result) => result.rows[0].value,
        () => undefined,
      );
    }
    assert.equal(value, 'kept');
    assert.notEqual(postmaster(), crashed);
    process.kill(postmaster(), 'SIGKILL');
    await database.close();
    const kept = async (handle: HostDatabase) => {
      const client = new pg.Client({ connectionString: handle.url });
      await client.connect();
      try {
        return (await client.query('SELECT value FROM synthetic')).rows[0].value;
      } finally {
        await client.end();
      }
    };
    const reopened = await open();
    assert.equal(await kept(reopened), 'kept');
    await reopened.close();
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise((resolve) => closed.close(resolve));
    writeFileSync(
      join(root, 'database', 'data', 'postmaster.pid'),
      `${process.pid}\n${join(root, 'database', 'data')}\n0\n${port}\n\n127.0.0.1\n0 0\nready   \n`,
    );
    const reused = await open();
    assert.equal(await kept(reused), 'kept');
  },
);
