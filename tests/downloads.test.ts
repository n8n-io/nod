import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test, { type TestContext } from 'node:test';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Composio } from '@composio/core';
import pg from 'pg';
import { browserDownloadBytes } from '../src/ports/computer.ts';
import { ObjectStoreConflict } from '../src/ports/object-storage.ts';
import { createAgentBrowserComputer } from '../src/providers/agent-browser/index.ts';
import {
  completedDownloads,
  decodeDownload,
  downloadFile,
  readDownload,
  waitForDownload,
} from '../src/providers/agent-browser/downloads.ts';
import { createIntegrationFileDownloader } from '../src/providers/composio/downloads.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import {
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createHttpObjectStore } from '../src/providers/object-storage/http.ts';
import { createS3ObjectStore } from '../src/providers/object-storage/s3.ts';
import { createArtifactService } from '../src/server/artifacts.ts';
import { createPostgresObjectStore } from '../src/server/object-storage.ts';
import { browserDownloadPdf, createBrowserDownloadFixture } from './browser-download-fixture.ts';

function downloadWaitProbe(t: TestContext) {
  const controller = new AbortController();
  let scanned!: () => void;
  const scan = new Promise<void>((resolve) => {
    scanned = resolve;
  });
  const check = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  t.mock.method(controller.signal, 'throwIfAborted', () => {
    check();
    if (++checks === 2) scanned();
  });
  return {
    controller,
    async scan(pending: Promise<unknown>) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          scan,
          pending.then(() => assert.fail('Capture completed before its scan.')),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('The download scan did not start.')), 2000);
          }),
        ]);
      } catch (error) {
        controller.abort(error);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

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
        browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
        headless: true,
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

test('browser file validation bounds encoded bytes and rejects unsafe metadata', async () => {
  assert.deepEqual(
    decodeDownload({ data: browserDownloadPdf.toString('base64'), mimeType: 'application/pdf' }),
    {
      bytes: browserDownloadPdf,
      name: 'download.pdf',
      mimeType: 'application/pdf',
    },
  );
  assert.throws(() =>
    decodeDownload({
      data: 'A'.repeat(Math.ceil(browserDownloadBytes / 3) * 4 + 4),
      mimeType: 'application/pdf',
    }),
  );
  assert.throws(() => decodeDownload({ data: 'Zh==', mimeType: 'application/pdf' }));
  assert.throws(() => decodeDownload({ data: 'Zg==trailing', mimeType: 'application/pdf' }));
  assert.throws(() => downloadFile(Buffer.alloc(browserDownloadBytes + 1)));
  assert.throws(() => downloadFile(Buffer.alloc(0)));
  for (const name of ['../private', 'folder/file', 'folder\\file', '.', '..', 'file\nname'])
    assert.throws(() => downloadFile(browserDownloadPdf, name));
  assert.throws(() => downloadFile(Buffer.from('text'), 'file', 'text/html\r\nX-Header: value'));
});

test('no-target capture refuses replaced directories and unsafe native files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sk-download-unsafe-'));
  try {
    for (const kind of ['symlink', 'hardlink', 'oversized', 'entries', 'directory'] as const) {
      await t.test(kind, async () => {
        const directory = join(root, kind);
        await mkdir(directory);
        await writeFile(join(root, `${kind}.pdf`), browserDownloadPdf);
        if (kind === 'symlink') await symlink(join(root, `${kind}.pdf`), join(directory, 'file'));
        if (kind === 'hardlink') await link(join(root, `${kind}.pdf`), join(directory, 'file'));
        if (kind === 'oversized')
          await writeFile(
            join(directory, 'file.crdownload'),
            Buffer.alloc(browserDownloadBytes + 1),
          );
        if (kind === 'entries')
          await Promise.all(
            Array.from({ length: 65 }, (_, index) => writeFile(join(directory, `${index}`), 'x')),
          );
        if (kind === 'directory') await mkdir(join(directory, 'file'));
        await assert.rejects(waitForDownload(directory));
      });
    }
    const directory = join(root, 'replaced');
    await mkdir(directory);
    await writeFile(join(directory, 'file.crdownload'), browserDownloadPdf);
    const probe = downloadWaitProbe(t);
    const pending = waitForDownload(directory, probe.controller.signal);
    void pending.catch(() => {});
    await probe.scan(pending);
    await rename(directory, join(root, 'original'));
    await mkdir(directory);
    await writeFile(join(directory, 'replacement.pdf'), browserDownloadPdf);
    await assert.rejects(pending, /directory/);
    assert.deepEqual(await readFile(join(root, 'original', 'file.crdownload')), browserDownloadPdf);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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
    await assert.rejects(readDownload(directory, '../private'));
    await writeFile(join(directory, 'invoice.pdf'), browserDownloadPdf);
    assert.deepEqual((await readDownload(directory, 'invoice.pdf')).bytes, browserDownloadPdf);
    await writeFile(join(directory, 'large'), Buffer.alloc(browserDownloadBytes + 1));
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
    skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE,
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
          for (const [id, input] of [
            ['attachment', { selector: '#download', name: 'invoice.pdf' }],
            ['inline-url', { url: `${fixture.origin}/inline.pdf`, name: 'invoice.pdf' }],
            ['blob', { selector: '#blob', name: 'invoice.pdf' }],
            ['blob-anchor', { selector: '#blob-anchor', name: 'invoice.pdf' }],
          ] as const) {
            await computer.act(id, { action: 'open', url: `${fixture.origin}/session` });
            const before = fixture.authenticatedDownloads();
            const file = await computer.download!(id, input);
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
          await computer.act('popup', { action: 'click', selector: '#popup' });
          assert.deepEqual(
            (await computer.download!('popup', { name: 'popup.pdf' })).bytes,
            browserDownloadPdf,
          );
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
          await assert.rejects(computer.download!('large', { selector: '#large' }));
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
            computer.download!('slow', { selector: '#slow' }, abort.signal),
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

const key = `artifacts/${randomUUID()}`;
test('private filesystem objects survive factory restart and preserve conditional writes and path bounds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'otto-objects-'));
  const outside = await mkdtemp(join(tmpdir(), 'otto-outside-'));
  try {
    const first = createFilesystemObjectStore(root);
    assert.equal(await first.read(key, 100), undefined);
    const version = await first.write(key, Buffer.from('private'), { expectedVersion: null });
    const next = createFilesystemObjectStore(root);
    assert.equal((await next.read(key, 100))?.bytes.toString(), 'private');
    await assert.rejects(
      next.write(key, Buffer.from('foreign'), { expectedVersion: null }),
      ObjectStoreConflict,
    );
    await assert.rejects(
      next.write(key, Buffer.from('foreign'), { expectedVersion: 'stale' }),
      ObjectStoreConflict,
    );
    await assert.rejects(next.read(key, 2), /unavailable/);
    await assert.rejects(next.read('../secret', 100), /identifier/);
    await next.write(key, Buffer.from('next'), { expectedVersion: version });
    await assert.rejects(next.remove(key, { expectedVersion: version }), ObjectStoreConflict);
    const file = join(outside, 'private');
    await writeFile(file, 'never read');
    await rm(join(root, key));
    await symlink(file, join(root, key));
    await assert.rejects(next.read(key, 100), /unavailable/);
    await rm(join(root, 'artifacts'), { recursive: true });
    await symlink(outside, join(root, 'artifacts'));
    await assert.rejects(
      next.write(key, Buffer.from('escape'), { expectedVersion: null }),
      /unavailable/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('HTTP storage bounds responses, uses version conditions and never forwards owner or credentials', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  let status = 200;
  const store = createHttpObjectStore({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      if (init?.method === 'PUT')
        return new Response(null, { status: 204, headers: { etag: '"next"' } });
      if (status === 500) throw new Error('secret upstream URL?token=private');
      return new Response('payload', { status, headers: { etag: '"current"' } });
    },
  });
  assert.equal((await store.read(key, 100))?.version, '"current"');
  assert.equal(
    await store.write(key, Buffer.from('bytes'), { expectedVersion: '"current"' }),
    '"next"',
  );
  assert.equal(new Headers(requests[1].init.headers).get('if-match'), '"current"');
  assert.equal(new Headers(requests[1].init.headers).get('authorization'), null);
  assert.equal(new Headers(requests[1].init.headers).get('x-owner-id'), null);
  assert.equal(new Headers(requests[1].init.headers).get('x-otto-generation'), null);
  assert.equal(requests[0].url, 'http://otto.storage/v1/objects/' + encodeURIComponent(key));
  assert.equal(requests[0].init.redirect, 'manual');
  await assert.rejects(store.read(key, 3), /unavailable/);
  status = 412;
  await assert.rejects(store.read(key, 100), ObjectStoreConflict);
  status = 404;
  assert.equal(await store.read(key, 100), undefined);
  status = 500;
  await assert.rejects(
    store.read(key, 100),
    (error: Error) => !/secret|private.*URL|token/.test(error.message),
  );
});

test('self-host S3 storage binds every operation to the configured owner and environment', async (t) => {
  const client = new S3Client({
    region: 'auto',
    credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
  });
  const commands: unknown[] = [];
  t.mock.method(
    client,
    'send',
    async (command: GetObjectCommand | PutObjectCommand | DeleteObjectCommand) => {
      commands.push(command);
      assert.equal(command.input.Bucket, 'fixture-private');
      assert.equal(command.input.Key, 'development/owner-one/' + key);
      if (command instanceof GetObjectCommand)
        return {
          ETag: '"read"',
          ContentLength: 3,
          Body: { transformToWebStream: () => new Response('abc').body! },
        };
      if (command instanceof PutObjectCommand) return { ETag: '"written"' };
      return {};
    },
  );
  const store = createS3ObjectStore({
    client,
    bucket: 'fixture-private',
    ownerId: 'owner-one',
    environment: 'development',
  });
  assert.equal((await store.read(key, 4))?.bytes.toString(), 'abc');
  await store.write(key, Buffer.from('x'), { expectedVersion: null });
  assert.equal((commands[1] as PutObjectCommand).input.IfNoneMatch, '*');
  await store.remove(key, { expectedVersion: '"written"' });
  assert.equal((commands[2] as DeleteObjectCommand).input.IfMatch, '"written"');
  await assert.rejects(
    store.write('../other-owner/file', Buffer.from('x'), { expectedVersion: null }),
    /unavailable/,
  );
  client.destroy();
});

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
      await Promise.all([first.initialize(), second.initialize()]);
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
        first.write(key, Buffer.alloc(16 * 1024 * 1024 + 1), { expectedVersion: saved!.version }),
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
  'a lost PostgreSQL write acknowledgement preserves committed bytes and rejects stale replay',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const f = await fixture();
    const key = `artifacts/${randomUUID()}`;
    const stable = createPostgresObjectStore({ database: f.database, ownerId: 'owner' });
    try {
      await stable.initialize();
      const version = await stable.write(key, Buffer.from('before'), { expectedVersion: null });
      const disconnected = {
        query: async (...args: Parameters<pg.Pool['query']>) => {
          await f.database.query(...args);
          throw new Error('private connection details must not escape');
        },
      } as unknown as pg.Pool;
      const uncertain = createPostgresObjectStore({ database: disconnected, ownerId: 'owner' });
      await assert.rejects(
        uncertain.write(key, Buffer.from('committed'), { expectedVersion: version }),
        { message: 'Private file storage is temporarily unavailable.' },
      );
      const restored = createPostgresObjectStore({ database: f.database, ownerId: 'owner' });
      assert.equal((await restored.read(key, 100))?.bytes.toString(), 'committed');
      await assert.rejects(
        restored.write(key, Buffer.from('replayed'), { expectedVersion: version }),
        ObjectStoreConflict,
      );
    } finally {
      await f.close();
    }
  },
);

test(
  'private artifacts survive actor restart and remain owned for downloads and channel delivery',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'otto-artifact-store-'));
    const schema = 'test_durable_artifacts_' + randomUUID().replaceAll('-', '');
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema}`,
    });
    try {
      await database.query(
        `CREATE TABLE threads(id uuid PRIMARY KEY,owner_id text NOT NULL); CREATE TABLE artifacts(id uuid PRIMARY KEY,owner_id text NOT NULL,thread_id uuid REFERENCES threads(id),name text NOT NULL CHECK(name <> 'reject'),mime_type text NOT NULL,size integer NOT NULL,storage_path text NOT NULL)`,
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
          store: createFilesystemObjectStore(join(root, ownerId)),
        });
      const original = create('owner-one');
      const saved = await original.storeArtifact(
        Buffer.from('synthetic file'),
        'private.txt',
        'text/plain',
        thread,
      );
      assert.deepEqual(Object.keys(saved).sort(), ['id', 'mimeType', 'name', 'size', 'url']);
      const restored = create('owner-one');
      assert.equal((await restored.readArtifact(saved.id)).toString(), 'synthetic file');
      assert.equal(
        (await restored.readThreadArtifacts(thread, [saved.id]))[0].bytes.toString(),
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

const descriptor = (url = 'https://files.example.com/attachment?signature=private-fixture') => ({
  data: {
    successful: true,
    data: { file: { name: '../../invoice.pdf', mimetype: 'application/pdf', s3url: url } },
  },
  error: null,
});
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('app downloads use only the completed provider file descriptor and return bounded private bytes', async () => {
  const calls: string[] = [];
  const download = createIntegrationFileDownloader({
    resolver: publicResolver,
    request: async ({ url, address, maxBytes, metadata, purpose }) => {
      calls.push(url.href);
      assert.equal(address, '93.184.216.34');
      assert.equal(maxBytes, 15 * 1024 * 1024);
      assert.equal(metadata, false);
      assert.equal(purpose, 'download');
      if (calls.length === 1)
        return {
          status: 302,
          headers: { location: '/final?signature=private-fixture' },
          body: new Uint8Array(),
        };
      return { status: 200, headers: {}, body: Buffer.from('synthetic-file') };
    },
  });
  const file = await download('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000));
  assert.deepEqual(file, {
    name: 'invoice.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('synthetic-file'),
  });
  assert.equal(JSON.stringify(file).includes('signature'), false);
  assert.equal(calls.length, 2);
  const drive = createIntegrationFileDownloader({
    resolver: publicResolver,
    request: async () => ({ status: 200, headers: {}, body: Buffer.from('drive') }),
  });
  assert.equal(
    (
      await drive(
        'GOOGLEDRIVE_DOWNLOAD_FILE',
        {
          data: {
            downloaded_file_content: {
              name: 'report.csv',
              mimetype: 'text/csv',
              s3url: 'https://files.example.com/report',
            },
          },
        },
        AbortSignal.timeout(1000),
      )
    ).name,
    'report.csv',
  );
  for (const result of [
    { data: { successful: false, data: descriptor().data.data } },
    { data: { done: false, downloaded_file_content: descriptor().data.data.file } },
    { data: { uri: '/etc/passwd', display_url: 'https://files.example.com/arbitrary' } },
    {
      data: { file: { ...descriptor().data.data.file, mimetype: 'text/plain\r\nX-Fixture: bad' } },
    },
  ])
    await assert.rejects(drive('GMAIL_GET_ATTACHMENT', result, AbortSignal.timeout(1000)));
});

test('app downloads reject private redirects, rebinding, insecure URLs and oversized responses', async () => {
  for (const url of [
    'http://files.example.com/file',
    'https://127.0.0.1/file',
    'https://[::1]/file',
    'https://169.254.169.254/file',
    'https://name:secret@files.example.com/file',
  ]) {
    let requests = 0;
    const download = createIntegrationFileDownloader({
      resolver: publicResolver,
      request: async () => {
        requests++;
        throw new Error('Unexpected request');
      },
    });
    await assert.rejects(
      download('GMAIL_GET_ATTACHMENT', descriptor(url), AbortSignal.timeout(1000)),
    );
    assert.equal(requests, 0);
  }
  let resolutions = 0;
  let requests = 0;
  const rebound = createIntegrationFileDownloader({
    resolver: async () => [
      { address: ++resolutions === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 },
    ],
    request: async ({ address }) => {
      requests++;
      assert.equal(address, '93.184.216.34');
      return { status: 302, headers: { location: '/next' }, body: new Uint8Array() };
    },
  });
  await assert.rejects(rebound('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000)));
  assert.equal(requests, 1);
  for (const size of [0, 15 * 1024 * 1024 + 1]) {
    const download = createIntegrationFileDownloader({
      resolver: publicResolver,
      request: async () => ({ status: 200, headers: {}, body: new Uint8Array(size) }),
    });
    await assert.rejects(download('GMAIL_GET_ATTACHMENT', descriptor(), AbortSignal.timeout(1000)));
  }
});

test('Composio downloads bind the account, reject unreviewed arguments and keep upstream URLs out of errors', async (t) => {
  const client = new Composio({
    apiKey: 'fixture-never-live',
    allowTracking: false,
    disableVersionCheck: true,
    fileUploadDirs: false,
  });
  const transport = client.getClient().toolRouter.session;
  t.mock.method(transport, 'create', async () => ({
    session_id: 'fixture-files',
    mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/mcp/fixture-files' },
    config: { user_id: 'fixture-owner' },
    config_version: 1,
  }));
  let executions = 0;
  let fail = false;
  t.mock.method(
    transport,
    'execute',
    async (sessionId: string, input: unknown, options: { signal: AbortSignal }) => {
      executions++;
      assert.equal(sessionId, 'fixture-files');
      assert.deepEqual(input, {
        tool_slug: 'GMAIL_GET_ATTACHMENT',
        arguments: { message_id: 'message-1', attachment_id: 'part-1', file_name: 'invoice.pdf' },
        account: 'owned-account',
      });
      assert.equal(options.signal.aborted, false);
      if (fail)
        throw new Error('Upstream refused https://files.example/signed?X-Amz-Signature=fixture');
      return descriptor();
    },
  );
  const provider = createComposioProvider({
    client,
    fileDownload: {
      resolver: publicResolver,
      request: async () => ({ status: 200, headers: {}, body: Buffer.from('fixture') }),
    },
  });
  const session = await provider.createSession('fixture-owner', { gmail: 'owned-account' });
  const args = { message_id: 'message-1', attachment_id: 'part-1', file_name: 'invoice.pdf' };
  assert.equal(
    (await session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account')).name,
    'invoice.pdf',
  );
  for (const [action, input] of [
    ['GMAIL_SEND_EMAIL', args],
    ['GMAIL_GET_ATTACHMENT', { ...args, url: 'https://example.com/file' }],
  ] as const)
    await assert.rejects(session.download!(action, input, 'owned-account'), {
      message: /^The app file could not be downloaded: /,
    });
  assert.equal(executions, 1);
  fail = true;
  await assert.rejects(session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account'), {
    message: 'The app file could not be downloaded: Upstream refused [file URL]',
  });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    session.download!('GMAIL_GET_ATTACHMENT', args, 'owned-account', controller.signal),
    { name: 'AbortError' },
  );
  assert.equal(executions, 2);
});
