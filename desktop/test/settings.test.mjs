import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import { createSettingsStore } from '../main/settings.mjs';
import { createDesktopAnalytics } from '../main/analytics.mjs';
import { createAppPreferencesStore } from '../main/app-preferences.mjs';
import { createChatReadCursorStore } from '../main/chat-read-cursors.mjs';
import { createReadinessNotice, isQuietTime } from '../main/notifications.mjs';
import { saveArtifactDownload } from '../main/downloads.mjs';
import { createDesktopLifecycle, desktopSetupMode } from '../main/lifecycle.mjs';
import {
  createDesktopUpdater,
  createUpdateSource,
  startDesktopUpdateChecks,
} from '../main/updates.mjs';
import { protectWindowsProfile, stageWindowsUpdate } from '../runtime/windows.mjs';
import { buildDesktopUI } from '../scripts/build-ui.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function artifactDownload(overrides = {}) {
  const url = 'http://127.0.0.1:4310/api/artifacts/1a76a5b0-899f-4d18-aaf2-c5f7b4924938';
  return Object.assign(
    new EventEmitter(),
    {
      hasUserGesture: () => true,
      getInitiatorOrigin: () => 'http://127.0.0.1:4310',
      getURL: () => url,
      getURLChain: () => [url],
      getFilename: () => 'report.csv',
      setSavePath(path) {
        this.savedPath = path;
      },
    },
    overrides,
  );
}

async function artifactDownloads(t) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-artifact-downloads-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const errors = [];
  return {
    directory,
    errors,
    start(overrides = {}, options = {}) {
      const item = artifactDownload(overrides);
      const event = {
        preventDefault() {
          this.prevented = true;
        },
      };
      const handled = saveArtifactDownload(event, item, {
        origin: 'http://127.0.0.1:4310',
        directory,
        onError: (path) => errors.push(path),
        ...options,
      });
      return { item, event, handled };
    },
  };
}

test('artifact downloads publish complete bytes without replacing colliding files, directories, or symlinks', async (t) => {
  const f = await artifactDownloads(t);
  await writeFile(join(f.directory, 'report.csv'), 'previous file');
  await mkdir(join(f.directory, 'report (1).csv'));
  await writeFile(join(f.directory, 'existing.csv'), 'symlink target');
  await symlink(join(f.directory, 'existing.csv'), join(f.directory, 'report (2).csv'));
  const downloads = [f.start(), f.start()];
  for (const [index, { item, event, handled }] of downloads.entries()) {
    assert.equal(handled, true);
    assert.equal(event.prevented, undefined);
    assert.equal(dirname(dirname(item.savedPath)), f.directory);
    if (process.platform !== 'win32')
      assert.equal((await stat(dirname(item.savedPath))).mode & 0o777, 0o700);
    await writeFile(item.savedPath, `new file ${index}`);
  }
  assert.notEqual(downloads[0].item.savedPath, downloads[1].item.savedPath);
  await assert.rejects(stat(join(f.directory, 'report (3).csv')), { code: 'ENOENT' });
  await Promise.all(
    downloads.map(
      ({ item }) =>
        new Promise((resolve) =>
          setImmediate(() => {
            item.emit('done', {}, 'completed');
            resolve();
          }),
        ),
    ),
  );
  assert.equal(await readFile(join(f.directory, 'report.csv'), 'utf8'), 'previous file');
  assert.equal((await stat(join(f.directory, 'report (1).csv'))).isDirectory(), true);
  assert.equal(await readFile(join(f.directory, 'existing.csv'), 'utf8'), 'symlink target');
  assert.equal(await readFile(join(f.directory, 'report (3).csv'), 'utf8'), 'new file 0');
  assert.equal(await readFile(join(f.directory, 'report (4).csv'), 'utf8'), 'new file 1');
  for (const { item } of downloads)
    await assert.rejects(stat(dirname(item.savedPath)), { code: 'ENOENT' });
  assert.deepEqual(f.errors, []);
});

test('artifact downloads leave foreign, redirected, ambiguous, and non-user sources to Electron', async (t) => {
  const f = await artifactDownloads(t);
  const url = artifactDownload().getURL();
  for (const overrides of [
    { hasUserGesture: () => false },
    { getInitiatorOrigin: () => '' },
    { getInitiatorOrigin: () => 'null' },
    { getInitiatorOrigin: () => 'https://example.test' },
    ...[
      url.replace('4310', '4311'),
      url.replace('/api/artifacts/', '/api/files/'),
      url.replace('1a76a5b0', 'invalid'),
      `${url}?download=1`,
      `${url}?`,
      `${url}#download`,
      `${url}#`,
      url.replace('http://', 'http://user:password@'),
    ].map((value) => ({ getURL: () => value, getURLChain: () => [value] })),
    { getURLChain: () => ['https://example.test/download', url] },
    { getURLChain: () => [url, url] },
    { getURLChain: () => [] },
    { getURLChain: () => ['https://example.test/download'] },
  ]) {
    const { handled, item, event } = f.start(overrides);
    assert.equal(handled, false);
    assert.equal(item.savedPath, undefined);
    assert.equal(item.listenerCount('done'), 0);
    assert.equal(event.prevented, undefined);
  }
  assert.equal(f.start({}, { origin: '' }).handled, false);
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.errors, []);
});

test('artifact filenames cannot escape Downloads and ordinary names keep their extension', async (t) => {
  const f = await artifactDownloads(t);
  for (const [input, expected] of [
    ['../outside.pdf', 'outside.pdf'],
    ['..\\folder\\windows.txt', 'windows.txt'],
    ['notes\r\n\0.txt', 'notes.txt'],
    ['.', 'download'],
    ['..', 'download (1)'],
    ['', 'download (2)'],
    ['Résumé 2026.pdf', 'Résumé 2026.pdf'],
    ['archive.tar.gz', 'archive.tar.gz'],
    ['archive.tar.gz', 'archive.tar (1).gz'],
  ]) {
    const { item } = f.start({ getFilename: () => input });
    await writeFile(item.savedPath, 'synthetic artifact');
    item.emit('done', {}, 'completed');
    assert.equal(await readFile(join(f.directory, expected), 'utf8'), 'synthetic artifact');
  }
  assert.deepEqual(f.errors, []);
});

test('artifact downloads clean terminal failures without discarding resumable downloads', async (t) => {
  const f = await artifactDownloads(t);
  for (const state of ['cancelled', 'interrupted']) {
    const { item } = f.start();
    await writeFile(item.savedPath, 'partial artifact');
    item.emit('updated', {}, 'interrupted');
    assert.equal(await readFile(item.savedPath, 'utf8'), 'partial artifact');
    item.emit('done', {}, state);
    await assert.rejects(stat(dirname(item.savedPath)), { code: 'ENOENT' });
  }
  assert.deepEqual(await readdir(f.directory), []);
  assert.deepEqual(f.errors, [undefined]);
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
  await assert.rejects(lifecycle.start());
  assert.equal(lifecycle.engineStarting, false);
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
});

test('failed runtime preparation waits for explicit retry and keeps the successful computer', async () => {
  let attempts = 0;
  let engineStarts = 0;
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
    onRuntimeStatus: () => {},
  });
  await assert.rejects(lifecycle.warmup());
  await assert.rejects(lifecycle.start());
  assert.equal(attempts, 1);
  assert.equal(engineStarts, 0);
  await assert.rejects(lifecycle.start({ retry: true }));
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
  const rejected = assert.rejects(starting);
  await started.promise;
  const closing = lifecycle.close();
  assert.equal(signal.aborted, true);
  await new Promise(setImmediate);
  assert.ok(!events.includes('engine stopped'));
  gate.resolve({ close: async () => events.push('computer closed') });
  await Promise.all([closing, rejected]);
  assert.ok(events.includes('computer closed'));
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
  await assert.rejects(lifecycle.close());
  assert.throws(() => lifecycle.start());
  await lifecycle.close();
  assert.equal(stops, 2);
  await lifecycle.close();
  assert.equal(stops, 2);
});

async function runningDesktop(
  t,
  request,
  {
    allowStart = false,
    reportReady = true,
    setupReady = true,
    fastSetupTimeout = false,
    initialState = 'running',
    legacyKey,
    prepareRuntime,
    nativePageLoaded,
    protectNativeProfile = async () => {},
    setupCleanup,
    notificationsSupported = false,
    webPreferences = { quietHoursEnabled: false },
    openFile = open,
    environment = {},
    platform = process.platform === 'win32' ? 'win32' : 'darwin',
    packaged = false,
    buildMetadata,
    version = '0.0.0-test',
    argv = [],
    prompt = () => assert.fail('No restart prompt is needed.'),
    reveal = () => assert.fail('No file should be revealed.'),
  } = {},
) {
  const storage = await fixture(t, platform);
  await storage.store.save({
    onboardingCompleted: initialState !== 'fresh',
  });
  if (legacyKey) {
    await storage.store.environment();
    const saved = JSON.parse(await readFile(storage.path, 'utf8'));
    saved.secrets.composioApiKey = storage.encryption.encryptString(legacyKey).toString('base64');
    saved.keyMetadata.composioApiKey = {
      suffix: legacyKey.slice(-4),
      source: 'manual',
      updatedAt: '2026-10-08T00:00:00.000Z',
    };
    await writeFile(storage.path, JSON.stringify(saved));
    storage.store = storage.reopen();
  }
  const windows = [];
  const children = [];
  const paths = new Map();
  const handlers = new Map();
  const notifications = [];
  const updateMenu = {};
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
  });
  let openAtLogin = false;
  let elapsed = 0;
  let requestHeaders;
  const appSession = Object.assign(new EventEmitter(), {
    webRequest: {
      onBeforeSendHeaders: (handler) => {
        requestHeaders = handler;
      },
    },
  });
  const context = {
    app: {
      isPackaged: packaged,
      setName() {},
      setPath: (name, path) => paths.set(name, path),
      getPath: (name) => paths.get(name) || dirname(storage.path),
      getVersion: () => version,
      requestSingleInstanceLock: () => false,
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (value) => {
        openAtLogin = value.openAtLogin;
      },
      quit() {},
    },
    process: {
      platform,
      argv,
      env: typeof environment === 'function' ? environment(dirname(storage.path)) : environment,
      resourcesPath: dirname(storage.path),
    },
    ipcMain: ipc,
    session: { fromPartition: () => appSession },
    dialog: { showMessageBox: async (options) => prompt(options) },
    Menu: { getApplicationMenu: () => ({ getMenuItemById: () => updateMenu }) },
    shell: { showItemInFolder: reveal },
    URL,
    dirname,
    isAbsolute,
    join,
    resolve,
    fileURLToPath,
    pathToFileURL,
    mkdir,
    appendFile,
    readFile: (file, ...args) =>
      buildMetadata && file === fileURLToPath(new URL('../package.json', import.meta.url))
        ? Promise.resolve(JSON.stringify({ ottoBuild: buildMetadata }))
        : readFile(file, ...args),
    open: openFile,
    rename,
    stat,
    writeFile,
    rm,
    randomUUID,
    randomBytes,
    createServer,
    AbortController,
    AbortSignal,
    Date: class extends Date {
      static now() {
        return Date.now() + elapsed;
      }
    },
    setTimeout: (callback, ms) => {
      if (fastSetupTimeout && ms === 100) {
        elapsed += 45_000;
        return setTimeout(callback, 0);
      }
      return setTimeout(callback, ms);
    },
    clearTimeout,
    fetch: request,
    createSettingsStore: () => storage.store,
    protectNativeProfile,
    createDesktopAnalytics,
    createAppPreferencesStore: () => ({
      sync: async () => {},
      get: async () => ({ preferences: webPreferences }),
    }),
    createChatReadCursorStore: () => ({}),
    saveArtifactDownload,
    createReadinessNotice,
    isQuietTime,
    watchAssistantMessages: () => () => {},
    createDesktopLifecycle: (options) =>
      createDesktopLifecycle({
        ...options,
        prepareRuntime: async (options) => {
          await mkdir(join(paths.get('userData'), 'profiles', 'local'), { recursive: true });
          return prepareRuntime ? prepareRuntime(options) : { env: {} };
        },
      }),
    desktopSetupMode,
    nativeTheme: { shouldUseDarkColors: false },
    safeStorage: storage.encryption,
    Notification: class extends EventEmitter {
      static isSupported() {
        return notificationsSupported;
      }
      show() {
        notifications.push(this);
      }
    },
    utilityProcess: {
      fork(file, _args, options) {
        assert.ok(allowStart, 'The healthy engine must not restart.');
        assert.ok(Object.values(options.env).every((value) => typeof value === 'string'));
        const child = new EventEmitter();
        child.kind =
          file.endsWith('/setup.mjs') || file.endsWith('\\setup.mjs') ? 'setup' : 'engine';
        child.sent = [];
        child.postMessage = (message) => {
          child.sent.push(message);
          if (message.type === 'otto-setup-ack')
            void Promise.resolve(setupCleanup).then(() =>
              setImmediate(() => child.emit('message', { type: 'otto-setup-cleaned' })),
            );
        };
        child.environment = options.env;
        child.port = options.env.PORT;
        child.stdout = { resume() {} };
        child.stderr = Object.assign(new EventEmitter(), { resume() {} });
        child.kill = () => {
          child.killed = true;
          child.emit('exit', 0);
        };
        if (child.kind === 'setup' ? setupReady : reportReady)
          setImmediate(() => {
            child.emit('message', {
              type: child.kind === 'setup' ? 'otto-setup-ready' : 'otto-ready',
              port: Number(options.env.PORT),
              ...(options.env.OTTO_DESKTOP_SETUP_PENDING === 'true'
                ? { setupId: 'synthetic-setup-receipt' }
                : {}),
            });
            if (child.kind === 'setup' && initialState === 'frozen')
              child.emit('message', { type: 'otto-setup-complete' });
          });
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
          id: windows.length + 1,
          setWindowOpenHandler(handler) {
            this.openWindow = handler;
          },
          isLoadingMainFrame: () => Boolean(this.loading),
          getURL: () => this.webContents.mainFrame.url,
          send: (channel, value) => {
            this.sent.push([channel, value]);
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
      isVisible() {
        return this.visible && !this.destroyed;
      }
      loadURL(url) {
        this.url = url;
        this.loading = true;
        this.webContents.mainFrame = {
          url,
          routingId: this.webContents.id,
          processId: this.webContents.id + 100,
        };
      }
      loadFile(path, options) {
        this.path = path;
        this.query = options?.query;
        this.webContents.mainFrame = { url: pathToFileURL(path).href };
        return nativePageLoaded ?? Promise.resolve();
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
    .replaceAll('\r\n', '\n')
    .replace(/^import[\s\S]*?;\n/gm, '')
    .replaceAll(
      'import.meta.url',
      JSON.stringify(new URL('../main/main.mjs', import.meta.url).href),
    );
  await runInNewContext(
    `(async () => {
    ${source}
    engine = {};
    enginePreferencesReady = true;
    engineOrigin = 'http://127.0.0.1:4310';
    engineBound = true;
    onboardingCompleted = true;
    status.phase = 'ready';
    ${initialState === 'running' ? '' : "engine = undefined; enginePreferencesReady = false; engineOrigin = ''; engineBound = false; onboardingCompleted = false; status.phase = 'idle';"}
    ${source.slice(source.indexOf('      const appSession ='), source.indexOf('      const image = nativeImage'))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:get'"), source.indexOf("      ipcMain.handle('otto:feedback:context'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:feedback:context'"), source.indexOf("      ipcMain.handle('otto:preferences:get'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:save'"), source.indexOf("      ipcMain.handle('otto:prepare'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:prepare'"), source.indexOf("      ipcMain.handle('otto:runtime:warm'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:runtime:install-wsl'"), source.indexOf("      ipcMain.handle('otto:chat-read:get'"))}
    if (typeof protectProfile === 'function') protectProfile = globalThis.protectNativeProfile;
    globalThis.running = {
      prepare,
      launch: async () => { ${source.slice(source.lastIndexOf('      try {\n        const saved = await settings.get();'), source.indexOf('    })', source.lastIndexOf('      try {\n        const saved = await settings.get();')))} },
      settle: () => preparing ?? Promise.resolve(),
      close: async () => { quitting = true; await stopEarlySetup(); await lifecycle.close(); },
      profileRoot,
      profileOwner,
      startEarlySetup,
      showEngine,
      showSettings,
      replayOnboarding,
      showFeedback,
      saveEngineDownload,
      setReady: (ready) => { status.phase = ready ? 'ready' : 'starting'; },
      status: () => status,
      notifyReady: updateReadinessNotice,
      checkUpdates: (updater, manual = true) => { updates = updater; return checkForUpdates(manual); },
      crash: () => { engine = undefined; enginePreferencesReady = false; },
    };
    })()`,
    context,
  );
  if (initialState === 'frozen') {
    await mkdir(join(context.running.profileRoot, 'onboarding'), { recursive: true });
    await writeFile(
      join(context.running.profileRoot, 'onboarding', 'pending'),
      'synthetic encrypted snapshot',
    );
  }
  return {
    ...context.running,
    windows,
    children,
    storage,
    handlers,
    notifications,
    updateMenu,
    headers: (details) => new Promise((resolve) => requestHeaders(details, resolve)),
  };
}

test('early setup and the full engine use the same release boundary for analytics', async (t) => {
  for (const scenario of [
    {
      name: 'stable release',
      buildMetadata: { release: true },
      version: '0.1.17',
      expected: 'production',
    },
    {
      name: 'staging build',
      buildMetadata: { release: false },
      version: '0.1.17',
      expected: 'development',
    },
    {
      name: 'prerelease',
      buildMetadata: { release: true },
      version: '0.1.17-test',
      expected: 'development',
    },
    {
      name: 'isolated test install',
      buildMetadata: { release: true, testProfile: true },
      version: '0.1.17',
      expected: 'development',
    },
  ]) {
    await t.test(scenario.name, async (t) => {
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState: 'frozen',
        allowStart: true,
        packaged: true,
        buildMetadata: scenario.buildMetadata,
        version: scenario.version,
      });
      try {
        await f.launch();
        await f.settle();
        assert.deepEqual(
          f.children.map((child) => child.kind),
          ['setup', 'engine'],
        );
        assert.ok(
          f.children.every(
            (child) => child.environment.OTTO_ANALYTICS_ENVIRONMENT === scenario.expected,
          ),
        );
        if (scenario.buildMetadata.testProfile)
          assert.ok(
            f.children.every((child) => child.environment.OTTO_ANALYTICS_ENABLED === 'false'),
          );
      } finally {
        await f.close();
      }
    });
  }
});

test('Windows early setup protects its profile before unlocking keys even without WSL', async (t) => {
  for (const failure of [false, true]) {
    await t.test(failure ? 'refused permissions' : 'protected profile', async (t) => {
      const gate = deferred();
      let protecting = false;
      let protectedProfile = false;
      let unlocked = false;
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState: 'fresh',
        platform: 'win32',
        allowStart: true,
        prepareRuntime: async () => {
          throw Object.assign(new Error('Synthetic WSL missing'), { code: 'OTTO_WSL_REQUIRED' });
        },
        protectNativeProfile: async () => {
          assert.ok(f.windows.some((window) => window.isVisible()));
          protecting = true;
          await gate.promise;
          if (failure) throw new Error('Synthetic profile protection failed');
          protectedProfile = true;
        },
      });
      const environment = f.storage.store.environment;
      f.storage.store.environment = async () => {
        assert.ok(protectedProfile, 'Profile protection must finish before unlocking keys.');
        unlocked = true;
        return environment();
      };
      try {
        const launching = f.launch();
        for (let attempt = 0; !protecting && attempt < 50; attempt++)
          await new Promise((accept) => setTimeout(accept, 10));
        assert.ok(protecting);
        assert.equal(unlocked, false);
        assert.equal(f.children.length, 0);
        gate.resolve();
        await launching;
        assert.equal(unlocked, !failure);
        assert.deepEqual(
          f.children.map((child) => child.kind),
          failure ? [] : ['setup'],
        );
        if (failure) assert.match(f.status().error, /profile protection failed/);
        else assert.equal(f.status().runtime.needsWsl, true);
      } finally {
        gate.resolve();
        await f.close();
      }
    });
  }
});

test('native first launch shows a loading window before unlocking its system key store', async (t) => {
  const loaded = deferred();
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'fresh',
    allowStart: true,
    nativePageLoaded: loaded.promise,
  });
  const encrypt = f.storage.encryption.encryptString;
  let observed = false;
  f.storage.encryption.encryptString = (value) => {
    const window = f.windows.find((candidate) => candidate.isVisible());
    assert.ok(window, 'The app must be visible before the blocking system key-store call.');
    assert.equal(window.query.mode, 'loading');
    assert.equal(f.status().unlockingKeys, true);
    assert.equal(f.children.length, 0);
    observed = true;
    return encrypt(value);
  };
  try {
    const launching = f.launch();
    for (let attempt = 0; !f.windows.length && attempt < 50; attempt++)
      await new Promise((accept) => setTimeout(accept, 10));
    assert.equal(f.windows.length, 1);
    const output = await mkdtemp(join(tmpdir(), 'otto-native-startup-'));
    t.after(() => rm(output, { recursive: true, force: true }));
    await buildDesktopUI(output);
    const page = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
      url: 'file:///synthetic/setup.html?mode=loading&firstSetup=true&unlocking=darwin',
      runScripts: 'outside-only',
    });
    t.after(() => page.window.close());
    page.window.ottoDesktop = {
      onStatus() {},
      onPreferences() {},
      onNavigate() {},
      getPreferences: () => new Promise(() => {}),
      status: () => new Promise(() => {}),
    };
    page.window.eval(await readFile(join(output, 'setup.js'), 'utf8'));
    for (
      let attempt = 0;
      !page.window.document.querySelector('[role="status"]') && attempt < 50;
      attempt++
    )
      await new Promise((accept) => setTimeout(accept, 10));
    assert.ok(page.window.document.querySelector('[role="status"]'));
    assert.equal(page.window.document.querySelector('input'), null);
    assert.equal(page.window.document.querySelector('button'), null);
    await new Promise((accept) => setTimeout(accept, 100));
    assert.equal(observed, false);
    loaded.resolve();
    await launching;
    assert.equal(observed, true);
    assert.equal(f.windows.filter((window) => window.isVisible()).length, 1);
    assert.equal(f.windows[0].isDestroyed(), true);
    assert.equal(new URL(f.windows.at(-1).url).pathname, '/onboarding');
    assert.equal(f.status().unlockingKeys, false);
  } finally {
    loaded.resolve();
    await f.close();
  }
});

test('native startup recovery keeps current status and serializes retry, prerequisite installation, and runtime import', async (t) => {
  for (const initialResult of ['stale response', 'stale failure']) {
    await t.test(initialResult, async (t) => {
      const output = await mkdtemp(join(tmpdir(), 'otto-native-recovery-'));
      t.after(() => rm(output, { recursive: true, force: true }));
      await buildDesktopUI(output);
      const page = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
        url: 'file:///synthetic/setup.html?mode=loading&firstSetup=false',
        runScripts: 'outside-only',
      });
      t.after(() => page.window.close());
      const initial = deferred();
      const retry = deferred();
      let publish;
      const calls = [];
      let imports = 0;
      page.window.ottoDesktop = {
        onStatus(listener) {
          publish = listener;
        },
        onPreferences() {},
        getPreferences: async () => ({ theme: 'light' }),
        status: () => initial.promise,
        prepare(options) {
          calls.push(['prepare', options]);
          return options ? retry.promise : Promise.resolve({ phase: 'starting' });
        },
        installWsl: async () => {
          calls.push(['installWsl']);
          return { phase: 'error', error: 'Synthetic restart required' };
        },
        importRuntime: async () => {
          calls.push(['importRuntime']);
          return imports++ ? { runtime: { phase: 'ready' } } : undefined;
        },
      };
      page.window.eval(await readFile(join(output, 'setup.js'), 'utf8'));
      const settle = async (predicate) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          await new Promise((accept) => setTimeout(accept, 10));
          if (predicate()) return;
        }
        assert.ok(predicate());
      };
      await settle(() => publish);
      publish({ phase: 'error', error: 'Synthetic startup failure' });
      if (initialResult === 'stale response') initial.resolve({ phase: 'ready' });
      else initial.reject(new page.window.Error('Synthetic stale failure'));
      await settle(() => page.window.document.querySelector('[role="alert"]'));
      assert.ok(
        page.window.document
          .querySelector('[role="alert"]')
          .textContent.includes('Synthetic startup failure'),
      );
      assert.equal(page.window.document.querySelector('input'), null);
      const button = (name) =>
        [...page.window.document.querySelectorAll('button')].find(
          (item) => item.textContent === name,
        );
      button('Try again').click();
      button('Try again').click();
      await settle(() => calls.length === 1);
      assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['prepare', { retry: true }]]);
      retry.reject(new page.window.Error('Synthetic retry failed'));
      await settle(() =>
        page.window.document
          .querySelector('[role="alert"]')
          ?.textContent.includes('Synthetic retry failed'),
      );
      publish({ phase: 'preparing', runtime: { phase: 'downloading', progress: 0.42 } });
      await settle(() => page.window.document.querySelector('progress')?.value === 42);
      assert.equal(page.window.document.querySelector('[role="alert"]'), null);
      assert.equal(page.window.document.querySelector('button'), null);
      publish({ phase: 'error', error: 'Synthetic prerequisite failure', needsWsl: true });
      await settle(() => button('Install WSL'));
      button('Install WSL').click();
      await settle(() =>
        page.window.document
          .querySelector('[role="alert"]')
          ?.textContent.includes('Synthetic restart required'),
      );
      assert.deepEqual(calls.at(-1), ['installWsl']);
      assert.equal(button('Install WSL'), undefined);
      publish({ phase: 'error', error: 'Synthetic runtime missing', needsRuntimeArchive: true });
      await settle(() => button('Choose runtime file'));
      button('Choose runtime file').click();
      await settle(
        () =>
          calls.filter(([name]) => name === 'importRuntime').length === 1 &&
          !button('Choose runtime file').disabled &&
          page.window.document.querySelector('[role="alert"]'),
      );
      assert.equal(calls.filter(([name]) => name === 'prepare').length, 1);
      assert.ok(page.window.document.querySelector('[role="alert"]'));
      button('Choose runtime file').click();
      await settle(() => calls.filter(([name]) => name === 'prepare').length === 2);
      assert.deepEqual(calls.at(-1), ['prepare', undefined]);
      await settle(() => !page.window.document.querySelector('[role="alert"]'));
    });
  }
});

test('native owner identity survives interrupted durable publication without inventing another owner', async (t) => {
  for (const failure of process.platform === 'win32' ? ['file'] : ['file', 'directory']) {
    await t.test(failure, async (t) => {
      let failing = true;
      const f = await runningDesktop(
        t,
        async () => assert.fail('Identity persistence needs no network.'),
        {
          initialState: 'fresh',
          openFile: async (path, flags, mode) => {
            const file = await open(path, flags, mode);
            return {
              readFile: (...args) => file.readFile(...args),
              writeFile: (...args) => file.writeFile(...args),
              close: () => file.close(),
              sync: async () => {
                if (failing && (failure === 'file' ? flags === 'wx' : flags === 'r'))
                  throw Object.assign(new Error('Synthetic persistence failure.'), { code: 'EIO' });
                await file.sync();
              },
            };
          },
        },
      );
      await mkdir(f.profileRoot, { recursive: true });
      const path = join(f.profileRoot, 'profile.json');
      await assert.rejects(f.profileOwner(), { code: 'EIO' });
      let published;
      if (failure === 'file') await assert.rejects(readFile(path), { code: 'ENOENT' });
      else published = JSON.parse(await readFile(path, 'utf8')).ownerId;
      assert.ok((await readdir(f.profileRoot)).every((name) => !name.startsWith('.profile-')));
      failing = false;
      const owner = await f.profileOwner();
      if (published) assert.equal(owner, published);
      assert.equal(JSON.parse(await readFile(path, 'utf8')).ownerId, owner);
      assert.equal(await f.profileOwner(), owner);
      await f.close();
    });
  }
});

test('quitting while macOS keychain access is pending never forks a late setup process', async (t) => {
  const f = await runningDesktop(t, async () => assert.fail('The full engine must not run.'), {
    platform: 'darwin',
    initialState: 'fresh',
    allowStart: true,
  });
  const accessed = deferred();
  const unlocked = deferred();
  f.storage.encryption.isAsyncEncryptionAvailable = () => {
    accessed.resolve();
    return unlocked.promise;
  };
  try {
    const launching = f.launch();
    await accessed.promise;
    const window = f.windows.find((candidate) => candidate.isVisible());
    assert.ok(window);
    assert.equal(window.query.mode, 'loading');
    assert.equal(f.status().unlockingKeys, true);
    await f.close();
    unlocked.resolve(true);
    await launching;
    assert.equal(f.children.length, 0);
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
  } finally {
    unlocked.resolve(true);
    await f.close();
  }
});

test('native first-start key-store failure retries shared setup without completing onboarding', async (t) => {
  for (const failure of ['unavailable', 'denied']) {
    await t.test(failure, async (t) => {
      const f = await runningDesktop(t, async () => assert.fail('The full engine must not run.'), {
        initialState: 'fresh',
        allowStart: true,
      });
      let failing = true;
      const encrypt = f.storage.encryption.encryptString;
      f.storage.encryption.isEncryptionAvailable = () => failure !== 'unavailable' || !failing;
      f.storage.encryption.encryptString = (value) => {
        if (failure === 'denied' && failing) throw new Error('Synthetic key-store denial.');
        return encrypt(value);
      };
      try {
        await f.launch();
        await new Promise(setImmediate);
        assert.equal(f.status().phase, 'error');
        assert.equal(f.children.length, 0);
        assert.equal((await f.storage.store.get()).onboardingCompleted, false);
        const window = f.windows.at(-1);
        assert.equal(
          window.sent.findLast(([channel]) => channel === 'otto:navigate')[1].mode,
          'loading',
        );
        const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
        await assert.rejects(
          f.handlers.get('otto:settings:save')(event, { onboardingCompleted: true }),
        );
        failing = false;
        await Promise.all([
          f.handlers.get('otto:prepare')(event, { retry: true }),
          f.handlers.get('otto:prepare')(event, { retry: true }),
        ]);
        assert.equal(f.children.length, 1);
        assert.equal(f.children[0].kind, 'setup');
        assert.equal((await f.storage.store.get()).onboardingCompleted, false);
        assert.equal(new URL(f.windows.at(-1).url).pathname, '/onboarding');
      } finally {
        await f.close();
      }
    });
  }
});

test('native first launch opens the shared web onboarding while runtime preparation is pending, then imports once', async (t) => {
  for (const platform of process.platform === 'win32' ? ['win32'] : ['darwin', 'win32']) {
    await t.test(platform, async (t) => {
      const runtime = deferred();
      let preparations = 0;
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        platform,
        initialState: 'fresh',
        allowStart: true,
        prepareRuntime: async () => {
          preparations++;
          return runtime.promise;
        },
      });
      try {
        await f.launch();
        assert.equal(preparations, 1);
        assert.equal(f.children.length, 1);
        const setup = f.children[0];
        assert.equal(setup.kind, 'setup');
        assert.equal(setup.environment.DATABASE_URL, undefined);
        assert.equal(f.windows.filter((window) => window.isVisible()).length, 1);
        const window = f.windows.at(-1);
        assert.equal(new URL(window.url).pathname, '/onboarding');
        const beforeReplay = await readFile(f.storage.path, 'utf8');
        const setupUrl = window.url;
        f.replayOnboarding();
        assert.equal(window.url, setupUrl);
        assert.equal(await readFile(f.storage.path, 'utf8'), beforeReplay);
        assert.equal(f.children.length, 1);
        const setupOrigin = new URL(window.url).origin;
        const request = (url, extra = {}) => ({
          url,
          webContentsId: window.webContents.id,
          frame: window.webContents.mainFrame,
          resourceType: 'xhr',
          requestHeaders: { 'X-Otto-Desktop-Token': 'forged' },
          ...extra,
        });
        const authorized = await f.headers(request(`${setupOrigin}/api/session`));
        assert.equal(
          authorized.requestHeaders['x-otto-desktop-token'],
          setup.environment.OTTO_DESKTOP_AUTH_TOKEN,
        );
        for (const details of [
          request(`${setupOrigin}/api/session`, { webContentsId: -1 }),
          request(`${setupOrigin}/api/session`, { frame: { routingId: -1, processId: -1 } }),
          request('https://external.example.test/api/session'),
        ]) {
          const result = await f.headers(details);
          assert.ok(
            Object.keys(result.requestHeaders).every(
              (name) => name.toLowerCase() !== 'x-otto-desktop-token',
            ),
          );
        }

        setup.emit('message', { type: 'otto-setup-complete' });
        setup.emit('message', { type: 'otto-setup-complete' });
        await new Promise(setImmediate);
        assert.equal(f.children.length, 1);
        runtime.resolve({ env: {} });
        await f.settle();
        assert.equal(f.children.length, 2);
        const engine = f.children[1];
        assert.equal(engine.kind, 'engine');
        assert.equal(engine.environment.OTTO_DESKTOP_SETUP_PENDING, 'true');
        assert.equal(
          engine.environment.OTTO_DESKTOP_OWNER_ID,
          setup.environment.OTTO_DESKTOP_OWNER_ID,
        );
        assert.equal(engine.environment.OTTO_VAULT_KEY, setup.environment.OTTO_VAULT_KEY);
        assert.notEqual(
          engine.environment.OTTO_DESKTOP_AUTH_TOKEN,
          setup.environment.OTTO_DESKTOP_AUTH_TOKEN,
        );
        assert.equal(f.windows.at(-1), window);
        assert.notEqual(new URL(window.url).origin, setupOrigin);
        assert.equal(new URL(window.url).pathname, '/');
        const full = await f.headers(request(`${new URL(window.url).origin}/api/session`));
        assert.equal(
          full.requestHeaders['x-otto-desktop-token'],
          engine.environment.OTTO_DESKTOP_AUTH_TOKEN,
        );
        const retired = await f.headers(request(`${setupOrigin}/api/session`));
        assert.ok(
          Object.keys(retired.requestHeaders).every(
            (name) => name.toLowerCase() !== 'x-otto-desktop-token',
          ),
        );

        assert.equal(setup.killed, true);
        assert.equal((await f.storage.store.get()).onboardingCompleted, true);
        assert.equal(setup.sent.filter((message) => message.type === 'otto-setup-ack').length, 1);
        assert.equal(f.status().phase, 'ready');
      } finally {
        runtime.resolve({ env: {} });
        await f.close();
      }
    });
  }
});

test('native frozen setup resumes handoff while completed upgrades skip early setup', async (t) => {
  for (const initialState of ['frozen', 'upgrade', 'replay']) {
    await t.test(initialState, async (t) => {
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState,
        legacyKey: initialState === 'frozen' ? 'synthetic-older-incomplete-project' : undefined,
        allowStart: true,
        argv: initialState === 'replay' ? ['--onboarding'] : [],
      });
      const before = await f.storage.store.environment();
      const preferences = await f.storage.store.get();
      try {
        await f.launch();
        await f.settle();
        assert.equal(f.status().phase, 'ready');
        assert.deepEqual(
          f.children.map((child) => child.kind),
          initialState === 'frozen' ? ['setup', 'engine'] : ['engine'],
        );
        assert.equal(
          f.children.at(-1).environment.OTTO_DESKTOP_SETUP_PENDING,
          initialState === 'frozen' ? 'true' : undefined,
        );
        assert.equal(f.children.at(-1).environment.OTTO_DESKTOP_LEGACY_INTEGRATION, undefined);
        if (initialState === 'frozen') assert.ok(await f.storage.store.legacyIntegration());
        if (initialState === 'frozen') assert.equal(f.children[0].killed, true);
        else if (initialState === 'replay')
          assert.ok(f.windows.some((window) => window.url?.endsWith('/onboarding?replay=1')));
        else
          assert.ok(
            f.windows.every(
              (window) => !window.url || new URL(window.url).pathname !== '/onboarding',
            ),
          );
        if (initialState !== 'frozen') {
          assert.deepEqual(await f.storage.store.environment(), before);
          assert.deepEqual(await f.storage.store.get(), preferences);
        }
      } finally {
        await f.close();
      }
    });
  }
});

test('native upgrade sends legacy credentials only to its current owned child and clears after exact acknowledgement', async (t) => {
  const key = 'synthetic-private-upgrade-key';
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'upgrade',
    allowStart: true,
    legacyKey: key,
  });
  const before = await f.storage.store.environment();
  try {
    await f.launch();
    await f.settle();
    const child = f.children[0];
    assert.equal(child.environment.OTTO_DESKTOP_LEGACY_INTEGRATION, 'true');
    assert.equal(JSON.stringify(child.environment).includes(key), false);
    assert.equal(JSON.stringify(await f.storage.store.get()).includes(key), false);
    const ownerId = child.environment.OTTO_DESKTOP_OWNER_ID;
    const nonce = randomUUID();
    const request = { type: 'otto-legacy-integration-request', ownerId, nonce };
    child.emit('message', { ...request, ownerId: randomUUID() });
    child.emit('message', { ...request, nonce: 'invalid' });
    assert.equal(child.sent.length, 0);
    child.emit('message', request);
    assert.equal(child.sent.length, 1);
    const payload = child.sent[0];
    assert.equal(payload.apiKey, key);
    assert.equal(payload.ownerId, ownerId);
    assert.equal(payload.nonce, nonce);
    child.emit('message', request);
    assert.equal(child.sent.length, 1);
    const ack = { type: 'otto-legacy-integration-ack', ownerId, nonce, receipt: payload.receipt };
    child.emit('message', { ...ack, ownerId: randomUUID() });
    child.emit('message', { ...ack, nonce: randomUUID() });
    child.emit('message', { ...ack, receipt: '0'.repeat(64) });
    await new Promise(setImmediate);
    assert.equal((await f.storage.store.legacyIntegration()).apiKey, key);
    child.emit('message', ack);
    for (let i = 0; i < 100 && child.sent.length < 2; i++)
      await new Promise((accept) => setTimeout(accept, 10));
    assert.equal(child.sent[1].type, 'otto-legacy-integration-cleaned');
    assert.equal(await f.storage.store.legacyIntegration(), undefined);
    assert.deepEqual(await f.storage.store.environment(), before);
    assert.equal((await f.storage.store.get()).onboardingCompleted, true);
    assert.equal(f.children.length, 1);
    assert.ok(f.windows.every((window) => !JSON.stringify(window.sent).includes(key)));
    f.crash();
    child.emit('message', request);
    assert.equal(child.sent.length, 2);
  } finally {
    await f.close();
  }
});

test('unreadable historical app ciphertext does not block a completed profile and remains recoverable', async (t) => {
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'upgrade',
    allowStart: true,
    legacyKey: 'synthetic-older-key',
  });
  const before = await readFile(f.storage.path, 'utf8');
  const ciphertext = JSON.parse(before).secrets.composioApiKey;
  const decrypt = f.storage.encryption.decryptString;
  f.storage.encryption.decryptString = (value) => {
    if (value.toString('base64') === ciphertext) throw new Error('Synthetic old key cannot unlock');
    return decrypt(value);
  };
  try {
    await f.launch();
    await f.settle();
    assert.equal(f.status().phase, 'ready');
    assert.deepEqual(
      f.children.map((child) => child.kind),
      ['engine'],
    );
    assert.equal(f.children[0].environment.OTTO_DESKTOP_LEGACY_INTEGRATION, undefined);
    assert.equal(await readFile(f.storage.path, 'utf8'), before);
    assert.equal((await f.storage.store.get()).onboardingCompleted, true);
    f.storage.encryption.decryptString = decrypt;
    assert.equal((await f.storage.store.legacyIntegration()).apiKey, 'synthetic-older-key');
  } finally {
    await f.close();
  }
});

test('native early setup retry opens Windows recovery instead of repeating failed warmup', async (t) => {
  let preparations = 0;
  const f = await runningDesktop(t, async () => assert.fail('No engine can run without WSL.'), {
    platform: 'win32',
    initialState: 'fresh',
    allowStart: true,
    prepareRuntime: async () => {
      preparations++;
      throw Object.assign(new Error('Synthetic WSL missing'), { code: 'OTTO_WSL_REQUIRED' });
    },
  });
  try {
    await f.launch();
    assert.equal(f.status().runtime.needsWsl, true);
    assert.equal(f.windows.filter((window) => window.isVisible()).length, 1);
    f.children[0].emit('message', { type: 'otto-setup-retry' });
    await new Promise(setImmediate);
    assert.equal(preparations, 1);
    assert.equal(f.windows.filter((window) => window.isVisible()).length, 2);
    assert.equal(f.windows.at(-1).query.section, 'general');
    assert.equal(f.children.length, 1);
  } finally {
    await f.close();
  }
});

test('native early readiness timeout stops the exact child and ignores its late ready message', async (t) => {
  const f = await runningDesktop(
    t,
    async () => assert.fail('A timed-out setup cannot start the engine.'),
    {
      initialState: 'fresh',
      allowStart: true,
      setupReady: false,
      fastSetupTimeout: true,
    },
  );
  try {
    await assert.rejects(f.startEarlySetup(), /could not open setup/);
    assert.equal(f.children.length, 1);
    const child = f.children[0];
    assert.equal(child.killed, true);
    child.emit('message', { type: 'otto-setup-ready', port: Number(child.port) });
    assert.equal(f.windows.length, 1);
    assert.equal(f.windows[0].query.mode, 'loading');
    assert.equal(f.windows[0].url, undefined);
  } finally {
    await f.close();
  }
});

test('native quit drains early setup and aborts warmup without starting the full engine', async (t) => {
  const runtime = deferred();
  let signal;
  let closed = 0;
  const f = await runningDesktop(t, async () => assert.fail('Quit must fence the full engine.'), {
    initialState: 'fresh',
    allowStart: true,
    prepareRuntime: async (options) => {
      signal = options.signal;
      return runtime.promise;
    },
  });
  await f.launch();
  const closing = f.close();
  await new Promise(setImmediate);
  assert.equal(f.children[0].killed, true);
  assert.equal(signal.aborted, true);
  runtime.resolve({
    env: {},
    close: async () => {
      closed++;
    },
  });
  await closing;
  assert.equal(closed, 1);
  assert.deepEqual(
    f.children.map((child) => child.kind),
    ['setup'],
  );
});

test('desktop proxy overrides reach only isolated source engines and retain origin validation', async (t) => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const scenario of [
    { name: 'isolated local source', url: 'http://127.0.0.1:8787', isolated: true },
    { name: 'isolated HTTPS source', url: 'https://proxy.example.test', isolated: true },
    {
      name: 'packaged override',
      url: 'https://proxy.example.test',
      isolated: true,
      packaged: true,
    },
    { name: 'ordinary source override', url: 'https://proxy.example.test' },
    {
      name: 'invalid packaged override',
      url: 'file:///tmp/invalid',
      isolated: true,
      packaged: true,
    },
    ...[
      'http://proxy.example.test',
      'https://user:password@proxy.example.test',
      'https://proxy.example.test/path',
      'https://proxy.example.test?query=1',
      'https://proxy.example.test#fragment',
    ].map((url) => ({ name: `invalid source ${url}`, url, isolated: true, invalid: true })),
  ]) {
    await t.test(scenario.name, async (t) => {
      const f = await runningDesktop(
        t,
        async (url) => {
          assert.equal(new URL(url).pathname, '/api/health');
          return Response.json({ ok: true });
        },
        {
          allowStart: true,
          packaged: scenario.packaged,
          environment: (path) => ({
            OTTO_COMPOSIO_PROXY_URL: scenario.url,
            COMPOSIO_API_KEY: 'synthetic-inherited-project-key',
            ...(scenario.isolated ? { OTTO_DESKTOP_USER_DATA: join(path, 'isolated') } : {}),
          }),
        },
      );
      f.crash();
      assert.equal((await f.prepare()).phase, 'ready');
      const environment = f.children[0].environment;
      const allowed = scenario.isolated && !scenario.packaged;
      assert.equal(environment.COMPOSIO_API_KEY, undefined);
      assert.equal(environment.OTTO_COMPOSIO_PROXY_URL, allowed ? scenario.url : undefined);
      assert.equal(Boolean(environment.OTTO_DESKTOP_USER_DATA), Boolean(allowed));
      assert.equal(
        environment.OTTO_DATA_ROOT,
        allowed
          ? join(dirname(f.storage.path), 'isolated', 'profiles', 'local')
          : join(dirname(f.storage.path), 'Otto', 'profiles', 'local'),
      );
      const expected = allowed ? scenario.url : 'https://composio.n8n.cloud';
      const script = `
        import assert from 'node:assert/strict';
        let requests = 0;
        globalThis.fetch = async (resource, options) => {
          const request = new Request(resource, options);
          assert.equal(request.url, ${JSON.stringify(expected)} + '/v1/access/status');
          assert.equal(request.method, 'POST');
          assert.equal(request.headers.has('x-api-key'), false);
          assert.ok(request.headers.get('x-otto-signature'));
          requests++;
          return Response.json({ state: 'sign_in_required' });
        };
        const { createDefaultAdapters } = await import('./src/server/composition.ts');
        const { pool } = await import('./src/server/db.ts');
        if (${Boolean(scenario.invalid)}) {
          assert.throws(() => createDefaultAdapters(), /proxy address/);
          assert.equal(requests, 0);
        } else {
          const adapters = createDefaultAdapters();
          assert.deepEqual(await adapters.integrationAccess.status(), { state: 'sign_in_required', email: null });
          assert.equal(requests, 1);
          await adapters.integrationAccess.close();
        }
        await pool.end();
      `;
      await new Promise((resolveRun, reject) =>
        execFile(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '--eval', script],
          {
            cwd: root,
            env: {
              ...environment,
              DOTENV_CONFIG_PATH: join(dirname(f.storage.path), 'absent.env'),
              COMPOSIO_BASE_URL: 'https://backend.composio.dev',
              OTTO_ANALYTICS_ENABLED: 'false',
            },
            timeout: 20_000,
            maxBuffer: 128 * 1024,
          },
          (error, _stdout, stderr) => {
            if (error) reject(new Error(stderr || error.message));
            else resolveRun();
          },
        ),
      );
    });
  }
  await assert.rejects(
    runningDesktop(t, () => assert.fail('No engine should launch.'), {
      environment: () => ({
        OTTO_DESKTOP_USER_DATA: 'relative-profile',
        OTTO_COMPOSIO_PROXY_URL: 'http://127.0.0.1:8787',
      }),
    }),
    /profile path must be absolute/,
  );
});

test('native artifact saving requires an owned main frame on the current trusted app', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('No separate download request is needed.'));
  f.showEngine();
  const window = f.windows.at(-1);
  const sender = window.webContents;
  const frame = sender.mainFrame;
  const event = {
    preventDefault: () => assert.fail('Excluded downloads keep their default behavior.'),
  };
  for (const [candidate, candidateFrame] of [
    [undefined, undefined],
    [{ mainFrame: frame }, frame],
    [sender, { url: frame.url }],
    [sender, null],
  ]) {
    const item = artifactDownload();
    f.saveEngineDownload(event, item, candidate, candidateFrame);
    assert.equal(item.savedPath, undefined);
  }
  for (const url of ['https://example.test/', 'http://127.0.0.1:4310/api/artifacts/example']) {
    frame.url = url;
    const item = artifactDownload();
    f.saveEngineDownload(event, item, sender, frame);
    assert.equal(item.savedPath, undefined);
  }
  frame.url = 'http://127.0.0.1:4310/';
  const saved = artifactDownload();
  f.saveEngineDownload(event, saved, sender, frame);
  assert.equal(dirname(dirname(saved.savedPath)), dirname(f.storage.path));
  await writeFile(saved.savedPath, 'owned artifact');
  saved.emit('done', {}, 'completed');
  assert.equal(
    await readFile(join(dirname(f.storage.path), 'report.csv'), 'utf8'),
    'owned artifact',
  );
  window.destroy();
  const retired = artifactDownload();
  f.saveEngineDownload(event, retired, sender, frame);
  assert.equal(retired.savedPath, undefined);
});

test('native settings reject foreign windows, subframes, AI credentials, and web onboarding writes', async (t) => {
  const f = await runningDesktop(
    t,
    () => assert.fail('Settings must not make an engine request.'),
    { platform: 'win32' },
  );
  const { OTTO_VAULT_KEY: vaultKey } = await f.storage.store.environment();
  assert.ok(vaultKey);
  f.showEngine();
  const window = f.windows.at(-1);
  const frame = { url: 'http://127.0.0.1:4310/' };
  window.webContents.mainFrame = frame;
  const paymentURL = 'http://127.0.0.1:4310/payments/synthetic-request';
  const opened = window.webContents.openWindow({ url: paymentURL });
  assert.equal(opened.action, 'allow');
  window.webContents.emit(
    'will-navigate',
    { preventDefault: () => assert.fail('The owned payment page stays in the app.') },
    paymentURL,
  );
  assert.equal(window.webContents.openWindow({ url: 'file:///synthetic' }).action, 'deny');
  const event = { sender: window.webContents, senderFrame: frame };
  const invoke = (channel, target, ...args) =>
    Promise.resolve().then(() => f.handlers.get(channel)(target, ...args));
  const get = (target = event) => invoke('otto:settings:get', target);
  const save = (value, target = event) => invoke('otto:settings:save', target, value);
  assert.equal(f.handlers.has('otto:settings:reveal'), false);
  for (const rejected of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: window.webContents, senderFrame: { url: frame.url } },
  ]) {
    await assert.rejects(get(rejected));
    await assert.rejects(save({ composioApiKey: 'synthetic-injected-key' }, rejected));
  }
  for (const url of ['https://example.test/', 'http://127.0.0.1:4310/api/files/synthetic']) {
    frame.url = url;
    await assert.rejects(get());
    await assert.rejects(save({ theme: 'dark' }));
  }
  frame.url = 'http://127.0.0.1:4310/onboarding';
  const previous = await readFile(f.storage.path, 'utf8');
  for (const value of [
    { onboardingCompleted: false },
    { openaiApiKey: 'synthetic-ai-key' },
    { anthropicApiKey: 'synthetic-ai-key' },
    { vaultKey: 'synthetic-vault-key' },
    { clearKeys: ['composioApiKey'] },
    { composioApiKey: 'synthetic-injected-key' },
  ])
    await assert.rejects(save(value));
  assert.equal(await readFile(f.storage.path, 'utf8'), previous);
  const vaultCiphertext = JSON.parse(previous).secrets.vaultKey;
  assert.ok(vaultCiphertext);
  assert.notEqual(vaultCiphertext, vaultKey);
  const serialized = JSON.stringify(await get());
  assert.equal(serialized.includes(vaultKey), false);
  assert.equal(serialized.includes(vaultCiphertext), false);
  await save({ theme: 'dark', launchAtLogin: true });
  assert.equal((await f.storage.store.get()).launchAtLogin, true);
  window.destroy();
  await assert.rejects(save({ theme: 'light' }));
  f.setReady(false);
  f.showSettings();
  const setup = f.windows.at(-1).webContents;
  f.status().runtime = { phase: 'error', needsWsl: true };
  for (const rejected of [
    { sender: window.webContents, senderFrame: frame },
    { sender: { mainFrame: setup.mainFrame }, senderFrame: setup.mainFrame },
    { sender: setup, senderFrame: { url: setup.mainFrame.url } },
  ])
    await assert.rejects(invoke('otto:runtime:install-wsl', rejected));
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

test('the engine token waits for the engine Otto started to report its port', async (t) => {
  const requests = [];
  const f = await runningDesktop(
    t,
    async (url) => {
      requests.push(url);
      return Response.json({ ok: true });
    },
    { allowStart: true, reportReady: false },
  );
  f.crash();
  const prepared = f.prepare();
  for (let attempt = 0; !f.children.length && attempt < 250; attempt += 1)
    await new Promise((accept) => setTimeout(accept, 20));
  assert.equal(f.children.length, 1);
  await new Promise((accept) => setTimeout(accept, 1000));
  f.children[0].emit('exit', 1);
  assert.equal((await prepared).phase, 'error');
  assert.deepEqual(requests, []);
});

async function fixture(t, platform = 'win32') {
  const directory = await mkdtemp(join(tmpdir(), 'otto-desktop-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'profile', 'settings.json');
  const key = randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    isAsyncEncryptionAvailable: async () => encryption.isEncryptionAvailable(),
    getSelectedStorageBackend: () => 'synthetic-secure-store',
    encryptStringAsync: async (value) => encryption.encryptString(value),
    decryptStringAsync: async (value) => ({
      result: encryption.decryptString(value),
      shouldReEncrypt: false,
    }),
    encryptString(value) {
      if (platform === 'darwin') {
        const cipher = createCipheriv('aes-128-cbc', key.subarray(0, 16), Buffer.alloc(16, 32));
        return Buffer.concat([Buffer.from('v10'), cipher.update(value, 'utf8'), cipher.final()]);
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    },
    decryptString(value) {
      if (platform === 'darwin') {
        const decipher = createDecipheriv('aes-128-cbc', key.subarray(0, 16), Buffer.alloc(16, 32));
        return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString(
          'utf8',
        );
      }
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
    store: createSettingsStore(path, encryption, platform),
    reopen: () => createSettingsStore(path, encryption, platform),
  };
}

test(
  'Windows DPAPI keeps the Vault and completed setup across real Electron restarts behind private ACLs',
  { skip: process.platform !== 'win32', timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'otto-dpapi-restart-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const profile = join(directory, 'profile');
    await mkdir(join(directory, 'electron'));
    const engineRoot = fileURLToPath(new URL('../../', import.meta.url));
    await protectWindowsProfile(profile, engineRoot);
    const { transformWithEsbuild } = await import('vite');
    const cryptoSource = fileURLToPath(
      new URL('../../src/server/vault-crypto.ts', import.meta.url),
    );
    const vault = join(directory, 'vault-crypto.mjs');
    await writeFile(
      vault,
      (await transformWithEsbuild(await readFile(cryptoSource, 'utf8'), cryptoSource)).code,
    );
    const script = join(directory, 'probe.mjs');
    await writeFile(
      script,
      `import assert from 'node:assert/strict';
import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSettingsStore } from ${JSON.stringify(new URL('../main/settings.mjs', import.meta.url).href)};
import { sealVaultValue, openVaultValue } from ${JSON.stringify(pathToFileURL(vault).href)};
app.setPath('userData', process.env.OTTO_STORAGE_TEST_USER_DATA);
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const profile = process.env.OTTO_STORAGE_TEST_PROFILE;
  const settingsPath = join(profile, 'settings.json');
  const store = createSettingsStore(settingsPath, safeStorage);
  if (process.argv.at(-1) === 'write')
    await store.save({ notifications: false, launchAtLogin: true, onboardingCompleted: true });
  const { OTTO_VAULT_KEY } = await store.environment();
  const key = Buffer.from(OTTO_VAULT_KEY, 'base64');
  const binding = ['synthetic-owner', 'synthetic-account'];
  const secret = 'synthetic-private-provider-key';
  const ciphertextPath = join(profile, 'vault');
  if (process.argv.at(-1) === 'write')
    await writeFile(ciphertextPath, sealVaultValue(key, binding, secret));
  const ciphertext = await readFile(ciphertextPath, 'utf8');
  assert.equal(openVaultValue(key, binding, ciphertext), secret);
  assert.throws(() => openVaultValue(key, ['different-owner', binding[1]], ciphertext));
  const settings = await readFile(settingsPath);
  assert.equal(settings.includes(OTTO_VAULT_KEY), false);
  assert.equal(ciphertext.includes(secret), false);
  process.stdout.write('OTTO_STORAGE_RESULT=' + JSON.stringify({
    keyHash: createHash('sha256').update(key).digest('hex'),
    settingsHash: createHash('sha256').update(settings).digest('hex'),
    preferences: await store.get(),
  }) + '\\n');
  app.exit(0);
}).catch(async (error) => {
  process.stderr.write(error.stack + '\\n');
  app.exit(1);
});
`,
    );
    const environment = {
      ...process.env,
      OTTO_STORAGE_TEST_PROFILE: profile,
      OTTO_STORAGE_TEST_USER_DATA: join(directory, 'electron'),
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const execute = (file, args, env = environment) =>
      new Promise((resolve, reject) => {
        execFile(
          file,
          args,
          { env, timeout: 45_000, windowsHide: true },
          (error, stdout, stderr) => {
            if (error) reject(new Error(`${error.message}\n${stderr}`));
            else resolve(stdout);
          },
        );
      });
    const { default: electron } = await import('../node_modules/electron/index.js');
    const run = async (mode) => {
      const output = await execute(electron, [script, mode]);
      const result = output.match(/OTTO_STORAGE_RESULT=([^\r\n]+)/);
      assert.ok(result, 'The Electron process must return its storage receipt.');
      return JSON.parse(result[1]);
    };
    const first = await run('write');
    const restarted = await run('read');
    assert.deepEqual(restarted, first);
    assert.deepEqual(restarted.preferences, {
      launchAtLogin: true,
      notifications: false,
      theme: 'system',
      onboardingCompleted: true,
      onboardingPreferenceStep: 'complete',
    });
    const acl = JSON.parse(
      await execute(
        join(process.env.SYSTEMROOT, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$expected = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$results = foreach ($path in @($env:OTTO_STORAGE_TEST_PROFILE, (Join-Path $env:OTTO_STORAGE_TEST_PROFILE 'settings.json'), (Join-Path $env:OTTO_STORAGE_TEST_PROFILE 'vault'))) {
  $acl = Get-Acl -LiteralPath $path
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  [pscustomobject]@{
    private = ($rules.Count -eq 3 -and @($rules | Where-Object { $_.IdentityReference.Value -notin $expected -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count -eq 0)
    owner = ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $owner)
    protected = $acl.AreAccessRulesProtected
  }
}
ConvertTo-Json -InputObject @($results) -Compress`,
        ],
      ),
    );
    assert.equal(acl.length, 3);
    assert.ok(acl.every((value) => value.private && value.owner));
    assert.equal(acl[0].protected, true);
  },
);

test('legacy app keys migrate privately and remain encrypted until the exact durable acknowledgement', async (t) => {
  const f = await fixture(t);
  await f.store.environment();
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  const secret = 'synthetic-retired-composio-key';
  saved.secrets.composioApiKey = f.encryption.encryptString(secret).toString('base64');
  saved.secrets.integrationConfiguration = f.encryption
    .encryptString(JSON.stringify({ COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'synthetic-retired-config' }))
    .toString('base64');
  saved.keyMetadata.composioApiKey = {
    suffix: secret.slice(-4),
    source: 'manual',
    updatedAt: '2026-10-08T00:00:00.000Z',
  };
  await writeFile(f.path, JSON.stringify(saved));
  const store = f.reopen();
  const expectedVault = f.encryption.decryptString(Buffer.from(saved.secrets.vaultKey, 'base64'));
  assert.deepEqual(await store.environment(), { OTTO_VAULT_KEY: expectedVault });
  assert.equal(Object.hasOwn(await store.get(), 'keys'), false);
  assert.equal(Object.hasOwn(await store.get(), 'hasComposioKey'), false);
  assert.equal(store.revealKey, undefined);
  await store.save({ theme: 'dark', notifications: true });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).secrets, saved.secrets);
  assert.deepEqual(await f.reopen().environment(), { OTTO_VAULT_KEY: expectedVault });
  await assert.rejects(store.save({ composioApiKey: 'synthetic-replacement-key' }), /supported/);
  const damaged = {
    ...saved,
    secrets: {
      ...saved.secrets,
      integrationConfiguration: f.encryption
        .encryptString('synthetic-private-malformed-config')
        .toString('base64'),
    },
  };
  await writeFile(f.path, JSON.stringify(damaged));
  await assert.rejects(
    f.reopen().legacyIntegration(),
    (error) => error.message === 'Otto could not open its saved app connection.',
  );
  await writeFile(f.path, JSON.stringify({ ...saved, theme: 'dark', notifications: true }));
  const pending = await store.legacyIntegration();
  assert.equal(pending.apiKey, secret);
  assert.deepEqual(pending.authConfigs, { gmail: 'synthetic-retired-config' });
  assert.deepEqual(await f.reopen().legacyIntegration(), pending);
  await assert.rejects(store.acknowledgeLegacyIntegration('0'.repeat(64)), /changed/);
  const replaced = {
    ...saved,
    secrets: {
      ...saved.secrets,
      composioApiKey: f.encryption
        .encryptString('synthetic-replaced-legacy-key')
        .toString('base64'),
    },
  };
  await writeFile(f.path, JSON.stringify(replaced));
  await assert.rejects(store.acknowledgeLegacyIntegration(pending.receipt), /changed/);
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).secrets, replaced.secrets);
  await writeFile(f.path, JSON.stringify({ ...saved, theme: 'dark', notifications: true }));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).secrets, saved.secrets);
  await store.acknowledgeLegacyIntegration(pending.receipt);
  assert.equal(await f.reopen().legacyIntegration(), undefined);
  const migrated = JSON.parse(await readFile(f.path, 'utf8'));
  assert.deepEqual(migrated.secrets, { vaultKey: saved.secrets.vaultKey });
  assert.deepEqual(migrated.keyMetadata, {});
  assert.equal(migrated.theme, 'dark');
  assert.equal(migrated.notifications, true);
  assert.deepEqual(await f.reopen().environment(), { OTTO_VAULT_KEY: expectedVault });
});

test('macOS settings unlock asynchronously without rewriting existing ciphertext or calling synchronous storage', async (t) => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    await t.test(platform, async (t) => {
      const f = await fixture(t, platform);
      const expected = await createSettingsStore(f.path, f.encryption, 'win32').environment();
      const previous = await readFile(f.path, 'utf8');
      const storage = { ...f.encryption };
      let accessed = false;
      if (platform === 'darwin') {
        const permitted = deferred();
        storage.isAsyncEncryptionAvailable = async () => {
          accessed = true;
          await permitted.promise;
          return true;
        };
        storage.encryptStringAsync = async (value) => f.encryption.encryptString(value);
        storage.decryptStringAsync = async (value) => ({
          result: f.encryption.decryptString(value),
          shouldReEncrypt: true,
        });
        for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString'])
          storage[method] = () => assert.fail('macOS must not block on synchronous storage.');
        const store = createSettingsStore(f.path, storage, platform);
        const environment = store.environment();
        void environment.catch(() => {});
        for (let attempt = 0; !accessed && attempt < 100; attempt++)
          await new Promise((accept) => setTimeout(accept, 10));
        assert.equal(accessed, true);
        await new Promise(setImmediate);
        assert.equal(await readFile(f.path, 'utf8'), previous);
        permitted.resolve();
        assert.deepEqual(await environment, expected);
      } else {
        for (const method of [
          'isAsyncEncryptionAvailable',
          'encryptStringAsync',
          'decryptStringAsync',
        ])
          storage[method] = () => assert.fail('Other platforms retain their current storage.');
        assert.deepEqual(
          await createSettingsStore(f.path, storage, platform).environment(),
          expected,
        );
      }
      assert.equal(await readFile(f.path, 'utf8'), previous);
    });
  }
  for (const failure of ['unavailable', 'denied', 'basic_text']) {
    const f = await fixture(t);
    const previous = await f.store.environment();
    const bytes = await readFile(f.path, 'utf8');
    const storage = {
      ...f.encryption,
      isAsyncEncryptionAvailable: async () => failure !== 'unavailable',
      getSelectedStorageBackend: () => failure,
      encryptStringAsync: async () => {
        throw new Error('Synthetic keychain denial.');
      },
      decryptStringAsync: async () => {
        throw new Error('Synthetic keychain denial.');
      },
    };
    const fresh = join(dirname(f.path), 'fresh.json');
    for (const path of [fresh, f.path])
      await assert.rejects(
        createSettingsStore(path, storage, 'darwin').environment(),
        /quit and reopen/,
      );
    await assert.rejects(readFile(fresh), { code: 'ENOENT' });
    assert.equal(await readFile(f.path, 'utf8'), bytes);
    assert.deepEqual(await f.reopen().environment(), previous);
  }
});

test('macOS settings reject async decryption through a key other than the OS key', async (t) => {
  const f = await fixture(t, 'darwin');
  await f.store.environment();
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  const fallback = Buffer.from('d0d0ec9c7d77d43ac54187fa4818d17f', 'hex');
  const cipher = createCipheriv('aes-128-cbc', fallback, Buffer.alloc(16, 32));
  saved.secrets.vaultKey = Buffer.concat([
    Buffer.from('v10'),
    cipher.update(randomBytes(32).toString('base64'), 'utf8'),
    cipher.final(),
  ]).toString('base64');
  await writeFile(f.path, JSON.stringify(saved));
  const previous = await readFile(f.path, 'utf8');
  const storage = {
    ...f.encryption,
    decryptStringAsync: async (value) => {
      const decipher = createDecipheriv('aes-128-cbc', fallback, Buffer.alloc(16, 32));
      return {
        result: Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString(
          'utf8',
        ),
        shouldReEncrypt: false,
      };
    },
  };
  await assert.rejects(
    createSettingsStore(f.path, storage, 'darwin').environment(),
    /quit and reopen/,
  );
  assert.equal(await readFile(f.path, 'utf8'), previous);
});

test('native onboarding replay reaches product onboarding without restarting or resetting the profile', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('Replay must not make an engine request.'));
  await f.storage.store.environment();
  const before = await readFile(f.storage.path, 'utf8');
  f.showEngine();
  const chat = f.windows.at(-1);
  f.replayOnboarding();
  assert.equal(f.windows.length, 1);
  assert.equal(chat.url, 'http://127.0.0.1:4310/onboarding?replay=1');
  assert.equal(chat.isDestroyed(), false);
  assert.equal(f.children.length, 0);
  assert.equal(await readFile(f.storage.path, 'utf8'), before);
});

test('unavailable or plaintext key stores refuse secret persistence and decryption', async (t) => {
  const f = await fixture(t);
  await f.store.environment();
  const previous = await readFile(f.path, 'utf8');
  for (const unavailable of [
    { ...f.encryption, isEncryptionAvailable: () => false },
    { ...f.encryption, getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const store = createSettingsStore(f.path, unavailable, 'win32');
    const fresh = createSettingsStore(join(dirname(f.path), 'fresh.json'), unavailable, 'win32');
    await assert.rejects(fresh.environment());
    await assert.rejects(store.environment());
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
  const value = JSON.parse(previous);
  const ciphertext = Buffer.from(value.secrets.vaultKey, 'base64');
  ciphertext[12] ^= 1;
  value.secrets.vaultKey = ciphertext.toString('base64');
  await writeFile(f.path, JSON.stringify(value));
  await assert.rejects(f.reopen().environment());
});

test('unsupported saved schemas fail closed without rewriting or unlocking their contents', async (t) => {
  const f = await fixture(t);
  await f.store.environment();
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  const variants = [
    { ...saved, version: 2 },
    { ...saved, provider: 'openai' },
    { ...saved, notifications: undefined },
    { ...saved, secrets: { ...saved.secrets, openaiApiKey: 'unsupported-ciphertext' } },
    { ...saved, secrets: { ...saved.secrets, vaultKey: '' } },
    {
      ...saved,
      keyMetadata: { composioApiKey: { ...saved.keyMetadata.composioApiKey, source: 'saved' } },
    },
    { ...saved, keyMetadata: null },
    null,
    [],
  ];
  for (const value of variants) {
    const disk = JSON.stringify(value);
    await writeFile(f.path, disk);
    const store = createSettingsStore(
      f.path,
      {
        ...f.encryption,
        isEncryptionAvailable: () => assert.fail('Invalid storage must not access the key store.'),
      },
      'win32',
    );
    await assert.rejects(store.get());
    await assert.rejects(store.environment());
    await assert.rejects(store.save({ theme: 'dark' }));
    assert.equal(await readFile(f.path, 'utf8'), disk);
  }
});

test('a keyless installation creates one persistent encrypted vault across concurrent startup and preference changes', async (t) => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(await f.store.get(), 'hasComposioKey'), false);
  const environments = await Promise.all(Array.from({ length: 8 }, () => f.store.environment()));
  const vault = environments[0].OTTO_VAULT_KEY;
  assert.equal(Buffer.from(vault, 'base64').length, 32);
  for (const environment of environments) assert.deepEqual(environment, { OTTO_VAULT_KEY: vault });
  assert.equal((await f.reopen().environment()).OTTO_VAULT_KEY, vault);
  assert.ok(!(await readFile(f.path, 'utf8')).includes(vault));
  await f.store.save({ notifications: true, onboardingCompleted: true });
  assert.equal((await f.store.environment()).OTTO_VAULT_KEY, vault);
});

test('settings withhold completion when temporary bytes fail to persist', async (t) => {
  const f = await fixture(t);
  const environment = await f.store.environment();
  const saved = await readFile(f.path, 'utf8');
  const handle = await open(f.path, 'r');
  const prototype = Object.getPrototypeOf(handle);
  const sync = prototype.sync;
  await handle.close();
  let fail = true;
  t.mock.method(prototype, 'sync', async function () {
    if (fail && (await this.stat()).isFile())
      throw Object.assign(new Error('Synthetic file persistence failure'), { code: 'EIO' });
    return sync.call(this);
  });
  await assert.rejects(f.store.save({ onboardingCompleted: true }), { code: 'EIO' });
  assert.equal(await readFile(f.path, 'utf8'), saved);
  assert.equal((await f.store.get()).onboardingCompleted, false);
  assert.deepEqual(await readdir(dirname(f.path)), ['settings.json']);
  fail = false;
  await f.store.save({ onboardingCompleted: true });
  assert.equal((await f.reopen().get()).onboardingCompleted, true);
  assert.deepEqual(await f.reopen().environment(), environment);
});

test(
  'settings retain the published Vault key and completion through failed directory persistence and restart',
  { skip: process.platform === 'win32' },
  async (t) => {
    const f = await fixture(t);
    const ancestor = await stat(dirname(dirname(f.path)));
    const handle = await open(dirname(dirname(f.path)), 'r');
    const prototype = Object.getPrototypeOf(handle);
    const sync = prototype.sync;
    await handle.close();
    let fail = true;
    let encrypted = 0;
    const encrypt = f.encryption.encryptString;
    f.encryption.encryptString = (value) => {
      encrypted++;
      return encrypt(value);
    };
    t.mock.method(prototype, 'sync', async function () {
      const metadata = await this.stat();
      if (fail && metadata.dev === ancestor.dev && metadata.ino === ancestor.ino)
        throw Object.assign(new Error('Synthetic directory persistence failure'), { code: 'EIO' });
      return sync.call(this);
    });
    await assert.rejects(f.store.environment(), { code: 'EIO' });
    const saved = await readFile(f.path, 'utf8');
    const reopened = f.reopen();
    await assert.rejects(f.store.environment(), { code: 'EIO' });
    await assert.rejects(reopened.environment(), { code: 'EIO' });
    assert.equal(await readFile(f.path, 'utf8'), saved);
    assert.equal(encrypted, 1);
    fail = false;
    const environment = await f.store.environment();
    assert.deepEqual(await reopened.environment(), environment);
    fail = true;
    await assert.rejects(f.store.save({ onboardingCompleted: true }), { code: 'EIO' });
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).onboardingCompleted, true);
    await assert.rejects(f.store.get(), { code: 'EIO' });
    await assert.rejects(f.store.environment(), { code: 'EIO' });
    await assert.rejects(f.reopen().get(), { code: 'EIO' });
    fail = false;
    await f.store.save({ theme: 'dark' });
    const restored = f.reopen();
    assert.equal((await restored.get()).onboardingCompleted, true);
    assert.equal((await restored.get()).theme, 'dark');
    assert.deepEqual(await restored.environment(), environment);
    assert.equal(encrypted, 1);
  },
);

test('feedback screenshots stay in the trusted visible app and exclude private views and navigation races', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('Capture must not make an engine request.'));
  f.showEngine();
  const window = f.windows.at(-1);
  const contents = window.webContents;
  const frame = contents.mainFrame;
  const event = { sender: contents, senderFrame: frame };
  const capture = f.handlers.get('otto:feedback:capture');
  let safe = true;
  let captured = 0;
  const dom = new JSDOM(
    '<main>Sent synthetic conversation</main><div contenteditable="true"><p><br></p></div>',
  );
  t.after(() => dom.window.close());
  let bytes = Buffer.from('synthetic-image');
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 3200, height: 1800 }),
    resize: () => ({ toJPEG: () => bytes }),
  };
  contents.executeJavaScript = async (script) =>
    safe &&
    runInNewContext(script, {
      document: dom.window.document,
      HTMLInputElement: dom.window.HTMLInputElement,
      HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
    });
  contents.capturePage = async () => {
    captured++;
    return image;
  };
  for (const rejected of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: contents, senderFrame: { url: frame.url } },
  ])
    assert.throws(() => capture(rejected));
  for (const path of [
    '/credentials/synthetic',
    '/payments/synthetic',
    '/trust',
    '/vault/synthetic',
    '/browser',
    '/browser-connect/synthetic',
    '/onboarding',
  ]) {
    frame.url = `http://127.0.0.1:4310${path}`;
    assert.equal(await capture(event), null);
  }
  frame.url = 'http://127.0.0.1:4310/';
  window.visible = false;
  assert.equal(await capture(event), null);
  window.visible = true;
  safe = false;
  assert.equal(await capture(event), null);
  assert.equal(captured, 0);
  safe = true;
  const allowed = dom.window.document.body.innerHTML;
  const leaked = [];
  for (const [name, markup] of [
    [
      'collapsed handoff',
      '<div class="browser-handoff"><img src="synthetic-private-page.png"></div>',
    ],
    ['input draft', '<input value="Synthetic unsent private input">'],
    ['textarea draft', '<textarea>Synthetic unsent private textarea</textarea>'],
    [
      'rich chat draft',
      '<div contenteditable="true"><p>Synthetic <strong>unsent chat</strong></p></div>',
    ],
    ['plain chat draft', '<div contenteditable="plaintext-only">Synthetic unsent plain chat</div>'],
    ['pending upload', '<div class="pending-attachments">Synthetic private attachment</div>'],
  ]) {
    dom.window.document.body.innerHTML = markup;
    if (name === 'input draft')
      dom.window.document.querySelector('input').value = 'Synthetic changed input property';
    const before = dom.window.document.body.innerHTML;
    const fields = [...dom.window.document.querySelectorAll('input, textarea')].map(
      (field) => field.value,
    );
    if ((await capture(event)) !== null) leaked.push(name);
    assert.equal(dom.window.document.body.innerHTML, before);
    assert.deepEqual(
      [...dom.window.document.querySelectorAll('input, textarea')].map((field) => field.value),
      fields,
    );
  }
  assert.deepEqual(leaked, []);
  assert.equal(captured, 0);
  dom.window.document.body.innerHTML = allowed;
  assert.deepEqual(await capture(event), bytes);
  assert.equal(captured, 1);
  bytes = Buffer.alloc(2 * 1024 * 1024 + 1);
  assert.equal(await capture(event), null);
  bytes = Buffer.from('synthetic-image');
  assert.deepEqual(await capture(event), bytes);
  const pending = deferred();
  contents.capturePage = () => pending.promise;
  const racing = capture(event);
  await new Promise(setImmediate);
  safe = false;
  pending.resolve(image);
  assert.equal(await racing, null);
  safe = true;
  const draftPending = deferred();
  contents.capturePage = () => draftPending.promise;
  const typing = capture(event);
  await new Promise(setImmediate);
  dom.window.document.querySelector('[contenteditable]').textContent =
    'Synthetic newly typed private draft';
  draftPending.resolve(image);
  assert.equal(await typing, null);
  assert.equal(
    dom.window.document.querySelector('[contenteditable]').textContent,
    'Synthetic newly typed private draft',
  );
  dom.window.document.body.innerHTML = allowed;
  safe = true;
  const navigated = deferred();
  contents.capturePage = () => navigated.promise;
  const navigating = capture(event);
  await new Promise(setImmediate);
  frame.url = 'http://127.0.0.1:4310/credentials/synthetic';
  navigated.resolve(image);
  assert.equal(await navigating, null);
});

test('engine preload exposes no credential reveal and withholds privileged IPC event objects', async () => {
  const listeners = new Map();
  let bridge;
  runInNewContext(await readFile(new URL('../preload/engine.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      contextBridge: {
        exposeInMainWorld(_name, value) {
          bridge = value;
        },
      },
      ipcRenderer: {
        on: (channel, receive) => listeners.set(channel, receive),
      },
    }),
  });
  for (const field of [
    'revealKey',
    'revealComposioKey',
    'applySettings',
    'getAppPreferences',
    'saveAppPreferences',
    'prepare',
    'importRuntime',
  ])
    assert.equal(bridge[field], undefined);
  let received;
  bridge.onPreferences((...values) => {
    received = values;
  });
  const value = { theme: 'dark', resolvedTheme: 'dark', notifications: true, launchAtLogin: false };
  listeners.get('otto:preferences')({ sender: 'privileged-synthetic-ipc' }, value);
  assert.deepEqual(received, [value]);
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

test('native chat read positions reject cross-owner and malformed metadata without changing saved state', async (t) => {
  const f = await chatReadFixture(t);
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  await f.store.set(f.ownerId, f.threadId, position);
  const saved = await readFile(f.path, 'utf8');
  await assert.rejects(f.store.get(randomUUID(), f.threadId));
  await assert.rejects(f.store.set(randomUUID(), f.threadId, position));
  await assert.rejects(f.store.get(f.ownerId, '../../other'));
  for (const invalid of [
    { ...position, createdAt: '2026-10-02T10:00:00Z' },
    { ...position, createdAt: '2026-02-30T10:00:00.000Z' },
    { ...position, messageIds: [position.messageIds[0].toUpperCase()] },
    { ...position, messageIds: Array.from({ length: 2049 }, () => randomUUID()) },
    { ...position, content: 'Synthetic message content must never be stored here.' },
  ])
    await assert.rejects(f.store.set(f.ownerId, f.threadId, invalid));
  assert.equal(await readFile(f.path, 'utf8'), saved);
  f.identity.ownerId = randomUUID();
  await assert.rejects(f.store.get(f.ownerId, f.threadId));
  await assert.rejects(f.store.get(f.identity.ownerId, f.threadId));
  assert.equal(await readFile(f.path, 'utf8'), saved);
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
  if (process.platform !== 'win32') assert.equal((await stat(f.path)).mode & 0o777, 0o600);
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
  assert.equal(f.state.server.notificationRule, 'synthetic-notification-rule');
  assert.deepEqual(
    JSON.parse(f.state.calls.find(({ method }) => method === 'PATCH').body),
    stored.pending,
  );
  assert.ok(!JSON.stringify(result).includes('synthetic-notification-rule'));
  assert.ok(!(await readFile(f.path, 'utf8')).includes('synthetic-notification-rule'));
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).pending, {});
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

function updateReleaseFixture(sourceUrl, arch = 'arm64', official = false) {
  const platform = `darwin-${arch}`;
  const name = (kind) => (arch === 'arm64' ? `${kind}.json` : `${kind}-darwin-x64.json`);
  const archive = {
    file: `Otto-Runtime-${platform}-${'b'.repeat(12)}.tar.gz`,
    bytes: 180,
    sha256: 'c'.repeat(64),
  };
  const runtime = {
    platform,
    ...(official ? { releaseTag: 'desktop-v0.1.9' } : {}),
    id: 'b'.repeat(64),
    fingerprint: 'd'.repeat(64),
    archive,
  };
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
      item(101, name('release'), 300),
      item(103, `Otto-${arch}.zip`, 1000),
      item(102, name('runtime-release'), 500),
      item(104, name('update'), 150),
    ],
  };
  const pack = {
    id: 18,
    tag_name: runtime.releaseTag || `runtime-${platform}-${runtime.fingerprint}`,
    draft: false,
    assets: [item(201, archive.file, archive.bytes)],
  };
  const manifest = {
    version: '0.2.0',
    platform,
    source: 'a'.repeat(40),
    signing: { mode: 'self-signed' },
    runtime,
    update: { file: `Otto-${arch}.zip`, bytes: 1000, sha256: 'e'.repeat(64) },
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
        url: `https://github.com/n8n-io/otto/releases/download/desktop-v0.2.0/Otto-${arch}.zip`,
        name: 'Otto 0.2.0',
      },
    ],
  ]);
  const calls = [];
  const source = createUpdateSource({
    sourceUrl,
    os: 'darwin',
    arch,
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
    assert.throws(() =>
      createUpdateSource({ sourceUrl: `https://updates.example.invalid/otto${suffix}` }),
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
    assert.equal(await f.source.latest('0.2.0'), undefined);
    f.manifest.runtime = { ...f.runtime, id: 'f'.repeat(64) };
    await assert.rejects(f.source.latest('0.1.0'));
    f.manifest.runtime = f.runtime;
    f.pack.assets[0].size++;
    await assert.rejects(f.source.latest('0.1.0'));
    f.pack.assets[0].size--;
    f.release.assets[1].digest = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(f.source.latest('0.1.0'));
    f.release.assets[1].digest = `sha256:${f.manifest.update.sha256}`;
    f.release.assets.push({ ...f.release.assets[0], id: 999 });
    await assert.rejects(f.source.latest('0.1.0'));
  }
});

test('an incomplete newest release falls back to the next newer complete release', async () => {
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/otto-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    const broken = { ...f.release, id: 15, tag_name: 'desktop-v0.3.0', assets: [] };
    f.values.get(`${f.base}/releases${sourceUrl ? '' : '?per_page=100'}`).push(broken);
    f.values.set(`${f.base}/releases/15`, broken);
    assert.equal((await f.source.latest('0.1.0')).version, '0.2.0');
    f.release.assets = [];
    await assert.rejects(f.source.latest('0.1.0'), /incomplete/);
  }
});

test(
  'manual update failures fence concurrent requests and retry only after an explicit choice without exposing diagnostics',
  { timeout: 10_000 },
  async (t) => {
    const failure = new Error(
      'Synthetic updater transport failure https://updates.example.invalid/private',
    );
    const firstCheck = deferred();
    const displayed = deferred();
    const decision = deferred();
    const prompts = [];
    let checks = 0;
    const updater = {
      check: async () => {
        checks++;
        if (checks === 1) return firstCheck.promise;
      },
    };
    const f = await runningDesktop(t, () => assert.fail('No engine request is needed.'), {
      prompt: (options) => {
        prompts.push(options);
        if (prompts.length === 1) {
          displayed.resolve();
          return decision.promise;
        }
        return { response: 0 };
      },
    });
    const initial = f.checkUpdates(updater);
    const duplicate = f.checkUpdates(updater);
    firstCheck.reject(failure);
    await displayed.promise;
    const duringDialog = f.checkUpdates(updater);
    try {
      await new Promise(setImmediate);
      assert.equal(checks, 1);
      assert.equal(prompts.length, 1);
      assert.equal(f.updateMenu.enabled, false);
      assert.equal(JSON.stringify(prompts).includes('Synthetic updater transport failure'), false);
      decision.resolve({ response: 0 });
      await Promise.all([initial, duplicate, duringDialog]);
      assert.equal(checks, 2);
      assert.equal(prompts.length, 2);
      assert.equal(f.updateMenu.enabled, true);
      await f.checkUpdates(updater);
      assert.equal(checks, 3);
      const diagnostic = await readFile(join(f.profileRoot, 'logs/startup.log'), 'utf8');
      assert.match(diagnostic, /Synthetic updater transport failure/);
      assert.equal(diagnostic.includes('https://updates.example.invalid/private'), false);
    } finally {
      decision.resolve({ response: 1 });
      await Promise.allSettled([initial, duplicate, duringDialog]);
    }
  },
);

test('declining a manual update retry and failed background checks never repeat work or show background errors', async (t) => {
  for (const manual of [true, false]) {
    let checks = 0;
    const prompts = [];
    const updater = {
      check: async () => {
        checks++;
        throw new Error('Synthetic update service unavailable');
      },
    };
    const f = await runningDesktop(t, () => assert.fail('No engine request is needed.'), {
      prompt: (options) => {
        prompts.push(options);
        return { response: 1 };
      },
    });
    if (manual) await f.checkUpdates(updater);
    else
      await assert.rejects(f.checkUpdates(updater, false), /Synthetic update service unavailable/);
    assert.equal(checks, 1);
    assert.equal(prompts.length, manual ? 1 : 0);
    assert.equal(JSON.stringify(prompts).includes('Synthetic update service unavailable'), false);
    assert.equal(f.updateMenu.enabled, true);
  }
});

test(
  'explicit restart retries retain the verified update and never download it again',
  { timeout: 10_000 },
  async (t) => {
    for (const retry of [true, false]) {
      const candidate = { version: '0.2.0', feedUrl: 'https://updates.example.invalid/pinned' };
      let selections = 0;
      let preparations = 0;
      let downloads = 0;
      let restarts = 0;
      const native = new EventEmitter();
      native.setFeedURL = () => {};
      native.checkForUpdates = () => {
        downloads++;
        queueMicrotask(() => native.emit('update-downloaded', {}, '', 'Otto 0.2.0'));
      };
      const updater = createDesktopUpdater({
        source: {
          latest: async () => {
            selections++;
            return candidate;
          },
        },
        currentVersion: '0.1.0',
        native,
        prepareRuntime: async () => {
          preparations++;
        },
        restart: async () => {
          restarts++;
          if (restarts === 1) throw new Error('Synthetic native restart failure');
        },
      });
      t.after(() => updater.dispose());
      const prompts = [];
      const f = await runningDesktop(t, () => assert.fail('No engine request is needed.'), {
        prompt: (options) => {
          prompts.push(options);
          return { response: prompts.length === 2 && !retry ? 1 : 0 };
        },
      });
      await f.checkUpdates(updater);
      assert.equal(restarts, retry ? 2 : 1);
      assert.equal(prompts.length, 2);
      assert.equal(updater.ready, candidate);
      assert.equal(JSON.stringify(prompts).includes('Synthetic native restart failure'), false);
      if (!retry) {
        await f.checkUpdates(updater);
        assert.equal(restarts, 2);
      }
      assert.equal(selections, 1);
      assert.equal(preparations, 1);
      assert.equal(downloads, 1);
      assert.equal(f.updateMenu.enabled, true);
    }
  },
);

test('background update readiness respects notification permission and quiet time without opening or repeating a dialog', async (t) => {
  for (const scenario of [
    { enabled: false, supported: true, quiet: false, expected: 0 },
    { enabled: true, supported: false, quiet: false, expected: 0 },
    { enabled: true, supported: true, quiet: true, expected: 0 },
    { enabled: true, supported: true, quiet: false, expected: 1 },
  ]) {
    const candidate = { version: '0.2.0' };
    let selections = 0;
    const updater = createDesktopUpdater({
      source: {
        latest: async () => {
          selections++;
          return candidate;
        },
      },
      currentVersion: '0.1.0',
      prepareRuntime: async () => {},
      restart: async () => assert.fail('Background readiness cannot restart Otto.'),
    });
    t.after(() => updater.dispose());
    const prompts = [];
    const f = await runningDesktop(t, () => assert.fail('No engine request is needed.'), {
      notificationsSupported: scenario.supported,
      webPreferences: {
        quietHoursEnabled: scenario.quiet,
        timeZone: 'UTC',
        quietStart: new Date(Date.now() - 3_600_000).toISOString().slice(11, 16),
        quietEnd: new Date(Date.now() + 3_600_000).toISOString().slice(11, 16),
      },
      prompt: (options) => {
        prompts.push(options);
        return { response: 1 };
      },
    });
    await f.showSettings();
    const window = f.windows.at(-1);
    await f.handlers.get('otto:settings:save')(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { notifications: scenario.enabled },
    );
    await f.checkUpdates(updater, false);
    await f.checkUpdates(updater, false);
    assert.equal(prompts.length, 0);
    assert.equal(f.notifications.length, scenario.expected);
    assert.equal(updater.ready, candidate);
    assert.equal(f.updateMenu.enabled, true);
    if (scenario.expected) f.notifications[0].emit('click');
    await f.checkUpdates(updater);
    assert.equal(prompts.length, 1);
    assert.equal(selections, 1);
  }
});

test('automatic update checks retry failures sooner and return to the normal interval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const powerMonitor = new EventEmitter();
  let calls = 0;
  let failures = 3;
  const stop = startDesktopUpdateChecks({
    powerMonitor,
    interval: 60_000,
    retry: 5,
    check: async () => {
      calls++;
      if (failures-- > 0) throw new Error('Desktop updates are unavailable.');
    },
  });
  t.after(stop);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  for (const [wait, expected] of [
    [4, 1],
    [1, 2],
    [9, 2],
    [1, 3],
    [19, 3],
    [1, 4],
    [59_999, 4],
    [1, 5],
  ]) {
    t.mock.timers.tick(wait);
    await settle();
    assert.equal(calls, expected);
  }
});

test('first installation resolves its exact published runtime without a newer app and rejects changed identities', async () => {
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/otto-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    assert.equal(await f.source.latest('0.2.0'), undefined);
    assert.equal(
      await f.source.runtimeDownloadUrl(f.runtime),
      sourceUrl
        ? `${sourceUrl}/releases/18/assets/201/${f.runtime.archive.file}`
        : 'https://api.github.com/repos/n8n-io/otto/releases/assets/201',
    );
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
    }
  }
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
  await assert.rejects(check);
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
  await assert.rejects(wrong.check());
  assert.equal(wrong.ready, undefined);
  wrong.dispose();
});

test('Windows downloads stage the verified installer and fetch the runtime pack only when it changed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'otto-windows-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = 'https://updates.example.invalid/otto-desktop';
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bytes = {
    'Otto-Setup-x64.exe': Buffer.from('synthetic Windows installer'),
    'Otto-Runtime-win32-x64.tar.gz': Buffer.from('synthetic Windows runtime pack'),
  };
  const entry = (file) => ({ file, bytes: bytes[file].length, sha256: digest(bytes[file]) });
  const manifest = {
    version: '0.2.0',
    platform: 'win32-x64',
    source: 'a'.repeat(40),
    signing: { mode: 'unsigned' },
    installer: entry('Otto-Setup-x64.exe'),
    runtime: entry('Otto-Runtime-win32-x64.tar.gz'),
  };
  const item = (id, name, size, sha256) => ({
    id,
    name,
    size,
    state: 'uploaded',
    digest: `sha256:${sha256}`,
  });
  const release = {
    id: 12,
    tag_name: 'desktop-v0.2.0',
    draft: false,
    assets: [
      item(301, 'release-win32-x64.json', 400, 'f'.repeat(64)),
      item(302, 'Otto-Setup-x64.exe', manifest.installer.bytes, manifest.installer.sha256),
      item(303, 'Otto-Runtime-win32-x64.tar.gz', manifest.runtime.bytes, manifest.runtime.sha256),
    ],
  };
  const served = { ...bytes };
  const downloads = [];
  const request = async (url) => {
    if (url === `${base}/releases`)
      return Response.json([{ ...release, id: 11, tag_name: 'desktop-v0.1.0' }, release]);
    if (url === `${base}/releases/12` || url === `${base}/tags/desktop-v0.2.0`)
      return Response.json(release);
    if (url === `${base}/releases/12/assets/301/release-win32-x64.json`)
      return Response.json(manifest);
    const asset = release.assets.find(
      (value) => url === `${base}/releases/12/assets/${value.id}/${value.name}`,
    );
    if (asset)
      return new Response(null, {
        status: 302,
        headers: { location: `https://release-assets.githubusercontent.com/${asset.name}` },
      });
    const name = url.slice('https://release-assets.githubusercontent.com/'.length);
    assert.ok(served[name], `Unexpected update request ${url}`);
    downloads.push(name);
    return new Response(served[name]);
  };
  const resourcesPath = join(root, 'resources');
  await mkdir(join(resourcesPath, 'windows-runtime'), { recursive: true });
  const installRuntime = (pack) =>
    Promise.all([
      writeFile(join(resourcesPath, 'windows-runtime/guest.tar.gz'), pack),
      writeFile(
        join(resourcesPath, 'windows-runtime/manifest.json'),
        JSON.stringify({ guest: { file: 'guest.tar.gz', sha256: digest(pack) } }),
      ),
    ]);
  await installRuntime(bytes['Otto-Runtime-win32-x64.tar.gz']);
  const directory = join(root, 'updates');
  const updater = createDesktopUpdater({
    source: createUpdateSource({ sourceUrl: base, os: 'win32', fetch: request }),
    currentVersion: '0.1.0',
    prepareRuntime: (candidate, signal) =>
      stageWindowsUpdate(candidate, { directory, resourcesPath, signal, fetch: request }),
    restart: async () => {},
  });
  const ready = await updater.check();
  assert.equal(ready.version, '0.2.0');
  assert.deepEqual(downloads, ['Otto-Setup-x64.exe']);
  assert.deepEqual(await readdir(join(directory, '0.2.0')), ['Otto-Setup-x64.exe']);
  assert.deepEqual(
    await readFile(join(directory, '0.2.0', 'Otto-Setup-x64.exe')),
    bytes['Otto-Setup-x64.exe'],
  );
  await updater.dispose();

  const candidate = await createUpdateSource({
    sourceUrl: base,
    os: 'win32',
    fetch: request,
  }).latest('0.1.0');
  downloads.length = 0;
  await installRuntime(Buffer.from('older Windows runtime pack'));
  await stageWindowsUpdate(candidate, { directory, resourcesPath, fetch: request });
  assert.deepEqual(downloads, ['Otto-Runtime-win32-x64.tar.gz', 'Otto-Setup-x64.exe']);
  for (const [name, value] of Object.entries(bytes))
    assert.deepEqual(await readFile(join(directory, '0.2.0', name)), value);

  const source = createUpdateSource({ sourceUrl: base, os: 'win32', fetch: request });
  const runtime = {
    releaseTag: 'desktop-v0.2.0',
    guest: { bytes: manifest.runtime.bytes, sha256: manifest.runtime.sha256 },
  };
  assert.equal(
    await source.runtimeDownloadUrl(runtime),
    `${base}/releases/12/assets/303/Otto-Runtime-win32-x64.tar.gz`,
  );
  await assert.rejects(
    source.runtimeDownloadUrl({ ...runtime, guest: { ...runtime.guest, sha256: 'e'.repeat(64) } }),
  );

  served['Otto-Setup-x64.exe'] = Buffer.alloc(bytes['Otto-Setup-x64.exe'].length, 'x');
  await assert.rejects(stageWindowsUpdate(candidate, { directory, resourcesPath, fetch: request }));
  await assert.rejects(stat(directory), { code: 'ENOENT' });

  release.assets[1].digest = `sha256:${'e'.repeat(64)}`;
  await assert.rejects(
    createUpdateSource({ sourceUrl: base, os: 'win32', fetch: request }).latest('0.1.0'),
  );
});

test('desktop update checks send the weekly ID only to the update source origin', async () => {
  const base = 'https://updates.example.invalid/otto-desktop';
  const hops = {
    [`${base}/releases`]: `${base}/moved`,
    [`${base}/moved`]: 'https://mirror.example.invalid/releases',
  };
  const seen = [];
  const source = createUpdateSource({
    sourceUrl: base,
    weeklyId: async () => 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    fetch: async (url, options) => {
      seen.push([url, options.headers['x-otto-week'], options.headers['x-otto-version']]);
      return hops[url]
        ? new Response(null, { status: 302, headers: { location: hops[url] } })
        : Response.json([]);
    },
  });
  assert.equal(await source.latest('0.1.0'), undefined);
  assert.deepEqual(seen, [
    [`${base}/releases`, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '0.1.0'],
    [`${base}/moved`, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '0.1.0'],
    ['https://mirror.example.invalid/releases', undefined, undefined],
  ]);
});

test('Intel updates use their own app assets and an official Otto runtime release', async () => {
  const f = updateReleaseFixture('https://updates.example.invalid/otto-desktop', 'x64', true);
  const candidate = await f.source.latest('0.1.0');
  assert.equal(candidate.runtime.platform, 'darwin-x64');
  assert(candidate.feedUrl.endsWith('platform=darwin-x64'));
  assert(f.calls.some((url) => url.endsWith('/release-darwin-x64.json')));
  assert(f.calls.some((url) => url.endsWith('/tags/desktop-v0.1.9')));
  f.manifest.platform = 'darwin-arm64';
  await assert.rejects(f.source.latest('0.1.0'));
  f.manifest.platform = 'darwin-x64';
  f.runtime.platform = 'darwin-arm64';
  await assert.rejects(f.source.latest('0.1.0'));
});

test('desktop preference choices resume durably and cannot skip or regress explicit consent', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.get()).onboardingPreferenceStep, 'notifications');
  await assert.rejects(f.store.save({ launchAtLogin: true, onboardingPreferenceStep: 'complete' }));
  await assert.rejects(f.store.save({ onboardingPreferenceStep: 'launchAtLogin' }));
  await f.store.save({ notifications: false, onboardingPreferenceStep: 'launchAtLogin' });
  const reopened = f.reopen();
  assert.equal((await reopened.get()).notifications, false);
  assert.equal((await reopened.get()).onboardingPreferenceStep, 'launchAtLogin');
  await reopened.save({ notifications: false, onboardingPreferenceStep: 'launchAtLogin' });
  await assert.rejects(
    reopened.save({ notifications: true, onboardingPreferenceStep: 'launchAtLogin' }),
  );
  await reopened.save({ launchAtLogin: false, onboardingPreferenceStep: 'complete' });
  await reopened.save({ launchAtLogin: false, onboardingPreferenceStep: 'complete' });
  assert.equal((await f.reopen().get()).onboardingPreferenceStep, 'complete');
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  delete saved.onboardingPreferenceStep;
  saved.onboardingCompleted = true;
  await writeFile(f.path, JSON.stringify(saved));
  assert.equal((await f.reopen().get()).onboardingPreferenceStep, 'complete');
  assert.equal((await f.reopen().get()).notifications, false);
  assert.equal((await f.reopen().get()).launchAtLogin, false);
});

test('early desktop preference writes require the owned setup frame and stop after handoff freezes', async (t) => {
  const runtime = deferred();
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'fresh',
    allowStart: true,
    prepareRuntime: () => runtime.promise,
  });
  try {
    await f.launch();
    const window = f.windows.at(-1);
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    const save = f.handlers.get('otto:settings:save');
    await assert.rejects(
      save(
        { ...event, senderFrame: { url: window.url } },
        { notifications: true, onboardingPreferenceStep: 'launchAtLogin' },
      ),
    );
    await save(event, { notifications: false, onboardingPreferenceStep: 'launchAtLogin' });
    assert.equal((await f.storage.reopen().get()).onboardingPreferenceStep, 'launchAtLogin');
    await save(event, { launchAtLogin: false, onboardingPreferenceStep: 'complete' });
    f.children[0].emit('message', { type: 'otto-setup-complete' });
    await new Promise(setImmediate);
    await assert.rejects(
      save(event, { notifications: true, onboardingPreferenceStep: 'launchAtLogin' }),
    );
    assert.equal((await f.storage.reopen().get()).onboardingPreferenceStep, 'complete');
  } finally {
    runtime.resolve({ env: {} });
    await f.settle();
    await f.close();
  }
});

test('native setup-ready notification waits for cleanup acknowledgement and only reaches opted-in background users once', async (t) => {
  for (const scenario of [
    { enabled: true, focused: false, supported: true, expected: 1 },
    { enabled: false, focused: false, supported: true, expected: 0 },
    { enabled: true, focused: true, supported: true, expected: 0 },
    { enabled: true, focused: false, supported: false, expected: 0 },
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const runtime = deferred();
      const cleanup = deferred();
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState: 'fresh',
        allowStart: true,
        prepareRuntime: () => runtime.promise,
        setupCleanup: cleanup.promise,
        notificationsSupported: scenario.supported,
      });
      try {
        await f.storage.store.save({ notifications: scenario.enabled });
        await f.launch();
        const setup = f.children[0];
        const window = f.windows.at(-1);
        window.focused = scenario.focused;
        setup.emit('message', { type: 'otto-setup-complete' });
        runtime.resolve({ env: {} });
        const deadline = Date.now() + 3000;
        while (
          !setup.sent.some((message) => message.type === 'otto-setup-ack') &&
          Date.now() < deadline
        )
          await new Promise(setImmediate);
        assert.ok(setup.sent.some((message) => message.type === 'otto-setup-ack'));
        await new Promise(setImmediate);
        assert.equal(f.notifications.length, 0);
        assert.equal(setup.killed, undefined);
        cleanup.resolve();
        await f.settle();
        await new Promise(setImmediate);
        assert.equal(setup.killed, true);
        assert.equal(f.notifications.length, scenario.expected);
        f.notifyReady();
        f.notifyReady();
        await new Promise(setImmediate);
        assert.equal(f.notifications.length, scenario.expected);
        if (scenario.expected) {
          assert.equal(window.focused, false);
          f.notifications[0].emit('click');
          assert.equal(window.focused, true);
        }
      } finally {
        runtime.resolve({ env: {} });
        cleanup.resolve();
        await f.settle();
        await f.close();
      }
    });
  }
});
