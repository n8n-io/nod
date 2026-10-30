import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { BrowserActionError } from '../src/ports/computer.ts';
import { IntegrationDownload } from '../src/ports/integrations.ts';
import { ObjectStoreConflict } from '../src/ports/object-storage.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  completedDownloads,
  decodeDownloadChunk,
  downloadFile,
  readDownload,
} from '../src/providers/agent-browser/downloads.ts';
import { fileBytes } from '../src/shared/files.ts';
import { createComposioFiles } from '../src/providers/composio/downloads.ts';
import {
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { createPostgresObjectStore } from '../src/server/object-storage.ts';
import { browserDownloadPdf, createBrowserDownloadFixture } from './browser-download-fixture.ts';

async function createDownloadBrowser(root: string) {
  const socketPath = join(root, 'control.sock');
  let browserRoot = '';
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: (dataRoot) => {
      browserRoot = dataRoot;
      return createAgentBrowserComputer({
        dataRoot,
        browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
        privateNetwork: true,
        headless: true,
        evictIdleMs: 0,
      });
    },
  });
  const launch: BrowserBridgeLauncher = () => {
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    void runBrowserBridge({ socketPath, input: process.stdin, output: process.stdout }).then(
      () => process.emit('close', 0),
      () => process.emit('close', 1),
    );
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const value = createContainerBrowserComputer({
    dataRoot: join(root, 'owner'),
    spawn: launch,
  });
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new Error(`Native browser fixture stage: ${name}`, { cause: error });
    }
  };
  const computer = {
    ...value,
    act: (...args: Parameters<typeof value.act>) =>
      step(`act:${args[0]}:${args[1].action}`, () => value.act(...args)),
    download: (...args: Parameters<NonNullable<typeof value.download>>) =>
      step(`download:${args[0]}`, () => value.download!(...args)),
    close: (...args: Parameters<typeof value.close>) =>
      step(`close:${args[0]}`, () => value.close(...args)),
  };
  return {
    computer,
    browserRoot: () => browserRoot,
    close: async () => {
      try {
        await computer.dispose();
      } finally {
        await worker.close();
      }
    },
  };
}

test('browser file validation bounds bytes and rejects unsafe metadata', async () => {
  assert.deepEqual(
    downloadFile(
      decodeDownloadChunk(browserDownloadPdf.toString('base64')),
      undefined,
      'text/plain',
    ),
    {
      bytes: browserDownloadPdf,
      name: 'download.pdf',
      mimeType: 'application/pdf',
    },
  );
  assert.throws(() => decodeDownloadChunk('Zh=='));
  assert.throws(() => decodeDownloadChunk('Zg==trailing'));
  assert.throws(() => downloadFile(Buffer.alloc(fileBytes + 1)));
  assert.throws(() => downloadFile(Buffer.alloc(0)));
  for (const name of ['../private', 'folder/file', 'folder\\file', '.', '..', 'file\nname'])
    assert.throws(() => downloadFile(browserDownloadPdf, name));
  assert.throws(() => downloadFile(Buffer.from('text'), 'file', 'text/html\r\nX-Header: value'));
});

test('browser captures refuse symlinks, partial files, multiple links and excessive file size', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sk-download-files-'));
  try {
    const directory = join(root, 'downloads');
    await mkdir(directory);
    await writeFile(join(root, 'private'), 'private sentinel');
    await symlink(join(root, 'private'), join(directory, 'private.pdf'));
    await writeFile(join(directory, 'partial.crdownload'), browserDownloadPdf);
    assert.deepEqual(await completedDownloads(directory), []);
    await assert.rejects(readDownload(directory, 'private.pdf'));
    await link(join(root, 'private'), join(directory, 'linked.pdf'));
    await assert.rejects(readDownload(directory, 'linked.pdf'));
    await assert.rejects(readDownload(directory, '../private'));
    await writeFile(join(directory, 'invoice.pdf'), browserDownloadPdf);
    assert.deepEqual((await readDownload(directory, 'invoice.pdf')).bytes, browserDownloadPdf);
    await writeFile(join(directory, 'later.pdf'), browserDownloadPdf);
    await utimes(join(directory, 'invoice.pdf'), new Date(1_000_000), new Date(1_000_000));
    assert.equal((await completedDownloads(directory))[0], 'later.pdf');
    await writeFile(join(directory, 'large'), Buffer.alloc(fileBytes + 1));
    await assert.rejects(readDownload(directory, 'large'));
    await symlink(directory, join(root, 'alias'));
    await assert.rejects(completedDownloads(join(root, 'alias')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'authenticated browser PDFs cross the real private bridge without sharing the profile',
  {
    skip: !process.env.NOD_TEST_BROWSER_EXECUTABLE,
    timeout: 180_000,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sk-download-bridge-'));
    try {
      const fixture = await createBrowserDownloadFixture();
      try {
        const bridge = await createDownloadBrowser(root);
        const computer = bridge.computer;
        try {
          assert.equal((await fetch(`${fixture.origin}/invoice.pdf`)).status, 403);
          for (const [id, input, control] of [
            ['attachment', { selector: '#download', name: 'invoice.pdf' }, false],
            ['inline-url', { url: `${fixture.origin}/inline.pdf`, name: 'invoice.pdf' }, false],
            ['blob', { selector: '#blob', name: 'invoice.pdf' }, true],
            ['blob-anchor', { selector: '#blob-anchor', name: 'invoice.pdf' }, true],
          ] as const) {
            await computer.act(id, { action: 'open', url: `${fixture.origin}/session` });
            const before = fixture.authenticatedDownloads();
            if (control) {
              await assert.rejects(
                computer.download!(id, input),
                (error: Error) =>
                  error.cause instanceof BrowserActionError &&
                  error.cause.code === 'browser_download_control',
              );
              assert.equal(fixture.authenticatedDownloads(), before);
            }
            const file = await computer.download!(
              id,
              control ? { ...input, expectOrigin: fixture.origin } : input,
            );
            assert.equal(fixture.authenticatedDownloads(), before + 1);
            assert.deepEqual(file, {
              bytes: browserDownloadPdf,
              name: 'invoice.pdf',
              mimeType: 'application/pdf',
            });
          }
          await computer.act('cross-inline', { action: 'open', url: `${fixture.origin}/session` });
          const redirected = fixture.authenticatedDownloads();
          await assert.rejects(
            computer.download!('cross-inline', { url: `${fixture.origin}/redirect.pdf` }),
          );
          assert.equal(fixture.authenticatedDownloads(), redirected + 1);
          await computer.act('cross-inline', {
            action: 'open',
            url: `${fixture.crossOrigin}/inline.pdf`,
          });
          assert.deepEqual(
            (await computer.download!('cross-inline', {})).bytes,
            browserDownloadPdf,
          );
          await computer.act('blob-anchor', { action: 'click', selector: '#download' });
          assert.deepEqual((await computer.download!('blob-anchor', {})).bytes, browserDownloadPdf);
          await computer.act('current-inline', {
            action: 'open',
            url: `${fixture.origin}/session`,
          });
          await computer.act('current-inline', { action: 'click', selector: '#download' });
          await computer.act('current-inline', {
            action: 'open',
            url: `${fixture.origin}/inline.pdf?version=current`,
          });
          assert.deepEqual(
            (await computer.download!('current-inline', {})).bytes,
            Buffer.concat([browserDownloadPdf, Buffer.from('% current document\n')]),
          );
          await computer.close('attachment');
          await computer.act('popup', { action: 'open', url: `${fixture.origin}/session` });
          const beforePopup = fixture.authenticatedDownloads();
          try {
            await computer.act('popup', { action: 'click', selector: '#popup' });
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !(error.cause instanceof BrowserActionError) ||
              error.cause.code !== 'browser_observation_failed'
            )
              throw error;
            assert.ok((await computer.screenshot('popup'))?.length);
            assert.equal(computer.screenStatus!('popup').state, 'live');
          }
          assert.deepEqual(
            (await computer.download!('popup', { name: 'popup.pdf' })).bytes,
            browserDownloadPdf,
          );
          assert.equal(fixture.authenticatedDownloads(), beforePopup + 1);
          await assert.rejects(computer.download!('unrelated-task', {}));
          await assert.rejects(computer.download!('popup', { url: 'file:///etc/passwd' }));
          assert.equal(fixture.unauthenticatedDownloads(), 1);
          for (const [id, input] of [
            ['cross-selector', { selector: '#cross-origin', name: 'hosted.pdf' }],
            ['cross-url', { url: `${fixture.crossOrigin}/invoice.pdf`, name: 'hosted.pdf' }],
          ] as const) {
            await t.test(id, async () => {
              await computer.act(id, { action: 'open', url: `${fixture.origin}/session` });
              const before = fixture.authenticatedDownloads();
              assert.deepEqual((await computer.download!(id, input)).bytes, browserDownloadPdf);
              assert.equal(fixture.authenticatedDownloads(), before + 1);
            });
          }
          await computer.act('large', { action: 'open', url: `${fixture.origin}/session` });
          const downloads = join(bridge.browserRoot(), 'runtime', 'downloads', 'large');
          await mkdir(downloads, { recursive: true });
          await writeFile(join(downloads, 'previous.pdf'), browserDownloadPdf);
          await writeFile(join(downloads, 'previous.crdownload'), 'preexisting partial');
          await assert.rejects(
            computer.download!('large', { selector: '#large', expectOrigin: fixture.origin }),
          );
          assert.deepEqual((await readdir(downloads)).sort(), [
            'previous.crdownload',
            'previous.pdf',
          ]);
          assert.deepEqual(await readFile(join(downloads, 'previous.pdf')), browserDownloadPdf);
          assert.equal(
            await readFile(join(downloads, 'previous.crdownload'), 'utf8'),
            'preexisting partial',
          );
          await computer.act('slow', { action: 'open', url: `${fixture.origin}/session` });
          const slowDirectory = join(bridge.browserRoot(), 'runtime', 'downloads', 'slow');
          await mkdir(slowDirectory, { recursive: true });
          await writeFile(join(slowDirectory, 'previous.pdf'), browserDownloadPdf);
          const abort = new AbortController();
          const failed = assert.rejects(
            computer.download!(
              'slow',
              { selector: '#slow', expectOrigin: fixture.origin },
              abort.signal,
            ),
          );
          await fixture.slowDownloadStarted();
          abort.abort();
          await failed;
          assert.deepEqual(await readdir(slowDirectory), ['previous.pdf']);
          assert.deepEqual(await readFile(join(slowDirectory, 'previous.pdf')), browserDownloadPdf);
        } finally {
          await bridge.close();
        }
      } finally {
        await fixture.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

async function fixture() {
  const schema = 'test_private_objects_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema}`,
  });
  return {
    database,
    async close() {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

test(
  'PostgreSQL private objects survive adapter restart, isolate owners and atomically fence concurrent writers',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    const key = `sessions/${randomUUID()}.jsonl`;
    const first = createPostgresObjectStore({ database: f.database, ownerId: 'owner-one' });
    const second = createPostgresObjectStore({ database: f.database, ownerId: 'owner-two' });
    try {
      await f.database.query(`CREATE TABLE private_objects (
        owner_id text NOT NULL, object_key text NOT NULL, version text NOT NULL,
        bytes bytea NOT NULL,
        PRIMARY KEY(owner_id,object_key)
      )`);
      await Promise.all(
        Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).initialize()),
      );
      const borrowed = await f.database.connect();
      const query = borrowed.query.bind(borrowed);
      let collided = false;
      try {
        await borrowed.query('BEGIN');
        await borrowed.query("SET LOCAL lock_timeout='2s'");
        borrowed.query = ((statement: string, values?: unknown[]) => {
          if (
            !collided &&
            statement === 'CREATE TABLE IF NOT EXISTS nod_locks (key text PRIMARY KEY)'
          ) {
            collided = true;
            return query("CREATE TYPE nod_locks AS ENUM ('collision')");
          }
          return query(statement, values);
        }) as typeof borrowed.query;
        await createPostgresObjectStore({ database: borrowed, ownerId: 'owner-one' }).initialize();
        assert.equal(collided, true);
        assert.equal((await borrowed.query('SHOW lock_timeout')).rows[0].lock_timeout, '2s');
      } finally {
        borrowed.query = query;
        await borrowed.query('ROLLBACK');
        borrowed.release();
      }
      const large = Buffer.alloc(20 * 1024 * 1024, 7);
      const artifact = `artifacts/${randomUUID()}`;
      await first.write(artifact, large, { expectedVersion: null });
      assert.deepEqual((await first.read(artifact, large.length))?.bytes, large);
      const original = await first.write(key, Buffer.from('original'), { expectedVersion: null });
      assert.equal(await second.read(key, 100), undefined);
      await second.write(key, Buffer.from('foreign'), { expectedVersion: null });
      const writes = await Promise.allSettled(
        Array.from({ length: 12 }, (_, i) =>
          first.write(key, Buffer.from('winner-' + i), { expectedVersion: original }),
        ),
      );
      assert.equal(writes.filter((value) => value.status === 'fulfilled').length, 1);
      assert.ok(
        writes
          .filter((value) => value.status === 'rejected')
          .every((value) => value.reason instanceof ObjectStoreConflict),
      );
      const restored = createPostgresObjectStore({ database: f.database, ownerId: 'owner-one' });
      const saved = await restored.read(key, 100);
      assert.match(saved!.bytes.toString(), /^winner-\d+$/);
      assert.equal((await second.read(key, 100))?.bytes.toString(), 'foreign');
      await assert.rejects(first.read(key, 2), /unavailable/);
      await assert.rejects(first.read('../other-owner/key', 100), /unavailable/);
      await assert.rejects(
        first.write(key, Buffer.alloc(fileBytes + 1), { expectedVersion: saved!.version }),
        /unavailable/,
      );
      await assert.rejects(first.remove(key, { expectedVersion: original }), ObjectStoreConflict);
      await assert.rejects(first.remove(key, { expectedVersion: '' }), /unavailable/);
      await restored.remove(key, { expectedVersion: saved!.version });
      assert.equal(await first.read(key, 100), undefined);
      assert.equal((await second.read(key, 100))?.bytes.toString(), 'foreign');
    } finally {
      await f.close();
    }
  },
);

test(
  'private artifacts survive actor restart and remain owned for downloads and channel delivery',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-artifact-store-'));
    const schema = 'test_durable_artifacts_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await database.query(
        `CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL); CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid REFERENCES threads(id),name text NOT NULL CHECK(name <> 'reject'),mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL,expires_at timestamptz,deleting_at timestamptz)`,
      );
      const thread = randomUUID();
      const foreignThread = randomUUID();
      await database.query('INSERT INTO threads VALUES($1,$2),($3,$4)', [
        thread,
        'owner-one',
        foreignThread,
        'owner-two',
      ]);
      const create = (ownerId: string) =>
        createArtifactService({
          database,
          ownerId,
          localRoot: join(root, ownerId),
        });
      const original = create('owner-one');
      const saved = await original.storeArtifact(
        Buffer.from('synthetic file'),
        'private.txt',
        'text/plain',
        thread,
      );
      const restored = create('owner-one');
      assert.equal((await restored.readArtifact(saved.id)).toString(), 'synthetic file');
      assert.equal(
        Buffer.from(
          await (await restored.readThreadArtifacts(thread, [saved.id]))[0].read(),
        ).toString(),
        'synthetic file',
      );
      await assert.rejects(create('owner-two').readArtifact(saved.id), /unavailable/);
      await assert.rejects(
        create('owner-two').readThreadArtifacts(foreignThread, [saved.id]),
        /unavailable/,
      );
      await assert.rejects(
        restored.storeArtifact(Buffer.from('x'), 'file', 'text/plain', foreignThread),
        /conversation is unavailable/,
      );
      const before = await readdir(join(root, 'owner-one', 'artifacts'));
      await assert.rejects(restored.storeArtifact(Buffer.from('cleanup'), 'reject', 'text/plain'));
      assert.deepEqual(await readdir(join(root, 'owner-one', 'artifacts')), before);
      await database.query('UPDATE artifacts SET storage_path=$1 WHERE id=$2', [
        'object:artifacts/' + randomUUID(),
        saved.id,
      ]);
      await assert.rejects(restored.readArtifact(saved.id), /unavailable/);
    } finally {
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'temporary artifacts expire safely across retention, interrupted writes and cleanup restarts',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-artifact-lifecycle-'));
    const schema = 'test_artifact_lifecycle_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    const services: ReturnType<typeof createArtifactService>[] = [];
    const create = (ownerId: string, localRoot = root) => {
      const service = createArtifactService({ database, ownerId, localRoot });
      services.push(service);
      return service;
    };
    const directory = (ownerId: string) =>
      join(root, 'artifacts', createHash('sha256').update(ownerId).digest('hex'));
    const path = (ownerId: string, id: string) => join(directory(ownerId), id);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const age = (owner: string, ids: string[]) =>
      database.query(
        "UPDATE artifacts SET expires_at=now()-interval '1 hour' WHERE owner_id=$1 AND id=ANY($2::uuid[])",
        [owner, ids],
      );
    const absent = (file: string) => assert.rejects(readFile(file), { code: 'ENOENT' });
    t.after(async () => {
      await Promise.all(services.map((service) => service.close()));
      await database.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    });
    await database.query(`
      CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL);
      CREATE TABLE messages(id uuid PRIMARY KEY,owner_id text NOT NULL,attachments jsonb NOT NULL DEFAULT '[]');
      CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid REFERENCES threads(id),
        name text NOT NULL,mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz,deleting_at timestamptz);
    `);

    await t.test(
      'expiry preserves sent, published, retained and renewed files, including legacy rows',
      async () => {
        const owner = 'lease-owner';
        const service = create(owner);
        const thread = randomUUID();
        await database.query('INSERT INTO threads VALUES($1,$2)', [thread, owner]);
        const abandoned = await service.storeUpload(
          Buffer.from('abandoned'),
          'abandoned',
          'text/plain',
        );
        const sent = await service.storeUpload(Buffer.from('sent'), 'sent', 'text/plain');
        const published = await service.storeArtifact(
          Buffer.from('published'),
          'published',
          'text/plain',
          thread,
        );
        const retained = await service.storeArtifact(
          Buffer.from('retained'),
          'retained',
          'text/plain',
        );
        const recent = await service.storeUpload(Buffer.from('recent'), 'recent', 'text/plain');
        const renewed = await service.storeUpload(Buffer.from('renewed'), 'renewed', 'text/plain');
        const legacy = await service.storeUpload(Buffer.from('legacy'), 'legacy', 'text/plain');
        const legacyPath = join(root, 'artifacts', legacy.id);
        await rename(path(owner, legacy.id), legacyPath);
        await database.query('UPDATE artifacts SET storage_path=$3 WHERE owner_id=$1 AND id=$2', [
          owner,
          legacy.id,
          legacyPath,
        ]);
        assert.equal((await service.readArtifact(legacy.id)).toString(), 'legacy');
        await database.query('INSERT INTO messages VALUES($1,$2,$3)', [
          randomUUID(),
          owner,
          JSON.stringify([sent]),
        ]);
        await age(owner, [abandoned.id, sent.id, published.id, renewed.id, legacy.id]);
        const available = await service.renewUploads([
          renewed.id,
          retained.id,
          renewed.id,
          randomUUID(),
        ]);
        assert.deepEqual(available.map((file) => file.id).sort(), [renewed.id, retained.id].sort());
        const renewedRow = (
          await database.query('SELECT expires_at FROM artifacts WHERE owner_id=$1 AND id=$2', [
            owner,
            renewed.id,
          ])
        ).rows[0];
        assert.ok(renewedRow.expires_at.getTime() > Date.now() + 23 * 60 * 60 * 1000);
        assert.equal((await service.sweep()).removed, 2);
        await absent(path(owner, abandoned.id));
        await absent(legacyPath);
        for (const [file, content] of [
          [sent, 'sent'],
          [published, 'published'],
          [retained, 'retained'],
          [recent, 'recent'],
          [renewed, 'renewed'],
        ] as const)
          assert.equal((await service.readArtifact(file.id)).toString(), content);
        assert.equal(
          (
            await database.query('SELECT thread_id FROM artifacts WHERE owner_id=$1 AND id=$2', [
              owner,
              sent.id,
            ])
          ).rows[0].thread_id,
          null,
        );
        assert.equal(
          (
            await database.query('SELECT expires_at FROM artifacts WHERE owner_id=$1 AND id=$2', [
              owner,
              retained.id,
            ])
          ).rows[0].expires_at,
          null,
        );
      },
    );

    await t.test('renewal and retention require available backing files', async (t) => {
      const owner = 'availability-owner';
      const service = create(owner);
      const available = await service.storeUpload(
        Buffer.from('valid bytes'),
        'valid',
        'text/plain',
      );
      const retained = await service.storeArtifact(
        Buffer.from('retained bytes'),
        'retained',
        'text/plain',
      );
      const legacy = await service.storeUpload(Buffer.from('legacy bytes'), 'legacy', 'text/plain');
      const legacyPath = join(root, 'artifacts', legacy.id);
      await rename(path(owner, legacy.id), legacyPath);
      await database.query('UPDATE artifacts SET storage_path=$3 WHERE owner_id=$1 AND id=$2', [
        owner,
        legacy.id,
        legacyPath,
      ]);
      const mutations: Record<string, (file: string) => Promise<unknown>> = {
        missing: unlink,
        truncated: (file) => writeFile(file, 'short'),
        oversized: (file) => writeFile(file, 'longer than the original bytes'),
        symlink: async (file) => {
          await unlink(file);
          await symlink(path(owner, available.id), file);
        },
        directory: async (file) => {
          await unlink(file);
          await mkdir(file);
        },
      };
      const rejected: Array<typeof available> = [];
      for (const [name, mutate] of Object.entries(mutations)) {
        const file = await service.storeUpload(Buffer.from('valid bytes'), name, 'text/plain');
        await mutate(path(owner, file.id));
        rejected.push(file);
      }
      await age(
        owner,
        rejected.map((file) => file.id),
      );
      const expires = (
        await database.query('SELECT id,expires_at FROM artifacts WHERE owner_id=$1 ORDER BY id', [
          owner,
        ])
      ).rows;
      await t.test('renewal omits unusable files without extending their leases', async () => {
        const result = await service.renewUploads(
          [...rejected, available, retained, legacy].map((file) => file.id),
        );
        assert.deepEqual(
          result.map((file) => file.id).sort(),
          [available.id, retained.id, legacy.id].sort(),
        );
        for (const file of rejected)
          assert.deepEqual(
            (
              await database.query('SELECT expires_at FROM artifacts WHERE owner_id=$1 AND id=$2', [
                owner,
                file.id,
              ])
            ).rows[0].expires_at,
            expires.find((row) => row.id === file.id).expires_at,
          );
      });
      await t.test('retention rejects unusable files in the caller transaction', async () => {
        const client = await database.connect();
        try {
          for (const file of rejected) {
            await client.query('BEGIN');
            await assert.rejects(service.retainArtifacts([file.id], client), {
              message: 'An attachment is unavailable.',
              statusCode: 400,
            });
            await client.query('ROLLBACK');
          }
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      });
      const moved = directory(owner) + '-moved';
      await rename(directory(owner), moved);
      await symlink(moved, directory(owner));
      try {
        assert.deepEqual(await service.renewUploads([available.id, retained.id, legacy.id]), [
          legacy,
        ]);
      } finally {
        await unlink(directory(owner));
        await rename(moved, directory(owner));
      }
    });

    await t.test(
      'uncommitted writers stay protected and rolled-back files are reclaimed after restart',
      async () => {
        const owner = 'writer-owner';
        const service = create(owner);
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          const active = await service.storeArtifact(
            Buffer.from('active'),
            'active',
            'text/plain',
            undefined,
            client,
          );
          await utimes(path(owner, active.id), old, old);
          assert.equal((await service.sweep()).orphans, 0);
          assert.equal((await readFile(path(owner, active.id))).toString(), 'active');
          await client.query('COMMIT');
          assert.equal((await service.readArtifact(active.id)).toString(), 'active');
          await client.query('BEGIN');
          const interrupted = await service.storeArtifact(
            Buffer.from('interrupted'),
            'interrupted',
            'text/plain',
            undefined,
            client,
          );
          await utimes(path(owner, interrupted.id), old, old);
          await client.query('ROLLBACK');
          await service.close();
          const restarted = create(owner);
          assert.equal((await restarted.sweep()).orphans, 1);
          await absent(path(owner, interrupted.id));
          assert.equal((await restarted.readArtifact(active.id)).toString(), 'active');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );

    await t.test(
      'failed unlink leaves an unavailable tombstone and restart recovers it or missing bytes',
      async () => {
        const owner = 'retry-owner';
        const service = create(owner);
        const failed = await service.storeUpload(Buffer.from('retry'), 'retry', 'text/plain');
        await age(owner, [failed.id]);
        await unlink(path(owner, failed.id));
        await mkdir(path(owner, failed.id));
        assert.equal((await service.sweep()).failed, 1);
        assert.ok(
          (
            await database.query('SELECT deleting_at FROM artifacts WHERE owner_id=$1 AND id=$2', [
              owner,
              failed.id,
            ])
          ).rows[0].deleting_at,
        );
        await assert.rejects(service.readArtifact(failed.id), /unavailable/);
        assert.deepEqual(await service.renewUploads([failed.id]), []);
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          await assert.rejects(service.retainArtifacts([failed.id], client), {
            message: 'An attachment is unavailable.',
            statusCode: 400,
          });
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        await service.close();
        await rm(path(owner, failed.id), { recursive: true });
        await writeFile(path(owner, failed.id), 'retry');
        const restarted = create(owner);
        assert.equal((await restarted.sweep()).removed, 1);
        await absent(path(owner, failed.id));
        const missing = await restarted.storeUpload(
          Buffer.from('missing'),
          'missing',
          'text/plain',
        );
        await age(owner, [missing.id]);
        await database.query('UPDATE artifacts SET deleting_at=now() WHERE owner_id=$1 AND id=$2', [
          owner,
          missing.id,
        ]);
        await unlink(path(owner, missing.id));
        assert.equal((await restarted.sweep()).removed, 1);
        assert.equal(
          (
            await database.query(
              'SELECT id FROM artifacts WHERE owner_id=$1 AND id=ANY($2::uuid[])',
              [owner, [failed.id, missing.id]],
            )
          ).rowCount,
          0,
        );
      },
    );

    await t.test(
      'shared roots preserve foreign files, unowned flat files, symlinks and arbitrary recorded paths',
      async () => {
        const owner = 'isolation-owner';
        const foreignOwner = 'foreign-owner';
        const service = create(owner);
        const foreign = create(foreignOwner);
        const saved = await service.storeArtifact(Buffer.from('owned'), 'owned', 'text/plain');
        const foreignFile = await foreign.storeUpload(
          Buffer.from('foreign'),
          'foreign',
          'text/plain',
        );
        await age(foreignOwner, [foreignFile.id]);
        const ownOrphan = path(owner, randomUUID());
        const foreignOrphan = path(foreignOwner, randomUUID());
        const legacyOrphan = join(root, 'artifacts', randomUUID());
        const unknown = join(directory(owner), 'keep.txt');
        for (const file of [ownOrphan, foreignOrphan, legacyOrphan, unknown]) {
          await writeFile(file, 'unknown');
          await utimes(file, old, old);
        }
        const linkPath = path(owner, randomUUID());
        await symlink(foreignOrphan, linkPath);
        const nested = path(owner, randomUUID());
        await mkdir(nested);
        await writeFile(join(nested, randomUUID()), 'nested');
        assert.equal((await service.sweep()).orphans, 1);
        await absent(ownOrphan);
        for (const file of [foreignOrphan, legacyOrphan, unknown, linkPath])
          assert.equal((await readFile(file)).toString(), 'unknown');
        assert.equal((await foreign.readArtifact(foreignFile.id)).toString(), 'foreign');
        assert.deepEqual(await service.renewUploads([foreignFile.id]), []);
        const unavailable = await service.storeUpload(
          Buffer.from('unsafe'),
          'unsafe',
          'text/plain',
        );
        await age(owner, [unavailable.id]);
        await database.query('UPDATE artifacts SET storage_path=$3 WHERE owner_id=$1 AND id=$2', [
          owner,
          unavailable.id,
          foreignOrphan,
        ]);
        assert.equal((await service.sweep()).failed, 1);
        assert.equal((await readFile(foreignOrphan)).toString(), 'unknown');
        assert.equal((await service.readArtifact(saved.id)).toString(), 'owned');
        const rootLink = join(root, 'linked-root');
        await symlink(root, rootLink);
        const linked = create('linked-owner', rootLink);
        await assert.rejects(
          linked.storeArtifact(Buffer.from('unsafe'), 'unsafe', 'text/plain'),
          /unavailable/,
        );
        assert.equal((await linked.sweep()).orphans, 0);
        const hashOwner = 'linked-hash-owner';
        await symlink(directory(foreignOwner), directory(hashOwner));
        const linkedHash = create(hashOwner);
        await assert.rejects(
          linkedHash.storeArtifact(Buffer.from('unsafe'), 'unsafe', 'text/plain'),
          /unavailable/,
        );
        assert.equal((await linkedHash.sweep()).orphans, 0);
        assert.equal((await readFile(foreignOrphan)).toString(), 'unknown');
      },
    );

    await t.test(
      'renewal wins before deletion or returns unavailable after cleanup claims the row',
      async () => {
        const owner = 'renewal-race-owner';
        const service = create(owner);
        const gate = Math.floor(Math.random() * 1_000_000_000) + 1;
        const barrier = await database.connect();
        const waitBlocked = async () => {
          for (let attempt = 0; attempt < 100; attempt++) {
            if (
              (
                await database.query(
                  "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted",
                  [gate],
                )
              ).rowCount
            )
              return;
            await delay(10);
          }
          assert.fail('The artifact operation did not reach its database barrier.');
        };
        const block = async (column: 'expires_at' | 'deleting_at') => {
          await database.query(`
          CREATE OR REPLACE FUNCTION pause_artifact_update() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.owner_id='renewal-race-owner' THEN PERFORM pg_advisory_xact_lock(${gate}); END IF;
            RETURN NEW;
          END $$;
          CREATE TRIGGER pause_artifact_update BEFORE UPDATE OF ${column} ON artifacts
            FOR EACH ROW EXECUTE FUNCTION pause_artifact_update();
        `);
          await barrier.query('SELECT pg_advisory_lock($1)', [gate]);
        };
        const release = () => barrier.query('SELECT pg_advisory_unlock($1)', [gate]);
        try {
          const renewed = await service.storeUpload(
            Buffer.from('renew-race'),
            'renew-race',
            'text/plain',
          );
          await age(owner, [renewed.id]);
          await block('expires_at');
          const renewing = service.renewUploads([renewed.id]);
          await waitBlocked();
          assert.equal((await service.sweep()).removed, 0);
          await release();
          assert.deepEqual(
            (await renewing).map((file) => file.id),
            [renewed.id],
          );
          assert.equal((await service.sweep()).removed, 0);
          assert.equal((await service.readArtifact(renewed.id)).toString(), 'renew-race');
          await database.query('DROP TRIGGER pause_artifact_update ON artifacts');
          const deleting = await service.storeUpload(
            Buffer.from('delete-race'),
            'delete-race',
            'text/plain',
          );
          await age(owner, [deleting.id]);
          await block('deleting_at');
          const sweeping = service.sweep();
          await waitBlocked();
          const unavailable = service.renewUploads([deleting.id]);
          await release();
          assert.equal((await sweeping).removed, 1);
          assert.deepEqual(await unavailable, []);
          await absent(path(owner, deleting.id));
        } finally {
          await release();
          barrier.release();
          await database.query(
            'DROP TRIGGER IF EXISTS pause_artifact_update ON artifacts; DROP FUNCTION IF EXISTS pause_artifact_update()',
          );
        }
      },
    );

    await t.test(
      'bounded sweeps advance beyond failures and keep directory progress until close',
      async () => {
        const owner = 'bounded-owner';
        const service = create(owner);
        const failed = await service.storeUpload(Buffer.from('blocked'), 'blocked', 'text/plain');
        await unlink(path(owner, failed.id));
        await mkdir(path(owner, failed.id));
        const files = [];
        for (let index = 0; index < 120; index++)
          files.push(
            await service.storeUpload(Buffer.from('expired'), String(index), 'text/plain'),
          );
        await age(owner, [failed.id, ...files.map((file) => file.id)]);
        const first = await service.sweep();
        assert.ok(first.removed <= 100);
        assert.ok(first.removed > 0);
        for (let pass = 0; pass < 10; pass++) {
          if (
            !(
              await database.query('SELECT 1 FROM artifacts WHERE owner_id=$1 AND id<>$2', [
                owner,
                failed.id,
              ])
            ).rowCount
          )
            break;
          await service.sweep();
        }
        assert.equal(
          (
            await database.query('SELECT 1 FROM artifacts WHERE owner_id=$1 AND id<>$2', [
              owner,
              failed.id,
            ])
          ).rowCount,
          0,
        );
        assert.ok(
          (
            await database.query('SELECT deleting_at FROM artifacts WHERE owner_id=$1 AND id=$2', [
              owner,
              failed.id,
            ])
          ).rows[0].deleting_at,
        );
        const orphans = Array.from({ length: 205 }, () => path(owner, randomUUID()));
        await Promise.all(
          orphans.map(async (file) => {
            await writeFile(file, 'orphan');
            await utimes(file, old, old);
          }),
        );
        let removed = 0;
        for (let pass = 0; pass < 10 && removed < orphans.length; pass++) {
          const result = await service.sweep();
          assert.ok(result.orphans <= 100);
          removed += result.orphans;
        }
        assert.equal(removed, orphans.length);
        const client = await database.connect();
        try {
          await client.query('BEGIN');
          await client.query('LOCK TABLE artifacts IN ACCESS EXCLUSIVE MODE');
          const a = service.sweep();
          const b = service.sweep();
          const closed = service.close();
          await client.query('COMMIT');
          assert.equal(await a, await b);
          await closed;
          await service.close();
          assert.deepEqual(await service.sweep(), { removed: 0, orphans: 0, failed: 0 });
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      },
    );
  },
);

const fileObject = (url = 'https://files.example.com/attachment?signature=private-fixture') => ({
  name: '../../invoice.pdf',
  mimetype: 'application/pdf',
  s3url: url,
});
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];
const settled = async (value: unknown): Promise<unknown> => {
  if (value instanceof IntegrationDownload) return settled(await value.start());
  if (Array.isArray(value)) return Promise.all(value.map(settled));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await settled(item)])),
  );
};

test('Composio file outputs become private bytes wherever they appear and never expose their links', async () => {
  const files = createComposioFiles({
    resolver: publicResolver,
    request: async ({ url, address }) => {
      assert.equal(address, '93.184.216.34');
      if (url.pathname === '/attachment')
        return {
          status: 302,
          headers: { location: '/final?signature=private-fixture' },
          body: new Uint8Array(),
        };
      return { status: 200, headers: {}, body: Buffer.from(`synthetic ${url.pathname}`) };
    },
  });
  const pending = await files(
    {
      data: {
        file: fileObject(),
        file_content: {
          name: 'Screenshot.png',
          mimetype: 'image/png',
          s3url: 'https://files.example.com/slack?signature=private-fixture',
        },
        file_info: { uri: '/etc/passwd', display_url: 'https://files.example.com/arbitrary' },
        drive: [
          {
            downloaded_file_content: {
              mimetype: 'text/plain\r\nX-Fixture: bad',
              s3url: 'https://files.example.com/report',
            },
          },
        ],
      },
      error: null,
    },
    AbortSignal.timeout(1000),
  );
  const result = await settled(pending);
  assert.deepEqual(result, {
    data: {
      file: {
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('synthetic /final'),
      },
      file_content: {
        name: 'Screenshot.png',
        mimeType: 'image/png',
        bytes: Buffer.from('synthetic /slack'),
      },
      file_info: { uri: '/etc/passwd', display_url: 'https://files.example.com/arbitrary' },
      drive: [
        {
          downloaded_file_content: {
            name: 'report',
            mimeType: 'application/octet-stream',
            bytes: Buffer.from('synthetic /report'),
          },
        },
      ],
    },
    error: null,
  });
  assert.equal(JSON.stringify(result).includes('signature'), false);
  const nested = JSON.stringify({
    file: { name: 'nested.png', mimetype: 'image/png', s3url: 'https://files.example.com/nested' },
  });
  assert.deepEqual(
    await settled(await files({ data: { response: nested } }, AbortSignal.timeout(1000))),
    {
      data: {
        response: {
          file: {
            name: 'nested.png',
            mimeType: 'image/png',
            bytes: Buffer.from('synthetic /nested'),
          },
        },
      },
    },
  );
});

test('Composio file links that are private, insecure, rebinding or oversized are not fetched', async () => {
  const failed = async (files: ReturnType<typeof createComposioFiles>, url?: string) => {
    const result = (await settled(
      await files({ file: fileObject(url) }, AbortSignal.timeout(1000)),
    )) as { file: { error?: string } };
    assert.match(result.file.error ?? '', /^The file could not be downloaded/);
    assert.equal(JSON.stringify(result).includes('signature'), false);
  };
  for (const url of [
    'http://files.example.com/file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://169.254.169.254/file',
    'https://name:secret@files.example.com/file',
  ]) {
    let requests = 0;
    await failed(
      createComposioFiles({
        resolver: publicResolver,
        request: async () => {
          requests++;
          throw new Error('Unexpected request');
        },
      }),
      url,
    );
    assert.equal(requests, 0);
  }
  const quoted = JSON.stringify({ s3url: 'https://files.example.com/beacon', name: 'beacon.png' });
  const mail = {
    data: { messages: [{ subject: quoted, body: `\n  ${quoted}\n` }], response: { text: quoted } },
  };
  let quotedRequests = 0;
  assert.deepEqual(
    await settled(
      await createComposioFiles({
        resolver: async () => {
          quotedRequests++;
          return [{ address: '93.184.216.34', family: 4 }];
        },
        request: async () => {
          quotedRequests++;
          throw new Error('Unexpected request');
        },
      })(mail, AbortSignal.timeout(1000)),
    ),
    mail,
  );
  assert.equal(quotedRequests, 0);
  let resolutions = 0;
  let requests = 0;
  await failed(
    createComposioFiles({
      resolver: async () => [
        { address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 },
      ],
      request: async ({ address }) => {
        requests++;
        assert.equal(address, '93.184.216.34');
        return { status: 302, headers: { location: '/next' }, body: new Uint8Array() };
      },
    }),
  );
  assert.equal(requests, 1);
  for (const size of [0, fileBytes + 1])
    await failed(
      createComposioFiles({
        resolver: publicResolver,
        request: async () => ({ status: 200, headers: {}, body: new Uint8Array(size) }),
      }),
    );
});
