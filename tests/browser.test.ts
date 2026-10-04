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
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  Agent,
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
import { SetupNotice } from '../src/web/components/setup-notice.tsx';
import { Chat } from '../src/web/pages/chat.tsx';
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
  async () => {
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
    let onCapture: (() => Promise<void>) | undefined;
    const captures: string[] = [];
    const controls: unknown[] = [];
    const app = await createApp({
      configuration: () => configuration({ inspectorEnabled }),
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
      const click = { type: 'click', x: 0.5, y: 0.25 };
      const handoff = async (input: unknown = click) => [
        (await request('/api/browser-handoff/screen')).statusCode,
        (
          await app.inject({
            method: 'POST',
            url: '/api/browser-handoff',
            payload: input as object,
            headers: { host: `localhost:${port}` },
          })
        ).statusCode,
      ];
      assert.deepEqual(await handoff(), [423, 423]);
      await db.pool.query(
        "UPDATE turns SET status='waiting',waiting_reason='credentials' WHERE id=$1",
        [nextTurnId],
      );
      assert.deepEqual(await handoff(), [423, 423]);
      await db.pool.query("UPDATE turns SET waiting_reason='question' WHERE id=$1", [nextTurnId]);
      assert.deepEqual(await handoff(), [200, 200]);
      assert.deepEqual(controls, [[next.id, click]]);
      assert.deepEqual(await handoff({ type: 'click', x: 2, y: 0 }), [200, 400]);
      const check = randomUUID();
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status,background) VALUES($1,$2,$3,'event','Check','running',true)",
        [check, ownerId, next.id],
      );
      assert.deepEqual(await handoff(), [423, 423]);
      await db.pool.query("UPDATE turns SET status='succeeded' WHERE id=$1", [check]);
      assert.deepEqual(await handoff(), [200, 200]);
      assert.equal(controls.length, 2);
      await db.pool.query(
        "INSERT INTO turns(id,owner_id,thread_id,source,prompt,status) VALUES($1,$2,$3,'user','Done','queued')",
        [randomUUID(), ownerId, next.id],
      );
      assert.deepEqual(await handoff(), [423, 423]);
      assert.equal(controls.length, 2);
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
    act: async () => ({ text: 'Synthetic page', url: 'https://example.test/', candidates: [] }),
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
    return { text: 'Finished', url: 'https://example.test/', candidates: [] };
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
        phase === 'screenshot' ? ['url', phase] : [phase],
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
      candidates: [],
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
    return { text: 'Late', url: 'https://example.com', candidates: [] };
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
    await assert.rejects(
      computer.act('login', { action: 'fill', selector: '#account', text: 'not-through-chat' }),
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

test('the user can click, type and scroll in the handed-off browser at page coordinates', async () => {
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
    await computer.control!('fixture', { type: 'click', x: 0.5, y: 0.25 });
    await computer.control!('fixture', { type: 'type', text: 'ab' });
    await computer.control!('fixture', { type: 'key', key: 'Enter' });
    await computer.control!('fixture', { type: 'scroll', deltaY: 300 });
    assert.deepEqual(
      commands
        .filter((command) => !['url', 'evaluate'].includes(String(command.action)))
        .map(({ id: _id, plugins: _plugins, ...command }) => command),
      [
        { action: 'mousemove', x: 512, y: 192 },
        { action: 'mousedown', button: 'left' },
        { action: 'mouseup', button: 'left' },
        { action: 'keyboard', subaction: 'type', text: 'ab' },
        { action: 'press', key: 'Enter' },
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
  'native container browser stays responsive after output exceeds stderr pipe capacity',
  {
    skip: process.env.OTTO_TEST_NATIVE_DOWNLOAD !== 'true' || process.platform !== 'linux',
    timeout: 30_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-stderr-native-'));
    const server = createHttpServer((_request, response) => {
      response.setHeader('content-type', 'text/html');
      response.end('<button onclick="this.textContent=\'Accepted\'">Continue</button>');
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
      await computer.control!('fixture', { type: 'click', x: 0.03, y: 0.035 });
      const page = await computer.act('fixture', { action: 'snapshot' });
      assert.match(page.text, /Accepted/);
      const screenshot = await computer.screenshot('fixture');
      assert.ok(screenshot?.length);
      assert.equal(computer.screenStatus!('fixture').state, 'live');
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
    await computer.control!('fixture', { type: 'type', text: 'Sign' });
    await computer.control!('fixture', { type: 'type', text: secret.slice(4) });
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
    await computer.control!('fixture', { type: 'type', text: `${secret}2` });
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
  const redact = createInspectorRedactor([secret]);
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

function handoffScreen(state = 'live', text = 'Synthetic screen') {
  return new Response(text, {
    headers: { 'Content-Type': 'image/png', 'X-Screen-State': state },
  });
}

async function handoffView(
  request: (path: string, options?: RequestInit) => Promise<Response>,
  content?: React.ReactNode,
) {
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost',
    pretendToBeVisual: true,
  });
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
    fetch: (input: string | URL | Request, options?: RequestInit) =>
      request(String(input), options),
  };
  const previous = new Map(
    Object.keys(replacements).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  Object.assign(globalThis, replacements);
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const createUrl = URL.createObjectURL;
  const revokeUrl = URL.revokeObjectURL;
  const images = new Map<string, Blob>();
  let serial = 0;
  URL.createObjectURL = (blob) => {
    assert.ok(blob instanceof Blob);
    const url = `blob:handoff-${++serial}`;
    images.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = (url) => images.delete(url);
  let poll: () => void = () => {};
  dom.window.setInterval = (handler) => {
    assert.equal(typeof handler, 'function');
    poll = handler as () => void;
    return 1;
  };
  dom.window.clearInterval = () => {
    poll = () => {};
  };
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
  return {
    dom,
    images,
    element,
    completions: () => completions,
    async poll() {
      await act(async () => poll());
    },
    async render(next: React.ReactNode) {
      await act(async () => root.render(next));
    },
    async clickImage() {
      const image = element<HTMLImageElement>('img');
      image.getBoundingClientRect = () =>
        ({ left: 10, top: 20, width: 200, height: 100 }) as DOMRect;
      await act(async () => {
        image.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true, clientX: 110, clientY: 70 }),
        );
      });
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
      URL.createObjectURL = createUrl;
      URL.revokeObjectURL = revokeUrl;
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
    threadStatus: 'idle',
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

test('missing-key setup opens native Providers and can retry a rejected settings request', async () => {
  const requests: string[] = [];
  const view = await handoffView(async () => {
    throw new Error('Unexpected setup network request.');
  }, createElement('div'));
  Object.assign(view.dom.window, {
    ottoDesktop: {
      openSettings: async (section: string) => {
        requests.push(section);
        if (requests.length === 1) throw new Error('Synthetic settings rejection.');
      },
    },
  });
  const notice = (integrationsReady: boolean) =>
    createElement(SetupNotice, {
      configuration: { ...requestedChatState().configuration, integrationsReady },
      capability: 'apps',
    });
  try {
    await view.render(notice(false));
    await act(async () => view.element<HTMLButtonElement>('button').click());
    assert.deepEqual(requests, ['providers']);
    assert.ok(view.element('[role="alert"]'));
    await act(async () => view.element<HTMLButtonElement>('button').click());
    assert.deepEqual(requests, ['providers', 'providers']);
    assert.equal(view.dom.window.document.querySelector('[role="alert"]'), null);
    await view.render(notice(true));
    assert.equal(view.dom.window.document.querySelector('button'), null);
    assert.deepEqual(requests, ['providers', 'providers']);
  } finally {
    await view.close();
  }
});

test('chat request submits once under StrictMode and keeps the pending message visible', async () => {
  const state = requestedChatState();
  const pending = deferred<Response>();
  const submissions: Array<{ clientMessageId: string; text: string }> = [];
  const handled: string[] = [];
  const request = { id: randomUUID(), text: 'Create a synthetic goal.' };
  const chat = () =>
    createElement(
      StrictMode,
      null,
      createElement(Chat, {
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
  const request = { id: randomUUID(), text: 'Create a synthetic goal.' };
  const chat = (llmReady: boolean) =>
    createElement(Chat, {
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
    { id: randomUUID(), text: 'Create a synthetic goal.' },
    { id: randomUUID(), text: 'Schedule a synthetic reminder.' },
  ];
  const chat = (requestedMessage: (typeof requests)[number]) =>
    createElement(Chat, {
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
    { id: randomUUID(), text: 'Create a synthetic goal.' },
    { id: randomUUID(), text: 'Schedule a synthetic reminder.' },
  ];
  const submissions: Array<{ text: string }> = [];
  const chat = (requestedMessage?: (typeof requests)[number]) =>
    createElement(Chat, {
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
  const request = { id: randomUUID(), text: 'Create a synthetic goal.' };
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

for (const failure of ['rejected', 'disconnected'] as const)
  test(`chat preserves a ${failure} browser continuation until an acknowledged retry`, async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const submissions: Array<{ clientMessageId: string; threadId: string }> = [];
    let controls = 0;
    const state: AppState = {
      threadId: randomUUID(),
      threadStatus: 'idle',
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
        if (path === '/api/browser-handoff/screen') return handoffScreen();
        if (path === '/api/browser-handoff') {
          controls++;
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
        state,
        streams: {},
        refresh: async () => {},
        resetConversation: async () => state.threadId,
      }),
    );
    try {
      const original = view.element('.browser-handoff');
      await view.clickImage();
      await act(async () => delay(350));
      await view.button('Done');
      assert.equal(submissions.length, 1);
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(view.element<HTMLButtonElement>('.browser-handoff-bar button').disabled, true);
      assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 1);
      await view.clickImage();
      await view.poll();
      assert.equal(submissions.length, 1);
      assert.equal(controls, 1);
      await act(async () =>
        first.resolve(Response.json({ error: 'Synthetic request rejected' }, { status: 503 })),
      );
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(view.element<HTMLButtonElement>('.browser-handoff-bar button').disabled, false);
      assert.equal(view.dom.window.document.querySelectorAll('.message-user').length, 0);
      const failureStatus = view.element('.browser-handoff [role="status"]').textContent;
      await view.poll();
      assert.equal(view.element('.browser-handoff [role="status"]').textContent, failureStatus);
      await view.button('Done');
      assert.equal(submissions.length, 2);
      assert.equal(submissions[1].clientMessageId, submissions[0].clientMessageId);
      assert.equal(view.element('.browser-handoff'), original);
      assert.equal(controls, 1);
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
      assert.equal(controls, 1);
    } finally {
      first.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
      second.resolve(Response.json({ error: 'Synthetic rejected request' }, { status: 503 }));
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
    threadStatus: 'idle',
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

for (const failure of ['rejected', 'disconnected'] as const)
  test(`browser handoff preserves a ${failure} input failure through Done and polling without replay`, async () => {
    const input = deferred<Response>();
    let inputs = 0;
    const view = await handoffView(async (_path, options) => {
      if (options?.method !== 'POST') return handoffScreen();
      inputs++;
      const response = await input.promise;
      if (failure === 'disconnected') throw new Error('Synthetic connection lost');
      return response;
    });
    try {
      await view.clickImage();
      await view.button('Done');
      assert.ok(view.element('.browser-handoff'));
      assert.equal(view.completions(), 0);
      assert.equal(view.element<HTMLButtonElement>('button').disabled, true);
      await act(async () => {
        input.resolve(
          new Response(JSON.stringify({ error: 'Synthetic input rejected' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      });
      await view.poll();
      assert.equal(view.completions(), 0);
      assert.match(view.element('[role="status"]').textContent!, /Refresh the view/);
      await view.clickImage();
      assert.equal(inputs, 1);
      await view.button('Refresh view');
      await view.button('Done');
      assert.equal(inputs, 1);
      assert.equal(view.completions(), 1);
      assert.equal(view.dom.window.document.querySelector('.browser-handoff'), null);
    } finally {
      await view.close();
    }
  });

test('browser handoff prevents input on saved frames and recovers an observation failure without replay', async () => {
  let state = 'last_known';
  let failScreen = false;
  let inputs = 0;
  const view = await handoffView(async (_path, options) => {
    if (options?.method === 'POST') {
      inputs++;
      failScreen = true;
      return Response.json({ ok: true });
    }
    return failScreen
      ? Response.json({ error: 'Synthetic capture failed' }, { status: 500 })
      : handoffScreen(state);
  });
  try {
    await view.clickImage();
    await view.button('Done');
    assert.equal(inputs, 0);
    assert.equal(view.completions(), 0);
    assert.equal(view.element('[role="application"]').getAttribute('aria-disabled'), 'true');
    state = 'live';
    await view.poll();
    await view.clickImage();
    await act(async () => delay(350));
    assert.equal(inputs, 1);
    assert.match(view.element('[role="status"]').textContent!, /capture failed/);
    await view.clickImage();
    assert.equal(inputs, 1);
    failScreen = false;
    await view.poll();
    await view.button('Done');
    assert.equal(view.completions(), 1);
    assert.equal(inputs, 1);
  } finally {
    await view.close();
  }
});

test('browser handoff cancels queued controls when the preceding view cannot be observed', async () => {
  const first = deferred<Response>();
  const inputs: unknown[] = [];
  let failScreen = false;
  const view = await handoffView(async (_path, options) => {
    if (options?.method === 'POST') {
      inputs.push(JSON.parse(String(options.body)));
      failScreen = true;
      return first.promise;
    }
    return failScreen
      ? Response.json({ error: 'Synthetic capture failed' }, { status: 500 })
      : handoffScreen();
  });
  try {
    await view.clickImage();
    await view.clickImage();
    await view.button('Done');
    await act(async () => {
      first.resolve(Response.json({ ok: true }));
      await delay(350);
    });
    assert.equal(inputs.length, 1);
    assert.equal(view.completions(), 0);
    assert.match(view.element('[role="status"]').textContent!, /pending action was not sent/);
    failScreen = false;
    await view.poll();
    await view.button('Done');
    assert.equal(view.completions(), 0);
    await view.button('Refresh view');
    assert.equal(inputs.length, 1);
    await view.button('Done');
    assert.equal(view.completions(), 1);
  } finally {
    await view.close();
  }
});
