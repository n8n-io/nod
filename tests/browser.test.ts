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
import pg from 'pg';
import type { Agent, AgentToolResult, RuntimeContext } from '../src/ports/agent.ts';
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
import { createBridgeComputer } from '../src/providers/container-browser/client.ts';
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
    let copyResponses: Array<string | undefined> = [];
    let onCopy: (() => Promise<void>) | undefined;
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
          if (input.type === 'copy') {
            await onCopy?.();
            return copyResponses.length ? copyResponses.shift() : 'Synthetic selected text';
          }
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
      const copied = await post('/api/browser-handoff', { inputs: [{ type: 'copy' }] });
      assert.equal(copied.statusCode, 200);
      assert.deepEqual(copied.json(), { ok: true, copiedText: 'Synthetic selected text' });
      assert.deepEqual(controls.pop(), [next.id, { type: 'copy' }]);
      copyResponses = ['Synthetic selected text', undefined];
      const unselected = await post('/api/browser-handoff', {
        inputs: [{ type: 'copy' }, { type: 'copy' }],
      });
      assert.equal(unselected.statusCode, 200);
      assert.deepEqual(unselected.json(), { ok: true });
      assert.deepEqual(controls.splice(-2), [
        [next.id, { type: 'copy' }],
        [next.id, { type: 'copy' }],
      ]);
      const copyStarted = deferred();
      const copyRelease = deferred();
      onCopy = async () => {
        copyStarted.resolve();
        await copyRelease.promise;
      };
      const closingCopy = post('/api/browser-handoff', { inputs: [{ type: 'copy' }] });
      await copyStarted.promise;
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [nextTurnId]);
      copyRelease.resolve();
      const lateCopy = await closingCopy;
      assert.equal(lateCopy.statusCode, 423);
      assert.equal(lateCopy.body.includes('Synthetic selected text'), false);
      assert.deepEqual(controls.pop(), [next.id, { type: 'copy' }]);
      onCopy = undefined;
      await db.pool.query("UPDATE turns SET status='waiting' WHERE id=$1", [nextTurnId]);
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
      const foreignCopy = await post('/api/browser-handoff', {
        turnId: foreignTurnId,
        inputs: [{ type: 'copy' }],
      });
      assert.equal(foreignCopy.statusCode, 423);
      assert.equal(foreignCopy.body.includes('Synthetic selected text'), false);
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
    clear: async (id) => {
      calls.push({ method: 'clear', input: id });
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

async function harness(
  control: {
    beforeFirstBridge?: Promise<void>;
    computer?: Computer | (() => Computer);
  } = {},
) {
  const root = await mkdtemp('/tmp/sk-browser-');
  const socketPath = join(root, 'control.sock');
  const instances = new Map<string, ReturnType<typeof workerComputer>>();
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: async (path) => {
      if (typeof control.computer === 'function') return control.computer();
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
      if (input.type === 'copy') return 'Synthetic selected text';
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
            assert.equal(await client.control('task', input), undefined);
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
    assert.equal(await client.control('task', { type: 'copy' }), 'Synthetic selected text');
    assert.deepEqual(inputs.pop(), { type: 'copy' });
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

for (const successful of [true, false])
  test(`a cancelled ${successful ? 'successful' : 'cancelled'} bridge response fences later actions`, async () => {
    const entered = deferred<string>();
    let launches = 0;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    child.stdin.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).trim().split('\n')) {
        const frame = JSON.parse(line);
        if (frame.type === 'request') entered.resolve(frame.request.id);
      }
    });
    const computer = createBridgeComputer({
      namespace: 'sk-000000000000000000000001',
      launch: () => {
        launches++;
        return child as never;
      },
    });
    const controller = new AbortController();
    const pending = computer.act(
      'task',
      { action: 'click', selector: '#submit' },
      controller.signal,
    );
    const id = await entered.promise;
    child.stdout.write(
      JSON.stringify(
        successful
          ? {
              id,
              ok: true,
              result: { text: 'Done', url: 'https://example.com' },
              metadata: { status: 'succeeded' },
            }
          : { id, ok: false, error: 'cancelled', metadata: { status: 'cancelled' } },
      ) + '\n',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    child.emit('close', 0);
    await assert.rejects(pending, /Browser operation cancelled/);
    await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
    assert.equal(launches, 1);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  });

test('read-only cancellation preserves an existing mutation fence', async () => {
  const entered: string[] = [];
  const waiting: Array<() => void> = [];
  const children: Array<ReturnType<typeof fakeBridge>> = [];
  function fakeBridge() {
    return Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
  }
  const computer = createBridgeComputer({
    namespace: 'sk-000000000000000000000002',
    launch: () => {
      const child = fakeBridge();
      children.push(child);
      child.stdin.on('data', (chunk: Buffer) => {
        for (const line of String(chunk).trim().split('\n')) {
          const frame = JSON.parse(line);
          if (frame.type === 'request') {
            entered.push(frame.request.id);
            waiting.shift()?.();
          }
        }
      });
      return child as never;
    },
  });
  const request = (input: BrowserAction, signal: AbortSignal) => {
    const ready = new Promise<void>((resolve) => waiting.push(resolve));
    const pending = computer.act('task', input, signal);
    return { pending, ready };
  };
  const mutation = new AbortController();
  const first = request({ action: 'click', selector: '#submit' }, mutation.signal);
  await first.ready;
  const observation = new AbortController();
  const secondReady = new Promise<void>((resolve) => waiting.push(resolve));
  const secondPending = computer.screenshot('task', observation.signal);
  await secondReady;
  mutation.abort();
  observation.abort();
  const firstRejected = assert.rejects(first.pending, /cancelled/);
  const secondRejected = assert.rejects(secondPending, /cancelled/);
  for (const [index, child] of children.entries()) {
    const id = entered[index]!;
    child.stdout.write(
      JSON.stringify({ id, ok: false, error: 'cancelled', metadata: { status: 'cancelled' } }) +
        '\n',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    child.emit('close', 0);
  }
  await firstRejected;
  await secondRejected;
  await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
  assert.equal(children.length, 2);
  for (const child of children) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
});

test(
  'cancelling and reopening one browser keeps other sessions in the same namespace running',
  { timeout: 10_000 },
  async () => {
    const fixture = await harness();
    const dataRoot = '/synthetic/parallel-cancellation';
    const computer = fixture.client(dataRoot);
    const entered = deferred();
    const chatEntered = deferred();
    const releaseChat = deferred();
    let chatSignal: AbortSignal | undefined;
    try {
      await computer.act('chat', { action: 'snapshot' });
      const instance = fixture.instance(dataRoot);
      instance.setAct(async (id, input, signal) => {
        if (id === 'task' && input.action === 'click') {
          entered.resolve();
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
          );
        }
        if (id === 'chat' && input.action === 'wait') {
          chatSignal = signal;
          chatEntered.resolve();
          await releaseChat.promise;
        }
        return { text: id, url: 'https://example.com' };
      });
      const controller = new AbortController();
      const cancelled = assert.rejects(
        computer.act('task', { action: 'click', selector: '#submit' }, controller.signal),
        /cancelled/,
      );
      await entered.promise;
      controller.abort();
      await cancelled;
      await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
      assert.equal((await computer.act('chat', { action: 'snapshot' })).text, 'chat');
      const chat = computer.act('chat', { action: 'wait' });
      await chatEntered.promise;
      await computer.act('task', { action: 'open', url: 'https://example.com/reopened' });
      assert.equal(chatSignal?.aborted, false);
      assert.equal(fixture.instance(dataRoot), instance);
      assert.deepEqual(
        instance.calls.filter(({ method }) => method === 'clear'),
        [{ method: 'clear', input: 'task' }],
      );
      assert.equal(
        instance.calls.some(({ method }) => method === 'dispose'),
        false,
      );
      releaseChat.resolve();
      assert.equal((await chat).text, 'chat');
      assert.equal((await computer.act('chat', { action: 'snapshot' })).text, 'chat');
    } finally {
      releaseChat.resolve();
      await fixture.close();
    }
  },
);

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
  'native handoff clicks stay aligned and copy preserves clipboard contents',
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
      if (process.platform === 'linux') {
        const initial = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const source = document.createElement('textarea');
          source.id = 'copy-source';
          source.value = 'Before Synthetic selected text After';
          document.body.append(source);
          source.focus();
          source.setSelectionRange(7, 30);
          return source.value.slice(source.selectionStart, source.selectionEnd);
        })()`,
        });
        assert.equal(initial.result, 'Synthetic selected text');
        assert.equal(
          await computer.control!('pointer', { type: 'copy' }),
          'Synthetic selected text',
        );
        await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const previous = document.createElement('textarea');
          previous.value = 'Prior remote clipboard';
          previous.addEventListener('copy', event => {
            window.seededRichCopy = true;
            event.clipboardData.setData('text/plain', 'Prior remote clipboard');
            event.clipboardData.setData('text/html', '<strong>Prior remote clipboard</strong>');
            event.preventDefault();
          });
          document.body.append(previous);
          previous.focus();
          previous.select();
        })()`,
        });
        await computer.control!('pointer', { type: 'key', key: 'Control+c' });
        const seeded = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: 'window.seededRichCopy === true',
        });
        assert.equal(seeded.result, true);
        const selected = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const source = document.querySelector('#copy-source');
          source.focus();
          source.setSelectionRange(7, 30);
          return source.value.slice(source.selectionStart, source.selectionEnd);
        })()`,
        });
        assert.equal(selected.result, 'Synthetic selected text');
        assert.equal(
          await computer.control!('pointer', { type: 'copy' }),
          'Synthetic selected text',
        );
        const cleared = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const source = document.querySelector('#copy-source');
          source.setSelectionRange(source.value.length, source.value.length);
          document.body.tabIndex = -1;
          document.body.focus();
          getSelection().removeAllRanges();
          return source.selectionStart === source.selectionEnd && document.activeElement === document.body && !getSelection().toString();
        })()`,
        });
        assert.equal(cleared.result, true);
        assert.equal(await computer.control!('pointer', { type: 'copy' }), undefined);
        await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const destination = document.createElement('div');
          destination.id = 'copy-destination';
          destination.contentEditable = 'true';
          document.body.append(destination);
          destination.focus();
        })()`,
        });
        await computer.control!('pointer', {
          type: 'key',
          key: 'Control+v',
        });
        const pasted = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const destination = document.querySelector('#copy-destination');
          return { text: destination.textContent, rich: Boolean(destination.querySelector('strong')) };
        })()`,
        });
        assert.deepEqual(pasted.result, { text: 'Prior remote clipboard', rich: true });
        await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const previous = document.createElement('textarea');
          previous.value = 'Prior rich only';
          previous.addEventListener('copy', event => {
            window.seededRichOnly = true;
            event.clipboardData.setData('text/html', '<strong>Prior rich only</strong>');
            event.preventDefault();
          });
          const replacement = document.createElement('textarea');
          replacement.value = 'Replacement rich only';
          replacement.addEventListener('copy', event => {
            window.copiedRichOnly = true;
            event.clipboardData.setData('text/html', '<em>Replacement rich only</em>');
            event.preventDefault();
          });
          document.body.append(previous, replacement);
          previous.focus();
          previous.select();
          window.richOnlyReplacement = replacement;
        })()`,
        });
        await computer.control!('pointer', { type: 'key', key: 'Control+c' });
        await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const probe = document.createElement('div');
          probe.contentEditable = 'true';
          probe.addEventListener('paste', event => {
            window.richOnlyClipboard = {
              plain: event.clipboardData.getData('text/plain'),
              types: [...event.clipboardData.types],
            };
          });
          document.body.append(probe);
          probe.focus();
        })()`,
        });
        await computer.control!('pointer', { type: 'key', key: 'Control+v' });
        const richOnlySeeded = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          window.richOnlyReplacement.focus();
          window.richOnlyReplacement.select();
          return { seeded: window.seededRichOnly === true, clipboard: window.richOnlyClipboard };
        })()`,
        });
        const richOnlyState = richOnlySeeded.result as {
          seeded: boolean;
          clipboard: { plain: string; types: string[] };
        };
        assert.equal(richOnlyState.seeded, true);
        assert.equal(richOnlyState.clipboard.plain, '');
        assert.equal(richOnlyState.clipboard.types.includes('text/html'), true);
        assert.equal(richOnlyState.clipboard.types.includes('text/plain'), false);
        assert.equal(await computer.control!('pointer', { type: 'copy' }), undefined);
        const richOnlyCopied = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => {
          const destination = document.createElement('div');
          destination.contentEditable = 'true';
          document.body.append(destination);
          destination.focus();
          window.richOnlyDestination = destination;
          return window.copiedRichOnly === true;
        })()`,
        });
        assert.equal(richOnlyCopied.result, true);
        await computer.control!('pointer', { type: 'key', key: 'Control+v' });
        const restoredRichOnly = await existingDaemonCommand(socketPath, {
          action: 'evaluate',
          script: `(() => ({
          text: window.richOnlyDestination.textContent,
          prior: Boolean(window.richOnlyDestination.querySelector('strong')),
          replacement: Boolean(window.richOnlyDestination.querySelector('em')),
        }))()`,
        });
        assert.deepEqual(restoredRichOnly.result, {
          text: 'Prior rich only',
          prior: true,
          replacement: false,
        });
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

test('rich feedback redaction handles embedded JSON, identifying addresses, encoded secrets and binary', async () => {
  const { createFeedbackRedactor } = await import('../src/server/feedback-redaction.ts');
  const redactor = createFeedbackRedactor({
    secrets: ['fixture/secret-token'],
    profile: { names: ['Marta Vidal'], region: 'ES' },
  });
  const values = [
    'Useful result: {"name":"Synthetic Third Person","email":"third.person@example.test","arguments":{"api_key":"embedded-api-secret","query":"recent messages"}} end.',
    JSON.stringify(
      JSON.stringify({
        display_name: 'Another Synthetic Person',
        address: 'Private Street 14',
        input: { action: 'read', password: 'embedded-password' },
      }),
    ),
    'GET "https://private-user.custom.example.test/private-person?query=patient-data" failed with HTTP 404.',
    'Open /api/accounts/private-account/files/private-file?query=private-query failed.',
    'File "C:\\Users\\Private Owner\\Secret Folder\\report.txt" could not be read.',
    'Working directory /home/private-owner/project failed.',
    'ENOENT /home/alice/Private Project/log.txt\nRetry was not attempted.',
    'EACCES C:\\Users\\unknown-other\\Shared Folder\\Ada Lovelace\\report.txt\nAccess is unavailable.',
    'Open /Users/Marta Vidal/Archived Notes/private.txt\nHTTP 418.',
    'Open C:/Users/unknown-other/Client Records/Design Review.txt\nHTTP 502.',
    "Open /home/alice/O'Brien Private Files/readme.txt\nHTTP 409.",
    'Open file:///home/alice/Private Project/log.txt\nFile lookup failed.',
    'Open file:///home/alice/Private%20Project/log.txt\nFile lookup failed.',
    'Open https://tenant.example.test/Private%20Project/Personal%20Notes/log.txt\nHTTP 410.',
    'Open https%3A%2F%2Ftenant.example.test%2FPrivate%20Project%2FPersonal%20Notes%2Flog.txt\nHTTP 411.',
    'Open "file:///home/alice/Private%20Project/log.txt" failed with ENOENT.',
    'Open "https://tenant.example.test/Personal%20Notes/log.txt" failed with HTTP 412.',
    'Rejected fixture%2fsecret-token and marta.vidal%40example.test.',
    'External record 00000000-1111-4222-8333-444444444444 was not found.',
    { type: 'image', data: 'synthetic-private-image' },
    {
      content: [
        {
          type: 'image',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=',
          mimeType: 'image/png',
        },
        { type: 'audio', data: 'c3ludGhldGljIGF1ZGlv', mimeType: 'audio/wav' },
        { type: 'text', text: 'The screenshot request completed after 421 ms.' },
      ],
    },
    { document: Buffer.from('synthetic-buffer-value') },
    'data:image/png;base64,' + 'Z'.repeat(500),
    'Encoded output: ' + 'Y'.repeat(512),
  ];
  const safe = redactor.value(values);
  const encoded = JSON.stringify(safe);
  for (const sensitive of [
    'Synthetic Third Person',
    'third.person',
    'embedded-api-secret',
    'Another Synthetic Person',
    'Private Street',
    'embedded-password',
    'private-user',
    'private-person',
    'patient-data',
    'private-account',
    'private-file',
    'private-query',
    'Private Owner',
    'Secret Folder',
    'private-owner',
    'alice',
    'Project/log',
    'Project',
    'Personal',
    'tenant.example',
    'unknown-other',
    'Shared Folder',
    'Ada Lovelace',
    'Archived Notes',
    'Client Records',
    'Design Review',
    'Private Files',
    'fixture',
    'marta.vidal',
    '00000000-1111',
    'synthetic-private-image',
    'iVBORw0KGgoAAAANS',
    'c3ludGhldGljIGF1ZGlv',
    'synthetic-buffer-value',
    'Z'.repeat(20),
    'Y'.repeat(20),
  ])
    assert.ok(!encoded.includes(sensitive), sensitive);
  for (const useful of [
    'Useful result',
    'recent messages',
    'action',
    'read',
    'HTTP 404',
    'could not be read',
    'was not found',
    '421 ms',
    'ENOENT',
    'EACCES',
    'Retry was not attempted',
    'Access is unavailable',
    'HTTP 418',
    'HTTP 502',
    'HTTP 409',
    'File lookup failed',
    'HTTP 410',
    'HTTP 411',
    'HTTP 412',
  ])
    assert.ok(encoded.includes(useful), useful);
  const concealedType = createFeedbackRedactor({ secrets: ['image'], profile: { names: [] } });
  assert.ok(
    !JSON.stringify(concealedType.value({ type: 'image', data: 'c3ludGhldGljIGltYWdl' })).includes(
      'c3ludGhldGljIGltYWdl',
    ),
  );
});

test('rich feedback redaction bounds traversal and preserves sanitized Error diagnostics without getters', async () => {
  const { createFeedbackRedactor } = await import('../src/server/feedback-redaction.ts');
  const redactor = createFeedbackRedactor({
    secrets: ['bounded-private-secret'],
    profile: { names: ['Marta Vidal'], region: 'ES' },
  });
  let invoked = 0;
  const cause = Object.assign(new Error('HTTP request for marta.vidal@example.test failed'), {
    code: 'ETIMEDOUT',
  });
  const error = Object.assign(new Error('Browser failed with bounded-private-secret', { cause }), {
    statusCode: 503,
  });
  Object.defineProperty(error, 'name', { value: 'ConnectionError' });
  Object.defineProperty(error, 'stack', {
    get() {
      invoked++;
      return 'getter-private-stack';
    },
  });
  const unsafeError = new Error();
  Object.defineProperty(unsafeError, 'message', {
    get() {
      invoked++;
      return 'getter-private-message';
    },
  });
  const payload = {
    error,
    unsafeError,
    frontendError: {
      message: 'Render failed',
      stack:
        'Error: Render failed\n    at render (file:///Users/private-owner/Private Project/src/web/app.tsx:13:27)\n    at /home/private-owner/private-project/worker.ts:18:4',
    },
    tools: Array.from({ length: 1000 }, () => ({ action: 'read', output: 'Useful diagnostic' })),
    binary: new Uint8Array([1, 2, 3]),
  };
  Object.defineProperty(payload, 'privateGetter', {
    enumerable: true,
    get() {
      invoked++;
      return 'getter-private-value';
    },
  });
  Object.defineProperty(payload, 'toJSON', {
    value() {
      invoked++;
      return 'private-tojson';
    },
  });
  const safe = redactor.value(payload) as any;
  assert.equal(invoked, 0);
  assert.equal(safe.error.name, 'ConnectionError');
  assert.equal(safe.error.statusCode, 503);
  assert.equal(safe.error.cause.code, 'ETIMEDOUT');
  assert.ok(safe.error.cause.stack.includes('HTTP request'));
  assert.ok(safe.frontendError.stack.includes(':13:27'));
  assert.ok(safe.frontendError.stack.includes(':18:4'));
  assert.ok(!JSON.stringify(safe).includes('private-owner'));
  assert.ok(!JSON.stringify(safe).includes('Private Project'));
  assert.ok(!JSON.stringify(safe).includes('private-project'));
  assert.ok(safe.error.message.includes('Browser failed'));
  assert.ok(!JSON.stringify(safe).includes('bounded-private-secret'));
  assert.ok(!JSON.stringify(safe).includes('marta.vidal'));
  assert.ok(safe.tools.length <= 101);
  const cyclic: Record<string, unknown> = { result: 'Useful output' };
  cyclic.cycle = cyclic;
  assert.ok(JSON.stringify(redactor.value(cyclic)).includes('[circular]'));
  assert.ok(
    Buffer.byteLength(JSON.stringify(redactor.value({ large: 'diagnostic '.repeat(100_000) }))) <
      64_000,
  );
  assert.ok(
    !redactor
      .text('partial {"password":"bounded-private-secret')
      .includes('bounded-private-secret'),
  );
  const boundary = redactor.text(
    'diagnostic '.repeat(2800) + ' marta.vidal@example.test bounded-private-secret',
  );
  assert.ok(boundary.includes('diagnostic'));
  assert.ok(!boundary.includes('marta.vidal'));
  assert.ok(!boundary.includes('bounded-private-secret'));
});

test('browser handoff preserves platform editing chords, text input and paste', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
        'Event', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollIntoView = () => {};
      URL.createObjectURL = () => 'blob:synthetic-browser-frame';
      URL.revokeObjectURL = () => {};
      const received = [];
      const clipboardWrites = [];
      let clipboardText = 'Existing clipboard';
      let copiedText = 'Synthetic selected text';
      let copyResponseGate;
      let copyRequestFails = false;
      let delayedCopySignal;
      let nextInputReceived;
      let closeHandoffStream;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async text => { clipboardText = text; clipboardWrites.push(text); } },
      });
      globalThis.fetch = async (path, options) => {
        if (path.startsWith('/api/browser-handoff/stream?'))
          return new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array([0, 0, 0, 1, 0]));
            closeHandoffStream = () => controller.error(new DOMException('Handoff ended.', 'AbortError'));
            options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
          } }));
        assert.equal(path, '/api/browser-handoff');
        const inputs = JSON.parse(options.body).inputs;
        received.push(...inputs);
        if (inputs.some(input => input.type === 'text' && input.text === 'x'))
          nextInputReceived?.();
        if (inputs.some(input => input.type === 'copy')) {
          if (copyResponseGate) {
            delayedCopySignal = options.signal;
            await copyResponseGate;
          }
          if (copyRequestFails)
            return Response.json({ error: 'Synthetic copy failure' }, { status: 409 });
        }
        return Response.json({
          ok: true,
          ...(inputs.some(input => input.type === 'copy') && copiedText !== undefined
            ? { copiedText }
            : {}),
        });
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { BrowserHandoff } = await import('./src/web/components/browser-handoff.tsx');
      const root = createRoot(document.querySelector('#root'));
      try {
        await act(async () => root.render(createElement(BrowserHandoff, { turnId: 'synthetic-turn' })));
        const frame = document.querySelector('.browser-handoff-screen img');
        assert.equal(frame.src, 'blob:synthetic-browser-frame');
        await act(async () => frame.dispatchEvent(new Event('load')));
        let screen = document.querySelector('.browser-handoff-screen');
        assert.equal(screen.getAttribute('aria-disabled'), 'false');
        let dispatchingKey = false;
        const key = async (key, options = {}) => {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
          if (options.altGraph) Object.defineProperty(event, 'getModifierState', { value: name => name === 'AltGraph' });
          await act(async () => {
            dispatchingKey = true;
            try { screen.dispatchEvent(event); }
            finally { dispatchingKey = false; }
          });
          return event.defaultPrevented;
        };
        for (const platform of ['MacIntel', 'Win32']) {
          Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
          const primary = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true };
          const other = platform === 'MacIntel' ? { ctrlKey: true } : { metaKey: true };
          received.length = 0;
          assert.equal(await key('z', primary), true);
          assert.equal(await key('Z', { ...primary, shiftKey: true }), true);
          assert.equal(await key('ArrowLeft', { shiftKey: true }), true);
          assert.equal(await key('Tab', { shiftKey: true }), true);
          assert.equal(await key('A', { shiftKey: true }), true);
          assert.deepEqual(received, [
            { type: 'key', key: 'Control+z' },
            { type: 'key', key: 'Control+Shift+z' },
            { type: 'key', key: 'Shift+ArrowLeft' },
            { type: 'key', key: 'Shift+Tab' },
            { type: 'text', text: 'A' },
          ]);
          received.length = 0;
          assert.equal(await key('z', other), false);
          assert.equal(await key('z', { ctrlKey: true, metaKey: true }), false);
          assert.equal(await key('v', primary), false);
          assert.equal(await key('V', { ...primary, shiftKey: true }), false);
          assert.deepEqual(received, []);
          clipboardWrites.length = 0;
          assert.equal(await key('c', primary), true);
          assert.deepEqual(clipboardWrites, ['Synthetic selected text']);
          assert.deepEqual(received, [{ type: 'copy' }]);
          received.length = 0;
          clipboardWrites.length = 0;
          copiedText = undefined;
          assert.equal(await key('c', primary), true);
          assert.deepEqual(clipboardWrites, []);
          assert.deepEqual(received, [{ type: 'copy' }]);
          received.length = 0;
          copiedText = 'Synthetic selected text';
          const pasted = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(pasted, 'clipboardData', { value: { getData: () => 'First\r\nSecond\n' } });
          await act(async () => screen.dispatchEvent(pasted));
          assert.equal(pasted.defaultPrevented, true);
          assert.deepEqual(received, [{ type: 'text', text: 'First\nSecond' }]);
          received.length = 0;
          if (platform === 'MacIntel') {
            assert.equal(await key('ë', { altKey: true }), true);
            assert.deepEqual(received, [{ type: 'text', text: 'ë' }]);
          } else {
            assert.equal(await key('€', { ctrlKey: true, altKey: true, altGraph: true }), true);
            assert.deepEqual(received, [{ type: 'text', text: '€' }]);
            assert.equal(await key('e', { altKey: true }), false);
            assert.equal(received.length, 1);
          }
        }
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        globalThis.ClipboardItem = class {
          constructor(data) { this.data = data; }
        };
        const nativeItems = [];
        const nativeWrites = [];
        let stallNativeWrite = false;
        navigator.clipboard.write = items => {
          nativeItems.push({ items, duringKey: dispatchingKey });
          const data = items[0].data['text/plain'];
          assert.ok(data instanceof Promise);
          const stall = stallNativeWrite;
          const writing = data.then(blob => blob.text()).then(text => {
            clipboardText = text;
            clipboardWrites.push(text);
            if (stall) return new Promise(() => {});
          });
          nativeWrites.push(writing.then(() => true, () => false));
          return writing;
        };
        let releaseCopy;
        copyResponseGate = new Promise(resolve => { releaseCopy = resolve; });
        received.length = 0;
        clipboardWrites.length = 0;
        const beforeCopy = clipboardText;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.deepEqual(received, [{ type: 'copy' }]);
        assert.equal(nativeItems.at(-1).duringKey, true);
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, beforeCopy);
        releaseCopy();
        copyResponseGate = undefined;
        assert.equal(await nativeWrites.at(-1), true);
        assert.deepEqual(clipboardWrites, ['Synthetic selected text']);
        assert.equal(clipboardText, 'Synthetic selected text');
        stallNativeWrite = true;
        received.length = 0;
        clipboardWrites.length = 0;
        const nextInput = new Promise(resolve => { nextInputReceived = resolve; });
        assert.equal(await key('c', { metaKey: true }), true);
        assert.equal(await key('x'), true);
        let inputTimeout;
        try {
          await Promise.race([
            nextInput,
            new Promise((_, reject) => {
              inputTimeout = setTimeout(() => reject(new Error('Clipboard write blocked later input.')), 2_000);
            }),
          ]);
        } finally {
          clearTimeout(inputTimeout);
          nextInputReceived = undefined;
        }
        assert.deepEqual(received, [{ type: 'copy' }, { type: 'text', text: 'x' }]);
        assert.deepEqual(clipboardWrites, ['Synthetic selected text']);
        stallNativeWrite = false;
        clipboardText = 'Existing clipboard';
        clipboardWrites.length = 0;
        copiedText = undefined;
        received.length = 0;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.equal(await nativeWrites.at(-1), false);
        assert.deepEqual(received, [{ type: 'copy' }]);
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, 'Existing clipboard');
        copyRequestFails = true;
        received.length = 0;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.equal(await nativeWrites.at(-1), false);
        assert.deepEqual(received, [{ type: 'copy' }]);
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, 'Existing clipboard');
        copyRequestFails = false;
        copiedText = 'Stale selected text';
        let releaseClosedCopy;
        copyResponseGate = new Promise(resolve => { releaseClosedCopy = resolve; });
        await act(async () => root.render(createElement(BrowserHandoff, { key: 'closed-state', turnId: 'closed-state' })));
        const closedFrame = document.querySelector('.browser-handoff-screen img');
        await act(async () => closedFrame.dispatchEvent(new Event('load')));
        screen = document.querySelector('.browser-handoff-screen');
        received.length = 0;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.deepEqual(received, [{ type: 'copy' }]);
        const closedWrite = nativeWrites.at(-1);
        const closedSignal = delayedCopySignal;
        await act(async () => {
          closeHandoffStream();
          for (let flush = 0; flush < 6; flush++) await Promise.resolve();
          releaseClosedCopy();
          copyResponseGate = undefined;
          await new Promise(resolve => setTimeout(resolve, 0));
        });
        assert.match(document.querySelector('.browser-handoff-feedback').textContent, /ended/);
        assert.equal(closedSignal.aborted, true);
        assert.equal(await closedWrite, false);
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, 'Existing clipboard');
        copiedText = 'Stale selected text';
        let releaseStaleCopy;
        copyResponseGate = new Promise(resolve => { releaseStaleCopy = resolve; });
        await act(async () => root.render(createElement(BrowserHandoff, { key: 'stale-native', turnId: 'stale-native' })));
        const staleNativeFrame = document.querySelector('.browser-handoff-screen img');
        await act(async () => staleNativeFrame.dispatchEvent(new Event('load')));
        screen = document.querySelector('.browser-handoff-screen');
        received.length = 0;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.deepEqual(received, [{ type: 'copy' }]);
        const staleNativeWrite = nativeWrites.at(-1);
        const staleNativeSignal = delayedCopySignal;
        await act(async () => root.render(createElement('div')));
        assert.equal(staleNativeSignal.aborted, true);
        releaseStaleCopy();
        copyResponseGate = undefined;
        assert.equal(await staleNativeWrite, false);
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, 'Existing clipboard');
        globalThis.ClipboardItem = undefined;
        navigator.clipboard.write = undefined;
        let releaseStaleFallback;
        copyResponseGate = new Promise(resolve => { releaseStaleFallback = resolve; });
        await act(async () => root.render(createElement(BrowserHandoff, { key: 'stale-fallback', turnId: 'stale-fallback' })));
        const staleFallbackFrame = document.querySelector('.browser-handoff-screen img');
        await act(async () => staleFallbackFrame.dispatchEvent(new Event('load')));
        screen = document.querySelector('.browser-handoff-screen');
        received.length = 0;
        assert.equal(await key('c', { metaKey: true }), true);
        assert.deepEqual(received, [{ type: 'copy' }]);
        const staleFallbackSignal = delayedCopySignal;
        await act(async () => root.render(createElement('div')));
        assert.equal(staleFallbackSignal.aborted, true);
        releaseStaleFallback();
        copyResponseGate = undefined;
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.deepEqual(clipboardWrites, []);
        assert.equal(clipboardText, 'Existing clipboard');
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('voice previews sample unsaved voices and cancel stale playback on selection and close', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
        'Event', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      Object.defineProperty(navigator, 'language', { configurable: true, value: 'pt-PT' });
      window.HTMLElement.prototype.getClientRects = function() { return [{ top: 0, bottom: 40, left: 0, right: 300 }]; };
      const requests = [], writes = [], players = [], revoked = [], preparations = [], busy = [], saves = [];
      let delaySave = false, failSave = false;
      let failConnection = true, delayCatalog = false, addConnectedVoice = false;
      const catalogs = [];
      const connections = [], connectionWrites = [];
      window.open = () => ({ opener: null, location: { replace() {} }, close() {} });
      URL.createObjectURL = () => 'blob:preview-' + players.length;
      URL.revokeObjectURL = url => revoked.push(url);
      globalThis.Audio = function(url) {
        const player = document.createElement('audio');
        player.src = url;
        player.playing = false;
        player.play = async () => { player.playing = true; };
        player.pause = () => { player.playing = false; };
        player.load = () => {};
        players.push(player);
        return player;
      };
      let settings = { transcription: true, synthesis: true, speechReply: 'voice', speechVoice: 'local:pf_dora',
        local: { state: 'ready' }, localInput: { state: 'ready' },
        defaultVoice: 'local:pf_dora', voices: [
          { id: 'local:pm_alex', name: 'Alex', description: 'Brazilian Portuguese', engine: 'Local', language: 'pt-BR' },
          { id: 'local:af_heart', name: 'Heart', description: 'American English', engine: 'Kokoro', language: 'en-US' },
          { id: 'openai:coral', name: 'Coral', description: 'Warm and friendly', engine: 'OpenAI' },
          { id: 'local:pf_dora', name: 'Dora', description: 'Brazilian Portuguese', engine: 'Local', language: 'pt-BR' },
        ] };
      globalThis.fetch = (path, options) => {
        if (path === '/api/speech') return Promise.resolve(Response.json(settings));
        if (path === '/api/models') return Promise.resolve(Response.json({ connections, selection: null }));
        if (path === '/api/speech/voices/refresh') {
          const snapshot = structuredClone(settings);
          if (delayCatalog) return new Promise(resolve => catalogs.push({ complete: () => resolve(Response.json(snapshot)) }));
          return Promise.resolve(Response.json(snapshot));
        }
        if (path === '/api/models/keys' || path === '/api/models/oauth/complete') {
          connectionWrites.push({ path, body: JSON.parse(options.body) });
          if (!failConnection && addConnectedVoice) {
            settings = { ...settings, voices: [...settings.voices, { id: 'openai:cedar', name: 'Cedar', description: 'Newly connected', engine: 'OpenAI' }] };
            addConnectedVoice = false;
          }
          return Promise.resolve(failConnection ? Response.json({ error: 'Synthetic connection failure' }, { status: 400 }) : Response.json({ connections, selection: null }));
        }
        if (path === '/api/models/oauth') {
          connectionWrites.push({ path, body: JSON.parse(options.body) });
          return Promise.resolve(Response.json({ url: 'https://nod.fixture.invalid/oauth', attempt: '60000000-0000-4000-8000-000000000001' }));
        }
        if (path.startsWith('/api/models/oauth/status/')) return Promise.resolve(Response.json({ status: 'pending' }));
        if (path.startsWith('/api/models/oauth/') && options.method === 'DELETE') return Promise.resolve(Response.json({ ok: true }));
        if (path === '/api/speech/prepare') return new Promise((resolve, reject) => {
          preparations.push({ options, resolve });
          options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
        });
        if (path === '/api/preferences') {
          const change = JSON.parse(options.body);
          writes.push(change);
          const complete = () => {
            if (failSave) return Response.json({ error: 'Synthetic preference failure' }, { status: 503 });
            settings = { ...settings, ...change }; return Response.json(settings);
          };
          if (delaySave) return new Promise(resolve => saves.push({ options, complete: () => resolve(complete()) }));
          return Promise.resolve(complete());
        }
        assert.equal(path, '/api/speech/preview');
        return new Promise(resolve => requests.push({ options, resolve }));
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { VoiceSettings } = await import('./src/web/components/voice-settings.tsx');
      const { SettingsDraftContext } = await import('./src/web/components/settings-drafts.tsx');
      const drafts = new Map();
      const register = draft => { drafts.set(draft.id, draft); return () => { if (drafts.get(draft.id)?.revision === draft.revision) drafts.delete(draft.id); }; };
      let root = createRoot(document.querySelector('#root'));
      let mounted = true;
      const onBusyChange = value => busy.push(value);
      const render = () => act(async () => root.render(createElement(SettingsDraftContext.Provider, { value: register }, createElement(VoiceSettings, { onBusyChange }))));
      const settle = async check => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
        assert.ok(check(), 'Expected voice preview interaction to settle');
      };
      const trigger = () => document.querySelector('.voice-picker-trigger');
      const dialog = label => [...document.querySelectorAll('[role="dialog"]')].find(element =>
        element.getAttribute('aria-labelledby')?.split(/\s+/).some(id => document.getElementById(id)?.textContent === label));
      const picker = () => document.querySelector('[role="menu"][aria-label="Choose voice"]');
      const close = async () => {
        await act(async () => picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        await settle(() => !picker());
      };
      const click = (label, scope = document) => act(async () => {
        const button = scope.querySelector('[aria-label="' + label + '"]');
        assert.ok(button, 'Expected button: ' + label);
        button.click();
      });
      const open = async () => {
        await act(async () => trigger().click());
        await settle(() => picker());
      };
      const openKeyboard = async key => {
        await act(async () => {
          trigger().focus();
          trigger().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
        });
        await settle(() => picker());
      };
      const resolve = index => act(async () => requests[index].resolve(new Response(new Blob(['Synthetic audio'], { type: 'audio/wav' }))));
      const released = (player, url) => {
        assert.equal(player.playing, false);
        assert.equal(player.getAttribute('src'), null);
        assert.equal(revoked.filter(value => value === url).length, 1);
      };
      const dora = 'Dora sample, Brazilian Portuguese';
      const alex = 'Alex sample, Brazilian Portuguese';
      try {
        await render();
        await settle(() => trigger());
        assert.equal(document.querySelector('textarea'), null);
        await act(async () => {
          trigger().focus();
          trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        });
        await settle(() => picker());
        assert.equal(document.activeElement, picker().querySelector('input'));
        const search = picker().querySelector('input');
        await act(async () => {
          search.focus();
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, 'Alex');
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(picker().querySelectorAll('.voice-choice').length, 1);
        await act(async () => search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
        assert.equal(document.activeElement, picker().querySelector('.voice-choice'));
        await act(async () => {
          picker().querySelector('.voice-sample').focus();
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        });
        assert.equal(document.activeElement, picker().querySelector('.voice-choice'));
        await click('Clear voice search', picker());
        assert.equal(document.activeElement, search);
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, 'Kokoro');
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.equal(picker().querySelectorAll('.voice-choice').length, 1);
        assert.ok(picker().querySelector('[aria-label^="Choose Heart"]'));
        await click('Clear voice search', picker());
        await act(async () => {
          picker().querySelector('[aria-label^="Choose Coral"]').focus();
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true, cancelable: true }));
        });
        assert.equal(document.activeElement, picker().querySelector('[aria-label^="Choose Dora"]'));
        assert.deepEqual(writes, []);
        await click('Play ' + dora, picker());
        assert.deepEqual(JSON.parse(requests[0].options.body), { voice: 'local:pf_dora', locale: 'pt-PT' });
        assert.deepEqual(writes, []);
        assert.equal(settings.speechVoice, 'local:pf_dora');
        await click('Play ' + alex, picker());
        assert.equal(requests[0].options.signal.aborted, true);
        assert.deepEqual(JSON.parse(requests[1].options.body), { voice: 'local:pm_alex', locale: 'pt-PT' });
        await resolve(0);
        assert.equal(players.length, 0);
        await resolve(1);
        assert.equal(players[0].playing, true);
        const firstUrl = players[0].src;
        await click('Stop ' + alex, picker());
        released(players[0], firstUrl);
        await click('Play ' + dora, picker());
        await resolve(2);
        assert.equal(players[1].playing, true);
        const secondUrl = players[1].src;
        await act(async () => picker().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
        await settle(() => !picker());
        await settle(() => document.activeElement === trigger());
        released(players[1], secondUrl);
        assert.deepEqual(writes, []);
        await open();
        await click('Play ' + dora, picker());
        delaySave = true;
        await click('Choose Dora, Brazilian Portuguese, Free voices', picker());
        assert.equal(requests[3].options.signal.aborted, true);
        assert.ok(picker());
        assert.equal(busy.at(-1), true);
        assert.equal(saves[0].options.signal.aborted, false);
        await act(async () => saves[0].complete());
        delaySave = false;
        await settle(() => !picker() && settings.speechVoice === 'local:pf_dora');
        assert.deepEqual(writes, [{ speechVoice: 'local:pf_dora' }]);
        await resolve(3);
        assert.equal(players.length, 2);
        await settle(() => trigger().getAttribute('aria-disabled') !== 'true');
        await click('Play ' + dora);
        assert.deepEqual(JSON.parse(requests[4].options.body), { voice: 'local:pf_dora', locale: 'pt-PT' });
        await resolve(4);
        assert.equal(players[2].playing, true);
        const thirdUrl = players[2].src;
        await openKeyboard('ArrowUp');
        released(players[2], thirdUrl);
        await click('Play ' + alex, picker());
        await close();
        assert.equal(requests[5].options.signal.aborted, true);
        await resolve(5);
        assert.equal(players.length, 3);
        assert.deepEqual(writes, [{ speechVoice: 'local:pf_dora' }]);
        await settle(() => !picker());
        await click('Play ' + dora);
        await openKeyboard('ArrowDown');
        assert.equal(requests[6].options.signal.aborted, true);
        await resolve(6);
        assert.equal(players.length, 3);
        await close();
        await settle(() => !picker());
        await click('Play ' + dora);
        await act(async () => requests[7].resolve(Response.json({ error: 'Synthetic preview failure' }, { status: 503 })));
        assert.ok(document.body.textContent.includes('Synthetic preview failure'));
        assert.equal(requests.length, 8);
        assert.equal(settings.speechVoice, 'local:pf_dora');
        await openKeyboard('ArrowUp');
        assert.equal(settings.speechVoice, 'local:pf_dora');
        await close();
        await settle(() => !picker());
        await click('Play ' + dora);
        await resolve(8);
        const fourthUrl = players[3].src;
        await act(async () => root.unmount());
        mounted = false;
        released(players[3], fourthUrl);
        root = createRoot(document.querySelector('#root'));
        mounted = true;
        await render();
        await settle(() => trigger());
        await open();
        await click('Play ' + alex, picker());
        await act(async () => root.unmount());
        mounted = false;
        assert.equal(requests[9].options.signal.aborted, true);
        await resolve(9);
        assert.equal(players.length, 4);
        assert.deepEqual(writes, [{ speechVoice: 'local:pf_dora' }]);
        root = createRoot(document.querySelector('#root'));
        mounted = true;
        await render();
        await settle(() => trigger());
        const button = label => [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
        const downloadedVoices = settings.voices.filter(voice => voice.engine === 'Local');
        settings = { ...settings, speechVoice: 'openai:coral', local: { state: 'not_downloaded' },
          voices: settings.voices.filter(voice => voice.engine !== 'Local') };
        await act(async () => window.dispatchEvent(new Event('focus')));
        await settle(() => trigger().textContent.includes('Coral'));
        const beforeDownload = writes.length;
        await open();
        for (const outcome of ['cancel', 'failure', 'complete']) {
          const label = outcome === 'complete' ? 'Retry voice download' : 'Download free voices';
          await click(label, picker());
          const preparation = preparations.at(-1);
          assert.equal(busy.at(-1), true);
          assert.equal(preparation.options.signal.aborted, false);
          assert.equal(JSON.parse(preparation.options.body).inputOnly, undefined);
          if (outcome === 'cancel') {
            await click('Cancel voice download', picker());
            assert.equal(preparation.options.signal.aborted, true);
          } else if (outcome === 'failure') {
            await act(async () => preparation.resolve(Response.json({ error: 'Synthetic download failure' }, { status: 503 })));
          } else {
            settings = { ...settings, local: { state: 'downloading', progress: 100 } };
            await act(async () => window.dispatchEvent(new Event('focus')));
            await settle(() => picker().querySelector('[data-state="preparing"]'));
            assert.equal(picker().querySelector('[aria-label="Choose Dora, Brazilian Portuguese, Free voices"]'), null);
            assert.equal(settings.speechVoice, 'openai:coral');
            assert.equal(busy.at(-1), true);
            settings = { ...settings, local: { state: 'ready' }, voices: [...settings.voices, ...downloadedVoices] };
            await act(async () => preparation.resolve(Response.json({ local: { state: 'ready' } })));
          }
          await settle(() => busy.at(-1) === false);
          if (outcome === 'failure') assert.ok(document.body.textContent.includes('Synthetic download failure'));
          assert.equal(settings.speechVoice, 'openai:coral');
          assert.equal(writes.length, beforeDownload);
        }
        assert.ok(picker().querySelector('[aria-label="Choose Dora, Brazilian Portuguese, Free voices"]'));
        await click('Choose Dora, Brazilian Portuguese, Free voices', picker());
        await settle(() => !picker() && settings.speechVoice === 'local:pf_dora');
        assert.deepEqual(writes.at(-1), { speechVoice: 'local:pf_dora' });
        await open();
        assert.ok(picker().querySelector('[aria-label="Choose Coral, Warm and friendly, OpenAI"]'));
        await close();
        delaySave = true;
        failSave = true;
        await act(async () => button('Always').click());
        assert.equal(button('Always').getAttribute('aria-pressed'), 'true');
        assert.equal(settings.speechReply, 'voice');
        await act(async () => saves.at(-1).complete());
        await settle(() => busy.at(-1) === false);
        assert.equal(button('After audio').getAttribute('aria-pressed'), 'true');
        assert.equal(settings.speechReply, 'voice');
        assert.ok(document.body.textContent.includes('Synthetic preference failure'));
        failSave = false;
        delaySave = false;
        await act(async () => button('Auto').click());
        await settle(() => settings.speechReply === 'auto' && busy.at(-1) === false);
        assert.deepEqual(writes.at(-1), { speechReply: 'auto' });
        await open();
        const voiceSearch = picker().querySelector('input');
        await act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(voiceSearch, 'Coral');
          voiceSearch.dispatchEvent(new Event('input', { bubbles: true }));
        });
        delaySave = true;
        failSave = true;
        const failedChoice = picker().querySelector('[aria-label="Choose Coral, Warm and friendly, OpenAI"]');
        await act(async () => failedChoice.focus());
        await click('Choose Coral, Warm and friendly, OpenAI', picker());
        assert.ok(picker());
        assert.equal(failedChoice.getAttribute('aria-disabled'), 'true');
        await act(async () => saves.at(-1).complete());
        await settle(() => busy.at(-1) === false);
        assert.equal(picker().querySelector('input').value, 'Coral');
        assert.equal(document.activeElement, failedChoice);
        assert.ok(picker().querySelector('[role="alert"]'));
        assert.equal(settings.speechVoice, 'local:pf_dora');
        failSave = false;
        delaySave = false;
        await click('Choose Coral, Warm and friendly, OpenAI', picker());
        await settle(() => !picker() && settings.speechVoice === 'openai:coral');
        const beforeCatalogLoss = writes.length;
        settings = { ...settings, speechVoice: 'elevenlabs-direct:saved' };
        await act(async () => window.dispatchEvent(new Event('focus')));
        await settle(() => document.querySelector('.voice-settings > .field-hint[role="status"]'));
        assert.equal(document.querySelector('.voice-settings-choice .voice-sample').disabled, true);
        assert.equal(writes.length, beforeCatalogLoss);
        await open();
        assert.equal(picker().querySelector('[aria-checked="true"]'), null);
        await close();
        settings = { ...settings, voices: [...settings.voices, { id: 'elevenlabs-direct:replacement', name: 'Replacement', description: 'Warm', engine: 'ElevenLabs', source: 'elevenlabs' }] };
        await act(async () => window.dispatchEvent(new Event('focus')));
        await open();
        await click('Choose Replacement, Warm, ElevenLabs', picker());
        await settle(() => settings.speechVoice === 'elevenlabs-direct:replacement');
        assert.deepEqual(writes.at(-1), { speechVoice: 'elevenlabs-direct:replacement' });
        await open();
        await act(async () => [...picker().querySelectorAll('.voice-choice')].find(item => item.textContent.startsWith('Automatic')).click());
        await settle(() => settings.speechVoice === null && busy.at(-1) === false);
        assert.deepEqual(writes.at(-1), { speechVoice: null });
        const beforeAutomaticSample = writes.length;
        await click('Play ' + dora);
        assert.deepEqual(JSON.parse(requests.at(-1).options.body), { voice: 'local:pf_dora', locale: 'pt-PT' });
        await resolve(requests.length - 1);
        const automaticPlayer = players.at(-1);
        const automaticUrl = automaticPlayer.src;
        assert.equal(automaticPlayer.playing, true);
        settings = { ...settings, defaultVoice: 'openai:coral' };
        await act(async () => window.dispatchEvent(new Event('focus')));
        await settle(() => !automaticPlayer.playing);
        released(automaticPlayer, automaticUrl);
        assert.equal(settings.speechVoice, null);
        assert.equal(writes.length, beforeAutomaticSample);
        await click('Play Coral sample, Warm and friendly');
        assert.deepEqual(JSON.parse(requests.at(-1).options.body), { voice: 'openai:coral', locale: 'pt-PT' });
        assert.equal(writes.length, beforeAutomaticSample);
        const enter = async (input, value) => act(async () => {
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await open();
        delayCatalog = true;
        await act(async () => picker().querySelector('.voice-refresh-option').click());
        assert.equal(catalogs.length, 1);
        await act(async () => [...picker().querySelectorAll('.voice-provider-option')].find(item => item.textContent.includes('OpenAI')).click());
        await settle(() => dialog('OpenAI'));
        await act(async () => [...dialog('OpenAI').querySelectorAll('button')].find(item => ['Connect', 'Add API key'].includes(item.textContent.trim())).click());
        const keyInput = dialog('OpenAI').querySelector('input[type="password"]');
        await enter(keyInput, 'synthetic-retry-key');
        assert.ok(drafts.has('voice-connection'));
        assert.equal(drafts.get('voice-connection').busy, false);
        assert.equal(JSON.stringify(drafts.get('voice-connection').changes).includes('synthetic-retry-key'), false);
        await act(async () => dialog('OpenAI').querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => dialog('OpenAI').querySelector('[role="alert"]'));
        assert.equal(keyInput.value, 'synthetic-retry-key');
        assert.deepEqual(connectionWrites.at(-1).body, { provider: 'openai', key: 'synthetic-retry-key' });
        failConnection = false;
        addConnectedVoice = true;
        await act(async () => assert.equal(await drafts.get('voice-connection').save(), true));
        assert.ok(dialog('OpenAI'));
        assert.equal(picker(), null);
        await act(async () => catalogs[0].complete());
        await settle(() => catalogs.length === 2);
        assert.ok(dialog('OpenAI'));
        await act(async () => catalogs[1].complete());
        delayCatalog = false;
        await settle(() => !dialog('OpenAI') && picker());
        assert.ok(picker().querySelector('[aria-label^="Choose Cedar"]'));
        assert.equal(writes.length, beforeAutomaticSample);
        await act(async () => [...picker().querySelectorAll('.voice-provider-option')].find(item => item.textContent.includes('OpenRouter')).click());
        await settle(() => dialog('OpenRouter'));
        await act(async () => [...dialog('OpenRouter').querySelectorAll('button')].find(item => item.textContent.trim() === 'Sign in with OpenRouter').click());
        await settle(() => dialog('OpenRouter').querySelector('details'));
        assert.deepEqual(connectionWrites.at(-1).body, { provider: 'openrouter' });
        const callbackInput = dialog('OpenRouter').querySelector('input[type="url"]');
        failConnection = true;
        await enter(callbackInput, 'https://nod.fixture.invalid/callback?code=synthetic-only');
        await act(async () => callbackInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => dialog('OpenRouter').querySelector('[role="alert"]'));
        assert.equal(callbackInput.value, 'https://nod.fixture.invalid/callback?code=synthetic-only');
        failConnection = false;
        await act(async () => callbackInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => !dialog('OpenRouter') && picker());
        assert.equal(writes.length, beforeAutomaticSample);
        assert.equal(drafts.has('voice-connection'), false);
        await close();
        await settle(() => document.activeElement === trigger());
      } finally {
        if (mounted) await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('UI analytics keep answer choices, the survey card and survey flag requests within their consent and account', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        localStorage: dom.window.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'MutationObserver'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      let visibility = 'visible';
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      const observations = [];
      globalThis.IntersectionObserver = class {
        constructor(callback) { this.callback = callback; observations.push(this); }
        observe(element) { this.element = element; }
        disconnect() { this.disconnected = true; }
        intersect(...values) { this.callback(values.map(value => ({ target: this.element, isIntersecting: value }))); }
      };
      globalThis.fetch = async () => { throw new Error('This fixture cannot use the network.'); };
      const sent = [], requests = [];
      const client = {
        init(key, options) { this.token = key; this.options = options; },
        capture(event, properties = {}) {
          const value = this.options.before_send({ event, properties });
          if (value) this._send_request({ url: 'https://eu.i.posthog.com/e/', data: [value] });
          return value;
        },
        _send_request(request) {
          requests.push(request);
          if (Array.isArray(request.data)) sent.push(...request.data);
        },
        set_config(options) { this.options = { ...this.options, ...options }; },
        reset() {
          for (const key of Object.keys(localStorage))
            if (key.startsWith('seenSurvey_') || key.startsWith('inProgressSurvey_') || key === 'lastSeenSurveyDate')
              localStorage.removeItem(key);
        },
        reloadFeatureFlags() {}, startSessionRecording() {}, stopSessionRecording() {},
        surveys: [],
        surveyCallbacks: [],
        getActiveMatchingSurveys(callback) {
          if (this.deferSurveys) this.surveyCallbacks.push(callback);
          else callback(this.surveys);
        },
        onFeatureFlags() { return () => {}; },
        onSurveysLoaded() { return () => {}; },
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { AnswerChoices } = await import('./src/web/components/answer-choices.tsx');
      const { setRequestAccount } = await import('./src/web/lib/api.ts');
      const { setAnalyticsClient, configureAnalytics, captureAnalytics } = await import('./src/web/lib/analytics.ts');
      const configuration = { enabled: true, distinctId: 'synthetic-installation', environment: 'development' };
      setRequestAccount('synthetic-owner-one');
      setAnalyticsClient(client);
      const consent = (enabled, surveys = true) => configureAnalytics({ ...configuration, enabled, surveys }, 'web');
      consent(true);
      const seenSurveyKey = 'seenSurvey_0190c1a2-0000-7000-8000-000000000001';
      const inProgressKey = 'inProgressSurvey_0190c1a2-0000-7000-8000-000000000001';
      const lastSeenDate = '2026-01-01T00:00:00.000Z';
      localStorage.setItem(seenSurveyKey, 'true');
      localStorage.setItem('lastSeenSurveyDate', lastSeenDate);
      localStorage.setItem(inProgressKey, 'PRIVATE_UNSENT_DRAFT');
      consent(false);
      consent(true);
      assert.equal(localStorage.getItem(seenSurveyKey), 'true');
      assert.equal(localStorage.getItem('lastSeenSurveyDate'), lastSeenDate);
      assert.equal(localStorage.getItem(inProgressKey), null);
      configureAnalytics({ ...configuration, surveys: true, distinctId: 'synthetic-installation-two' }, 'web');
      assert.equal(localStorage.getItem(seenSurveyKey), null);
      assert.equal(localStorage.getItem('lastSeenSurveyDate'), null);
      consent(true);
      const container = document.querySelector('#root');
      const root = createRoot(container);
      const pending = [], custom = [];
      const mount = async (id, multiple = false, count = 2) => {
        const choices = {
          multiple,
          options: Array.from({ length: count }, (_, index) => ({
            id: 'PRIVATE_OPTION_' + index,
            label: 'PRIVATE_LABEL_' + index,
            description: 'PRIVATE_DESCRIPTION_' + index,
          })),
        };
        await act(() => root.render(createElement(AnswerChoices, {
          key: id, choices, question: { id: 'PRIVATE_QUESTION_' + id, text: 'PRIVATE_QUESTION_TEXT' },
          onAnswer: (text, selection) => new Promise((resolve, reject) => pending.push({ text, selection, resolve, reject })),
          onWriteAnswer: text => custom.push(text),
        })));
      };
      const events = name => sent.filter(item => item.event === name);
      const viewed = () => events('answer_choices_viewed');
      const selected = () => events('answer_choices_selected');
      const intersect = (...values) => act(() => observations.at(-1)?.intersect(...values));
      const visible = value => act(() => {
        visibility = value ? 'visible' : 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      const click = selector => act(() => document.querySelector(selector).click());
      const finish = outcome => act(async () => {
        if (outcome instanceof Error) pending.at(-1).reject(outcome);
        else pending.at(-1).resolve(outcome);
      });
      await mount('visible');
      assert.equal(viewed().length, 0);
      await visible(false);
      await intersect(true, false);
      await visible(true);
      assert.equal(viewed().length, 0);
      await intersect(false);
      await visible(false);
      await intersect(false, true);
      assert.equal(viewed().length, 0);
      await visible(true);
      assert.equal(viewed().length, 1);
      assert.equal(viewed()[0].properties.multiple, false);
      assert.equal(viewed()[0].properties.option_count, 2);
      await intersect(false);
      await intersect(true);
      await act(() => root.render(null));
      assert.equal(observations.at(-1).disconnected, true);
      await mount('visible');
      await intersect(true);
      assert.equal(viewed().length, 1);
      container.hidden = true;
      await mount('hidden');
      await intersect(true);
      assert.equal(viewed().length, 1);
      container.hidden = false;
      await intersect(true);
      assert.equal(viewed().length, 2);
      consent(false);
      await intersect(true);
      assert.equal(viewed().length, 2);
      consent(true);
      assert.equal(viewed().length, 3);
      const count = pending.length;
      await click('.answer-choice');
      await click('.answer-choice');
      assert.equal(pending.length, count + 1);
      assert.equal(selected().length, 0);
      await finish(true);
      assert.equal(selected().length, 1);
      assert.equal(selected()[0].properties.multiple, false);
      assert.equal(selected()[0].properties.option_count, 2);
      assert.equal(selected()[0].properties.selected_count, 1);
      assert.equal(document.querySelector('.answer-choices'), null);
      await mount('multiple', true, 6);
      await intersect(true);
      await click('.answer-choice:nth-child(1)');
      await click('.answer-choice:nth-child(2)');
      await click('.answer-choice:nth-child(2)');
      await click('.answer-choices-write');
      assert.equal(custom.length, 1);
      assert.equal(selected().length, 1);
      await click('.answer-choice:nth-child(3)');
      await click('.answer-choices-send');
      assert.equal(selected().length, 1);
      await finish(true);
      assert.equal(selected().length, 2);
      assert.equal(selected().at(-1).properties.multiple, true);
      assert.equal(selected().at(-1).properties.option_count, 6);
      assert.equal(selected().at(-1).properties.selected_count, 2);
      for (const [index, outcome] of ['unavailable', false, new Error('Synthetic rejection')].entries()) {
        await mount('rejected-' + index);
        await click('.answer-choice');
        await finish(outcome);
        assert.equal(selected().length, 2);
      }
      await mount('late-consent');
      await click('.answer-choice');
      consent(false);
      consent(true);
      await finish(true);
      assert.equal(selected().length, 2);
      await mount('late-account');
      await intersect(true);
      await click('.answer-choice');
      const oldViews = viewed().length;
      setRequestAccount('synthetic-owner-two');
      await intersect(true);
      assert.equal(viewed().length, oldViews);
      await finish(true);
      assert.equal(selected().length, 2);
      await mount('accepted-after-unmount');
      await click('.answer-choice');
      const observer = observations.at(-1);
      await act(() => root.render(null));
      observer.intersect(true);
      assert.equal(viewed().length, oldViews);
      await finish(true);
      assert.equal(selected().length, 3);
      const beforeInvalid = sent.length;
      for (const value of [undefined, 0, 7, -1, 1.5, NaN, '2']) {
        captureAnalytics('answer_choices_viewed', { multiple: false, option_count: value });
        captureAnalytics('answer_choices_selected', { multiple: true, option_count: 2, selected_count: value });
      }
      captureAnalytics('answer_choices_viewed', { multiple: 'false', option_count: 2 });
      captureAnalytics('chat_message_sent', { has_attachments: false, is_reply: true, source: 'composer' });
      for (const input of [undefined, null, '', 'invalid', 'audio', false, 0])
        captureAnalytics('chat_message_sent', { has_attachments: false, is_reply: true, source: 'composer', input });
      assert.equal(sent.length, beforeInvalid);
      for (const [source, input] of [['answer_choice', 'text'], ['composer', 'text'], ['composer', 'voice']]) {
        const before = sent.length;
        captureAnalytics('chat_message_sent', { has_attachments: false, is_reply: true, source, input });
        assert.equal(sent.length, before + 1);
        assert.equal(sent.at(-1).event, 'chat_message_sent');
        assert.equal(sent.at(-1).properties.source, source);
        assert.equal(sent.at(-1).properties.input, input);
      }
      captureAnalytics('answer_choices_selected', {
        multiple: true, option_count: 6, selected_count: 6,
        question_id: 'PRIVATE_QUESTION_ID', choice_ids: ['PRIVATE_OPTION_ID'], text: 'PRIVATE_TEXT',
      });
      assert.equal(selected().length, 4);
      assert.equal(selected().at(-1).properties.selected_count, 6);
      assert.ok(!JSON.stringify(sent).includes('PRIVATE_'));
      assert.ok(sent.every(item => item.properties.analytics_schema === 'v4'));
      assert.ok(sent.every(item => !item.event.startsWith('nod_')));
      assert.equal(client.options.disable_session_recording, true);
      client.capture('$snapshot', { snapshot_data: 'PRIVATE_REPLAY' });
      assert.equal(sent.length, beforeInvalid + 4);
      const survey = '0190c1a2-0000-7000-8000-000000000001';
      const score = '$survey_response_0190c1a2-0000-7000-8000-000000000002';
      const reason = '$survey_response_0190c1a2-0000-7000-8000-000000000003';
      const beforeSurvey = sent.length;
      client.capture('survey sent', {
        $survey_id: survey, $survey_iteration: 0, $survey_completed: true,
        $survey_submission_id: '0190c1a2-0000-7000-8000-000000000004',
        [score]: 9, [reason]: 'Synthetic reason. '.repeat(200), $survey_response: 9,
        $survey_name: 'PRIVATE_NAME', sessionRecordingUrl: 'https://PRIVATE_URL.invalid',
        $survey_questions: [{ id: 'PRIVATE_QUESTION_ID', question: 'PRIVATE_QUESTION', response: 9 }],
        $set: { ['$survey_responded/' + survey]: true, PRIVATE_PERSON: true },
      });
      client.capture('survey sent', { $survey_id: 'PRIVATE_SURVEY', [score]: 9 });
      client.capture('survey sent', { $survey_id: survey, [score]: 11, [reason + '_PRIVATE']: 'PRIVATE_TEXT' });
      client.capture('survey dismissed', { $survey_id: survey, [reason]: 'PRIVATE_PARTIAL', $survey_partially_completed: true });
      client.capture('survey abandoned', { $survey_id: survey });
      const surveys = sent.slice(beforeSurvey);
      assert.deepEqual(surveys.map(item => item.event), ['survey sent', 'survey sent', 'survey dismissed']);
      assert.equal(surveys[0].properties[score], 9);
      assert.equal(surveys[0].properties.$survey_response, 9);
      assert.equal(surveys[0].properties[reason].length, 2000);
      assert.equal(surveys[0].properties.$survey_completed, true);
      assert.equal(surveys[0].properties.$process_person_profile, false);
      assert.equal(surveys[1].properties[score], undefined);
      assert.ok(!JSON.stringify(surveys).includes('PRIVATE_'));
      const { SurveyCard } = await import('./src/web/components/survey-card.tsx');
      const card = () => document.querySelector('.survey-card');
      const write = (element, value) => act(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
      const rating = '0190c1a2-0000-7000-8000-00000000000b';
      const why = '0190c1a2-0000-7000-8000-00000000000c';
      const questions = [
        { id: rating, type: 'rating', scale: 10, question: 'Synthetic score question', lowerBoundLabel: 'Low', upperBoundLabel: 'High' },
        { id: why, type: 'open', question: 'Synthetic reason question', optional: true },
      ];
      client.surveys = [
        { id: '0190c1a2-0000-7000-8000-00000000000a', type: 'api', questions: [{ id: why, type: 'multiple_choice', question: 'Unsupported', choices: ['A', 'B'] }] },
        { id: survey, type: 'api', current_iteration: null, questions },
      ];
      await act(() => root.render(null));
      consent(true, false);
      const beforeCard = sent.length;
      const beforeSurveyDate = localStorage.getItem('lastSeenSurveyDate');
      await visible(false);
      await act(() => root.render(createElement(SurveyCard)));
      assert.equal(card(), null);
      await act(() => consent(true));
      assert.ok(card().hasAttribute('data-analytics-private'));
      assert.equal(card().querySelector('textarea'), null);
      assert.equal(sent.length, beforeCard);
      assert.equal(localStorage.getItem('lastSeenSurveyDate'), beforeSurveyDate);
      await visible(true);
      assert.equal(sent.length, beforeCard + 1);
      assert.equal(sent.at(-1).event, 'survey shown');
      assert.ok(localStorage.getItem('lastSeenSurveyDate'));
      await visible(false);
      await visible(true);
      assert.equal(sent.length, beforeCard + 1);
      await act(() => card().querySelectorAll('.survey-scale-option')[9].click());
      await write(card().querySelector('textarea'), '  Synthetic reason  ');
      await act(() => card().querySelector('button[type="submit"]').click());
      const answered = sent.slice(beforeCard);
      assert.deepEqual(answered.map(item => item.event), ['survey shown', 'survey sent', 'survey sent']);
      assert.equal(answered[1].properties['$survey_response_' + rating], 9);
      assert.equal(answered[1].properties['$survey_response_' + why], undefined);
      assert.equal(answered[1].properties.$survey_completed, false);
      assert.equal(answered[2].properties.$survey_id, survey);
      assert.equal(answered[2].properties['$survey_response_' + rating], 9);
      assert.equal(answered[2].properties['$survey_response_' + why], 'Synthetic reason');
      assert.equal(answered[2].properties.$survey_completed, true);
      assert.match(answered[2].properties.$survey_submission_id, /^[0-9a-f-]{36}$/);
      assert.equal(answered[1].properties.$survey_submission_id, answered[2].properties.$survey_submission_id);
      assert.deepEqual(answered[2].properties.$survey_questions, [
        { id: rating, question: 'Synthetic score question' },
        { id: why, question: 'Synthetic reason question' },
      ]);
      await act(() => root.render(null));
      client.surveys = [{ id: '0190c1a2-0000-7000-8000-00000000000d', type: 'api', questions }];
      const beforeDismiss = sent.length;
      await act(() => root.render(createElement(SurveyCard)));
      await act(() => card().querySelector('.survey-scale-option').click());
      await write(card().querySelector('textarea'), 'PRIVATE_UNSENT_REASON');
      await act(() => card().querySelector('.survey-card-close').click());
      assert.equal(card(), null);
      const dismissed = sent.slice(beforeDismiss);
      assert.deepEqual(dismissed.map(item => item.event), ['survey shown', 'survey sent', 'survey dismissed']);
      assert.equal(dismissed[1].properties['$survey_response_' + rating], 0);
      assert.equal(dismissed[2].properties.$survey_partially_completed, true);
      assert.equal(dismissed[2].properties.$survey_submission_id, dismissed[1].properties.$survey_submission_id);
      assert.ok(!JSON.stringify(dismissed).includes('PRIVATE_'));
      await act(() => root.render(null));
      client.surveys = [{ id: '0190c1a2-0000-7000-8000-00000000000e', type: 'api', questions }];
      const beforeWhole = sent.length;
      await act(() => root.render(createElement(SurveyCard)));
      await act(() => card().querySelector('.survey-card-close').click());
      const unanswered = sent.slice(beforeWhole);
      assert.deepEqual(unanswered.map(item => item.event), ['survey shown', 'survey dismissed']);
      assert.equal(unanswered[1].properties.$survey_submission_id, undefined);
      assert.equal(unanswered[1].properties.$survey_partially_completed, undefined);
      await act(() => root.render(null));
      const followup = '0190c1a2-0000-7000-8000-000000000010';
      client.surveys = [{
        id: '0190c1a2-0000-7000-8000-00000000000f', type: 'api',
        questions: [...questions, { id: followup, type: 'open', question: 'Synthetic follow-up', optional: true }],
      }];
      const beforeNext = sent.length;
      await act(() => root.render(createElement(SurveyCard)));
      await act(() => card().querySelectorAll('.survey-scale-option')[8].click());
      await write(card().querySelector('textarea'), 'Synthetic intermediate answer');
      assert.equal(sent.length, beforeNext + 2);
      await act(() => card().querySelector('button[type="submit"]').click());
      const intermediate = sent.at(-1);
      assert.equal(intermediate.event, 'survey sent');
      assert.equal(intermediate.properties['$survey_response_' + why], 'Synthetic intermediate answer');
      assert.equal(intermediate.properties['$survey_response_' + followup], undefined);
      assert.equal(intermediate.properties.$survey_completed, false);
      await write(card().querySelector('textarea'), 'PRIVATE_UNSENT_FOLLOWUP');
      await act(() => card().querySelector('.survey-card-close').click());
      assert.equal(sent.at(-1).event, 'survey dismissed');
      assert.equal(sent.at(-1).properties.$survey_submission_id, intermediate.properties.$survey_submission_id);
      assert.ok(!JSON.stringify(sent.slice(beforeNext)).includes('PRIVATE_'));
      await act(() => root.render(null));
      client.deferSurveys = true;
      await act(() => root.render(createElement(SurveyCard)));
      assert.equal(card(), null);
      assert.ok(client.surveyCallbacks.length);
      await act(() => consent(true, false));
      const beforeLateSurvey = sent.length;
      await act(() => client.surveyCallbacks.splice(0).forEach(callback => callback(client.surveys)));
      assert.equal(card(), null);
      assert.equal(sent.length, beforeLateSurvey);
      client.deferSurveys = false;
      await act(() => consent(true));
      assert.ok(card());
      await act(() => consent(false));
      assert.equal(card(), null);
      await act(() => root.render(null));
      consent(true);
      let flagsCompleted = false;
      const flags = (url, distinctId) => client._send_request({
        url, method: 'POST',
        data: {
          token: client.token, distinct_id: distinctId, $anon_distinct_id: 'PRIVATE_ANON',
          person_properties: { $initial_current_url: 'https://PRIVATE_URL.invalid' }, timezone: 'PRIVATE_ZONE',
        },
        callback: () => { flagsCompleted = true; },
      });
      const beforeFlags = requests.length;
      flags('https://eu.i.posthog.com/flags/?v=2&only_evaluate_survey_feature_flags=true', 'synthetic-installation');
      flags('https://eu.i.posthog.com/flags/?v=2', 'PRIVATE_ALL_FLAGS');
      flags('https://eu.i.posthog.com/flags/?v=2&only_evaluate_survey_feature_flags=true', 'PRIVATE_PREVIOUS_INSTALLATION');
      flags('https://untrusted.fixture.invalid/flags/?only_evaluate_survey_feature_flags=true', 'synthetic-installation');
      client._send_request({ url: 'https://eu.i.posthog.com/PRIVATE_PATH', method: 'GET' });
      assert.equal(requests.length, beforeFlags + 1);
      assert.deepEqual(requests.at(-1).data, { token: client.token, distinct_id: 'synthetic-installation' });
      const flagsCallback = requests.at(-1).callback;
      consent(true, false);
      flags('https://eu.i.posthog.com/flags/?v=2&only_evaluate_survey_feature_flags=true', 'synthetic-installation');
      client._send_request({ url: 'https://eu.i.posthog.com/api/surveys/?token=' + client.token, method: 'GET' });
      flagsCallback({ statusCode: 200, json: { featureFlags: {} } });
      assert.equal(flagsCompleted, false);
      assert.equal(requests.length, beforeFlags + 1);
      consent(false);
      flags('https://eu.i.posthog.com/flags/?v=2&only_evaluate_survey_feature_flags=true', 'synthetic-installation');
      client.capture('survey sent', { $survey_id: survey, [score]: 9 });
      assert.equal(requests.length, beforeFlags + 1);
      await act(() => root.unmount());
      dom.window.close();
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('composer preserves keyboard shortcuts, upload retries, previews and failed-send recovery', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root" class="chat-page"></div>', {
        url: 'https://nod.fixture.invalid',
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        localStorage: dom.window.localStorage,
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
      Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      const microphoneRequests = [], recorders = [], stoppedRecordings = [];
      let captureType = 'audio/mp4', speechFormat, speechStatus, delayStop = false;
      const audioPreparations = [];
      let microphones = [];
      globalThis.NodeFilter = dom.window.NodeFilter;
      const mediaDevices = new dom.window.EventTarget();
      mediaDevices.getUserMedia = (constraints) => new Promise((resolve, reject) => microphoneRequests.push({ constraints, resolve, reject }));
      mediaDevices.enumerateDevices = async () => microphones;
      Object.defineProperty(navigator, 'mediaDevices', {
        value: mediaDevices,
      });
      globalThis.MediaRecorder = class {
        static isTypeSupported(type) { return type === captureType; }
        state = 'inactive';
        constructor(stream, options) {
          this.stream = stream;
          this.mimeType = options.mimeType ?? captureType;
          recorders.push(this);
        }
        start() { this.state = 'recording'; }
        stop() {
          this.state = 'inactive';
          const finish = () => {
            this.ondataavailable?.({ data: new Blob(['synthetic audio'], { type: this.mimeType }) });
            this.onstop?.();
          };
          if (delayStop) stoppedRecordings.push(finish);
          else queueMicrotask(finish);
        }
      };
      const microphone = () => {
        const track = { stopped: false, stop() { this.stopped = true; } };
        return { track, getTracks: () => [track], getAudioTracks: () => [track] };
      };
      dom.window.HTMLMediaElement.prototype.pause = () => {};
      dom.window.HTMLMediaElement.prototype.load = () => {};
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = function() {
        return this.closest('[role="menu"]') ? [this.getBoundingClientRect()] : [];
      };
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [];
      const created = [],
        revoked = [],
        requests = [],
        renewals = [],
        renewable = [],
        opened = [],
        sends = [];
      let holdRenewals = false;
      URL.createObjectURL = (file) => {
        const url = 'blob:synthetic-' + created.length;
        created.push({ file, url });
        return url;
      };
      URL.revokeObjectURL = (url) => revoked.push(url);
      fetch = (url, options) => {
        if (url === '/api/speech') return Promise.resolve(Response.json(speechStatus ?? { transcription: true, transcriptionFormat: speechFormat }));
        if (url === '/api/speech/prepare') return new Promise((resolve, reject) => {
          audioPreparations.push({ options, resolve, reject });
          options.signal.addEventListener('abort', () => {
            speechStatus = { transcription: false, local: { state: 'not_downloaded' } };
            reject(new DOMException('Cancelled', 'AbortError'));
          }, { once: true });
        });
        return new Promise((resolve, reject) => {
          assert.ok(url === '/api/uploads' || url === '/api/uploads/renew');
          assert.equal(options.headers.get('X-nod-Account'), 'synthetic-owner');
          const request = { url, options, resolve, reject };
          if (url === '/api/uploads/renew') {
            assert.equal(options.method, 'POST');
            renewals.push(request);
            if (!holdRenewals) {
              const { ids } = JSON.parse(options.body);
              resolve(Response.json(renewable.filter(artifact => ids.includes(artifact.id))));
            }
          } else requests.push(request);
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      };
      const { createElement, useState, StrictMode, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Composer } = await import('./src/web/components/composer.tsx');
      const { MessageBubble } = await import('./src/web/components/message.tsx');
      const { parseComposerMarkdown } = await import('./src/web/lib/composer-markdown.ts');
      const { fileBytes } = await import('./src/shared/files.ts');
      const { ArtifactDrawerContext } = await import('./src/web/components/artifact-context.tsx');
      const { setRequestAccount } = await import('./src/web/lib/api.ts');
      setRequestAccount('synthetic-owner');
      let drafts = [],
        result = { sent: false, restoreText: true },
        currentText,
        changeActive,
        replaceText,
        workStops = 0;
      const setDrafts = (value) => {
        drafts = value;
      };
      function Fixture({ draftKey } = {}) {
        const [text, setText] = useState(draftKey ? '' : 'Synthetic review request');
        const [active, setActive] = useState(true);
        changeActive = setActive;
        currentText = text;
        replaceText = setText;
        return createElement(
          ArtifactDrawerContext.Provider,
          { value: { selectedId: null, open: (...args) => opened.push(args), setDrafts } },
          createElement(Composer, {
            draftKey,
            active,
            ready: true,
            text,
            setText,
            replyTo: null,
            clearReply() {},
            onStop() { workStops++; },
            onSend: async (text, attachments, recording, displayText) => {
              sends.push({ text, attachments, ...(recording ? { recording } : {}), ...(displayText ? { displayText } : {}) });
              return result;
            },
          }),
        );
      }
      let root = createRoot(document.getElementById('root'));
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
        await act(async () => {
          button.click();
          if (label === 'Cancel recording' || label === 'Discard recording')
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
      };
      const microphoneSettings = async (keyboard = false) => {
        const button = document.querySelector('[aria-label="Record an audio message"]');
        assert.ok(button);
        await act(async () => {
          button.focus();
          button.dispatchEvent(keyboard
            ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true })
            : new dom.window.MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true }));
        });
      };
      const choose = async (files) => {
        const button = document.querySelector('[aria-label="Attach files"]');
        await act(async () => button.focus());
        assert.ok(document.activeElement === button, 'Expected focus: ' + (button)?.getAttribute('aria-label'));
        const input = document.querySelector('input[type="file"]');
        let pickerOpened = false;
        input.addEventListener('click', () => { pickerOpened = true; }, { once: true });
        await click('Attach files');
        assert.equal(pickerOpened, true);
        Object.defineProperty(input, 'files', { configurable: true, value: files });
        await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
      };
      const upload = async (files, method = 'paste') => {
        const event = new Event(method, { bubbles: true, cancelable: true });
        Object.defineProperty(event, method === 'paste' ? 'clipboardData' : 'dataTransfer', {
          value: { files, getData: () => '' },
        });
        await act(async () => document.querySelector('[contenteditable]').dispatchEvent(event));
      };
      const submit = async () => {
        await act(async () =>
          document
            .querySelector('form')
            .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
        );
      };
      const edit = async (text = 'First lineSecond line', selector = 'p') => {
        await act(async () => replaceText(text));
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          window.getSelection().collapse(field.querySelector(selector).firstChild, 10);
          document.dispatchEvent(new Event('selectionchange'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      };
      const enter = async (modifiers = {}) => {
        await act(async () => {
          document.querySelector('[contenteditable]').dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, ...modifiers,
          }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      };
      const artifact = {
        id: '00000000-0000-4000-8000-000000000001',
        name: 'Review.txt',
        mimeType: 'text/plain',
        size: 21,
        url: '/api/artifacts/00000000-0000-4000-8000-000000000001',
      };
      renewable.push(artifact);
      let closed = false;
      try {
        localStorage.setItem('nod.send-with-enter', 'false');
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture))));
        await settle(() => document.querySelector('[contenteditable]'));
        const jsonPaste = [
          '[',
          '  {"id":101,"email":"ada@example.test","notes":"*priority* # call <after> __init__ _legacy_"},',
          '  {"id":102,"email":"ben@example.test","notes":"1. follow up"}',
          ']',
        ].join('\n');
        const csvPaste = [
          'id,email,notes',
          '101,ada@example.test,"__init__ _legacy_ # call <after>"',
          '102,ben@example.test,"*priority* 1. follow up"',
        ].join('\n');
        const indentedPaste = [
          '  id\tnotes',
          '\t101\t*priority*',
          '    102\t# call',
          '',
        ].join('\n');
        const paste = async (literalPaste, html = '') => {
          await act(async () => {
            const field = document.querySelector('[contenteditable]');
            field.focus();
            const event = new Event('paste', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'clipboardData', {
              value: {
                files: [],
                getData: (type) => type === 'text/plain' ? literalPaste : type === 'text/html' ? html : '',
              },
            });
            field.dispatchEvent(event);
          });
        };
        const pasteAtEnd = async (selector, literalPaste) => {
          await act(async () => {
            const field = document.querySelector('[contenteditable]');
            field.focus();
            const target = field.querySelector(selector);
            assert.ok(target);
            window.getSelection().collapse(target.lastChild, target.lastChild.textContent.length);
            document.dispatchEvent(new Event('selectionchange'));
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
          await paste(literalPaste);
        };
        const displayHost = document.createElement('div');
        document.body.append(displayHost);
        const displayRoot = createRoot(displayHost);
        const assertVisiblePaste = async (sent, expected) => {
          assert.equal(typeof sent.displayText, 'string');
          await act(async () => displayRoot.render(createElement(MessageBubble, {
            message: {
              id: 'synthetic-pasted-message',
              role: 'user',
              text: sent.text,
              displayText: sent.displayText,
              attachments: [],
              turnId: null,
              createdAt: '2026-11-10T12:00:00Z',
            },
          })));
          const visible = displayHost.querySelector('.message-text');
          assert.ok(visible);
          const paragraph = visible.querySelector('p');
          assert.ok(paragraph);
          const rendered = Array.from(paragraph.childNodes)
            .map((node) => node.nodeName === 'BR' ? '\n' : (node.textContent ?? '').replaceAll('\n', ''))
            .join('');
          assert.equal(rendered.replaceAll('\u00a0', ' '), expected);
          return visible;
        };
        result = { sent: true };
        for (const literalPaste of [jsonPaste, csvPaste, indentedPaste]) {
          const richPaste = '<pre>' + literalPaste.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') + '</pre>';
          for (const html of ['', richPaste]) {
            await act(async () => replaceText(''));
            await paste(literalPaste, html);
            await submit();
            const sent = sends.at(-1);
            assert.equal(sent.text, literalPaste);
            assert.deepEqual(sent.attachments, []);
            await assertVisiblePaste(sent, literalPaste);
          }
        }
        const spacedPaste = '  ["__init__", "<after>", "ada@example.test"]  \n';
        await act(async () => replaceText(''));
        await paste(spacedPaste);
        await submit();
        assert.equal(sends.at(-1).text, spacedPaste);
        const spacedVisible = await assertVisiblePaste(sends.at(-1), spacedPaste);
        assert.ok(spacedVisible.querySelector('br') || spacedVisible.textContent.endsWith('\n'));
        const typedInput = 'Email ada@example.test; JSON {"name":"__init__","note":"<after>"}';
        await act(async () => replaceText(''));
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          const paragraph = field.querySelector('p');
          paragraph.textContent = typedInput;
          window.getSelection().collapse(paragraph.firstChild, typedInput.length);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await settle(() => currentText.includes('example.test'));
        await submit();
        assert.equal(sends.at(-1).text, typedInput);
        await act(async () => replaceText('**bold\\*star** next'));
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          const paragraph = field.querySelector('p');
          window.getSelection().collapse(paragraph.lastChild, paragraph.lastChild.textContent.length);
          document.dispatchEvent(new Event('selectionchange'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await paste(' *literal*');
        await submit();
        assert.equal(sends.at(-1).text, '**bold\\*star** next *literal*');
        const richVisible = await assertVisiblePaste(sends.at(-1), 'bold*star next *literal*');
        assert.equal(richVisible.querySelector('strong')?.textContent, 'bold*star');
        await act(async () => replaceText('| label | value |\n| --- | --- |\n| first | second |'));
        await pasteAtEnd('table tr:last-child td:first-child p', 'A|B\\|C\nD');
        await submit();
        const parsedTable = parseComposerMarkdown(sends.at(-1).text);
        assert.equal(parsedTable.content.length, 1);
        assert.equal(parsedTable.content[0].type, 'table');
        assert.equal(parsedTable.content[0].content.length, 2);
        const pastedCell = parsedTable.content[0].content[1].content[0].content[0].content;
        assert.equal(pastedCell.map((node) => node.type === 'hardBreak' ? '\n' : node.text ?? '').join(''), 'firstA|B\\|C\nD');
        assert.equal(parsedTable.content[0].content[1].content[1].content[0].content[0].text, 'second');
        for (const [source, selector, expected, block] of [
          ['- first', 'li p', '- firstA\n  B', 'bulletList'],
          ['> first', 'blockquote p', '> firstA\n> B', 'blockquote'],
        ]) {
          await act(async () => replaceText(source));
          await pasteAtEnd(selector, 'A\nB');
          await submit();
          assert.equal(sends.at(-1).text.trimEnd(), expected);
          assert.equal(parseComposerMarkdown(sends.at(-1).text).content[0].type, block);
        }
        await act(async () => replaceText('Review this synthetic data:'));
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          const paragraph = field.querySelector('p');
          window.getSelection().collapse(paragraph.firstChild, paragraph.textContent.length);
          document.dispatchEvent(new Event('selectionchange'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await enter({ shiftKey: true });
        const intro = currentText;
        assert.equal(intro, 'Review this synthetic data:\n');
        await paste(jsonPaste);
        const introPaste = 'Review this synthetic data:\n' + jsonPaste;
        result = { sent: false, restoreText: true };
        await submit();
        assert.equal(sends.at(-1).text, introPaste);
        await assertVisiblePaste(sends.at(-1), introPaste);
        await settle(() => currentText === introPaste && document.querySelector('[contenteditable]').textContent.includes('__init__'));
        result = { sent: true };
        await submit();
        assert.equal(sends.at(-1).text, introPaste);
        await assertVisiblePaste(sends.at(-1), introPaste);
        await act(async () => root.unmount());
        closed = true;
        const literalDraftKey = 'synthetic-owner.literal-paste';
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture, { draftKey: literalDraftKey }))));
        await settle(() => document.querySelector('[contenteditable]'));
        await paste(jsonPaste);
        await settle(() => JSON.parse(localStorage.getItem(literalDraftKey) ?? 'null')?.text === jsonPaste);
        await act(async () => root.unmount());
        closed = true;
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture, { draftKey: literalDraftKey }))));
        await settle(() => document.querySelector('[contenteditable]').textContent.includes('__init__'));
        await submit();
        assert.equal(sends.at(-1).text, jsonPaste);
        await assertVisiblePaste(sends.at(-1), jsonPaste);
        await act(async () => root.unmount());
        closed = true;
        const typedDraftKey = 'synthetic-owner.typed-literal-draft';
        const typedDraft = '  __init__ _legacy_ <after> ada@example.test {"note":"*priority*"}';
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture, { draftKey: typedDraftKey }))));
        await settle(() => document.querySelector('[contenteditable]'));
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          const paragraph = field.querySelector('p');
          paragraph.textContent = typedDraft;
          window.getSelection().collapse(paragraph.firstChild, typedDraft.length);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await settle(() => currentText === typedDraft && JSON.parse(localStorage.getItem(typedDraftKey) ?? 'null')?.text === typedDraft);
        await act(async () => root.unmount());
        closed = true;
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture, { draftKey: typedDraftKey }))));
        await settle(() => currentText === typedDraft && document.querySelector('[contenteditable]')?.textContent === typedDraft);
        await submit();
        assert.equal(sends.at(-1).text, typedDraft);
        await assertVisiblePaste(sends.at(-1), typedDraft);
        await act(async () => displayRoot.unmount());
        displayHost.remove();
        await act(async () => root.unmount());
        closed = true;
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture))));
        await settle(() => document.querySelector('[contenteditable]'));
        sends.length = 0;
        result = { sent: false, restoreText: true };
        await edit();
        const field = document.querySelector('[contenteditable]');
        const input = document.querySelector('input[type="file"]');
        let pickerCount = 0;
        input.addEventListener('click', () => pickerCount++);
        const attachKey = async (modifiers = {}) => {
          await act(async () => document.querySelector('[contenteditable]').dispatchEvent(new KeyboardEvent('keydown', {
            key: 'u', code: 'KeyU', bubbles: true, cancelable: true, metaKey: true, ...modifiers,
          })));
        };
        const originalDraft = currentText;
        await act(async () => {
          window.getSelection().selectAllChildren(field);
          document.dispatchEvent(new Event('selectionchange'));
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
        await attachKey();
        assert.equal(pickerCount, 1);
        assert.equal(currentText, originalDraft);
        assert.equal(field.querySelector('u'), null);
        assert.equal(requests.length, 0);
        assert.equal(sends.length, 0);
        await settle(() => document.querySelector('[aria-label="Underline"]'));
        const underline = document.querySelector('[aria-label="Underline"]');
        assert.ok(underline);
        assert.equal(document.querySelector('form').contains(underline), false);
        await act(async () => {
          underline.focus();
          underline.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'u', code: 'KeyU', metaKey: true, bubbles: true, cancelable: true,
          }));
        });
        assert.equal(pickerCount, 2);
        assert.equal(currentText, originalDraft);
        assert.equal(field.querySelector('u'), null);
        await act(async () => field.focus());
        await attachKey({ repeat: true });
        assert.equal(pickerCount, 2);
        for (const modifiers of [{ metaKey: false }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])
          await attachKey(modifiers);
        assert.equal(pickerCount, 2);
        await act(async () => changeActive(false));
        await attachKey();
        assert.equal(pickerCount, 2);
        await act(async () => changeActive(true));
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
        await act(async () => replaceText('Windows attachment shortcut'));
        await attachKey({ metaKey: false, ctrlKey: true });
        assert.equal(pickerCount, 3);
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        await act(async () => replaceText(originalDraft));
        await edit();
        for (const modifiers of [{ isComposing: true }, { keyCode: 229 }]) {
          await enter(modifiers);
          assert.equal(sends.length, 0);
        }
        result = { sent: true };
        for (const modifiers of [{}, { metaKey: true }, { ctrlKey: true }]) {
          const count = sends.length;
          await edit();
          await enter({ shiftKey: true });
          assert.equal(sends.length, count);
          assert.equal(currentText.replaceAll('\\\n', '\n'), 'First line\nSecond line');
          const expected = currentText;
          await enter(modifiers);
          assert.deepEqual(sends.at(-1), {
            text: expected,
            attachments: [],
            displayText: 'First line<br>Second line',
          });
          assert.equal(sends.length, count + 1);
        }
        await edit();
        await enter({ altKey: true });
        assert.equal(sends.length, 3);
        assert.equal(currentText.replaceAll('\\\n', '\n'), 'First line\nSecond line');
        const fence = String.fromCharCode(96).repeat(3);
        for (const [text, selector, blocks, expected] of [
          ['# First lineSecond line', 'h1', 'h1, h1 + p', [['H1', 'First line'], ['P', 'Second line']]],
          ['- First lineSecond line', 'li p', 'li', [['LI', 'First line'], ['LI', 'Second line']]],
          [fence + '\nFirst lineSecond line\n' + fence, 'code', 'pre, pre + p', [['PRE', 'First lineSecond line'], ['P', '']]],
        ]) {
          await edit(text, selector);
          await enter({ shiftKey: true });
          assert.equal(sends.length, 3);
          assert.deepEqual(
            Array.from(document.querySelector('[contenteditable]').querySelectorAll(blocks),
              (block) => [block.tagName, block.textContent]),
            expected,
          );
          if (selector === 'code')
            assert.ok(document.querySelector('[contenteditable] > pre + p').contains(window.getSelection().anchorNode));
        }
        await act(async () => replaceText('Synthetic review request'));
        sends.length = 0;
        result = { sent: false, restoreText: true };
        const oversized = new File(['Synthetic oversized file'], 'Too large.txt', { type: 'text/plain' });
        Object.defineProperty(oversized, 'size', { value: fileBytes + 1 });
        await choose([oversized]);
        await settle(() => document.activeElement === document.querySelector('[contenteditable]'));
        assert.equal(currentText, 'Synthetic review request');
        assert.equal(document.querySelector('[contenteditable]').textContent, 'Synthetic review request');
        assert.equal(requests.length, 0);
        assert.equal(sends.length, 0);
        assert.equal(drafts.length, 0);
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
        const native = [];
        window.nodDesktop = { fileAction: async (...args) => { native.push(args); } };
        const { prepareFile, reuseFile } = await import('./src/web/components/file-actions.tsx');
        prepareFile(drafts[0]);
        assert.deepEqual(native, [[artifact.id, 'prepare']]);
        await act(async () => reuseFile(drafts[0]));
        assert.equal(drafts.length, 1);
        delete window.nodDesktop;
        assert.equal(document.querySelector('[aria-label="Send message"]').disabled, false);
        await submit();
        await settle(
          () =>
            drafts.length === 1 &&
            document.querySelector('[contenteditable]').textContent.includes('Synthetic review request'),
        );
        assert.deepEqual(sends[0].attachments, [artifact]);
        assert.equal(sends[0].displayText, undefined);
        assert.equal(revoked.includes(created[0].url), false);
        assert.deepEqual(JSON.parse(renewals.at(-1).options.body), { ids: [artifact.id] });
        await settle(() => !document.querySelector('[aria-label="Send message"]').disabled);
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
        await upload(unsafe, 'drop');
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
        await upload(finalFiles);
        await settle(() => requests.length === 4);
        await act(async () => root.unmount());
        closed = true;
        assert.equal(requests[3].options.signal.aborted, true);
        assert.equal(requests.length, 4);
        assert.equal(drafts.length, 0);
        assert.deepEqual([...new Set(revoked)].sort(), created.map((item) => item.url).sort());
        for (const item of created) assert.equal(revoked.filter((url) => url === item.url).length, 1);
        const restoredFiles = Array.from({ length: 5 }, (_, index) => {
          const id = '00000000-0000-4000-8000-' + String(index + 1).padStart(12, '0');
          return { ...artifact, id, url: '/api/artifacts/' + id, name: index === 0 ? artifact.name : 'Restored-' + index + '.txt' };
        });
        renewable.splice(0, renewable.length, ...restoredFiles);
        holdRenewals = true;
        const beforeRenewal = renewals.length;
        localStorage.setItem('synthetic-owner.thread', JSON.stringify({ version: 1, text: 'Restored synthetic request', reply: null, attachments: restoredFiles, missing: [] }));
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture, { draftKey: 'synthetic-owner.thread' }))));
        await settle(() => renewals.length > beforeRenewal);
        const restoredRenewal = renewals.at(-1);
        assert.equal(restoredRenewal.options.signal.aborted, false);
        assert.deepEqual(JSON.parse(restoredRenewal.options.body), { ids: restoredFiles.map(file => file.id) });
        assert.equal(document.querySelector('[aria-label="Send message"]').disabled, true);
        await submit();
        assert.equal(sends.length, 2);
        assert.equal(requests.length, 4);
        await act(async () => restoredRenewal.resolve(Response.json(restoredFiles.slice(1))));
        await settle(() => document.querySelector('[aria-label="Retry checking Review.txt"]'));
        assert.equal(JSON.parse(localStorage.getItem('synthetic-owner.thread')).attachments[0].id, artifact.id);
        await click('Retry checking Review.txt');
        const retryRenewal = renewals.at(-1);
        assert.notEqual(retryRenewal, restoredRenewal);
        assert.deepEqual(JSON.parse(retryRenewal.options.body), { ids: restoredFiles.map(file => file.id) });
        await act(async () => retryRenewal.resolve(Response.json({ error: 'Synthetic offline check' }, { status: 503 })));
        await settle(() => document.querySelector('[aria-label="Retry checking Review.txt"]'));
        assert.equal(document.querySelector('[aria-label="Send message"]').disabled, true);
        await click('Retry checking Review.txt');
        const recoveredRenewal = renewals.at(-1);
        assert.notEqual(recoveredRenewal, retryRenewal);
        await act(async () => recoveredRenewal.resolve(Response.json(restoredFiles)));
        await settle(() => !document.querySelector('[aria-label="Send message"]').disabled);
        holdRenewals = false;
        await submit();
        assert.deepEqual(sends[2], { text: 'Restored synthetic request', attachments: restoredFiles });
        assert.equal(microphoneRequests.length, 0);
        assert.ok(document.querySelector('[aria-label="Record an audio message"]'));
        await click('Stop all work');
        assert.equal(workStops, 1);
        assert.equal(document.querySelector('[aria-label="Send message"]'), null);
        await act(async () => replaceText('Keep this synthetic draft'));
        assert.equal(document.querySelector('[aria-label="Stop all work"]'), null);
        assert.equal(document.querySelector('[aria-label="Send message"]').disabled, false);
        await click('Record an audio message');
        assert.equal(microphoneRequests.length, 1);
        await click('Cancel recording');
        const cancelled = microphone();
        await act(async () => microphoneRequests[0].resolve(cancelled));
        assert.equal(cancelled.track.stopped, true);
        await settle(() => document.activeElement === document.querySelector('[contenteditable]'));
        assert.equal(recorders.length, 0);
        assert.equal(currentText, 'Keep this synthetic draft');
        await click('Record an audio message');
        await act(async () => microphoneRequests[1].reject(new DOMException('Blocked', 'NotAllowedError')));
        assert.equal(currentText, 'Keep this synthetic draft');
        await click('Audio needs attention');
        await settle(() => document.querySelector('.voice-setup'));
        assert.ok(document.querySelector('.voice-setup [role="alert"]'));
        await act(async () => document.querySelector('.voice-setup button').click());
        const recorded = microphone();
        await act(async () => microphoneRequests[2].resolve(recorded));
        assert.equal(recorders[0].mimeType, 'audio/mp4');
        assert.equal(recorded.track.stopped, false);
        assert.ok(document.activeElement === document.querySelector('[aria-label="Send audio message"]'), 'Recording must focus Send audio message');
        assert.equal(document.querySelector('[aria-label="Stop all work"]'), null);
        assert.equal(recorded.track.stopped, false);
        assert.equal(document.querySelector('[aria-label="Send audio message"]').disabled, false);
        let recordingPickers = 0;
        document.querySelector('input[type="file"]').addEventListener('click', () => recordingPickers++);
        await attachKey();
        assert.equal(recordingPickers, 0);
        assert.equal(recorded.track.stopped, false);
        assert.equal(currentText, 'Keep this synthetic draft');
        await act(async () =>
          window.dispatchEvent(new CustomEvent('nod:attach-artifact', { detail: artifact })),
        );
        result = { sent: false, restoreText: true };
        delayStop = true;
        await submit();
        await submit();
        assert.equal(sends.length, 3);
        assert.equal(requests.length, 4);
        assert.equal(recorded.track.stopped, true);
        assert.equal(stoppedRecordings.length, 1);
        await act(async () => stoppedRecordings.shift()());
        delayStop = false;
        await settle(() => currentText === 'Keep this synthetic draft' && drafts.length === 1);
        assert.equal(sends.length, 4);
        await settle(() => document.querySelector('audio'));
        const preview = document.querySelector('audio').src;
        assert.ok(document.querySelector('audio').getAttribute('src')?.startsWith('blob:'));
        assert.equal(revoked.includes(preview), false);
        assert.equal(requests.length, 4);
        assert.equal(sends[3].recording.type, 'audio/mp4');
        assert.equal(sends[3].recording.name, 'Voice message.m4a');
        assert.equal(document.querySelector('audio').src, preview);
        assert.equal(revoked.includes(preview), false);
        assert.equal(sends[3].attachments[0].id, artifact.id);
        result = { sent: true };
        await submit();
        await settle(() => !document.querySelector('audio'));
        assert.equal(sends[4].recording, sends[3].recording);
        assert.equal(revoked.filter((url) => url === preview).length, 1);
        await click('Record an audio message');
        const changedOwner = microphone();
        await act(async () => microphoneRequests[3].resolve(changedOwner));
        await act(async () => setRequestAccount('another-synthetic-owner'));
        await settle(() => changedOwner.track.stopped);
        assert.equal(document.querySelector('audio'), null);
        await click('Record an audio message');
        await act(async () => changeActive(false));
        const afterLeaving = microphone();
        await act(async () => microphoneRequests[4].resolve(afterLeaving));
        assert.equal(afterLeaving.track.stopped, true);
        await act(async () => changeActive(true));
        assert.equal(recorders.length, 2);
        assert.ok(document.querySelector('[aria-label="Record an audio message"]'));
        await act(async () => replaceText('Keep this draft while navigating'));
        await click('Record an audio message');
        const beforeLeaving = microphone();
        await act(async () => microphoneRequests[5].resolve(beforeLeaving));
        await act(async () => changeActive(false));
        assert.equal(beforeLeaving.track.stopped, true);
        assert.equal(document.querySelector('audio'), null);
        const retained = created.at(-1);
        assert.equal(revoked.includes(retained.url), false);
        await act(async () => changeActive(true));
        await settle(() => document.querySelector('audio'));
        assert.equal(document.querySelector('audio').src, retained.url);
        assert.equal(currentText, 'Keep this draft while navigating');
        assert.equal(recorders.length, 3);
        await click('Discard recording');
        assert.equal(revoked.filter((url) => url === retained.url).length, 1);
        delayStop = true;
        for (const outcome of ['discard', 'leave-and-return']) {
          const before = sends.length;
          await click('Record an audio message');
          const interrupted = microphone();
          await act(async () => microphoneRequests.at(-1).resolve(interrupted));
          await submit();
          assert.equal(interrupted.track.stopped, true);
          assert.equal(stoppedRecordings.length, 1);
          if (outcome === 'discard') await click('Discard recording');
          else {
            await act(async () => changeActive(false));
            await act(async () => changeActive(true));
          }
          await act(async () => stoppedRecordings.shift()());
          await settle(() => currentText === 'Keep this draft while navigating');
          assert.equal(sends.length, before);
          if (outcome === 'discard') assert.equal(document.querySelector('audio'), null);
          else {
            assert.ok(document.querySelector('audio'));
            await click('Discard recording');
          }
        }
        delayStop = false;
        speechFormat = 'wav';
        captureType = 'audio/wav';
        await act(async () => window.dispatchEvent(new Event('focus')));
        await click('Record an audio message');
        const nativeWave = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(nativeWave));
        await click('Stop and preview recording');
        assert.equal(nativeWave.track.stopped, true);
        await settle(() => document.querySelector('audio') && !document.querySelector('[aria-label="Send audio message"]')?.disabled);
        await submit();
        assert.equal(sends.at(-1).recording.type, 'audio/wav');
        assert.equal(sends.at(-1).recording.name, 'Voice message.wav');
        await settle(() => !document.querySelector('audio'));
        captureType = 'audio/mp4';
        let conversionFails = true, contextsClosed = 0;
        globalThis.AudioContext = class {
          async decodeAudioData(bytes) {
            assert.equal(new TextDecoder().decode(bytes), 'synthetic audio');
            if (conversionFails) throw new Error('Synthetic decode failure');
            return { duration: 1 };
          }
          async close() { contextsClosed++; }
        };
        globalThis.OfflineAudioContext = class {
          constructor(channels, frames, rate) {
            assert.equal(channels, 1);
            assert.equal(frames, 16000);
            assert.equal(rate, 16000);
          }
          createBufferSource() { return { connect() {}, start() {} }; }
          async startRendering() {
            const samples = new Float32Array(16000);
            samples.set([-1, -0.5, 0, 0.5, 1]);
            return { getChannelData: () => samples };
          }
        };
        await click('Record an audio message');
        const needsConversion = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(needsConversion));
        const beforeConversionSend = sends.length;
        await submit();
        assert.equal(needsConversion.track.stopped, true);
        await settle(() => document.querySelector('audio') && !document.querySelector('[aria-label="Send audio message"]').disabled);
        assert.equal(sends.length, beforeConversionSend);
        const unconverted = created.at(-1);
        assert.equal(unconverted.file.type, 'audio/mp4');
        assert.equal(revoked.includes(unconverted.url), false);
        conversionFails = false;
        await submit();
        await settle(() => sends.length === beforeConversionSend + 1);
        assert.equal(revoked.filter((url) => url === unconverted.url).length, 1);
        const converted = created.at(-1);
        assert.equal(converted.file.type, 'audio/wav');
        const wave = new DataView(await converted.file.arrayBuffer());
        assert.equal(new TextDecoder().decode(new Uint8Array(wave.buffer, 0, 4)), 'RIFF');
        assert.equal(wave.getUint16(22, true), 1);
        assert.equal(wave.getUint32(24, true), 16000);
        assert.equal(wave.getUint32(40, true), 32000);
        assert.deepEqual(Array.from({ length: 5 }, (_, index) => wave.getInt16(44 + index * 2, true)), [-32768, -16384, 0, 16383, 32767]);
        assert.ok(contextsClosed >= 3);
        assert.equal(sends.length, beforeConversionSend + 1);
        assert.equal(sends.at(-1).recording, converted.file);
        await settle(() => !document.querySelector('audio'));
        await click('Record an audio message');
        await act(async () => root.unmount());
        closed = true;
        const afterUnmount = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(afterUnmount));
        assert.equal(afterUnmount.track.stopped, true);
        assert.equal(recorders.length, 7);
        speechFormat = undefined;
        root = createRoot(document.getElementById('root'));
        closed = false;
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture))));
        await settle(() => document.querySelector('[aria-label="Record an audio message"]'));
        const beforeDiscovery = microphoneRequests.length;
        await microphoneSettings();
        assert.equal(microphoneRequests.length, beforeDiscovery);
        assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 0);
        assert.equal(document.activeElement, document.querySelector('[aria-label="Allow microphone access"]'));
        await click('Allow microphone access');
        assert.equal(microphoneRequests.length, beforeDiscovery + 1);
        await click('Allow microphone access');
        assert.equal(microphoneRequests.length, beforeDiscovery + 1);
        assert.equal(recorders.length, 7);
        await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        const lateDiscovery = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(lateDiscovery));
        assert.equal(lateDiscovery.track.stopped, true);
        await settle(() => !document.querySelector('[role="menu"]'));
        await settle(() => document.activeElement === document.querySelector('[aria-label="Record an audio message"]'));
        await microphoneSettings(true);
        await click('Allow microphone access');
        microphones = [
          { kind: 'audioinput', deviceId: 'default', label: 'Default microphone' },
          { kind: 'audioinput', deviceId: 'built-in', label: 'Built-in microphone' },
          { kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' },
        ];
        const discovered = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(discovered));
        assert.equal(discovered.track.stopped, true);
        assert.equal(recorders.length, 7);
        await settle(() => document.querySelector('[aria-label="USB microphone"]'));
        const namedMicrophones = microphones;
        microphones = [{ kind: 'audioinput', deviceId: 'default', label: 'Default microphone' }];
        await act(async () => mediaDevices.dispatchEvent(new Event('devicechange')));
        assert.equal(document.querySelectorAll('[role="menuitemradio"]').length, 1);
        assert.ok(document.querySelector('[aria-label="System default"]'));
        assert.equal(document.querySelector('[aria-label="Allow microphone access"]'), null);
        microphones = namedMicrophones;
        await act(async () => mediaDevices.dispatchEvent(new Event('devicechange')));
        await act(async () => document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
        assert.ok(document.activeElement === document.querySelector('[aria-label="USB microphone"]'), 'Expected focus: ' + (document.querySelector('[aria-label="USB microphone"]'))?.getAttribute('aria-label'));
        await click('USB microphone');
        assert.equal(localStorage.getItem('nod.microphone'), 'usb');
        const enumerations = [];
        mediaDevices.enumerateDevices = () => new Promise(resolve => enumerations.push(resolve));
        await act(async () => {
          mediaDevices.dispatchEvent(new Event('devicechange'));
          mediaDevices.dispatchEvent(new Event('devicechange'));
        });
        assert.equal(enumerations.length, 2);
        await act(async () => enumerations[1](microphones));
        await act(async () => enumerations[0](microphones.filter(device => device.deviceId !== 'usb')));
        assert.equal(localStorage.getItem('nod.microphone'), 'usb');
        mediaDevices.enumerateDevices = async () => microphones;
        await act(async () => {
          localStorage.setItem('nod.microphone', 'built-in');
          window.dispatchEvent(new CustomEvent('nod:microphone-change', { detail: 'built-in' }));
        });
        await click('Record an audio message');
        assert.deepEqual(microphoneRequests.at(-1).constraints.audio.deviceId, { exact: 'built-in' });
        const chosenMicrophone = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(chosenMicrophone));
        await act(async () => {
          localStorage.setItem('nod.microphone', 'usb');
          window.dispatchEvent(new window.StorageEvent('storage', { key: 'nod.microphone', newValue: 'usb' }));
        });
        assert.equal(chosenMicrophone.track.stopped, false);
        await click('Stop and preview recording');
        await settle(() => document.querySelector('audio'));
        const priorClip = document.querySelector('audio').src;
        await click('Record again');
        assert.deepEqual(microphoneRequests.at(-1).constraints.audio.deviceId, { exact: 'usb' });
        await act(async () => microphoneRequests.at(-1).reject(new DOMException('Blocked', 'NotAllowedError')));
        await settle(() => document.querySelector('audio'));
        assert.equal(document.querySelector('audio').src, priorClip);
        assert.equal(revoked.includes(priorClip), false);
        assert.equal(currentText, 'Synthetic review request');
        await click('Audio needs attention');
        await settle(() => document.querySelector('.voice-setup'));
        await act(async () => document.querySelector('.voice-setup button').click());
        await act(async () => changeActive(false));
        assert.equal(document.querySelector('audio'), null);
        assert.equal(revoked.includes(priorClip), false);
        const replacementAfterLeaving = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(replacementAfterLeaving));
        assert.equal(replacementAfterLeaving.track.stopped, true);
        await act(async () => changeActive(true));
        await settle(() => document.querySelector('audio'));
        assert.equal(document.querySelector('audio').src, priorClip);
        assert.equal(currentText, 'Synthetic review request');
        const priorSends = sends.length;
        speechFormat = 'wav';
        conversionFails = true;
        await act(async () => window.dispatchEvent(new Event('focus')));
        await submit();
        await settle(() => document.querySelector('audio') && !document.querySelector('[aria-label="Send audio message"]').disabled);
        assert.equal(sends.length, priorSends);
        assert.equal(document.querySelector('audio').src, priorClip);
        assert.equal(revoked.includes(priorClip), false);
        assert.equal(currentText, 'Synthetic review request');
        conversionFails = false;
        await submit();
        await settle(() => !document.querySelector('audio'));
        assert.equal(sends.at(-1).recording.type, 'audio/wav');
        assert.equal(revoked.filter((url) => url === priorClip).length, 1);
        await act(async () => root.unmount());
        root = createRoot(document.getElementById('root'));
        await act(async () => root.render(createElement(StrictMode, null, createElement(Fixture))));
        await settle(() => document.querySelector('[aria-label="Record an audio message"]'));
        await click('Record an audio message');
        assert.deepEqual(microphoneRequests.at(-1).constraints.audio.deviceId, { exact: 'usb' });
        await click('Cancel recording');
        const cancelledChoice = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(cancelledChoice));
        assert.equal(cancelledChoice.track.stopped, true);
        microphones = microphones.filter(device => device.deviceId !== 'usb');
        await act(async () => mediaDevices.dispatchEvent(new Event('devicechange')));
        assert.equal(localStorage.getItem('nod.microphone'), null);
        await click('Record an audio message');
        assert.equal(microphoneRequests.at(-1).constraints.audio.deviceId, undefined);
        await click('Cancel recording');
        const fallback = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(fallback));
        assert.equal(fallback.track.stopped, true);
        await settle(() => document.activeElement === document.querySelector('[contenteditable]'));
        microphones.push({ kind: 'audioinput', deviceId: 'usb', label: 'USB microphone' });
        await microphoneSettings();
        await settle(() => document.querySelector('[aria-label="USB microphone"]'));
        await click('USB microphone');
        await click('Record an audio message');
        const beforeFallback = microphoneRequests.length;
        await act(async () => microphoneRequests.at(-1).reject(new DOMException('Unplugged', 'OverconstrainedError')));
        assert.equal(microphoneRequests.length, beforeFallback + 1);
        assert.equal(microphoneRequests.at(-1).constraints.audio.deviceId, undefined);
        await click('Cancel recording');
        const racedFallback = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(racedFallback));
        assert.equal(racedFallback.track.stopped, true);
        const beforeHoldSend = sends.length;
        const pressRecord = async (keyboard = false) => {
          await act(async () => document.querySelector('[aria-label="Record an audio message"]').dispatchEvent(keyboard
            ? new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
            : new dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true, cancelable: true })));
        };
        const releaseRecord = async (keyboard = false) => {
          await act(async () => window.dispatchEvent(keyboard
            ? new KeyboardEvent('keyup', { key: ' ', bubbles: true })
            : new dom.window.MouseEvent('pointerup', { button: 0, bubbles: true })));
        };
        await pressRecord();
        await releaseRecord();
        const releasedBeforePermission = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(releasedBeforePermission));
        assert.equal(releasedBeforePermission.track.stopped, true);
        assert.equal(document.querySelector('audio'), null);
        for (const keyboard of [false, true]) {
          await pressRecord(keyboard);
          const held = microphone();
          await act(async () => microphoneRequests.at(-1).resolve(held));
          assert.equal(held.track.stopped, false);
          await releaseRecord(keyboard);
          await settle(() => document.querySelector('audio'));
          assert.equal(held.track.stopped, true);
          assert.equal(sends.length, beforeHoldSend);
          if (!keyboard) {
            const count = microphoneRequests.length;
            await act(async () => document.querySelector('.record-button').dispatchEvent(new dom.window.MouseEvent('click', { detail: 1, bubbles: true })));
            assert.equal(microphoneRequests.length, count);
            assert.ok(document.querySelector('audio'));
          }
          await click('Discard recording');
        }
        const recordKey = async (modifiers = {}, target = document.querySelector('[contenteditable]')) => {
          const event = new KeyboardEvent('keydown', { key: 'd', code: 'KeyD', metaKey: true, bubbles: true, cancelable: true, ...modifiers });
          await act(async () => target.dispatchEvent(event));
          return event.defaultPrevented;
        };
        for (const platform of ['MacIntel', 'Win32']) {
          Object.defineProperty(navigator, 'platform', { configurable: true, value: platform });
          await act(async () => replaceText('Synthetic ' + platform + ' shortcut draft'));
          const modifiers = platform === 'MacIntel' ? {} : { metaKey: false, ctrlKey: true };
          const field = document.querySelector('[contenteditable]');
          await act(async () => field.focus());
          const before = microphoneRequests.length;
          assert.equal(await recordKey(modifiers), true);
          assert.equal(await recordKey(modifiers), true);
          assert.equal(await recordKey({ ...modifiers, repeat: true }), true);
          assert.equal(microphoneRequests.length, before + 1);
          const shortcutCapture = microphone();
          await act(async () => microphoneRequests.at(-1).resolve(shortcutCapture));
          assert.equal(shortcutCapture.track.stopped, false);
          await recordKey({ ...modifiers, repeat: true });
          assert.equal(shortcutCapture.track.stopped, false);
          delayStop = true;
          await recordKey(modifiers);
          assert.equal(shortcutCapture.track.stopped, true);
          await recordKey(modifiers);
          assert.equal(microphoneRequests.length, before + 1);
          await act(async () => stoppedRecordings.at(-1)());
          delayStop = false;
          await settle(() => document.querySelector('audio'));
          const preview = document.querySelector('audio').src;
          await recordKey(modifiers);
          assert.equal(document.querySelector('audio').src, preview);
          assert.equal(microphoneRequests.length, before + 1);
          assert.equal(currentText, 'Synthetic ' + platform + ' shortcut draft');
          assert.equal(sends.length, beforeHoldSend);
          await click('Discard recording');
          const dialog = document.createElement('div');
          dialog.setAttribute('role', 'dialog');
          document.body.append(dialog);
          assert.equal(await recordKey(modifiers), false);
          dialog.remove();
          const otherInput = document.createElement('input');
          document.querySelector('.chat-page').append(otherInput);
          await act(async () => otherInput.focus());
          assert.equal(await recordKey(modifiers, otherInput), false);
          otherInput.remove();
          await act(async () => field.focus());
          for (const excluded of [{ repeat: true }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])
            await recordKey({ ...modifiers, ...excluded });
          await act(async () => changeActive(false));
          assert.equal(await recordKey(modifiers), false);
          await act(async () => changeActive(true));
          assert.equal(microphoneRequests.length, before + 1);
        }
        Object.defineProperty(navigator, 'platform', { configurable: true, value: 'MacIntel' });
        await act(async () => replaceText('Synthetic review request'));
        const { pageDataCache } = await import('./src/web/lib/page-data-cache.ts');
        const refreshAudio = () => act(async () => pageDataCache.refresh('/api/speech', true));
        speechStatus = { transcription: false, localInput: { state: 'not_downloaded' }, local: { state: 'not_downloaded' } };
        await refreshAudio();
        const persistentMicrophone = document.querySelector('.record-button');
        const beforeSetupMicrophones = microphoneRequests.length;
        await click('Record an audio message');
        assert.equal(microphoneRequests.length, beforeSetupMicrophones + 1);
        assert.equal(audioPreparations.length, 0);
        const immediateCapture = microphone();
        await act(async () => microphoneRequests.at(-1).resolve(immediateCapture));
        await settle(() => audioPreparations.length === 1);
        assert.deepEqual(JSON.parse(audioPreparations[0].options.body), { inputOnly: true });
        assert.equal(document.querySelector('.voice-setup'), null);
        assert.ok(document.querySelector('.record-button') === persistentMicrophone);
        await click('Stop and preview recording');
        await settle(() => document.querySelector('audio'));
        const initialRecording = document.querySelector('audio').src;
        await submit();
        await settle(() => document.querySelector('[aria-label="Cancel sending"]'));
        const preparingCaptureCount = microphoneRequests.length;
        await recordKey();
        assert.equal(microphoneRequests.length, preparingCaptureCount);
        assert.equal(sends.length, beforeHoldSend);
        await click('Cancel sending');
        await settle(() => document.querySelector('audio'));
        assert.equal(audioPreparations[0].options.signal.aborted, true);
        assert.equal(document.querySelector('audio').src, initialRecording);
        assert.equal(currentText, 'Synthetic review request');
        await submit();
        await settle(() => audioPreparations.length === 2);
        await act(async () => audioPreparations[1].resolve(Response.json({ error: 'Synthetic download interruption' }, { status: 503 })));
        await settle(() => document.querySelector('audio'));
        assert.equal(sends.length, beforeHoldSend);
        assert.equal(document.querySelector('audio').src, initialRecording);
        assert.equal(currentText, 'Synthetic review request');
        await submit();
        await settle(() => audioPreparations.length === 3);
        speechStatus = { transcription: true, transcriptionFormat: 'wav', localInput: { state: 'ready' }, local: { state: 'not_downloaded' } };
        await act(async () => audioPreparations[2].resolve(Response.json({ transcription: true, transcriptionFormat: 'wav' })));
        await settle(() => sends.length === beforeHoldSend + 1);
        assert.equal(sends.at(-1).recording.type, 'audio/wav');
        assert.equal(immediateCapture.track.stopped, true);
        await settle(() => !document.querySelector('audio'));
        for (const localState of ['failed', 'downloading']) {
          speechStatus = { transcription: true, local: { state: localState, progress: 60 } };
          await refreshAudio();
          const beforeProviderRecording = microphoneRequests.length;
          await click('Record an audio message');
          assert.equal(microphoneRequests.length, beforeProviderRecording + 1);
          await click('Cancel recording');
          const cancelledProviderRecording = microphone();
          await act(async () => microphoneRequests.at(-1).resolve(cancelledProviderRecording));
          assert.equal(cancelledProviderRecording.track.stopped, true);
          assert.equal(audioPreparations.length, 3);
        }
        speechStatus = { transcription: false, localInput: { state: 'not_downloaded' }, local: { state: 'not_downloaded' } };
        await refreshAudio();
        await click('Record an audio message');
        await act(async () => microphoneRequests.at(-1).resolve(microphone()));
        await settle(() => audioPreparations.length === 4);
        await act(async () => changeActive(false));
        assert.equal(audioPreparations[3].options.signal.aborted, true);
        await act(async () => changeActive(true));
        await settle(() => document.querySelector('audio'));
        await click('Discard recording');
        speechStatus = undefined;
        await act(async () => root.unmount());
        const { Chat } = await import('./src/web/pages/chat.tsx');
        pageDataCache.clear();
        HTMLElement.prototype.scrollTo = () => {};
        HTMLElement.prototype.scrollIntoView = () => {};
        const audioRequests = [];
        const sentAudio = {
          id: '00000000-0000-4000-8000-000000000222',
          name: 'Synthetic recording.mp4', mimeType: 'audio/mp4', size: 15,
          url: '/api/artifacts/00000000-0000-4000-8000-000000000222',
        };
        let outcome = 'unknown';
        fetch = async (url, options = {}) => {
          if (url === '/api/speech') return Response.json({ transcription: true, transcriptionFormat: speechFormat });
          if (url === '/api/apps') return Response.json([]);
          if (url === '/api/trust') return Response.json({});
          if (url === '/api/onboarding/introduction') return Response.json({ messageId: null });
          assert.equal(url, '/api/messages/audio');
          const body = options.body.get('message');
          const file = options.body.get('file');
          audioRequests.push({ body, file, bytes: await file.arrayBuffer() });
          if (outcome === 'unknown') throw new TypeError('Synthetic lost response');
          if (outcome === 'retryable') return Response.json({ error: 'Synthetic unavailable transcription', retryable: true }, { status: 503 });
          if (outcome === 'question_unavailable') return Response.json({ error: 'Synthetic unavailable question', code: outcome }, { status: 409 });
          return Response.json({
            messageId: JSON.parse(body).clientMessageId, turnId: 'synthetic-turn',
            messageText: '', audioCaption: '',
            ...(outcome === 'private' ? { verificationStatus: 'submitted' } : { attachments: [sentAudio] }),
          });
        };
        let chatState = {
          threadId: 'synthetic-thread', turns: [], activity: [], tasks: [],
          verificationRequests: [], configuration: { llmReady: true },
          messages: [{ id: 'synthetic-assistant', role: 'assistant', text: 'Synthetic conversation', attachments: [], turnId: null, createdAt: '2026-10-26T12:00:00Z' }],
        };
        let chatRefreshes = 0;
        const renderChat = () => act(async () => root.render(createElement(Chat, {
          ownerId: 'synthetic-owner', state: chatState, streams: {}, refresh: async () => { chatRefreshes++; },
        })));
        root = createRoot(document.getElementById('root'));
        speechFormat = undefined;
        await renderChat();
        await settle(() => document.querySelector('[aria-label="Record an audio message"]:not(:disabled)'));
        await click('Record an audio message');
        await act(async () => microphoneRequests.at(-1).resolve(microphone()));
        await submit();
        await settle(() => audioRequests.length === 1 && document.querySelector('.composer audio'));
        const uncertain = audioRequests[0];
        assert.equal(uncertain.file.type, 'audio/mp4');
        speechFormat = 'wav';
        chatState = { ...chatState, messages: [...chatState.messages, { ...chatState.messages[0], id: 'synthetic-later-assistant' }] };
        await renderChat();
        await act(async () => window.dispatchEvent(new Event('focus')));
        outcome = 'success';
        const retryPreviewStart = created.length;
        await submit();
        await settle(() => audioRequests.length === 2 && !document.querySelector('.composer audio'));
        assert.ok(document.querySelector('.message-user audio'));
        assert.equal(document.querySelector('.message-user audio').getAttribute('src'), sentAudio.url);
        assert.ok(revoked.includes(created.at(-1).url));
        assert.ok(created.slice(retryPreviewStart).some(item => item.file.type === 'audio/wav'));
        assert.equal(audioRequests[1].body, uncertain.body);
        assert.equal(audioRequests[1].file.type, uncertain.file.type);
        assert.equal(audioRequests[1].file.name, uncertain.file.name);
        assert.deepEqual(audioRequests[1].bytes, uncertain.bytes);
        speechFormat = undefined;
        await act(async () => window.dispatchEvent(new Event('focus')));
        await click('Record an audio message');
        await act(async () => microphoneRequests.at(-1).resolve(microphone()));
        outcome = 'retryable';
        await submit();
        await settle(() => audioRequests.length === 3 && document.querySelector('.composer audio'));
        speechFormat = 'wav';
        await act(async () => window.dispatchEvent(new Event('focus')));
        outcome = 'success';
        await submit();
        await settle(() => audioRequests.length === 4 && !document.querySelector('.composer audio'));
        assert.notEqual(JSON.parse(audioRequests[3].body).clientMessageId, JSON.parse(audioRequests[2].body).clientMessageId);
        assert.equal(audioRequests[3].file.type, 'audio/wav');
        const publicPlayers = document.querySelectorAll('.message-user audio').length;
        await click('Record an audio message');
        await act(async () => microphoneRequests.at(-1).resolve(microphone()));
        outcome = 'private';
        await submit();
        await settle(() => audioRequests.length === 5 && !document.querySelector('.composer audio'));
        assert.equal(document.querySelectorAll('.message-user audio').length, publicPlayers);
        assert.ok(revoked.includes(created.at(-1).url));
        const audioFetch = fetch;
        const choiceRequests = [];
        let choiceOutcome = 'success';
        fetch = async (url, options = {}) => {
          if (url === '/api/uploads/renew') return Response.json([artifact]);
          if (url !== '/api/messages') return audioFetch(url, options);
          const input = JSON.parse(options.body);
          choiceRequests.push(input);
          if (choiceOutcome !== 'success') return Response.json({
            error: 'Synthetic ' + choiceOutcome,
            ...(choiceOutcome === 'question_unavailable' ? { code: choiceOutcome } : {}),
          }, { status: 409 });
          return Response.json({ messageId: input.clientMessageId, turnId: 'synthetic-choice-turn' });
        };
        const question = {
          id: '00000000-0000-4000-8000-000000000333',
          role: 'assistant', text: 'Which synthetic mailbox?', attachments: [],
          turnId: 'synthetic-question-turn', createdAt: '2026-10-26T12:00:00Z',
          answerChoices: { multiple: false, options: [
            { id: '00000000-0000-4000-8000-000000000334', label: 'Work', description: 'Synthetic shared mailbox' },
            { id: '00000000-0000-4000-8000-000000000335', label: 'Personal' },
          ] },
        };
        const chatDraftKey = 'nod.chat-draft.synthetic-owner.synthetic-thread';
        const mountQuestion = async (pending, draft) => {
          await act(async () => root.unmount());
          pageDataCache.clear();
          localStorage.setItem(chatDraftKey, JSON.stringify({ version: 1, missing: [], attachments: [], reply: null, ...draft }));
          chatState = { ...chatState, messages: [{ ...question, answerChoicesPending: pending }], pendingAnswerChoiceMessageIds: pending ? [question.id] : [] };
          root = createRoot(document.getElementById('root'));
          await renderChat();
          await settle(() => draft.text.split('\n').every(line => document.querySelector('[contenteditable]')?.textContent.includes(line)));
          await settle(() => !document.querySelector('[aria-label="Send message"]').disabled);
        };
        const quote = { id: question.id, role: question.role, text: question.text };
        await mountQuestion(false, { text: 'Synthetic historical follow-up' });
        await click('Reply to message');
        await submit();
        await settle(() => choiceRequests.length === 1);
        assert.equal(choiceRequests[0].replyToMessageId, question.id);
        assert.equal(choiceRequests[0].questionAnswer, undefined);
        const qualifiedAnswer = 'Work: Synthetic shared mailbox\nAlso include the archive, but only for drafts.';
        await mountQuestion(true, { text: qualifiedAnswer, reply: { ...quote, answerQuestion: true }, attachments: [artifact] });
        choiceOutcome = 'question_unavailable';
        const beforeChoiceRefresh = chatRefreshes;
        await submit();
        await settle(() => choiceRequests.length === 2 && qualifiedAnswer.split('\n').every(line => document.querySelector('[contenteditable]')?.textContent.includes(line)));
        await settle(() => !document.querySelector('.answer-choices'));
        assert.deepEqual(choiceRequests[1].questionAnswer, { custom: true });
        assert.ok(chatRefreshes > beforeChoiceRefresh);
        assert.equal(document.querySelector('[role="alert"]'), null);
        const retainedAnswer = JSON.parse(localStorage.getItem(chatDraftKey));
        assert.equal(retainedAnswer.text, choiceRequests[1].text);
        assert.equal(retainedAnswer.reply.id, question.id);
        assert.equal(retainedAnswer.reply.answerQuestion, undefined);
        assert.deepEqual(retainedAnswer.attachments.map(file => file.id), [artifact.id]);
        assert.equal(choiceRequests.length, 2);
        choiceOutcome = 'success';
        await submit();
        await settle(() => choiceRequests.length === 3);
        assert.equal(choiceRequests[2].questionAnswer, undefined);
        assert.equal(choiceRequests[2].replyToMessageId, question.id);
        assert.equal(choiceRequests[2].text, choiceRequests[1].text);
        assert.deepEqual(choiceRequests[2].attachmentIds, [artifact.id]);
        assert.notEqual(choiceRequests[2].clientMessageId, choiceRequests[1].clientMessageId);
        await mountQuestion(true, { text: 'Unrelated draft stays here', attachments: [artifact] });
        choiceOutcome = 'question_unavailable';
        await act(async () => document.querySelector('.answer-choice').click());
        await settle(() => choiceRequests.length === 4 && !document.querySelector('.answer-choices'));
        assert.equal(document.querySelector('[role="alert"]'), null);
        assert.equal(document.querySelector('[contenteditable]').textContent, 'Unrelated draft stays here');
        assert.deepEqual(JSON.parse(localStorage.getItem(chatDraftKey)).attachments.map(file => file.id), [artifact.id]);
        assert.equal(choiceRequests.length, 4);
        await mountQuestion(false, { text: 'Synthetic conflict remains visible', reply: quote });
        choiceOutcome = 'message-id-conflict';
        await submit();
        await settle(() => choiceRequests.length === 5 && document.querySelector('[role="alert"]'));
        assert.match(document.querySelector('[role="alert"]').textContent, /Synthetic message-id-conflict/);
        await mountQuestion(true, { text: 'Synthetic audio qualifier', reply: { ...quote, answerQuestion: true } });
        outcome = 'question_unavailable';
        const beforeQuestionAudio = audioRequests.length;
        await click('Record an audio message');
        await act(async () => microphoneRequests.at(-1).resolve(microphone()));
        await submit();
        await settle(() => audioRequests.length === beforeQuestionAudio + 1 && document.querySelector('.composer audio'));
        assert.equal(document.querySelector('[role="alert"]'), null);
        assert.equal(document.querySelector('[contenteditable]').textContent, 'Synthetic audio qualifier');
        assert.equal(JSON.parse(localStorage.getItem(chatDraftKey)).reply.id, question.id);
        assert.equal(JSON.parse(localStorage.getItem(chatDraftKey)).reply.answerQuestion, undefined);
        assert.equal(document.querySelector('.answer-choices'), null);
        assert.equal(audioRequests.length, beforeQuestionAudio + 1);
      } finally {
        if (!closed) await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
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
    assert.match(search.target!, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      {
        origin: search.origin,
        url: search.url,
        controls: search.controls,
        submits: search.submits,
      },
      {
        origin: 'https://1.1.1.1',
        url: 'https://1.1.1.1/login',
        controls: [{ role: 'textbox', name: 'Search' }],
        submits: 'unknown',
      },
    );
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
    await assert.rejects(
      computer.act('checked', {
        action: 'drag',
        selector: '@e3',
        targetSelector: '@e2',
        expectTarget: search.target,
      }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
    );
    page().location = {
      origin: 'https://1.1.1.1',
      href: 'https://1.1.1.1/login?token=first',
    };
    page().dom.window.history.replaceState(null, '', '/login?token=first');
    const collision = await computer.currentPage('checked', next);
    page().location.href = 'https://1.1.1.1/login?token=second';
    page().dom.window.history.replaceState(null, '', '/login?token=second');
    await assert.rejects(
      computer.act('checked', {
        ...next,
        expectOrigin: collision.origin,
        expectUrl: collision.url,
        expectTarget: collision.target,
      }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
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
    const nextTarget = await computer.currentPage('checked', next);
    await computer.act('checked', { action: 'snapshot' });
    assert.equal((await computer.currentPage('checked', next)).target, nextTarget.target);
    await computer.act('checked', {
      ...next,
      expectOrigin: 'https://1.1.1.1',
      expectTarget: nextTarget.target,
    });
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
    const beforeControlChange = await computer.currentPage('checked', {
      action: 'click',
      selector: `@${searchRef}`,
    });
    await computer.act('checked', {
      action: 'evaluate',
      script: "document.querySelector('#search').setAttribute('aria-label', 'Delete account')",
    });
    assert.deepEqual(
      (await computer.currentPage('checked', { action: 'click', selector: `@${searchRef}` }))
        .controls,
      [{ role: 'textbox', name: 'Delete account' }],
    );
    await assert.rejects(
      computer.act('checked', {
        action: 'click',
        selector: `@${searchRef}`,
        expectTarget: beforeControlChange.target,
      }),
      (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
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
      const cssStep = { action: 'click', selector: '#plain' } as const;
      const original = await computer.currentPage('submits', cssStep);
      assert.equal((await computer.currentPage('submits', cssStep)).target, original.target);
      await computer.act('submits', { ...cssStep, expectTarget: original.target });
      const enterStep = { action: 'press', key: 'Enter' } as const;
      const focused = await computer.currentPage('submits', enterStep);
      await computer.act('submits', { ...enterStep, expectTarget: focused.target });
      const located = await computer.act('submits', {
        action: 'evaluate',
        script:
          "const r=document.querySelector('#plain').getBoundingClientRect();({x:(r.x+r.width/2)/innerWidth,y:(r.y+r.height/2)/innerHeight})",
      });
      const point = JSON.parse(located.text.slice(located.text.indexOf('\n') + 1)) as {
        x: number;
        y: number;
      };
      const pointStep = { action: 'click', ...point } as const;
      const pointed = await computer.currentPage('submits', pointStep);
      await computer.act('submits', { ...pointStep, expectTarget: pointed.target });
      await computer.act('submits', {
        action: 'evaluate',
        script:
          "const plain=document.querySelector('#plain');plain.replaceWith(plain.cloneNode(true))",
      });
      const replacement = await computer.currentPage('submits', cssStep);
      assert.notEqual(replacement.target, original.target);
      await assert.rejects(
        computer.act('submits', { ...cssStep, expectTarget: original.target }),
        (error) => error instanceof BrowserActionError && error.code === 'browser_target_changed',
      );
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
    const makeComputer = () => {
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
      return computer;
    };
    const worker = await harness({ computer: makeComputer });
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
      const byRef = await client.signInMethods!('fixture', origin, [
        { label: 'Ignored', selector: '@' + ref },
      ]);
      assert.equal(byRef.methods[0]!.label, 'Continue with Example');
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@e9999' }]),
      );
      await act({ action: 'open', url: origin + '/covered' });
      await act({ action: 'click', selector: '#change' });
      const covered = /button "Continue with Example"[^\n]*ref=(e\d+)/.exec(
        (await act({ action: 'snapshot' })).text,
      )?.[1];
      assert.ok(covered);
      await assert.rejects(
        client.signInMethods!('fixture', origin, [{ label: 'Ignored', selector: '@' + covered }]),
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
      await assert.rejects(act({ action: 'click', selector: '#ordinary' }), /unavailable/);
      await act({ action: 'open', url: origin + '/cancel' });
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

test('chat retires reply targets without losing drafts or duplicating ambiguous sends', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLButtonElement', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'DOMParser'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollTo = () => {};
      HTMLElement.prototype.scrollIntoView = () => {};
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = () => [rect];
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [rect];
      const requests = [], releases = [];
      let committed = null;
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/trust') return Response.json({});
        if (path === '/api/speech') return Response.json({ transcription: true });
        if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
        assert.equal(path, '/api/messages');
        const message = JSON.parse(options.body);
        requests.push(message);
        if (committed)
          return message.clientMessageId === committed.clientMessageId
            ? Response.json({
                error: 'This message ID is already in use. Send this as a new message.',
              }, { status: 409 })
            : Response.json({ messageId: message.clientMessageId, turnId: 'synthetic-duplicate-turn' });
        return new Promise((resolve, reject) => releases.push({ resolve, reject }));
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Chat } = await import('./src/web/pages/chat.tsx');
      const ids = [
        '00000000-0000-4000-8000-000000000701',
        '00000000-0000-4000-8000-000000000702',
        '00000000-0000-4000-8000-000000000703',
      ];
      const messages = ids.map((id, index) => ({
        id, role: 'assistant', text: 'Synthetic confirmation ' + index,
        attachments: [], turnId: 'synthetic-turn-' + index, createdAt: '2026-10-26T12:00:00Z',
      }));
      const draft = 'Synthetic cancellation draft';
      const draftKey = 'nod.chat-draft.synthetic-owner.synthetic-thread';
      const saveDraft = reply => localStorage.setItem(draftKey, JSON.stringify({
        version: 1, text: draft, reply, attachments: [], missing: [],
      }));
      saveDraft(null);
      let state = {
        threadId: 'synthetic-thread', turns: [], activity: [], tasks: [],
        verificationRequests: [], configuration: { llmReady: true }, messages,
      };
      let root = createRoot(document.getElementById('root'));
      const render = () => act(async () => root.render(createElement(Chat, {
        ownerId: 'synthetic-owner', state, streams: {}, refresh: async () => {},
      })));
      const settle = async check => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(check(), 'Expected reply transition to settle');
      };
      const reply = async id => {
        const button = document.querySelector('[data-message-id="' + id + '"] [aria-label="Reply to message"]');
        assert.ok(button, 'Expected visible reply target ' + id);
        await act(async () => button.click());
        assert.ok(document.querySelector('.composer-reply'));
      };
      const submit = () => act(async () =>
        document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      const hasDraft = () => document.querySelector('[contenteditable]')?.textContent === draft;
      try {
        await render();
        await settle(hasDraft);
        await reply(ids[0]);
        state = { ...state, hiddenMessageIds: [ids[0]] };
        await render();
        assert.equal(document.querySelector('.composer-reply'), null);
        assert.ok(hasDraft());
        assert.equal(JSON.parse(localStorage.getItem(draftKey)).reply, null);
        await act(async () => root.unmount());
        saveDraft({ id: ids[0], role: 'assistant', text: messages[0].text });
        root = createRoot(document.getElementById('root'));
        await render();
        await settle(hasDraft);
        assert.equal(document.querySelector('.composer-reply'), null);
        await reply(ids[1]);
        await submit();
        await settle(() => requests.length === 1);
        assert.equal(requests[0].replyToMessageId, ids[1]);
        await act(async () => releases[0].resolve(Response.json({
          error: 'The reply is unavailable in this conversation.',
        }, { status: 404 })));
        await settle(() => hasDraft() && !document.querySelector('.composer-reply'));
        await submit();
        await settle(() => requests.length === 2);
        assert.equal(requests[1].replyToMessageId, undefined);
        assert.notEqual(requests[1].clientMessageId, requests[0].clientMessageId);
        await act(async () => releases[1].reject(new TypeError('Synthetic plain response lost')));
        await settle(hasDraft);
        state = { ...state, hiddenMessageIds: [ids[0], ids[1]] };
        await render();
        await reply(ids[2]);
        await submit();
        await settle(() => requests.length === 3);
        assert.equal(requests[2].replyToMessageId, ids[2]);
        committed = requests[2];
        await act(async () => releases[2].reject(new TypeError('Synthetic response lost')));
        await settle(() => hasDraft() && document.querySelector('.composer-reply'));
        state = { ...state, hiddenMessageIds: ids, messages: [...messages, {
          id: committed.clientMessageId, role: 'user', text: draft, attachments: [],
          replyToMessageId: ids[2], turnId: 'synthetic-committed-turn', createdAt: '2026-10-26T12:01:00Z',
        }] };
        await render();
        await settle(() => hasDraft() && !document.querySelector('.composer-reply'));
        await submit();
        await settle(() => requests.length === 4);
        assert.equal(requests[3].replyToMessageId, undefined);
        assert.notEqual(requests[3].clientMessageId, committed.clientMessageId);
        assert.equal(requests[3].text, draft);
        assert.ok(document.querySelector('[data-message-id="' + committed.clientMessageId + '"]'));
        assert.equal(document.querySelector('[role="alert"]'), null);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('chat reloads older history after hidden confirmations exceed the ID window', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLButtonElement', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'DOMParser'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollTo = () => {};
      HTMLElement.prototype.scrollIntoView = () => {};
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = () => [rect];
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [rect];
      document.hasFocus = () => true;
      const older = {
        id: '00000000-0000-4000-8000-000000000801', role: 'assistant',
        text: 'Older synthetic confirmation', attachments: [], turnId: 'synthetic-old-turn',
        createdAt: '2026-10-25T12:00:00Z',
      };
      const stale = { ...older, id: '00000000-0000-4000-8000-000000000802',
        text: 'Another retired confirmation', createdAt: '2026-10-24T12:00:00Z' };
      const latest = Array.from({ length: 150 }, (_, index) => ({
        id: '00000000-0000-4000-8000-' + String(1000 + index).padStart(12, '0'),
        role: 'assistant', text: 'Recent synthetic message ' + index, attachments: [],
        turnId: 'synthetic-recent-turn',
        createdAt: new Date(Date.parse('2026-10-26T12:00:00Z') + index * 60_000).toISOString(),
      }));
      const recentHidden = Array.from({ length: 150 }, (_, index) =>
        '00000000-0000-4000-8000-' + String(5000 + index).padStart(12, '0'));
      const unreadTarget = latest[51];
      const readCursor = { createdAt: latest[50].createdAt, messageIds: [latest[50].id] };
      const threadId = '00000000-0000-4000-8000-000000000811';
      const draft = 'Synthetic older reply';
      const draftKey = 'nod.chat-draft.synthetic-owner.' + threadId;
      localStorage.setItem(draftKey,
        JSON.stringify({ version: 1, text: draft, reply: null, attachments: [], missing: [] }));
      let retired = false, oldHistory = null, validReload = null, freshPages = 0, aroundChecks = 0;
      const rejectSend = [];
      const sends = [];
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/trust') return Response.json({});
        if (path === '/api/speech') return Response.json({ transcription: true });
        if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
        if (path === '/api/messages/around/' + older.id) {
          aroundChecks++;
          if (!retired && state.hiddenMessageCount === 152 && aroundChecks === 2)
            throw new TypeError('Synthetic availability check offline');
          return retired
            ? Response.json({ error: 'Message not found.' }, { status: 404 })
            : Response.json([older]);
        }
        if (String(path).startsWith('/api/messages?')) {
          const beforeId = new URL(String(path), 'https://nod.fixture.invalid').searchParams.get('beforeId');
          if (!retired && state.hiddenMessageCount === 152 && beforeId === latest[0].id)
            return new Promise(resolve => { validReload = resolve; });
          if (!retired && beforeId === older.id)
            return new Promise(resolve => { oldHistory = resolve; });
          if (retired) {
            freshPages++;
            return Response.json({ messages: [], hasMore: false });
          }
          return Response.json({ messages: [older], hasMore: true });
        }
        assert.equal(path, '/api/messages');
        const body = JSON.parse(options.body);
        sends.push(body);
        if (sends.length <= 2)
          return new Promise((_resolve, reject) => { rejectSend.push(reject); });
        return Response.json({ messageId: body.clientMessageId, turnId: 'synthetic-sent-turn' });
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Chat } = await import('./src/web/pages/chat.tsx');
      let state = {
        threadId, turns: [], activity: [], tasks: [], verificationRequests: [],
        configuration: { llmReady: true }, messages: latest, hasEarlierMessages: true,
        hiddenMessageCount: 151, hiddenMessageIds: recentHidden,
      };
      const root = createRoot(document.getElementById('root'));
      const render = () => act(async () => root.render(createElement(Chat, {
        ownerId: 'synthetic-owner', state, streams: {}, refresh: async () => {},
        readCursor,
      })));
      const settle = async check => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(check(), 'Expected hidden-history transition to settle');
      };
      const hasDraft = () => document.querySelector('[contenteditable]')?.textContent === draft;
      const visible = id => Boolean(document.querySelector('[data-message-id="' + id + '"]'));
      const firstUnread = () => document.querySelector('.unread-divider')?.nextElementSibling?.getAttribute('data-message-id');
      const submit = () => act(async () => document.querySelector('form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true })));
      try {
        await render();
        await settle(hasDraft);
        assert.equal(firstUnread(), unreadTarget.id);
        await act(async () => window.dispatchEvent(new CustomEvent('nod:focus-message', {
          detail: { messageId: older.id },
        })));
        await settle(() => visible(older.id));
        await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
        const reply = document.querySelector('[data-message-id="' + older.id + '"] [aria-label="Reply to message"]');
        assert.ok(reply);
        await act(async () => reply.click());
        assert.ok(document.querySelector('.composer-reply'));
        await submit();
        await settle(() => sends.length === 1 && rejectSend.length === 1);
        await act(async () => rejectSend[0](new TypeError('Synthetic response lost')));
        await settle(() => hasDraft() && document.querySelector('.composer-reply'));
        state = { ...state, hiddenMessageCount: 152,
          hiddenMessageIds: [unreadTarget.id, ...recentHidden.slice(0, 149)],
          messages: latest.filter(message => message.id !== unreadTarget.id) };
        await render();
        assert.equal(firstUnread(), latest[52].id);
        const retryReply = () => document.querySelector(
          '.composer-reply button[aria-label="Retry reply availability"]');
        await settle(() => aroundChecks >= 2 && validReload && retryReply());
        assert.ok(!document.querySelector('.composer-reply')?.textContent.includes('Older synthetic confirmation'));
        assert.equal(JSON.parse(localStorage.getItem(draftKey)).reply.text, older.text);
        assert.ok(hasDraft());
        await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
        assert.equal(aroundChecks, 2);
        await act(async () => retryReply().click());
        await settle(() => aroundChecks >= 3 &&
          document.querySelector('.composer-reply .message-reply-quote'));
        assert.ok(hasDraft());
        await submit();
        await settle(() => sends.length === 2 && rejectSend.length === 2 &&
          document.querySelector('.message-user .message-reply-quote'));
        assert.ok(aroundChecks >= 3);
        assert.equal(sends[1].clientMessageId, sends[0].clientMessageId);
        assert.equal(sends[1].replyToMessageId, older.id);
        await act(async () => validReload(Response.json({ messages: [older], hasMore: true })));
        await settle(() => visible(older.id));
        const scroll = document.querySelector('.conversation-scroll');
        Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
        Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 200 });
        for (let attempt = 0; attempt < 30 && !oldHistory; attempt++)
          await act(async () => {
            scroll.scrollTop = 0;
            scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 10));
          });
        assert.ok(oldHistory, 'Expected older pagination to be pending');
        const pendingReply = document.querySelector('[data-message-id="' + older.id + '"] [aria-label="Reply to message"]');
        assert.ok(pendingReply);
        await act(async () => pendingReply.click());
        assert.ok(document.querySelector('.composer-reply'));
        retired = true;
        state = { ...state, hiddenMessageCount: 303, hiddenMessageIds: recentHidden,
          hasEarlierMessages: false };
        await render();
        assert.equal(visible(older.id), false);
        assert.ok(!document.querySelector('.composer-reply')?.textContent.includes('Older synthetic confirmation'));
        assert.ok(document.querySelector('.message-user'));
        assert.equal(document.querySelector('.message-user .message-reply-quote'), null);
        await settle(() => !document.querySelector('.composer-reply'));
        await act(async () => oldHistory(Response.json({ messages: [stale], hasMore: false })));
        await settle(() => freshPages > 0 && !visible(stale.id));
        assert.equal(visible(older.id), false);
        await act(async () => rejectSend[1](new TypeError('Synthetic second response lost')));
        await settle(() => hasDraft() && !document.querySelector('.composer-reply'));
        assert.equal(JSON.parse(localStorage.getItem(draftKey)).reply, null);
        await submit();
        await settle(() => document.querySelector('[role="alert"]')?.textContent.includes('may have been sent'));
        assert.equal(sends.length, 2);
        assert.ok(hasDraft());
        await submit();
        await settle(() => sends.length === 3);
        assert.equal(sends[2].replyToMessageId, undefined);
        assert.notEqual(sends[2].clientMessageId, sends[0].clientMessageId);
        assert.equal(sends[2].text, draft);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('chat removes a cached older reply quote when its target becomes hidden', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLButtonElement', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'DOMParser'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollTo = () => {};
      HTMLElement.prototype.scrollIntoView = () => {};
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = () => [rect];
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [rect];
      const target = {
        id: '00000000-0000-4000-8000-000000000851', role: 'assistant',
        text: 'Older synthetic confirmation', attachments: [],
        turnId: 'synthetic-old-turn', createdAt: '2026-10-25T12:00:00Z',
      };
      const olderReply = {
        id: '00000000-0000-4000-8000-000000000852', role: 'user',
        text: 'Synthetic response', attachments: [], replyToMessageId: target.id,
        replyTo: { id: target.id, role: target.role, text: target.text },
        turnId: 'synthetic-reply-turn', createdAt: '2026-10-25T12:01:00Z',
      };
      const recent = {
        id: '00000000-0000-4000-8000-000000000853', role: 'assistant',
        text: 'Recent synthetic message', attachments: [],
        turnId: 'synthetic-recent-turn', createdAt: '2026-10-26T12:00:00Z',
      };
      globalThis.fetch = async path => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/trust') return Response.json({});
        if (path === '/api/speech') return Response.json({ transcription: true });
        if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
        if (path === '/api/messages/around/' + olderReply.id)
          return Response.json([target, olderReply]);
        if (String(path).startsWith('/api/messages?'))
          return Response.json({ messages: [], hasMore: false });
        throw new Error('Unexpected request: ' + path);
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Chat } = await import('./src/web/pages/chat.tsx');
      let state = {
        threadId: '00000000-0000-4000-8000-000000000854',
        turns: [], activity: [], tasks: [], verificationRequests: [],
        configuration: { llmReady: true }, messages: [recent], hasEarlierMessages: true,
        hiddenMessageCount: 0, hiddenMessageIds: [],
      };
      const root = createRoot(document.getElementById('root'));
      const render = () => act(async () => root.render(createElement(Chat, {
        ownerId: 'synthetic-owner', state, streams: {}, refresh: async () => {},
      })));
      const quote = () => document.querySelector(
        '[data-message-id="' + olderReply.id + '"] .message-reply-quote');
      try {
        await render();
        await act(async () => window.dispatchEvent(new CustomEvent('nod:focus-message', {
          detail: { messageId: olderReply.id },
        })));
        for (let attempt = 0; attempt < 100 && !quote(); attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(quote(), 'Expected the older persisted reply quote to load');
        state = { ...state, hiddenMessageCount: 1, hiddenMessageIds: [target.id] };
        await render();
        assert.ok(document.querySelector('[data-message-id="' + olderReply.id + '"]'));
        assert.equal(document.querySelector('[data-message-id="' + target.id + '"]'), null);
        assert.equal(quote(), null);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('chat resumes history after a failed focus check and cancels pending focus on Return', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLButtonElement', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'DOMParser'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollTo = () => {};
      HTMLElement.prototype.scrollIntoView = () => {};
      const rect = { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      HTMLElement.prototype.getBoundingClientRect = () => rect;
      HTMLElement.prototype.getClientRects = () => [rect];
      dom.window.Range.prototype.getBoundingClientRect = () => rect;
      dom.window.Range.prototype.getClientRects = () => [rect];
      document.hasFocus = () => true;
      const replyTarget = {
        id: '00000000-0000-4000-8000-000000000861', role: 'assistant',
        text: 'Recent synthetic message', attachments: [],
        turnId: 'synthetic-recent-turn', createdAt: '2026-10-26T12:00:00Z',
      };
      const focusTarget = {
        id: '00000000-0000-4000-8000-000000000862', role: 'assistant',
        text: 'Older synthetic message', attachments: [],
        turnId: 'synthetic-focus-turn', createdAt: '2026-10-25T12:00:00Z',
      };
      const earlier = {
        id: '00000000-0000-4000-8000-000000000863', role: 'assistant',
        text: 'Earlier synthetic page', attachments: [],
        turnId: 'synthetic-earlier-turn', createdAt: '2026-10-24T12:00:00Z',
      };
      const threadId = '00000000-0000-4000-8000-000000000864';
      const draft = 'Synthetic reply draft';
      const draftKey = 'nod.chat-draft.synthetic-owner.' + threadId;
      localStorage.setItem(draftKey, JSON.stringify({
        version: 1, text: draft, reply: null, attachments: [], missing: [],
      }));
      const hiddenIds = Array.from({ length: 150 }, (_, index) =>
        '00000000-0000-4000-8000-' + String(6000 + index).padStart(12, '0'));
      let state = {
        threadId, turns: [], activity: [], tasks: [], verificationRequests: [],
        configuration: { llmReady: true }, messages: [replyTarget], hasEarlierMessages: true,
        hiddenMessageCount: 151, hiddenMessageIds: hiddenIds,
      };
      let visible = true, focusChecks = 0, historyChecks = 0;
      globalThis.fetch = async path => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/trust') return Response.json({});
        if (path === '/api/speech') return Response.json({ transcription: true });
        if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
        if (path === '/api/messages/around/' + focusTarget.id) {
          focusChecks++;
          if (focusChecks === 1) return Response.json([focusTarget]);
          throw new TypeError('Synthetic focus validation offline');
        }
        if (String(path).startsWith('/api/messages?')) {
          historyChecks++;
          return Response.json(historyChecks === 1
            ? { messages: [], hasMore: true }
            : { messages: [earlier], hasMore: false });
        }
        throw new Error('Unexpected request: ' + path);
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Chat } = await import('./src/web/pages/chat.tsx');
      let root = createRoot(document.getElementById('root'));
      const render = () => act(async () => root.render(createElement(Chat, {
        ownerId: 'synthetic-owner', state, streams: {}, refresh: async () => {}, visible,
      })));
      const settle = async check => {
        for (let attempt = 0; attempt < 100 && !check(); attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(check(), 'Expected focus navigation to settle');
      };
      const messageVisible = id => Boolean(document.querySelector('[data-message-id="' + id + '"]'));
      const hasDraft = () => document.querySelector('[contenteditable]')?.textContent === draft;
      const pageFromTop = async check => {
        const scroll = document.querySelector('.conversation-scroll');
        Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 100 });
        Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 200 });
        for (let attempt = 0; attempt < 30 && !check(); attempt++)
          await act(async () => {
            scroll.scrollTop = 0;
            scroll.dispatchEvent(new Event('scroll', { bubbles: true }));
            await new Promise(resolve => setTimeout(resolve, 10));
          });
        assert.ok(check(), 'Expected ordinary history pagination');
      };
      try {
        await render();
        await settle(hasDraft);
        visible = false;
        await render();
        await act(async () => window.dispatchEvent(new CustomEvent('nod:focus-message', {
          detail: { messageId: focusTarget.id },
        })));
        await settle(() => focusChecks === 1 && messageVisible(focusTarget.id));
        const reply = document.querySelector(
          '[data-message-id="' + focusTarget.id + '"] [aria-label="Reply to message"]');
        assert.ok(reply);
        await act(async () => reply.click());
        await settle(() => JSON.parse(localStorage.getItem(draftKey)).reply?.id === focusTarget.id);
        state = { ...state, hiddenMessageCount: 152 };
        await render();
        await settle(() => focusChecks === 2 && historyChecks >= 1 &&
          document.querySelector('[role="alert"]')?.textContent.includes('offline'));
        visible = true;
        await render();
        await pageFromTop(() => historyChecks >= 2 && messageVisible(earlier.id));
        assert.ok(hasDraft());
        assert.ok(document.querySelector('.composer-reply button[aria-label="Retry reply availability"]'));
        assert.equal(JSON.parse(localStorage.getItem(draftKey)).reply.id, focusTarget.id);

        await act(async () => root.unmount());
        root = createRoot(document.getElementById('root'));
        const pendingTarget = { ...focusTarget,
          id: '00000000-0000-4000-8000-000000000865' };
        const returnedPage = { ...earlier,
          id: '00000000-0000-4000-8000-000000000866' };
        let releaseFocus = null, returnedHistory = 0;
        state = { ...state,
          threadId: '00000000-0000-4000-8000-000000000867',
          messages: [replyTarget], hiddenMessageCount: 0, hiddenMessageIds: [],
        };
        globalThis.fetch = async path => {
          if (path === '/api/apps') return Response.json([]);
          if (path === '/api/trust') return Response.json({});
          if (path === '/api/speech') return Response.json({ transcription: true });
          if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
          if (path === '/api/messages/around/' + pendingTarget.id)
            return new Promise(resolve => { releaseFocus = resolve; });
          if (String(path).startsWith('/api/messages?')) {
            returnedHistory++;
            return Response.json({ messages: [returnedPage], hasMore: false });
          }
          throw new Error('Unexpected request: ' + path);
        };
        await render();
        await act(async () => window.dispatchEvent(new CustomEvent('nod:focus-message', {
          detail: { messageId: pendingTarget.id },
        })));
        const returnButton = () => Array.from(document.querySelectorAll('.chat-jump-actions button'))
          .find(button => button.textContent.includes('Return to previous position'));
        await settle(() => releaseFocus && returnButton());
        await act(async () => returnButton().click());
        assert.equal(returnButton(), undefined);
        await act(async () => releaseFocus(Response.json([pendingTarget])));
        await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
        assert.equal(messageVisible(pendingTarget.id), false);
        await pageFromTop(() => returnedHistory >= 1 && messageVisible(returnedPage.id));
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('chat shows pending sends and active work before a model step', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'NodeFilter', 'Element', 'HTMLElement', 'HTMLInputElement',
        'HTMLButtonElement', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'DOMParser'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      HTMLElement.prototype.scrollTo = () => {};
      HTMLElement.prototype.scrollIntoView = () => {};
      let messageRequest, releaseMessage, releaseRefresh, stops = 0;
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/trust') return Response.json({});
        if (path === '/api/speech') return Response.json({ transcription: true });
        if (path === '/api/onboarding/introduction') return Response.json({ messageId: null });
        if (path === '/api/thread/stop') {
          stops++;
          return Response.json({});
        }
        assert.equal(path, '/api/messages');
        messageRequest = JSON.parse(options.body);
        return new Promise(resolve => { releaseMessage = resolve; });
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Chat } = await import('./src/web/pages/chat.tsx');
      const root = createRoot(document.getElementById('root'));
      let state = {
        threadId: 'synthetic-thread', turns: [], activity: [], tasks: [],
        verificationRequests: [], configuration: { llmReady: true },
        messages: [{ id: 'synthetic-message', role: 'assistant', text: 'Synthetic conversation',
          attachments: [], turnId: null, createdAt: '2026-10-26T12:00:00Z' }],
      };
      const render = (props = {}) => act(async () => root.render(createElement(Chat, {
        ownerId: 'synthetic-owner', state, streams: {}, refresh: async () => {}, ...props,
      })));
      const settle = async check => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(check(), 'Expected activity transition to settle');
      };
      const activity = {
        turnId: 'synthetic-turn', taskId: null, title: null, step: null, site: null,
        since: '2026-10-26T12:00:00Z',
      };
      try {
        await render({ requestedMessage: { id: 'synthetic-send', text: 'Synthetic request' },
          refresh: () => new Promise(resolve => { releaseRefresh = resolve; }) });
        await settle(() => messageRequest && document.querySelector('.message-user'));
        assert.equal(document.querySelector('.thinking .sr-only')?.textContent, 'Working…');
        await act(async () => releaseMessage(Response.json({
          messageId: messageRequest.clientMessageId, turnId: activity.turnId,
        })));
        await settle(() => releaseRefresh);
        assert.equal(document.querySelector('.thinking .sr-only')?.textContent, 'Working…');
        state = { ...state, activity: [activity] };
        await act(async () => releaseRefresh());
        await render();
        assert.equal(document.querySelector('.thinking .sr-only')?.textContent, 'Working…');
        const stop = document.querySelector('[aria-label="Stop all work"]');
        assert.ok(stop && !stop.disabled);
        await act(async () => stop.click());
        assert.equal(stops, 1);
        for (const [detail, line] of [[{ site: 'example.test', doing: 'tool' }, 'example.test'], [{ site: 'example.test', doing: 'model' }, null], [{ step: '   ' }, null], [{ doing: 'model' }, null]]) {
          state = { ...state, activity: [{ ...activity, ...detail }] };
          await render();
          if (line) assert.equal(document.querySelector('.thinking')?.textContent, line);
          else {
            assert.equal(document.querySelector('.thinking .sr-only')?.textContent, 'Working…');
            assert.ok(document.querySelector('.thinking .working-text [aria-hidden="true"]')?.textContent.trim());
          }
          assert.ok(document.querySelector('[aria-label="Stop all work"]'));
        }
        const task = { ...activity, turnId: 'synthetic-task-turn', taskId: 'synthetic-task', title: 'Synthetic task',
          step: 'Checking hotel availability' };
        state = { ...state, activity: [task] };
        await render();
        assert.equal(Boolean(document.querySelector('.thinking')), false);
        assert.ok(document.querySelector('[aria-label="Stop all work"]'));
        state = { ...state, activity: [activity, task] };
        await render();
        assert.equal(document.querySelector('.thinking .sr-only')?.textContent, 'Working…');
        assert.ok(!document.querySelector('.thinking').textContent.includes('hotel'));
        state = { ...state, activity: [{ ...activity, doing: 'tool', site: 'example.test', step: 'Comparing prices',
          quietSince: new Date(Date.now() - 150_000).toISOString(), received: true }] };
        await render();
        assert.equal(document.querySelector('.thinking .working-text')?.textContent, 'Comparing prices · example.test · 2 min');
        assert.ok(document.querySelector('.thinking .working-receipt'));
        state = { ...state, activity: [{ ...activity, background: true }] };
        await render();
        assert.equal(Boolean(document.querySelector('.thinking')), false);
        assert.equal(Boolean(document.querySelector('[aria-label="Stop all work"]')), false);
        state = { ...state, activity: [{ ...activity, step: 'Comparing **flight prices**' }, task] };
        await render();
        assert.equal(document.querySelectorAll('.thinking .working-text').length, 1);
        assert.match(document.querySelector('.thinking').textContent, /Comparing flight prices/);
        assert.ok(!document.querySelector('.thinking').textContent.includes('**'));
        assert.ok(!document.querySelector('.thinking').textContent.includes('hotel'));
        await render({ streams: { 'synthetic-stream': 'Synthetic partial result' } });
        assert.equal(Boolean(document.querySelector('.thinking')), false);
        state = { ...state, activity: [{ ...activity, step: 'Checking the return journey' }] };
        await render();
        assert.equal(document.querySelector('.thinking').textContent, 'Checking the return journey');
        state = { ...state, activity: [] };
        await render();
        assert.equal(Boolean(document.querySelector('.thinking')), false);
        assert.equal(Boolean(document.querySelector('[aria-label="Stop all work"]')), false);
        const pastedDraft = '*priority* # call';
        await act(async () => {
          const field = document.querySelector('[contenteditable]');
          field.focus();
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', {
            value: { files: [], getData: (type) => type === 'text/plain' ? pastedDraft : '' },
          });
          field.dispatchEvent(event);
        });
        assert.equal(document.querySelector('[contenteditable]').textContent, pastedDraft);
        messageRequest = undefined;
        releaseMessage = undefined;
        await render({ requestedMessage: { id: 'synthetic-failed-send', text: 'Synthetic failed request' } });
        await settle(() => messageRequest?.text === 'Synthetic failed request' && releaseMessage);
        await act(async () => releaseMessage(Response.json({ error: 'Synthetic unavailable request' }, { status: 503 })));
        await settle(() => document.querySelector('[contenteditable]').textContent.includes('Synthetic failed request'));
        assert.ok(document.querySelector('[contenteditable]').textContent.includes(pastedDraft));
        await act(async () => document.querySelector('form').dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })));
        await settle(() => messageRequest?.text.includes(pastedDraft));
        assert.equal(messageRequest.text, 'Synthetic failed request\n\n' + pastedDraft);
        await act(async () => releaseMessage(Response.json({
          messageId: messageRequest.clientMessageId, turnId: 'synthetic-restored-turn',
        })));
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('analytics follow visible Settings sections, Apps tabs and the Scheduled page', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid/settings', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
        'HTMLButtonElement', 'Event', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLElement.prototype.getClientRects = function() { return [{ top: 0, bottom: 40, left: 0, right: 640 }]; };
      window.HTMLElement.prototype.scrollTo = function() {};
      const responses = {
        '/api/preferences': { quietHoursEnabled: false, quietStart: '22:00', quietEnd: '08:00',
          locale: 'en-GB', timeZone: 'Europe/Lisbon', hourCycle: 'h23', speechReply: 'auto', speechVoice: null },
        '/api/models': { connections: [], selection: null },
        '/api/speech': { transcription: false, synthesis: false, voices: [], speechVoice: null, speechReply: 'auto' },
        '/api/memory': { saving: true, sensitive: false, notes: [], skills: [], archive: [] },
        '/api/apps': [], '/api/apps/catalog': [], '/api/schedules': [],
      };
      globalThis.fetch = async (path, options = {}) => {
        assert.equal(options.method ?? 'GET', 'GET');
        assert.ok(Object.hasOwn(responses, path), 'Unexpected fixture request: ' + path);
        return Response.json(responses[path]);
      };
      const sent = [];
      const client = {
        init(_key, options) { this.options = options; },
        capture(event, properties = {}) {
          const value = this.options.before_send({ event, properties });
          if (value) this._send_request({ url: this.options.api_host + '/e/', data: [value] });
          return value;
        },
        _send_request(request) { sent.push(...request.data); },
        set_config(options) { this.options = { ...this.options, ...options }; }, reset() {},
      };
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { AccountSettings } = await import('./src/web/components/account-settings.tsx');
      const { Apps } = await import('./src/web/pages/apps.tsx');
      const { Scheduled } = await import('./src/web/pages/tasks.tsx');
      const { pageDataCache } = await import('./src/web/lib/page-data-cache.ts');
      const { setRequestAccount } = await import('./src/web/lib/api.ts');
      const { configureAnalytics, setAnalyticsClient, capturePageview } = await import('./src/web/lib/analytics.ts');
      setRequestAccount('synthetic-owner');
      setAnalyticsClient(client);
      const consent = enabled => configureAnalytics({ enabled, distinctId: 'synthetic-installation', environment: 'development' }, 'web');
      consent(true);
      const account = { user: { id: 'synthetic-owner', email: null, name: 'PRIVATE_OWNER', avatarUrl: null },
        theme: 'system', usageData: true, saving: false, onSettings() {}, async onTheme() {},
        async onUsageData() {}, async onTraces() {} };
      const root = createRoot(document.querySelector('#root'));
      const settle = async check => {
        for (let i = 0; i < 100 && !check(); i++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 10)));
        assert.ok(check(), 'Expected page transition to settle');
      };
      const events = event => sent.filter(item => item.event === event);
      const settings = () => events('settings_viewed').map(item => item.properties.tab);
      const tabs = () => events('tab_viewed').map(item => [item.properties.page, item.properties.tab]);
      const sectionLabels = ['General', 'Notifications', 'Models', 'Voice & audio', 'Memory', 'Privacy & data'];
      try {
        await act(async () => root.render(createElement(AccountSettings, {
          account, open: true, initialTab: 'General', openRequest: 0, onOpenChange() {},
        })));
        await settle(() => document.querySelector('.memory-panel'));
        assert.deepEqual(settings(), ['general']);
        const navigation = [...document.querySelectorAll('.settings-nav-item')];
        assert.deepEqual(navigation.map(item => item.textContent), sectionLabels);
        for (const item of navigation.slice(1)) await act(async () => item.click());
        assert.deepEqual(settings(), ['general', 'notifications', 'models', 'voice', 'memory', 'privacy']);
        await act(async () => navigation.at(-1).click());
        assert.equal(settings().length, 6);
        const scroller = document.querySelector('.settings-scroll');
        Object.defineProperties(scroller, { scrollHeight: { value: 2000 }, clientHeight: { value: 400 } });
        document.querySelectorAll('.settings-category > h2').forEach((heading, index) => {
          heading.getBoundingClientRect = () => ({ top: index * 100 });
        });
        await act(async () => {
          scroller.dispatchEvent(new Event('wheel'));
          scroller.dispatchEvent(new Event('scroll'));
        });
        assert.equal(settings().at(-1), 'notifications');
        const beforeDisabled = sent.length;
        consent(false);
        await act(async () => navigation[2].click());
        assert.equal(sent.length, beforeDisabled);
        consent(true);
        await act(async () => navigation[3].click());
        assert.equal(settings().at(-1), 'voice');
        for (const path of ['/settings', '/settings/notifications', '/settings/models', '/settings/voice', '/settings/memory', '/settings/privacy']) {
          window.history.replaceState(null, '', path);
          capturePageview(path);
          assert.equal(events('$pageview').at(-1).properties.route, '/settings');
          assert.equal(events('$pageview').at(-1).properties.$current_url, 'https://app.example/settings');
        }
        window.history.replaceState(null, '', '/apps');
        await act(async () => root.render(createElement(Apps, { onAsk() {} })));
        await settle(() => document.querySelectorAll('[role="tab"]').length === 2);
        assert.deepEqual(tabs(), [['apps', 'all']]);
        const connected = [...document.querySelectorAll('[role="tab"]')].find(item => item.textContent.startsWith('Connected'));
        await act(async () => connected.click());
        await act(async () => connected.click());
        assert.deepEqual(tabs(), [['apps', 'all'], ['apps', 'connected']]);
        const connectMcp = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Connect MCP');
        await act(async () => connectMcp.click());
        assert.equal(events('app_connect_clicked').length, 1);
        assert.equal(events('app_connect_clicked')[0].properties.entry, 'apps');
        assert.equal(events('app_connection_completed').length, 0);
        window.history.replaceState(null, '', '/tasks');
        await act(async () => root.render(createElement(Scheduled, { onAsk() {} })));
        await settle(() => document.querySelector('.schedule-empty'));
        assert.equal(document.querySelector('h1').textContent.trim(), 'Scheduled');
        assert.equal(document.querySelector('[role="tab"]'), null);
        assert.deepEqual(tabs(), [['apps', 'all'], ['apps', 'connected']]);
        capturePageview('/tasks');
        assert.equal(events('$pageview').at(-1).properties.route, '/tasks');
        assert.ok(sent.every(item => item.properties.analytics_schema === 'v4'));
        assert.ok(sent.every(item => !item.event.startsWith('nod_')));
        assert.ok(!JSON.stringify(sent).includes('PRIVATE_'));
      } finally {
        consent(false);
        await act(async () => root.unmount());
        pageDataCache.clear();
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stdout + result.stderr);
});

test('Settings saves only reviewed draft revisions and retains failed edits', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid/settings', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
        'HTMLButtonElement', 'Event', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.HTMLElement.prototype.getClientRects = function() { return [{ top: 0, bottom: 40, left: 0, right: 640 }]; };
      window.HTMLElement.prototype.scrollTo = function() {};
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { AccountSettings } = await import('./src/web/components/account-settings.tsx');
      const { pageDataCache } = await import('./src/web/lib/page-data-cache.ts');
      let preferences = { quietHoursEnabled: true, quietStart: '22:00', quietEnd: '08:00',
        locale: 'en-GB', timeZone: 'Europe/Lisbon', hourCycle: 'h23', speechReply: 'auto', speechVoice: null };
      let memory = { saving: true, sensitive: false, notes: [{ path: 'preferences/synthetic-note',
        area: 'preferences', text: 'Synthetic original note', status: 'stated', updated: '2026-10-30',
        edited: null, expires: null, learnedFrom: null, sources: [] }], skills: [], archive: [] };
      const writes = [];
      let holdPreferences = false, releasePreferences, failMemory = false, failPreferences = false;
      globalThis.fetch = async (path, options = {}) => {
        const method = options.method ?? 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        if (method !== 'GET') writes.push({ path, body });
        if (path === '/api/preferences') {
          if (method === 'PATCH') {
            if (failPreferences) {
              failPreferences = false;
              return Response.json({ error: 'Synthetic preference failure' }, { status: 500 });
            }
            if (holdPreferences) {
              holdPreferences = false;
              await new Promise(resolve => { releasePreferences = resolve; });
            }
            preferences = { ...preferences, ...body };
          }
          return Response.json(preferences);
        }
        if (path === '/api/models') return Response.json({ connections: [], selection: null });
        if (path === '/api/speech') return Response.json({ transcription: false, synthesis: false,
          voices: [], speechVoice: null, speechReply: 'auto' });
        if (path === '/api/memory') return Response.json(memory);
        if (path === '/api/memory/notes/preferences/synthetic-note' && method === 'PATCH') {
          if (failMemory) {
            failMemory = false;
            return Response.json({ error: 'Synthetic note failure' }, { status: 500 });
          }
          memory = { ...memory, notes: memory.notes.map(note => ({ ...note, ...body })) };
          return Response.json(memory);
        }
        throw new Error('Unexpected request: ' + path);
      };
      const root = createRoot(document.querySelector('#root'));
      const account = { user: { id: 'synthetic-owner', email: null, name: 'Synthetic owner', avatarUrl: null },
        theme: 'system', usageData: false, saving: false, onSettings() {}, async onTheme() {},
        async onUsageData() {}, async onTraces() {} };
      const settle = () => act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); });
      const button = (text, scope = document) => [...scope.querySelectorAll('button')]
        .find(item => item.textContent.trim() === text);
      const click = async element => {
        assert.ok(element);
        await act(async () => element.click());
        await settle();
      };
      const input = async (element, value) => {
        assert.ok(element);
        await act(async () => {
          const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
          element.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await settle();
      };
      const startDrafts = async text => {
        const nextHour = preferences.quietStart.startsWith('21') ? '20' : '21';
        await input(document.querySelector('[aria-label="From hours"]'), nextHour);
        await click(document.querySelector('[aria-label="Note options"]'));
        await click(button('Edit note'));
        await input(document.querySelector('.memory-detail textarea'), text);
        return nextHour + ':00';
      };
      const save = () => click(button('Save changes', document.querySelector('.settings-save-bar')));
      const discard = () => click(button('Discard', document.querySelector('.settings-save-bar')));
      try {
        await act(async () => root.render(createElement(AccountSettings, {
          account, open: true, initialTab: 'General', openRequest: 0, onOpenChange() {},
        })));
        await settle();
        const firstQuietTime = await startDrafts('Synthetic first edit');
        failMemory = true;
        await save();
        assert.equal(preferences.quietStart, firstQuietTime);
        assert.equal(memory.notes[0].text, 'Synthetic original note');
        assert.equal(document.querySelector('.memory-detail textarea').value, 'Synthetic first edit');
        assert.ok(document.querySelector('.settings-save-bar button:not(:disabled)'));
        await discard();
        await startDrafts('Synthetic reviewed revision');
        holdPreferences = true;
        await save();
        const edited = document.querySelector('.memory-detail textarea');
        assert.equal(edited.disabled, false);
        await input(edited, 'Synthetic later revision');
        await act(async () => releasePreferences());
        await settle();
        assert.equal(memory.notes[0].text, 'Synthetic original note');
        assert.equal(edited.value, 'Synthetic later revision');
        assert.ok(document.querySelector('.settings-save-bar'));
        assert.equal(writes.filter(write => write.path.startsWith('/api/memory/notes/')).length, 1);
        await discard();
        await startDrafts('Synthetic pending revision');
        holdPreferences = true;
        await save();
        await input(document.querySelector('.memory-detail textarea'), memory.notes[0].text);
        await act(async () => releasePreferences());
        await settle();
        assert.equal(writes.filter(write => write.path.startsWith('/api/memory/notes/')).length, 1);
        assert.equal(document.querySelector('.settings-save-bar'), null);
        const source = { id: 'synthetic-source-message', text: 'Synthetic source text', at: '2026-10-30',
          channel: 'web', canOpenInCurrentChat: true };
        memory = { ...memory, notes: [...memory.notes,
          { ...memory.notes[0], path: 'preferences/first-source', status: 'observed', text: 'Source first note', sources: [source] },
          { ...memory.notes[0], path: 'preferences/second-source', status: 'observed', text: 'Source second note', sources: [source] },
        ] };
        await act(async () => pageDataCache.update('/api/memory', () => memory));
        let open = true, activeAccount = account;
        const opened = [];
        const renderSettings = () => root.render(createElement(AccountSettings, {
          account: activeAccount, open, initialTab: 'Memory', openRequest: 0, onOpenChange() {},
          onOpenSource(messageId) { opened.push(messageId); open = false; renderSettings(); },
        }));
        await act(async () => renderSettings());
        await settle();
        await click([...document.querySelectorAll('.memory-stage')].find(item => item.textContent.startsWith('Learned')));
        await input(document.querySelector('.memory-search input'), 'Source');
        await click([...document.querySelectorAll('.memory-row')].at(-1));
        await click(document.querySelector('.memory-provenance summary'));
        assert.equal(document.querySelector('.memory-provenance').open, true);
        await input(document.querySelector('[aria-label="From hours"]'), '19');
        await click(button('View message'));
        assert.deepEqual(opened, []);
        await click(button('Keep editing', document.querySelector('[role="dialog"]')));
        assert.equal(open, true);
        assert.equal(document.querySelector('.memory-search input').value, 'Source');
        await click(button('View message'));
        failPreferences = true;
        await click(button('Save and continue', document.querySelector('[role="dialog"]')));
        assert.deepEqual(opened, []);
        assert.equal(open, true);
        assert.equal(document.querySelector('[aria-label="From hours"]').value, '19');
        await click(button('Discard', document.querySelector('[role="dialog"]')));
        assert.deepEqual(opened, ['synthetic-source-message']);
        assert.equal(document.querySelector('.memory-panel'), null);
        open = true;
        await act(async () => renderSettings());
        await settle();
        assert.equal(document.querySelector('.memory-search input').value, 'Source');
        assert.ok(document.querySelector('.memory-stage[aria-pressed="true"]').textContent.startsWith('Learned'));
        assert.ok(document.querySelector('.memory-row[aria-current="true"]').textContent.includes('Source second note'));
        assert.equal(document.querySelector('.memory-provenance').open, true);
        assert.equal(document.querySelector('[aria-label="From hours"]').value, preferences.quietStart.slice(0, 2));
        await click(button('View message'));
        assert.equal(open, false);
        activeAccount = { ...account, user: { ...account.user, id: 'another-owner' } };
        await act(async () => renderSettings());
        open = true;
        await act(async () => renderSettings());
        await settle();
        assert.equal(document.querySelector('.memory-search input').value, '');
        assert.ok(document.querySelector('.memory-stage[aria-pressed="true"]').textContent.startsWith('All'));
        assert.equal(document.querySelector('.memory-provenance').open, false);
        assert.ok(!JSON.stringify(localStorage).includes('Source'));
      } finally {
        await act(async () => root.unmount());
        pageDataCache.clear();
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('SearchPicker selects empty-string options with keyboard navigation and filtering', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid/settings',
        pretendToBeVisual: true,
      });
      for (const name of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Node', 'Element', 'Event', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment']) {
        globalThis[name] = dom.window[name];
      }
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
      globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
      globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
      globalThis.IS_REACT_ACT_ENVIRONMENT = true;
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      const { createElement, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { SearchPicker } = await import('./src/web/components/search-picker.tsx');
      const selected = [];
      const root = createRoot(document.getElementById('root'));
      const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      const trigger = () => document.querySelector('button[aria-haspopup="dialog"]');
      const open = async (keyboard = false) => {
        await act(async () => {
          if (keyboard) {
            trigger().focus();
            trigger().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
          } else trigger().click();
        });
        await tick();
        const input = document.querySelector('[role="combobox"]');
        assert.equal(document.activeElement, input);
        return input;
      };
      const key = (input, value) => act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
      });
      const input = (element, value) => act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, value);
        element.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const activeOption = (input) => document.getElementById(input.getAttribute('aria-activedescendant'));
      try {
        await act(async () => root.render(createElement(SearchPicker, {
          value: 'mic-1',
          onChange: (value) => selected.push(value),
          options: [{ value: '', label: 'System default' }, { value: 'mic-1', label: 'Studio microphone' }],
          labels: { choose: 'Choose microphone', search: 'Search microphones', placeholder: 'Search', clear: 'Clear', list: 'Microphones', empty: 'No microphones' },
        })));
        let search = await open(true);
        await key(search, 'Home');
        assert.equal(activeOption(search)?.textContent, 'System default');
        await key(search, 'Enter');
        await tick();
        assert.deepEqual(selected, ['']);
        assert.equal(document.querySelector('[role="combobox"]'), null);
        assert.equal(document.activeElement, trigger());
        search = await open();
        await key(search, 'ArrowUp');
        assert.equal(activeOption(search)?.textContent, 'System default');
        await key(search, 'End');
        assert.equal(activeOption(search)?.textContent, 'Studio microphone');
        await key(search, 'Enter');
        await tick();
        assert.deepEqual(selected, ['', 'mic-1']);
        search = await open();
        await input(search, 'System');
        assert.equal(activeOption(search)?.textContent, 'System default');
        await key(search, 'Enter');
        await tick();
        assert.deepEqual(selected, ['', 'mic-1', '']);
        search = await open();
        await input(search, 'unavailable device');
        assert.equal(search.getAttribute('aria-activedescendant'), null);
        await key(search, 'ArrowDown');
        await key(search, 'Enter');
        assert.deepEqual(selected, ['', 'mic-1', '']);
        assert.equal(document.activeElement, search);
        await key(search, 'Escape');
        await tick();
        assert.equal(document.querySelector('[role="combobox"]'), null);
        assert.equal(document.activeElement, trigger());
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('shared controls retain reachable tabs, visible-label typeahead and disabled explanations', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<!doctype html><div id="root"></div>', {
        url: 'https://nod.fixture.invalid', pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window, document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true, localStorage: dom.window.localStorage,
        innerWidth: 1024, innerHeight: 768,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
      });
      for (const name of ['Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
        'Event', 'KeyboardEvent', 'CustomEvent', 'MutationObserver', 'NodeFilter', 'DocumentFragment'])
        globalThis[name] = dom.window[name];
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      const matches = window.Element.prototype.matches;
      window.Element.prototype.matches = function(selector) {
        return selector === ':focus-visible' ? this === document.activeElement : matches.call(this, selector);
      };
      let left = 100;
      window.HTMLElement.prototype.getClientRects = function() { return [this.getBoundingClientRect()]; };
      window.HTMLElement.prototype.getBoundingClientRect = function() {
        const x = this.id === 'moving-anchor' ? left : 0;
        return { x, y: 100, top: 100, bottom: 124, left: x, right: x + 80, width: 80, height: 24 };
      };
      globalThis.fetch = async path => { throw new Error('Unexpected request: ' + path); };
      const { createElement: h, act } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { Tabs } = await import('./src/web/components/tabs.tsx');
      const { ActionMenuSurface, ActionMenuItem } = await import('./src/web/components/action-menu.tsx');
      const { Tooltip } = await import('./src/web/components/tooltip.tsx');
      const { Button } = await import('./src/web/components/ui.tsx');
      const root = createRoot(document.querySelector('#root'));
      const render = content => act(async () => root.render(content));
      const key = (node, key) => act(async () => node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
      const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); });
      try {
        const values = [];
        const items = [{ value: 'a', label: 'A', disabled: true }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }];
        await render(h(Tabs, { id: 'tabs', panelId: 'panel', label: 'Controls', items, value: 'a', onValueChange: value => { values.push(value); return false; } }));
        const tabs = document.querySelectorAll('[role="tab"]');
        assert.equal(tabs[0].disabled, true);
        assert.equal(tabs[1].tabIndex, 0);
        assert.equal(tabs[2].tabIndex, -1);
        await act(async () => tabs[1].focus());
        await key(tabs[1], 'End');
        assert.deepEqual(values, ['c']);
        assert.equal(document.activeElement, tabs[1]);
        await render(h(Tabs, { id: 'tabs', panelId: 'panel', label: 'Controls', items: items.map(item => ({ ...item, disabled: true })), value: 'a', onValueChange() {} }));
        assert.equal(document.querySelector('[role="tab"][tabindex="0"]'), null);
        await render(h(ActionMenuSurface, { 'aria-label': 'Choose voice' },
          h(ActionMenuItem, { 'aria-label': 'Choose Alpha' }, 'Alpha'),
          h(ActionMenuItem, { 'aria-label': 'Choose Beta' }, 'Beta'),
          h(ActionMenuItem, { textValue: 'Zulu', 'aria-label': 'Choose Alternate' }, 'Alternate'),
          h(ActionMenuItem, { disabled: true }, 'Bravo')));
        const menu = document.querySelector('[role="menu"]');
        const choices = menu.querySelectorAll('[role="menuitem"]');
        await act(async () => choices[0].focus());
        await key(choices[0], 'b');
        assert.equal(document.activeElement, choices[1]);
        await key(choices[1], 'Home');
        assert.equal(document.activeElement, choices[0]);
        await key(choices[0], 'End');
        assert.equal(document.activeElement, choices[2]);
        await render(h(Tooltip, { content: 'Moving control', forceOpen: true }, h('button', { id: 'moving-anchor' }, 'Move')));
        const tooltip = document.querySelector('[role="tooltip"]');
        const first = Number.parseFloat(tooltip.style.left);
        left += 120;
        window.dispatchEvent(new Event('resize'));
        await tick();
        assert.equal(Number.parseFloat(tooltip.style.left), first + 120);
        let clicked = 0;
        await render(h(Button, { disabled: true, title: 'A spending limit pauses control', onClick() { clicked++; } }, 'Return to Nod'));
        const button = document.querySelector('button');
        assert.equal(button.disabled, true);
        const target = document.querySelector('[data-tooltip-trigger]');
        assert.equal(target.tabIndex, 0);
        await act(async () => target.focus());
        await tick();
        const explanation = document.querySelector('[role="tooltip"]');
        assert.ok(explanation);
        assert.equal(target.getAttribute('aria-describedby'), explanation.id);
        await act(async () => button.click());
        assert.equal(clicked, 0);
        await key(target, 'Escape');
        assert.equal(document.querySelector('[role="tooltip"]'), null);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});

test('navigation guards restore raw app history entries before leaving unsaved settings', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: String.raw`
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('', { url: 'https://nod.fixture.invalid/apps' });
      Object.assign(globalThis, { window: dom.window, PopStateEvent: dom.window.PopStateEvent });
      const { guardNavigation, navigate, subscribeNavigation } = await import('./src/web/lib/navigation.ts');
      const originalPush = window.history.pushState, originalReplace = window.history.replaceState;
      const unsubscribe = subscribeNavigation(() => {});
      let proceed;
      const until = async predicate => {
        const deadline = Date.now() + 1000;
        while (!predicate()) {
          assert.ok(Date.now() < deadline, 'History traversal did not reach the expected entry');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      let clearGuard = () => {};
      try {
        window.history.pushState(null, '', '/apps?connect=synthetic');
        window.history.replaceState({ connection: 'synthetic' }, '', '/apps');
        navigate('/settings');
        clearGuard = guardNavigation((path, continueNavigation) => {
          proceed = continueNavigation;
          return false;
        });
        window.history.back();
        await until(() => proceed && window.location.pathname === '/settings');
        assert.equal(window.history.state.nodNavigationIndex, 2);
        proceed();
        await until(() => window.location.pathname === '/apps');
        assert.equal(window.history.state.connection, 'synthetic');
        clearGuard();
        window.history.forward();
        await until(() => window.location.pathname === '/settings');
        const second = subscribeNavigation(() => {});
        unsubscribe();
        second();
        assert.equal(window.history.pushState, originalPush);
        assert.equal(window.history.replaceState, originalReplace);
      } finally {
        clearGuard();
        unsubscribe();
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr || result.stdout);
});
