import assert from 'node:assert/strict';
import type {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer, type Socket } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import pg from 'pg';
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
} from '../src/providers/agent-browser/index.ts';
import {
  loginInspectionSchema,
  loginInspectionScript,
  loginReferenceScript,
  loginReferencesStableScript,
} from '../src/providers/agent-browser/login.ts';
import {
  credentialFields,
  credentialEntryScript,
} from '../src/providers/agent-browser/credentials.ts';
import { maskPageScript } from '../src/providers/agent-browser/redaction.ts';
import { existingDaemonCommand } from '../src/providers/agent-browser/screens.ts';
import { runProcess } from '../src/providers/process.ts';
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
import { createInspectorRedactor } from '../src/server/inspector-redaction.ts';
import type { CredentialInjection } from '../src/server/vault.ts';
import { createBrowserFixture } from './browser-fixture.ts';
import { stagedLoginBrowser } from './login-fixture.ts';
import { fakeComputer, fakeWorkspace } from './runtime-fixtures.ts';

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
    inspectLogin: async () => ({
      origin: 'https://example.test',
      url: 'https://example.test/',
      fields: [],
      methods: [],
    }),
    hold: async () => {},
    close: async () => {},
    dispose: async () => {},
    status: () => 'Synthetic browser',
    canCheckpoint: () => true,
  };
}

async function workerFixture(createComputer: () => Computer | Promise<Computer>) {
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
      socket.setTimeout(5000, () => socket.destroy(new Error('Synthetic request timed out.')));
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
    const selector = (await f.computer.inspectLogin('task')).fields[0].selector;
    f.before(async (command) => {
      if (command[0] === 'eval') {
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
  await new Promise<void>((resolve) =>
    server.listen(join(directory, `${browserSessionId('fixture')}.sock`), resolve),
  );
  const computer = createAgentBrowserComputer({
    dataRoot: directory,
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

test('failed private entry clears its actual writes even when the response is lost', async () => {
  for (const behavior of ['lost', 'replacement', 'delayed']) {
    const f = await transportFixture();
    const release = deferred();
    const executed = deferred();
    let entries = 0;
    const followups: string[] = [];
    try {
      await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const field = (await f.computer.inspectLogin('fixture')).fields[0];
      const original = f.page().input;
      const replacement = original.cloneNode() as HTMLInputElement;
      replacement.value = 'replacement-user-value';
      const state = { input: '', change: '' };
      original.addEventListener('input', () => {
        state.input = original.value;
      });
      original.addEventListener('change', () => {
        state.change = original.value;
      });
      const isEntry = (command: Record<string, unknown>) =>
        command.action === 'evaluate' && String(command.script).includes('const origin=');
      f.before(async (_action, command) => {
        if (isEntry(command)) {
          entries++;
          if (behavior === 'delayed') await release.promise;
        } else if (entries && command.action === 'evaluate') {
          followups.push(String(command.script));
        }
      });
      f.after(async (_action, command, socket) => {
        if (!isEntry(command)) return;
        if (behavior === 'replacement') original.replaceWith(replacement);
        socket.destroy();
        executed.resolve();
      });
      await assert.rejects(
        f.computer.injectCredentials({
          threadId: 'fixture',
          origin: 'https://1.1.1.1',
          kind: 'identifier',
          username: 'synthetic-lost-response',
          usernameSelector: field.selector,
        }),
        /Secure entry could not be confirmed/,
      );
      release.resolve();
      await executed.promise;
      assert.equal(original.value, '', behavior);
      assert.deepEqual(state, { input: '', change: '' }, behavior);
      assert.equal(replacement.value, 'replacement-user-value', behavior);
      assert.equal(f.page().search.value, '', behavior);
      assert.equal(entries, 1, behavior);
      assert.ok(followups.length, behavior);
      assert.equal(
        followups.some((script) => script.includes('synthetic-lost-response')),
        false,
      );
    } finally {
      release.resolve();
      await f.cleanup();
    }
  }
});

test('confirmed private entry stays successful when finalization loses its response', async () => {
  const f = await transportFixture();
  let entered = false;
  let followups = 0;
  try {
    await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const field = (await f.computer.inspectLogin('fixture')).fields[0];
    f.after(async (action, command, socket) => {
      if (action !== 'evaluate') return;
      if (String(command.script).includes('const origin=')) entered = true;
      else if (entered) {
        followups++;
        assert.equal(String(command.script).includes('synthetic-confirmed'), false);
        socket.destroy();
      }
    });
    assert.deepEqual(
      await f.computer.injectCredentials({
        threadId: 'fixture',
        origin: 'https://1.1.1.1',
        kind: 'identifier',
        username: 'synthetic-confirmed',
        usernameSelector: field.selector,
      }),
      { status: 'submitted' },
    );
    assert.equal(f.page().input.value, 'synthetic-confirmed');
    assert.equal(followups, 1);
  } finally {
    await f.cleanup();
  }
});

test('unacknowledged credential cleanup fences later actions until browser close succeeds', async () => {
  for (const delayedEntry of [false, true]) {
    const f = await transportFixture();
    const releaseEntry = deferred();
    const releaseCleanup = deferred();
    const cleanupFinished = deferred();
    const entryFinished = deferred();
    let entered = false;
    const isEntry = (command: Record<string, unknown>) =>
      command.action === 'evaluate' && String(command.script).includes('const origin=');
    try {
      await f.computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
      const field = (await f.computer.inspectLogin('fixture')).fields[0];
      const input = {
        threadId: 'fixture',
        origin: 'https://1.1.1.1',
        kind: 'identifier' as const,
        username: 'synthetic-delayed-entry',
        usernameSelector: field.selector,
      };
      f.before(async (action, command) => {
        if (isEntry(command)) {
          entered = true;
          if (delayedEntry) await releaseEntry.promise;
        } else if (entered && action === 'evaluate') await releaseCleanup.promise;
      });
      f.after(async (action, command, socket) => {
        if (isEntry(command)) {
          socket.destroy();
          entryFinished.resolve();
        } else if (entered && action === 'evaluate') cleanupFinished.resolve();
      });
      f.fail('close');
      await assert.rejects(
        f.computer.injectCredentials(input),
        /Secure entry could not be confirmed/,
      );
      const count = f.actions.length;
      assert.equal(f.actions.filter((action) => action === 'close').length, 1);
      await assert.rejects(f.computer.injectCredentials(input), /expired/);
      await assert.rejects(f.computer.act('fixture', { action: 'snapshot' }), /expired/);
      assert.equal(f.actions.length, count);
      releaseCleanup.resolve();
      await cleanupFinished.promise;
      releaseEntry.resolve();
      await entryFinished.promise;
      assert.equal(f.page().input.value, '');
      f.before(async () => {});
      f.after(async () => {});
      f.fail();
      await f.computer.close('fixture');
      assert.equal(f.actions.filter((action) => action === 'close').length, 2);
    } finally {
      releaseCleanup.resolve();
      releaseEntry.resolve();
      await f.cleanup();
    }
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
    assert.equal(f.actions.slice(before).filter((action) => action === 'close').length, 1);
    assert.deepEqual(f.launches, ['open', 'info']);
  } finally {
    releaseSnapshot.resolve();
    releaseClose.resolve();
    await f.cleanup();
  }
});

test('failed interruption cleanup blocks later actions until an explicit close succeeds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-browser-drain-failure-'));
  const fixture = stagedLoginBrowser();
  const commands: string[] = [];
  let failClose = true;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const action = args[args.indexOf('--idle-timeout') + 2];
      commands.push(action);
      if (action === 'open' && failClose)
        throw new Error('Runtime command exceeded its time limit.');
      if (action === 'close' && failClose) throw new Error('Synthetic close unavailable.');
      return fixture.run(executable, args, options);
    },
  });
  try {
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /could not stop safely/,
    );
    const count = commands.length;
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }), /expired/);
    await assert.rejects(
      computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' }),
      /expired/,
    );
    assert.equal(commands.length, count);
    failClose = false;
    await computer.close('fixture');
    const reopened = await computer.act('fixture', {
      action: 'open',
      url: 'https://1.1.1.1/login',
    });
    assert.equal(reopened.url, 'https://1.1.1.1/login');
  } finally {
    failClose = false;
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

type Execute = (id: string, input: BrowserAction) => Promise<AgentToolResult>;

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
      assert.doesNotMatch(JSON.stringify(f.observations), /Private unknown|Private forged/);
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
    inspectLogin: async (_id, target) => {
      calls.push({ method: 'inspectLogin', input: target });
      return {
        origin: 'https://example.com',
        url: 'https://example.com/login',
        fields: [],
        methods: [],
      };
    },
    hold: async () => {},
    close: async () => {
      calls.push({ method: 'close' });
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

async function harness(control: { beforeFirstBridge?: Promise<void> } = {}) {
  const root = await mkdtemp('/tmp/sk-browser-');
  const socketPath = join(root, 'control.sock');
  const instances = new Map<string, ReturnType<typeof workerComputer>>();
  const worker = await startContainerBrowserWorker({
    socketPath,
    dataRoot: root,
    createComputer: async (path) => {
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
    const target = {
      origin: 'https://example.com',
      kind: 'otp' as const,
      passwordSelector: '@e7',
      emailCode: true,
    };
    await computer.inspectLogin('task', target);
    assert.deepEqual(
      fixture.instance(dataRoot).calls.filter((call) => call.method === 'inspectLogin'),
      [{ method: 'inspectLogin', input: target }],
    );
    const withSecret = { ...target, username: 'private-inspection-value' };
    await assert.rejects(computer.inspectLogin('task', withSecret));
    assert.equal(
      fixture.instance(dataRoot).calls.filter((call) => call.method === 'inspectLogin').length,
      1,
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

test('an unacknowledged cancellation fences new actions until namespace cleanup succeeds', async () => {
  const fixture = await harness();
  const drain = deferred();
  try {
    const computer = fixture.client('/synthetic/timeout', { drainTimeoutMs: 20 });
    await computer.act('task', { action: 'snapshot' });
    const entered = deferred();
    fixture.instance('/synthetic/timeout').setAct(async () => {
      entered.resolve();
      await drain.promise;
      return { text: 'Late', url: 'https://example.com', candidates: [] };
    });
    const controller = new AbortController();
    const cancelled = assert.rejects(
      computer.act('task', { action: 'snapshot' }, controller.signal),
      /did not finish safely/,
    );
    await entered.promise;
    controller.abort();
    await cancelled;
    await assert.rejects(computer.act('task', { action: 'snapshot' }), /unavailable/);
    assert.match(computer.status(), /needs a restart/);
    drain.resolve();
    await computer.dispose();
  } finally {
    drain.resolve();
    await fixture.close();
  }
});

// Login inspection and observation redaction

test('selected unfamiliar fields bind their actual nodes independently of labels and extra fields', () => {
  const dom = new JSDOM(
    '<form><label>アクセス番号<input id="account" autocomplete="one-time-code" readonly></label><label>秘密<input id="secret" type="password"></label><input type="password"><input type="email"><input id="code" maxlength="6" aria-label="Συνθηματικό"></form>',
    { url: 'https://identity.example.test/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
  try {
    const account = dom.window.document.querySelector<HTMLInputElement>('#account')!;
    const secret = dom.window.document.querySelector<HTMLInputElement>('#secret')!;
    account.addEventListener('focus', () => {
      account.readOnly = false;
    });
    const inspection = loginInspectionSchema.parse(
      dom.window.eval(
        loginInspectionScript({
          origin: dom.window.location.origin,
          kind: 'password',
          usernameSelector: '#account',
          passwordSelector: '#secret',
        }),
      ),
    );
    assert.deepEqual(
      inspection.fields.map((field) => field.kind),
      ['identifier', 'password'],
    );
    assert.equal(dom.window.document.querySelector(inspection.fields[0].selector), account);
    assert.equal(dom.window.document.querySelector(inspection.fields[1].selector), secret);
    assert.equal(account.readOnly, true);
    const fields = credentialFields({
      threadId: 'fixture',
      origin: dom.window.location.origin,
      kind: 'password',
      username: 'synthetic-account',
      password: 'synthetic-password',
      usernameSelector: inspection.fields[0].selector,
      passwordSelector: inspection.fields[1].selector,
    });
    assert.equal(
      (
        dom.window.eval(
          credentialEntryScript(dom.window.location.origin, fields, 'fixture-attempt'),
        ) as {
          ok: boolean;
        }
      ).ok,
      true,
    );
    assert.equal(account.readOnly, false);
    secret.replaceWith(secret.cloneNode());
    const stale = loginInspectionSchema.parse(
      dom.window.eval(
        loginInspectionScript({
          origin: dom.window.location.origin,
          kind: 'password',
          usernameSelector: inspection.fields[0].selector,
          passwordSelector: inspection.fields[1].selector,
        }),
      ),
    );
    assert.deepEqual(stale.fields, []);
    const otp = loginInspectionSchema.parse(
      dom.window.eval(
        loginInspectionScript({
          origin: dom.window.location.origin,
          kind: 'otp',
          passwordSelector: '#code',
        }),
      ),
    );
    assert.equal(otp.fields.length, 1);
    assert.equal(otp.fields[0].kind, 'otp');
  } finally {
    dom.window.close();
  }
});

test('snapshot field references tolerate unrelated animation and reject relevant page changes', () => {
  for (const mutation of [
    'spinner-style',
    'spinner-aria',
    'field',
    'ancestor',
    'label',
    'aria-source',
    'aria-text',
    'hidden-field',
    'structure',
  ]) {
    const dom = new JSDOM(
      '<form><label for="account">Account <span id="label-text">number</span></label><input id="account" aria-labelledby="name" aria-describedby="detail"><input id="hidden" hidden><span id="name">Account name</span><span id="detail">Use your saved account</span></form><span id="spinner">Loading</span>',
      { url: 'https://example.test/login', runScripts: 'outside-only' },
    );
    dom.window.HTMLElement.prototype.getClientRects = () => [{}] as unknown as DOMRectList;
    try {
      const document = dom.window.document;
      dom.window.eval(loginReferenceScript('snapshot'));
      if (mutation === 'spinner-style')
        document.querySelector<HTMLElement>('#spinner')!.style.opacity = '0.5';
      if (mutation === 'spinner-aria')
        document.querySelector('#spinner')!.setAttribute('aria-busy', 'true');
      if (mutation === 'field')
        document.querySelector('#account')!.setAttribute('aria-label', 'Changed');
      if (mutation === 'ancestor') document.querySelector('form')!.setAttribute('hidden', '');
      if (mutation === 'label')
        document.querySelector('#label-text')!.setAttribute('class', 'changed');
      if (mutation === 'aria-source') document.querySelector('#name')!.setAttribute('hidden', '');
      if (mutation === 'aria-text')
        document.querySelector('#detail')!.firstChild!.nodeValue = 'Changed';
      if (mutation === 'hidden-field') document.querySelector('#hidden')!.removeAttribute('hidden');
      if (mutation === 'structure')
        document.querySelector('#spinner')!.append(document.createElement('span'));
      assert.equal(
        dom.window.eval(loginReferencesStableScript),
        mutation === 'spinner-style' || mutation === 'spinner-aria',
        mutation,
      );
    } finally {
      dom.window.close();
    }
  }
});

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
    const first = await computer.inspectLogin('login');
    assert.deepEqual(
      first.fields.map((field) => field.kind),
      ['identifier'],
    );
    await assert.rejects(
      computer.act('login', {
        action: 'fill',
        selector: first.fields[0].selector,
        text: 'not-through-chat',
      }),
      /secure credential/,
    );
    const identifier = computer.injectCredentials({
      threadId: 'login',
      origin: first.origin,
      kind: 'identifier',
      username: 'synthetic-account@example.test',
      usernameSelector: first.fields[0].selector,
    });
    await assert.rejects(computer.screenshot('login'), /paused/);
    await identifier;
    await computer.act('login', { action: 'click', selector: 'button' });
    const password = await computer.inspectLogin('login');
    assert.deepEqual(
      password.fields.map((field) => field.kind),
      ['password'],
    );
    await computer.injectCredentials({
      threadId: 'login',
      origin: password.origin,
      kind: 'password',
      password: 'synthetic-password',
      passwordSelector: password.fields[0].selector,
    });
    await computer.act('login', { action: 'click', selector: 'button' });
    const challenge = fixture.pages.get('login')?.input;
    assert.ok(challenge);
    assert.equal(fixture.pages.get('login')?.stage, 'otp');
    const otp = await computer.inspectLogin('login');
    assert.deepEqual(
      otp.fields.map((field) => field.kind),
      ['otp'],
    );
    await computer.injectCredentials({
      threadId: 'login',
      origin: otp.origin,
      kind: 'otp',
      code: '739204',
      passwordSelector: otp.fields[0].selector,
    });
    await computer.act('login', { action: 'click', selector: 'button' });
    assert.equal(fixture.pages.get('login')?.stage, 'complete');
    const observation = await computer.act('login', { action: 'snapshot' });
    const screen = await computer.screenshot('login');
    for (const secret of ['synthetic-account@example.test', 'synthetic-password', '739204']) {
      assert.equal(JSON.stringify(observation).includes(secret), false);
      assert.equal(screen?.includes(Buffer.from(secret)), false);
    }
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('browser references bind selected nodes and reject later replacement without native fallback', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-ref-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('login', { action: 'open', url: 'https://1.1.1.1/login' });
    const page = fixture.pages.get('login')!;
    const ref = [...page.refs].find(([, node]) => node === page.input)![0];
    const chosen = await computer.inspectLogin('login', {
      origin: page.location.origin,
      kind: 'identifier',
      usernameSelector: ref,
    });
    const original = page.input;
    const replacement = original.cloneNode() as HTMLInputElement;
    replacement.value = 'unrelated-user-value';
    original.replaceWith(replacement);
    page.refs.set(ref, replacement);
    for (const selector of [ref, chosen.fields[0].selector]) {
      await assert.rejects(
        computer.injectCredentials({
          threadId: 'login',
          origin: page.location.origin,
          kind: 'identifier',
          username: 'synthetic-account',
          usernameSelector: selector,
        }),
        /Secure entry could not be confirmed/,
      );
      assert.equal(replacement.value, 'unrelated-user-value');
      assert.equal(original.value, '');
    }
    await computer.act('login', { action: 'snapshot' });
    const fresh = [...page.refs].find(([, node]) => node === replacement)![0];
    await computer.injectCredentials({
      threadId: 'login',
      origin: page.location.origin,
      kind: 'identifier',
      username: 'synthetic-account',
      usernameSelector: fresh,
    });
    assert.equal(replacement.value, 'synthetic-account');
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('profile origin remains authoritative when the page navigates after its initial check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-profile-origin-'));
  const fixture = stagedLoginBrowser();
  const profileId = randomUUID();
  let race = false;
  let foreignReads = 0;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (executable, args, options) => {
      const result = await fixture.run(executable, args, options);
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      if (race && command[0] === 'get' && command[1] === 'url') {
        race = false;
        const page = fixture.pages.get(profileId)!;
        page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
      }
      return result;
    },
  });
  try {
    await computer.bindProfile!('fixture', profileId, 'https://1.1.1.1');
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const page = fixture.pages.get(profileId)!;
    Object.defineProperty(page.input, 'value', {
      get: () => {
        if (page.location.origin === 'https://8.8.8.8') foreignReads++;
        return 'synthetic-foreign-value';
      },
    });
    for (const action of ['snapshot', 'screenshot'] as const) {
      page.location = { origin: 'https://1.1.1.1', href: 'https://1.1.1.1/login' };
      race = true;
      await assert.rejects(
        action === 'snapshot'
          ? computer.act('fixture', { action })
          : computer.screenshot('fixture'),
        (error) => error instanceof BrowserActionError && error.code === 'browser_origin_changed',
      );
      assert.equal(foreignReads, 0);
    }
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('origin changes never send fresh or previous credentials through page masking', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-origin-'));
  const fixture = stagedLoginBrowser();
  const secret = 'synthetic-origin-secret';
  let exposed = 0;
  let race = false;
  let foreignReads = 0;
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: fixture.run,
    onDaemonCommand: (command) => {
      if (
        fixture.pages.get('fixture')?.location.origin === 'https://8.8.8.8' &&
        JSON.stringify(command).includes(secret)
      )
        exposed++;
      if (
        race &&
        command.action === 'evaluate' &&
        String(command.script).includes('const selectors=')
      ) {
        race = false;
        const page = fixture.pages.get('fixture')!;
        page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
        Object.defineProperty(page.input, 'value', {
          get: () => {
            foreignReads++;
            return '';
          },
        });
      }
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const inspection = await computer.inspectLogin('fixture');
    const page = fixture.pages.get('fixture')!;
    const input = {
      threadId: 'fixture',
      origin: inspection.origin,
      kind: 'identifier' as const,
      username: secret,
      usernameSelector: inspection.fields[0].selector,
    };
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await assert.rejects(computer.injectCredentials(input), /Secure entry could not be confirmed/);
    assert.equal(exposed, 0);
    assert.equal(page.input.value, '');
    page.location = { origin: inspection.origin, href: inspection.url };
    await computer.injectCredentials(input);
    page.render();
    page.location = { origin: 'https://8.8.8.8', href: 'https://8.8.8.8/login' };
    await computer.act('fixture', { action: 'snapshot' });
    assert.equal(exposed, 0);
    page.location = { origin: inspection.origin, href: inspection.url };
    race = true;
    await assert.rejects(computer.act('fixture', { action: 'snapshot' }));
    assert.equal(foreignReads, 0);
  } finally {
    await computer.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native secure entry binds refs and rejects replacement before the private socket write',
  {
    skip: !process.env.OTTO_TEST_BROWSER_EXECUTABLE,
    timeout: 60_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-native-login-'));
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(
        '<html><title>Synthetic login</title><body><form><label>利用者<input id="account" readonly autocomplete="one-time-code"></label><label>暗証<input id="password" type="password"></label><input id="unrelated" value="existing-user-value"><button type="button" id="replace">Replace</button></form><script>document.querySelector("#account").addEventListener("focus",event=>{event.target.readOnly=false});document.querySelector("#replace").addEventListener("click",()=>{const e=document.querySelector("#password");const clone=e.cloneNode();clone.value="replacement-user-value";e.replaceWith(clone)});</script></body></html>',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    const secret = 'synthetic-native-password';
    let socket: string | undefined;
    let replaceAtEntry = false;
    let privateWrites = 0;
    let shellLeak = false;
    let responseLeak = false;
    const computer = createAgentBrowserComputer({
      dataRoot: directory,
      browserExecutable: process.env.OTTO_TEST_BROWSER_EXECUTABLE,
      headless: true,
      run: async (executable, args, options) => {
        shellLeak ||= JSON.stringify({ args, input: options?.input }).includes(secret);
        const result = await runProcess(executable, args, options);
        responseLeak ||= JSON.stringify(result).includes(secret);
        return result;
      },
      daemonCommand: async (path, command, ...args) => {
        socket = path;
        const privateEntry =
          command.action === 'evaluate' &&
          typeof command.script === 'string' &&
          command.script.includes('const origin=') &&
          command.script.includes(secret);
        if (privateEntry) {
          assert.equal(command.action, 'evaluate');
          privateWrites++;
          if (replaceAtEntry)
            await existingDaemonCommand(path, {
              action: 'evaluate',
              script: 'document.querySelector("#replace").click()',
            });
        }
        const result = await existingDaemonCommand(path, command, ...args);
        if (privateEntry) responseLeak ||= JSON.stringify(result).includes(secret);
        return result;
      },
    });
    try {
      const opened = await computer.act('fixture', { action: 'open', url: origin + '/login' });
      const ref = /textbox "利用者" \[ref=(e\d+)\]/.exec(opened.text)?.[1];
      assert.ok(ref);
      const target = {
        origin,
        kind: 'password' as const,
        usernameSelector: `@${ref}`,
        passwordSelector: '#password',
      };
      const inspection = await computer.inspectLogin('fixture', target);
      assert.equal(inspection.fields.length, 2);
      const input = {
        threadId: 'fixture',
        origin,
        kind: 'password' as const,
        username: 'synthetic-native-account',
        password: secret,
        usernameSelector: inspection.fields[0].selector,
        passwordSelector: inspection.fields[1].selector,
      };
      await computer.injectCredentials(input);
      assert.ok(socket);
      const entered = await existingDaemonCommand(socket, {
        action: 'evaluate',
        script: `({valid:document.querySelector('#account').value==='synthetic-native-account'&&document.querySelector('#password').value===${JSON.stringify(secret)}&&document.querySelector('#unrelated').value==='existing-user-value'})`,
      });
      assert.deepEqual(entered.result, { valid: true });
      await computer.act('fixture', { action: 'open', url: origin + '/login' });
      const fresh = await computer.inspectLogin('fixture', {
        ...target,
        usernameSelector: '#account',
      });
      replaceAtEntry = true;
      await assert.rejects(
        computer.injectCredentials({
          ...input,
          usernameSelector: fresh.fields[0].selector,
          passwordSelector: fresh.fields[1].selector,
        }),
        /Secure entry could not be confirmed/,
      );
      const untouched = await existingDaemonCommand(socket, {
        action: 'evaluate',
        script:
          "({valid:document.querySelector('#account').value===''&&document.querySelector('#password').value==='replacement-user-value'&&document.querySelector('#unrelated').value==='existing-user-value'})",
      });
      assert.deepEqual(untouched.result, { valid: true });
      assert.equal(privateWrites, 2);
      assert.equal(shellLeak, false);
      assert.equal(responseLeak, false);
    } finally {
      await computer.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('a signed-in job search box is not a sign-in field', () => {
  const dom = new JSDOM(
    '<main><h1>Jobs</h1><input aria-label="Search" placeholder="Search jobs"></main><footer>Sign in</footer>',
    { url: 'https://www.example.com/company/jobs/', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rect = new dom.window.DOMRect(0, 0, 30, 30);
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  try {
    const inspection = loginInspectionSchema.parse(dom.window.eval(loginInspectionScript()));
    assert.equal(inspection.fields.length, 0);
    assert.equal(inspection.methods.length, 0);
  } finally {
    dom.window.close();
  }
});

test('split-code observations hide each private input value and retain unrelated numbers and refs', async () => {
  const directory = await mkdtemp('/tmp/otto-private-values-');
  const dom = new JSDOM(
    '<form class="otp"><h1>Verification</h1>' +
      Array.from(
        { length: 6 },
        (_, index) => `<input class="otp-input" aria-label="Digit ${index + 1}" maxlength="1">`,
      ).join('') +
      '<button type="button">Verify</button></form><p>Invoice 2026, 18 items</p><form><input aria-label="Seats" value="18"></form>',
    { url: 'https://1.1.1.1/login', runScripts: 'outside-only' },
  );
  dom.window.HTMLElement.prototype.getClientRects = function () {
    const rect = new dom.window.DOMRect(0, 0, 30, 30);
    return Object.assign([rect], { item: (index: number) => (index === 0 ? rect : null) });
  };
  Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
    get() {
      return this.textContent;
    },
  });
  const inputs = [...dom.window.document.querySelectorAll('input')];
  inputs[0].focus();
  const snapshots: string[] = [];
  const computer = createBrowserFixture({
    dataRoot: directory,
    run: async (_executable, args, options) => {
      const command = args.slice(args.indexOf('--idle-timeout') + 2);
      let data: Record<string, unknown> = {};
      if (command[0] === 'get' && command[1] === 'url') data = { url: dom.window.location.href };
      if (command[0] === 'get' && command[1] === 'attr')
        data = { value: inputs[Number(command[2].slice(2)) - 1]?.getAttribute(command[3]) ?? null };
      if (command[0] === 'eval') data = { result: await dom.window.eval(options?.input ?? '') };
      if (command[0] === 'fill') {
        const target = dom.window.document.querySelector<HTMLInputElement>(command[1]);
        if (target) target.value = command[2];
      }
      if (command[0] === 'snapshot') {
        const snapshot = [
          ...inputs.map(
            (input, index) =>
              `- textbox "${input.getAttribute('aria-label')}" [ref=e${index + 1}]: ${input.value}`,
          ),
          '- button "Verify" [ref=e8]',
        ].join('\n');
        snapshots.push(snapshot);
        data = { snapshot };
      }
      if (command[0] === 'screenshot') await writeFile(command[1], 'synthetic masked frame');
      return { stdout: JSON.stringify({ success: true, data }), stderr: '', exitCode: 0 };
    },
  });
  try {
    await computer.act('fixture', { action: 'open', url: dom.window.location.href });
    const inspection = await computer.inspectLogin('fixture', {
      origin: dom.window.location.origin,
      kind: 'otp',
      passwordSelector: '.otp-input',
    });
    const otp = inspection.fields.find((field) => field.kind === 'otp')!;
    assert.ok(otp);
    for (const [index, digit] of [...'137924'].entries()) inputs[index].value = digit;
    const beforeEntry = await computer.act('fixture', { action: 'snapshot' });
    assert.equal(beforeEntry.text.includes('137924'), false);
    for (let index = 0; index < 6; index++)
      assert.ok(
        beforeEntry.text.includes(`textbox "Digit ${index + 1}" [ref=e${index + 1}]: [redacted]`),
      );
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: dom.window.location.origin,
      kind: 'otp',
      code: '483729',
      passwordSelector: '@e1',
    });
    const observation = await computer.act('fixture', { action: 'snapshot' });
    assert.match(snapshots.at(-1)!, /textbox "Digit 1" \[ref=e1\]: 4/);
    assert.match(observation.text, /Invoice 2026, 18 items/);
    assert.match(observation.text, /textbox "Seats" \[ref=e7\]: 18/);
    for (let index = 0; index < 6; index++) {
      assert.ok(
        observation.text.includes(`textbox "Digit ${index + 1}" [ref=e${index + 1}]: [redacted]`),
      );
      assert.equal(inputs[index].style.color, 'transparent');
    }
    assert.deepEqual(observation.candidates, [{ id: '@e8', label: '- button "Verify" [ref=e8]' }]);
    assert.equal(observation.text.includes('483729'), false);
  } finally {
    await computer.dispose();
    dom.window.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('closing and reopening a browser creates a usable page without reviving old field bindings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-login-reopen-'));
  const fixture = stagedLoginBrowser();
  const computer = createBrowserFixture({ dataRoot: directory, run: fixture.run });
  try {
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const first = fixture.pages.get('fixture')!;
    const selected = await computer.inspectLogin('fixture');
    await computer.close('fixture');
    assert.equal(first.closed, true);
    await computer.act('fixture', { action: 'open', url: 'https://1.1.1.1/login' });
    const next = fixture.pages.get('fixture')!;
    assert.equal(next === first, false);
    await assert.rejects(
      computer.injectCredentials({
        threadId: 'fixture',
        origin: selected.origin,
        kind: 'identifier',
        username: 'synthetic-reopened-account',
        usernameSelector: selected.fields[0].selector,
      }),
      /Secure entry could not be confirmed/,
    );
    const fresh = await computer.inspectLogin('fixture');
    await computer.injectCredentials({
      threadId: 'fixture',
      origin: fresh.origin,
      kind: 'identifier',
      username: 'synthetic-reopened-account',
      usernameSelector: fresh.fields[0].selector,
    });
    assert.equal(next.input.value, 'synthetic-reopened-account');
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
    const inspection = await original.inspectLogin('fixture');
    await original.injectCredentials({
      threadId: 'fixture',
      origin: inspection.origin,
      kind: 'identifier',
      username: 'synthetic-secret@example.test',
      usernameSelector: inspection.fields[0].selector,
    });
    const masked = await original.screenshot('fixture');
    assert.equal(masked?.includes(Buffer.from('synthetic-secret@example.test')), false);
    assert.deepEqual(await restored.screenshot('fixture'), masked);
    assert.equal(restored.screenStatus?.('fixture').state, 'last_known');
    assert.equal(commands, 0);
    await assert.rejects(restored.inspectLogin('fixture'), /Open the login page/);
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
