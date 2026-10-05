import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { createSettingsStore } from '../main/settings.mjs';
import {
  completeDesktopSetup,
  createDesktopAnalytics,
  trackDesktopAnalytics,
} from '../main/analytics.mjs';
import { createAppPreferencesStore } from '../main/app-preferences.mjs';
import { createChatReadCursorStore } from '../main/chat-read-cursors.mjs';
import { createDesktopLifecycle, desktopSetupMode } from '../main/lifecycle.mjs';
import {
  createDesktopUpdater,
  createUpdateSource,
  guardUpdateRenderers,
  restartDesktopUpdate,
  startDesktopUpdateChecks,
} from '../main/updates.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('successful setup lets the recorder flush before closing and cannot block startup', async () => {
  const flushed = deferred();
  const events = [];
  let closed = false;
  const window = {
    isDestroyed: () => closed,
    webContents: {
      executeJavaScript: () => {
        events.push('flush');
        return flushed.promise;
      },
    },
    destroy: () => {
      closed = true;
      events.push('close');
    },
  };
  const completed = completeDesktopSetup(window);
  await new Promise(setImmediate);
  assert.deepEqual(events, ['flush']);
  flushed.resolve();
  await completed;
  assert.deepEqual(events, ['flush', 'close']);
  await completeDesktopSetup(window);
  assert.deepEqual(events, ['flush', 'close']);
  for (const flush of [
    () => {
      throw new Error('Synthetic recorder failure');
    },
    () => Promise.reject(new Error('Synthetic renderer failure')),
    () => new Promise(() => {}),
  ]) {
    closed = false;
    window.webContents.executeJavaScript = flush;
    await completeDesktopSetup(window, 10);
    assert.equal(closed, true);
  }
});

test('overlapping recording drains share session handlers without mixing windows or dropping later requests', async (t) => {
  const listeners = {};
  const session = {
    webRequest: Object.fromEntries(
      ['onBeforeRequest', 'onCompleted', 'onErrorOccurred'].map((event) => [
        event,
        (_filter, listener) => {
          listeners[event] = listener;
        },
      ]),
    ),
  };
  const createWindow = (id) => {
    const window = Object.assign(new EventEmitter(), {
      webContents: { id, session, executeJavaScript: async () => {} },
      isDestroyed: () => window.destroyed === true,
      destroy: () => {
        window.destroyed = true;
        window.emit('closed');
      },
    });
    t.after(() => {
      if (!window.isDestroyed()) window.destroy();
    });
    trackDesktopAnalytics(window);
    return window;
  };
  const started = (id, webContentsId) => listeners.onBeforeRequest({ id, webContentsId }, () => {});
  const first = createWindow(1);
  const second = createWindow(2);
  started(101, 1);
  started(102, 2);
  const firstDrain = completeDesktopSetup(first);
  const secondDrain = completeDesktopSetup(second);
  await new Promise((accept) => setTimeout(accept, 150));
  assert.equal(first.isDestroyed(), false);
  assert.equal(second.isDestroyed(), false);
  listeners.onCompleted({ id: 101 });
  await firstDrain;
  assert.equal(first.isDestroyed(), true);
  assert.equal(second.isDestroyed(), false);
  started(103, 2);
  listeners.onCompleted({ id: 102 });
  await new Promise((accept) => setTimeout(accept, 150));
  assert.equal(second.isDestroyed(), false);
  listeners.onErrorOccurred({ id: 103 });
  await secondDrain;
  assert.equal(second.isDestroyed(), true);
  const reopened = createWindow(3);
  started(104, 3);
  const reopenedDrain = completeDesktopSetup(reopened);
  await new Promise((accept) => setTimeout(accept, 150));
  assert.equal(reopened.isDestroyed(), false);
  listeners.onCompleted({ id: 104 });
  await reopenedDrain;
  assert.equal(reopened.isDestroyed(), true);
});

test('native onboarding and restarted runtimes share a private installation identity', async (t) => {
  const f = await fixture(t);
  const path = join(dirname(f.path), 'analytics-id');
  const readers = Array.from({ length: 12 }, () =>
    createDesktopAnalytics(path, { packaged: true, env: {} }),
  );
  const configurations = await Promise.all(readers.map((read) => read()));
  assert.equal(new Set(configurations.map((value) => value.distinctId)).size, 1);
  const saved = await readFile(path, 'utf8');
  assert.equal(configurations[0].distinctId, `local:${saved}`);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(configurations[0].enabled, true);
  assert.equal(configurations[0].environment, 'production');
  const restarted = await createDesktopAnalytics(path, {
    packaged: true,
    env: { OTTO_ANALYTICS_ENABLED: 'false' },
  })();
  assert.equal(restarted.distinctId, configurations[0].distinctId);
  assert.equal(restarted.enabled, false);
  const development = await createDesktopAnalytics(path, { env: {} })();
  assert.equal(development.enabled, false);
  assert.equal(development.environment, 'development');
  const runtime = await createDesktopAnalytics(path, {
    env: { OTTO_ANALYTICS_ID: saved, OTTO_ANALYTICS_ENABLED: 'true' },
  })();
  assert.equal(runtime.distinctId, configurations[0].distinctId);
  assert.equal(runtime.enabled, true);
});

test('invalid analytics identifiers never enter the renderer configuration', async (t) => {
  const f = await fixture(t);
  const path = join(dirname(f.path), 'analytics-id');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, 'synthetic-private-value');
  await assert.rejects(createDesktopAnalytics(path, { env: {} })(), /installation ID is invalid/);
  await assert.rejects(
    createDesktopAnalytics(path, { env: { OTTO_ANALYTICS_ID: 'synthetic-private-value' } })(),
    /installation ID is invalid/,
  );
});

test('runtime warmup overlaps onboarding without reading credentials or starting the engine', async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  const started = deferred();
  const events = [];
  let decrypted = 0;
  const decrypt = f.encryption.decryptString;
  f.encryption.decryptString = (value) => {
    decrypted++;
    return decrypt(value);
  };
  const computer = { close: async () => events.push('computer closed') };
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async () => {
      events.push('computer started');
      started.resolve();
      return gate.promise;
    },
    validateStart: async () => {
      if (!(await f.store.get()).onboardingCompleted) throw new Error('Setup incomplete');
    },
    startEngine: async ({ runtime }) => {
      assert.equal(runtime, computer);
      assert.equal((await f.reopen().get()).onboardingCompleted, true);
      await f.store.environment();
      events.push('engine started');
    },
    stopEngine: async () => events.push('engine stopped'),
    onRuntimeStatus: () => {},
  });
  const first = lifecycle.warmup();
  assert.equal(first, lifecycle.warmup());
  await started.promise;
  await assert.rejects(lifecycle.start(), /Setup incomplete/);
  assert.equal(lifecycle.engineStarting, false);
  await f.store.save({ composioApiKey: 'synthetic-warmup-connection-key' });
  assert.equal(decrypted, 0);
  await f.store.save({ onboardingCompleted: true });
  const running = lifecycle.start();
  assert.equal(running, lifecycle.start());
  assert.equal(lifecycle.engineStarting, false);
  assert.deepEqual(events, ['computer started']);
  gate.resolve(computer);
  await Promise.all([first, running]);
  assert.ok(decrypted > 0);
  assert.deepEqual(events, ['computer started', 'engine started']);
  const stopped = lifecycle.close();
  assert.equal(stopped, lifecycle.close());
  await stopped;
  assert.deepEqual(events.slice(-2), ['engine stopped', 'computer closed']);
});

test('failed runtime preparation waits for explicit retry and keeps the successful computer', async () => {
  let attempts = 0;
  let engineStarts = 0;
  const statuses = [];
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async () => {
      if (++attempts === 1)
        throw Object.assign(new Error('Runtime required'), { code: 'RUNTIME_ARCHIVE_REQUIRED' });
      return { close: async () => {} };
    },
    validateStart: async () => {},
    startEngine: async () => {
      if (++engineStarts === 1) throw new Error('Engine unavailable');
    },
    stopEngine: async () => {},
    onRuntimeStatus: (value) => statuses.push(value),
  });
  await assert.rejects(lifecycle.warmup(), /Runtime required/);
  await assert.rejects(lifecycle.start(), /Runtime required/);
  assert.equal(attempts, 1);
  assert.equal(engineStarts, 0);
  assert.equal(statuses.at(-1).needsRuntimeArchive, true);
  await assert.rejects(lifecycle.start({ retry: true }), /Engine unavailable/);
  assert.equal(attempts, 2);
  assert.equal(engineStarts, 1);
  await new Promise(setImmediate);
  assert.equal(engineStarts, 1);
  await lifecycle.start({ retry: true });
  assert.equal(attempts, 2);
  assert.equal(engineStarts, 2);
  await lifecycle.close();
});

test('quit aborts and waits for late runtime completion without starting an engine', async () => {
  const gate = deferred();
  const started = deferred();
  const events = [];
  let signal;
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async (options) => {
      signal = options.signal;
      started.resolve();
      return gate.promise;
    },
    validateStart: async () => {},
    startEngine: async () => assert.fail('Quit must fence engine startup.'),
    stopEngine: async () => events.push('engine stopped'),
    onRuntimeStatus: (value) => events.push(value.phase),
  });
  const starting = lifecycle.start();
  const rejected = assert.rejects(starting, /closing/);
  await started.promise;
  const closing = lifecycle.close();
  assert.equal(signal.aborted, true);
  await new Promise(setImmediate);
  assert.ok(!events.includes('engine stopped'));
  gate.resolve({ close: async () => events.push('computer closed') });
  await Promise.all([closing, rejected]);
  assert.deepEqual(events, ['preparing', 'engine stopped', 'computer closed']);
});

test('runtime import joins startup and quit fences an unfinished archive installer', async () => {
  for (const quitting of [false, true]) {
    const gate = deferred();
    const started = deferred();
    const events = [];
    let signal;
    const lifecycle = createDesktopLifecycle({
      prepareRuntime: async () => {
        events.push('warm');
        return { close: async () => events.push('close') };
      },
      validateStart: async () => {},
      startEngine: async () => events.push('engine'),
      stopEngine: async () => {},
      onRuntimeStatus: () => {},
    });
    const importing = lifecycle.install(async (options) => {
      signal = options.signal;
      started.resolve();
      await gate.promise;
    });
    const checkedImport = quitting ? assert.rejects(importing, /closing/) : importing;
    await started.promise;
    assert.throws(() => lifecycle.install(async () => {}), /Wait for Otto/);
    const starting = lifecycle.start();
    const checkedStart = quitting ? assert.rejects(starting, /closing/) : starting;
    let closing;
    if (quitting) {
      closing = lifecycle.close();
      assert.equal(signal.aborted, true);
    }
    gate.resolve();
    await Promise.all([checkedImport, checkedStart, closing]);
    assert.deepEqual(events, quitting ? [] : ['warm', 'engine']);
    await lifecycle.close();
  }
});

test('failed computer shutdown retains the runtime and permits an explicit retry', async () => {
  let stops = 0;
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async () => ({
      close: async () => {
        if (++stops === 1) throw new Error('Computer did not stop');
      },
    }),
    validateStart: async () => {},
    startEngine: async () => {},
    stopEngine: async () => {},
    onRuntimeStatus: () => {},
  });
  await lifecycle.warmup();
  await assert.rejects(lifecycle.close(), /Computer did not stop/);
  assert.throws(() => lifecycle.start(), /closing/);
  await lifecycle.close();
  assert.equal(stops, 2);
  await lifecycle.close();
  assert.equal(stops, 2);
});

test('quit retains a late runtime when its shutdown fails and retries unfinished preparation cleanup', async () => {
  for (const prepared of [true, false]) {
    const started = deferred();
    const gate = deferred();
    let stops = 0;
    const stop = async () => {
      if (++stops === 1) throw new Error('Computer did not stop');
    };
    const lifecycle = createDesktopLifecycle({
      prepareRuntime: async () => {
        started.resolve();
        await gate.promise;
        if (!prepared)
          throw Object.assign(new Error('Preparation interrupted'), {
            code: 'OTTO_RUNTIME_STOP_FAILED',
          });
        return { close: stop };
      },
      stopRuntime: stop,
      validateStart: async () => {},
      startEngine: async () => assert.fail('Quit must fence engine startup.'),
      stopEngine: async () => {},
      onRuntimeStatus: () => {},
    });
    const warming = assert.rejects(lifecycle.warmup());
    await started.promise;
    const closing = assert.rejects(lifecycle.close(), /Computer did not stop/);
    gate.resolve();
    await Promise.all([warming, closing]);
    await lifecycle.close();
    assert.equal(stops, 2);
  }
});

test('quit does not try to stop a computer before installation has started it', async () => {
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async () => {
      throw Object.assign(new Error('Runtime required'), { code: 'RUNTIME_ARCHIVE_REQUIRED' });
    },
    stopRuntime: async () => assert.fail('No computer was started.'),
    validateStart: async () => {},
    startEngine: async () => {},
    stopEngine: async () => {},
    onRuntimeStatus: () => {},
  });
  await assert.rejects(lifecycle.warmup(), /Runtime required/);
  await lifecycle.close();
});

test('native navigation keeps incomplete setup and startup out of normal Settings', () => {
  for (const running of [false, true]) {
    assert.equal(desktopSetupMode({ completed: false, replaying: false, running }), 'onboarding');
    assert.equal(desktopSetupMode({ completed: true, replaying: true, running }), 'onboarding');
  }
  assert.equal(desktopSetupMode({ completed: true, replaying: false, running: false }), 'loading');
  assert.equal(desktopSetupMode({ completed: true, replaying: false, running: true }), 'settings');
});

async function runningDesktop(t, request, { allowStart = false } = {}) {
  const storage = await fixture(t);
  await storage.store.save({
    onboardingCompleted: true,
  });
  const windows = [];
  const children = [];
  const handlers = new Map();
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
  });
  let openAtLogin = false;
  const context = {
    app: {
      setName() {},
      setPath() {},
      getPath: () => dirname(storage.path),
      requestSingleInstanceLock: () => false,
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (value) => {
        openAtLogin = value.openAtLogin;
      },
      quit() {},
    },
    process: { platform: 'darwin', argv: [], env: {} },
    ipcMain: ipc,
    guardUpdateRenderers,
    URL,
    dirname,
    join,
    resolve,
    fileURLToPath,
    pathToFileURL,
    mkdir,
    appendFile,
    readFile,
    stat,
    writeFile,
    randomUUID,
    randomBytes,
    createServer,
    AbortController,
    AbortSignal,
    setTimeout,
    clearTimeout,
    fetch: request,
    createSettingsStore: () => storage.store,
    createDesktopAnalytics,
    completeDesktopSetup,
    trackDesktopAnalytics,
    createAppPreferencesStore: () => ({ sync: async () => {} }),
    createChatReadCursorStore: () => ({}),
    createReadinessNotice: () => ({ update() {} }),
    createDesktopLifecycle: (options) =>
      createDesktopLifecycle({
        ...options,
        prepareRuntime: async () => {
          await mkdir(join(dirname(storage.path), 'profiles', 'local'), { recursive: true });
          return { env: {} };
        },
      }),
    desktopSetupMode,
    nativeTheme: { shouldUseDarkColors: false },
    safeStorage: storage.encryption,
    Notification: { isSupported: () => false },
    utilityProcess: {
      fork() {
        assert.ok(allowStart, 'The healthy engine must not restart.');
        const child = new EventEmitter();
        child.stdout = { resume() {} };
        child.stderr = new EventEmitter();
        child.kill = () => {
          child.killed = true;
          child.emit('exit', 0);
        };
        children.push(child);
        return child;
      },
    },
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        this.sent = [];
        this.visible = true;
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler() {},
          isLoadingMainFrame: () => Boolean(this.loading),
          send: (channel, value) => {
            this.sent.push([channel, value]);
            if (channel === 'otto:update:prepare')
              queueMicrotask(() =>
                ipc.emit(
                  'otto:update:prepared',
                  { sender: this.webContents, senderFrame: this.webContents.mainFrame },
                  { token: value, blocked: false },
                ),
              );
          },
        });
        windows.push(this);
        this.focus();
      }
      isDestroyed() {
        return this.destroyed === true;
      }
      isFocused() {
        return this.focused && !this.destroyed;
      }
      loadURL(url) {
        this.url = url;
        this.loading = true;
        this.webContents.mainFrame = { url };
      }
      loadFile(path, options) {
        this.path = path;
        this.query = options?.query;
        this.webContents.mainFrame = { url: pathToFileURL(path).href };
      }
      show() {
        this.visible = true;
        this.focus();
      }
      focus() {
        for (const window of windows) window.focused = false;
        this.focused = true;
      }
      setSize() {}
      setBackgroundColor() {}
      destroy() {
        this.destroyed = true;
        this.visible = false;
        this.focused = false;
        this.emit('closed');
      }
    },
  };
  const source = (await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8'))
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replaceAll(
      'import.meta.url',
      JSON.stringify(new URL('../main/main.mjs', import.meta.url).href),
    );
  runInNewContext(
    `${source}
    engine = {};
    enginePreferencesReady = true;
    engineOrigin = 'http://127.0.0.1:4310';
    onboardingCompleted = true;
    status.phase = 'ready';
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:get'"), source.indexOf("      ipcMain.handle('otto:feedback:context'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:feedback:context'"), source.indexOf("      ipcMain.handle('otto:preferences:get'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:save'"), source.indexOf("      ipcMain.handle('otto:prepare'"))}
    globalThis.running = {
      prepare,
      showEngine,
      replayOnboarding,
      showFeedback,
      setReady: (ready) => { status.phase = ready ? 'ready' : 'starting'; },
      status: () => status,
      setRestartRequired: (value) => { restartRequired = value; },
      crash: () => { engine = undefined; enginePreferencesReady = false; },
    };`,
    context,
  );
  return { ...context.running, windows, children, storage, handlers };
}

test('native settings reject foreign windows, subframes, AI credentials, and web onboarding writes', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('Settings must not make an engine request.'));
  await f.storage.store.save({ composioApiKey: 'synthetic-existing-key' });
  f.showEngine();
  const window = f.windows.at(-1);
  const frame = { url: 'http://127.0.0.1:4310/' };
  window.webContents.mainFrame = frame;
  const event = { sender: window.webContents, senderFrame: frame };
  const invoke = (channel, target, ...args) =>
    Promise.resolve().then(() => f.handlers.get(channel)(target, ...args));
  const get = (target = event) => invoke('otto:settings:get', target);
  const save = (value, target = event) => invoke('otto:settings:save', target, value);
  const reveal = (field, target = event) => invoke('otto:settings:reveal', target, field);
  const analytics = (target = event) => invoke('otto:analytics:configuration', target);
  for (const rejected of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: window.webContents, senderFrame: { url: frame.url } },
  ]) {
    await assert.rejects(get(rejected), /unavailable/);
    await assert.rejects(
      save({ composioApiKey: 'synthetic-injected-key' }, rejected),
      /unavailable/,
    );
    await assert.rejects(reveal('composioApiKey', rejected), /unavailable/);
    await assert.rejects(analytics(rejected), /unavailable/);
  }
  for (const url of ['https://example.test/', 'http://127.0.0.1:4310/api/files/synthetic']) {
    frame.url = url;
    await assert.rejects(get(), /unavailable/);
    await assert.rejects(save({ theme: 'dark' }), /unavailable/);
    await assert.rejects(reveal('composioApiKey'), /unavailable/);
    await assert.rejects(analytics(), /unavailable/);
  }
  frame.url = 'http://127.0.0.1:4310/onboarding';
  const previous = await readFile(f.storage.path, 'utf8');
  for (const value of [
    { onboardingCompleted: false },
    { openaiApiKey: 'synthetic-ai-key' },
    { anthropicApiKey: 'synthetic-ai-key' },
    { vaultKey: 'synthetic-vault-key' },
    { clearKeys: ['composioApiKey'] },
  ])
    await assert.rejects(save(value), /not supported/);
  for (const field of ['vaultKey', 'integrationConfiguration', 'openaiApiKey', 'anthropicApiKey'])
    await assert.rejects(reveal(field), /supported key/);
  assert.equal(await readFile(f.storage.path, 'utf8'), previous);
  assert.ok(!JSON.stringify(await get()).includes('synthetic-existing-key'));
  assert.ok(!JSON.stringify(await analytics()).includes('synthetic-existing-key'));
  assert.equal(await reveal('composioApiKey'), 'synthetic-existing-key');
  await save({ theme: 'dark', launchAtLogin: true, composioApiKey: 'synthetic-replacement-key' });
  assert.equal((await f.storage.store.get()).launchAtLogin, true);
  assert.equal(await reveal('composioApiKey'), 'synthetic-replacement-key');
  window.destroy();
  await assert.rejects(reveal('composioApiKey'), /unavailable/);
});

test('an engine crash retires every stale chat window before recovery opens the new engine', async (t) => {
  const requests = [];
  const f = await runningDesktop(
    t,
    async (url) => {
      requests.push(url);
      assert.equal(new URL(url).pathname, '/api/health');
      return Response.json({ ok: true });
    },
    { allowStart: true },
  );
  f.crash();
  assert.equal((await f.prepare()).phase, 'ready');
  f.showEngine();
  const previous = f.windows.at(-1);
  const secondary = new previous.constructor();
  previous.webContents.emit('did-create-window', secondary);
  f.children[0].emit('exit', 1);
  assert.equal(f.status().phase, 'error');
  assert.equal(previous.isDestroyed(), true);
  assert.equal(secondary.isDestroyed(), true);
  assert.equal((await f.prepare({ retry: true })).phase, 'ready');
  f.showEngine();
  const current = f.windows.at(-1);
  assert.notEqual(current, previous);
  assert.equal(current.isDestroyed(), false);
  assert.equal(current.url, new URL(requests.at(-1)).origin);
  assert.equal(f.children.length, 2);
});

test('a deferred app connection restart keeps the healthy chat accessible and settings pending', async (t) => {
  const calls = [];
  const f = await runningDesktop(t, async (url) => {
    calls.push(url);
    return Response.json({ activeWork: true });
  });
  f.setRestartRequired(true);
  const result = await f.prepare();
  assert.equal(result.phase, 'ready');
  assert.equal(result.restartRequired, true);
  assert.match(result.error, /Finish or stop/);
  assert.deepEqual(calls, ['http://127.0.0.1:4310/api/desktop/status']);
  f.showEngine();
  assert.equal(f.windows.at(-1).url, 'http://127.0.0.1:4310');
});

test('settings restart resumes the running engine when a renderer navigates or opens a window during drain', async (t) => {
  for (const mutation of ['navigation', 'new-window']) {
    let current;
    let progress;
    let f;
    const requests = [];
    f = await runningDesktop(
      t,
      async (url, options = {}) => {
        const path = new URL(url).pathname;
        if (path === '/api/health') return Response.json({ ok: true });
        requests.push({ path, body: options.body });
        if (path === '/api/desktop/status') return Response.json({ activeWork: false });
        if (path === '/api/runtime/drain') {
          progress = f.windows.find((window) => window.path && !window.isDestroyed());
          assert.ok(progress?.visible);
          assert.equal(current.isDestroyed(), false);
          assert.equal(f.children[0].killed, undefined);
          if (mutation === 'navigation') {
            current.webContents.mainFrame.url = `${current.url}/tasks`;
            current.webContents.emit('did-start-navigation');
          } else {
            const child = new current.constructor();
            child.loadURL(current.url);
            current.webContents.emit('did-create-window', child);
          }
          return Response.json({ drained: true });
        }
        assert.equal(path, '/api/runtime/resume');
        return Response.json({ ok: true });
      },
      { allowStart: true },
    );
    f.crash();
    await f.prepare();
    f.showEngine();
    current = f.windows.at(-1);
    f.setRestartRequired(true);
    await assert.rejects(
      f.handlers.get('otto:settings:apply')({
        sender: current.webContents,
        senderFrame: current.webContents.mainFrame,
      }),
    );
    assert.deepEqual(
      requests.map(({ path }) => path),
      ['/api/desktop/status', '/api/runtime/drain', '/api/runtime/resume'],
    );
    assert.equal(requests[2].body, requests[1].body);
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].killed, undefined);
    assert.equal(current.isDestroyed(), false);
    assert.equal(current.isFocused(), true);
    assert.equal(progress.isDestroyed(), true);
    assert.equal(f.status().phase, 'ready');
    assert.equal(f.status().restartRequired, true);
    assert.equal(current.webContents.listenerCount('did-start-navigation'), 0);
    const guarded = current.sent.filter(([channel]) => channel.startsWith('otto:update:'));
    assert.equal(guarded.length, 2);
    assert.equal(guarded[0][0], 'otto:update:prepare');
    assert.equal(guarded[1][0], 'otto:update:resume');
    assert.equal(guarded[1][1], guarded[0][1]);
  }
});

test('a canceled settings restart stays in recovery until runtime resume is confirmed', async (t) => {
  const responses = [
    { confirmed: true, send: () => Response.json({ ok: true }) },
    { send: () => Response.json({ ok: true }, { status: 503 }) },
    { send: () => Response.json({ ok: false }) },
    { send: () => Response.json({ resumed: true }) },
    { send: () => Response.json({ ok: 'true' }) },
    { send: () => new Response('{') },
    {
      send: () => {
        throw new Error('synthetic-private-transport-detail');
      },
    },
  ];
  for (const drained of [false, true]) {
    for (const response of responses) {
      let f;
      let current;
      let progress;
      const requests = [];
      f = await runningDesktop(
        t,
        async (url, options = {}) => {
          const path = new URL(url).pathname;
          if (path === '/api/health') return Response.json({ ok: true });
          requests.push({ path, body: options.body });
          if (path === '/api/desktop/status') return Response.json({ activeWork: false });
          if (path === '/api/runtime/drain') {
            progress = f.windows.find((window) => window.path && !window.isDestroyed());
            assert.ok(progress?.visible);
            if (drained) current.webContents.emit('did-start-navigation');
            return Response.json({ drained }, { status: drained ? 200 : 503 });
          }
          assert.equal(path, '/api/runtime/resume');
          return response.send();
        },
        { allowStart: true },
      );
      f.crash();
      await f.prepare();
      f.showEngine();
      current = f.windows.at(-1);
      f.setRestartRequired(true);
      await assert.rejects(
        f.handlers.get('otto:settings:apply')({
          sender: current.webContents,
          senderFrame: current.webContents.mainFrame,
        }),
        (error) => !error.message.includes('synthetic-private-transport-detail'),
      );
      assert.equal(f.status().phase, response.confirmed ? 'ready' : 'error');
      assert.equal(f.status().restartRequired, true);
      assert.equal(progress.isDestroyed(), response.confirmed === true);
      assert.equal(progress.visible, !response.confirmed);
      assert.equal(f.children[0].killed, undefined);
      assert.equal(f.children.length, 1);
      assert.equal(current.isDestroyed(), false);
      assert.equal(current.webContents.listenerCount('did-start-navigation'), 0);
      assert.deepEqual(
        requests.map(({ path }) => path),
        ['/api/desktop/status', '/api/runtime/drain', '/api/runtime/resume'],
      );
      assert.equal(requests[2].body, requests[1].body);
      await new Promise(setImmediate);
      assert.equal(requests.length, 3);
    }
  }
});

test('settings restart displays native progress, restores Chat on success, and keeps startup recovery visible after stopping', async (t) => {
  for (const failAfterStop of [false, true]) {
    let f;
    let current;
    let progress;
    f = await runningDesktop(
      t,
      async (url) => {
        const path = new URL(url).pathname;
        if (path === '/api/health') return Response.json({ ok: true });
        if (path === '/api/desktop/status') return Response.json({ activeWork: false });
        assert.equal(path, '/api/runtime/drain');
        progress = f.windows.find((window) => window.path && !window.isDestroyed());
        assert.ok(progress?.visible);
        assert.equal(progress.query.firstSetup, 'false');
        assert.equal(current.isDestroyed(), false);
        assert.equal(f.children[0].killed, undefined);
        if (failAfterStop) f.storage.encryption.isEncryptionAvailable = () => false;
        return Response.json({ drained: true });
      },
      { allowStart: true },
    );
    f.crash();
    await f.prepare();
    f.showEngine();
    current = f.windows.at(-1);
    f.setRestartRequired(true);
    const applying = f.handlers.get('otto:settings:apply')({
      sender: current.webContents,
      senderFrame: current.webContents.mainFrame,
    });
    if (failAfterStop) {
      await assert.rejects(applying);
      assert.equal(f.status().phase, 'error');
      assert.equal(progress.isDestroyed(), false);
      assert.equal(progress.visible, true);
      assert.equal(progress.isFocused(), true);
      assert.equal(f.children[0].killed, true);
      assert.equal(f.children.length, 1);
      f.storage.encryption.isEncryptionAvailable = () => true;
      await f.prepare({ retry: true });
    } else await applying;
    assert.equal(current.isDestroyed(), true);
    assert.equal(f.children[0].killed, true);
    assert.equal(f.children.length, 2);
    assert.equal(f.status().phase, 'ready');
    assert.equal(f.status().restartRequired, false);
    assert.equal(progress.isDestroyed(), true);
    const replacement = f.windows.at(-1);
    assert.notEqual(replacement, current);
    assert.ok(replacement.url);
    assert.notEqual(replacement.url, current.url);
    assert.equal(replacement.isDestroyed(), false);
    assert.equal(replacement.visible, true);
    assert.equal(replacement.isFocused(), true);
  }
});

test('a pending recording drain cannot close or detach a newly opened onboarding window', async (t) => {
  const flushing = deferred();
  const flushed = deferred();
  let f;
  let progress;
  f = await runningDesktop(
    t,
    async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/health') return Response.json({ ok: true });
      if (path === '/api/desktop/status') return Response.json({ activeWork: false });
      assert.equal(path, '/api/runtime/drain');
      progress = f.windows.find((window) => window.path && !window.isDestroyed());
      progress.webContents.executeJavaScript = () => {
        flushing.resolve();
        return flushed.promise;
      };
      return Response.json({ drained: true });
    },
    { allowStart: true },
  );
  f.crash();
  await f.prepare();
  f.showEngine();
  const current = f.windows.at(-1);
  f.setRestartRequired(true);
  const applying = f.handlers.get('otto:settings:apply')({
    sender: current.webContents,
    senderFrame: current.webContents.mainFrame,
  });
  await flushing.promise;
  f.replayOnboarding();
  const replacement = f.windows.at(-1);
  flushed.resolve();
  await applying;
  assert.notEqual(replacement, progress);
  assert.equal(progress.isDestroyed(), true);
  assert.equal(replacement.isDestroyed(), false);
  const count = f.windows.length;
  f.replayOnboarding();
  assert.equal(f.windows.length, count);
  assert.equal(replacement.isFocused(), true);
});

test('a failed restart health check or crashed engine retains the error state', async (t) => {
  for (const crashed of [false, true]) {
    const f = await runningDesktop(t, async () => {
      if (crashed) f.crash();
      return Response.json({ activeWork: true }, { status: crashed ? 200 : 503 });
    });
    f.setRestartRequired(true);
    assert.equal((await f.prepare()).phase, 'error');
    f.showEngine();
    assert.equal(f.windows.at(-1).url, undefined);
  }
});

test('saving general preferences reuses the running engine', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('No restart admission check is needed.'));
  const revision = await f.storage.store.revision();
  await f.storage.store.save({ theme: 'dark', notifications: true });
  f.setRestartRequired((await f.storage.store.revision()) !== revision);
  const result = await f.prepare();
  assert.equal(result.phase, 'ready');
  assert.equal(result.restartRequired, false);
  assert.equal(result.error, undefined);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-desktop-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile', 'settings.json');
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'synthetic-secure-store',
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString(
        'utf8',
      );
    },
  };
  return {
    path,
    encryption,
    store: createSettingsStore(path, encryption),
    reopen: () => createSettingsStore(path, encryption),
  };
}

test('app connection keys remain encrypted and only masked metadata reaches ordinary reads', async (t) => {
  const f = await fixture(t);
  const secret = 'synthetic-composio-key';
  const saved = await f.store.save({ composioApiKey: secret });
  assert.equal(saved.hasComposioKey, true);
  assert.equal(saved.keys.composioApiKey.suffix, secret.slice(-4));
  assert.equal(saved.keys.composioApiKey.source, 'manual');
  const disk = await readFile(f.path, 'utf8');
  assert.ok(!disk.includes(secret));
  assert.ok(!JSON.stringify(saved).includes(secret));
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await f.reopen().get(), saved);
  const environment = await f.reopen().environment();
  assert.equal(environment.COMPOSIO_API_KEY, secret);
  assert.equal(Buffer.from(environment.OTTO_VAULT_KEY, 'base64').length, 32);
  assert.equal((await f.reopen().environment()).OTTO_VAULT_KEY, environment.OTTO_VAULT_KEY);
  assert.ok(!disk.includes(environment.OTTO_VAULT_KEY));
  assert.deepEqual(Object.keys(environment).sort(), ['COMPOSIO_API_KEY', 'OTTO_VAULT_KEY']);
});

test('invalid edits preserve encrypted keys and later saves still succeed', async (t) => {
  const f = await fixture(t);
  await f.store.save({ composioApiKey: 'synthetic-working-key' });
  const previous = await readFile(f.path, 'utf8');
  for (const input of [
    { composioApiKey: {} },
    { composioApiKey: 'x'.repeat(16_385) },
    { composioApiKey: 'synthetic-rejected-key', openaiApiKey: 'synthetic-ai-key' },
    { composioApiKey: null, provider: 'anthropic' },
    { clearKeys: ['vaultKey'] },
    { clearKeys: ['anthropicApiKey'] },
  ]) {
    await assert.rejects(f.store.save(input));
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
  assert.equal((await f.store.environment()).COMPOSIO_API_KEY, 'synthetic-working-key');
  await f.store.save({ composioApiKey: 'synthetic-replacement-key' });
  assert.equal((await f.reopen().environment()).COMPOSIO_API_KEY, 'synthetic-replacement-key');
});

test('blank fields preserve the connection key while removal persists without rotating the vault', async (t) => {
  for (const remove of [{ composioApiKey: null }, { clearKeys: ['composioApiKey'] }]) {
    const f = await fixture(t);
    await f.store.save({ composioApiKey: 'synthetic-composio-key' });
    const before = await f.store.environment();
    for (const composioApiKey of ['', '   ']) await f.store.save({ composioApiKey });
    assert.equal((await f.store.environment()).COMPOSIO_API_KEY, before.COMPOSIO_API_KEY);
    await f.store.save(remove);
    const after = await f.reopen().environment();
    assert.equal(after.COMPOSIO_API_KEY, '');
    assert.equal(after.OTTO_VAULT_KEY, before.OTTO_VAULT_KEY);
    assert.equal((await f.reopen().get()).hasComposioKey, false);
  }
});

test('encrypted integration import cannot configure AI, import accounts, or replace runtime identity', async (t) => {
  const f = await fixture(t);
  const rejected = {
    COMPOSIO_CONNECTED_ACCOUNT_ID: 'synthetic-connected-account',
    TELEGRAM_BOT_TOKEN: 'synthetic-bot-token',
    DATABASE_URL: 'synthetic-database-url',
    OTTO_DESKTOP_OWNER_ID: 'synthetic-owner',
    OTTO_DESKTOP_AUTH_TOKEN: 'synthetic-desktop-token',
    OPENAI_API_KEY: 'synthetic-openai-key',
    ANTHROPIC_API_KEY: 'synthetic-anthropic-key',
    LLM_PROVIDER: 'openai',
    LLM_MODEL: 'synthetic-model',
  };
  await f.store.save(
    {},
    {
      COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'synthetic-auth-config',
      OTTO_VAULT_KEY: 'synthetic-vault-key',
      ...rejected,
    },
  );
  const environment = await f.reopen().environment();
  assert.equal(environment.COMPOSIO_GMAIL_AUTH_CONFIG_ID, 'synthetic-auth-config');
  for (const field of Object.keys(rejected)) assert.equal(environment[field], undefined);
  assert.notEqual(environment.OTTO_VAULT_KEY, 'synthetic-vault-key');
  assert.ok(!(await readFile(f.path, 'utf8')).includes('synthetic-auth-config'));
});

test('unavailable or plaintext key stores refuse secret persistence and decryption', async (t) => {
  const f = await fixture(t);
  await f.store.save({ composioApiKey: 'synthetic-protected-key' });
  const previous = await readFile(f.path, 'utf8');
  for (const unavailable of [
    { ...f.encryption, isEncryptionAvailable: () => false },
    { ...f.encryption, getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const store = createSettingsStore(f.path, unavailable);
    await assert.rejects(store.save({ composioApiKey: 'synthetic-new-key' }), /system key store/);
    await assert.rejects(store.environment(), /system key store/);
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
});

test('unreadable ciphertext fails closed without returning the secret or decryptor error', async (t) => {
  const f = await fixture(t);
  await f.store.save({ composioApiKey: 'synthetic-private-key' });
  const value = JSON.parse(await readFile(f.path, 'utf8'));
  const ciphertext = Buffer.from(value.secrets.composioApiKey, 'base64');
  ciphertext[12] ^= 1;
  value.secrets.composioApiKey = ciphertext.toString('base64');
  await writeFile(f.path, JSON.stringify(value));
  await assert.rejects(f.reopen().environment(), {
    message: 'The system key store could not unlock your saved keys.',
  });
});

test('preferences persist without unlocking keys or changing the running engine configuration', async (t) => {
  const f = await fixture(t);
  await f.store.save({ composioApiKey: 'synthetic-retained-connection-key' });
  const before = JSON.parse(await readFile(f.path, 'utf8'));
  const encrypted = { ...before.secrets };
  const store = createSettingsStore(f.path, {
    ...f.encryption,
    isEncryptionAvailable() {
      throw new Error('Preferences must not access the key store.');
    },
  });
  const revision = await store.revision();
  await store.save({
    theme: 'dark',
    notifications: true,
    launchAtLogin: true,
    onboardingCompleted: true,
  });
  assert.equal(await store.revision(), revision);
  const reopened = await f.reopen().get();
  assert.equal(reopened.theme, 'dark');
  assert.equal(reopened.notifications, true);
  assert.equal(reopened.launchAtLogin, true);
  assert.equal(reopened.onboardingCompleted, true);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).secrets, encrypted);
  assert.equal(
    (await f.reopen().environment()).COMPOSIO_API_KEY,
    'synthetic-retained-connection-key',
  );
  await assert.rejects(store.save({ theme: 'invalid' }), /supported appearance/);
  await assert.rejects(store.save({ notifications: 'true' }), /preferences/);
});

test('explicit reveal permits only the app connection key while ordinary reads retain masked metadata', async (t) => {
  const f = await fixture(t);
  const key = 'synthetic-reveal-connection-key';
  await f.store.save({ composioApiKey: key }, {});
  assert.equal(await f.store.revealKey('composioApiKey'), key);
  const redacted = await f.store.get();
  assert.equal(redacted.keys.composioApiKey.source, 'import');
  assert.equal(redacted.keys.composioApiKey.suffix, '-key');
  assert.ok(!JSON.stringify(redacted).includes(key));
  for (const field of [
    'vaultKey',
    'integrationConfiguration',
    'openaiApiKey',
    'anthropicApiKey',
    '__proto__',
    null,
  ])
    await assert.rejects(f.store.revealKey(field), /supported app connection key/);
  await f.store.save({ composioApiKey: null });
  assert.equal(await f.store.revealKey('composioApiKey'), '');
  assert.deepEqual((await f.store.get()).keys.composioApiKey, {
    suffix: null,
    source: null,
    updatedAt: null,
  });
});

test('unsupported saved schemas fail closed without rewriting or unlocking their contents', async (t) => {
  const f = await fixture(t);
  await f.store.save({ composioApiKey: 'synthetic-retained-key' });
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  const variants = [
    { ...saved, version: 2 },
    { ...saved, provider: 'openai' },
    { ...saved, notifications: undefined },
    { ...saved, secrets: { ...saved.secrets, openaiApiKey: 'unsupported-ciphertext' } },
    { ...saved, keyMetadata: {} },
    {
      ...saved,
      keyMetadata: { composioApiKey: { ...saved.keyMetadata.composioApiKey, source: 'saved' } },
    },
    { ...saved, secrets: {} },
    null,
    [],
  ];
  for (const value of variants) {
    const disk = JSON.stringify(value);
    await writeFile(f.path, disk);
    const store = createSettingsStore(f.path, {
      ...f.encryption,
      isEncryptionAvailable: () => assert.fail('Invalid storage must not access the key store.'),
    });
    await assert.rejects(store.get(), /saved settings/);
    await assert.rejects(store.environment(), /saved settings/);
    await assert.rejects(store.save({ theme: 'dark' }), /saved settings/);
    assert.equal(await readFile(f.path, 'utf8'), disk);
  }
});

test('a keyless installation creates one persistent encrypted vault and only connection changes advance the engine revision', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.get()).hasComposioKey, false);
  const environments = await Promise.all(Array.from({ length: 8 }, () => f.store.environment()));
  const vault = environments[0].OTTO_VAULT_KEY;
  assert.equal(Buffer.from(vault, 'base64').length, 32);
  for (const environment of environments)
    assert.deepEqual(environment, { COMPOSIO_API_KEY: '', OTTO_VAULT_KEY: vault });
  assert.equal((await f.reopen().environment()).OTTO_VAULT_KEY, vault);
  assert.ok(!(await readFile(f.path, 'utf8')).includes(vault));
  const revision = await f.store.revision();
  await f.store.save({ notifications: true, onboardingCompleted: true });
  assert.equal(await f.store.revision(), revision);
  await f.store.save({ composioApiKey: 'synthetic-connection-key' });
  assert.equal(await f.store.revision(), revision + 1);
  await f.store.save({}, { COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'synthetic-auth-config' });
  assert.equal(await f.store.revision(), revision + 2);
  await f.store.save({ composioApiKey: null });
  assert.equal(await f.store.revision(), revision + 3);
  assert.equal((await f.store.environment()).OTTO_VAULT_KEY, vault);
});

test('native feedback waits for the engine and renderer load, then delivers once', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('Feedback must not make an engine request.'));
  f.setReady(false);
  f.showFeedback();
  const setup = f.windows.at(-1);
  assert.ok(setup.path);
  f.setReady(true);
  f.showEngine();
  const window = f.windows.at(-1);
  assert.notEqual(window, setup);
  f.showFeedback();
  assert.deepEqual(window.sent, []);
  window.loading = false;
  window.webContents.emit('did-finish-load');
  assert.deepEqual(window.sent, [['otto:feedback:open', undefined]]);
  window.webContents.emit('did-finish-load');
  assert.equal(window.sent.length, 1);
  f.showFeedback();
  assert.equal(window.sent.length, 2);
  const frame = window.webContents.mainFrame;
  const context = f.handlers.get('otto:feedback:context');
  for (const rejected of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: window.webContents, senderFrame: { url: frame.url } },
    { sender: setup.webContents, senderFrame: setup.webContents.mainFrame },
  ])
    assert.throws(() => context(rejected), /unavailable/);
  frame.url = 'http://127.0.0.1:4310/api/files/synthetic';
  assert.throws(() => context({ sender: window.webContents, senderFrame: frame }), /unavailable/);
});

test('feedback metadata uses installed version and build source with a bounded hostname fallback', async () => {
  const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function feedbackContext('),
    source.indexOf('function availablePort('),
  );
  let commandError;
  let computerName = 'Synthetic Mac\n';
  let sourceRevision = 'a'.repeat(40);
  let modified = false;
  const context = {
    process: { platform: 'darwin', arch: 'arm64' },
    app: { getVersion: () => '1.2.3', isPackaged: true },
    desktopRoot: '/synthetic/desktop',
    join,
    hostname: () => 'synthetic-hostname',
    readFile: async (path) => {
      assert.equal(path, '/synthetic/desktop/package.json');
      return JSON.stringify({ version: '0.0.0', ottoBuild: { source: sourceRevision, modified } });
    },
    execFile: (file, args, options, callback) => {
      assert.equal(file, '/usr/sbin/scutil');
      assert.deepEqual(Array.from(args), ['--get', 'ComputerName']);
      assert.ok(options.timeout > 0);
      assert.ok(options.maxBuffer > 0);
      callback(commandError, computerName);
    },
  };
  runInNewContext(`${body}\nglobalThis.read = feedbackContext;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(await context.read())), {
    computerName: 'Synthetic Mac',
    appVersion: '1.2.3',
    appRelease: sourceRevision,
    appModified: false,
    development: false,
    source: 'desktop',
    platform: 'darwin-arm64',
  });
  commandError = new Error('Synthetic scutil failure');
  sourceRevision = undefined;
  modified = undefined;
  context.app.isPackaged = false;
  assert.deepEqual(JSON.parse(JSON.stringify(await context.read())), {
    computerName: 'synthetic-hostname',
    appVersion: '1.2.3',
    appRelease: null,
    appModified: null,
    development: true,
    source: 'desktop',
    platform: 'darwin-arm64',
  });
  commandError = undefined;
  computerName = ' '.repeat(10);
  assert.equal((await context.read()).computerName, 'synthetic-hostname');
  computerName = 'x'.repeat(300);
  assert.equal((await context.read()).computerName.length, 200);
  context.process.platform = 'linux';
  context.process.arch = 'x64';
  context.execFile = () => assert.fail('Other platforms must not invoke scutil.');
  assert.equal((await context.read()).computerName, 'synthetic-hostname');
  assert.equal((await context.read()).platform, 'linux-x64');
});

test('engine preload limits secret access to Composio and withholds privileged IPC event objects', async () => {
  const calls = [];
  const listeners = new Map();
  let bridge;
  runInNewContext(await readFile(new URL('../preload/engine.cjs', import.meta.url), 'utf8'), {
    require: (name) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: {
          exposeInMainWorld(name, value) {
            assert.equal(name, 'ottoDesktop');
            bridge = value;
          },
        },
        ipcRenderer: {
          invoke: (...args) => calls.push(args),
          on: (channel, receive) => listeners.set(channel, receive),
          removeListener(channel, receive) {
            assert.equal(listeners.get(channel), receive);
            listeners.delete(channel);
          },
        },
      };
    },
  });
  for (const field of [
    'revealKey',
    'getAppPreferences',
    'saveAppPreferences',
    'prepare',
    'importRuntime',
  ])
    assert.equal(bridge[field], undefined);
  bridge.getPreferences();
  bridge.getFeedbackContext();
  bridge.setTheme('dark');
  bridge.openSettings('models');
  bridge.getSettings();
  const settings = { composioApiKey: 'synthetic-connection-key', notifications: true };
  bridge.saveSettings(settings);
  bridge.revealComposioKey('vaultKey');
  bridge.applySettings();
  const ownerId = randomUUID();
  const threadId = randomUUID();
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  bridge.getChatReadCursor(ownerId, threadId);
  bridge.setChatReadCursor(ownerId, threadId, position);
  assert.deepEqual(calls, [
    ['otto:preferences:get'],
    ['otto:feedback:context'],
    ['otto:preferences:theme', 'dark'],
    ['otto:settings:open', 'models'],
    ['otto:settings:get'],
    ['otto:settings:save', settings],
    ['otto:settings:reveal', 'composioApiKey'],
    ['otto:settings:apply'],
    ['otto:chat-read:get', ownerId, threadId],
    ['otto:chat-read:set', ownerId, threadId, position],
  ]);
  let received;
  const unsubscribe = bridge.onPreferences((...values) => {
    received = values;
  });
  const value = { theme: 'dark', resolvedTheme: 'dark', notifications: true, launchAtLogin: false };
  listeners.get('otto:preferences')({ sender: 'privileged-synthetic-ipc' }, value);
  assert.deepEqual(received, [value]);
  unsubscribe();
  assert.equal(listeners.has('otto:preferences'), false);
  const emitSettings = (value) =>
    listeners.get('otto:settings:focus')({ sender: 'privileged-synthetic-ipc' }, value);
  emitSettings('general');
  emitSettings('models');
  const settingsReceived = [];
  const stopSettings = bridge.onOpenSettings((...values) => settingsReceived.push(values));
  assert.deepEqual(settingsReceived, [['models']]);
  emitSettings('invalid');
  emitSettings({ section: 'general' });
  emitSettings('preferences');
  assert.deepEqual(settingsReceived, [['models'], ['preferences']]);
  stopSettings();
  emitSettings('general');
  const resumedSettings = [];
  bridge.onOpenSettings((...values) => resumedSettings.push(values))();
  assert.deepEqual(resumedSettings, [['general']]);
  const noSettingsReplay = [];
  bridge.onOpenSettings((...values) => noSettingsReplay.push(values))();
  assert.deepEqual(noSettingsReplay, []);
  const feedbackReceived = [];
  const emitFeedback = () =>
    listeners.get('otto:feedback:open')({ sender: 'privileged-synthetic-ipc' });
  emitFeedback();
  emitFeedback();
  const stopFeedback = bridge.onFeedbackRequested((...values) => feedbackReceived.push(values));
  assert.deepEqual(feedbackReceived, [[]]);
  emitFeedback();
  assert.deepEqual(feedbackReceived, [[], []]);
  stopFeedback();
  emitFeedback();
  const resumedFeedback = [];
  bridge.onFeedbackRequested((...values) => resumedFeedback.push(values))();
  assert.deepEqual(resumedFeedback, [[]]);
  bridge.onFeedbackRequested(() => assert.fail('A consumed request must not replay.'))();
  assert.throws(() => bridge.onFeedbackRequested(null), /listener/);
  const first = { threadId, messageId: randomUUID() };
  const latest = { threadId, messageId: randomUUID() };
  const delivered = [];
  const emitFocus = (value) =>
    listeners.get('otto:focus-message')({ sender: 'privileged-synthetic-ipc' }, value);
  emitFocus(first);
  emitFocus(latest);
  const stopFocus = bridge.onFocusMessage((value) => delivered.push(value));
  assert.deepEqual(JSON.parse(JSON.stringify(delivered)), [latest]);
  emitFocus(null);
  emitFocus({ threadId: '../other', messageId: latest.messageId });
  assert.deepEqual(JSON.parse(JSON.stringify(delivered)), [latest, null]);
  stopFocus();
  emitFocus(first);
  const resumed = [];
  const stopResumed = bridge.onFocusMessage((value) => resumed.push(value));
  assert.deepEqual(JSON.parse(JSON.stringify(resumed)), [first]);
  stopResumed();
  const noReplay = [];
  bridge.onFocusMessage((value) => noReplay.push(value))();
  assert.deepEqual(noReplay, []);
  assert.deepEqual(JSON.parse(JSON.stringify(delivered)), [latest, null]);
});

async function chatReadFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-chat-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'positions.json');
  const identity = { ownerId: randomUUID() };
  const options = { owner: async () => identity.ownerId };
  return {
    path,
    identity,
    ownerId: identity.ownerId,
    threadId: randomUUID(),
    store: createChatReadCursorStore(path, options),
    reopen: () => createChatReadCursorStore(path, options),
  };
}

test('native chat read positions survive concurrent delayed reads, timestamp ties, and reopen', async (t) => {
  const f = await chatReadFixture(t);
  assert.equal(await f.store.get(f.ownerId, f.threadId), null);
  const earlier = { createdAt: '2026-10-02T09:59:59.999Z', messageIds: [randomUUID()] };
  const first = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  const secondId = randomUUID();
  await Promise.all([
    f.store.set(f.ownerId, f.threadId, first),
    f.store.set(f.ownerId, f.threadId, earlier),
    f.store.set(f.ownerId, f.threadId, { ...first, messageIds: [secondId] }),
  ]);
  await f.store.flush();
  const expected = { ...first, messageIds: [...first.messageIds, secondId].sort() };
  assert.deepEqual(await f.reopen().get(f.ownerId, f.threadId), expected);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const returned = await f.store.get(f.ownerId, f.threadId);
  returned.messageIds.push(randomUUID());
  assert.deepEqual(await f.store.get(f.ownerId, f.threadId), expected);
  const next = { createdAt: '2026-10-02T10:00:00.001Z', messageIds: [randomUUID()] };
  const saving = f.store.set(f.ownerId, f.threadId, next);
  next.messageIds.push(randomUUID());
  await saving;
  assert.deepEqual(await f.reopen().get(f.ownerId, f.threadId), {
    createdAt: next.createdAt,
    messageIds: [next.messageIds[0]],
  });
});

test('native chat read positions reject cross-owner and malformed metadata without changing saved state', async (t) => {
  const f = await chatReadFixture(t);
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  await f.store.set(f.ownerId, f.threadId, position);
  const saved = await readFile(f.path, 'utf8');
  await assert.rejects(f.store.get(randomUUID(), f.threadId), /local profile/);
  await assert.rejects(f.store.set(randomUUID(), f.threadId, position), /local profile/);
  await assert.rejects(f.store.get(f.ownerId, '../../other'), /identity/);
  for (const invalid of [
    { ...position, createdAt: '2026-10-02T10:00:00Z' },
    { ...position, createdAt: '2026-02-30T10:00:00.000Z' },
    { ...position, messageIds: [position.messageIds[0].toUpperCase()] },
    { ...position, messageIds: Array.from({ length: 2049 }, () => randomUUID()) },
    { ...position, content: 'Synthetic message content must never be stored here.' },
  ])
    await assert.rejects(f.store.set(f.ownerId, f.threadId, invalid), /invalid/);
  assert.equal(await readFile(f.path, 'utf8'), saved);
  f.identity.ownerId = randomUUID();
  await assert.rejects(f.store.get(f.ownerId, f.threadId), /local profile/);
  await assert.rejects(f.store.get(f.identity.ownerId, f.threadId), /another profile/);
  assert.equal(await readFile(f.path, 'utf8'), saved);
});

test('native chat read positions fail closed on corruption or profile identity failure', async (t) => {
  const f = await chatReadFixture(t);
  await writeFile(f.path, '{synthetic-malformed-state');
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  await assert.rejects(f.store.get(f.ownerId, f.threadId), /could not open/);
  await assert.rejects(f.store.set(f.ownerId, f.threadId, position), /could not open/);
  assert.equal(await readFile(f.path, 'utf8'), '{synthetic-malformed-state');
  const unavailable = createChatReadCursorStore(f.path, {
    owner: async () => {
      throw new Error('synthetic-sensitive-profile-error');
    },
  });
  await assert.rejects(
    unavailable.get(f.ownerId, f.threadId),
    (error) => error.message === 'Otto could not read its local profile identity.',
  );
});

test('native chat read positions bound retired threads and reject overflowing timestamp ties', async (t) => {
  const f = await chatReadFixture(t);
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  await f.store.set(f.ownerId, f.threadId, position);
  for (let index = 0; index < 32; index++) await f.store.set(f.ownerId, randomUUID(), position);
  assert.equal(await f.reopen().get(f.ownerId, f.threadId), null);
  const full = { ...position, messageIds: Array.from({ length: 2048 }, () => randomUUID()) };
  await f.store.set(f.ownerId, f.threadId, full);
  await assert.rejects(f.store.set(f.ownerId, f.threadId, position), /too many/);
  assert.deepEqual(await f.reopen().get(f.ownerId, f.threadId), {
    ...full,
    messageIds: full.messageIds.sort(),
  });
});

async function preferencesFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-native-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile', 'preferences.json');
  const state = {
    online: false,
    fail: false,
    malformed: false,
    calls: [],
    server: {
      notificationRule: 'synthetic-notification-rule',
      locale: 'pt-PT',
      timeZone: 'Europe/Lisbon',
      hourCycle: 'h23',
      quietHoursEnabled: false,
      quietStart: '23:30',
      quietEnd: '06:45',
    },
  };
  const options = {
    isReady: () => state.online,
    request: async (route, input) => {
      assert.equal(route, '/api/preferences');
      assert.equal(input.redirect, 'error');
      state.calls.push({ method: input.method, body: input.body });
      if (state.fail) return new Response('synthetic-private-failure', { status: 500 });
      if (input.method === 'PATCH') {
        assert.equal(input.headers['content-type'], 'application/json');
        state.server = { ...state.server, ...JSON.parse(input.body) };
        if (state.malformed) return Response.json({ quietStart: '23:00' });
      } else assert.equal(input.method, 'GET');
      return Response.json(state.server);
    },
  };
  return {
    path,
    state,
    store: createAppPreferencesStore(path, options),
    reopen: () => createAppPreferencesStore(path, options),
  };
}

test('offline native preferences retain explicit clears and synchronize only edited fields', async (t) => {
  const f = await preferencesFixture(t);
  await f.store.save({ locale: null, timeZone: null });
  await f.store.save({ quietHoursEnabled: true, quietEnd: '07:15' });
  assert.equal(f.state.calls.length, 0);
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  const stored = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(stored.cached, null);
  assert.deepEqual(stored.pending, {
    locale: null,
    timeZone: null,
    quietHoursEnabled: true,
    quietEnd: '07:15',
  });
  const reopened = f.reopen();
  assert.equal((await reopened.get()).pending, true);
  f.state.online = true;
  const result = await reopened.sync();
  assert.equal(result.pending, false);
  assert.equal(result.preferences.locale, null);
  assert.equal(result.preferences.timeZone, null);
  assert.equal(result.preferences.hourCycle, 'h23');
  assert.equal(result.preferences.quietStart, '23:30');
  assert.equal(f.state.server.notificationRule, 'synthetic-notification-rule');
  assert.deepEqual(
    f.state.calls.map(({ method }) => method),
    ['GET', 'PATCH'],
  );
  assert.deepEqual(JSON.parse(f.state.calls[1].body), stored.pending);
  assert.ok(!JSON.stringify(result).includes('synthetic-notification-rule'));
  assert.ok(!(await readFile(f.path, 'utf8')).includes('synthetic-notification-rule'));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).pending, {});
});

test('native preference reads cache existing server values without replacing them with defaults', async (t) => {
  const f = await preferencesFixture(t);
  await f.store.get();
  assert.equal(f.state.calls.length, 0);
  f.state.online = true;
  const saved = await f.store.get();
  assert.equal(saved.pending, false);
  assert.equal(saved.preferences.locale, 'pt-PT');
  assert.equal(saved.preferences.quietStart, '23:30');
  f.state.server.locale = 'en-GB';
  assert.equal((await f.store.get()).preferences.locale, 'en-GB');
  assert.ok(f.state.calls.every(({ method }) => method === 'GET'));
  f.state.online = false;
  assert.equal((await f.reopen().get()).preferences.locale, 'en-GB');
});

test('failed preference synchronization retains the queue across restarts and blocks ready acknowledgement', async (t) => {
  const f = await preferencesFixture(t);
  await f.store.save({ hourCycle: 'h12' });
  f.state.online = true;
  f.state.fail = true;
  await assert.rejects(f.store.sync(), (error) => {
    assert.equal(error.code, 'PREFERENCES_SYNC_REQUIRED');
    assert.ok(!error.message.includes('synthetic-private-failure'));
    return true;
  });
  const reopened = f.reopen();
  const pending = await reopened.get();
  assert.equal(pending.pending, true);
  assert.equal(pending.preferences.hourCycle, 'h12');
  await assert.rejects(reopened.save({ quietStart: '21:45' }), /could not read your preferences/);
  f.state.fail = false;
  const synchronized = await f.reopen().sync();
  assert.equal(synchronized.pending, false);
  assert.equal(f.state.server.hourCycle, 'h12');
  assert.equal(f.state.server.quietStart, '21:45');
  assert.equal(f.state.server.notificationRule, 'synthetic-notification-rule');
});

test('unconfirmed preference responses cannot discard the durable queue', async (t) => {
  const f = await preferencesFixture(t);
  f.state.online = true;
  f.state.malformed = true;
  await assert.rejects(f.store.save({ quietEnd: '09:30' }), /could not read your preferences/);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).pending, { quietEnd: '09:30' });
  f.state.malformed = false;
  const result = await f.reopen().sync();
  assert.equal(result.pending, false);
  assert.equal(result.preferences.quietEnd, '09:30');
});

test('native preferences reject unsupported fields and invalid values before persistence or network access', async (t) => {
  const f = await preferencesFixture(t);
  await f.store.save({ locale: 'en-gb' });
  const previous = await readFile(f.path, 'utf8');
  f.state.online = true;
  for (const input of [
    { notificationRule: 'changed' },
    { provider: 'anthropic' },
    { locale: 'invalid_locale' },
    { locale: true },
    { timeZone: 'invalid/timezone' },
    { timeZone: '+01:00' },
    { hourCycle: 'h24' },
    { quietHoursEnabled: 1 },
    { quietStart: '24:00' },
    { quietEnd: '07:60' },
    { quietEnd: null },
    { quietEnd: undefined },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) {
    await assert.rejects(f.store.save(input));
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
  assert.equal(f.state.calls.length, 0);
  f.state.online = false;
  assert.equal((await f.store.get()).preferences.locale, 'en-GB');
});

test('serialized preference changes preserve independent edits and malformed storage fails closed', async (t) => {
  const f = await preferencesFixture(t);
  await Promise.all([
    f.store.save({ locale: 'en-GB' }),
    f.store.save({ quietStart: '21:00' }),
    f.store.save({ quietEnd: '07:00' }),
    f.store.save({ locale: null }),
  ]);
  const result = await f.reopen().get();
  assert.equal(result.preferences.locale, null);
  assert.equal(result.preferences.quietStart, '21:00');
  assert.equal(result.preferences.quietEnd, '07:00');
  await writeFile(f.path, '{"version":1,"cached":null,"pending":{"notificationRule":"bad"}}');
  const malformed = await readFile(f.path, 'utf8');
  await assert.rejects(f.reopen().get(), /could not open its saved preferences/);
  await assert.rejects(
    f.reopen().save({ quietEnd: '08:00' }),
    /could not open its saved preferences/,
  );
  assert.equal(await readFile(f.path, 'utf8'), malformed);
});

function updateReleaseFixture(sourceUrl) {
  const archive = {
    file: `Otto-Runtime-darwin-arm64-${'b'.repeat(12)}.tar.gz`,
    bytes: 180,
    sha256: 'c'.repeat(64),
  };
  const runtime = { id: 'b'.repeat(64), fingerprint: 'd'.repeat(64), archive };
  const item = (id, name, size) => ({
    id,
    name,
    size,
    state: 'uploaded',
    digest: `sha256:${name.endsWith('.zip') ? 'e'.repeat(64) : 'c'.repeat(64)}`,
  });
  const release = {
    id: 12,
    tag_name: 'desktop-v0.2.0',
    draft: false,
    prerelease: true,
    assets: [
      item(101, 'release.json', 300),
      item(103, 'Otto-arm64.zip', 1000),
      item(102, 'runtime-release.json', 500),
      item(104, 'update.json', 150),
    ],
  };
  const pack = {
    id: 18,
    tag_name: `runtime-darwin-arm64-${runtime.fingerprint}`,
    draft: false,
    assets: [item(201, archive.file, archive.bytes)],
  };
  const manifest = {
    version: '0.2.0',
    platform: 'darwin-arm64',
    source: 'a'.repeat(40),
    signing: { mode: 'self-signed' },
    runtime,
    update: { file: 'Otto-arm64.zip', bytes: 1000, sha256: 'e'.repeat(64) },
  };
  const base = sourceUrl || 'https://api.github.com/repos/n8n-io/otto';
  const assetPath = (owner, entry) =>
    sourceUrl
      ? `${base}/releases/${owner.id}/assets/${entry.id}/${entry.name}`
      : `${base}/releases/assets/${entry.id}`;
  const values = new Map([
    [
      `${base}/releases${sourceUrl ? '' : '?per_page=100'}`,
      [
        { ...release, id: 11, tag_name: 'desktop-v0.1.0' },
        { ...release, id: 13, tag_name: 'desktop-v9.0.0', draft: true },
        { ...release, id: 14, tag_name: 'runtime-darwin-arm64-irrelevant' },
        release,
      ],
    ],
    [`${base}/releases/12`, release],
    [`${base}/${sourceUrl ? 'tags' : 'releases/tags'}/${pack.tag_name}`, pack],
    [assetPath(release, release.assets[0]), manifest],
    [assetPath(release, release.assets[2]), runtime],
    [
      assetPath(release, release.assets[3]),
      {
        url: 'https://github.com/n8n-io/otto/releases/download/desktop-v0.2.0/Otto-arm64.zip',
        name: 'Otto 0.2.0',
      },
    ],
  ]);
  const calls = [];
  const source = createUpdateSource({
    sourceUrl,
    fetch: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.authorization, undefined);
      assert.ok(values.has(url), `Unexpected release request ${url}`);
      return Response.json(values.get(url));
    },
  });
  return { source, calls, values, release, pack, runtime, manifest, base };
}

test('desktop updates bind newer published releases and both source adapters to exact app and runtime assets', async () => {
  for (const suffix of ['?', '#'])
    assert.throws(
      () => createUpdateSource({ sourceUrl: `https://updates.example.invalid/otto${suffix}` }),
      /source is invalid/,
    );
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/otto-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    const candidate = await f.source.latest('0.1.0');
    assert.equal(candidate.version, '0.2.0');
    assert.equal(candidate.runtime.archive.sha256, f.runtime.archive.sha256);
    assert.equal(
      candidate.downloadUrl,
      sourceUrl
        ? `${sourceUrl}/releases/18/assets/201/${f.runtime.archive.file}`
        : 'https://api.github.com/repos/n8n-io/otto/releases/assets/201',
    );
    assert.equal(
      candidate.feedUrl,
      sourceUrl
        ? `${sourceUrl}/releases/12/feed/103?version=0.1.0&platform=darwin-arm64`
        : 'https://github.com/n8n-io/otto/releases/download/desktop-v0.2.0/update.json',
    );
    f.calls.length = 0;
    assert.equal(await f.source.latest('0.2.0'), undefined);
    assert.equal(f.calls.length, 1);
    f.manifest.runtime = { ...f.runtime, id: 'f'.repeat(64) };
    await assert.rejects(f.source.latest('0.1.0'), /runtime does not match/);
    f.manifest.runtime = f.runtime;
    f.pack.assets[0].size++;
    await assert.rejects(f.source.latest('0.1.0'), /archive size does not match/);
    f.pack.assets[0].size--;
    f.release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(f.source.latest('0.1.0'), /archive digest does not match/);
    f.release.assets[1].digest = `sha256:${f.manifest.update.sha256}`;
    f.release.assets.push({ ...f.release.assets[0], id: 999 });
    await assert.rejects(f.source.latest('0.1.0'), /incomplete/);
  }
});

test('first installation resolves its exact published runtime without a newer app and rejects changed identities', async () => {
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/otto-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    assert.equal(await f.source.latest('0.2.0'), undefined);
    f.calls.length = 0;
    assert.equal(
      await f.source.runtimeDownloadUrl(f.runtime),
      sourceUrl
        ? `${sourceUrl}/releases/18/assets/201/${f.runtime.archive.file}`
        : 'https://api.github.com/repos/n8n-io/otto/releases/assets/201',
    );
    assert.deepEqual(f.calls, [
      `${f.base}/${sourceUrl ? 'tags' : 'releases/tags'}/${f.pack.tag_name}`,
    ]);
    for (const change of [
      (runtime) => (runtime.fingerprint = '../other'),
      (runtime) => (runtime.id = 'invalid'),
      (runtime) => (runtime.archive.file = '../runtime.tar.gz'),
      (runtime) => (runtime.archive.file = `Otto-Runtime-darwin-arm64-${'f'.repeat(12)}.tar.gz`),
      (runtime) => (runtime.archive.bytes = 0),
      (runtime) => (runtime.archive.bytes = 1.5),
      (runtime) => (runtime.archive.sha256 = 'invalid'),
    ]) {
      const runtime = structuredClone(f.runtime);
      change(runtime);
      f.calls.length = 0;
      await assert.rejects(f.source.runtimeDownloadUrl(runtime));
      assert.deepEqual(f.calls, []);
    }
    for (const change of [
      (pack) => (pack.draft = true),
      (pack) => (pack.tag_name = `runtime-darwin-arm64-${'f'.repeat(64)}`),
      (pack) => (pack.id = 0),
      (pack) => (pack.assets[0].id = 0),
      (pack) => (pack.assets[0].name = 'another-runtime.tar.gz'),
      (pack) => pack.assets.push({ ...pack.assets[0], id: 202 }),
      (pack) => (pack.assets[0].state = 'new'),
      (pack) => pack.assets[0].size++,
      (pack) => (pack.assets[0].digest = `sha256:${'f'.repeat(64)}`),
    ]) {
      const changed = updateReleaseFixture(sourceUrl);
      change(changed.pack);
      await assert.rejects(changed.source.runtimeDownloadUrl(changed.runtime));
      assert.equal(changed.calls.length, 1);
    }
  }
});

test('desktop update discovery repeats after failures and clock changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const powerMonitor = new EventEmitter();
  const pending = deferred();
  let attempts = 0;
  const stop = startDesktopUpdateChecks({
    interval: 1_000,
    powerMonitor,
    check: async () => {
      attempts++;
      if (attempts === 1) await pending.promise;
      if (attempts === 2) throw new Error('Network unavailable');
    },
  });
  t.after(stop);
  assert.equal(attempts, 1);
  t.mock.timers.tick(5_000);
  assert.equal(attempts, 1);
  pending.resolve();
  await new Promise(setImmediate);
  powerMonitor.emit('resume');
  t.mock.timers.tick(999);
  assert.equal(attempts, 1);
  t.mock.timers.tick(1);
  assert.equal(attempts, 2);
  await new Promise(setImmediate);
  t.mock.timers.setTime(20_000);
  powerMonitor.emit('resume');
  assert.equal(attempts, 3);
  await new Promise(setImmediate);
  t.mock.timers.tick(1_000);
  assert.equal(attempts, 4);
  await new Promise(setImmediate);
  t.mock.method(Date, 'now', () => 5_000);
  t.mock.timers.tick(1_000);
  assert.equal(attempts, 5);
  stop();
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000);
  powerMonitor.emit('resume');
  assert.equal(attempts, 5);
  assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('waking during a pending update check queues one check and quit cancels it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const powerMonitor = new EventEmitter();
  const first = deferred();
  const last = deferred();
  let attempts = 0;
  const stop = startDesktopUpdateChecks({
    interval: 1_000,
    powerMonitor,
    check: async () => {
      attempts++;
      if (attempts === 1) await first.promise;
      if (attempts === 3) await last.promise;
    },
  });
  t.after(stop);
  t.mock.timers.tick(5_000);
  powerMonitor.emit('resume');
  powerMonitor.emit('resume');
  assert.equal(attempts, 1);
  first.reject(new Error('Connection lost during sleep'));
  await new Promise(setImmediate);
  t.mock.timers.tick(0);
  assert.equal(attempts, 2);
  await new Promise(setImmediate);
  powerMonitor.emit('resume');
  assert.equal(attempts, 2);
  t.mock.timers.tick(1_000);
  powerMonitor.emit('resume');
  assert.equal(attempts, 3);
  stop();
  last.resolve();
  await new Promise(setImmediate);
  t.mock.timers.tick(10_000);
  powerMonitor.emit('resume');
  assert.equal(attempts, 3);
  assert.equal(powerMonitor.listenerCount('resume'), 0);
});

test('desktop staging waits for runtime preparation and a native downloaded event, and retries preparation only explicitly', async () => {
  const candidate = {
    version: '0.2.0',
    source: 'a'.repeat(40),
    feedUrl: 'https://updates.example.invalid/releases/12/feed/103',
  };
  const native = new EventEmitter();
  const prepared = deferred();
  const started = deferred();
  const events = [];
  native.setFeedURL = ({ url }) => events.push(url);
  native.checkForUpdates = () => events.push('stage');
  let attempts = 0;
  const updater = createDesktopUpdater({
    source: { latest: async () => candidate },
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async () => {
      attempts++;
      started.resolve();
      await prepared.promise;
      events.push('runtime verified');
    },
    restart: async () => events.push('restart'),
  });
  const check = updater.check();
  assert.equal(check, updater.check());
  await started.promise;
  assert.deepEqual(events, []);
  prepared.reject(new Error('Corrupt runtime archive'));
  await assert.rejects(check, /Corrupt runtime/);
  assert.equal(attempts, 1);
  assert.equal(updater.ready, undefined);
  const readyRuntime = deferred();
  const next = createDesktopUpdater({
    source: { latest: async () => candidate },
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async () => {
      events.push('runtime verified');
      readyRuntime.resolve();
    },
    restart: async () => events.push('restart'),
  });
  const staged = next.check();
  await readyRuntime.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['runtime verified', candidate.feedUrl, 'stage']);
  assert.equal(next.ready, undefined);
  native.emit('update-downloaded', {}, '', 'Otto 0.2.0');
  assert.equal(await staged, candidate);
  assert.equal(await next.check(), candidate);
  assert.equal(events.includes('restart'), false);
  await next.restart();
  assert.equal(events.at(-1), 'restart');
  updater.dispose();
  next.dispose();
});

test('desktop no-update checks and failed native downloads never restart', async () => {
  const native = new EventEmitter();
  native.setFeedURL = () => {};
  native.checkForUpdates = () =>
    queueMicrotask(() => native.emit('error', new Error('Download failed')));
  let candidate;
  let prepared = 0;
  const updater = createDesktopUpdater({
    source: { latest: async () => candidate },
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async () => {
      prepared++;
    },
    restart: async () => assert.fail('Unexpected restart'),
  });
  assert.equal(await updater.check(), undefined);
  assert.equal(prepared, 0);
  candidate = { version: '0.2.0', feedUrl: 'https://updates.example.invalid/pinned' };
  await assert.rejects(updater.check(), /Download failed/);
  assert.equal(updater.ready, undefined);
  await assert.rejects(updater.restart(), /No desktop update/);
  updater.dispose();
});

test('desktop restart fences drafts and active work, resumes failed drains, and closes the existing lifecycle before install', async () => {
  const candidate = { source: 'a'.repeat(40) };
  for (const scenario of [
    'draft',
    'busy',
    'drain failed',
    'flush failed',
    'shutdown failed',
    'ready',
  ]) {
    const events = [];
    const transitions = [];
    const lifecycle = createDesktopLifecycle({
      prepareRuntime: async () => ({ close: async () => events.push('runtime closed') }),
      validateStart: async () => {},
      startEngine: async () => {},
      stopEngine: async () => events.push('engine stopped'),
      onRuntimeStatus: () => {},
    });
    await lifecycle.start();
    const options = {
      candidate,
      guard: async () => {
        events.push('guard');
        if (scenario === 'draft') throw new Error('Draft');
        return () => events.push('renderer resumed');
      },
      request: async (path, options) => {
        events.push(path);
        if (path.endsWith('/status')) return Response.json({ activeWork: scenario === 'busy' });
        transitions.push(JSON.parse(options.body));
        if (path.endsWith('/drain')) return Response.json({ drained: scenario !== 'drain failed' });
        return Response.json({ ok: true });
      },
      flush: async () => {
        events.push('cursors flushed');
        if (scenario === 'flush failed') throw new Error('Disk unavailable');
      },
      shutdown: async () => {
        await lifecycle.close();
        if (scenario === 'shutdown failed') throw new Error('Native install unavailable');
        events.push('native install');
      },
    };
    if (scenario === 'ready') {
      await restartDesktopUpdate(options);
      assert.deepEqual(events, [
        'guard',
        '/api/desktop/status',
        '/api/runtime/drain',
        'cursors flushed',
        'engine stopped',
        'runtime closed',
        'native install',
      ]);
      assert.equal(transitions[0].targetRelease, candidate.source);
    } else {
      await assert.rejects(restartDesktopUpdate(options));
      assert.equal(events.includes('native install'), false);
      assert.equal(events.includes('engine stopped'), scenario === 'shutdown failed');
      if (scenario === 'draft') assert.deepEqual(events, ['guard']);
      if (scenario === 'busy')
        assert.deepEqual(events, ['guard', '/api/desktop/status', 'renderer resumed']);
      if (scenario === 'flush failed') {
        assert.equal(events.at(-1), 'renderer resumed');
        assert.deepEqual(transitions[0], transitions[1]);
      }
      if (scenario === 'shutdown failed') {
        assert.equal(events.includes('renderer resumed'), false);
        assert.equal(events.includes('/api/runtime/resume'), false);
        assert.equal(transitions.length, 1);
      }
      if (scenario === 'drain failed') {
        assert.deepEqual(events, [
          'guard',
          '/api/desktop/status',
          '/api/runtime/drain',
          '/api/runtime/resume',
          'renderer resumed',
        ]);
        assert.deepEqual(transitions[0], transitions[1]);
      }
      await lifecycle.close();
    }
  }
});

test('trusted preload blocks unknown or dirty renderers and restores interaction after a canceled restart', async () => {
  const ipc = new EventEmitter();
  const renderer = new EventEmitter();
  const document = { documentElement: { inert: false } };
  let bridge;
  let dirty = true;
  let forged = false;
  const frame = {};
  const window = {
    isDestroyed: () => false,
    webContents: Object.assign(new EventEmitter(), {
      mainFrame: frame,
      send: (channel, token) => renderer.emit(channel, {}, token),
    }),
  };
  runInNewContext(await readFile(new URL('../preload/engine.cjs', import.meta.url), 'utf8'), {
    document,
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (_name, value) => {
          bridge = value;
        },
      },
      ipcRenderer: {
        on: (channel, receive) => renderer.on(channel, receive),
        send: (channel, value) =>
          ipc.emit(
            channel,
            { sender: window.webContents, senderFrame: forged ? {} : frame },
            value,
          ),
      },
    }),
  });
  const guard = () =>
    guardUpdateRenderers({
      windows: [window],
      ipc,
      timeout: 20,
      trusted: (event) => event.sender === window.webContents && event.senderFrame === frame,
    });
  await assert.rejects(guard(), /draft/);
  const stop = bridge.onPrepareUpdate(() => !dirty);
  await assert.rejects(guard(), /draft/);
  assert.equal(document.documentElement.inert, false);
  dirty = false;
  forged = true;
  await assert.rejects(guard(), /draft/);
  assert.equal(document.documentElement.inert, false);
  forged = false;
  const release = await guard();
  assert.equal(document.documentElement.inert, true);
  window.webContents.emit('did-start-navigation');
  assert.throws(release.validate, /window changed/);
  renderer.emit('otto:update:resume', {}, randomUUID());
  assert.equal(document.documentElement.inert, true);
  release();
  assert.equal(document.documentElement.inert, false);
  stop();
  await assert.rejects(guard(), /draft/);
  assert.equal(ipc.listenerCount('otto:update:prepared'), 0);
});

test('native download attempts remain exclusive until their terminal event and reject a different release', async () => {
  let selections = 0;
  const native = new EventEmitter();
  const staged = deferred();
  native.setFeedURL = () => {};
  native.checkForUpdates = () => staged.resolve();
  const updater = createDesktopUpdater({
    source: {
      latest: async () => {
        selections++;
        return {
          version: selections === 1 ? '0.2.0' : '0.3.0',
          feedUrl: 'https://updates.example.invalid/pinned',
        };
      },
    },
    currentVersion: '0.1.0',
    native,
    prepareRuntime: async () => {},
    restart: async () => {},
  });
  const first = updater.check();
  await staged.promise;
  assert.equal(updater.check(), first);
  assert.equal(selections, 1);
  native.emit('update-downloaded', {}, '', 'Otto 0.2.0');
  assert.equal((await first).version, '0.2.0');
  assert.equal((await updater.check()).version, '0.2.0');
  assert.equal(selections, 1);
  updater.dispose();
  const wrongNative = new EventEmitter();
  wrongNative.setFeedURL = () => {};
  wrongNative.checkForUpdates = () =>
    queueMicrotask(() => wrongNative.emit('update-downloaded', {}, '', 'Otto 0.1.0'));
  const wrong = createDesktopUpdater({
    source: {
      latest: async () => ({ version: '0.2.0', feedUrl: 'https://updates.example.invalid/pinned' }),
    },
    currentVersion: '0.1.0',
    native: wrongNative,
    prepareRuntime: async () => {},
    restart: async () => assert.fail('Wrong version must not restart'),
  });
  await assert.rejects(wrong.check(), /does not match the selected version/);
  assert.equal(wrong.ready, undefined);
  wrong.dispose();
});

test('post-drain shutdown and native install failures retry the same closed lifecycle without restoring the engine', async () => {
  const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function finishQuit('),
    source.indexOf('async function validateStart('),
  );
  const events = [];
  let closes = 0;
  let installs = 0;
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async () => ({
      close: async () => {
        events.push('runtime close');
        if (++closes === 1) throw new Error('Synthetic runtime stop failed');
      },
    }),
    validateStart: async () => {},
    startEngine: async () => {},
    stopEngine: async () => events.push('engine stopped'),
    onRuntimeStatus: () => {},
  });
  await lifecycle.start();
  const context = {
    lifecycle,
    writeDiagnostic: async () => {},
    dialog: {
      showMessageBox: async () => {
        events.push('retry offered');
        return { response: 0 };
      },
    },
    app: { exit: () => assert.fail('No forced quit') },
  };
  runInNewContext(`${body}\nglobalThis.finish = finishQuit;`, context);
  await context.finish(async () => {
    events.push('install');
    if (++installs === 1) throw new Error('Synthetic native install failed');
  });
  assert.deepEqual(events, [
    'engine stopped',
    'runtime close',
    'retry offered',
    'engine stopped',
    'runtime close',
    'install',
    'retry offered',
    'install',
  ]);
  assert.throws(() => lifecycle.start(), /closing/);
});

test('late renderer acknowledgements cannot authorize another update restart', async () => {
  const ipc = new EventEmitter();
  let token;
  const contents = Object.assign(new EventEmitter(), {
    send: (channel, value) => {
      if (channel === 'otto:update:prepare') token = value;
    },
  });
  const window = { isDestroyed: () => false, webContents: contents };
  const options = {
    windows: [window],
    ipc,
    timeout: 20,
    trusted: (event) => event.sender === contents,
  };
  await assert.rejects(guardUpdateRenderers(options), /draft/);
  const expired = token;
  const pending = guardUpdateRenderers(options);
  let settled = false;
  pending.then(() => {
    settled = true;
  });
  ipc.emit('otto:update:prepared', { sender: contents }, { token: expired, blocked: false });
  await Promise.resolve();
  assert.equal(settled, false);
  ipc.emit('otto:update:prepared', { sender: contents }, { token, blocked: false });
  const release = await pending;
  release();
  assert.equal(ipc.listenerCount('otto:update:prepared'), 0);
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
});

test('choosing Later keeps restart available without repeated background prompts', async () => {
  const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function checkForUpdates('),
    source.indexOf('async function restartForUpdate('),
  );
  const candidate = { version: '0.2.0' };
  let checks = 0;
  let prompts = 0;
  let restarts = 0;
  const updates = {
    ready: undefined,
    check: async () => {
      checks++;
      updates.ready = candidate;
      return candidate;
    },
    restart: async () => restarts++,
  };
  const context = {
    updates,
    quitting: false,
    checkingUpdates: undefined,
    dialog: {
      showMessageBox: async () => ({ response: ++prompts === 1 ? 1 : 0 }),
    },
    refreshUpdateMenu: () => {},
    writeDiagnostic: async () => {},
    bounded: String,
  };
  runInNewContext(`${body}\nglobalThis.check = checkForUpdates;`, context);
  await context.check(false);
  assert.equal(prompts, 1);
  assert.equal(restarts, 0);
  await context.check(false);
  assert.equal(checks, 1);
  assert.equal(prompts, 1);
  await context.check();
  assert.equal(prompts, 2);
  assert.equal(restarts, 1);
});

test('main update restart preserves the renderer navigation fence through its quitting wrapper', async () => {
  const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function restartForUpdate('),
    source.indexOf('async function finishQuit('),
  );
  const ipc = new EventEmitter();
  const events = [];
  const contents = Object.assign(new EventEmitter(), {
    send: (channel, token) => {
      if (channel === 'otto:update:prepare')
        ipc.emit('otto:update:prepared', { sender: contents }, { token, blocked: false });
      else events.push(channel);
    },
  });
  const window = { isDestroyed: () => false, webContents: contents };
  const context = {
    restartDesktopUpdate,
    guardUpdateRenderers,
    quitting: false,
    engine: {},
    status: { phase: 'ready' },
    lifecycle: { engineStarting: false },
    setupWindow: undefined,
    engineWindows: new Set([window]),
    ipcMain: ipc,
    isEngine: (event) => event.sender === contents,
    engineRequest: async (path) => {
      events.push(path);
      if (path.endsWith('/status')) return Response.json({ activeWork: false });
      if (path.endsWith('/drain')) {
        contents.emit('did-start-navigation');
        return Response.json({ drained: true });
      }
      return Response.json({ ok: true });
    },
    chatReadCursors: { flush: async () => events.push('flushed') },
    updateReadinessNotice: () => assert.fail('Navigation must prevent shutdown'),
  };
  runInNewContext(`${body}\nglobalThis.restart = restartForUpdate;`, context);
  await assert.rejects(context.restart({ source: 'a'.repeat(40) }), /window changed/);
  assert.equal(context.quitting, false);
  assert.deepEqual(events, [
    '/api/desktop/status',
    '/api/runtime/drain',
    'flushed',
    '/api/runtime/resume',
    'otto:update:resume',
  ]);
  assert.equal(contents.listenerCount('did-start-navigation'), 0);
});

test('uncertain update resumes retain the renderer fence until explicit retry succeeds or Otto quits', async (t) => {
  const source = await readFile(new URL('../main/main.mjs', import.meta.url), 'utf8');
  const body = source.slice(
    source.indexOf('async function restartForUpdate('),
    source.indexOf('async function validateStart('),
  );
  const failures = {
    unavailable: () => Response.json({ ok: true }, { status: 503 }),
    rejected: () => Response.json({ ok: false }),
    malformed: () => new Response('not json'),
    disconnected: () => {
      throw new Error('Synthetic connection closed');
    },
  };
  for (const [name, failure] of Object.entries(failures)) {
    for (const response of [0, 1]) {
      await t.test(`${name}: ${response === 0 ? 'retry' : 'quit'}`, async () => {
        const offered = deferred();
        const choice = deferred();
        const events = [];
        const transitions = [];
        const ipc = new EventEmitter();
        let attempts = 0;
        const contents = Object.assign(new EventEmitter(), {
          send: (channel, token) => {
            if (channel === 'otto:update:prepare')
              ipc.emit('otto:update:prepared', { sender: contents }, { token, blocked: false });
            else events.push(channel);
          },
        });
        const context = {
          restartDesktopUpdate,
          guardUpdateRenderers,
          quitting: false,
          engine: {},
          status: { phase: 'ready' },
          lifecycle: {
            engineStarting: false,
            close: async () => events.push('lifecycle closed'),
          },
          setupWindow: undefined,
          engineWindows: new Set([{ isDestroyed: () => false, webContents: contents }]),
          ipcMain: ipc,
          isEngine: (event) => event.sender === contents,
          engineRequest: async (path, options) => {
            events.push(path);
            if (path.endsWith('/status')) return Response.json({ activeWork: false });
            transitions.push(JSON.parse(options.body));
            if (path.endsWith('/drain')) {
              contents.emit('did-start-navigation');
              return Response.json({ drained: true });
            }
            assert.equal(path, '/api/runtime/resume');
            return ++attempts === 1 ? failure() : Response.json({ ok: true });
          },
          chatReadCursors: { flush: async () => events.push('flushed') },
          updateReadinessNotice: () => assert.fail('Canceled update must not install'),
          writeDiagnostic: async () => {},
          dialog: {
            showMessageBox: async () => {
              events.push('recovery offered');
              offered.resolve();
              return choice.promise;
            },
          },
          app: { exit: () => events.push('exit') },
        };
        runInNewContext(`${body}\nglobalThis.restart = restartForUpdate;`, context);
        const result = context.restart({ source: 'a'.repeat(40) }).then(
          () => ({ completed: true }),
          (error) => ({ error }),
        );
        await Promise.race([
          offered.promise,
          result.then(() => assert.fail('Unconfirmed resume must offer recovery')),
        ]);
        assert.equal(context.quitting, true);
        assert.equal(attempts, 1);
        assert.equal(events.includes('otto:update:resume'), false);
        assert.equal(events.includes('lifecycle closed'), false);
        choice.resolve({ response });
        const outcome = await result;
        assert.ok(outcome.error);
        assert.equal(attempts, response === 0 ? 2 : 1);
        assert.ok(
          transitions.every(
            (transition) => JSON.stringify(transition) === JSON.stringify(transitions[0]),
          ),
        );
        if (response === 0) {
          assert.match(outcome.error.message, /window changed/);
          assert.equal(context.quitting, false);
          assert.equal(events.at(-1), 'otto:update:resume');
          assert.equal(events.includes('lifecycle closed'), false);
          assert.equal(contents.listenerCount('did-start-navigation'), 0);
        } else {
          assert.equal(context.quitting, true);
          assert.equal(events.includes('otto:update:resume'), false);
          assert.deepEqual(events.slice(-2), ['lifecycle closed', 'exit']);
        }
      });
    }
  }
});
