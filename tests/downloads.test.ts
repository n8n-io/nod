import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
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
} from '../src/providers/agent-browser/downloads.ts';
import { mcpFiles } from '../src/providers/app-files.ts';
import { createComposioFiles } from '../src/providers/composio/downloads.ts';
import { createComposioProvider } from '../src/providers/composio/integrations.ts';
import {
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { createFilesystemObjectStore } from '../src/providers/object-storage/filesystem.ts';
import { createHttpObjectStore } from '../src/providers/object-storage/http.ts';
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
    await writeFile(join(directory, 'large'), Buffer.alloc(browserDownloadBytes + 1));
    await assert.rejects(readDownload(directory, 'large'));
    await symlink(directory, join(root, 'alias'));
    await assert.rejects(completedDownloads(join(root, 'alias')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'native browser actions keep generated PDF tabs usable after a failed download',
  { skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE, timeout: 90_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'otto-blob-pdf-'));
    try {
      const fixture = await createBrowserDownloadFixture();
      try {
        const bridge = await createDownloadBrowser(root);
        try {
          const computer = bridge.computer;
          await computer.act('blob-view', { action: 'open', url: `${fixture.origin}/session` });
          const notes = 'Typed €\nSecond line';
          await computer.act('blob-view', { action: 'type', selector: '#notes', text: notes });
          await computer.act('blob-view', { action: 'select', selector: '#format', text: 'pdf' });
          await computer.act('blob-view', { action: 'check', selector: '#copy' });
          const fields = await computer.act('blob-view', {
            action: 'evaluate',
            script: `({notes: document.querySelector('#notes').value, enter: window.keys.includes('Enter'), format: document.querySelector('#format').value, copy: document.querySelector('#copy').checked})`,
          });
          assert.deepEqual(JSON.parse(fields.text.split('\n')[1]), {
            notes,
            enter: true,
            format: 'pdf',
            copy: true,
          });
          await computer.act('blob-view', { action: 'uncheck', selector: '#copy' });
          const unchecked = await computer.act('blob-view', {
            action: 'evaluate',
            script: `document.querySelector('#copy').checked`,
          });
          assert.equal(JSON.parse(unchecked.text.split('\n')[1]), false);
          const longNotes = 'Synthetic document text.\n'.repeat(2000);
          await computer.act('blob-view', { action: 'fill', selector: '#notes', text: longNotes });
          const documentText = await computer.act('blob-view', {
            action: 'evaluate',
            script: `document.querySelector('#notes').value`,
          });
          assert.equal(JSON.parse(documentText.text.split('\n')[1]), longNotes);
          const ready = await computer.act('blob-view', {
            action: 'wait',
            text: 'Download invoice',
            waitMs: 90_000,
          });
          assert.match(ready.text, /Download invoice/);
          await computer.injectCredentials({
            threadId: 'blob-view',
            origin: fixture.origin,
            kind: 'identifier',
            username: 'synthetic-download@example.test',
            usernameSelector: '#identifier',
            submitSelector: '#continue',
          });
          await assert.rejects(computer.download!('blob-view', { selector: '#blob-view' }));
          let tabId: string | undefined;
          const deadline = Date.now() + 5000;
          do {
            const tabs = await computer.act('blob-view', { action: 'tab_list' });
            tabId = /(?:Active|Open) (\S+): blob:/.exec(tabs.text)?.[1];
          } while (!tabId && Date.now() < deadline);
          assert.ok(tabId);
          const view = await computer.act('blob-view', { action: 'tab_switch', tabId });
          assert.equal(new URL(view.url).protocol, 'blob:');
          await computer.act('blob-view', { action: 'snapshot' });
          assert.match(
            (
              await computer.act('blob-view', {
                action: 'evaluate',
                script: 'document.contentType',
              })
            ).text,
            /application\/pdf/,
          );
          await assert.rejects(computer.currentPage('blob-view'));
          assert.deepEqual((await computer.download!('blob-view', {})).bytes, browserDownloadPdf);
          assert.equal(fixture.unauthenticatedDownloads(), 0);
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

const fileObject = (url = 'https://files.example.com/attachment?signature=private-fixture') => ({
  name: '../../invoice.pdf',
  mimetype: 'application/pdf',
  s3url: url,
});
const publicResolver = async () => [{ address: '93.184.216.34', family: 4 }];

test('Composio file outputs become private bytes wherever they appear and never expose their links', async () => {
  const calls: string[] = [];
  const files = createComposioFiles({
    resolver: publicResolver,
    request: async ({ url, address, maxBytes, metadata, purpose }) => {
      calls.push(url.href);
      assert.equal(address, '93.184.216.34');
      assert.equal(maxBytes, 15 * 1024 * 1024);
      assert.equal(metadata, false);
      assert.equal(purpose, 'download');
      if (url.pathname === '/attachment')
        return {
          status: 302,
          headers: { location: '/final?signature=private-fixture' },
          body: new Uint8Array(),
        };
      return { status: 200, headers: {}, body: Buffer.from(`synthetic ${url.pathname}`) };
    },
  });
  const result = await files(
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
  assert.equal(calls.length, 4);
  const nested = JSON.stringify({
    file: { name: 'nested.png', mimetype: 'image/png', s3url: 'https://files.example.com/nested' },
  });
  assert.deepEqual(await files({ data: { response: nested } }, AbortSignal.timeout(1000)), {
    data: {
      response: {
        file: {
          name: 'nested.png',
          mimeType: 'image/png',
          bytes: Buffer.from('synthetic /nested'),
        },
      },
    },
  });
  assert.deepEqual(await files({ file: fileObject() }, AbortSignal.timeout(1000), false), {
    file: {
      name: '../../invoice.pdf',
      mimeType: 'application/pdf',
      message: 'Files are not opened in activity checks.',
    },
  });
  assert.equal(calls.length, 5);
  const many = (await files(
    {
      items: Array.from({ length: 11 }, (_, index) => ({
        name: `${index}.txt`,
        mimetype: 'text/plain',
        s3url: `https://files.example.com/${index}`,
      })),
    },
    AbortSignal.timeout(1000),
  )) as { items: unknown[] };
  assert.deepEqual(many.items[10], {
    name: '10.txt',
    mimeType: 'text/plain',
    error: 'Not downloaded: too many files in one result.',
  });
  assert.equal(calls.length, 15);
});

test('MCP file blocks over the file limit are refused before decoding', () => {
  assert.deepEqual(
    mcpFiles({
      content: [{ type: 'image', data: 'A'.repeat(21 * 1024 * 1024), mimeType: 'image/png' }],
    }),
    { content: [{ type: 'image', mimeType: 'image/png', error: 'The file is too large.' }] },
  );
});

test('Composio file links that are private, insecure, rebinding or oversized are not fetched', async () => {
  const failed = async (files: ReturnType<typeof createComposioFiles>, url?: string) => {
    const result = (await files({ file: fileObject(url) }, AbortSignal.timeout(1000))) as {
      file: { error?: string };
    };
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
  for (const size of [0, 15 * 1024 * 1024 + 1])
    await failed(
      createComposioFiles({
        resolver: publicResolver,
        request: async () => ({ status: 200, headers: {}, body: new Uint8Array(size) }),
      }),
    );
});

test('Composio actions on the bound account return downloaded files without their links', async (t) => {
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
  t.mock.method(transport, 'execute', async (sessionId: string, input: unknown) => {
    assert.equal(sessionId, 'fixture-files');
    assert.deepEqual(input, {
      tool_slug: 'SLACK_DOWNLOAD_SLACK_FILE',
      arguments: { file: 'F0SYNTHETIC' },
      account: 'owned-account',
    });
    return {
      data: {
        file_content: {
          name: 'Screenshot.png',
          mimetype: 'image/png',
          s3url: 'https://files.example.com/slack?X-Amz-Signature=fixture',
        },
      },
      error: null,
      log_id: 'fixture-log',
    };
  });
  const provider = createComposioProvider({
    client,
    fileDownload: {
      resolver: publicResolver,
      request: async () => ({ status: 200, headers: {}, body: Buffer.from('fixture') }),
    },
  });
  const session = await provider.createSession('fixture-owner', { slack: 'owned-account' });
  const result = await session.execute(
    'SLACK_DOWNLOAD_SLACK_FILE',
    { file: 'F0SYNTHETIC' },
    'owned-account',
  );
  assert.deepEqual((result as { data: unknown }).data, {
    file_content: { name: 'Screenshot.png', mimeType: 'image/png', bytes: Buffer.from('fixture') },
  });
  assert.equal(JSON.stringify(result).includes('X-Amz-Signature'), false);
});
