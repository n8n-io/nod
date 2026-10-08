import assert from 'node:assert/strict';
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { Static } from '@sinclair/typebox';
import type { Editor } from '@tiptap/core';
import { JSDOM } from 'jsdom';
import pg from 'pg';
import { act, createElement, StrictMode, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Agent,
  AgentTool,
  AgentToolResult,
  RuntimeContext,
  RuntimeObservation,
} from '../src/ports/agent.ts';
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
import { createInspectorRedactor } from '../src/server/inspector-redaction.ts';
import type { CredentialInjection } from '../src/server/vault.ts';
import { createBrowserFixture } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';
import { BrowserHandoff } from '../src/web/components/browser-handoff.tsx';
import { browserFrames } from '../src/web/lib/browser-frames.ts';
import { SetupNotice } from '../src/web/components/setup-notice.tsx';
import { Chat } from '../src/web/pages/chat.tsx';
import { Composer } from '../src/web/components/composer.tsx';
import type { AppState, Message } from '../src/shared/contracts.ts';

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
    const db = await import('../src/server/db.ts');
    const { createApp } = await import('../src/server/app.ts');
    const { activeThread } = await import('../src/server/thread.ts');
    const { ownerId, port, configuration } = await import('../src/server/config.ts');
    const capturedAt = '2026-09-25T12:00:00.000Z';
    let currentId: string | undefined;
    let locked = false;
    let fail = false;
    let inspectorEnabled = false;
    let browserHeld = false;
    let pageShown = true;
    let onView: ((signal: AbortSignal) => AsyncGenerator<Buffer>) | undefined;
    let onCapture: (() => Promise<void>) | undefined;
    const captures: string[] = [];
    const controls: unknown[] = [];
    const app = await createApp({
      configuration: () => configuration({ inspectorEnabled }),
      runtime: {
        status: () => ({ browser: 'Ready', workspace: 'Ready' }),
        holdBrowserForUser: () => !browserHeld,
      },
      computer: {
        status: () => 'Ready',
        currentSession: () =>
          currentId ? { threadId: currentId, lastActivityAt: capturedAt } : undefined,
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
    const request = (path: string) =>
      app.inject({ url: path, headers: { host: `localhost:${port}` } });
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
      currentId = thread.id;
      const metadata = await request('/api/browser');
      assert.equal(metadata.statusCode, 200);
      assert.equal(metadata.headers['cache-control'], 'no-store');
      assert.deepEqual(metadata.json(), {
        currentBrowser: {
          threadId: thread.id,
          title: 'Synthetic browser',
          status: 'running',
          lastActivityAt: capturedAt,
        },
      });
      for (const path of ['/api/inspector', '/api/inspector/screen'])
        assert.equal((await request(path)).statusCode, 404);
      const frame = await request('/api/browser/screen');
      assert.equal(frame.statusCode, 200);
      assert.match(String(frame.headers['content-type']), /^image\/png/);
      assert.equal(frame.headers['cache-control'], 'no-store');
      assert.equal(frame.headers['referrer-policy'], 'no-referrer');
      assert.equal(frame.headers['x-screen-state'], 'live');
      assert.equal(frame.body, 'synthetic-public-browser-frame');
      assert.deepEqual(captures, [thread.id]);
      inspectorEnabled = true;
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [turnId],
      );
      for (const path of ['/api/browser/screen', '/api/inspector/screen']) {
        const pending = await request(path);
        assert.equal(pending.statusCode, 423);
        assert.equal(pending.headers['cache-control'], 'no-store');
        assert.equal(pending.body.includes('synthetic-public-browser-frame'), false);
      }
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
      assert.equal(privateFrame.headers['cache-control'], 'no-store');
      assert.equal(privateFrame.body.includes('synthetic-public-browser-frame'), false);
      locked = false;
      fail = true;
      const failed = await request('/api/browser/screen');
      assert.equal(failed.statusCode, 500);
      assert.equal(failed.body.includes('synthetic-private-provider-detail'), false);
      const nextTurnId = await insertTurn(next.id, ownerId, 'Next browser');
      currentId = undefined;
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
      assert.equal(fallback.currentBrowser.title, 'Next browser');
      assert.deepEqual(Object.keys(fallback), ['currentBrowser']);
      currentId = thread.id;
      assert.deepEqual((await request('/api/browser')).json(), { currentBrowser: null });

      fail = false;
      const click = { type: 'mouse', event: 'down', x: 0.5, y: 0.25, button: 'left' };
      const frames: Buffer[] = [];
      const post = (url: string, payload: object) =>
        app.inject({ method: 'POST', url, payload, headers: { host: `localhost:${port}` } });
      const handoff = async (input: unknown = click) => {
        const controller = new AbortController();
        const stream = await app.inject({
          url: '/api/browser-handoff/stream',
          headers: { host: `localhost:${port}` },
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
      await db.pool.query("UPDATE turns SET waiting_reason='question' WHERE id=$1", [nextTurnId]);
      assert.deepEqual(await handoff(), [200, 200, 200]);
      assert.equal(frames[0].readUInt32BE(0), Buffer.byteLength('synthetic-live-frame'));
      assert.equal(frames[0].subarray(4).toString(), 'synthetic-live-frame');
      assert.deepEqual(controls, [
        [next.id, click],
        [next.id, { action: 'back' }],
      ]);
      assert.deepEqual(await handoff({ ...click, x: 2 }), [200, 400, 200]);
      pageShown = false;
      assert.equal((await request('/api/browser-handoff/stream')).statusCode, 409);
      pageShown = true;
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background) VALUES($1,$2,$3,'event','Check','running',true)",
        [randomUUID(), ownerId, next.id],
      );
      assert.deepEqual(await handoff(), [200, 200, 200]);
      browserHeld = true;
      assert.deepEqual(await handoff(), [423, 423, 423]);
      browserHeld = false;
      assert.deepEqual(await handoff(), [200, 200, 200]);
      assert.equal(controls.length, 7);
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
          url: '/api/browser-handoff/stream',
          headers: { host: `localhost:${port}` },
          signal: controller.signal,
        });
        try {
          const viewing = await started.promise;
          if (reason === 'revoked') browserHeld = true;
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
          browserHeld = false;
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
        url: '/api/browser-handoff/stream',
        headers: { host: `localhost:${port}` },
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
        assert.equal(controls.length, 7);
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
      assert.equal(controls.length, 7);
    } finally {
      await app.close();
      await db.pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test('browser frame streaming preserves fragmented and coalesced frames and rejects incomplete or oversized streams', async () => {
  const images = [Buffer.from('synthetic-first-frame'), Buffer.from('synthetic-second-frame')];
  const encoded = Buffer.concat(
    images.flatMap((image) => {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(image.length);
      return [length, image];
    }),
  );
  for (const chunks of [
    [encoded],
    [encoded.subarray(0, 2), encoded.subarray(2, 7), encoded.subarray(7)],
    [...encoded].map((byte) => Uint8Array.of(byte)),
  ]) {
    const received: Buffer[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    await assert.rejects(
      browserFrames(body, (bytes) => {
        received.push(Buffer.from(bytes));
      }),
      /view ended/,
    );
    assert.deepEqual(received, images);
    assert.equal(body.locked, false);
  }
  for (const incomplete of [encoded.subarray(0, 2), encoded.subarray(0, 8)]) {
    const received: Uint8Array[] = [];
    await assert.rejects(
      browserFrames(
        new ReadableStream({
          start(controller) {
            controller.enqueue(incomplete);
            controller.close();
          },
        }),
        (bytes) => {
          received.push(bytes);
        },
      ),
      /view ended/,
    );
    assert.deepEqual(received, []);
  }
  for (const size of [0, 4 * 1024 * 1024 + 1]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(size);
        controller.enqueue(length);
      },
      cancel() {
        cancelled = true;
      },
    });
    await assert.rejects(
      browserFrames(body, () => assert.fail()),
      /Invalid browser frame/,
    );
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

// Checkpoint quiescence

function syntheticComputer(): Computer & { canCheckpoint?: () => boolean } {
  return {
    act: async () => ({ text: 'Synthetic page', url: 'https://example.test/' }),
    screenshot: async () => null,
    injectCredentials: async () => ({ status: 'submitted' }),
    currentPage: async () => ({ origin: 'https://example.test', url: 'https://example.test/' }),
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'Synthetic browser',
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
      if (command[0] === 'fill') {
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

type BrowserTab = { tabId: string; active: boolean; url: string };

async function transportFixture(respectTimeouts = false) {
  const directory = await mkdtemp('/tmp/sk-transport-');
  const pages = stagedLoginBrowser();
  const actions: string[] = [];
  const launches: string[] = [];
  const diagnostics: BrowserDiagnostic[] = [];
  const sockets = new Set<Socket>();
  let before = async (_action: string, _command: Record<string, unknown>) => {};
  let after = async (_action: string, _command: Record<string, unknown>, _socket: Socket) => {};
  let failedAction: string | undefined;
  let failedMessage = 'Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE PRIVATE-UPSTREAM';
  const switches: string[] = [];
  const timeouts: { action: unknown; timeoutMs: number | undefined }[] = [];
  let tabs = (url: string): BrowserTab[] => [{ tabId: 't1', active: true, url }];
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
      if (command.action === 'tab_list') data = { tabs: tabs(page.location.href) };
      if (command.action === 'tab_switch') switches.push(command.tabId);
      if (command.action === 'evaluate') data = { result: await page.evaluate(command.script) };
      if (command.action === 'snapshot') data = { snapshot: page.text() };
      if (command.action === 'navigate') page.location.href = command.url;
      if (command.action === 'screenshot') await writeFile(command.path, page.screen());
      await after(command.action, command, socket);
      if (!socket.destroyed) socket.end(JSON.stringify({ success: true, data }) + '\n');
    });
  });
  const startDaemon = () =>
    new Promise<void>((resolve) =>
      server.listen(join(directory, `${browserSessionId('fixture')}.sock`), resolve),
    );
  await startDaemon();
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
    onDiagnostic: (event) => diagnostics.push(event),
    daemonCommand: (path, command, signal, timeoutMs) => {
      timeouts.push({ action: command.action, timeoutMs });
      return existingDaemonCommand(path, command, signal, respectTimeouts ? timeoutMs : 250);
    },
    run: async (executable, args, options) => {
      if (args.includes('info')) {
        launches.push('info');
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
      }
      const action = args[args.indexOf('--idle-timeout') + 2];
      launches.push(action);
      assert.equal(action, 'open', 'Warm actions must not invoke the retrying CLI');
      return pages.run(executable, args, options);
    },
  });
  return {
    computer,
    actions,
    launches,
    diagnostics,
    page: () => pages.pages.get('fixture')!,
    switches,
    timeouts,
    tabs(value: typeof tabs) {
      tabs = value;
    },
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
    startDaemon,
    async stopDaemon() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    assert.equal(f.actions.slice(before).filter((action) => action === 'close').length, 1);
    assert.deepEqual(f.launches, ['open', 'info']);
    assert.deepEqual(
      f.diagnostics.map(({ phase, outcome }) => ({ phase, outcome })),
      [
        { phase: 'snapshot', outcome: 'timeout' },
        { phase: 'cleanup', outcome: 'completed' },
      ],
    );
  } finally {
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await f.cleanup();
  }
});

for (const [method, phase] of [
  ['screenshot', 'screenshot'],
  ['screenshot', 'url'],
  ['currentPage', 'url'],
  ['snapshot', 'url'],
] as const)
  test(`an acknowledged ${phase} failure during ${method} preserves the page and emits private-safe diagnostics`, async () => {
    const browser = await transportFixture();
    const bridge = await harness({ computer: browser.computer });
    const computer = bridge.client('/synthetic/capture-failure');
    const upstreamError = 'Synthetic private upstream detail https://example.test/?token=private';
    const identifier = 'synthetic-private@example.test';
    try {
      await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const page = browser.page();
      page.input.value = identifier;
      page.next.disabled = false;
      browser.fail(phase, upstreamError);
      const before = browser.actions.length;
      await assert.rejects(
        method === 'snapshot'
          ? computer.act('fixture', { action: 'snapshot' })
          : computer[method]('fixture'),
        (error: unknown) => {
          assert.ok(error instanceof BrowserActionError);
          assert.equal(error.code, 'browser_observation_failed');
          assert.equal(error.message.includes(upstreamError), false);
          return true;
        },
      );
      assert.equal(page.stage, 'identifier');
      assert.equal(page.input.value, identifier);
      assert.deepEqual(page.entered, []);
      assert.deepEqual(
        browser.actions.slice(before),
        phase === 'screenshot' ? ['dialog', 'url', phase] : ['dialog', phase],
      );
      assert.equal(browser.diagnostics.length, 1);
      const diagnostic = browser.diagnostics[0];
      assert.deepEqual(Object.keys(diagnostic).sort(), ['at', 'elapsedMs', 'outcome', 'phase']);
      assert.equal(diagnostic.phase, phase);
      assert.equal(diagnostic.outcome, 'daemon_rejected');
      assert.ok(Number.isFinite(Date.parse(diagnostic.at)));
      assert.ok(Number.isFinite(diagnostic.elapsedMs) && diagnostic.elapsedMs >= 0);
      const recorded = JSON.stringify(browser.diagnostics);
      for (const secret of [upstreamError, identifier, 'https://', 'private'])
        assert.equal(recorded.includes(secret), false);
      browser.fail();
      const screen = await computer.screenshot('fixture');
      assert.equal(screen?.toString(), page.screen());
      assert.equal(computer.screenStatus!('fixture').state, 'live');
      assert.equal(browser.actions.includes('close'), false);
      assert.deepEqual(browser.launches, ['open', 'info']);
    } finally {
      browser.fail();
      await bridge.close();
      await browser.cleanup();
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
      assert.deepEqual(browser.launches, ['open', 'info']);
    } finally {
      browser.fail();
      await bridge.close();
      await browser.cleanup();
    }
  });

test('discarding a thread closes its browser and deletes only its throwaway data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-discard-'));
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
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

async function wedgedBrowser(options: { idleTimeoutMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-drain-failure-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  let failClose = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    ...options,
    run: async (executable, args, input) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failClose)
        throw new Error('Runtime command exceeded its time limit.');
      if (action === 'close' && failClose) throw new Error('Synthetic close unavailable.');
      return fixture.run(executable, args, input);
    },
  });
  await assert.rejects(
    computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
    /could not stop safely/,
  );
  return {
    computer,
    commands,
    repair: () => {
      failClose = false;
    },
    async cleanup() {
      failClose = false;
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('failed interruption cleanup blocks actions until the next open retries the close', async () => {
  const wedged = await wedgedBrowser();
  const { computer, commands } = wedged;
  try {
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    const count = commands.length;
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /Synthetic close unavailable/,
    );
    assert.equal(commands.slice(count).at(-1), 'close');
    wedged.repair();
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    await wedged.cleanup();
  }
});

test('calls rejected by a wedged browser do not keep it from idling out', async () => {
  const wedged = await wedgedBrowser({ idleTimeoutMs: 40 });
  const { computer, commands } = wedged;
  try {
    wedged.repair();
    const count = commands.length;
    for (const deadline = Date.now() + 3000; !commands.slice(count).includes('close');) {
      assert.ok(Date.now() < deadline, 'the idle sweep never closed the wedged browser');
      await assert.rejects(computer.act('fixture', { action: 'snapshot' }));
      await delay(5);
    }
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    await wedged.cleanup();
  }
});

test('a browser whose daemon is gone closes without a daemon and can be reopened', async () => {
  const f = await transportFixture();
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    await f.stopDaemon();
    await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /unavailable/);
    await f.startDaemon();
    const reopened = await f.computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
    assert.equal(f.actions.includes('close'), false);
  } finally {
    await f.cleanup();
  }
});

type Execute = (
  id: string,
  input: Static<typeof toolDefinitions.browser.parameters>,
) => Promise<AgentToolResult>;

async function runtimeFixture(
  computer: Computer,
  run: (execute: Execute) => Promise<void>,
  options: {
    controller?: AbortController;
    observe?: (event: RuntimeObservation) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-click-recovery-'));
  const threadId = randomUUID();
  const observations: RuntimeObservation[] = [];
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
    turnId: randomUUID(),
    prompt: 'Open the synthetic destination after dismissing its covering dialog.',
    history: [],
    attachments: [],
    workspacePath: directory,
    signal: (options.controller ?? new AbortController()).signal,
    emit: async () => {},
    observe: async (event) => {
      observations.push(event);
      await options.observe?.(event);
    },
    reply: async () => {},
    delta() {},
    publish: async () => {
      throw new Error('unused');
    },
    requestCredential: async () => ({}),
    integration: async () => ({}),
    manage: async () => ({}),
  };
  return {
    observations,
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

test('the browser has one holder, and the conversation keeps it for the user until it is done', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-claim-'));
  const threadId = randomUUID();
  const opened: string[] = [];
  const replies: string[] = [];
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
      act: async (_id, action) => {
        if (action.action === 'open' && action.url) opened.push(action.url);
        return { text: 'Fixture page', url: 'https://example.com' };
      },
    }),
    workspace: fakeWorkspace(),
  });
  const turn = (
    background: boolean,
    script: (tools: Map<string, AgentTool>) => Promise<unknown>,
  ) => {
    const turnId = randomUUID();
    scripts.set(turnId, script);
    return runtime.runTurn({
      threadId,
      turnId,
      background,
      prompt: 'Use the browser.',
      history: [],
      attachments: [],
      workspacePath: directory,
      signal: new AbortController().signal,
      emit: async () => {},
      reply: async (text) => {
        replies.push(text);
      },
      delta() {},
      publish: async () => {
        throw new Error('unused');
      },
      requestCredential: async () => ({}),
      integration: async () => ({}),
      manage: async () => ({}),
    });
  };
  const open = (tools: Map<string, AgentTool>, url: string) =>
    tools.get('browser')!.execute({ action: 'open', url });
  const handoff = deferred();
  const backgroundDone = deferred();
  try {
    const asking = turn(false, async (tools) => {
      await open(tools, 'https://example.com/conversation');
      await handoff.promise;
      await tools.get('ask_user')!.execute({ question: 'Sign in in [Open browser](/browser).' });
    });
    await delay(10);
    const background = turn(true, async (tools) => {
      await open(tools, 'https://example.com/background');
      await backgroundDone.promise;
    });
    handoff.resolve();
    assert.equal((await asking).status, 'waiting_user');
    await delay(10);
    assert.deepEqual(opened, ['https://example.com/conversation']);
    assert.equal(runtime.holdBrowserForUser(threadId), true);
    await turn(false, (tools) => open(tools, 'https://example.com/after-done'));
    await delay(10);
    assert.deepEqual(opened, [
      'https://example.com/conversation',
      'https://example.com/after-done',
      'https://example.com/background',
    ]);
    assert.equal(runtime.holdBrowserForUser(threadId), false);
    const nextHandoff = turn(false, (tools) =>
      tools.get('ask_user')!.execute({ question: 'Continue in [Open browser](/browser).' }),
    );
    await delay(10);
    assert.deepEqual(replies, ['Sign in in [Open browser](/browser).']);
    backgroundDone.resolve();
    await background;
    assert.equal((await nextHandoff).status, 'waiting_user');
    assert.equal(replies.at(-1), 'Continue in [Open browser](/browser).');
    assert.equal(runtime.holdBrowserForUser(threadId), true);
  } finally {
    handoff.resolve();
    backgroundDone.resolve();
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a browser handoff needs an open page, so Pi reopens it instead of handing over nothing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-handoff-page-'));
  const replies: string[] = [];
  let failure = '';
  const runtime = createAgentRuntime({
    agent: {
      open: async ({ tools }) => ({
        resumed: false,
        prompt: async () => {
          const ask = tools.find((tool) => tool.name === 'ask_user')!;
          await ask.execute({ question: 'Sign in in [Open browser](/browser).' }).catch((error) => {
            failure = String(error);
          });
        },
        abort() {},
        dispose() {},
      }),
      dispose() {},
    },
    computer: fakeComputer({
      currentPage: async () => {
        throw new Error('Open the login page in this task browser first.');
      },
    }),
    workspace: fakeWorkspace(),
  });
  try {
    const result = await runtime.runTurn({
      threadId: randomUUID(),
      turnId: randomUUID(),
      prompt: 'Hand me the browser.',
      history: [],
      attachments: [],
      workspacePath: directory,
      signal: new AbortController().signal,
      emit: async () => {},
      reply: async (text) => {
        replies.push(text);
      },
      delta() {},
      publish: async () => {
        throw new Error('unused');
      },
      requestCredential: async () => ({}),
      integration: async () => ({}),
      manage: async () => ({}),
    });
    assert.equal(result.status, 'succeeded');
    assert.match(failure, /Open the page in your browser before handing it to the user/);
    assert.deepEqual(replies, []);
  } finally {
    await runtime.dispose();
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

for (const failure of ['unknown', 'forged', 'navigation', 'wrong_action', 'cancelled_observation'])
  test(`${failure} browser failure stops the turn without a blocked result`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const f = await runtimeFixture(
      fakeComputer({
        act: async () => {
          calls++;
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
      {
        controller,
        observe: async (event) => {
          if (failure === 'cancelled_observation' && event.type === 'tool_end') controller.abort();
        },
      },
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
  let session: ReturnType<NonNullable<Computer['currentSession']>>;
  let act: Computer['act'] = async (id, input) => {
    session = { threadId: id, lastActivityAt: new Date().toISOString() };
    return {
      text: input.text ?? 'Synthetic page',
      url: input.url ?? 'https://example.com/',
    };
  };
  const computer: Computer = {
    currentSession: () => session,
    status: () => 'Synthetic workspace browser',
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
    return process as unknown as ChildProcessWithoutNullStreams;
  };
  const clients: Computer[] = [];
  function client(
    dataRoot: string,
    options: { timeoutMs?: number; openTimeoutMs?: number; drainTimeoutMs?: number } = {},
  ) {
    const value = createContainerBrowserComputer({ dataRoot, spawn: launch, ...options });
    clients.push(value);
    return value;
  }
  return {
    root,
    socketPath,
    worker,
    launches,
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

test('a live view streams frames and carries input over one bridge call, and closing it keeps the browser', async () => {
  const inputs: unknown[] = [];
  let disposals = 0;
  const computer: Computer = {
    ...syntheticComputer(),
    dispose: async () => {
      disposals++;
    },
    control: async (_id, input) => {
      inputs.push(input);
    },
    view: async function* (_id, signal) {
      yield Buffer.from('first frame');
      while (inputs.length < 2 && !signal.aborted) await delay(5);
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
        await client.control!('task', { type: 'mouse', event: 'move', x: 0.5, y: 0.5 });
        await client.control!('task', { type: 'text', text: 'hi' });
      } else break;
    }
    assert.deepEqual(frames, ['first frame', 'second frame']);
    assert.deepEqual(inputs, [
      { type: 'mouse', event: 'move', x: 0.5, y: 0.5 },
      { type: 'text', text: 'hi' },
    ]);
    assert.equal(fixture.launches.length, 1);
    await assert.rejects(client.control!('task', { type: 'text', text: 'late' }), /not open/);
    assert.match((await client.act('task', { action: 'snapshot' })).text, /Synthetic page/);
    assert.equal(disposals, 0);
  } finally {
    await fixture.close();
  }
});

test('Vault broker metadata stays local while identifier, password and OTP inputs reach the browser', async () => {
  const fixture = await harness();
  const dataRoot = '/synthetic/vault-broker';
  const inputs: CredentialInjection[] = [
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'identifier',
      username: 'synthetic@example.test',
      usernameSelector: '#username',
    },
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic saved account',
      kind: 'password',
      username: 'synthetic@example.test',
      password: 'Synthetic-only-value',
      usernameSelector: '#username',
      passwordSelector: '#password',
    },
    {
      threadId: 'task',
      origin: 'https://example.com',
      label: 'Synthetic verification step',
      kind: 'otp',
      code: '123456',
      passwordSelector: '#code',
    },
  ];
  try {
    const computer = fixture.client(dataRoot);
    assert.deepEqual(await computer.currentPage('task'), {
      origin: 'https://example.com',
      url: 'https://example.com/login',
    });
    assert.deepEqual(
      fixture.instance(dataRoot).calls.filter((call) => call.method === 'currentPage'),
      [{ method: 'currentPage' }],
    );
    for (const input of inputs)
      assert.deepEqual(await computer.injectCredentials(input), { status: 'submitted' });
    const calls = fixture
      .instance(dataRoot)
      .calls.filter((call) => call.method === 'injectCredentials');
    assert.equal(calls.length, inputs.length);
    for (const [index, input] of inputs.entries()) {
      const { label: _label, ...expected } = input;
      assert.deepEqual(calls[index].input, expected);
    }
    assert.doesNotMatch(
      JSON.stringify(fixture.launches),
      /Synthetic saved account|Synthetic-only-value|123456/,
    );
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
      { id: randomUUID(), namespace: '../../private', method: 'status' },
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
    assert.throws(
      () => createContainerBrowserComputer({ dataRoot: '/synthetic', container: 'otto-workspace' }),
      /BROWSER_CONTAINER/,
    );
  } finally {
    await fixture.close();
  }
});

test('discard reaches the namespace computer of the same thread only', async () => {
  const fixture = await harness();
  try {
    const computer = fixture.client('/synthetic/discard');
    await computer.act('task', { action: 'snapshot' });
    await computer.discard!('task');
    assert.deepEqual(fixture.instance('/synthetic/discard').calls, [
      { method: 'act', input: { action: 'snapshot' } },
      { method: 'discard', input: 'task' },
    ]);
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
      assert.equal(restored.calls.length, 1);
      if (method === 'open')
        assert.deepEqual(restored.calls[0], {
          method: 'act',
          input: { action: 'open', url: 'https://example.com/reopened' },
        });
      else assert.equal(restored.calls[0].method, 'bindProfile');
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

for (const failure of ['failed', 'unacknowledged'] as const)
  test(`a ${failure} namespace cleanup leaves explicit browser recovery fenced`, async () => {
    const fixture = await harness();
    const dataRoot = `/synthetic/recover-${failure}`;
    const interrupted = await interruptedBrowser(fixture, dataRoot);
    const finishClose = deferred();
    let blocked = true;
    try {
      const { computer, instance, release } = interrupted;
      const close = instance.computer.dispose;
      const closeStarted = deferred();
      instance.computer.dispose = async () => {
        if (blocked) {
          closeStarted.resolve();
          if (failure === 'failed') throw new Error('Synthetic cleanup failed');
          await finishClose.promise;
        }
        await close();
      };
      const failed = assert.rejects(
        computer.act('task', { action: 'open', url: 'https://example.com/reopened' }),
      );
      release.resolve();
      await closeStarted.promise;
      await failed;
      assert.equal(fixture.instance(dataRoot), instance);
      const calls = fixture.launches.length;
      await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
      await assert.rejects(
        computer.act('task', { action: 'click', selector: '#submit' }),
        /unavailable/,
      );
      assert.equal(fixture.launches.length, calls);
      assert.equal(instance.calls.filter(({ method }) => method === 'act').length, 2);
      blocked = false;
      finishClose.resolve();
      await computer.act('task', { action: 'open', url: 'https://example.com/reopened' });
      assert.notEqual(fixture.instance(dataRoot), instance);
      assert.equal(fixture.instance(dataRoot).calls.length, 1);
    } finally {
      blocked = false;
      finishClose.resolve();
      interrupted.release.resolve();
      await fixture.close();
    }
  });

test('disposal during explicit browser recovery cannot revive the client', async () => {
  const fixture = await harness();
  const dataRoot = '/synthetic/recovery-disposal';
  const { computer, instance, release } = await interruptedBrowser(fixture, dataRoot);
  try {
    const recovery = assert.rejects(
      computer.act('task', { action: 'open', url: 'https://example.com/reopened' }),
      /unavailable/,
    );
    const disposal = computer.dispose();
    release.resolve();
    await Promise.all([recovery, disposal]);
    await assert.rejects(
      computer.act('task', { action: 'open', url: 'https://example.com/reopened' }),
      /unavailable/,
    );
    assert.equal(fixture.instance(dataRoot), instance);
    assert.deepEqual(
      instance.calls.map(({ method }) => method),
      ['act', 'act', 'dispose'],
    );
  } finally {
    release.resolve();
    await fixture.close();
  }
});

// Login inspection and observation redaction

test('browser observations redact OAuth callback values, API credentials and signed URL query values', () => {
  const url = redactBrowserUrl(
    'https://example.com/callback?code=private-code&email=private-email&state=private-state&view=account#access_token=private-token',
    [],
  );
  for (const value of ['private-code', 'private-email', 'private-state', 'private-token'])
    assert.equal(url.includes(value), false);
  assert.equal(new URL(url).searchParams.get('view'), 'account');
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
});

test('browser observations redact manually typed secrets in encoded paths and unknown query fields', () => {
  const secret = 'fixture secret/with+symbols';
  const variants = [
    encodeURIComponent(secret),
    encodeURI(secret),
    new URLSearchParams({ value: secret }).toString().slice(6),
  ];
  for (const value of variants) {
    assert.equal(redactBrowserText(value, [secret]), '[redacted]');
    assert.equal(
      redactBrowserText(
        value.replace(/%[0-9A-F]{2}/g, (code) => code.toLowerCase()),
        [secret],
      ),
      '[redacted]',
    );
    assert.equal(
      redactBrowserUrl(`https://example.com/${value}?other=${value}`, [secret]).includes(value),
      false,
    );
  }
  assert.doesNotThrow(() => redactBrowserText('fixture', ['\ud800']));
});

test('Pi can submit each staged sign-in step without exposing entered values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-staged-login-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const origin = 'https://1.1.1.1';
    for (const action of ['fill', 'type'] as const)
      await assert.rejects(
        computer.act('login', { action, selector: '#account', text: 'not-through-chat' }),
        /secure credential/,
      );
    const identifier = computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'identifier',
      username: 'synthetic-account@example.test',
      usernameSelector: '#account',
    });
    await assert.rejects(computer.screenshot('login'), /paused/);
    await identifier;
    await computer.act('login', { action: 'click', selector: 'button' });
    await computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'password',
      password: 'synthetic-password',
      passwordSelector: '#account',
    });
    await computer.act('login', { action: 'click', selector: 'button' });
    const challenge = fixture.pages.get('login')?.input;
    assert.ok(challenge);
    assert.equal(fixture.pages.get('login')?.stage, 'otp');
    await computer.injectCredentials({
      threadId: 'login',
      origin,
      kind: 'otp',
      code: '739204',
      passwordSelector: '#account',
    });
    assert.deepEqual(fixture.pages.get('login')?.entered, [
      'synthetic-account@example.test',
      'synthetic-password',
    ]);
    await computer.act('login', { action: 'click', selector: 'button' });
    assert.equal(fixture.pages.get('login')?.stage, 'complete');
    assert.equal(fixture.pages.get('login')?.entered.at(-1), '739204');
    const observation = await computer.act('login', { action: 'snapshot' });
    for (const secret of ['synthetic-account@example.test', 'synthetic-password', '739204'])
      assert.equal(JSON.stringify(observation).includes(secret), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a sign-in approval can be observed after a wait, and Stop cancels the wait', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-approval-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const page = fixture.pages.get('login')!;
    page.dom.window.document.querySelector('h1')!.textContent = 'Approve sign-in on your device';
    const pending = await computer.act('login', { action: 'snapshot' });
    assert.match(pending.text, /Approve sign-in on your device/);
    const approved = computer.act('login', { action: 'snapshot', waitMs: 100 });
    await delay(25);
    page.stage = 'complete';
    page.render();
    assert.match((await approved).text, /Sign in complete/);
    assert.deepEqual(page.entered, []);

    const controller = new AbortController();
    const cancelled = assert.rejects(
      computer.act('login', { action: 'snapshot', waitMs: 15000 }, controller.signal),
      { name: 'AbortError' },
    );
    await delay(25);
    controller.abort();
    await cancelled;
    assert.match((await computer.act('login', { action: 'snapshot' })).text, /Sign in complete/);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the user can point, click, type and scroll in the handed-off browser at page coordinates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-handoff-'));
  const fixture = stagedLoginBrowser();
  const commands: Record<string, unknown>[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => commands.push(command),
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    commands.length = 0;
    await computer.control!('fixture', { type: 'mouse', event: 'move', x: 0.25, y: 0.5 });
    await computer.control!('fixture', { type: 'mouse', event: 'down', x: 0.5, y: 0.25 });
    await computer.control!('fixture', { type: 'mouse', event: 'up', x: 0.5, y: 0.25 });
    await computer.control!('fixture', { type: 'text', text: 'ab' });
    await computer.control!('fixture', { type: 'key', key: 'Control+a' });
    await computer.control!('fixture', { type: 'wheel', deltaX: 0, deltaY: 300 });
    assert.equal(
      commands.filter(
        (command) =>
          command.action === 'evaluate' && command.script === '[innerWidth, innerHeight]',
      ).length,
      1,
    );
    assert.deepEqual(
      commands
        .filter((command) => !['url', 'evaluate'].includes(String(command.action)))
        .map(({ id: _id, plugins: _plugins, ...command }) => command),
      [
        { action: 'mousemove', x: 256, y: 384 },
        { action: 'mousemove', x: 512, y: 192 },
        { action: 'mousedown', button: 'left' },
        { action: 'mousemove', x: 512, y: 192 },
        { action: 'mouseup', button: 'left' },
        { action: 'keyboard', subaction: 'type', text: 'ab' },
        { action: 'press', key: 'Control+a' },
        { action: 'wheel', deltaX: 0, deltaY: 300 },
      ],
    );
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('visual browser actions use screenshot coordinates and reject invalid gestures before input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-visual-'));
  const fixture = stagedLoginBrowser();
  const commands: Record<string, unknown>[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => commands.push(command),
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    commands.length = 0;
    await computer.act('fixture', { action: 'click', x: 0.5, y: 0.25 });
    assert.deepEqual(
      commands.filter((command) => String(command.action).startsWith('mouse')),
      [
        { action: 'mousemove', x: 512, y: 192 },
        { action: 'mousedown', button: 'left' },
        { action: 'mouseup', button: 'left' },
      ],
    );
    for (const input of [
      { action: 'click', x: -0.1, y: 0.5 },
      { action: 'click', x: 0.5, y: 1.1 },
      { action: 'click', x: 0.5 },
      { action: 'click', x: Number.NaN, y: 0.5 },
      { action: 'click', x: 0.5, y: 0.5, durationMs: 15_001 },
      { action: 'click', selector: '#account', x: 0.5, y: 0.5 },
      { action: 'drag', points: [{ x: 0.5, y: 0.5 }] },
      {
        action: 'drag',
        points: [
          { x: 0.2, y: 0.5 },
          { x: 1.1, y: 0.5 },
        ],
      },
      { action: 'drag', points: Array.from({ length: 101 }, () => ({ x: 0.5, y: 0.5 })) },
    ]) {
      commands.length = 0;
      await assert.rejects(computer.act('fixture', input as BrowserAction));
      assert.equal(
        commands.some((command) => String(command.action).startsWith('mouse')),
        false,
      );
    }
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const failure of ['cancelled hold', 'cancelled drag', 'failed drag'])
  test(`visual browser actions release the pointer after a ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-visual-stop-'));
    const fixture = stagedLoginBrowser();
    const controller = new AbortController();
    const pressed = deferred();
    const commands: string[] = [];
    const computer = createBrowserFixture({
      dataRoot: directory,
      run: fixture.run,
      onDaemonCommand: (command) => {
        const action = String(command.action);
        commands.push(action);
        if (action === 'mousedown') pressed.resolve();
        if (failure === 'failed drag' && action === 'mousemove' && commands.includes('mousedown'))
          throw new DaemonCommandError();
      },
    });
    try {
      await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const input: BrowserAction =
        failure === 'cancelled hold'
          ? { action: 'click', x: 0.5, y: 0.25, durationMs: 1000 }
          : {
              action: 'drag',
              points: [
                { x: 0.2, y: 0.5 },
                { x: 0.8, y: 0.5 },
              ],
              durationMs: 1000,
            };
      const pending = computer.act('fixture', input, controller.signal);
      await Promise.race([
        pressed.promise,
        pending.then(() => assert.fail('The pointer action did not hold the mouse button.')),
      ]);
      if (failure.startsWith('cancelled')) controller.abort(new Error('Synthetic stop.'));
      await assert.rejects(pending);
      assert.equal(commands.filter((action) => action === 'mousedown').length, 1);
      assert.equal(commands.filter((action) => action === 'mouseup').length, 1);
    } finally {
      await computer.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });

test('visual browser actions fence the session when releasing the pointer fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-visual-release-'));
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
    skip: process.env.OTTO_TEST_NATIVE_DOWNLOAD !== 'true' || process.platform !== 'linux',
    timeout: 30_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-stderr-native-'));
    const server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end(
        '<button style="width:100vw;height:100vh" onclick="this.textContent=\'Accepted\'">Continue</button>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const computer = createAgentBrowserComputer(containerBrowserOptions(directory));
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
          "navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32) } }).then(() => 'resolved', (error) => error.name)",
      });
      assert.match(passkey.text, /NotAllowedError/);
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
  'native visual browser actions solve a canvas interaction inside nested cross-origin frames',
  { skip: process.env.OTTO_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-visual-native-'));
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
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
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
  const directory = await mkdtemp(join(tmpdir(), 'otto-handoff-secret-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-origin-'));
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
    };
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await assert.rejects(computer.injectCredentials(input), /not on the website for this login/);
    assert.equal(exposed, 0);
    assert.equal(page.input.value, '');
    page.location = { origin: 'https://1.1.1.1', href: 'https://1.1.1.1/login' };
    await computer.injectCredentials(input);
    assert.equal(page.input.value, secret);
    page.render();
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await computer.act('fixture', { action: 'snapshot' });
    assert.equal(exposed, 0);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('secure entry types a code into the referenced field and keeps it out of observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-code-'));
  const fixture = stagedLoginBrowser();
  const commands: Record<string, unknown>[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => {
      if (['fill', 'press'].includes(String(command.action))) commands.push(command);
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const page = fixture.pages.get('fixture')!;
    const ref = [...page.refs].find(([, node]) => node === page.input)![0];
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      kind: 'otp',
      code: '483729',
      passwordSelector: ref,
    });
    assert.equal(page.input.value, '483729');
    assert.deepEqual(commands, [
      { action: 'fill', selector: ref, value: '' },
      ...[...'483729'].map((key) => ({ action: 'press', key })),
    ]);
    const observation = await computer.act('fixture', { action: 'snapshot' });
    assert.equal(JSON.stringify(observation).includes('483729'), false);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native secure entry completes single and split OTP controls without maxlength hints',
  { skip: process.env.OTTO_TEST_NATIVE_DOWNLOAD !== 'true', timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-code-native-'));
    const code = '072846';
    const server = createHttpServer((request, response) => {
      const split = request.url === '/split';
      response.setHeader('content-type', 'text/html');
      response.end(`<form>
        ${Array.from({ length: split ? code.length : 1 }, (_, index) => `<input autocomplete="one-time-code" inputmode="numeric" aria-label="Code ${index + 1}">`).join('')}
        <button type="submit" disabled>Verify</button><output></output>
        </form><script>
        const fields = [...document.querySelectorAll('input')];
        const button = document.querySelector('button');
        for (const [index, field] of fields.entries()) field.addEventListener('input', event => {
          if (!event.isTrusted) return;
          if (fields.length > 1 && field.value) {
            field.value = field.value.slice(-1);
            fields[index + 1]?.focus();
          }
          button.disabled = fields.map(field => field.value).join('') !== ${JSON.stringify(code)};
        });
        document.querySelector('form').onsubmit = event => {
          event.preventDefault();
          if (!button.disabled) document.querySelector('output').textContent = 'Verified';
        };
        </script>`);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
    });
    const worker = await workerFixture(() => computer, 30_000);
    const act = async (input: BrowserAction) =>
      result(await worker.request({ method: 'act', threadId: 'fixture', input })) as {
        text: string;
      };
    try {
      for (const path of ['/single', '/split']) {
        await act({ action: 'open', url: origin + path });
        const shape = await act({
          action: 'evaluate',
          script:
            '[...document.querySelectorAll(\'input[autocomplete="one-time-code"]\')].map(field => field.maxLength)',
        });
        assert.deepEqual(
          JSON.parse(shape.text.slice(shape.text.indexOf('\n') + 1)),
          Array(path === '/split' ? 6 : 1).fill(-1),
        );
        const injected = result(
          await worker.request({
            method: 'injectCredentials',
            input: {
              threadId: 'fixture',
              origin,
              kind: 'otp',
              code,
              passwordSelector: 'input[autocomplete="one-time-code"]',
            },
          }),
        );
        assert.deepEqual(injected, { status: 'submitted' });
        await act({ action: 'click', selector: 'button' });
        const accepted = await act({
          action: 'evaluate',
          script: "document.querySelector('output').textContent === 'Verified'",
        });
        assert.equal(JSON.parse(accepted.text.slice(accepted.text.indexOf('\n') + 1)), true);
        assert.equal((await act({ action: 'snapshot' })).text.includes(code), false);
      }
    } finally {
      await worker.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('closing and reopening a browser fills only the new page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-reopen-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const first = fixture.pages.get('fixture')!;
    await computer.close('fixture');
    assert.equal(first.closed, true);
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const next = fixture.pages.get('fixture')!;
    assert.equal(next === first, false);
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: 'https://1.1.1.1',
      kind: 'identifier',
      username: 'synthetic-reopened-account',
      usernameSelector: '#account',
    });
    assert.equal(next.input.value, 'synthetic-reopened-account');
    assert.equal(first.input.value, '');
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the owner time zone and region reach a new browser launch without injecting browser flags', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-locale-'));
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
  const original = createBrowserFixture({ dataRoot: directory, run: fixture.run });
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
    assert.equal(masked?.includes(Buffer.from('synthetic-secret@example.test')), false);
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

test('inspector masks nested credentials, headers and encoded JSON before persistence', () => {
  const secret = 'fixture-provider-secret-with/slash';
  const secrets = [secret];
  const redact = createInspectorRedactor(secrets);
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
  secrets.push('fixture-rotated-opaque-token');
  const rotated = String(redact('fixture-rotated-opaque-token and ' + secret));
  assert.ok(!rotated.includes('fixture-rotated-opaque-token'));
  assert.ok(!rotated.includes(secret));
});

test('inspector masks secure links, common token strings and secret assignments in tool text', () => {
  const redact = createInspectorRedactor();
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

test('short secret masking does not scan replacement markers again', () => {
  const redact = createInspectorRedactor(['a', 'red'], { minimumSecretLength: 1 });
  assert.equal(redact('red a'), '[redacted] [redacted]');
});

async function handoffView(
  request: (path: string, options?: RequestInit) => Promise<Response>,
  content?: React.ReactNode,
  beforeStreamResponse?: Promise<void>,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
  const streams: Array<{
    path: string;
    signal: AbortSignal | null | undefined;
    controller: ReadableStreamDefaultController<Uint8Array>;
    closed: boolean;
    cancelled: boolean;
  }> = [];
  const activeUrls = new Set<string>();
  const revokedUrls: string[] = [];
  const streamResponses: Response[] = [];
  dom.window.URL.createObjectURL = () => {
    const url = `blob:http://localhost/${randomUUID()}`;
    activeUrls.add(url);
    return url;
  };
  dom.window.URL.revokeObjectURL = (url) => {
    activeUrls.delete(url);
    revokedUrls.push(url);
  };
  const replacements = {
    window: dom.window,
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    DOMParser: dom.window.DOMParser,
    MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
    URL: dom.window.URL,
    fetch: (input: string | URL | Request, options?: RequestInit) => {
      const path = String(input);
      if (!path.startsWith('/api/browser-handoff/stream')) return request(path, options);
      const stream = {
        path,
        signal: options?.signal,
        controller: undefined as unknown as ReadableStreamDefaultController<Uint8Array>,
        closed: false,
        cancelled: false,
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          stream.controller = controller;
        },
        cancel() {
          stream.closed = true;
          stream.cancelled = true;
        },
      });
      streams.push(stream);
      const abort = () => {
        if (stream.closed) return;
        stream.closed = true;
        stream.controller.error(new DOMException('Synthetic stream aborted.', 'AbortError'));
      };
      if (stream.signal?.aborted) abort();
      else stream.signal?.addEventListener('abort', abort, { once: true });
      return Promise.resolve(beforeStreamResponse).then(
        () =>
          streamResponses.shift() ??
          new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } }),
      );
    },
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, replacements);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  let completions = 0;
  let unmounted = false;
  const root = createRoot(dom.window.document.querySelector('#root')!);
  await act(async () => {
    root.render(
      content ??
        createElement(BrowserHandoff, {
          onDone: async () => {
            completions++;
          },
        }),
    );
  });
  const element = <T extends Element>(selector: string) => {
    const value = dom.window.document.querySelector<T>(selector);
    assert.ok(value, selector);
    return value;
  };
  const pointer = async (type: string, clientX = 110, clientY = 70) => {
    const image = element<HTMLImageElement>('.browser-handoff img');
    await act(async () => {
      image.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX, clientY }));
    });
  };
  return {
    dom,
    element,
    completions: () => completions,
    pointer,
    streams,
    streamResponses,
    activeUrls,
    revokedUrls,
    async render(next: React.ReactNode) {
      await act(async () => root.render(next));
    },
    async frame(bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9])) {
      const stream = streams.at(-1)!;
      assert.ok(stream && !stream.closed);
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      await act(async () => {
        stream.controller.enqueue(length.subarray(0, 2));
        stream.controller.enqueue(length.subarray(2));
        stream.controller.enqueue(bytes);
      });
    },
    async endStream(failure = false) {
      const stream = streams.at(-1)!;
      assert.ok(stream && !stream.closed);
      await act(async () => {
        stream.closed = true;
        if (failure) stream.controller.error(new Error('Synthetic stream interrupted.'));
        else stream.controller.close();
      });
    },
    async loadFrame(image = element<HTMLImageElement>('.browser-handoff img')) {
      image.getBoundingClientRect = () =>
        ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect;
      Object.defineProperties(image, {
        naturalWidth: { value: 400, configurable: true },
        naturalHeight: { value: 200, configurable: true },
      });
      await act(async () => {
        image.dispatchEvent(new dom.window.Event('load'));
      });
    },
    async showFrame() {
      await this.frame();
      await this.loadFrame();
    },
    async clickImage() {
      await this.showFrame();
      await pointer('mousedown');
      await pointer('mouseup');
    },
    async button(label: string) {
      const button = [...dom.window.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent === label,
      );
      assert.ok(button, label);
      await act(async () => button.click());
    },
    async unmount() {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
    },
    async close() {
      if (!unmounted) await act(async () => root.unmount());
      await act(async () => delay(10));
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function requestedChatState(): AppState {
  return {
    threadId: randomUUID(),
    messages: [
      {
        id: randomUUID(),
        role: 'assistant',
        turnId: randomUUID(),
        text: 'An earlier synthetic conversation.',
        attachments: [],
        createdAt: '2026-10-01T12:00:00.000Z',
      },
    ],
    turns: [],
    configuration: {
      provider: 'fixture',
      model: 'none',
      llmReady: true,
      integrationsReady: false,
      inspectorEnabled: false,
      localOnly: true,
      conversationResetEnabled: false,
    },
  };
}

test('missing-key setup opens the shared Models settings', async () => {
  const requests: string[] = [];
  const view = await handoffView(async () => {
    throw new Error('Unexpected setup network request.');
  }, createElement('div'));
  Object.assign(view.dom.window, {
    ottoDesktop: {
      getSettings: async () => {
        throw new Error('Unexpected native settings request.');
      },
    },
  });
  const receive = (event: Event) => requests.push((event as CustomEvent<string>).detail);
  view.dom.window.addEventListener('otto:open-settings', receive);
  const notice = (integrationsReady: boolean) =>
    createElement(SetupNotice, {
      configuration: { ...requestedChatState().configuration, integrationsReady },
    });
  try {
    await view.render(notice(false));
    await act(async () => view.element<HTMLButtonElement>('button').click());
    assert.deepEqual(requests, ['models']);
    await act(async () => view.element<HTMLButtonElement>('button').click());
    assert.deepEqual(requests, ['models', 'models']);
    await view.render(notice(true));
    assert.equal(view.dom.window.document.querySelector('button'), null);
    assert.deepEqual(requests, ['models', 'models']);
  } finally {
    view.dom.window.removeEventListener('otto:open-settings', receive);
    await view.close();
  }
});

test('chat request submits once under StrictMode and keeps the pending message visible', async () => {
  const state = requestedChatState();
  const pending = deferred<Response>();
  const submissions: Array<{ clientMessageId: string; text: string }> = [];
  const handled: string[] = [];
  const request = { id: randomUUID(), text: 'Create a synthetic task.' };
  const chat = () =>
    createElement(
      StrictMode,
      null,
      createElement(Chat, {
        ownerId: 'synthetic-feedback-owner',
        state,
        streams: {},
        refresh: async () => {},
        resetConversation: async () => state.threadId,
        requestedMessage: { ...request },
        onRequestHandled: (id) => handled.push(id),
      }),
    );
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    assert.equal(path, '/api/messages');
    submissions.push(JSON.parse(String(options?.body)));
    return pending.promise;
  }, chat());
  try {
    assert.equal(submissions.length, 1);
    assert.deepEqual(handled, [request.id]);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 1);
    await view.render(chat());
    assert.equal(submissions.length, 1);
    assert.deepEqual(handled, [request.id]);
    await act(async () =>
      pending.resolve(
        Response.json({
          messageId: submissions[0].clientMessageId,
          threadId: state.threadId,
          turnId: randomUUID(),
        }),
      ),
    );
    await view.render(chat());
    assert.equal(submissions.length, 1);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 1);
  } finally {
    pending.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    await view.close();
  }
});

test('chat request waits for model readiness before consuming and submitting once', async () => {
  const state = requestedChatState();
  const pending = deferred<Response>();
  const submissions: Array<{ clientMessageId: string; text: string }> = [];
  const handled: string[] = [];
  const request = { id: randomUUID(), text: 'Create a synthetic task.' };
  const chat = (llmReady: boolean) =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state: { ...state, configuration: { ...state.configuration, llmReady } },
      streams: {},
      refresh: async () => {},
      resetConversation: async () => state.threadId,
      requestedMessage: request,
      onRequestHandled: (id) => handled.push(id),
    });
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    assert.equal(path, '/api/messages');
    submissions.push(JSON.parse(String(options?.body)));
    return pending.promise;
  }, chat(false));
  try {
    assert.equal(submissions.length, 0);
    assert.deepEqual(handled, []);
    await view.render(chat(true));
    assert.equal(submissions.length, 1);
    assert.deepEqual(handled, [request.id]);
    await act(async () =>
      pending.resolve(
        Response.json({
          messageId: submissions[0].clientMessageId,
          threadId: state.threadId,
          turnId: randomUUID(),
        }),
      ),
    );
    await view.render(chat(true));
    assert.equal(submissions.length, 1);
    assert.deepEqual(handled, [request.id]);
  } finally {
    pending.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    await view.close();
  }
});

test('chat request queues a later page request behind an unacknowledged message', async () => {
  const state = requestedChatState();
  const first = deferred<Response>();
  const second = deferred<Response>();
  const submissions: Array<{ clientMessageId: string; text: string }> = [];
  const requests = [
    { id: randomUUID(), text: 'Create a synthetic task.' },
    { id: randomUUID(), text: 'Schedule a synthetic reminder.' },
  ];
  const chat = (requestedMessage: (typeof requests)[number]) =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state,
      streams: {},
      refresh: async () => {},
      resetConversation: async () => state.threadId,
      requestedMessage,
    });
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    assert.equal(path, '/api/messages');
    submissions.push(JSON.parse(String(options?.body)));
    return submissions.length === 1 ? first.promise : second.promise;
  }, chat(requests[0]));
  try {
    await view.render(chat(requests[1]));
    assert.equal(submissions.length, 1);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 2);
    await act(async () =>
      first.resolve(
        Response.json({
          messageId: submissions[0].clientMessageId,
          threadId: state.threadId,
          turnId: randomUUID(),
        }),
      ),
    );
    assert.deepEqual(
      submissions.map((submission) => submission.text),
      requests.map((request) => request.text),
    );
    assert.notEqual(submissions[0].clientMessageId, submissions[1].clientMessageId);
    await act(async () =>
      second.resolve(
        Response.json({
          messageId: submissions[1].clientMessageId,
          threadId: state.threadId,
          turnId: randomUUID(),
        }),
      ),
    );
    await view.render(chat({ ...requests[1] }));
    assert.equal(submissions.length, 2);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 2);
  } finally {
    first.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    second.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    await view.close();
  }
});

test('chat request restores failed queued requests in submission order without dispatching the later request', async () => {
  const state = requestedChatState();
  const pending = deferred<Response>();
  const draft = 'Keep this unsent draft.';
  const requests = [
    { id: randomUUID(), text: 'Create a synthetic task.' },
    { id: randomUUID(), text: 'Schedule a synthetic reminder.' },
  ];
  const submissions: Array<{ text: string }> = [];
  const chat = (requestedMessage?: (typeof requests)[number]) =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state,
      streams: {},
      refresh: async () => {},
      resetConversation: async () => state.threadId,
      requestedMessage,
    });
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    assert.equal(path, '/api/messages');
    submissions.push(JSON.parse(String(options?.body)));
    return pending.promise;
  }, chat());
  try {
    const editor = view.element<HTMLElement & { editor: Editor }>('[role="textbox"]').editor;
    await act(async () => editor.commands.setContent(draft));
    await view.render(chat(requests[0]));
    await view.render(chat(requests[1]));
    assert.equal(submissions.length, 1);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 2);
    await act(async () =>
      pending.resolve(Response.json({ error: 'Synthetic request rejected' }, { status: 503 })),
    );
    assert.equal(submissions.length, 1);
    assert.equal(editor.getMarkdown(), `${requests[0].text}\n\n${requests[1].text}\n\n${draft}`);
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 0);
    await view.render(chat({ ...requests[1] }));
    assert.equal(submissions.length, 1);
  } finally {
    pending.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    await view.close();
  }
});

test('chat request isolates a stale reply and attachments and restores failure before the existing draft', async () => {
  const state = requestedChatState();
  const pending = deferred<Response>();
  const request = { id: randomUUID(), text: 'Create a synthetic task.' };
  const draft = 'Keep this unsent draft.';
  const artifact = {
    id: randomUUID(),
    name: 'synthetic-draft.txt',
    mimeType: 'text/plain',
    size: 5,
    url: '/api/artifacts/synthetic-draft',
  };
  const submissions: Array<{
    clientMessageId: string;
    text: string;
    replyToMessageId?: string;
    attachmentIds: string[];
  }> = [];
  const chat = (requestedMessage?: typeof request) =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state,
      streams: {},
      refresh: async () => {},
      resetConversation: async () => state.threadId,
      requestedMessage,
    });
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    if (path === '/api/uploads') return Response.json(artifact);
    assert.equal(path, '/api/messages');
    submissions.push(JSON.parse(String(options?.body)));
    return pending.promise;
  }, chat());
  try {
    const editor = view.element<HTMLElement & { editor: Editor }>('[role="textbox"]').editor;
    await act(async () => {
      editor.commands.setContent(draft);
      view.element<HTMLButtonElement>('[aria-label="Reply to message"]').click();
      const input = view.element<HTMLInputElement>('[aria-label="Choose files"]');
      Object.defineProperty(input, 'files', {
        value: [new File(['draft'], artifact.name, { type: artifact.mimeType })],
      });
      input.dispatchEvent(new view.dom.window.Event('change', { bubbles: true }));
    });
    assert.ok(view.element('.composer-reply'));
    await view.render(chat(request));
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].replyToMessageId, undefined);
    assert.deepEqual(submissions[0].attachmentIds, []);
    assert.equal(editor.getMarkdown(), draft);
    assert.ok(view.element('[aria-label="Remove synthetic-draft.txt"]'));
    assert.equal(view.dom.window.document.querySelector('.composer-reply'), null);
    await act(async () =>
      pending.resolve(Response.json({ error: 'Synthetic request rejected' }, { status: 503 })),
    );
    assert.equal(editor.getMarkdown(), `${request.text}\n\n${draft}`);
    assert.ok(view.element('[aria-label="Remove synthetic-draft.txt"]'));
    assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 0);
    assert.equal(view.dom.window.document.querySelector('.composer-reply'), null);
    await view.render(chat({ ...request }));
    assert.equal(submissions.length, 1);
    assert.equal(editor.getMarkdown(), `${request.text}\n\n${draft}`);
  } finally {
    pending.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
    await view.close();
  }
});

test('chat keeps a waiting browser handoff after a background message and closes it for a new user turn', async () => {
  const state = requestedChatState();
  const turnId = state.messages[0].turnId!;
  state.messages[0].text = 'Complete this step in [Open browser](/browser).';
  state.turns = [
    {
      id: turnId,
      source: 'user',
      status: 'waiting',
      showTyping: true,
      createdAt: '2026-10-01T12:00:00.000Z',
    },
  ];
  const chat = () =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state: { ...state },
      streams: {},
      refresh: async () => {},
      resetConversation: async () => state.threadId,
    });
  const controls: unknown[] = [];
  const view = await handoffView(async (path, options) => {
    if (path === '/api/apps') return Response.json([]);
    assert.equal(path, '/api/browser-handoff');
    controls.push(...JSON.parse(String(options?.body)).inputs);
    return Response.json({ ok: true });
  }, chat());
  try {
    const original = view.element('.browser-handoff');
    const backgroundId = randomUUID();
    state.messages = [
      ...state.messages,
      {
        id: randomUUID(),
        role: 'assistant',
        turnId: backgroundId,
        text: 'A separate schedule needs your approval.',
        attachments: [],
        createdAt: '2026-10-01T12:01:00.000Z',
      },
    ];
    state.turns = [
      {
        id: backgroundId,
        source: 'schedule',
        status: 'waiting',
        showTyping: false,
        createdAt: '2026-10-01T12:01:00.000Z',
      },
      ...state.turns,
    ];
    await view.render(chat());
    assert.equal(view.element('.browser-handoff'), original);
    await view.clickImage();
    await act(async () => delay(10));
    assert.deepEqual(controls, [
      { type: 'mouse', event: 'down', x: 0.5, y: 0.5, button: 'left' },
      { type: 'mouse', event: 'up', x: 0.5, y: 0.5, button: 'left' },
    ]);
    state.turns = [
      {
        id: randomUUID(),
        source: 'user',
        status: 'succeeded',
        showTyping: true,
        createdAt: '2026-10-01T12:02:00.000Z',
      },
      ...state.turns,
    ];
    await view.render(chat());
    assert.equal(view.dom.window.document.querySelector('.browser-handoff'), null);
  } finally {
    await view.close();
  }
});

for (const failure of ['rejected', 'disconnected'] as const)
  test(`chat preserves a ${failure} browser continuation until an acknowledged retry`, async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const submissions: Array<{ clientMessageId: string; threadId: string }> = [];
    let controls = 0;
    const state: AppState = {
      threadId: randomUUID(),
      messages: [
        {
          id: randomUUID(),
          role: 'assistant',
          turnId: randomUUID(),
          text: 'Complete this step in [Open browser](/browser).',
          attachments: [],
          createdAt: '2026-10-01T12:00:00.000Z',
        },
      ],
      turns: [],
      configuration: {
        provider: 'fixture',
        model: 'none',
        llmReady: true,
        integrationsReady: false,
        inspectorEnabled: false,
        localOnly: true,
        conversationResetEnabled: false,
      },
    };
    const view = await handoffView(
      async (path, options) => {
        if (path === '/api/apps') return Response.json([]);
        if (path === '/api/browser-handoff') {
          controls += JSON.parse(String(options?.body)).inputs.length;
          return Response.json({ ok: true });
        }
        assert.equal(path, '/api/messages');
        const attempt = submissions.length;
        submissions.push(JSON.parse(String(options?.body)));
        const result = await (attempt ? second.promise : first.promise);
        if (!attempt && failure === 'disconnected') throw new Error('Synthetic connection lost');
        return result;
      },
      createElement(Chat, {
        ownerId: 'synthetic-feedback-owner',
        state,
        streams: {},
        refresh: async () => {},
        resetConversation: async () => state.threadId,
      }),
    );
    try {
      const original = view.element('.browser-handoff');
      await view.clickImage();
      await act(async () => delay(10));
      await view.button('Done');
      assert.equal(submissions.length, 1);
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(
        view.element<HTMLButtonElement>('.browser-handoff-bar > :last-child > button:last-child')
          .disabled,
        true,
      );
      assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 1);
      await view.clickImage();
      assert.equal(submissions.length, 1);
      assert.equal(controls, 2);
      await act(async () =>
        first.resolve(Response.json({ error: 'Synthetic request rejected' }, { status: 503 })),
      );
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(
        view.element<HTMLButtonElement>('.browser-handoff-bar > :last-child > button:last-child')
          .disabled,
        false,
      );
      assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 0);
      await view.button('Done');
      assert.equal(submissions.length, 2);
      assert.equal(submissions[1].clientMessageId, submissions[0].clientMessageId);
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(controls, 2);
      await act(async () =>
        second.resolve(
          Response.json({
            messageId: submissions[1].clientMessageId,
            threadId: state.threadId,
            turnId: randomUUID(),
          }),
        ),
      );
      assert.equal(view.dom.window.document.querySelector('.browser-handoff'), null);
      assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 1);
      assert.equal(controls, 2);
    } finally {
      first.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
      second.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
      await view.close();
    }
  });

test('the live handoff waits for a frame, merges moves and typing behind a pending request, and sends everything before Done', async () => {
  const first = deferred<Response>();
  const posted: unknown[] = [];
  const view = await handoffView(async (path, options) => {
    assert.equal(path, '/api/browser-handoff');
    posted.push(JSON.parse(String(options?.body)).inputs);
    return posted.length === 1 ? first.promise : Response.json({ ok: true });
  });
  const type = async (key: string) => {
    const screen = view.element('.browser-handoff-screen');
    await act(async () => {
      screen.dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key, bubbles: true }));
    });
  };
  try {
    assert.match(
      view.streams.at(-1)!.path,
      /^\/api\/browser-handoff\/stream\?view=[0-9a-f-]{36}-0$/,
    );
    await view.pointer('mousemove');
    assert.deepEqual(posted, []);
    await view.showFrame();
    await view.pointer('mousedown');
    await view.pointer('mousemove', 60, 30);
    await view.pointer('mousemove', 160, 120);
    await type('a');
    await type('b');
    await view.button('Done');
    assert.equal(view.completions(), 0);
    await act(async () => first.resolve(Response.json({ ok: true })));
    await act(async () => delay(10));
    assert.deepEqual(posted, [
      [{ type: 'mouse', event: 'down', x: 0.5, y: 0.5, button: 'left' }],
      [
        { type: 'mouse', event: 'move', x: 0.75, y: 1 },
        { type: 'text', text: 'ab' },
      ],
    ]);
    assert.equal(view.completions(), 1);
  } finally {
    first.resolve(Response.json({ ok: true }));
    await view.close();
  }
});

test('a handoff with no first frame stops reconnecting and can be reopened without submitting input', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: unknown[] = [];
  const view = await handoffView(async (_path, options) => {
    posted.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  });
  const source = () => view.streams.findLast((stream) => !stream.signal?.aborted)?.path;
  try {
    const first = source();
    await act(async () => t.mock.timers.tick(15_000));
    await act(async () => t.mock.timers.tick(1000));
    assert.notEqual(source(), first);
    const second = source();
    await act(async () => t.mock.timers.tick(15_000));
    await act(async () => t.mock.timers.tick(1000));
    assert.notEqual(source(), second);
    await act(async () => t.mock.timers.tick(15_000));
    assert.equal(source(), undefined);
    await act(async () => t.mock.timers.tick(60_000));
    assert.equal(source(), undefined);
    assert.equal(view.completions(), 0);
    assert.deepEqual(posted, []);
    const retry = [...view.dom.window.document.querySelectorAll('button')].find(
      (button) => button.textContent === 'Try again',
    );
    assert.ok(retry);
    const activate = new view.dom.window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => retry.dispatchEvent(activate));
    assert.equal(activate.defaultPrevented, false);
    await view.button('Try again');
    assert.ok(source());
    await view.clickImage();
    assert.equal(posted.length, 2);
    await act(async () => t.mock.timers.tick(60_000));
    assert.ok(source());
    for (const label of ['Enlarge browser', 'Shrink browser']) {
      const previousImage = view.element('.browser-handoff img');
      await act(async () => {
        view.element<HTMLButtonElement>(`button[aria-label="${label}"]`).click();
      });
      assert.notEqual(view.element('.browser-handoff img'), previousImage);
      assert.equal(view.element('.browser-handoff-screen').getAttribute('aria-disabled'), 'true');
      const resized = source();
      await act(async () => t.mock.timers.tick(15_000));
      await act(async () => t.mock.timers.tick(1000));
      assert.notEqual(source(), resized);
      await view.showFrame();
    }
    await view.button('Done');
    assert.equal(view.completions(), 1);
  } finally {
    t.mock.timers.reset();
    await view.close();
  }
});

for (const failure of [false, true])
  test(`a live browser handoff disables input and retries after stream ${failure ? 'failure' : 'EOF'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const posted: unknown[] = [];
    const view = await handoffView(async (_path, options) => {
      posted.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true });
    });
    const disabled = () => view.element('.browser-handoff-screen').getAttribute('aria-disabled');
    try {
      await view.showFrame();
      assert.equal(disabled(), 'false');
      const original = view.element<HTMLImageElement>('.browser-handoff img');
      await view.endStream(failure);
      assert.equal(disabled(), 'true');
      await view.loadFrame(original);
      assert.equal(disabled(), 'true');
      await view.pointer('mousedown');
      await act(async () => {
        view
          .element('.browser-handoff-screen')
          .dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      });
      assert.deepEqual(posted, []);
      await act(async () => t.mock.timers.tick(1000));
      assert.equal(view.streams.length, 2);
      assert.equal(view.streams[0].signal?.aborted, true);
      await view.loadFrame(original);
      assert.equal(disabled(), 'true');
      await view.endStream(failure);
      await act(async () => t.mock.timers.tick(1000));
      assert.equal(view.streams.length, 3);
      await view.endStream(failure);
      await act(async () => t.mock.timers.tick(60_000));
      assert.equal(view.streams.length, 3);
      assert.equal(view.dom.window.document.querySelector('.browser-handoff img'), null);
      assert.deepEqual(posted, []);
      assert.equal(view.activeUrls.size, 0);
      await view.button('Try again');
      assert.equal(view.streams.length, 4);
      await view.showFrame();
      assert.equal(disabled(), 'false');
      await view.button('Done');
      assert.equal(view.completions(), 1);
      assert.equal(view.streams[3].signal?.aborted, true);
      assert.equal(view.activeUrls.size, 0);
    } finally {
      t.mock.timers.reset();
      await view.close();
    }
  });

for (const status of [423, 409])
  test(`browser handoff access response ${status} ${status === 423 ? 'closes the view' : 'allows recovery'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const posted: unknown[] = [];
    const view = await handoffView(async (_path, options) => {
      posted.push(JSON.parse(String(options?.body)));
      return Response.json({ ok: true });
    });
    try {
      await view.showFrame();
      view.streamResponses.push(Response.json({ error: 'Synthetic view response.' }, { status }));
      await view.endStream();
      await act(async () => t.mock.timers.tick(1000));
      assert.equal(view.streams.length, 2);
      assert.equal(view.activeUrls.size, 0);
      assert.deepEqual(posted, []);
      if (status === 423) {
        assert.equal(Boolean(view.dom.window.document.querySelector('.browser-handoff')), false);
        assert.equal(
          view.streams.every((stream) => stream.signal?.aborted),
          true,
        );
        await act(async () => t.mock.timers.tick(60_000));
        assert.equal(view.streams.length, 2);
        assert.equal(view.completions(), 0);
      } else {
        assert.equal(view.element('.browser-handoff-screen').getAttribute('aria-disabled'), 'true');
        await act(async () => t.mock.timers.tick(1000));
        assert.equal(view.streams.length, 3);
        await view.showFrame();
        assert.equal(
          view.element('.browser-handoff-screen').getAttribute('aria-disabled'),
          'false',
        );
        await view.button('Done');
        assert.equal(view.completions(), 1);
        assert.equal(
          view.streams.every((stream) => stream.signal?.aborted),
          true,
        );
      }
      assert.deepEqual(posted, []);
      assert.equal(view.activeUrls.size, 0);
    } finally {
      t.mock.timers.reset();
      await view.close();
    }
  });

test('a browser frame decoded after EOF cannot restore input and old views release their frames', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: unknown[] = [];
  const view = await handoffView(async (_path, options) => {
    posted.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  });
  const disabled = () => view.element('.browser-handoff-screen').getAttribute('aria-disabled');
  try {
    await view.frame();
    const undecoded = view.element<HTMLImageElement>('.browser-handoff img');
    assert.equal(disabled(), 'true');
    await view.endStream();
    await view.loadFrame(undecoded);
    assert.equal(disabled(), 'true');
    await act(async () => t.mock.timers.tick(1000));
    assert.equal(view.streams.length, 2);
    await view.frame();
    await view.loadFrame(undecoded);
    await act(async () => undecoded.dispatchEvent(new view.dom.window.Event('error')));
    assert.equal(disabled(), 'true');
    await view.loadFrame();
    assert.equal(disabled(), 'false');
    for (let index = 0; index < 12; index++) {
      await view.frame();
      assert.ok(view.activeUrls.size <= 2);
    }
    await view.loadFrame();
    assert.equal(view.activeUrls.size, 1);
    const previous = view.element<HTMLImageElement>('.browser-handoff img');
    await act(async () => {
      view.element<HTMLButtonElement>('button[aria-label="Enlarge browser"]').click();
    });
    assert.equal(view.streams[1].signal?.aborted, true);
    assert.equal(view.streams.length, 3);
    await view.loadFrame(previous);
    assert.equal(disabled(), 'true');
    await view.frame();
    await act(async () => previous.dispatchEvent(new view.dom.window.Event('error')));
    await view.loadFrame();
    assert.equal(disabled(), 'false');
    await view.unmount();
    assert.equal(view.streams[2].signal?.aborted, true);
    assert.equal(view.activeUrls.size, 0);
    assert.deepEqual(posted, []);
  } finally {
    t.mock.timers.reset();
    await view.close();
  }
});

test('a handoff with an undecoded replacement frame bounds waiting after stream EOF', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const posted: unknown[] = [];
  const view = await handoffView(async (_path, options) => {
    posted.push(JSON.parse(String(options?.body)));
    return Response.json({ ok: true });
  });
  try {
    await view.showFrame();
    await view.frame();
    await view.endStream();
    assert.equal(view.element('.browser-handoff-screen').getAttribute('aria-disabled'), 'false');
    await act(async () => t.mock.timers.tick(15_000));
    assert.equal(view.element('.browser-handoff-screen').getAttribute('aria-disabled'), 'true');
    await act(async () => {
      view
        .element('.browser-handoff-screen')
        .dispatchEvent(new view.dom.window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    });
    assert.deepEqual(posted, []);
    await view.loadFrame();
    assert.equal(view.element('.browser-handoff-screen').getAttribute('aria-disabled'), 'true');
    assert.equal(view.activeUrls.size, 0);
  } finally {
    t.mock.timers.reset();
    await view.close();
  }
});

for (const phase of ['headers', 'frame'])
  test(`changing account closes a browser handoff waiting for ${phase} without reconnecting`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { setRequestAccount } = await import('../src/web/lib/api.ts');
    setRequestAccount('synthetic-original-owner');
    const response = deferred();
    const posted: unknown[] = [];
    const view = await handoffView(
      async (_path, options) => {
        posted.push(JSON.parse(String(options?.body)));
        return Response.json({ ok: true });
      },
      undefined,
      phase === 'headers' ? response.promise : undefined,
    );
    try {
      if (phase === 'frame') {
        await view.frame();
        assert.equal(view.activeUrls.size, 1);
      }
      await act(async () => setRequestAccount('synthetic-replacement-owner'));
      await act(async () => response.resolve());
      assert.equal(view.streams[0].signal?.aborted, true);
      assert.equal(view.dom.window.document.querySelector('.browser-handoff'), null);
      assert.equal(view.activeUrls.size, 0);
      await act(async () => t.mock.timers.tick(60_000));
      assert.equal(view.streams.length, 1);
      assert.deepEqual(posted, []);
    } finally {
      await act(async () => {
        response.resolve();
        setRequestAccount(null);
      });
      t.mock.timers.reset();
      await view.close();
    }
  });

test('chat keeps every message across refreshes after earlier messages were loaded', async () => {
  const threadId = randomUUID();
  const messages: Message[] = Array.from({ length: 6 }, (_, index) => ({
    id: randomUUID(),
    role: 'user',
    turnId: null,
    text: `Synthetic message ${index}`,
    attachments: [],
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
  }));
  const state = (window: Message[]): AppState => ({
    threadId,
    hasEarlierMessages: true,
    messages: window,
    turns: [],
    configuration: {
      provider: 'fixture',
      model: 'none',
      llmReady: true,
      integrationsReady: false,
      inspectorEnabled: false,
      localOnly: true,
      conversationResetEnabled: false,
    },
  });
  const chat = (window: Message[]) =>
    createElement(Chat, {
      ownerId: 'synthetic-feedback-owner',
      state: state(window),
      streams: {},
      refresh: async () => {},
      resetConversation: async () => threadId,
    });
  const view = await handoffView(
    async (path) => {
      if (path === '/api/apps') return Response.json([]);
      assert.match(path, /^\/api\/messages\?/);
      return Response.json({ messages: messages.slice(0, 2), hasMore: false });
    },
    chat(messages.slice(2, 5)),
  );
  const shown = () =>
    [...view.dom.window.document.querySelectorAll<HTMLElement>('[data-message-id]')].map(
      (element) => element.dataset.messageId,
    );
  try {
    await view.button('Load earlier messages');
    assert.deepEqual(
      shown(),
      messages.slice(0, 5).map((message) => message.id),
    );
    await view.render(chat(messages.slice(3, 6)));
    assert.deepEqual(
      shown(),
      messages.map((message) => message.id),
    );
  } finally {
    await view.close();
  }
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
      ];
      const leaked = [];
      try {
        for (const mode of ['web', 'native']) {
          window.ottoDesktop = mode === 'native' ? { captureFeedbackScreenshot: async () => { native++; return new Uint8Array([1, 2, 3]); } } : undefined;
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
        window.ottoDesktop = { captureFeedbackScreenshot: () => { native++; started(); return new Promise(resolve => release = resolve); } };
        document.body.innerHTML = safe;
        const pending = captureFeedbackScreenshot();
        await requested;
        document.querySelector('[contenteditable]').textContent = 'Synthetic draft typed during capture';
        release(new Uint8Array([1, 2, 3]));
        assert.equal(await pending, null);
        assert.equal(document.querySelector('[contenteditable]').textContent, 'Synthetic draft typed during capture');
        document.body.innerHTML = safe;
        window.ottoDesktop = { captureFeedbackScreenshot: async () => { native++; return new Uint8Array([1, 2, 3]); } };
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

test('native Settings and feedback preserve the active credential form', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', {
        url: 'http://localhost/credentials/synthetic-form',
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
        IS_REACT_ACT_ENVIRONMENT: true,
        ...Object.fromEntries(['Node', 'NodeFilter', 'Event', 'CustomEvent', 'Element', 'HTMLElement', 'HTMLInputElement', 'MutationObserver'].map(name => [name, dom.window[name]])),
      });
      const requests = [];
      globalThis.fetch = async path => {
        requests.push(path);
        if (path === '/api/session') return Response.json({
          auth: { mode: 'local', googleAvailable: false },
          user: { id: 'synthetic-owner', name: 'Fixture', email: null, avatarUrl: null },
          settings: { theme: 'system', onboardingCompleted: true, usageData: false },
          capabilities: { developer: true },
        });
        if (path === '/api/feedback/context') return Response.json({
          enabled: true, appVersion: null, appRelease: null, appModified: null, source: 'local-web', development: false, computerName: null, platform: null,
        });
        if (path === '/api/credential-requests/synthetic-form') return Response.json({
          kind: 'password', status: 'pending', origin: 'https://fixture.example.invalid',
          expiresAt: new Date(Date.now() + 60_000).toISOString(), fields: [], savedEntries: [],
        });
        throw new Error('Unexpected fixture request: ' + path);
      };
      const preferences = { theme: 'system', resolvedTheme: 'light', launchAtLogin: false, notifications: false };
      let openSettings;
      let openFeedback;
      let screenshotCaptures = 0;
      dom.window.ottoDesktop = {
        captureFeedbackScreenshot: async () => { screenshotCaptures++; throw new Error('Private capture must not run'); },
        getSettings: async () => ({ ...preferences, hasComposioKey: false, keys: { composioApiKey: { suffix: null } }, restartRequired: false }),
        getPreferences: async () => preferences,
        onPreferences: () => () => {},
        onOpenSettings: listener => {
          openSettings = listener;
          return () => { openSettings = undefined; };
        },
        onFeedbackRequested: listener => {
          openFeedback = listener;
          return () => { openFeedback = undefined; };
        },
      };
      const { act, createElement } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { App } = await import('./src/web/app.tsx');
      const root = createRoot(document.querySelector('#root'));
      try {
        await act(async () => root.render(createElement(App)));
        const password = document.querySelector('input[name="password"]');
        assert.ok(password);
        password.value = 'synthetic-unsaved-password';
        password.focus();
        assert.ok(openSettings);
        await act(async () => openSettings('general'));
        assert.ok(document.querySelector('[role="dialog"]'));
        assert.equal(window.location.pathname, '/credentials/synthetic-form');
        assert.equal(document.querySelector('input[name="password"]'), password);
        assert.equal(password.value, 'synthetic-unsaved-password');
        await act(async () => document.querySelector('[aria-label="Close"]').click());
        await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.querySelector('input[name="password"]'), password);
        assert.equal(password.value, 'synthetic-unsaved-password');
        assert.ok(document.activeElement === password);
        assert.deepEqual(requests, ['/api/session', '/api/credential-requests/synthetic-form']);
        assert.ok(openFeedback);
        await act(async () => openFeedback());
        assert.ok(document.querySelector('[role="dialog"].feedback-dialog'));
        assert.equal(screenshotCaptures, 0);
        assert.equal(window.location.pathname, '/credentials/synthetic-form');
        assert.equal(document.querySelector('input[name="password"]'), password);
        assert.equal(password.value, 'synthetic-unsaved-password');
        await act(async () => document.querySelector('[aria-label="Close"]').click());
        await act(async () => new Promise(resolve => setTimeout(resolve, 0)));
        assert.equal(document.querySelector('[role="dialog"]'), null);
        assert.equal(document.querySelector('input[name="password"]'), password);
        assert.equal(password.value, 'synthetic-unsaved-password');
        assert.ok(document.activeElement === password);
        assert.deepEqual(requests, ['/api/session', '/api/credential-requests/synthetic-form', '/api/feedback/context']);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
      process.exit(0);
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

for (const surface of ['channels', 'onboarding'])
  test(`Telegram setup preserves multiline clipboard boundaries in its protected submitted field on ${surface}`, async () => {
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
      const submissions = [];
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/channels') return Response.json({ channels: [], error: null });
        if (path === '/api/channel-settings') return Response.json({ ready: true, channels: [] });
        assert.equal(path, '/api/channel-settings/telegram');
        assert.equal(options.method, 'PUT');
        submissions.push(JSON.parse(options.body));
        return Response.json({ error: 'Synthetic retry keeps the form available.' }, { status: 400 });
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
        await act(async () => document.querySelector('${surface === 'channels' ? '.channel-option button' : '.ob-tg-action'}').click());
        const input = document.querySelector('input[type="password"]');
        assert.ok(input);
        assert.equal(input.autocomplete, 'off');
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        const edit = async value => act(async () => {
          setValue.call(input, value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        const paste = async text => {
          const event = new Event('paste', { bubbles: true, cancelable: true });
          Object.defineProperty(event, 'clipboardData', { value: {
            getData: type => type === 'text/plain' ? text : '',
          } });
          await act(async () => input.dispatchEvent(event));
          return event;
        };
        const submit = async () => act(async () => input.form.querySelector('button[type="submit"]').click());
        const token = '777000111:synthetic-channel-fixture';
        const expected = 'Use this token: ' + token + ' Keep it secure.';
        for (const newline of ['\\n', '\\r\\n', '\\r']) {
          await edit('replace-me');
          input.setSelectionRange(0, input.value.length);
          const event = await paste('Use this token:' + newline + token + newline + 'Keep it secure.');
          await submit();
          assert.equal(submissions.at(-1).botToken, expected);
          assert.equal(event.defaultPrevented, true);
          assert.equal(input.type, 'password');
        }
        await edit('Prefix replace-me suffix.');
        input.setSelectionRange(7, 17);
        await paste('Use this token:\\n' + token + '\\nKeep it secure.');
        assert.equal(input.selectionStart, 7 + expected.length);
        assert.equal(input.selectionEnd, input.selectionStart);
        await submit();
        assert.equal(submissions.at(-1).botToken, 'Prefix ' + expected + ' suffix.');
        const rawPaste = await paste(token);
        assert.equal(rawPaste.defaultPrevented, false);
        await edit(token);
        await submit();
        assert.equal(submissions.at(-1).botToken, token);
        assert.equal(submissions.length, 5);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
    });
    assert.equal(result.exitCode, 0, result.stderr);
  });

test('a selected model arriving after settings load keeps the picker closed', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        IS_REACT_ACT_ENVIRONMENT: true,
        ...Object.fromEntries(['Node', 'NodeFilter', 'Event', 'CustomEvent', 'Element', 'HTMLElement', 'HTMLInputElement', 'MutationObserver'].map(name => [name, dom.window[name]])),
      });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      let models = { connections: [], selection: null, subscriptionAvailable: true };
      globalThis.fetch = async path => {
        assert.equal(path, '/api/models');
        return Response.json(models);
      };
      const { act, createElement } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { ModelSettings } = await import('./src/web/components/models.tsx');
      const { pageDataCache } = await import('./src/web/lib/page-data-cache.ts');
      const root = createRoot(document.querySelector('#root'));
      try {
        await act(async () => root.render(createElement(ModelSettings)));
        models = {
          connections: [{ id: 'fixture', provider: 'openai', method: 'subscription', label: 'Fixture', status: 'connected', managed: false,
            models: [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['high'], images: true, contextWindow: 1000 }] }],
          selection: { connectionId: 'fixture', modelId: 'gpt-6-sol', effort: 'high' },
          subscriptionAvailable: true,
        };
        await act(async () => pageDataCache.update('/api/models', () => models));
        assert.equal(Boolean(document.querySelector('[role="dialog"]')), false);
        const picker = document.querySelector('.model-picker-trigger');
        assert.ok(picker);
        assert.equal(picker.disabled, false);
        await act(async () => picker.dispatchEvent(new Event('click', { bubbles: true })));
        assert.equal(Boolean(document.querySelector('[role="dialog"]')), true);
      } finally {
        await act(async () => root.unmount());
        pageDataCache.clear();
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('model sign-in cancellation reaches the server on dismissal, unmount and a late start response', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: `
      import assert from 'node:assert/strict';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        IS_REACT_ACT_ENVIRONMENT: true,
      });
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
      const connections = { connections: [], selection: null, subscriptionAvailable: true };
      const cancelled = [];
      let starts = 0;
      let releaseCancel;
      let releaseStart;
      let delayStart = false;
      const popups = [];
      window.open = () => {
        const popup = { closed: false, location: { replace() {} }, close() { this.closed = true; } };
        popups.push(popup);
        return popup;
      };
      globalThis.fetch = async (path, options = {}) => {
        if (path === '/api/models') return Response.json(connections);
        if (path === '/api/models/oauth') {
          const attempt = String(++starts).repeat(32);
          if (delayStart) await new Promise(resolve => { releaseStart = resolve; });
          return Response.json({ attempt, url: 'https://auth.openai.com/oauth/authorize?state=' + attempt });
        }
        if (options.method === 'DELETE') {
          cancelled.push(path.split('/').at(-1));
          if (cancelled.length === 1) await new Promise(resolve => { releaseCancel = resolve; });
          return Response.json(connections);
        }
        if (path.startsWith('/api/models/oauth/status/')) return Response.json({ status: 'waiting' });
        throw new Error('Unexpected request: ' + path);
      };
      const { act, createElement } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { ModelSettings } = await import('./src/web/components/models.tsx');
      const root = createRoot(document.querySelector('#root'));
      const find = text => [...document.querySelectorAll('button')].find(button => button.textContent.includes(text));
      const click = async text => {
        const button = find(text);
        assert.ok(button);
        await act(async () => button.click());
      };
      try {
        await act(async () => root.render(createElement(ModelSettings)));
        await click('Connect ChatGPT');
        await click('Cancel sign-in');
        assert.deepEqual(cancelled, ['1'.repeat(32)]);
        assert.equal(find('Connect ChatGPT').disabled, true);
        await act(async () => releaseCancel());
        assert.equal(find('Connect ChatGPT').disabled, false);
        await click('Connect ChatGPT');
        await act(async () => root.render(null));
        assert.deepEqual(cancelled, ['1'.repeat(32), '2'.repeat(32)]);
        await act(async () => root.render(createElement(ModelSettings)));
        delayStart = true;
        await click('Connect ChatGPT');
        await act(async () => root.render(null));
        await act(async () => releaseStart());
        assert.deepEqual(cancelled, ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)]);
        assert.equal(popups[2].closed, true);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('feedback draft storage isolates owners, preserves editable files and clears queued writes', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 15_000,
    input: `
      import assert from 'node:assert/strict';
      import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
      globalThis.indexedDB = indexedDB;
      const { loadFeedbackDraft, saveFeedbackDraft } = await import('./src/web/lib/feedback-draft.ts');
      const original = new File(['synthetic-original-private-pixels'], 'capture.png', { type: 'image/png', lastModified: 1000 });
      const rendered = new File(['synthetic-rendered-covered-pixels'], 'capture.png', { type: 'image/png', lastModified: 2000 });
      const marks = [{ tool: 'redact', from: { x: 10, y: 20 }, to: { x: 70, y: 90 } }];
      const first = {
        category: 'feature', feedback: 'Synthetic idea draft', includeReport: false, pendingId: null,
        attachments: [{ id: 'capture', file: rendered, image: { original, marks } }],
      };
      const second = {
        category: 'other', feedback: 'Different synthetic owner', includeReport: true, pendingId: crypto.randomUUID(),
        attachments: [{ id: 'log', file: new File(['synthetic log'], 'details.log', { type: 'text/plain' }) }],
      };
      const edited = { ...first, feedback: 'Updated synthetic idea' };
      await Promise.all([
        saveFeedbackDraft('owner-one', first),
        saveFeedbackDraft('owner-two', second),
        saveFeedbackDraft('owner-one', edited),
      ]);
      const restored = await loadFeedbackDraft('owner-one');
      assert.equal(restored.feedback, edited.feedback);
      assert.equal(restored.category, 'feature');
      assert.equal(restored.includeReport, false);
      assert.equal(restored.attachments[0].file.name, 'capture.png');
      assert.equal(restored.attachments[0].file.lastModified, 2000);
      assert.equal(await restored.attachments[0].file.text(), 'synthetic-rendered-covered-pixels');
      assert.equal(await restored.attachments[0].image.original.text(), 'synthetic-original-private-pixels');
      assert.deepEqual(restored.attachments[0].image.marks, marks);
      assert.equal((await loadFeedbackDraft('owner-two')).pendingId, second.pendingId);
      assert.equal(await loadFeedbackDraft('owner-three'), null);
      await assert.rejects(loadFeedbackDraft(''), /owner/);
      const pendingSave = saveFeedbackDraft('owner-one', first);
      const clear = saveFeedbackDraft('owner-one', null);
      await Promise.all([pendingSave, clear]);
      assert.equal(await loadFeedbackDraft('owner-one'), null);
      assert.equal((await loadFeedbackDraft('owner-two')).feedback, second.feedback);
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function () { throw new DOMException('Synthetic quota failure', 'QuotaExceededError'); };
      try {
        await assert.rejects(saveFeedbackDraft('owner-two', first));
        assert.equal((await loadFeedbackDraft('owner-two')).feedback, second.feedback);
      } finally {
        IDBObjectStore.prototype.put = put;
      }
      await saveFeedbackDraft('owner-two', edited);
      assert.equal((await loadFeedbackDraft('owner-two')).feedback, edited.feedback);
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open('otto-feedback', 1);
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
      assert.equal((await loadFeedbackDraft('owner-two')).feedback, edited.feedback);
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});

test('feedback copies the submitted snapshot and cancels pending copies when closed', async () => {
  const result = await runProcess(process.execPath, ['--import', 'tsx', '--input-type=module'], {
    timeoutMs: 20_000,
    input: `
      import assert from 'node:assert/strict';
      import 'fake-indexeddb/auto';
      import { JSDOM } from 'jsdom';
      const dom = new JSDOM('<div id="root"></div>', {
        url: 'http://localhost',
        pretendToBeVisual: true,
      });
      Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
        requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
        cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
        IS_REACT_ACT_ENVIRONMENT: true,
        ...Object.fromEntries(['Node', 'NodeFilter', 'Event', 'CustomEvent', 'Element', 'HTMLElement', 'HTMLInputElement', 'File', 'FileReader', 'MutationObserver', 'DOMParser'].map(name => [name, dom.window[name]])),
      });
      dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
      dom.window.Range.prototype.getClientRects = () => [];
      URL.createObjectURL = () => 'blob:synthetic-image';
      URL.revokeObjectURL = () => {};
      const copies = [];
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { userAgent: dom.window.navigator.userAgent, platform: 'MacIntel', language: 'en-GB', languages: ['en-GB'], clipboard: { writeText: async text => copies.push(text) } },
      });
      const requests = [];
      const reports = [];
      const submissions = [];
      const snapshot = {
        id: crypto.randomUUID(),
        content: JSON.stringify({ messages: ['Synthetic redacted conversation'], trace: ['Synthetic tool result'] }, null, 2),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      globalThis.fetch = async (path, options) => {
        requests.push(path);
        if (path === '/api/feedback/context') return Response.json({
          enabled: true, appVersion: null, appRelease: 'synthetic-runtime-commit', appModified: true, source: 'local-web', development: true, computerName: null, platform: null,
        });
        if (path === '/api/feedback/report') return new Promise(resolve => reports.push({ resolve, signal: options.signal }));
        if (path === '/api/feedback') {
          const body = JSON.parse(options.body);
          submissions.push(body);
          return Response.json({ submissionId: body.submissionId, status: submissions.length === 1 ? 'unknown' : 'submitted' });
        }
        if (path.startsWith('/api/feedback/')) return Response.json({ submissionId: path.split('/').at(-1), status: 'submitted' });
        throw new Error('Unexpected fixture request: ' + path);
      };
      const { act, createElement, useState } = await import('react');
      const { createRoot } = await import('react-dom/client');
      const { FeedbackDialog } = await import('./src/web/components/feedback.tsx');
      const { saveFeedbackDraft } = await import('./src/web/lib/feedback-draft.ts');
      await saveFeedbackDraft('synthetic-owner', {
        category: 'bug', feedback: '1. ', includeReport: false, attachments: [], pendingId: null,
      });
      function Fixture() {
        const [open, setOpen] = useState(true);
        return createElement('div', null,
          createElement('button', { 'data-open': true, onClick: () => setOpen(true) }, 'Open fixture'),
          createElement(FeedbackDialog, { ownerId: 'synthetic-owner', open, onOpenChange: setOpen, returnFocus: () => document.querySelector('[data-open]') }),
        );
      }
      const root = createRoot(document.querySelector('#root'));
      const click = async label => {
        const button = [...document.querySelectorAll('button')].find(candidate => candidate.textContent === label);
        assert.ok(button, label);
        await act(async () => button.click());
        for (let attempt = 0; attempt < 100 && document.querySelector('.feedback-dialog[data-busy="true"]'); attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
      };
      const submitForm = async () => {
        await act(async () => document.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
        for (let attempt = 0; attempt < 100 && document.querySelector('.feedback-dialog[data-busy="true"]'); attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
      };
      const writeFeedback = async value => {
        await act(async () => {
          const editor = document.querySelector('.feedback-editor').editor;
          editor.commands.setContent(value, { contentType: 'markdown' });
          editor.commands.setTextSelection(editor.state.doc.content.size - 1);
        });
      };
      try {
        await act(async () => root.render(createElement(Fixture)));
        for (let attempt = 0; attempt < 100 && document.querySelector('.feedback-editor')?.getAttribute('contenteditable') !== 'true'; attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
        const restoredEditor = document.querySelector('.feedback-editor').editor;
        assert.equal(restoredEditor.isEmpty, true);
        assert.equal(restoredEditor.state.doc.firstChild.type.name, 'orderedList');
        assert.equal(document.querySelector('.feedback-form button[type="submit"]').disabled, true);
        await submitForm();
        assert.equal(submissions.length, 0);
        await writeFeedback('- Synthetic item');
        await act(async () => restoredEditor.commands.deleteRange({ from: 3, to: 17 }));
        assert.equal(restoredEditor.isEmpty, true);
        assert.equal(restoredEditor.state.doc.firstChild.type.name, 'bulletList');
        assert.equal(document.querySelector('.feedback-form button[type="submit"]').disabled, true);
        await act(async () => restoredEditor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
        assert.equal(submissions.length, 0);
        await act(async () => document.querySelector('.feedback-diagnostics input[type="checkbox"]').click());
        await click('Copy trace');
        assert.equal(reports.length, 1);
        assert.equal(submissions.length, 0);
        await writeFeedback('Synthetic **feedback**');
        const editor = document.querySelector('.feedback-editor').editor;
        for (const modifier of ['altKey', 'shiftKey']) {
          await act(async () => editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', [modifier]: true, bubbles: true, cancelable: true })));
          assert.equal(editor.state.doc.childCount, 1);
          assert.equal(editor.state.doc.firstChild.lastChild.type.name, 'hardBreak');
          assert.equal(submissions.length, 0);
          await writeFeedback('Synthetic **feedback**');
        }
        await act(async () => editor.view.dom.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
        assert.equal(editor.state.doc.childCount, 2);
        assert.equal(submissions.length, 0);
        await writeFeedback('Synthetic **feedback**');
        await act(async () => editor.commands.insertContent('x'.repeat(12_001)));
        assert.equal(editor.getMarkdown(), 'Synthetic **feedback**');
        assert.ok(document.querySelector('.feedback-length-error'));
        const bytes = Uint8Array.from([137,80,78,71,13,10,26,10]);
        const file = new File([bytes], 'synthetic-paste.png', { type: 'image/png' });
        const paste = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(paste, 'clipboardData', { value: {
          files: [file], items: [], getData: type => type === 'text/plain' ? 'Synthetic pasted text' : '',
        } });
        await act(async () => document.querySelector('.feedback-editor').dispatchEvent(paste));
        assert.equal(paste.defaultPrevented, true);
        assert.equal(editor.getMarkdown(), 'Synthetic **feedback**Synthetic pasted text');
        assert.equal(document.querySelector('.feedback-length-error'), null);
        const dropped = new File(['Synthetic log entry'], 'synthetic-drop.log');
        const details = new File(['{"status":"synthetic"}'], 'details.json', { type: 'application/json' });
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { files: [dropped, details], types: ['Files'] } });
        await act(async () => document.querySelector('.feedback-editor').dispatchEvent(drop));
        assert.equal(drop.defaultPrevented, true);
        assert.equal(reports.length, 1);
        await act(async () => reports[0].resolve(Response.json(snapshot)));
        assert.deepEqual(copies, [snapshot.content]);
        await click('Review');
        assert.equal(document.querySelector('pre[aria-label="Diagnostic report"]').textContent, copies[0]);
        await act(async () => document.querySelector('[aria-label="Close"]').click());
        await act(async () => document.querySelector('[data-open]').click());
        assert.equal(document.querySelector('.feedback-editor').editor.getMarkdown(), 'Synthetic **feedback**Synthetic pasted text');
        assert.equal(document.querySelectorAll('.feedback-thumbnail-item').length, 3);
        await submitForm();
        for (let attempt = 0; submissions.length < 1 && attempt < 50; attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0].reportId, snapshot.id);
        assert.equal(submissions[0].feedback, 'Synthetic **feedback**Synthetic pasted text');
        assert.deepEqual(submissions[0].attachments, [
          { name: 'synthetic-paste.png', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          { name: 'synthetic-drop.log', mimeType: 'text/plain', data: Buffer.from('Synthetic log entry').toString('base64') },
          { name: 'details.json', mimeType: 'application/json', data: Buffer.from('{"status":"synthetic"}').toString('base64') },
        ]);
        assert.equal(submissions[0].source, 'local-web');
        assert.equal(submissions[0].appVersion, null);
        assert.equal(submissions[0].appRelease, 'synthetic-runtime-commit');
        assert.equal(submissions[0].appModified, true);
        assert.equal(submissions[0].platform, 'MacIntel');
        assert.equal(document.querySelector('.feedback-editor').getAttribute('contenteditable'), 'false');
        const actualNow = Date.now;
        Date.now = () => actualNow() + 3_600_000;
        try {
          await click('Hide');
          await click('Review');
          assert.equal(reports.length, 1);
          assert.equal(document.querySelector('pre[aria-label="Diagnostic report"]').textContent, snapshot.content);
        } finally {
          Date.now = actualNow;
        }
        await click('Check submission status');
        assert.equal(document.querySelector('[role="dialog"]'), null);
        window.ottoDesktop = { getFeedbackContext: async () => ({
          computerName: 'Synthetic Device Name', appVersion: '1.2.3', appRelease: null, appModified: null,
          source: 'desktop', development: true, platform: 'darwin-arm64',
        }) };
        await act(async () => document.querySelector('[data-open]').click());
        await click('Copy trace');
        assert.equal(reports.length, 2);
        await act(async () => document.querySelector('[aria-label="Close"]').click());
        assert.equal(reports[1].signal.aborted, true);
        await act(async () => reports[1].resolve(Response.json({ ...snapshot, id: crypto.randomUUID(), content: 'Canceled synthetic trace' })));
        assert.deepEqual(copies, [snapshot.content]);
        await act(async () => document.querySelector('[data-open]').click());
        await click('Copy trace');
        assert.equal(reports.length, 3);
        await act(async () => reports[2].resolve(Response.json({ ...snapshot, id: crypto.randomUUID(), content: 'Fresh synthetic trace' })));
        assert.deepEqual(copies, [snapshot.content, 'Fresh synthetic trace']);
        assert.equal(submissions.length, 1);
        assert.equal(requests.includes('/api/conversation/bug-report'), false);
        await writeFeedback('Synthetic desktop feedback');
        assert.equal(reports.length, 3);
        assert.equal(document.body.textContent.includes('Synthetic Device Name'), false);
        await submitForm();
        assert.equal(submissions.length, 2);
        assert.equal(submissions[1].computerName, 'Synthetic Device Name');
        assert.equal(submissions[1].source, 'desktop');
        assert.equal(submissions[1].appVersion, '1.2.3');
        assert.equal(submissions[1].appRelease, 'synthetic-runtime-commit');
        assert.equal(submissions[1].appModified, true);
        assert.equal(submissions[1].platform, 'darwin-arm64');
        for (const [category, label] of [['feature', 'Idea'], ['other', 'Other']]) {
          await act(async () => document.querySelector('[data-open]').click());
          await click(label);
          const reportIndex = reports.length;
          await writeFeedback('Synthetic context for ' + category);
          assert.equal(reports.length, reportIndex + 1);
          const categorySnapshot = { ...snapshot, id: crypto.randomUUID() };
          await act(async () => reports[reportIndex].resolve(Response.json(categorySnapshot)));
          await submitForm();
          assert.equal(submissions.at(-1).category, category);
          assert.equal(submissions.at(-1).reportId, categorySnapshot.id);
          assert.equal(document.querySelector('[role="dialog"]'), null);
        }
        await act(async () => document.querySelector('[data-open]').click());
        await act(async () => document.querySelector('input[type="checkbox"]').click());
        await click('Idea');
        await click('Other');
        const reportCount = reports.length;
        await writeFeedback('Synthetic feedback with diagnostics excluded');
        const beforeKeyboardSend = submissions.length;
        await act(async () => document.querySelector('.feedback-editor').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })));
        for (let attempt = 0; document.querySelector('.feedback-dialog[data-busy="true"]') && attempt < 100; attempt++)
          await act(async () => new Promise(resolve => setTimeout(resolve, 5)));
        assert.equal(submissions.length, beforeKeyboardSend + 1);
        assert.equal(reports.length, reportCount);
        assert.equal(submissions.at(-1).category, 'other');
        assert.equal(submissions.at(-1).reportId, null);
      } finally {
        await act(async () => root.unmount());
        dom.window.close();
      }
      process.exit(0);
    `,
  });
  assert.equal(result.exitCode, 0, result.stderr);
});
