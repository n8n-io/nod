import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Static } from '@sinclair/typebox';
import fc from 'fast-check';
import pg from 'pg';
import type { Agent, AgentTool, AgentToolResult, RuntimeContext } from '../src/ports/agent.ts';
import { BrowserActionError, type BrowserAction, type Computer } from '../src/ports/computer.ts';
import {
  browserSessionId,
  createAgentBrowserComputer,
  redactBrowserText,
  redactBrowserUrl,
  type BrowserDiagnostic,
} from '../src/providers/agent-browser/index.ts';
import {
  DaemonCommandError,
  existingDaemonCommand,
} from '../src/providers/agent-browser/screens.ts';
import { runProcess } from '../src/providers/process.ts';
import { containerBrowserOptions } from '../src/providers/container-browser/config.ts';
import { openDevtools } from '../src/providers/agent-browser/devtools.ts';
import { runBrowserBridge } from '../src/providers/container-browser/bridge.ts';
import {
  browserNamespace,
  createContainerBrowserComputer,
  type BrowserBridgeLauncher,
} from '../src/providers/container-browser/index.ts';
import {
  browserResponse,
  type BrowserCall,
  type BrowserResponse,
} from '../src/providers/container-browser/protocol.ts';
import { startContainerBrowserWorker } from '../src/providers/container-browser/worker.ts';
import { createAgentRuntime } from '../src/runtime/index.ts';
import { toolDefinitions } from '../src/runtime/tools.ts';
import { createErrorRedactor, createRedactor } from '../src/server/redaction.ts';
import { createBrowserFixture, fakeDevtools, type DevtoolsModel } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { accessCookie, accessKey } from '../src/server/access.ts';

// Shared helpers

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Core browser API: ownership and private-capture locks

test(
  'core browser metadata and frames work without Inspector and retain ownership and private-capture locks',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 15_000 },
  async (t) => {
    const schema = `test_browser_api_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'nod-test-runtime-'));
    t.after(() => rm(runtimeRoot, { recursive: true, force: true }));
    process.env.NOD_DATA_ROOT = runtimeRoot;
    const db = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { activeThread } = await import('../src/server/thread.ts');
    const { dataRoot, ownerId, port, configuration } = await import('../src/server/config.ts');
    const headers = {
      host: `localhost:${port}`,
      cookie: `${accessCookie(port)}=${await accessKey(dataRoot)}`,
    };
    const capturedAt = '2026-09-25T12:00:00.000Z';
    let locked = false;
    let fail = false;
    let pageShown = true;
    let onView: ((signal: AbortSignal) => AsyncGenerator<Buffer>) | undefined;
    let onCapture: (() => Promise<void>) | undefined;
    const captures: string[] = [];
    const controls: unknown[] = [];
    const app = await createApp({
      configuration: () => configuration(),
      computer: {
        screenStatus: () => ({ state: 'live', capturedAt }),
        screenshot: async (id) => {
          captures.push(id!);
          if (locked)
            throw Object.assign(new Error('Screen hidden during sign-in.'), { statusCode: 423 });
          if (fail) throw new Error('synthetic-private-provider-detail');
          await onCapture?.();
          return Buffer.from('synthetic-public-browser-frame');
        },
        control: async (id, input) => {
          controls.push([id, input]);
        },
        clear: async () => {},
        discard: async () => {},
        act: async (id, input) => {
          controls.push([id, input]);
          return { text: 'Synthetic page', url: 'https://example.test/' };
        },
        view: async function* (_id, signal) {
          if (!pageShown) return;
          if (onView) {
            yield* onView(signal);
            return;
          }
          yield Buffer.from('synthetic-live-frame');
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        },
      },
    });
    const request = (path: string) => app.inject({ url: path, headers });
    const insertTurn = async (threadId: string, owner: string, prompt: string) => {
      const id = randomUUID();
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'event',$4,'running')",
        [id, owner, threadId, prompt],
      );
      return id;
    };
    try {
      await db.initializeDatabase();
      const thread = await activeThread(db.pool);
      const foreignThread = await activeThread(db.pool, 'other');
      const turnId = await insertTurn(thread.id, ownerId, 'Synthetic browser');
      const foreignTurnId = await insertTurn(foreignThread.id, 'other', 'Foreign browser');
      const frame = await request('/api/browser/screen');
      assert.equal(frame.statusCode, 200);
      assert.equal(frame.headers['cache-control'], 'no-store');
      assert.equal(frame.body, 'synthetic-public-browser-frame');
      assert.deepEqual(captures, [thread.id]);
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [turnId],
      );
      const paused = await request('/api/browser/screen');
      assert.equal(paused.statusCode, 423);
      assert.equal(paused.body.includes('synthetic-public-browser-frame'), false);
      assert.deepEqual(captures, [thread.id]);
      await db.pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        turnId,
      ]);
      onCapture = async () => {
        await db.pool.query(
          "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
          [turnId],
        );
      };
      const becamePrivate = await request('/api/browser/screen');
      assert.equal(becamePrivate.statusCode, 423);
      assert.equal(becamePrivate.body.includes('synthetic-public-browser-frame'), false);
      assert.deepEqual(captures, [thread.id, thread.id]);
      await db.pool.query("UPDATE turns SET status='running',waiting_reason=NULL WHERE id=$1", [
        turnId,
      ]);
      onCapture = async () => {
        await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [thread.id]);
      };
      const obsolete = await request('/api/browser/screen');
      assert.equal(obsolete.statusCode, 409);
      assert.equal(obsolete.body.includes('synthetic-public-browser-frame'), false);
      onCapture = undefined;
      const next = await activeThread(db.pool);
      assert.notEqual(next.id, thread.id);
      const resumed = await request('/api/browser/screen');
      assert.equal(resumed.statusCode, 200);
      assert.equal(resumed.body, 'synthetic-public-browser-frame');
      assert.equal(captures.at(-1), next.id);
      locked = true;
      const privateFrame = await request('/api/browser/screen');
      assert.equal(privateFrame.statusCode, 423);
      assert.equal(privateFrame.body.includes('synthetic-public-browser-frame'), false);
      locked = false;
      fail = true;
      const failed = await request('/api/browser/screen');
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.body.includes('synthetic-private-provider-detail'), false);
      const nextTurnId = await insertTurn(next.id, ownerId, 'Next browser');
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), turnId],
      );
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), foreignTurnId],
      );
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });
      await db.pool.query(
        "INSERT INTO turn_events(id,turn_id,type,summary) VALUES($1,$2,'tool_complete','browser')",
        [randomUUID(), nextTurnId],
      );
      const fallback = (await request('/api/browser')).json();
      assert.equal(fallback.currentBrowser.threadId, next.id);

      fail = false;
      const click = { type: 'mouse', event: 'down', x: 0.5, y: 0.25, button: 'left' };
      const frames: Buffer[] = [];
      const post = (url: string, payload: object) =>
        app.inject({ method: 'POST', url, payload: { turnId: nextTurnId, ...payload }, headers });
      const handoff = async (input: unknown = click) => {
        const controller = new AbortController();
        const stream = await app.inject({
          url: `/api/browser-handoff/stream?turnId=${nextTurnId}`,
          headers,
          payloadAsStream: true,
          signal: controller.signal,
        });
        if (stream.statusCode === 200)
          frames.push(
            await new Promise<Buffer>((resolve) => {
              let body = Buffer.alloc(0);
              stream.stream().on('data', (chunk) => {
                body = Buffer.concat([body, chunk]);
                if (body.length >= 4 && body.length >= body.readUInt32BE(0) + 4) resolve(body);
              });
            }),
          );
        controller.abort();
        return [
          stream.statusCode,
          (await post('/api/browser-handoff', { inputs: [input] })).statusCode,
          (await post('/api/browser-handoff/navigate', { action: 'back' })).statusCode,
        ];
      };
      assert.deepEqual(await handoff(), [423, 423, 423]);
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [nextTurnId],
      );
      assert.deepEqual(await handoff(), [423, 423, 423]);
      await db.pool.query(
        "UPDATE turns SET waiting_reason='question',handoff_browser_id=session_id::text WHERE id=$1",
        [nextTurnId],
      );
      assert.deepEqual(await handoff(), [200, 200, 200]);
      assert.equal(frames[0].readUInt32BE(0), Buffer.byteLength('synthetic-live-frame'));
      assert.equal(frames[0].subarray(4).toString(), 'synthetic-live-frame');
      assert.deepEqual(controls, [
        [next.id, click],
        [next.id, { action: 'back' }],
      ]);
      const scroll = { type: 'wheel', deltaX: 0, deltaY: 120 };
      assert.equal((await post('/api/browser-handoff', { inputs: [scroll] })).statusCode, 200);
      assert.deepEqual(await handoff({ ...click, x: 2 }), [200, 400, 200]);
      pageShown = false;
      assert.equal(
        (await request(`/api/browser-handoff/stream?turnId=${nextTurnId}`)).statusCode,
        409,
      );
      pageShown = true;
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background) VALUES($1,$2,$3,'event','Check','running',true)",
        [randomUUID(), ownerId, next.id],
      );
      assert.deepEqual(await handoff(), [200, 200, 200]);
      assert.equal(controls.length, 6);
      const backgroundId = randomUUID();
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background,waiting_reason,handoff_browser_id) VALUES($1,$2,$3,'event','Background handoff','waiting',true,'question',$1::uuid::text)",
        [backgroundId, ownerId, next.id],
      );
      assert.equal(
        (await post('/api/browser-handoff', { turnId: backgroundId, inputs: [click] })).statusCode,
        200,
      );
      assert.deepEqual(controls.pop(), [backgroundId, click]);
      assert.equal(
        (await post('/api/browser-handoff', { turnId: foreignTurnId, inputs: [click] })).statusCode,
        423,
      );
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt) VALUES($1,$2,$3,$4,'resume','Continued background work')",
        [randomUUID(), ownerId, next.id, backgroundId],
      );
      assert.equal(
        (await post('/api/browser-handoff', { turnId: backgroundId, inputs: [click] })).statusCode,
        423,
      );
      assert.equal(controls.length, 6);
      for (const reason of ['timeout', 'revoked', 'archived', 'cancelled']) {
        const started = deferred<AbortSignal>();
        const aborted = deferred();
        const closed = deferred();
        onView = async function* (signal) {
          try {
            started.resolve(signal);
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                'abort',
                () => {
                  aborted.resolve();
                  resolve();
                },
                { once: true },
              ),
            );
          } finally {
            closed.resolve();
          }
        };
        const controller = new AbortController();
        const deadline = new AbortController();
        if (reason === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
        const pending = app.inject({
          url: `/api/browser-handoff/stream?turnId=${nextTurnId}`,
          headers,
          signal: controller.signal,
        });
        try {
          const viewing = await started.promise;
          if (reason === 'revoked')
            await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [nextTurnId]);
          if (reason === 'archived')
            await db.pool.query('UPDATE threads SET archived_at=now() WHERE id=$1', [next.id]);
          if (reason === 'cancelled') controller.abort();
          else if (reason === 'timeout') t.mock.timers.tick(10_000);
          const response = await Promise.race([
            Promise.all([pending.catch(() => null), aborted.promise, closed.promise]).then(
              ([response]) => response,
            ),
            delay(5_000, undefined, { signal: deadline.signal }).then(() =>
              assert.fail(`Opening should abort and close after ${reason}.`),
            ),
          ]);
          if (reason !== 'cancelled')
            assert.equal(response?.statusCode, reason === 'timeout' ? 409 : 423);
          assert.equal(viewing.aborted, true);
        } finally {
          deadline.abort();
          controller.abort();
          await pending.catch(() => {});
          if (reason === 'revoked')
            await db.pool.query("UPDATE turns SET status='waiting' WHERE id=$1", [nextTurnId]);
          if (reason === 'archived')
            await db.pool.query('UPDATE threads SET archived_at=NULL WHERE id=$1', [next.id]);
          onView = undefined;
          if (reason === 'timeout') t.mock.timers.reset();
        }
      }
      const replacementStarted = deferred<AbortSignal>();
      const replacementClosed = deferred();
      let views = 0;
      onView = async function* (signal) {
        views++;
        if (views === 1) {
          yield Buffer.from('synthetic-live-frame');
          return;
        }
        try {
          replacementStarted.resolve(signal);
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
        } finally {
          replacementClosed.resolve();
        }
      };
      const controller = new AbortController();
      const deadline = new AbortController();
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const pending = app.inject({
        url: `/api/browser-handoff/stream?turnId=${nextTurnId}`,
        headers,
        signal: controller.signal,
      });
      try {
        const replacement = await replacementStarted.promise;
        t.mock.timers.tick(10_000);
        const [response] = await Promise.race([
          Promise.all([pending, replacementClosed.promise]),
          delay(5_000, undefined, { signal: deadline.signal }).then(() =>
            assert.fail('A silent replacement view should abort and close the live stream.'),
          ),
        ]);
        assert.equal(response.statusCode, 200);
        assert.ok(response.body.includes('synthetic-live-frame'));
        assert.equal(replacement.aborted, true);
        assert.equal(views, 2);
        assert.equal(controls.length, 6);
      } finally {
        deadline.abort();
        controller.abort();
        await pending.catch(() => {});
        onView = undefined;
        t.mock.timers.reset();
      }
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','Done','queued')",
        [randomUUID(), ownerId, next.id],
      );
      assert.deepEqual(await handoff(), [423, 423, 423]);
      assert.equal(controls.length, 6);
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

// Checkpoint quiescence

function syntheticComputer(): Computer & { canCheckpoint?: () => boolean } {
  return {
    ...fakeComputer({
      act: async () => ({ text: 'Synthetic page', url: 'https://example.test/' }),
      injectCredentials: async () => ({ status: 'submitted' }),
      currentPage: async () => ({ origin: 'https://example.test', url: 'https://example.test/' }),
    }),
    canCheckpoint: () => true,
  };
}

async function workerFixture(createComputer: () => Computer | Promise<Computer>, timeoutMs = 5000) {
  const directory = await mkdtemp('/tmp/sk-quiesce-');
  const socketPath = join(directory, 'control.sock');
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: directory,
    createComputer,
  });
  const namespace = 'sk-' + 'a'.repeat(24);
  const request = (call: BrowserCall) =>
    new Promise<BrowserResponse>((resolve, reject) => {
      const socket = connect(socketPath);
      let output = '';
      socket.setEncoding('utf8');
      socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Synthetic request timed out.')));
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write(
          JSON.stringify({
            type: 'request',
            request: { ...call, id: randomUUID(), namespace },
          }) + '\n',
        );
      });
      socket.on('data', (chunk) => {
        output += chunk;
      });
      socket.once('end', () => {
        try {
          resolve(browserResponse.parse(JSON.parse(output)));
        } catch (error) {
          reject(error);
        }
      });
    });
  return {
    request,
    async close() {
      await worker.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function result(response: BrowserResponse) {
  assert.equal(response.ok, true);
  return response.ok ? response.result : undefined;
}

test('quiesce refuses a pending request without aborting or querying its browser', async () => {
  const entered = deferred();
  const release = deferred();
  const computer = syntheticComputer();
  let checks = 0;
  let disposals = 0;
  let aborted = false;
  computer.canCheckpoint = () => {
    checks++;
    return true;
  };
  computer.act = async (_id, _input, signal) => {
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    entered.resolve();
    await release.promise;
    return { text: 'Finished', url: 'https://example.test/' };
  };
  computer.dispose = async () => {
    disposals++;
  };
  const f = await workerFixture(() => computer);
  const active = f.request({ method: 'act', threadId: 'task', input: { action: 'snapshot' } });
  try {
    await entered.promise;
    assert.equal(result(await f.request({ method: 'quiesce' })), false);
    assert.equal(checks, 0);
    assert.equal(disposals, 0);
    assert.equal(aborted, false);
    release.resolve();
    result(await active);
    assert.equal(result(await f.request({ method: 'quiesce' })), true);
    assert.equal(disposals, 1);
  } finally {
    release.resolve();
    await active;
    await f.close();
  }
});

async function browserFixture() {
  const directory = await mkdtemp('/tmp/sk-checkpoint-browser-');
  const browser = stagedLoginBrowser();
  let before = async (_command: string[]) => {};
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, options) => {
      await before(args.slice(args.indexOf('--idle-timeout') + 2));
      return browser.run(executable, args, options);
    },
  });
  return {
    computer,
    open: () => computer.act('task', { action: 'open', url: 'https://1.1.1.1/login' }),
    before(value: typeof before) {
      before = value;
    },
    async close() {
      before = async () => {};
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('checkpoint status blocks credential injection until the private call finishes', async () => {
  const f = await browserFixture();
  const entered = deferred();
  const release = deferred();
  try {
    await f.open();
    const selector = '#account';
    f.before(async (command) => {
      if (command[0] === 'focus') {
        entered.resolve();
        await release.promise;
      }
    });
    const injecting = f.computer.injectCredentials({
      threadId: 'task',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: selector,
    });
    assert.equal(f.computer.canCheckpoint(), false);
    await entered.promise;
    assert.equal(f.computer.canCheckpoint(), false);
    release.resolve();
    assert.deepEqual(await injecting, { status: 'submitted' });
    assert.equal(f.computer.canCheckpoint(), true);
  } finally {
    release.resolve();
    await f.close();
  }
});

// Daemon transport fences and credential feedback

async function transportFixture() {
  const directory = await mkdtemp('/tmp/sk-transport-');
  const pages = stagedLoginBrowser();
  const actions: string[] = [];
  const diagnostics: BrowserDiagnostic[] = [];
  const sockets = new Set<Socket>();
  let before = async (_action: string, _command: Record<string, unknown>) => {};
  let after = async (_action: string, _command: Record<string, unknown>, _socket: Socket) => {};
  let failedAction: string | undefined;
  let failedMessage = 'Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE PRIVATE-UPSTREAM';
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let input = '';
    socket.on('data', async (chunk) => {
      input += chunk.toString();
      if (!input.includes('\n')) return;
      const command = JSON.parse(input);
      input = '';
      actions.push(command.action);
      await before(command.action, command);
      if (command.action === failedAction) {
        socket.end(
          JSON.stringify({
            success: false,
            error: failedMessage,
          }) + '\n',
        );
        return;
      }
      const page = pages.pages.get('fixture')!;
      let data: Record<string, unknown> = {};
      if (command.action === 'url') data = { url: page.location.href };
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'snapshot') data = { snapshot: page.text() };
      if (command.action === 'navigate') page.location.href = command.url;
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      await after(command.action, command, socket);
      if (!socket.destroyed) socket.end(JSON.stringify({ success: true, data }) + '\n');
      if (command.action === 'close') server.close();
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(join(directory, `${browserSessionId('fixture')}.sock`), resolve),
  );
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    headless: true,
    onDiagnostic: (event) => diagnostics.push(event),
    daemonCommand: (path, command, signal) => existingDaemonCommand(path, command, signal, 250),
    run: async (executable, args, options) => {
      if (args.includes('info'))
        return {
          exitCode: 0,
          stderr: '',
          stdout: JSON.stringify({
            success: true,
            data: {
              active: true,
              namespace: args[args.indexOf('--namespace') + 1],
              session: args[args.indexOf('--session') + 1],
              socketDir: directory,
            },
          }),
        };
      const action = args[args.indexOf('--idle-timeout') + 2];
      assert.equal(action, 'open', 'Warm actions must not invoke the retrying CLI');
      return pages.run(executable, args, options);
    },
  });
  return {
    computer,
    actions,
    diagnostics,
    page: () => pages.pages.get('fixture')!,
    fail(action?: string, message?: string) {
      failedAction = action;
      if (message !== undefined) failedMessage = message;
    },
    before(value: typeof before) {
      before = value;
    },
    after(value: typeof after) {
      after = value;
    },
    async cleanup() {
      before = async () => {};
      after = async () => {};
      await computer.dispose().catch(() => {});
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('browser files larger than one protocol message stream through the bridge both ways', async () => {
  const file = Buffer.alloc(13 * 1024 * 1024 + 7);
  for (let index = 0; index < file.length; index += 4099) file[index] = index % 251;
  const uploaded: Buffer[] = [];
  const bridge = await harness({
    computer: fakeComputer({
      download: async () => ({ bytes: file, name: 'export.zip', mimeType: 'application/zip' }),
      upload: async (_id, input) => {
        uploaded.push(Buffer.from(input.bytes));
        return { text: 'Uploaded', url: 'https://example.test/' };
      },
    }),
  });
  try {
    const computer = bridge.client('/synthetic/transfer');
    const downloaded = await computer.download('fixture', {});
    assert.equal(downloaded.name, 'export.zip');
    assert.ok(downloaded.bytes.equals(file));
    const result = await computer.upload('fixture', {
      selector: '#file',
      name: 'export.zip',
      bytes: file,
    });
    assert.equal(result.text, 'Uploaded');
    assert.equal(uploaded.length, 1);
    assert.ok(uploaded[0]!.equals(file));
  } finally {
    await bridge.close();
  }
});

test('a timed out snapshot is not resent and its queue remains fenced until close is acknowledged', async () => {
  const f = await transportFixture();
  const closeStarted = deferred();
  const releaseClose = deferred();
  const releaseSnapshot = deferred();
  let finished = false;
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const before = f.actions.length;
    f.before(async (action) => {
      if (action === 'snapshot') await releaseSnapshot.promise;
      if (action === 'close') {
        closeStarted.resolve();
        await releaseClose.promise;
      }
    });
    const failed = assert
      .rejects(f.computer.act('fixture', { action: 'snapshot' }), /unavailable/)
      .finally(() => {
        finished = true;
      });
    await closeStarted.promise;
    assert.equal(finished, false);
    const queued = assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await Promise.all([failed, queued]);
    assert.equal(f.actions.slice(before).filter((action) => action === 'snapshot').length, 1);
  } finally {
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await f.cleanup();
  }
});

for (const action of ['snapshot', 'click'] as const)
  test(`an acknowledged ${action} observation failure preserves the page through the browser bridge`, async () => {
    const browser = await transportFixture();
    const bridge = await harness({ computer: browser.computer });
    const computer = bridge.client('/synthetic/observation-failure');
    const upstreamError = 'Snapshot timeout with synthetic-private-upstream-value';
    try {
      await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const page = browser.page();
      page.input.value = 'synthetic@example.test';
      page.next.disabled = false;
      browser.after(async (current) => {
        if (current === 'click') page.next.click();
      });
      browser.fail('snapshot', upstreamError);
      const before = browser.actions.length;
      await assert.rejects(
        computer.act('fixture', { action, ...(action === 'click' ? { selector: 'button' } : {}) }),
        (error: unknown) => {
          assert.ok(error instanceof BrowserActionError);
          assert.equal(error.code, 'browser_observation_failed');
          assert.equal(error.message.includes(upstreamError), false);
          return true;
        },
      );
      assert.equal(page.stage, action === 'click' ? 'password' : 'identifier');
      assert.equal(page.entered.length, action === 'click' ? 1 : 0);
      const screen = await computer.screenshot('fixture');
      assert.ok(screen);
      assert.equal(computer.screenStatus!('fixture').state, 'live');
      assert.equal(screen.toString(), page.screen());
      browser.fail();
      assert.match(
        (await computer.act('fixture', { action: 'snapshot' })).text,
        new RegExp(page.stage),
      );
      assert.deepEqual(
        browser.actions
          .slice(before)
          .filter((current) => ['click', 'navigate', 'close'].includes(current)),
        action === 'click' ? ['click'] : [],
      );
      assert.ok(browser.diagnostics.length);
      assert.equal(JSON.stringify(browser.diagnostics).includes('synthetic'), false);
    } finally {
      browser.fail();
      await bridge.close();
      await browser.cleanup();
    }
  });

test('a card goes only into the approved fields on the approved sites and stays out of what the model sees', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-card-'));
  let url = 'about:blank';
  let maskedShot: boolean | undefined;
  let snapshots = 0;
  const autocomplete: Record<string, string> = { '@e4': 'cc-number', '@e5': 'cc-csc' };
  const model: DevtoolsModel = {
    document: 'loader-0',
    frames: [
      { id: 'main', session: 'page', origin: 'https://1.1.1.1' },
      { id: 'pay', session: 'pay-session', origin: 'https://pay.fixture.test', parent: 'page' },
      { id: 'ads', session: 'ads-session', origin: 'https://ads.fixture.test', parent: 'page' },
    ],
    frameOf: { '@e3': 'main', '#expiry': 'main', '@e4': 'pay', '@e5': 'pay', '@e9': 'ads' },
    values: new Map(),
  };
  let documents = 0;
  const devtools = await fakeDevtools(model);
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (_executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      let data: Record<string, unknown> = {};
      if (command[0] === 'open' || command[0] === 'reload') {
        if (command[0] === 'open') url = command[1]!;
        model.document = `loader-${++documents}`;
        model.values.clear();
        model.focused = model.field = model.armed = undefined;
      }
      if (command[0] === 'get' && command[1] === 'url') data = { url };
      if (command[0] === 'get' && command[1] === 'cdp-url') data = { cdpUrl: devtools.url };
      if (command[0] === 'get' && command[1] === 'attr')
        data = {
          value: command[3] === 'autocomplete' ? (autocomplete[command[2]!] ?? null) : null,
        };
      if (command[0] === 'focus') {
        model.field = command[1]!;
        model.focused = model.frameOf[command[1]!];
      }
      if (command[0] === 'eval') data = { result: options?.input?.length ?? 0 };
      if (command[0] === 'screenshot') {
        if (command.includes('--full')) maskedShot = model.masked;
        await writeFile(command[1]!, command.includes('--full') ? 'synthetic-checkout' : 'screen');
      }
      if (command[0] === 'snapshot') {
        snapshots++;
        data = {
          snapshot: [
            '- heading "Checkout" [ref=e1]',
            '- StaticText "Total €43.20, order 737-12"',
            `- textbox "Name" [ref=e3]: ${model.values.get('@e3') ?? ''}`,
            `- textbox "Card" [ref=e4]: ${(model.values.get('@e4') ?? '').replace(/(\d{4})(?=\d)/g, '$1 ')}`,
            `- textbox "Code" [ref=e5]: ${model.values.get('@e5') ?? ''}`,
            `- textbox "Expiry" [ref=e6]: ${model.values.get('#expiry') ?? ''}`,
            `- StaticText "Paying with ${(model.values.get('@e4') ?? '').replace(/(\d{4})(?=\d)/g, '$1-')}"`,
          ].join('\n'),
        };
      }
      return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
    },
  });
  const card = {
    cardNumber: '4242424242424242',
    expiryMonth: 8,
    expiryYear: 2030,
    cardholder: 'Synthetic Cardholder',
    securityCode: '737',
  };
  const fields = { number: '@e4', expiry: '#expiry', securityCode: '@e5', name: '@e3' };
  const destinations = {
    number: 'https://pay.fixture.test',
    expiry: 'https://1.1.1.1',
    securityCode: 'https://pay.fixture.test',
    name: 'https://1.1.1.1',
  };
  try {
    await computer.act('shop', { action: 'open', url: 'https://1.1.1.1/checkout' });
    const found = await computer.cardDestinations('shop', fields);
    assert.deepEqual(found, { document: model.document, destinations });
    assert.equal(model.focused, undefined);
    assert.equal(
      Buffer.from(await computer.checkoutImage('shop')).toString(),
      'synthetic-checkout',
    );
    assert.equal(maskedShot, true);
    assert.equal(model.masked, false);
    let entry: Parameters<Computer['fillCard']>[0] = { threadId: 'shop', fields, card, ...found };
    await assert.rejects(
      computer.fillCard({ ...entry, document: 'loader-old' }),
      /checkout page changed/,
    );
    await computer.act('shop', { action: 'reload' });
    entry = { ...entry, ...(await computer.cardDestinations('shop', fields)) };
    await assert.rejects(
      computer.fillCard({
        ...entry,
        destinations: { ...destinations, number: 'https://1.1.1.1' },
      }),
      (error: unknown) => error instanceof BrowserActionError && error.code === 'browser_card_site',
    );
    assert.equal(model.values.size, 0);
    await computer.act('shop', { action: 'reload' });
    entry = { ...entry, ...(await computer.cardDestinations('shop', fields)) };
    await computer.fillCard(entry);
    const seen = (await computer.act('shop', { action: 'snapshot' })).text;
    const beforeFailure = snapshots;
    model.failMasks = true;
    await assert.rejects(computer.act('shop', { action: 'snapshot' }));
    assert.equal(snapshots, beforeFailure);
    model.failMasks = false;
    assert.doesNotMatch(seen, /4242|: 737/);
    assert.match(seen, /"Expiry"[^\n]*: 08\/30/);
    await assert.rejects(
      computer.act('shop', { action: 'evaluate', script: 'document.title' }),
      /scripts are paused/,
    );
    await computer.act('shop', { action: 'press', key: 'Control+c' });
    await computer.act('shop', { action: 'fill', selector: '#notes', text: 'x' });
    assert.ok(await computer.screenshot('shop'));
    assert.ok(await computer.checkoutImage('shop'));
    await computer.act('shop', { action: 'open', url: 'https://1.1.1.1/checkout' });
    const extra = await computer.cardDestinations('shop', fields);
    await assert.rejects(
      computer.fillCard({
        ...entry,
        ...extra,
        submitSelector: '@e9',
        destinations: { ...extra.destinations, expiryYear: 'https://ads.fixture.test' },
      }),
      /submit control is not on this page/,
    );
    assert.equal(model.values.get('@e9'), undefined);
    await computer.act('shop', { action: 'open', url: 'https://1.1.1.1/thanks' });
    assert.ok(await computer.screenshot('shop'));
    await computer.act('shop', { action: 'open', url: 'https://1.1.1.1/checkout' });
    model.steal = { after: 4, field: '@e9' };
    const stolen = await computer.cardDestinations('shop', fields);
    await assert.rejects(
      computer.fillCard({ ...entry, ...stolen }),
      (error: unknown) => error instanceof BrowserActionError && error.code === 'browser_card_site',
    );
    assert.equal(model.values.get('@e4'), card.cardNumber.slice(0, 4));
    assert.equal(model.values.get('@e9'), undefined);
    await assert.rejects(computer.act('shop', { action: 'snapshot' }));
    model.steal = undefined;
    await computer.act('shop', { action: 'open', url: 'https://1.1.1.1/checkout' });
    assert.match(
      (
        await computer.act('shop', {
          action: 'evaluate',
          script: 'document.body.dataset.modified = "true"',
        })
      ).text,
      /Script result/,
    );
    await assert.rejects(computer.cardDestinations('shop', fields), /script ran on this document/);
    await computer.act('shop', { action: 'reload' });
    model.document = `loader-${++documents}`;
    const fresh = await computer.cardDestinations('shop', fields);
    await computer.fillCard({ ...entry, ...fresh });
    assert.equal(model.values.get('@e4'), card.cardNumber);
    assert.doesNotMatch((await computer.act('shop', { action: 'snapshot' })).text, /4242/);
  } finally {
    await computer.dispose();
    await devtools.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'in real Chrome a card reaches only the verified fields and never a frame that grabs focus',
  { timeout: 180_000 },
  async (t) => {
    const received: Array<{ frame: string; field: string; value: string }> = [];
    const submitted: Array<Record<string, string>> = [];
    const page = (body: string) => `<!doctype html><meta charset="utf-8"><body>${body}</body>`;
    const record = (frame: string) =>
      `<script>for (const input of document.querySelectorAll('input')) input.addEventListener('input', () => { parent.postMessage('typed', '*'); fetch('/record', { method: 'POST', keepalive: true, body: JSON.stringify({ frame: '${frame}', field: input.id, value: input.value }) }); });</script>`;
    let steal = false;
    const server = createHttpServer((request, response) => {
      const { port } = server.address() as { port: number };
      if (request.method === 'POST' && request.url === '/record') {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          received.push(JSON.parse(body));
          response.end();
        });
        return;
      }
      if (request.method === 'POST' && request.url === '/paid') {
        let body = '';
        request.on('data', (chunk) => (body += chunk));
        request.on('end', () => {
          submitted.push(Object.fromEntries(new URLSearchParams(body)));
          response.setHeader('content-type', 'text/html');
          response.end(page('<h1>Payment received</h1>'));
        });
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/pay')
        return response.end(
          page(
            `<form method="post" action="http://127.0.0.1:${port}/paid" target="_top"><input id="number" name="number" aria-label="Card number"><input id="cvc" name="cvc" aria-label="Security code"><button>Pay now</button></form>${record('pay')}`,
          ),
        );
      if (request.url?.startsWith('/paid')) return response.end(page('<h1>Payment received</h1>'));
      if (request.url === '/ad')
        return response.end(
          page(
            `<input id="ad" aria-label="Ad box">${record('ad')}<script>addEventListener('focus', () => document.getElementById('ad').focus());</script>`,
          ),
        );
      response.end(
        page(
          `<h1>Shop</h1><input id="name" aria-label="Name on card"><iframe title="Card" src="http://localhost:${port}/pay"></iframe><iframe title="Ad" src="http://[::1]:${port}/ad"></iframe>${steal ? "<script>addEventListener('message', () => document.querySelector('iframe[title=Ad]').focus());</script>" : ''}`,
        ),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '::', resolve));
    const { port } = server.address() as { port: number };
    const directory = await mkdtemp(join(tmpdir(), 'nod-real-card-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      privateNetwork: true,
      headless: true,
    });
    const shop = `http://127.0.0.1:${port}`;
    const card = {
      cardNumber: '4242424242424242',
      expiryMonth: 8,
      expiryYear: 2030,
      cardholder: 'Synthetic Cardholder',
      securityCode: '737',
    };
    const refs = async () => {
      const text = (await computer.act('real', { action: 'snapshot' })).text;
      const ref = (name: string) => `@${new RegExp(`"${name}"[^\\n]*?ref=(e\\d+)`).exec(text)![1]}`;
      return {
        number: ref('Card number'),
        securityCode: ref('Security code'),
        name: ref('Name on card'),
      };
    };
    try {
      try {
        await computer.act('real', { action: 'open', url: `${shop}/` });
      } catch {
        t.skip('Chrome is not available here.');
        return;
      }
      await delay(500);
      const fields = await refs();
      const found = await computer.cardDestinations('real', fields);
      assert.deepEqual(found.destinations, {
        number: `http://localhost:${port}`,
        securityCode: `http://localhost:${port}`,
        name: shop,
      });
      const image = await computer.checkoutImage('real');
      assert.deepEqual([...image.subarray(0, 2)], [0xff, 0xd8]);
      const checkout = (await computer.act('real', { action: 'snapshot' })).text;
      const submitSelector = `@${/"Pay now"[^\n]*?ref=(e\d+)/.exec(checkout)![1]}`;
      await computer.fillCard({ threadId: 'real', fields, card, ...found, submitSelector });
      await delay(300);
      assert.deepEqual(submitted, [{ number: card.cardNumber, cvc: card.securityCode }]);
      assert.equal(
        received.some((item) => item.frame === 'ad'),
        false,
      );
      const seen = (await computer.act('real', { action: 'snapshot' })).text;
      assert.match(seen, /Payment received/);
      assert.doesNotMatch(seen, /4242|737|Synthetic Cardholder/);
      assert.match(
        (await computer.act('real', { action: 'evaluate', script: 'document.title' })).text,
        /Script result/,
      );
      assert.ok(await computer.screenshot('real'));
      await computer.close('real');
      steal = true;
      received.length = 0;
      await computer.act('real', { action: 'open', url: `${shop}/` });
      await delay(500);
      const again = await refs();
      const verified = await computer.cardDestinations('real', again);
      await computer
        .fillCard({ threadId: 'real', fields: again, card, ...verified })
        .catch(() => {});
      await delay(300);
      assert.ok(received.some((item) => item.frame === 'pay' && item.value.startsWith('4')));
      assert.equal(
        received.some((item) => item.frame === 'ad'),
        false,
      );
    } finally {
      await computer.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'in real Chrome a snapshot keeps the plain text around tables and links',
  { timeout: 120_000 },
  async (t) => {
    const server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<!doctype html><meta charset="utf-8"><body><h1>Laptop</h1><p>Before the table, plain text.</p><table><tr><th>Destination</th><th>Cost</th></tr><tr><td>Portugal</td><td>19.00</td></tr></table><p>Free delivery to Spain and Portugal on orders over 1,000.</p><p>See our <a href="/delivery">delivery page</a> for details.</p></body>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    const directory = await mkdtemp(join(tmpdir(), 'nod-real-text-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      privateNetwork: true,
      headless: true,
    });
    try {
      try {
        await computer.act('text', { action: 'open', url: `http://127.0.0.1:${port}/` });
      } catch {
        t.skip('Chrome is not available here.');
        return;
      }
      const text = (await computer.act('text', { action: 'snapshot' })).text;
      for (const line of [
        'Before the table, plain text.',
        'Free delivery to Spain and Portugal on orders over 1,000.',
        'See our ',
        ' for details.',
      ])
        assert.ok(text.includes(line), `${line}\n---\n${text}`);
    } finally {
      await computer.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('discarding a thread closes its browser and deletes only its throwaway data; clearing a finished session lets it start fresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-discard-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, options) => {
      commands.push(args[args.indexOf('--idle-timeout') + 2]);
      return fixture.run(executable, args, options);
    },
  });
  const runtime = join(directory, 'runtime');
  const savedProfile = randomUUID();
  const dirs = ['profiles/old', 'downloads/old', 'profiles/other', `profiles/${savedProfile}`];
  const screens = [
    'screen-old.png',
    'screen-old.capture.png',
    'screen-bound.png',
    'screen-other.png',
  ];
  try {
    for (const dir of dirs) {
      await mkdir(join(runtime, dir), { recursive: true });
      await writeFile(join(runtime, dir, 'data'), 'synthetic');
    }
    for (const screen of screens) await writeFile(join(runtime, screen), 'synthetic');
    await computer.act('old', { action: 'open', url: 'https://1.1.1.1/login' });
    await computer.act('other', { action: 'open', url: 'https://1.1.1.1/login' });
    await computer.bindProfile!('bound', savedProfile);
    await computer.discard!('old');
    await computer.discard!('bound');
    await assert.rejects(
      computer.act('old', { action: 'open', url: 'https://1.1.1.1/login' }),
      /was reset/,
    );
    await assert.rejects(computer.bindProfile!('old', savedProfile), /was reset/);
    assert.equal(commands.filter((command) => command === 'close').length, 1);
    assert.deepEqual(
      (await readdir(join(runtime, 'profiles'))).sort(),
      [savedProfile, 'other'].sort(),
    );
    assert.deepEqual(await readdir(join(runtime, 'downloads')), []);
    assert.deepEqual(
      (await readdir(runtime)).filter((file) => file.startsWith('screen-')),
      ['screen-other.png'],
    );
    assert.equal(computer.screenStatus!('old').state, 'unavailable');
    assert.equal(
      (await computer.act('other', { action: 'snapshot' })).url,
      'https://1.1.1.1/login',
    );
    await computer.clear!('other');
    assert.deepEqual(await readdir(join(runtime, 'profiles')), [savedProfile]);
    assert.equal(
      (await computer.act('other', { action: 'open', url: 'https://1.1.1.1/login' })).url,
      'https://1.1.1.1/login',
    );
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a browser that will not close is killed with its process groups so the next open starts fresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-drain-failure-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  let failOpen = true;
  const sockets = join(directory, 'fixture-sockets');
  const profile = join(directory, 'runtime', 'profiles', 'fixture');
  const daemon = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, AGENT_BROWSER_SESSION: browserSessionId('fixture') },
  });
  const display = Number(String((await once(daemon.stdout, 'data'))[0]).trim());
  const chrome = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)', `--user-data-dir=${profile}`],
    { detached: true, stdio: 'ignore' },
  );
  const alive = async (pid: number) => {
    for (let waited = 0; waited < 2000; waited += 50) {
      try {
        process.kill(pid, 0);
      } catch {
        return false;
      }
      await delay(50);
    }
    return true;
  };
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, input) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failOpen) {
        failOpen = false;
        throw new Error('Runtime command exceeded its time limit.');
      }
      if (action === 'close') throw new Error('Synthetic close unavailable.');
      return fixture.run(executable, args, input);
    },
  });
  try {
    await mkdir(sockets, { recursive: true });
    await mkdir(profile, { recursive: true });
    await writeFile(join(sockets, `${browserSessionId('fixture')}.pid`), String(daemon.pid));
    await symlink(`${hostname()}-${chrome.pid}`, join(profile, 'SingletonLock'));
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /time limit/,
    );
    assert.ok(commands.includes('close'));
    assert.equal(await alive(daemon.pid!), false);
    assert.equal(await alive(display), false);
    assert.equal(await alive(chrome.pid!), false);
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    for (const pid of [daemon.pid, display, chrome.pid])
      try {
        process.kill(pid!, 'SIGKILL');
      } catch {}
    await computer.dispose().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});

type Execute = (
  id: string,
  input: Static<typeof toolDefinitions.browser.parameters>,
) => Promise<AgentToolResult>;

async function runtimeFixture(
  computer: Computer,
  run: (execute: Execute) => Promise<void>,
  controller = new AbortController(),
) {
  const directory = await mkdtemp(join(tmpdir(), 'nod-click-recovery-'));
  const threadId = randomUUID();
  const agent: Agent = {
    open: async ({ tools }) => ({
      resumed: false,
      prompt: async () => {
        const tool = tools.find((value) => value.name === 'browser')!;
        await run((_id, input) => tool.execute({ ...input }));
      },
      abort() {},
      dispose() {},
    }),
    dispose() {},
  };
  const runtime = createAgentRuntime({ agent, computer, workspace: fakeWorkspace() });
  const context: RuntimeContext = {
    threadId,
    sessionId: threadId,
    turnId: randomUUID(),
    prompt: 'Open the synthetic destination after dismissing its covering dialog.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: controller.signal,
    emit: async () => {},
    reply: async () => {},
    delta() {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({ filled: true }),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  return {
    run: () => runtime.runTurn(context),
    async close() {
      try {
        await runtime.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

test('every session drives its own browser, so background work never waits for the conversation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-session-'));
  const threadId = randomUUID();
  const opened = new Map<string, string>();
  const cleared: string[] = [];
  const held: string[] = [];
  const scripts = new Map<string, (tools: Map<string, AgentTool>) => Promise<unknown>>();
  const runtime = createAgentRuntime({
    agent: {
      open: async ({ turnId, tools }) => ({
        resumed: false,
        prompt: async () => {
          await scripts.get(turnId)!(new Map(tools.map((tool) => [tool.name, tool])));
        },
        abort() {},
        dispose() {},
      }),
      dispose() {},
    },
    computer: fakeComputer({
      act: async (id, action) => {
        if (action.action === 'open' && action.url) opened.set(id, action.url);
        return { text: 'Fixture page', url: 'https://example.com' };
      },
      clear: async (id) => {
        cleared.push(id);
      },
      hold: async (id, value) => {
        if (value) held.push(id);
      },
    }),
    workspace: fakeWorkspace(),
  });
  const turn = (
    sessionId: string | undefined,
    script: (tools: Map<string, AgentTool>) => Promise<unknown>,
    resumed = false,
  ) => {
    const turnId = randomUUID();
    scripts.set(turnId, script);
    return runtime.runTurn({
      threadId,
      turnId,
      sessionId: sessionId ?? threadId,
      background: sessionId !== undefined,
      resumed,
      prompt: 'Use the browser.',
      history: [],
      attachments: [],
      workspacePath: directory,
      signal: new AbortController().signal,
      emit: async () => {},
      reply: async () => {},
      delta() {},
      publish: async () => {
        throw new Error('unused');
      },
      requestCredential: async () => ({ filled: true }),
      integration: async () => ({}),
      manage: async () => ({}),
    });
  };
  const open = (tools: Map<string, AgentTool>, url: string) =>
    tools.get('browser')!.execute({ action: 'open', url });
  const busy = deferred();
  const deadline = new AbortController();
  try {
    const conversation = turn(undefined, async (tools) => {
      await open(tools, 'https://example.com/conversation');
      await busy.promise;
      await tools.get('ask_user')!.execute({ question: 'Sign in in [Open browser](/browser).' });
    });
    const finished = randomUUID();
    const asking = randomUUID();
    const waiting = turn(asking, async (tools) => {
      await open(tools, 'https://example.com/asking');
      await tools.get('ask_user')!.execute({ question: 'Which date works?' });
    });
    const done = await Promise.race([
      turn(finished, (tools) => open(tools, 'https://example.com/finished')),
      delay(5_000, undefined, { signal: deadline.signal }).then(() =>
        assert.fail('Background work waited for the conversation browser.'),
      ),
    ]);
    assert.equal(done.status, 'succeeded');
    assert.equal((await waiting).status, 'waiting_user');
    busy.resolve();
    assert.equal((await conversation).status, 'waiting_user');
    assert.deepEqual(
      Object.fromEntries(opened),
      Object.fromEntries([
        [threadId, 'https://example.com/conversation'],
        [asking, 'https://example.com/asking'],
        [finished, 'https://example.com/finished'],
      ]),
    );
    assert.deepEqual(cleared, [finished]);
    assert.deepEqual(held.sort(), [asking, threadId].sort());
    assert.equal((await turn(asking, async () => {}, true)).status, 'succeeded');
    assert.deepEqual(cleared, [finished, asking]);
  } finally {
    deadline.abort();
    busy.resolve();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('at the browser cap a new browser waits for one idle past the window and never evicts a held one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-cap-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    maxLiveSessions: 2,
    evictIdleMs: 3000,
  });
  const open = (id: string, signal?: AbortSignal) =>
    computer.act(id, { action: 'open', url: 'https://1.1.1.1/login' }, signal);
  const pages = () => [...fixture.pages.keys()].sort();
  try {
    await open('chat');
    await computer.hold('chat', true);
    await open('subagent');
    const stop = new AbortController();
    const stopped = open('event', stop.signal);
    await delay(200);
    stop.abort();
    await assert.rejects(stopped, { name: 'AbortError' });
    assert.deepEqual(pages(), ['chat', 'subagent']);
    await open('scheduled');
    assert.deepEqual(pages(), ['chat', 'scheduled']);
    await computer.hold('scheduled', true);
    await delay(3100);
    const waiting = new AbortController();
    const blocked = open('later', waiting.signal);
    await delay(700);
    waiting.abort();
    await assert.rejects(blocked, { name: 'AbortError' });
    assert.deepEqual(pages(), ['chat', 'scheduled']);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a cancelled browser action cannot feed its cached screenshot back to the model', async () => {
  const browser = await transportFixture();
  const releaseClick = deferred();
  const runtime = await runtimeFixture(
    {
      ...browser.computer,
      screenshot: (_id, signal) => browser.computer.screenshot('fixture', signal),
      screenStatus: () => browser.computer.screenStatus!('fixture'),
    },
    async (execute) => {
      await execute('fixture', { action: 'screenshot' });
    },
  );
  try {
    await browser.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const captured = await browser.computer.screenshot('fixture');
    assert.ok(captured);
    assert.equal(browser.computer.screenStatus!('fixture').state, 'live');
    browser.before(async (action) => {
      if (action === 'click') await releaseClick.promise;
    });
    await assert.rejects(
      browser.computer.act('fixture', { action: 'click', selector: '@e1' }),
      /unavailable/,
    );
    assert.deepEqual(await browser.computer.screenshot('fixture'), captured);
    assert.equal(browser.computer.screenStatus!('fixture').state, 'last_known');
    await assert.rejects(runtime.run(), /live browser screenshot.*reopen/i);
  } finally {
    releaseClick.resolve();
    await runtime.close();
    await browser.cleanup();
  }
});

for (const failure of ['unknown', 'forged', 'navigation', 'wrong_action', 'cancelled'])
  test(`${failure} browser failure stops the turn without a blocked result`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const f = await runtimeFixture(
      fakeComputer({
        act: async () => {
          calls++;
          if (failure === 'cancelled') controller.abort();
          if (failure === 'unknown') throw new Error('Private unknown outcome');
          if (failure === 'forged')
            throw Object.assign(new Error('Private forged error'), {
              code: 'browser_click_intercepted',
            });
          throw new BrowserActionError(
            failure === 'navigation' ? 'browser_navigation_failed' : 'browser_click_intercepted',
          );
        },
      }),
      async (execute) => {
        await execute('uncertain', {
          action: failure === 'wrong_action' ? 'snapshot' : 'click',
          selector: '@e1',
        });
        assert.fail('An uncertain browser result must not continue.');
      },
      controller,
    );
    try {
      await assert.rejects(f.run());
      assert.equal(calls, 1);
    } finally {
      await f.close();
    }
  });

// Container browser worker namespaces

function workerComputer() {
  const calls: Array<{ method: string; input?: unknown }> = [];
  let act: Computer['act'] = async (_id, input) => {
    return {
      text: input.text ?? 'Synthetic page',
      url: input.url ?? 'https://example.com/',
    };
  };
  const computer: Computer = {
    ...fakeComputer(),
    screenStatus: () => ({ state: 'live', capturedAt: '2026-09-25T12:00:00.000Z' }),
    act: (id, input, signal) => {
      calls.push({ method: 'act', input });
      return act(id, input, signal);
    },
    screenshot: async () => Buffer.from('masked synthetic image'),
    injectCredentials: async (input) => {
      calls.push({ method: 'injectCredentials', input });
      return { status: 'submitted' };
    },
    currentPage: async () => {
      calls.push({ method: 'currentPage' });
      return { origin: 'https://example.com', url: 'https://example.com/login' };
    },
    bindProfile: async (_id, profileId) => {
      calls.push({ method: 'bindProfile', input: profileId });
    },
    hold: async () => {},
    close: async () => {
      calls.push({ method: 'close' });
    },
    discard: async (id) => {
      calls.push({ method: 'discard', input: id });
    },
    fillCard: async (input) => {
      calls.push({ method: 'fillCard', input });
    },
    cardDestinations: async (id, fields) => {
      calls.push({ method: 'cardDestinations', input: { id, fields } });
      return { document: 'loader-1', destinations: { number: 'https://pay.fixture.test' } };
    },
    checkoutImage: async (id) => {
      calls.push({ method: 'checkoutImage', input: id });
      return new Uint8Array([255, 216, 255]);
    },
    dispose: async () => {
      calls.push({ method: 'dispose' });
    },
  };
  return {
    computer,
    calls,
    setAct(value: Computer['act']) {
      act = value;
    },
  };
}

async function harness(control: { beforeFirstBridge?: Promise<void>; computer?: Computer } = {}) {
  const root = await mkdtemp('/tmp/sk-browser-');
  const socketPath = join(root, 'control.sock');
  const instances = new Map<string, ReturnType<typeof workerComputer>>();
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: async (path) => {
      if (control.computer) return control.computer;
      const value = workerComputer();
      instances.set(path, value);
      return value.computer;
    },
  });
  const launches: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv | undefined }> =
    [];
  const bridges: ChildProcessWithoutNullStreams[] = [];
  const launch: BrowserBridgeLauncher = (command, args, options) => {
    launches.push({ command, args, env: options.env });
    const process = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        this.stdin.destroy();
        return true;
      },
    });
    void Promise.resolve(launches.length === 1 ? control.beforeFirstBridge : undefined)
      .then(() => runBrowserBridge({ input: process.stdin, output: process.stdout, socketPath }))
      .then((code) => {
        process.stdout.end();
        process.stderr.end();
        process.emit('close', code);
      });
    const bridge = process as unknown as ChildProcessWithoutNullStreams;
    bridges.push(bridge);
    return bridge;
  };
  const clients: Computer[] = [];
  function client(dataRoot: string, options: { timeoutMs?: number; drainTimeoutMs?: number } = {}) {
    const value = createContainerBrowserComputer({ dataRoot, spawn: launch, ...options });
    clients.push(value);
    return value;
  }
  return {
    root,
    socketPath,
    worker,
    launches,
    bridges,
    instances,
    client,
    instance(dataRoot: string) {
      const value = instances.get(join(root, browserNamespace(dataRoot)));
      assert.ok(value);
      return value;
    },
    async close() {
      await Promise.allSettled(clients.map((client) => client.dispose()));
      await worker.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('a live view acknowledges applied input or fails', { timeout: 10_000 }, async (t) => {
  const inputs: unknown[] = [];
  const initialInputs: Array<Parameters<Computer['control']>[1]> = [
    { type: 'mouse', event: 'move', x: 0.5, y: 0.5 },
    { type: 'text', text: 'hi' },
    { type: 'wheel', deltaX: 12, deltaY: -240 },
    { type: 'key', key: 'Shift+Tab' },
  ];
  let failInput = false;
  let inputStarted = deferred();
  let inputAborted = deferred();
  let allowInput: Promise<void> | undefined;
  let inputSignal: AbortSignal | undefined;
  const viewSignals: AbortSignal[] = [];
  let disposals = 0;
  const computer: Computer = {
    ...syntheticComputer(),
    dispose: async () => {
      disposals++;
    },
    control: async (_id, input, signal) => {
      inputSignal = signal;
      inputStarted.resolve();
      const aborted = inputAborted;
      signal?.addEventListener('abort', () => aborted.resolve(), { once: true });
      if (failInput)
        throw new BrowserActionError('browser_click_intercepted', 'Synthetic private detail');
      await allowInput;
      await delay(1, undefined, { signal });
      signal?.throwIfAborted();
      inputs.push(input);
    },
    view: async function* (_id, signal) {
      viewSignals.push(signal);
      yield Buffer.from('first frame');
      while (inputs.length < initialInputs.length && !signal.aborted) await delay(5);
      yield Buffer.from('second frame');
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const fixture = await harness({ computer });
  try {
    const client = fixture.client('/synthetic/live-view');
    const frames: string[] = [];
    for await (const frame of client.view!('task', new AbortController().signal)) {
      frames.push(String(frame));
      if (frames.length === 1) {
        await Promise.all(
          initialInputs.map(async (input, index) => {
            await client.control('task', input);
            assert.deepEqual(inputs[index], input);
          }),
        );
      } else break;
    }
    assert.deepEqual(frames, ['first frame', 'second frame']);
    assert.deepEqual(inputs, initialInputs);
    await assert.rejects(client.control!('task', { type: 'text', text: 'late' }), /not open/);
    const controller = new AbortController();
    const stream = client.view!('task', controller.signal)[Symbol.asyncIterator]();
    await stream.next();
    failInput = true;
    await assert.rejects(
      client.control!('task', { type: 'mouse', event: 'down', x: 0.5, y: 0.5 }),
      (error: unknown) =>
        error instanceof BrowserActionError &&
        error.code === 'browser_click_intercepted' &&
        !error.message.includes('Synthetic private detail'),
    );
    assert.equal(inputs.length, initialInputs.length);
    failInput = false;
    inputStarted = deferred();
    inputAborted = deferred();
    const ready = deferred();
    allowInput = ready.promise;
    let acknowledged = false;
    const typing = client.control!('task', { type: 'text', text: 'before Done' }).then(() => {
      acknowledged = true;
    });
    await inputStarted.promise;
    assert.equal(acknowledged, false);
    ready.resolve();
    await typing;
    assert.deepEqual(inputs.at(-1), { type: 'text', text: 'before Done' });
    controller.abort();
    await stream.return?.();

    for (const interruption of ['abort', 'disconnect']) {
      inputStarted = deferred();
      inputAborted = deferred();
      const interrupted = deferred();
      allowInput = interrupted.promise;
      const nextController = new AbortController();
      const next = client.view!('task', nextController.signal)[Symbol.asyncIterator]();
      await next.next();
      const pendingInput = client.control!('task', { type: 'text', text: 'interrupted' });
      const rejected = assert.rejects(pendingInput, /did not finish/);
      await inputStarted.promise;
      if (interruption === 'abort') nextController.abort();
      else fixture.bridges.at(-1)!.stdin.destroy();
      await rejected;
      await inputAborted.promise;
      interrupted.resolve();
      await next.return?.();
      assert.equal(inputs.length, initialInputs.length + 1);
    }

    inputStarted = deferred();
    inputAborted = deferred();
    const timedOut = deferred();
    allowInput = timedOut.promise;
    const timedClient = fixture.client('/synthetic/input-timeout', { timeoutMs: 30 });
    const timedView = timedClient
      .view('task', new AbortController().signal)
      [Symbol.asyncIterator]();
    await timedView.next();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const timeout = assert.rejects(
        timedClient.control('task', { type: 'text', text: 'timed out' }),
        /did not finish/,
      );
      await inputStarted.promise;
      t.mock.timers.tick(30);
      await timeout;
      await inputAborted.promise;
    } finally {
      t.mock.timers.reset();
      timedOut.resolve();
      await timedView.return?.();
    }
    assert.equal(inputs.length, initialInputs.length + 1);

    allowInput = undefined;
    const olderController = new AbortController();
    const older = client.view('task', olderController.signal)[Symbol.asyncIterator]();
    await older.next();
    const newestController = new AbortController();
    const newest = client.view('task', newestController.signal)[Symbol.asyncIterator]();
    await newest.next();
    await client.control('task', { type: 'text', text: 'newest view' });
    assert.equal(inputSignal, viewSignals.at(-1));
    olderController.abort();
    await older.return?.();
    await client.control('task', { type: 'text', text: 'still newest' });
    assert.equal(inputSignal, viewSignals.at(-1));
    newestController.abort();
    await newest.return?.();
    assert.equal(inputs.length, initialInputs.length + 3);
    assert.match((await client.act('task', { action: 'snapshot' })).text, /Synthetic page/);
    assert.equal(disposals, 0);
  } finally {
    await fixture.close();
  }
});

test('each application namespace retains its own worker and disposal drains only that namespace', async () => {
  const fixture = await harness();
  try {
    const first = fixture.client('/synthetic/first');
    const second = fixture.client('/synthetic/second');
    await Promise.all([
      first.act('same-task', { action: 'snapshot' }),
      second.act('same-task', { action: 'snapshot' }),
    ]);
    const one = fixture.instance('/synthetic/first');
    const two = fixture.instance('/synthetic/second');
    await first.dispose();
    assert.equal(one.calls.filter((call) => call.method === 'dispose').length, 1);
    assert.equal(
      two.calls.some((call) => call.method === 'dispose'),
      false,
    );
    await assert.rejects(first.act('same-task', { action: 'snapshot' }), /unavailable/);
    await assert.rejects(
      first.act('same-task', { action: 'open', url: 'https://example.com' }),
      /unavailable/,
    );
    await assert.rejects(first.bindProfile!('same-task', randomUUID()), /unavailable/);
    assert.equal(one.calls.filter((call) => call.method === 'dispose').length, 1);
    await second.act('same-task', { action: 'snapshot' });
  } finally {
    await fixture.close();
  }
});

test('malformed methods and namespaces never reach a computer or filesystem path', async () => {
  const fixture = await harness();
  try {
    for (const request of [
      { id: randomUUID(), namespace: '../../private', method: 'dispose' },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'eval',
        input: 'private',
      },
      {
        id: randomUUID(),
        namespace: browserNamespace('/synthetic/invalid'),
        method: 'act',
        threadId: '../outside',
        input: { action: 'snapshot' },
      },
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(fixture.socketPath);
        socket.on('error', reject);
        socket.on('close', resolve);
        socket.on('connect', () =>
          socket.write(JSON.stringify({ type: 'request', request }) + '\n'),
        );
      });
    }
    assert.equal(fixture.instances.size, 0);
    const computer = fixture.client('/synthetic/discard');
    await computer.act('task', { action: 'snapshot' });
    await assert.rejects(computer.discard!('../task'));
  } finally {
    await fixture.close();
  }
});

async function interruptedBrowser(fixture: Awaited<ReturnType<typeof harness>>, dataRoot: string) {
  const computer = fixture.client(dataRoot, { timeoutMs: 200, drainTimeoutMs: 20 });
  await computer.act('task', { action: 'snapshot' });
  const instance = fixture.instance(dataRoot);
  const entered = deferred();
  const release = deferred();
  instance.setAct(async () => {
    entered.resolve();
    await release.promise;
    return { text: 'Late', url: 'https://example.com' };
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(
    computer.act('task', { action: 'click', selector: '#submit' }, controller.signal),
    /did not finish safely/,
  );
  await entered.promise;
  controller.abort();
  await cancelled;
  return { computer, instance, release };
}

for (const method of ['open', 'bindProfile'] as const)
  test(`an explicit ${method} drains an uncertain namespace before opening a new session`, async () => {
    const fixture = await harness();
    const dataRoot = `/synthetic/recover-${method}`;
    const interrupted = await interruptedBrowser(fixture, dataRoot);
    try {
      const other = fixture.client('/synthetic/other-session');
      await other.act('task', { action: 'snapshot' });
      const otherInstance = fixture.instance('/synthetic/other-session');
      const { computer, instance, release } = interrupted;
      const launches = fixture.launches.length;
      await assert.rejects(computer.act('task', { action: 'open', url: 'x'.repeat(8193) }));
      for (const url of ['not-a-url', 'javascript:alert(1)', 'https://user:pass@example.com'])
        await assert.rejects(computer.act('task', { action: 'open', url }));
      await assert.rejects(computer.bindProfile!('task', 'invalid-profile'));
      await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
      await assert.rejects(
        computer.act('task', { action: 'click', selector: '#submit' }),
        /unavailable/,
      );
      assert.equal(fixture.launches.length, launches);
      let settled = false;
      const recovery = (
        method === 'open'
          ? computer.act('task', { action: 'open', url: 'https://example.com/reopened' })
          : computer.bindProfile!('task', randomUUID())
      ).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await delay(10);
      assert.equal(settled, false);
      release.resolve();
      assert.equal(await recovery, undefined);
      const restored = fixture.instance(dataRoot);
      assert.notEqual(restored, instance);
      assert.deepEqual(
        instance.calls.map(({ method }) => method),
        ['act', 'act', 'dispose'],
      );
      await computer.act('task', { action: 'snapshot' });
      await other.act('task', { action: 'snapshot' });
      assert.equal(fixture.instance('/synthetic/other-session'), otherInstance);
      assert.equal(
        otherInstance.calls.some(({ method }) => method === 'dispose'),
        false,
      );
    } finally {
      interrupted.release.resolve();
      await fixture.close();
    }
  });

// Login inspection and observation redaction

test('browser observations redact OAuth callback values, API credentials and signed URL query values', () => {
  const url = redactBrowserUrl(
    'https://example.com/callback?code=private-code&email=private-email&state=private-state&view=account#access_token=private-token',
    [],
  );
  assert.equal(url.includes('private-token'), false);
  assert.equal(
    redactBrowserUrl('https://example.com/callback#access%5Ftoken=private-encoded', []).includes(
      'private-encoded',
    ),
    false,
  );
  for (const [name, value] of [
    ['code', 'private-code'],
    ['email', 'private-email'],
    ['state', 'private-state'],
    ['view', 'account'],
  ])
    assert.equal(new URL(url).searchParams.get(name), value);
  for (const name of [
    'api_key',
    'X-API-Key',
    'client_secret',
    'signature',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Goog-Signature',
  ]) {
    const value = redactBrowserUrl(
      `https://example.com/download?${name}=synthetic-private-value&view=account`,
      [],
    );
    assert.equal(value.includes('synthetic-private-value'), false, name);
    assert.equal(new URL(value).searchParams.get('view'), 'account');
  }
  const secret = 'fixture secret/with+symbols';
  for (const value of [
    encodeURIComponent(secret),
    encodeURI(secret),
    new URLSearchParams({ value: secret }).toString().slice(6),
  ]) {
    assert.equal(redactBrowserText(value, [secret]), '[redacted]');
    assert.equal(
      redactBrowserUrl(`https://example.com/${value}?other=${value}`, [secret]).includes(value),
      false,
    );
  }
});

test('browser text redaction hides every encoded form of any secret in any surrounding text', () => {
  const visible = (text: string, secrets: string[]) =>
    redactBrowserText(text, secrets).split('[redacted]');
  const unit = fc.oneof(
    fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 1 }),
    fc.string({ unit: 'grapheme', minLength: 1, maxLength: 1 }),
  );
  const text = fc.string({ unit });
  fc.assert(
    fc.property(
      fc.array(fc.string({ unit, minLength: 1 }), { minLength: 1, maxLength: 3 }),
      fc.nat(),
      fc.constantFrom(
        (secret: string) => secret,
        (secret: string) => JSON.stringify(secret).slice(1, -1),
        encodeURIComponent,
        encodeURI,
        (secret: string) => new URLSearchParams({ value: secret }).toString().slice(6),
        (secret: string) =>
          encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()),
      ),
      text,
      text,
      (secrets, pick, encode, before, after) => {
        const shown = encode(secrets[pick % secrets.length]!);
        const parts = visible(`${before}${shown}${after}`, secrets);
        assert.equal(
          parts.some((part) => part.includes(shown)),
          false,
        );
      },
    ),
    { numRuns: 1000 },
  );
  fc.assert(
    fc.property(
      fc.stringMatching(/^\d{12,19}$/),
      fc.array(fc.stringMatching(/^[ ./-]{0,3}$/), { minLength: 18, maxLength: 18 }),
      text,
      text,
      (card, gaps, before, after) => {
        const shown = [...card]
          .map((digit, index) => (index ? gaps[index - 1] : '') + digit)
          .join('');
        const parts = visible(`${before}${shown}${after}`, [card]);
        assert.equal(
          parts.some((part) => part.includes(shown)),
          false,
        );
      },
    ),
  );
});

test('observations reject embedded HTTP credentials and redact credentials in other tabs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-url-credentials-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('url', { action: 'open', url: 'https://1.1.1.1/login' });
    const url = 'https://synthetic-user:synthetic-password@1.1.1.1/report';
    fixture.pages.get('url')!.location = new URL(url);
    await assert.rejects(computer.act('url', { action: 'snapshot' }));
    await assert.rejects(computer.currentPage('url'));
    const redacted = redactBrowserUrl(url, []);
    assert.equal(new URL(redacted).username, '');
    assert.equal(new URL(redacted).password, '');
    assert.equal(redacted.includes('synthetic-password'), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Pi can submit each staged sign-in step without exposing entered values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-staged-login-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const origin = 'https://1.1.1.1';
    const identifier = computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'identifier',
      username: 'synthetic-account@example.test',
      usernameSelector: '#account',
      submitSelector: 'button',
    });
    await assert.rejects(computer.screenshot('login'), /paused/);
    await identifier;
    await computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'password',
      password: 'synthetic-password',
      passwordSelector: '#account',
      submitSelector: 'button',
    });
    const challenge = fixture.pages.get('login')?.input;
    assert.ok(challenge);
    assert.equal(fixture.pages.get('login')?.stage, 'otp');
    await computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'otp',
      code: '739204',
      passwordSelector: '#account',
      submitSelector: 'button',
    });
    assert.deepEqual(fixture.pages.get('login')?.entered, [
      'synthetic-account@example.test',
      'synthetic-password',
      '739204',
    ]);
    assert.equal(fixture.pages.get('login')?.stage, 'complete');
    assert.equal(fixture.pages.get('login')?.entered.at(-1), '739204');
    const observation = await computer.act('login', { action: 'snapshot' });
    for (const secret of ['synthetic-password', '739204'])
      assert.equal(JSON.stringify(observation).includes(secret), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('visual browser actions fence the session when releasing the pointer fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-visual-release-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => {
      commands.push(String(command.action));
      if (command.action === 'mouseup') throw new DaemonCommandError();
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    await assert.rejects(computer.act('fixture', { action: 'click', x: 0.5, y: 0.25 }));
    assert.equal(commands.filter((action) => action === 'mousedown').length, 1);
    await assert.rejects(computer.act('fixture', { action: 'click', selector: '#account' }));
    assert.equal(commands.includes('click'), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native container browser stays responsive, streams live frames and refuses passkeys after heavy stderr output',
  {
    skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true' || process.platform !== 'linux',
    timeout: 30_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-stderr-native-'));
    const server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<button style="width:100vw;height:100vh" onclick="this.textContent=\'Accepted\'">Continue</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const computer = createAgentBrowserComputer({
      ...containerBrowserOptions(directory),
      privateNetwork: true,
    });
    let stderrPath: string | undefined;
    try {
      await computer.act('fixture', { action: 'open', url: `http://127.0.0.1:${address.port}` });
      assert.ok((await computer.screenshot('fixture'))?.length);
      for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        if (args.includes(`--user-data-dir=${directory}/`) && !args.includes('--type=')) {
          stderrPath = `/proc/${pid}/fd/2`;
          break;
        }
      }
      assert.ok(stderrPath);
      const writer = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], Buffer.alloc(1024 * 1024, 120));",
          stderrPath,
        ],
        { stdio: 'ignore', timeout: 1500, killSignal: 'SIGKILL' },
      );
      const exit = await new Promise<number | null>((resolve, reject) => {
        writer.once('error', reject);
        writer.once('exit', resolve);
      });
      assert.equal(
        exit,
        0,
        'Chromium stderr must not block when browser output exceeds pipe capacity',
      );
      await computer.control!('fixture', { type: 'mouse', event: 'down', x: 0.5, y: 0.5 });
      await computer.control!('fixture', { type: 'mouse', event: 'up', x: 0.5, y: 0.5 });
      const page = await computer.act('fixture', { action: 'snapshot' });
      assert.match(page.text, /Accepted/);
      const screenshot = await computer.screenshot('fixture');
      assert.ok(screenshot?.length);
      assert.equal(computer.screenStatus!('fixture').state, 'live');
      for await (const frame of computer.view!('fixture', new AbortController().signal)) {
        assert.deepEqual([...frame.subarray(0, 2)], [0xff, 0xd8]);
        break;
      }
      const passkey = await computer.act('fixture', {
        action: 'evaluate',
        script:
          "Object.getPrototypeOf(navigator.credentials).get.call(navigator.credentials, { publicKey: { challenge: new Uint8Array(32) } }).then(() => 'resolved', (error) => error.message)",
      });
      assert.match(passkey.text, /Passkeys are not available in this browser/);
    } finally {
      if (stderrPath) {
        const pipe = await open(stderrPath, constants.O_RDONLY | constants.O_NONBLOCK).catch(
          () => undefined,
        );
        if (pipe) {
          try {
            const buffer = Buffer.alloc(65536);
            for (let count = 0; count < 32; count++) {
              const read = await pipe.read(buffer).catch(() => ({ bytesRead: 0 }));
              if (!read.bytesRead) break;
            }
          } finally {
            await pipe.close();
          }
        }
      }
      await computer.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a native page that freezes its renderer is killed at the deadline and the browser reopens',
  {
    skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true' || process.platform !== 'linux',
    timeout: 60_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-frozen-native-'));
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        request.url === '/frozen'
          ? '<p>Bidding history</p><script>setTimeout(() => { for (;;) {} }, 300)</script>'
          : '<p>Bidding open</p>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const computer = createAgentBrowserComputer({
      ...containerBrowserOptions(directory),
      privateNetwork: true,
      daemonCommand: (path, command, signal, timeoutMs) =>
        existingDaemonCommand(path, command, signal, timeoutMs ?? 3_000),
    });
    const session = `AGENT_BROWSER_SESSION=${browserSessionId('frozen')}\0`;
    const browsers = async () => {
      const found: string[] = [];
      for (const pid of await readdir('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        const environ = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '');
        const args = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
        if (environ.includes(session) || args.includes(`--user-data-dir=${directory}/`))
          found.push(args.split('\0')[0]!);
      }
      return found;
    };
    try {
      await computer.act('frozen', { action: 'open', url: `${origin}/frozen` });
      assert.ok((await browsers()).length);
      await delay(1_000);
      const started = Date.now();
      await assert.rejects(computer.act('frozen', { action: 'snapshot' }));
      assert.ok(Date.now() - started < 20_000);
      assert.deepEqual(await browsers(), []);
      await computer.act('frozen', { action: 'open', url: origin });
      assert.match((await computer.act('frozen', { action: 'snapshot' })).text, /Bidding open/);
    } finally {
      await computer.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'native handoff clicks stay aligned through page zoom, panning and viewport changes',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 60_000 },
  async () => {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const context = createCanvas(1, 1).getContext('2d');
    const directory = await mkdtemp(join(tmpdir(), 'nod-pointer-native-'));
    const server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden}button{position:fixed;left:10%;top:10%;width:10%;height:10%}</style>
        <button id="target">Target</button><output></output><script>
        document.addEventListener('mousedown',event=>window.lastPointer={target:event.target.id,x:event.clientX,y:event.clientY});
        let frame=0;function paint(){document.querySelector('output').textContent=String(frame++);requestAnimationFrame(paint)}paint();
        </script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    let socketPath = '';
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeoutMs) => {
        socketPath = path;
        return existingDaemonCommand(path, command, signal, timeoutMs);
      },
    });
    let inspector: WebSocket | undefined;
    try {
      await computer.act('pointer', { action: 'open', url: `http://127.0.0.1:${address.port}` });
      const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
      const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
      const tab = (tabs.tabs as Array<{ active: boolean; targetId: string }>).find(
        (tab) => tab.active,
      )!;
      inspector = new WebSocket(String(connection.cdpUrl));
      await once(inspector, 'open');
      let sequence = 0;
      const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const id = ++sequence;
          const receive = (event: MessageEvent) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== id) return;
            inspector!.removeEventListener('message', receive);
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          };
          inspector!.addEventListener('message', receive);
          inspector!.send(
            JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
          );
        });
      const { sessionId } = await send('Target.attachToTarget', {
        targetId: tab.targetId,
        flatten: true,
      });
      const page = (method: string, params: Record<string, unknown>) =>
        send(method, params, String(sessionId));
      for (const [index, sample] of [
        { width: 1440, height: 900, dpr: 1, zoom: 1, pan: false },
        { width: 1440, height: 900, dpr: 2, zoom: 1, pan: false },
        { width: 1440, height: 900, dpr: 1, zoom: 2, pan: false },
        { width: 1440, height: 900, dpr: 1, zoom: 2, pan: true },
        { width: 800, height: 1200, dpr: 1, zoom: 1, pan: false },
      ].entries()) {
        const color = [1, 2, 4].map((bit) => ((index + 1) & bit ? 255 : 0));
        await existingDaemonCommand(socketPath, {
          action: 'viewport',
          width: sample.width,
          height: sample.height,
          deviceScaleFactor: sample.dpr,
        });
        await page('Emulation.setPageScaleFactor', { pageScaleFactor: sample.zoom });
        if (sample.pan)
          await page('Input.synthesizeScrollGesture', {
            x: 400,
            y: 300,
            xDistance: -60,
            yDistance: -60,
            gestureSourceType: 'touch',
          });
        const expected = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {document.documentElement.style.backgroundColor='rgb(${color.join(',')})';const r=document.querySelector('#target').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:visualViewport.width,height:visualViewport.height,left:visualViewport.offsetLeft,top:visualViewport.offsetTop}})()`,
        });
        const point = expected.result as {
          x: number;
          y: number;
          width: number;
          height: number;
          left: number;
          top: number;
        };
        const controller = new AbortController();
        const frames = computer.view!('pointer', controller.signal)[Symbol.asyncIterator]();
        try {
          for (;;) {
            const frame = await frames.next();
            assert.equal(frame.done, false);
            const image = await loadImage(frame.value!);
            context.drawImage(image, 1 - image.width, 1 - image.height);
            const pixel = context.getImageData(0, 0, 1, 1).data;
            if (color.every((channel, index) => channel === (pixel[index]! > 127 ? 255 : 0))) break;
          }
          const position = {
            x: (point.x - point.left) / point.width,
            y: (point.y - point.top) / point.height,
          };
          await computer.control!('pointer', { type: 'mouse', event: 'down', ...position });
          await computer.control!('pointer', { type: 'mouse', event: 'up', ...position });
          const observed = await existingDaemonCommand(socketPath, {
            action: 'evaluate',
            script: 'window.lastPointer',
          });
          assert.deepEqual(
            observed.result,
            { target: 'target', x: point.x, y: point.y },
            JSON.stringify(sample),
          );
        } finally {
          controller.abort();
          await frames.return?.();
        }
      }
    } finally {
      inspector?.close();
      await computer.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'native visual browser actions solve a canvas interaction inside nested cross-origin frames',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-visual-native-'));
    let frameOrigin = '';
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        request.url === '/inner'
          ? `<body style="margin:0"><canvas width="300" height="180" tabindex="0"></canvas><script>
          const canvas = document.querySelector('canvas');
          const context = canvas.getContext('2d');
          context.fillStyle = '#2475cc'; context.fillRect(0, 0, 80, 80);
          context.fillStyle = '#e04a4a'; context.fillRect(200, 0, 80, 80);
          context.fillStyle = '#35a763'; context.fillRect(0, 100, 280, 60);
          const state = { selected: false, dragged: false, held: false, keys: [] };
          let start, moved;
          const send = () => top.postMessage(state, '*');
          canvas.onpointerdown = event => {
            if (!event.isTrusted) return;
            canvas.focus(); canvas.setPointerCapture(event.pointerId);
            start = { x: event.offsetX, y: event.offsetY, time: performance.now() }; moved = false;
          };
          canvas.onpointermove = event => {
            if (event.isTrusted && event.buttons === 1 && event.offsetX > 200) moved = true;
          };
          canvas.onpointerup = event => {
            if (!event.isTrusted || !start) return;
            if (start.x < 80 && start.y < 80 && event.offsetX < 80) state.selected = true;
            if (start.x < 80 && start.y > 100 && moved && event.offsetX > 200) state.dragged = true;
            if (start.x > 200 && start.y < 80 && performance.now() - start.time >= 80) state.held = true;
            start = null; send();
          };
          canvas.onkeydown = event => { if (event.isTrusted) { state.keys.push(event.key); send(); } };
          </script>`
          : request.url === '/outer'
            ? '<body style="margin:0"><iframe src="/inner" style="position:absolute;left:20px;top:30px;width:300px;height:180px;border:0"></iframe>'
            : `<body><p>Select blue, drag across green, hold red, then use the arrow keys and space.</p>
            <output id="result"></output>
            <iframe src="${frameOrigin}/outer" style="position:absolute;left:30px;top:60px;width:360px;height:240px;border:0"></iframe>
            <script>addEventListener('message', event => { document.querySelector('output').textContent = JSON.stringify(event.data); });</script>`,
      );
    });
    const frames = createHttpServer(
      server.listeners('request')[0] as Parameters<typeof createHttpServer>[0],
    );
    const origin = async (value: typeof server) => {
      await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
      const address = value.address();
      assert.ok(address && typeof address !== 'string');
      return `http://127.0.0.1:${address.port}`;
    };
    frameOrigin = await origin(frames);
    const pageOrigin = await origin(server);
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    const worker = await workerFixture(() => computer, 30_000);
    const act = async (input: BrowserAction) =>
      result(await worker.request({ method: 'act', threadId: 'fixture', input })) as {
        text: string;
      };
    try {
      await act({ action: 'open', url: pageOrigin, waitMs: 100 });
      const screen = result(await worker.request({ method: 'screenshot', threadId: 'fixture' }));
      assert.equal(typeof screen, 'string');
      const png = Buffer.from(screen as string, 'base64');
      assert.equal(png.toString('hex', 0, 8), '89504e470d0a1a0a');
      const point = (x: number, y: number) => ({
        x: x / png.readUInt32BE(16),
        y: y / png.readUInt32BE(20),
      });
      await act({ action: 'click', ...point(90, 130) });
      await act({
        action: 'drag',
        points: [point(90, 220), point(190, 220), point(300, 220)],
        durationMs: 100,
      });
      await act({ action: 'click', ...point(300, 130), durationMs: 120 });
      for (const key of ['ArrowLeft', 'ArrowRight', 'Space'] as const)
        await act({ action: 'press', key });
      const observation = await act({
        action: 'evaluate',
        script: `new Promise(resolve => {
          const read = () => {
            const state = JSON.parse(document.querySelector('#result').textContent || 'null');
            if (state?.keys.length >= 3) {
              removeEventListener('message', read);
              resolve(state);
            }
          };
          addEventListener('message', read);
          read();
        })`,
      });
      assert.deepEqual(JSON.parse(observation.text.slice(observation.text.indexOf('\n') + 1)), {
        selected: true,
        dragged: true,
        held: true,
        keys: ['ArrowLeft', 'ArrowRight', ' '],
      });
    } finally {
      await worker.close();
      await Promise.all(
        [server, frames].map(async (value) => {
          value.closeAllConnections();
          await new Promise<void>((resolve) => value.close(() => resolve()));
        }),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('a password typed through the handoff in several pauses hides only the finished value', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-handoff-secret-'));
  const fixture = stagedLoginBrowser();
  const secret = 'Sign-handoff-password';
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    fixture.pages.get('fixture')!.stage = 'password';
    fixture.pages.get('fixture')!.render();
    await computer.act('fixture', { action: 'click', selector: '#account' });
    await computer.control!('fixture', { type: 'text', text: 'Sign' });
    await computer.control!('fixture', { type: 'text', text: secret.slice(4) });
    assert.equal(fixture.pages.get('fixture')!.input.value, secret);
    for (const observation of [
      await computer.act('fixture', { action: 'snapshot' }),
      await computer.act('fixture', {
        action: 'evaluate',
        script: "document.querySelector('#account').value",
      }),
    ])
      assert.equal(JSON.stringify(observation).includes(secret), false);
    assert.match((await computer.act('fixture', { action: 'snapshot' })).text, /Sign in password/);
    await computer.act('fixture', { action: 'fill', selector: '#search', text: 'Sign' });
    const page = fixture.pages.get('fixture')!;
    const other = page.dom.window.document.createElement('input');
    other.type = 'password';
    page.dom.window.document.body.append(other);
    other.focus();
    await computer.control!('fixture', { type: 'text', text: `${secret}2` });
    const first = await computer.act('fixture', {
      action: 'evaluate',
      script: "document.querySelector('#account').value",
    });
    assert.equal(JSON.stringify(first).includes(secret), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('secure entry never sends a credential to a page on another origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-login-origin-'));
  const fixture = stagedLoginBrowser();
  const secret = 'synthetic-origin-secret';
  let exposed = 0;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => {
      if (
        fixture.pages.get('fixture')?.location.origin === 'https://8.8.8.8' &&
        JSON.stringify(command).includes(secret)
      )
        exposed++;
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const page = fixture.pages.get('fixture')!;
    const input = {
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      kind: 'identifier' as const,
      username: secret,
      usernameSelector: '#account',
      submitSelector: 'button',
    };
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await assert.rejects(computer.injectCredentials(input), /not on the website for this login/);
    assert.equal(exposed, 0);
    assert.equal(page.input.value, '');
    page.location = { origin: 'https://1.1.1.1', href: 'https://1.1.1.1/login' };
    await computer.injectCredentials(input);
    assert.equal(page.entered.at(-1), secret);
    page.render();
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await computer.act('fixture', { action: 'snapshot' });
    assert.equal(exposed, 0);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native secure entry completes single and split OTP controls without maxlength hints',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-code-native-'));
    const code = '072846';
    const received: string[] = [];
    const server = createHttpServer(async (request, response) => {
      if (request.method === 'POST') {
        let body = '';
        for await (const part of request) body += part.toString();
        received.push(new URLSearchParams(body).getAll('code').join(''));
        if (new URLSearchParams(body).getAll('code').join('') !== code) {
          response.writeHead(400);
          response.end('Invalid code');
          return;
        }
        response.writeHead(303, { location: '/done' });
        response.end();
        return;
      }
      if (request.url === '/done') {
        response.end('<h1>Verified</h1>');
        return;
      }
      const retained = request.url === '/retained';
      const closed = request.url === '/closed';
      const automatic = request.url === '/automatic';
      const split = request.url === '/split' || retained || closed;
      response.setHeader('content-type', 'text/html');
      response.end(`<form action="/verify" method="post">
        ${Array.from({ length: split ? code.length : 1 }, (_, index) => `<input name="code" autocomplete="one-time-code" inputmode="numeric" aria-label="Code ${index + 1}">`).join('')}
        ${automatic ? '' : '<button type="submit" onclick="if (!event.isTrusted) event.preventDefault()" disabled>Verify</button>'}<h1></h1>
        </form><script>
        const fields = [...document.querySelectorAll('input')];
        globalThis.fields = fields;
        const button = document.querySelector('button');
        for (const [index, field] of fields.entries()) field.addEventListener('input', event => {
          if (!event.isTrusted) return;
          if (fields.length > 1 && field.value) {
            field.value = field.value.slice(-1);
            fields[index + 1]?.focus();
          }
          if (button) button.disabled = fields.map(field => field.value).join('') !== ${JSON.stringify(code)};
          ${automatic ? `if (field.value === ${JSON.stringify(code)}) field.form.requestSubmit();` : ''}
        });
        ${retained || closed || automatic ? "document.querySelector('form').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget; await fetch('/verify', { method: 'POST', body: new URLSearchParams(new FormData(form)) }); form.querySelector('h1').textContent = 'Verified'; };" : ''}
        ${closed ? "const form = document.querySelector('form'); const host = document.createElement('code-panel'); form.replaceWith(host); host.attachShadow({mode:'closed'}).append(form);" : ''}
        </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    const worker = await harness({ computer });
    const client = worker.client(directory, { timeoutMs: 30_000 });
    const act = (input: BrowserAction) => client.act('fixture', input);
    try {
      for (const path of ['/single', '/split', '/retained', '/closed', '/automatic']) {
        const count = received.length;
        await act({ action: 'open', url: origin + path });
        const shape = await act({
          action: 'evaluate',
          script: 'globalThis.fields.map(field => field.maxLength)',
        });
        assert.deepEqual(
          JSON.parse(shape.text.slice(shape.text.indexOf('\n') + 1)),
          Array(path === '/single' || path === '/automatic' ? 1 : 6).fill(-1),
        );
        await act({ action: 'reload' });
        const initial = (await act({ action: 'snapshot' })).text;
        const held = /"Code 1"[^\n]*ref=(e\d+)/.exec(initial)?.[1];
        assert.ok(held);
        const codeRefs = Array.from(
          initial.matchAll(/"Code \d+"[^\n]*ref=(e\d+)/g),
          (match) => `@${match[1]}`,
        );
        if (path === '/closed')
          for (const fields of [codeRefs.slice(1), codeRefs.map(() => codeRefs[0]!)]) {
            await assert.rejects(
              client.injectCredentials({
                threadId: 'fixture',
                origin,
                kind: 'otp',
                code,
                passwordSelector: fields,
              }),
            );
            assert.equal(received.length, count);
            assert.doesNotMatch((await act({ action: 'snapshot' })).text, /:\s*\d/);
          }
        const injected = await client.injectCredentials({
          threadId: 'fixture',
          origin,
          kind: 'otp',
          code,
          passwordSelector: path === '/closed' ? codeRefs : 'input[autocomplete="one-time-code"]',
          submitSelector:
            path === '/closed'
              ? `@${/button "Verify"[^\n]*ref=(e\d+)/.exec(initial)?.[1]}`
              : path === '/automatic'
                ? undefined
                : 'button',
        });
        assert.deepEqual(injected, { status: 'submitted' });
        let accepted: string;
        if (path === '/closed') {
          const deadline = Date.now() + 5_000;
          do accepted = (await act({ action: 'snapshot' })).text;
          while (!accepted.includes('Verified') && Date.now() < deadline);
        } else {
          await act(
            path === '/retained' || path === '/automatic'
              ? { action: 'wait', text: 'Verified' }
              : { action: 'wait', url: '**/done' },
          );
          accepted = (await act({ action: 'snapshot' })).text;
        }
        assert.equal(received.length, count + 1);
        assert.equal(received.at(-1), code);
        assert.match(accepted, /Verified/);
        assert.equal(accepted.includes(code), false);
        if (path === '/retained' || path === '/closed' || path === '/automatic') {
          assert.doesNotMatch(accepted, /\[ref=e\d+\]:\s*\d/);
          await act({ action: 'click', selector: `@${held}` });
          assert.match((await act({ action: 'snapshot' })).text, /Verified/);
          await assert.rejects(
            act({
              action: 'evaluate',
              script: 'globalThis.fields.map(node => node.value)',
            }),
            (error: unknown) =>
              error instanceof BrowserActionError && error.code === 'browser_script_paused',
          );
          assert.ok(await client.screenshot('fixture'));
          continue;
        }
        await act({ action: 'back' });
        const restored = await act({
          action: 'evaluate',
          script: 'btoa([...document.querySelectorAll("input")].map(node => node.value).join(""))',
        });
        assert.equal(restored.text.includes(Buffer.from(code).toString('base64')), false);
      }
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('the owner time zone and region reach a new browser launch without injecting browser flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-browser-locale-'));
  const fixture = stagedLoginBrowser();
  const launches: Array<{ flags: string; zone?: string }> = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: (executable, args, options) => {
      if (args.includes('open'))
        launches.push({ flags: args[args.indexOf('--args') + 1], zone: options?.env?.TZ });
      return fixture.run(executable, args, options);
    },
  });
  const open = (timeZone: string, locale: string) =>
    computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
      timeZone,
      locale,
    });
  try {
    await open('Europe/Madrid', 'en-GB');
    await computer.close('fixture');
    await open('Europe/Madrid,--remote-debugging-port=9222', 'en-GB,--remote-debugging-port=9222');
    assert.equal(launches.length, 2);
    assert.equal(launches[0].zone, 'Europe/Madrid');
    assert.match(launches[0].flags, /,--accept-lang=en-GB(,|$)/);
    assert.equal(launches[1].zone, undefined);
    assert.equal(launches[1].flags.includes('remote-debugging'), false);
    assert.equal(launches[1].flags.includes('accept-lang'), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a restarted credential session serves only its cached masked image without reading the page', async () => {
  const directory = await mkdtemp('/tmp/sk-sensitive-screen-');
  const fixture = stagedLoginBrowser();
  let checkedBeforeEntry = false;
  const original = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: async (command) => {
      if (command.action !== 'focus' || checkedBeforeEntry) return;
      checkedBeforeEntry = true;
      const stored = JSON.parse(
        await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8'),
      );
      assert.equal(stored.sensitive, true);
      await assert.rejects(restored.currentPage('fixture'), /Open the login page/);
      assert.equal(commands, 0);
    },
  });
  let commands = 0;
  const restored = createBrowserFixture({
    dataRoot: directory,
    run: async () => {
      commands += 1;
      throw new Error('No daemon command should run for a recovered sensitive screen.');
    },
  });
  try {
    await original.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    await original.injectCredentials({
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic-secret@example.test',
      usernameSelector: '#account',
    });
    const masked = await original.screenshot('fixture');
    assert.equal(checkedBeforeEntry, true);
    assert.deepEqual(await restored.screenshot('fixture'), masked);
    assert.equal(restored.screenStatus?.('fixture').state, 'last_known');
    assert.equal(commands, 0);
    await assert.rejects(restored.currentPage('fixture'), /Open the login page/);
    const metadata = await readFile(join(directory, 'runtime/screen-fixture.json'), 'utf8');
    assert.equal(metadata.includes('synthetic-secret'), false);
  } finally {
    await original.dispose();
    await restored.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('redaction masks nested credentials, headers and encoded JSON before persistence', () => {
  const secret = 'fixture-provider-secret-with/slash';
  const padded = ` \t${secret}\r\n`;
  const paddedShort = '  short  ';
  const secrets = [padded, paddedShort];
  const redact = createRedactor(secrets);
  const redactError = createErrorRedactor(secrets);
  for (const value of [padded, secret, encodeURIComponent(padded), encodeURIComponent(secret)])
    assert.equal(redactError(`Provider failed for ${value}`), 'Provider failed for [redacted]');
  assert.equal(redact('short remains useful'), 'short remains useful');
  assert.equal(redact(`Padded value:${paddedShort}`), 'Padded value:[redacted]');
  const input = {
    query: 'messages after yesterday',
    password: 'private-password',
    customHeaders: { 'X-API-Key': 'custom-api-secret' },
    headers: [{ name: 'Authorization', value: 'header-private' }, ['Cookie', 'session-private']],
    result: JSON.stringify({
      password: 'nested-password',
      cookie: 'nested-cookie',
      nested: { api_key: 'nested-api-key' },
      title: 'Useful result',
    }),
    url: `https://example.com?key=${encodeURIComponent(secret)}&q=hello`,
    text: `An opaque value: ${secret}. Another one: ${encodeURIComponent(secret)}.`,
    otp: '834192',
    card_number: '4111111111111111',
    credentials: { username: 'private-login', password: 'private-pass' },
  };
  const encoded = JSON.stringify(redact(input));
  for (const value of [
    secret,
    encodeURIComponent(secret),
    'private-password',
    'header-private',
    'session-private',
    'nested-password',
    'nested-cookie',
    'nested-api-key',
    '834192',
    '4111111111111111',
    'private-login',
    'custom-api-secret',
  ])
    assert.ok(!encoded.includes(value), value);
  assert.ok(encoded.includes('Useful result'));
  assert.ok(encoded.includes('messages after yesterday'));
  assert.ok(encoded.includes('q=hello'));
  secrets.push(' \tfixture-rotated-opaque-token\n');
  const rotated = String(redact('fixture-rotated-opaque-token and ' + secret));
  assert.ok(!rotated.includes('fixture-rotated-opaque-token'));
  assert.ok(!rotated.includes(secret));
});

test('redaction masks secure links, common token strings and secret assignments in tool text', () => {
  const redact = createRedactor();
  const values = [
    'opaque-form-token',
    'opaque-approval-id',
    'oauth-code-value',
    'oauth-state-value',
    'account-password',
    'cookie-value',
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'eyJabc.eyJdef.signature-value',
    'BEGIN PRIVATE KEY',
    'nonstandard-auth-secret',
  ];
  const result = redact([
    'Open http://localhost:4310/credentials/opaque-form-token?x=2 or /approvals/opaque-approval-id',
    'https://example.com?code=oauth-code-value&state=oauth-state-value&safe=true',
    'https://user:account-password@example.com/',
    'Cookie: cookie-value',
    'Authorization: Token nonstandard-auth-secret',
    'sk-proj-abcdefghijklmnopqrstuvwxyz eyJabc.eyJdef.signature-value',
    '-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY-----',
  ]);
  for (const value of values) assert.ok(!JSON.stringify(result).includes(value), value);
  assert.ok(JSON.stringify(result).includes('safe=true'));
  assert.equal(
    redact('Open /vault/private-bearer-token for login'),
    'Open /vault/[redacted] for login',
  );
});

test('Telegram chat cards require paired owned metadata and preserve ordinary links', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid',
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
      for (const name of ['Node', 'Element', 'HTMLElement', 'Event', 'MouseEvent', 'MutationObserver']) globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      const requests = [];
      fetch = (url, options) => new Promise((resolve) => requests.push({url, options, resolve}));
      const { createElement: h, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { MessageText } = await import('./src/web/components/message.tsx');
      const { setRequestAccount } = await import('./src/web/lib/api.ts');
      setRequestAccount('synthetic-owner');
      const root = createRoot(document.getElementById('root'));
      let key = 0;
      const owned = 'https://t.me/nod_owned_bot';
      const paired = { ready: true, channels: [{provider:'telegram', enabled:true, accountHandle:'@nod_owned_bot', allowedUserId:'123', mode:'polling'}] };
      const render = async (text, replace = true) => {
        if (replace) key++;
        await act(async () => root.render(h('div', {key}, ...(Array.isArray(text) ? text : [text]).map((text, index) => h(MessageText, {key:index, text})))));
      };
      const respond = async (request, data, status=200) => {
        assert.equal(request.url, '/api/channel-settings');
        await act(async () => request.resolve(new Response(JSON.stringify(data), {status, headers:{'content-type':'application/json'}})));
      };
      await render('[Ordinary](https://example.com)');
      assert.equal(requests.length, 0);
      const links = [owned, 'https://t.me/another_bot', owned+'?start=synthetic-pairing', owned+'#fragment', owned+'/', 'http://t.me/nod_owned_bot', 'https://t.me:443/nod_owned_bot', 'https://t.me.evil.invalid/nod_owned_bot'];
      await render(links.map((href,i) => '[Link '+i+']('+href+')').join('\n\n'));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].options.headers.get('X-nod-Account'), 'synthetic-owner');
      assert.equal(document.querySelector('[data-setup="telegram"]'), null);
      await respond(requests[0], paired);
      const card = document.querySelector('[data-setup="telegram"]');
      assert.ok(card);
      assert.equal(document.querySelectorAll('[data-setup="telegram"]').length, 1);
      assert.equal(card.getAttribute('href'), owned);
      assert.equal(card.getAttribute('target'), '_blank');
      assert.equal(card.getAttribute('rel'), 'noopener noreferrer');
      assert.equal(card.getAttribute('referrerpolicy'), 'no-referrer');
      assert.deepEqual([...document.querySelectorAll('a')].map(a => a.getAttribute('href')), links);
      for (const type of ['click','contextmenu']) {
        const event = new MouseEvent(type, {bubbles:true,cancelable:true,ctrlKey:true});
        card.addEventListener(type, e => {assert.equal(e.defaultPrevented, false);e.preventDefault();}, {once:true});
        card.dispatchEvent(event);
      }
      card.focus();
      const beforeRefresh = requests.length;
      await act(async () => window.dispatchEvent(new Event('focus')));
      assert.equal(requests.length, beforeRefresh + 1);
      assert.equal(document.querySelector('[data-setup="telegram"]'), card);
      assert.equal(document.activeElement, card);
      await respond(requests.at(-1), {ready:true,channels:[]});
      assert.equal(document.querySelector('[data-setup="telegram"]'), null);
      for (const override of [{enabled:false},{allowedUserId:undefined},{webhookStatus:'registration_pending'},{pairingExpiresAt:'2099-01-01T00:00:00Z'},{accountHandle:'@another_bot'}]) {
        await render('[Open]('+owned+')');
        await respond(requests.at(-1), {ready:true,channels:[{...paired.channels[0],...override}]});
        assert.equal(document.querySelector('[data-setup="telegram"]'), null);
      }
      await render('[Open]('+owned+')');
      await respond(requests.at(-1), {error:'unavailable'}, 503);
      assert.equal(document.querySelector('[data-setup="telegram"]'), null);
      const beforeShared = requests.length;
      await render(Array(3).fill('[Open]('+owned+')'));
      assert.equal(requests.length, beforeShared + 1);
      await respond(requests.at(-1), paired);
      const cards = [...document.querySelectorAll('[data-setup="telegram"]')];
      assert.equal(cards.length, 3);
      await render(Array(4).fill('[Open]('+owned+')'), false);
      assert.equal(requests.length, beforeShared + 1);
      assert.equal(document.querySelectorAll('[data-setup="telegram"]').length, 4);
      await act(async () => window.dispatchEvent(new Event('focus')));
      assert.equal(requests.length, beforeShared + 2);
      const replaced = requests.at(-1);
      await act(async () => window.dispatchEvent(new Event('popstate')));
      assert.equal(requests.length, beforeShared + 3);
      assert.equal(replaced.options.signal.aborted, true);
      assert.deepEqual([...document.querySelectorAll('[data-setup="telegram"]')].slice(0,3), cards);
      await respond(replaced, {ready:true,channels:[]});
      assert.equal(document.querySelectorAll('[data-setup="telegram"]').length, 4);
      await respond(requests.at(-1), {error:'unavailable'}, 503);
      assert.equal(document.querySelectorAll('[data-setup="telegram"]').length, 4);
      await act(async () => window.dispatchEvent(new Event('focus')));
      const old = requests.at(-1);
      setRequestAccount('second-synthetic-owner');
      await render('[Open]('+owned+')');
      const current = requests.at(-1);
      assert.equal(old.options.signal.aborted, true);
      assert.equal(current.options.headers.get('X-nod-Account'), 'second-synthetic-owner');
      await respond(old, paired);
      assert.equal(document.querySelector('[data-setup="telegram"]'), null);
      await respond(current, {ready:true,channels:[]});
      await act(async () => window.dispatchEvent(new Event('popstate')));
      const unfinished = requests.at(-1);
      await act(async () => root.unmount());
      assert.equal(unfinished.options.signal.aborted, true);
      const count = requests.length;
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('popstate'));
      assert.equal(requests.length, count);
      dom.window.close();
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('composer uploads preserve retry bytes, cancellation, previews and failed-send recovery', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid',
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of [
        'Node',
        'Element',
        'HTMLElement',
        'HTMLInputElement',
        'HTMLButtonElement',
        'MutationObserver',
        'Event',
        'KeyboardEvent',
        'CustomEvent',
        'DOMParser',
      ])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = () => [];
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [];
      const created = [],
        revoked = [],
        requests = [],
        opened = [],
        sends = [];
      URL.createObjectURL = (file) => {
        const url = 'blob:synthetic-' + created.length;
        created.push({ file, url });
        return url;
      };
      URL.revokeObjectURL = (url) => revoked.push(url);
      fetch = (url, options) =>
        new Promise((resolve, reject) => {
          assert.equal(url, '/api/uploads');
          assert.equal(options.headers.get('X-nod-Account'), 'synthetic-owner');
          const request = { url, options, resolve, reject };
          requests.push(request);
          options.signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      const { createElement, useState, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Composer } = await import('./src/web/components/composer.tsx');
      const { ArtifactDrawerContext } = await import('./src/web/components/artifact-context.tsx');
      const { setRequestAccount } = await import('./src/web/lib/api.ts');
      setRequestAccount('synthetic-owner');
      let drafts = [],
        result = { sent: false, restoreText: true };
      const setDrafts = (value) => {
        drafts = value;
      };
      function Fixture() {
        const [text, setText] = useState('Synthetic review request');
        return createElement(
          ArtifactDrawerContext.Provider,
          { value: { selectedId: null, open: (...args) => opened.push(args), setDrafts } },
          createElement(Composer, {
            ready: true,
            text,
            setText,
            replyTo: null,
            clearReply() {},
            onSend: async (text, attachments) => {
              sends.push({ text, attachments });
              return result;
            },
          }),
        );
      }
      const root = createRoot(document.getElementById('root'));
      const settle = async (check) => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        assert.ok(check(), 'Expected operation to settle');
      };
      const click = async (label) => {
        const button = document.querySelector('[aria-label="' + label + '"]');
        assert.ok(button, label);
        await act(async () => button.click());
      };
      const choose = async (files) => {
        const input = document.querySelector('input[type="file"]');
        Object.defineProperty(input, 'files', { configurable: true, value: files });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      };
      const submit = async () => {
        await act(async () =>
          document
            .querySelector('form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
      };
      const artifact = {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Review.txt',
        mimeType: 'text/plain',
        size: 21,
        url: '/api/artifacts/00000000-0000-4000-8000-000000000001',
      };
      let closed = false;
      try {
        await act(async () => root.render(createElement(Fixture)));
        await settle(() => document.querySelector('[contenteditable]'));
        const first = new File(['Synthetic review file'], 'Review.txt', { type: 'text/plain' });
        const second = new File(['Queued file'], 'Queued.txt', { type: 'text/plain' });
        await choose([first, second]);
        await settle(() => requests.length === 1);
        assert.equal(drafts.length, 2);
        assert.equal(drafts[0].downloadUrl, undefined);
        assert.ok(document.querySelector('[aria-label="Send message"]').disabled);
        await click('Open Review.txt');
        assert.equal(opened[0][2], 'drafts');
        assert.equal(opened[0][0], drafts[0].id);
        await click('Remove Queued.txt');
        assert.equal(revoked.filter((url) => url === created[1].url).length, 1);
        await act(async () =>
          requests[0].resolve(Response.json({ error: 'Synthetic upload failure' }, { status: 503 })),
        );
        await settle(() => document.querySelector('[aria-label="Retry uploading Review.txt"]'));
        assert.equal(drafts.length, 1);
        assert.equal(drafts[0].url, created[0].url);
        assert.equal(requests.length, 1);
        await submit();
        assert.equal(sends.length, 0);
        await click('Retry uploading Review.txt');
        await settle(() => requests.length === 2);
        assert.equal(created.length, 2);
        for (const request of requests) {
          const file = request.options.body.get('file');
          assert.equal(file.name, first.name);
          assert.equal(file.type, first.type);
          assert.equal(await file.text(), await first.text());
        }
        await act(async () => requests[1].resolve(Response.json(artifact)));
        await settle(() => drafts[0]?.downloadUrl === artifact.url);
        assert.equal(document.querySelector('[aria-label="Send message"]').disabled, false);
        await submit();
        await settle(
          () =>
            drafts.length === 1 &&
            document.querySelector('[contenteditable]').textContent.includes('Synthetic review request'),
        );
        assert.deepEqual(sends[0].attachments, [artifact]);
        assert.equal(revoked.includes(created[0].url), false);
        result = { sent: true };
        await submit();
        await settle(() => drafts.length === 0);
        assert.deepEqual(sends[1], sends[0]);
        assert.equal(revoked.filter((url) => url === created[0].url).length, 1);
        const unsafe = [
          new File(['<h1>fixture</h1>'], 'Page.html', { type: 'text/html' }),
          new File(['<svg/>'], 'Icon.svg', { type: 'image/svg+xml' }),
          new File(['<fixture/>'], 'Data.xml', { type: 'application/xml' }),
        ];
        await choose(unsafe);
        await settle(() => requests.length === 3);
        assert.equal(created.length, 2);
        assert.equal(drafts.length, 0);
        for (const file of [...unsafe].reverse()) await click('Remove ' + file.name);
        await settle(() => requests[2].options.signal.aborted);
        assert.equal(requests.length, 3);
        const finalFiles = [
          new File(['Active'], 'Active.txt', { type: 'text/plain' }),
          new File(['Waiting'], 'Waiting.txt', { type: 'text/plain' }),
        ];
        await choose(finalFiles);
        await settle(() => requests.length === 4);
        await act(async () => root.unmount());
        closed = true;
        assert.equal(requests[3].options.signal.aborted, true);
        assert.equal(requests.length, 4);
        assert.equal(drafts.length, 0);
        assert.deepEqual([...new Set(revoked)].sort(), created.map((item) => item.url).sort());
        for (const item of created) assert.equal(revoked.filter((url) => url === item.url).length, 1);

      } finally {
        if (!closed) await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('automatic feedback captures exclude remote handoffs and unsent editable content without changing the page', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 15_000,
    input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<main>Sent synthetic conversation</main>', { url: 'http://localhost', pretendToBeVisual: true });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        ...Object.fromEntries(['Node', 'Element', 'HTMLElement', 'HTMLImageElement', 'HTMLCanvasElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'CSSRule', 'XMLSerializer'].map(name => [name, dom.window[name]])),
      });
      let images = 0;
      let native = 0;
      globalThis.Image = class {
        set src(value) { if (value) { images++; queueMicrotask(() => this.onload?.()); } }
      };
      dom.window.HTMLCanvasElement.prototype.getContext = () => ({ fillRect() {}, drawImage() {} });
      dom.window.HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new Blob(['synthetic-safe-raster'], { type: 'image/jpeg' })); };
      const { captureFeedbackScreenshot } = await import('./src/web/lib/feedback-capture.ts');
      const safe = '<main>Sent synthetic conversation</main><div contenteditable="true"><p><br></p></div><input><textarea></textarea><input type="checkbox" checked><input type="hidden" value="synthetic-hidden-metadata">';
      const privateViews = [
        ['collapsed handoff', '<div class="browser-handoff"><img src="synthetic-private-page.png"></div>'],
        ['input draft', '<input value="Synthetic unsent private input">'],
        ['textarea draft', '<textarea>Synthetic unsent private textarea</textarea>'],
        ['rich chat draft', '<div contenteditable="true"><p>Synthetic <strong>unsent chat</strong></p></div>'],
        ['plain chat draft', '<div contenteditable="plaintext-only">Synthetic unsent plain chat</div>'],
        ['pending upload', '<div class="pending-attachments">Synthetic private attachment</div>'],
        ['credential form', '<form><input type="password" name="password"></form>'],
      ];
      const leaked = [];
      try {
        for (const mode of ['web', 'native']) {
          window.nodDesktop = mode === 'native' ? { captureFeedbackScreenshot: async () => { native++; return new Uint8Array([1, 2, 3]); } } : undefined;
          for (const [name, markup] of privateViews) {
            document.body.innerHTML = markup;
            if (name === 'input draft') document.querySelector('input').value = 'Synthetic changed input property';
            const before = document.body.innerHTML;
            const fields = [...document.querySelectorAll('input, textarea')].map(field => field.value);
            const captures = images + native;
            if ((await captureFeedbackScreenshot()) !== null || images + native !== captures) leaked.push(mode + ': ' + name);
            assert.equal(document.body.innerHTML, before);
            assert.deepEqual([...document.querySelectorAll('input, textarea')].map(field => field.value), fields);
          }
          document.body.innerHTML = safe;
          const before = document.body.innerHTML;
          const file = await captureFeedbackScreenshot();
          assert.ok(file?.size, mode + ' empty composer');
          assert.equal(document.body.innerHTML, before);
        }
        assert.deepEqual(leaked, []);
        let release;
        let started;
        const requested = new Promise(resolve => started = resolve);
        window.nodDesktop = { captureFeedbackScreenshot: () => { native++; started(); return new Promise(resolve => release = resolve); } };
        document.body.innerHTML = safe;
        const pending = captureFeedbackScreenshot();
        await requested;
        document.querySelector('[contenteditable]').textContent = 'Synthetic draft typed during capture';
        release(new Uint8Array([1, 2, 3]));
        assert.equal(await pending, null);
        assert.equal(document.querySelector('[contenteditable]').textContent, 'Synthetic draft typed during capture');
        document.body.innerHTML = safe;
        window.nodDesktop = { captureFeedbackScreenshot: async () => { native++; return new Uint8Array([1, 2, 3]); } };
        const frame = window.requestAnimationFrame;
        window.requestAnimationFrame = callback => frame(() => {
          document.body.insertAdjacentHTML('beforeend', '<div class="browser-handoff">Synthetic newly opened remote page</div>');
          callback(0);
        });
        const captures = native;
        assert.equal(await captureFeedbackScreenshot(), null);
        assert.equal(native, captures);
      } finally {
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('browser handoff retains pointer input while the next frame is loading', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
      Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      const writes = [];
      let frames;
      globalThis.fetch = async (path, options = {}) => {
        if (path.startsWith('/api/browser-handoff/stream')) return new Response(new ReadableStream({ start(controller) { frames = controller; } }));
        writes.push([path, JSON.parse(options.body)]);
        return Response.json({ ok: true });
      };
      const { act, createElement } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { BrowserHandoff } = await import('./src/web/components/browser-handoff.tsx');
      const root = createRoot(document.querySelector('#root'));
      const frame = new Uint8Array([0, 0, 0, 4, 255, 216, 255, 217]);
      try {
        await act(async () => root.render(createElement(BrowserHandoff, { turnId: 'synthetic-turn' })));
        await act(async () => frames.enqueue(frame));
        const image = document.querySelector('.browser-handoff-screen img');
        let loaded = true;
        Object.defineProperties(image, {
          naturalWidth: { get: () => loaded ? 1280 : 0 },
          naturalHeight: { get: () => loaded ? 800 : 0 },
        });
        image.getBoundingClientRect = () => ({ left: 10, top: 20, width: 640, height: 400 });
        await act(async () => image.dispatchEvent(new dom.window.Event('load')));
        const displayed = image.src;
        loaded = false;
        await act(async () => frames.enqueue(frame));
        assert.notEqual(image.src, displayed);
        assert.equal(image.naturalWidth, 0);
        for (const type of ['mousedown', 'mouseup']) await act(async () => image.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: 330, clientY: 220, button: 0 })));
        assert.deepEqual(writes, [
          ['/api/browser-handoff', { turnId: 'synthetic-turn', inputs: [{ type: 'mouse', event: 'down', x: 0.5, y: 0.5, button: 'left' }] }],
          ['/api/browser-handoff', { turnId: 'synthetic-turn', inputs: [{ type: 'mouse', event: 'up', x: 0.5, y: 0.5, button: 'left' }] }],
        ]);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

for (const surface of ['channels', 'onboarding'])
  test(`Telegram setup preserves a pending identity and confirms it once on ${surface}`, async () => {
    const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
      timeoutMs: 20_000,
      input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/channels', pretendToBeVisual: true });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
        IS_REACT_ACT_ENVIRONMENT: true,
        ...Object.fromEntries(['Node', 'NodeFilter', 'Event', 'CustomEvent', 'Element', 'HTMLElement', 'HTMLInputElement', 'MutationObserver'].map(name => [name, dom.window[name]])),
      });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      let setup = {
        provider: 'telegram', enabled: true, accountHandle: '@fixture_nod_bot', mode: 'polling',
        pairingExpiresAt: new Date(Date.now() + 900000).toISOString(),
        pairingCandidate: ${surface === 'channels' ? 'undefined' : "{ id: '123456789', name: 'Fixture Person', username: 'fixture_person' }"},
      };
      const writes = [];
      let confirm;
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/channels') return Response.json({ channels: [{ provider: 'telegram', status: 'configured', missing: [] }], error: null });
        if (path === '/api/channel-settings') return Response.json({ ready: true, channels: [setup] });
        writes.push([path, options.method, JSON.parse(options.body)]);
        assert.equal(path, '/api/channel-settings/telegram/confirm');
        assert.equal(options.method, 'POST');
        await new Promise(resolve => confirm = resolve);
        setup = {
          provider: 'telegram', enabled: true, accountHandle: '@fixture_nod_bot', mode: 'polling',
          allowedUserId: '123456789', pairedUser: 'Fixture Person', pairedUsername: 'fixture_person',
        };
        return Response.json({ channel: setup });
      };
      const { act, createElement } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Channels } = await import('./src/web/pages/channels.tsx');
      const { Telegram } = await import('./src/web/pages/onboarding/steps/telegram.tsx');
      const root = createRoot(document.querySelector('#root'));
      try {
        await act(async () => root.render(${
          surface === 'channels'
            ? 'createElement(Channels, { hosted: true })'
            : "createElement(Telegram, { arrived: 'back', onNext() {}, onBack() {} })"
        }));
        ${
          surface === 'channels'
            ? `setup = { ...setup, pairingCandidate: { id: '123456789', name: 'Fixture Person', username: 'fixture_person' } };
        await act(async () => document.querySelector('.channel-account-actions button').click());`
            : ''
        }
        assert.deepEqual(writes, []);
        const identity = document.querySelector('.telegram-setup-identity');
        assert.ok(identity.textContent.includes('123456789'));
        assert.ok(identity.textContent.includes('@fixture_person'));
        assert.equal(identity.dataset.analyticsPrivate, 'true');
        const button = document.querySelector('.telegram-setup [data-telegram-primary]');
        await act(async () => { button.click(); button.click(); });
        assert.deepEqual(writes, [['/api/channel-settings/telegram/confirm', 'POST', {}]]);
        assert.equal(button.disabled, true);
        await act(async () => confirm());
        assert.equal(document.querySelector('.telegram-setup-identity'), null);
        assert.ok(document.querySelector('.telegram-setup-connected').textContent.includes('123456789'));
        assert.deepEqual(writes, [['/api/channel-settings/telegram/confirm', 'POST', {}]]);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
    });
    assert.equal(result.exitCode, 0, result.stderr);
  });

test('feedback draft storage isolates owners', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 15_000,
    input: `
      import assert from 'node:assert/strict';
      import { indexedDB } from 'fake-indexeddb';
      globalThis.indexedDB = indexedDB;
      const { loadFeedbackDraft, saveFeedbackDraft } = await import('./src/web/lib/feedback-draft.ts');
      const original = new File(['synthetic-original-private-pixels'], 'capture.png', { type: 'image/png', lastModified: 1000 });
      const rendered = new File(['synthetic-rendered-covered-pixels'], 'capture.png', { type: 'image/png', lastModified: 2000 });
      const marks = [{ tool: 'redact', from: { x: 10, y: 20 }, to: { x: 70, y: 90 } }];
      const first = {
        category: 'feature', feedback: 'Synthetic idea draft', pendingId: null,
        attachments: [{ id: 'capture', file: rendered, image: { original, marks } }],
      };
      const second = {
        category: 'other', feedback: 'Different synthetic owner', pendingId: crypto.randomUUID(),
        attachments: [{ id: 'log', file: new File(['synthetic log'], 'details.log', { type: 'text/plain' }) }],
      };
      await Promise.all([saveFeedbackDraft('owner-one', first), saveFeedbackDraft('owner-two', second)]);
      const restored = await loadFeedbackDraft('owner-one');
      assert.equal(await restored.attachments[0].image.original.text(), 'synthetic-original-private-pixels');
      assert.equal((await loadFeedbackDraft('owner-two')).pendingId, second.pendingId);
      assert.equal(await loadFeedbackDraft('owner-three'), null);
      await assert.rejects(loadFeedbackDraft(''), /owner/);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('nod-feedback', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        const request = store.get('owner-two');
        request.onsuccess = () => store.put({ ...request.result, ownerId: 'owner-two' }, 'owner-one');
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });
      db.close();
      await assert.rejects(loadFeedbackDraft('owner-one'), /restored/);
      assert.equal((await loadFeedbackDraft('owner-two')).feedback, second.feedback);
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test(
  'private entry masks known values, refuses Pi listeners and refuses a foreign login frame',
  { timeout: 60_000 },
  async () => {
    const hits: string[] = [];
    let shadowImage: Buffer | undefined;
    const server = createHttpServer((request, response) => {
      if (request.url === '/image') {
        response.setHeader('content-type', 'image/png');
        response.end(shadowImage);
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url?.startsWith('/record')) {
        hits.push(new URL(request.url, 'http://fixture').searchParams.get('value') ?? '');
        response.end();
        return;
      }
      if (request.url === '/frame') {
        response.end(
          '<input id="foreign" type="password" aria-label="Foreign password"><script>document.querySelector("input").addEventListener("input", e => fetch("/record?value="+encodeURIComponent(e.target.value)))</script>',
        );
        return;
      }
      if (request.url === '/card') {
        response.end(
          '<input id="number" aria-label="Card number"><input id="expiry" aria-label="Expiry"><input id="cvc" aria-label="Security code"><h2 id="echo"></h2><button id="submit">Continue</button><script>for(const input of document.querySelectorAll("input"))input.addEventListener("input",e=>document.querySelector("h2").textContent+=e.target.value)</script>',
        );
        return;
      }
      if (request.url === '/shadow') {
        response.setHeader('Content-Security-Policy', "style-src 'nonce-nod-fixture'");
        response.end(
          `<card-panel></card-panel><button id="report">Report</button><script>
          document.querySelector('#report').onclick = () => { const mutated = globalThis.maskMutations > 0; globalThis.privateStyles[0].style.setProperty('outline-width', '1px'); setTimeout(() => fetch('/record?value=' + encodeURIComponent('report:' + JSON.stringify({ mutated, styles: globalThis.privateStyles.map(node => [getComputedStyle(node).opacity, getComputedStyle(node).transitionProperty, node.style.getPropertyValue('transition-property'), node.style.getPropertyValue('opacity')]) }))), 0); };
          customElements.define('card-panel', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<card-fields></card-fields>'; } });
          customElements.define('card-fields', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'closed' });
          root.innerHTML = '<style nonce="nod-fixture">input[aria-label="Card number"],input[aria-label="Security code"],h2{background:rgb(255,0,0);transition:opacity 60s !important}button{background:rgb(0,0,255)}</style><form><input aria-label="Card number"><select aria-label="Month"><option value="1">January</option><option value="8">August</option></select><input aria-label="Year"><input aria-label="Security code"><h2></h2><button>Complete</button></form>';
          root.querySelectorAll('input').forEach(node => node.style.setProperty('visibility', 'visible', 'important'));
          globalThis.privateStyles = Array.from(root.querySelectorAll('input[aria-label="Card number"],input[aria-label="Security code"],h2'));
          globalThis.maskMutations = 0;
          new MutationObserver(records => { globalThis.maskMutations++; const source = root.querySelector('h2'); if (records.some(record => record.target === source) && source.style.opacity === '0' && source.textContent) { const echo = source.cloneNode(true); echo.style.removeProperty('opacity'); echo.style.removeProperty('transition-property'); root.append(echo); } }).observe(root, { subtree: true, attributes: true, attributeFilter: ['style'] });
          root.querySelector('input').oninput = event => { event.target.value = event.target.value.replace(/\\D/g, '').replace(/(\\d{4})(?=\\d)/g, '$1 '); root.querySelector('h2').textContent = event.target.value; };
          root.querySelector('form').onsubmit = event => { event.preventDefault(); fetch('/record?value=' + encodeURIComponent([...root.querySelectorAll('input,select')].map(node => node.value).join('/'))); };
          } });</script>`,
        );
        return;
      }
      const { port } = server.address() as { port: number };
      response.end(
        `<input id="password" type="password" aria-label="Password"><button id="submit">Continue</button><h2></h2><iframe title="Other origin" src="http://localhost:${port}/frame"></iframe><script>document.querySelector('#password').addEventListener('input',e=>document.querySelector('h2').textContent=e.target.value)</script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '::', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-entry-'));
    const native = createAgentBrowserComputer({
      dataRoot: directory,
      privateNetwork: true,
      headless: true,
    });
    const worker = await harness({ computer: native });
    const computer = worker.client(directory, { timeoutMs: 30_000 });
    assert.ok(computer.cardDestinations);
    assert.ok(computer.fillCard);
    try {
      await computer.act('private', { action: 'open', url: origin });
      const secret = 'Synthetic private value';
      const input = {
        threadId: 'private',
        origin,
        kind: 'password' as const,
        password: secret,
        passwordSelector: '#password',
        submitSelector: '#submit',
      };
      await computer.act('private', {
        action: 'evaluate',
        script:
          'document.querySelector("#password").addEventListener("input", e => localStorage.setItem("copied", btoa(e.target.value)))',
      });
      await assert.rejects(computer.injectCredentials(input), /script ran/);
      await computer.act('private', { action: 'reload' });
      await computer.injectCredentials(input);
      const seen = (await computer.act('private', { action: 'snapshot' })).text;
      assert.equal(seen.includes(secret), false);
      await assert.rejects(
        computer.act('private', {
          action: 'evaluate',
          script: 'document.querySelector("#password").value.split("").reverse().join("")',
        }),
        /scripts are paused/,
      );
      await computer.act('private', { action: 'reload' });
      assert.equal(
        (
          await computer.act('private', {
            action: 'evaluate',
            script: 'localStorage.getItem("copied")',
          })
        ).text.includes(Buffer.from(secret).toString('base64')),
        false,
      );
      const page = (await computer.act('private', { action: 'snapshot' })).text;
      const ref = /"Foreign password"[^\n]*ref=(e\d+)/.exec(page)?.[1];
      assert.ok(ref);
      await assert.rejects(computer.injectCredentials({ ...input, passwordSelector: `@${ref}` }));
      assert.deepEqual(hits, []);
      await computer.act('private', { action: 'open', url: `${origin}/card` });
      const fields = { number: '#number', expiry: '#expiry', securityCode: '#cvc' };
      const bound = await computer.cardDestinations('private', fields);
      await computer.fillCard({
        threadId: 'private',
        fields,
        ...bound,
        submitSelector: '#submit',
        card: {
          cardNumber: '4242424242424242',
          expiryMonth: 8,
          expiryYear: 2030,
          cardholder: 'Synthetic cardholder',
          securityCode: '737',
        },
      });
      const receipt = (await computer.act('private', { action: 'snapshot' })).text;
      assert.equal(receipt.includes('4242424242424242'), false);
      assert.equal(receipt.includes('737'), false);
      assert.ok(await computer.screenshot('private'));
      await assert.rejects(
        computer.act('private', {
          action: 'evaluate',
          script: '[...document.querySelectorAll("input")].map(node=>node.value)',
        }),
        /scripts are paused/,
      );
      await computer.act('private', { action: 'open', url: `${origin}/shadow` });
      const shadowPage = (await computer.act('private', { action: 'snapshot' })).text;
      const shadowRef = (name: string) => {
        const ref = new RegExp(`"${name}"[^\\n]*ref=(e\\d+)`).exec(shadowPage)?.[1];
        assert.ok(ref);
        return `@${ref}`;
      };
      const shadowFields = {
        number: shadowRef('Card number'),
        expiryMonth: shadowRef('Month'),
        expiryYear: shadowRef('Year'),
        securityCode: shadowRef('Security code'),
      };
      const shadowBound = await computer.cardDestinations('private', shadowFields);
      assert.deepEqual(Object.values(shadowBound.destinations), Array(4).fill(origin));
      await computer.fillCard({
        threadId: 'private',
        fields: shadowFields,
        ...shadowBound,
        submitSelector: shadowRef('Complete'),
        card: {
          cardNumber: '4242424242424242',
          expiryMonth: 8,
          expiryYear: 2030,
          cardholder: 'Synthetic cardholder',
          securityCode: '737',
        },
      });
      const shadowReceipt = (await computer.act('private', { action: 'snapshot' })).text;
      assert.equal(shadowReceipt.includes('4242424242424242'), false);
      assert.equal(shadowReceipt.includes('737'), false);
      assert.deepEqual(hits, ['4242 4242 4242 4242/8/2030/737']);
      const image = await computer.screenshot('private');
      assert.ok(image);
      shadowImage = Buffer.from(image);
      await assert.rejects(
        computer.act('private', {
          action: 'evaluate',
          script: 'globalThis.maskMutations',
        }),
        /scripts are paused/,
      );
      for (const field of [shadowFields.number, shadowFields.expiryYear, shadowFields.securityCode])
        await computer.act('private', { action: 'fill', selector: field, text: '' });
      await assert.rejects(computer.act('private', { action: 'open', url: 'file:///etc/hosts' }));
      await assert.rejects(
        computer.act('private', { action: 'evaluate', script: 'document.title' }),
        /scripts are paused/,
      );
      await computer.act('private', { action: 'click', selector: '#report' });
      const recorded = hits as string[];
      const reported = Date.now() + 5_000;
      while (!recorded.some((hit) => hit.startsWith('report:')) && Date.now() < reported)
        await delay(50);
      const report = JSON.parse(
        recorded.find((hit) => hit.startsWith('report:'))?.slice('report:'.length) ?? 'null',
      ) as { mutated: boolean; styles: string[][] } | null;
      assert.equal(report?.mutated, true);
      assert.deepEqual(
        report?.styles,
        Array.from({ length: 3 }, () => ['1', 'opacity', '', '']),
      );
      await computer.act('private', { action: 'open', url: origin });
      const pixels = await computer.act('private', {
        action: 'evaluate',
        script: `(async () => { const image = new Image(); image.src = '/image'; await image.decode(); const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext('2d'); context.drawImage(image, 0, 0); const pixels = context.getImageData(0, 0, image.width, image.height).data; let red = 0, blue = 0; for (let index = 0; index < pixels.length; index += 4) { if (pixels[index] === 255 && pixels[index + 1] === 0 && pixels[index + 2] === 0) red++; if (pixels[index] === 0 && pixels[index + 1] === 0 && pixels[index + 2] === 255) blue++; } return { red, blue }; })()`,
      });
      const colors = JSON.parse(pixels.text.slice(pixels.text.indexOf('\n') + 1)) as {
        red: number;
        blue: number;
      };
      assert.equal(colors.red, 0);
      assert.ok(colors.blue > 0);
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'a read-only evaluate never runs page work after its side-effect check',
  { timeout: 60_000 },
  async () => {
    const hits: string[] = [];
    const server = createHttpServer((request, response) => {
      if (request.method === 'POST') {
        hits.push(request.url ?? '');
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      response.end('<title>Sink</title><p>ready</p>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-readonly-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      await computer.act('read', { action: 'open', url: origin });
      await computer.act('read', {
        action: 'evaluate',
        readOnly: true,
        script: '({ then(resolve) { fetch("/leak", { method: "POST" }); resolve("done") } })',
      });
      await delay(500);
      assert.deepEqual(hits, []);
      assert.match(
        (
          await computer.act('read', {
            action: 'evaluate',
            readOnly: true,
            script: 'document.title',
          })
        ).text,
        /Sink/,
      );
      assert.deepEqual(hits, []);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'reloading a page reached by a form POST does not resubmit it',
  { timeout: 60_000 },
  async () => {
    let posts = 0;
    const server = createHttpServer((request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.method === 'POST') {
        posts += 1;
        response.end(`<title>Done</title><p>count ${posts}</p>`);
        return;
      }
      response.end('<form method="post" action="/submit"><button id="go">Go</button></form>');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-reload-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      await computer.act('post', { action: 'open', url: origin });
      await computer.act('post', { action: 'click', selector: '#go' });
      await computer.act('post', { action: 'wait', text: 'count 1' });
      assert.equal(posts, 1);
      await computer.act('post', { action: 'reload' });
      await computer.act('post', { action: 'wait', load: 'load' });
      assert.equal(posts, 1);
      await computer.act('post', { action: 'open', url: origin });
      await computer.act('post', { action: 'reload' });
      assert.equal(posts, 1);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('navigation stays available when a saved script fence cannot reach the inspector', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-navigation-recovery-'));
  const fixture = stagedLoginBrowser();
  let offline = false;
  const navigated: string[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (...args) => {
      const command = args[1].slice(args[1].indexOf('--idle-timeout') + 2);
      if (offline && command[0] === 'get' && command[1] === 'cdp-url')
        return { stdout: '{"success":false}', stderr: '', exitCode: 1 };
      if (['back', 'forward', 'reload', 'open'].includes(command[0])) navigated.push(command[0]);
      const result = await fixture.run(...args);
      if (command[0] === 'eval') offline = true;
      return result;
    },
  });
  try {
    await computer.act('recovery', { action: 'open', url: 'https://1.1.1.1/login' });
    await computer.act('recovery', {
      action: 'evaluate',
      script: "document.body.dataset.changed = 'synthetic'",
    });
    for (const action of ['back', 'forward', 'reload'] as const)
      await computer.act('recovery', { action });
    assert.deepEqual(navigated, ['open', 'back', 'forward', 'open']);
    offline = false;
    await assert.rejects(
      computer.injectCredentials({
        threadId: 'recovery',
        origin: 'https://1.1.1.1',
        kind: 'identifier',
        username: 'synthetic-recovery',
        usernameSelector: '#account',
        submitSelector: 'button',
      }),
      /script ran/,
    );
    await computer.act('recovery', { action: 'reload' });
    await computer.injectCredentials({
      threadId: 'recovery',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic-recovery',
      usernameSelector: '#account',
      submitSelector: 'button',
    });
    assert.deepEqual(fixture.pages.get('recovery')!.entered, ['synthetic-recovery']);
  } finally {
    offline = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed private entry holds every Pi action until the filled document changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-private-cleanup-'));
  const fixture = stagedLoginBrowser();
  let failSubmit = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (...args) => {
      const command = args[1].slice(args[1].indexOf('--idle-timeout') + 2);
      if (command[0] === 'click' && failSubmit)
        return { stdout: '{"success":false}', stderr: '', exitCode: 1 };
      return fixture.run(...args);
    },
  });
  try {
    await computer.act('private', { action: 'open', url: 'https://1.1.1.1/login' });
    await assert.rejects(
      computer.injectCredentials({
        threadId: 'private',
        origin: 'https://1.1.1.1',
        kind: 'identifier',
        username: 'synthetic-private@example.test',
        usernameSelector: '#account',
        submitSelector: 'button',
      }),
    );
    const before = fixture.pages.get('private')!.entered.length;
    for (const input of [
      { action: 'snapshot' as const },
      { action: 'click' as const, selector: 'button' },
      { action: 'evaluate' as const, script: 'document.body.textContent' },
    ])
      await assert.rejects(computer.act('private', input));
    await assert.rejects(computer.currentPage('private'));
    await assert.rejects(computer.screenshot('private'));
    await assert.rejects(computer.download!('private', { selector: 'button' }));
    await assert.rejects(computer.control!('private', { type: 'key', key: 'Enter' }));
    await assert.rejects(
      computer.cardDestinations('private', { number: '#account', expiry: '#account' }),
    );
    assert.equal(fixture.pages.get('private')!.entered.length, before);
    failSubmit = false;
    await computer.act('private', { action: 'reload' });
    assert.ok(await computer.screenshot('private'));
    assert.match(
      (await computer.act('private', { action: 'evaluate', script: 'document.title' })).text,
      /Script result/,
    );
    await computer.act('private', { action: 'reload' });
    const page = fixture.pages.get('private')!;
    page.afterInspect = (script) => {
      if (script.includes('globalThis.__nodFocused = node')) page.search.focus();
    };
    await assert.rejects(
      computer.injectCredentials({
        threadId: 'private',
        origin: 'https://1.1.1.1',
        kind: 'identifier',
        username: 'synthetic-focus-race',
        usernameSelector: '#account',
      }),
    );
    assert.equal(page.input.value, '');
    assert.equal(page.search.value, '');
    page.afterInspect = undefined;
    await computer.act('private', { action: 'reload' });
    page.afterInspect = (script) => {
      if (script.includes("execCommand('insertText'")) page.document = 'navigated-during-entry';
    };
    await assert.rejects(
      computer.injectCredentials({
        threadId: 'private',
        origin: 'https://1.1.1.1',
        kind: 'identifier',
        username: 'synthetic-navigation',
        usernameSelector: '#account',
        submitSelector: 'button',
      }),
      /checkout page changed/,
    );
    assert.equal(page.entered.length, before);
    page.afterInspect = undefined;
  } finally {
    failSubmit = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'private submission keeps SPA state, delayed requests and field formats, and pauses scripts while a value stays',
  { timeout: 60_000 },
  async () => {
    const submitted = deferred<string>();
    const cardSubmitted = deferred<string>();
    let submissions = 0;
    const server = createHttpServer(async (request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url === '/record') {
        let body = '';
        for await (const bytes of request) body += bytes;
        submissions++;
        submitted.resolve(body);
        response.end('Accepted');
      } else if (request.url === '/card-record') {
        let body = '';
        for await (const bytes of request) body += bytes;
        cardSubmitted.resolve(body);
        response.end('Accepted');
      } else if (request.url === '/delayed') {
        response.end(`<input id="company"><input id="password" type="password"><button id="submit">Continue</button><script>
        document.querySelector('button').onclick = () => setTimeout(() => fetch('/record', { method: 'POST', body: JSON.stringify({company: document.querySelector('#company').value, password: document.querySelector('#password').value}) }), 1200);
      </script>`);
      } else if (request.url === '/card') {
        response.end(
          '<h2>Order total EUR 30</h2><input id="number"><select id="month"><option value="">Choose month</option><option value="aug">August</option></select><input id="year"><input id="expiry"><button id="submit">Pay</button><script>document.querySelector("button").onclick = () => fetch("/card-record", {method:"POST", body:JSON.stringify({month:document.querySelector("#month").value, year:document.querySelector("#year").value, expiry:document.querySelector("#expiry").value})});</script>',
        );
      } else {
        response.end(`<input id="username"><button id="submit">Continue</button><script>
        document.querySelector('button').onclick = () => { document.body.innerHTML = '<h1>Password step</h1><input type="password" id="password">'; };
      </script>`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-private-state-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      await computer.act('state', { action: 'open', url: origin });
      await computer.injectCredentials({
        threadId: 'state',
        origin,
        kind: 'identifier',
        username: 'synthetic@example.test',
        usernameSelector: '#username',
        submitSelector: '#submit',
      });
      assert.match((await computer.act('state', { action: 'snapshot' })).text, /Password step/);
      await computer.act('state', { action: 'open', url: `${origin}/delayed` });
      await computer.act('state', {
        action: 'fill',
        selector: '#company',
        text: 'Synthetic company',
      });
      await computer.act('state', { action: 'evaluate', script: 'document.title' });
      await computer.injectCredentials({
        threadId: 'state',
        origin,
        kind: 'password',
        password: 'Synthetic private value',
        passwordSelector: '#password',
        submitSelector: '#submit',
      });
      assert.deepEqual(JSON.parse(await submitted.promise), {
        company: 'Synthetic company',
        password: 'Synthetic private value',
      });
      assert.equal(submissions, 1);
      assert.equal(
        (await computer.act('state', { action: 'snapshot' })).text.includes(
          'Synthetic private value',
        ),
        false,
      );
      await assert.rejects(
        computer.act('state', {
          action: 'evaluate',
          script: 'Promise.resolve(document.querySelector("#password").value.length)',
        }),
        /scripts are paused/,
      );
      await computer.act('state', { action: 'open', url: `${origin}/card` });
      const fields = {
        number: '#number',
        expiryMonth: '#month',
        expiryYear: { selector: '#year', format: 'YY' },
        expiry: { selector: '#expiry', format: 'YYYY-MM' },
      };
      const bound = await computer.cardDestinations('state', fields);
      await computer.fillCard({
        threadId: 'state',
        ...bound,
        fields,
        submitSelector: '#submit',
        card: {
          cardNumber: '4242424242424242',
          expiryMonth: 8,
          expiryYear: 2030,
          cardholder: 'Synthetic owner',
        },
      });
      assert.deepEqual(JSON.parse(await cardSubmitted.promise), {
        month: 'aug',
        year: '30',
        expiry: '2030-08',
      });
      assert.match(
        (await computer.act('state', { action: 'snapshot' })).text,
        /Order total EUR 30/,
      );
      await assert.rejects(
        computer.act('state', {
          action: 'evaluate',
          script: 'document.querySelector("#number").value',
        }),
        /scripts are paused/,
      );
      await computer.act('fence', { action: 'open', url: `${origin}/card` });
      await computer.act('fence', {
        action: 'evaluate',
        script: 'globalThis.__nodScripted = false',
      });
      const recovered = createAgentBrowserComputer({
        dataRoot: directory,
        browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
        privateNetwork: true,
        headless: true,
      });
      try {
        assert.equal((await recovered.currentPage('fence')).origin, origin);
        await recovered.act('fence', { action: 'snapshot' });
        await assert.rejects(
          recovered.cardDestinations('fence', fields),
          /script ran on this document/,
        );
        await computer.act('fence', { action: 'reload' });
        assert.equal(
          (await recovered.cardDestinations('fence', fields)).destinations.number,
          origin,
        );
      } finally {
        await recovered.dispose();
      }
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('a checked browser step is described from its snapshot and runs only on that page and control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nod-checked-step-'));
  const fixture = stagedLoginBrowser();
  const commands: Array<Record<string, unknown>> = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => commands.push(command),
  });
  const page = () => fixture.pages.get('checked')!;
  try {
    await computer.act('checked', { action: 'open', url: 'https://1.1.1.1/login' });
    await computer.act('checked', { action: 'fill', selector: '#account', text: 'synthetic' });
    const search = await computer.currentPage('checked', { action: 'click', selector: '@e3' });
    assert.deepEqual(search, {
      origin: 'https://1.1.1.1',
      url: 'https://1.1.1.1/login',
      controls: [{ role: 'textbox', name: 'Search' }],
      submits: 'unknown',
    });
    const next = { action: 'click', selector: '@e2' } as const;
    await assert.rejects(
      computer.act('checked', { ...next, expectOrigin: 'https://2.2.2.2' }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
    );
    await assert.rejects(
      computer.act('checked', { ...next, selector: '@e9', expectOrigin: 'https://1.1.1.1' }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
    );
    await assert.rejects(
      computer.act('checked', {
        action: 'drag',
        selector: '@e3',
        targetSelector: '@e9',
        expectOrigin: 'https://1.1.1.1',
      }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
    );
    assert.deepEqual(
      (
        await computer.currentPage('checked', {
          action: 'drag',
          selector: '@e3',
          targetSelector: '@e2',
        })
      ).dropTarget,
      [{ role: 'button', name: '' }],
    );
    assert.deepEqual(page().entered, []);
    await assert.rejects(
      computer.download('checked', { selector: '@e2' }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_download_control',
    );
    await assert.rejects(
      computer.download('checked', { selector: '@e2', expectOrigin: 'https://2.2.2.2' }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
    );
    assert.equal(
      commands.some((command) => command.action === 'download'),
      false,
    );
    await computer.act('checked', { ...next, expectOrigin: 'https://1.1.1.1' });
    assert.deepEqual(page().entered, ['synthetic']);
    await assert.rejects(
      computer.act('checked', {
        action: 'evaluate',
        script: "document.body.dataset.changed = 'synthetic'",
        readOnly: true,
      }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_script_writes',
    );
    assert.equal(page().dom.window.document.body.dataset.changed, undefined);
    const before = await computer.act('checked', { action: 'snapshot' });
    const searchRef = /textbox "Search" \[ref=(e\d+)\]/.exec(before.text)?.[1];
    assert.ok(searchRef);
    await computer.act('checked', {
      action: 'evaluate',
      script: "document.querySelector('#search').setAttribute('aria-label', 'Delete account')",
    });
    assert.deepEqual(
      (await computer.currentPage('checked', { action: 'click', selector: `@${searchRef}` }))
        .controls,
      [{ role: 'textbox', name: 'Delete account' }],
    );
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'a checked step reports the form it would send without sending it',
  { timeout: 60_000 },
  async (t) => {
    const sent: string[] = [];
    const server = createHttpServer(async (request, response) => {
      response.setHeader('content-type', 'text/html');
      if (request.url !== '/' && request.url !== '/favicon.ico') {
        sent.push(`${request.method} ${request.url}`);
        response.end('Sent');
        return;
      }
      response.end(
        '<form method="post" action="/book"><button>19:30</button></form><form action="/search"><input name="q" aria-label="Query"><button>Search</button></form><button id="plain">Plain</button><form method="post" action="/save"><button type="button" id="toggle">Toggle</button><button id="other" formaction="/other" formmethod="get">Other</button></form><form method="post" action="/a"><button>Same</button></form><form method="post" action="/b"><button>Same</button></form><form method="post" action="/reserve"><button>Menu</button></form><form method="post" action="/reserve"><button>Menu</button></form><form action="/find"><input name="city" aria-label="City"><button formaction="/reserve-now" formmethod="post">Go</button></form><form method="post" action="/label"><input type="submit" id="labelled" value="Send"><label for="labelled" id="label">Send it</label></form><form method="post" action="/shadowed"><input type="hidden" name="action" value="other"><input type="radio" name="method" aria-label="Card"><button>Shadowed</button></form>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const directory = await mkdtemp(join(tmpdir(), 'nod-submits-'));
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
    });
    try {
      let snapshot: string;
      try {
        snapshot = (await computer.act('submits', { action: 'open', url: origin })).text;
      } catch {
        t.skip('Chrome is not available here.');
        return;
      }
      const ref = (name: string) => {
        const found = new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`).exec(snapshot)?.[1];
        assert.ok(found, `No ${name} button in the snapshot.`);
        return `@${found}`;
      };
      const submits = async (step: BrowserAction) =>
        (await computer.currentPage('submits', step)).submits;
      assert.deepEqual(await submits({ action: 'click', selector: ref('19:30') }), {
        method: 'POST',
        to: `${origin}/book`,
      });
      assert.deepEqual(await submits({ action: 'click', selector: ref('Search') }), {
        method: 'GET',
        to: `${origin}/search`,
      });
      assert.deepEqual(await submits({ action: 'click', selector: '#other' }), {
        method: 'GET',
        to: `${origin}/other`,
      });
      assert.equal(await submits({ action: 'click', selector: '#plain' }), undefined);
      assert.equal(await submits({ action: 'click', selector: '#toggle' }), undefined);
      assert.deepEqual(await submits({ action: 'click', selector: ref('Same') }), {
        method: 'POST',
        to: `${origin}/a`,
      });
      assert.deepEqual(await submits({ action: 'click', selector: ref('Shadowed') }), {
        method: 'POST',
        to: `${origin}/shadowed`,
      });
      assert.deepEqual(await submits({ action: 'click', selector: ref('Menu') }), {
        method: 'POST',
        to: `${origin}/reserve`,
      });
      await computer.act('submits', { action: 'fill', selector: 'input[name=q]', text: 'tables' });
      assert.deepEqual(await submits({ action: 'press', key: 'Enter' }), {
        method: 'GET',
        to: `${origin}/search`,
      });
      await computer.act('submits', {
        action: 'evaluate',
        script: "document.querySelector('form button').focus()",
      });
      assert.deepEqual(await submits({ action: 'press', key: 'Enter' }), {
        method: 'POST',
        to: `${origin}/book`,
      });
      await computer.act('submits', {
        action: 'fill',
        selector: 'input[name=city]',
        text: 'Porto',
      });
      assert.deepEqual(await submits({ action: 'press', key: 'Enter' }), {
        method: 'POST',
        to: `${origin}/reserve-now`,
      });
      assert.deepEqual(await submits({ action: 'click', selector: '#label' }), {
        method: 'POST',
        to: `${origin}/label`,
      });
      assert.deepEqual(sent, []);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'native sign-in methods bind observed controls and refuse changed or repeated selections',
  { skip: process.env.NOD_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 90_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-method-native-'));
    const received: string[] = [];
    const cancelling = new AbortController();
    const cancelled = deferred();
    let cancelledMethod: string | undefined;
    const changes: Record<string, string> = {
      replaced: 'primary.replaceWith(primary.cloneNode(true))',
      renamed: "primary.textContent = 'Delete account'",
      accessibleName: "primary.setAttribute('aria-label', 'Delete account')",
      destination: "primary.form.action = '/other'",
      disabled: 'primary.disabled = true',
      hidden: "primary.style.display = 'none'",
      base: "document.querySelector('base').href = '/other/'",
      covered:
        "const cover=document.createElement('button');cover.style.cssText='position:fixed;inset:0;z-index:1000';cover.textContent='Cover';cover.onclick=()=>fetch('/covered',{method:'POST'});document.body.append(cover)",
      changedOnPress: "primary.addEventListener('mousedown',()=>primary.form.action='/other')",
      removedOnRelease: "primary.addEventListener('mouseup',()=>primary.remove())",
    };
    const server = createHttpServer(async (request, response) => {
      if (request.url === '/pressed') {
        cancelling.abort();
        await cancelled.promise;
        response.end();
        return;
      }
      if (request.method === 'POST') {
        received.push(request.url!);
        response.writeHead(303, { location: '/done' });
        response.end();
        return;
      }
      response.setHeader('content-type', 'text/html');
      if (request.url === '/done') {
        response.end('<h1>Selected</h1>');
        return;
      }
      if (
        ['/framed', '/foreign', '/duplicate', '/scaled-half', '/scaled-double'].includes(
          request.url!,
        )
      ) {
        const scaled = request.url!.startsWith('/scaled-');
        const source =
          request.url === '/foreign' || scaled
            ? `http://localhost:${(server.address() as { port: number }).port}/${scaled ? 'scaled-inner' : 'inner'}`
            : '/inner';
        const transform = scaled
          ? `transform:scale(${request.url === '/scaled-half' ? 0.5 : 2});transform-origin:top left;`
          : '';
        response.end(
          `
          ${request.url === '/duplicate' ? '<button id="primary">Continue with Example</button>' : ''}
          <iframe title="Sign in" src="${source}" onload="document.getElementById('frame-state').textContent='Frame ready'" style="width:700px;height:400px;margin:70px 100px;border:12px solid;${transform}"></iframe><button id="reload-frame" onclick="document.getElementById('frame-state').textContent='Loading frame';document.querySelector('iframe').contentWindow.location.reload()">Reload frame</button><p id="frame-state">Loading frame</p>`,
        );
        return;
      }
      if (request.url === '/cancel') {
        response.end(
          '<form action="/selected" method="post"><button id="primary" onmousedown="const xhr=new XMLHttpRequest();xhr.open(\'POST\',\'/pressed\',false);xhr.send()">Continue with Example</button></form><button id="ordinary" onclick="if(event.isTrusted)fetch(\'/ordinary\',{method:\'POST\'})">Continue browsing</button>',
        );
        return;
      }
      const change = changes[request.url!.slice(1)] ?? '';
      const primary =
        request.url === '/image'
          ? '<input id="primary" type="image" onclick="if(!event.isTrusted)event.preventDefault()" alt="Continue with Example" src="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22240%22 height=%2240%22%3E%3Crect width=%22240%22 height=%2240%22 fill=%22gray%22/%3E%3C/svg%3E">'
          : '<button id="primary" onclick="if(!event.isTrusted)event.preventDefault()"><span>Continue with Example</span></button>';
      response.end(
        `
        ${request.url === '/scaled-inner' ? '<script>addEventListener("pointermove",()=>{const xhr=new XMLHttpRequest();xhr.open("POST","/moved",false);xhr.send()},{once:true})</script>' : ''}
        <base href="/"><form action="selected" method="post">${primary}<button id="alternate" formaction="/alternate">Use another account</button></form><a id="link" href="linked">Continue with Link</a><button id="change" onclick="${change}">Change control</button>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    let socketPath = '';
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.NOD_TEST_BROWSER_EXECUTABLE,
      privateNetwork: true,
      headless: true,
      daemonCommand: async (path, command, signal, timeoutMs) => {
        socketPath = path;
        return existingDaemonCommand(path, command, signal, timeoutMs);
      },
    });
    const selectMethod = computer.selectSignInMethod!;
    computer.selectSignInMethod = async (id, input, signal) => {
      if (input.methodId === cancelledMethod)
        signal?.addEventListener('abort', () => cancelled.resolve(), { once: true });
      return selectMethod(id, input, signal);
    };
    const worker = await harness({ computer });
    const client = worker.client(directory, { timeoutMs: 30_000 });
    const act = (input: BrowserAction) => client.act('fixture', input);
    const choices = [
      { label: 'Misleading label', selector: '#primary span' },
      { label: 'Another misleading label', selector: '#alternate' },
    ];
    try {
      await act({ action: 'open', url: origin });
      await assert.rejects(
        client.signInMethods!('fixture', origin, [
          { label: 'First', selector: '#primary' },
          { label: 'Second', selector: '#primary span' },
        ]),
      );
      const bound = await client.signInMethods!('fixture', origin, choices);
      assert.deepEqual(
        bound.methods.map(({ label }) => label),
        ['Continue with Example', 'Use another account'],
      );
      assert.deepEqual(bound.methods[0]!.page.submits, {
        method: 'POST',
        to: origin + '/selected',
      });
      assert.deepEqual(bound.methods[1]!.page.submits, {
        method: 'POST',
        to: origin + '/alternate',
      });
      const selection = { origin, document: bound.document, methodId: bound.methods[0]!.id };
      await assert.rejects(client.selectSignInMethod!('other', selection));
      await client.selectSignInMethod!('fixture', selection);
      await act({ action: 'wait', url: '**/done' });
      assert.deepEqual(received, ['/selected']);
      await assert.rejects(client.selectSignInMethod!('fixture', selection));
      await assert.rejects(
        client.selectSignInMethod!('fixture', { ...selection, methodId: bound.methods[1]!.id }),
      );
      for (const change of [...Object.keys(changes), 'navigation', 'origin', 'closed']) {
        await act({ action: 'open', url: origin + '/' + change });
        const stale = await client.signInMethods!('fixture', origin, choices);
        if (change === 'navigation') await act({ action: 'reload' });
        else if (change === 'closed') await client.close('fixture');
        else if (change !== 'origin') await act({ action: 'click', selector: '#change' });
        await assert.rejects(
          client.selectSignInMethod!('fixture', {
            origin: change === 'origin' ? 'https://another.example' : origin,
            document: stale.document,
            methodId: stale.methods[0]!.id,
          }),
        );
        assert.deepEqual(received, ['/selected']);
      }
      await act({ action: 'open', url: origin + '/base' });
      const linked = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#link' },
      ]);
      await act({ action: 'click', selector: '#change' });
      await assert.rejects(
        client.selectSignInMethod!('fixture', {
          origin,
          document: linked.document,
          methodId: linked.methods[0]!.id,
        }),
      );
      assert.deepEqual(received, ['/selected']);
      await act({ action: 'open', url: origin });
      const snapshot = (await act({ action: 'snapshot' })).text;
      const ref = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(snapshot)?.[1];
      assert.ok(ref);
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@' + ref }]),
        /concrete CSS selectors/,
      );
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: 'button' }]),
      );
      await act({ action: 'open', url: origin + '/duplicate' });
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '#primary' }]),
      );
      for (const path of ['/framed', '/foreign']) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const inspect = () =>
          client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '#primary' }]);
        if (path === '/foreign') {
          await assert.rejects(inspect());
          continue;
        }
        const framed = await inspect();
        assert.equal(framed.methods[0]!.label, 'Continue with Example');
        await act({ action: 'click', selector: '#reload-frame' });
        await act({ action: 'wait', text: 'Frame ready' });
        await assert.rejects(
          client.selectSignInMethod!('fixture', {
            origin,
            document: framed.document,
            methodId: framed.methods[0]!.id,
          }),
        );
        const refreshed = await inspect();
        assert.equal(refreshed.document, framed.document);
        await client.selectSignInMethod!('fixture', {
          origin,
          document: refreshed.document,
          methodId: refreshed.methods[0]!.id,
        });
        const deadline = Date.now() + 5000;
        while (received.length < 2 && Date.now() < deadline) await delay(10);
        assert.deepEqual(received, ['/selected', '/selected']);
      }
      const controller = new AbortController();
      controller.abort();
      await assert.rejects(client.selectSignInMethod!('fixture', selection, controller.signal));
      assert.deepEqual(received, ['/selected', '/selected']);
      await act({ action: 'open', url: origin + '/image' });
      const image = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#primary' },
      ]);
      assert.equal(image.methods[0]!.label, 'Continue with Example');
      assert.deepEqual(image.methods[0]!.page.submits, {
        method: 'POST',
        to: origin + '/selected',
      });
      await client.selectSignInMethod!('fixture', {
        origin,
        document: image.document,
        methodId: image.methods[0]!.id,
      });
      await act({ action: 'wait', url: '**/done' });
      assert.deepEqual(received, ['/selected', '/selected', '/selected']);
      await assert.rejects(
        client.selectSignInMethod!('fixture', {
          origin,
          document: image.document,
          methodId: image.methods[0]!.id,
        }),
      );

      for (const [index, path] of ['/framed', '/foreign'].entries()) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
        const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
        const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
          (value) => value.active,
        )!;
        let inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
        try {
          const bound = await inspector.signInControl({ pixel: { x: 150, y: 100 } });
          assert.equal(
            bound.origin,
            path === '/foreign' ? `http://localhost:${address.port}` : origin,
          );
          assert.equal(bound.targetFrameId === bound.frameId, path === '/foreign');
          assert.notEqual(bound.loaderId, await inspector.document());
          if (path === '/framed') {
            await act({ action: 'click', selector: '#reload-frame' });
            await act({ action: 'wait', text: 'Frame ready' });
            await assert.rejects(inspector.selectSignInControl(bound));
          }
          inspector.close();
          inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
          const current = await inspector.signInControl({ pixel: { x: 150, y: 100 } });
          inspector.close();
          inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
          await inspector.selectSignInControl(current);
          const deadline = Date.now() + 5000;
          while (received.length < 4 + index && Date.now() < deadline) await delay(10);
          assert.deepEqual(received, Array(4 + index).fill('/selected'));
          await assert.rejects(inspector.selectSignInControl(current));
        } finally {
          inspector.close();
        }
      }
      for (const path of ['/scaled-half', '/scaled-double']) {
        await act({ action: 'open', url: origin + path });
        await act({ action: 'wait', text: 'Frame ready' });
        const connection = await existingDaemonCommand(socketPath, { action: 'cdp_url' });
        const tabs = await existingDaemonCommand(socketPath, { action: 'tab_list' });
        const tab = (tabs.tabs as { active: boolean; targetId: string }[]).find(
          (value) => value.active,
        )!;
        const inspector = await openDevtools(String(connection.cdpUrl), tab.targetId);
        try {
          const bound = await inspector.signInControl({ selector: '#primary' });
          await assert.rejects(inspector.selectSignInControl(bound));
          assert.deepEqual(received, Array(5).fill('/selected'));
        } finally {
          inspector.close();
        }
      }
      await act({ action: 'open', url: origin + '/cancel' });
      const interrupted = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '#primary' },
      ]);
      cancelledMethod = interrupted.methods[0]!.id;
      const interruptedSelection = {
        origin,
        document: interrupted.document,
        methodId: cancelledMethod,
      };
      await assert.rejects(
        client.selectSignInMethod!('fixture', interruptedSelection, cancelling.signal),
      );
      assert.equal(cancelling.signal.aborted, true);
      assert.deepEqual(received, Array(5).fill('/selected'));
      await assert.rejects(client.selectSignInMethod!('fixture', interruptedSelection));
      await act({ action: 'click', selector: '#ordinary' });
      const deadline = Date.now() + 5000;
      while (received.length < 6 && Date.now() < deadline) await delay(10);
      assert.deepEqual(received, [...Array(5).fill('/selected'), '/ordinary']);
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
