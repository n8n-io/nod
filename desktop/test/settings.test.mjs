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
import { createDesktopLifecycle } from '../main/lifecycle.mjs';
import {
  createDesktopUpdater,
  createUpdateSource,
  startDesktopUpdateChecks,
} from '../main/updates.mjs';
import {
  protectWindowsProfile,
  stageWindowsUpdate,
  windowsEnvironment,
} from '../runtime/windows.mjs';
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
  const directory = await mkdtemp(join(tmpdir(), 'nod-artifact-downloads-'));
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

test('storage starts the normal backend before workspace readiness and quit closes it before the runtime', async () => {
  const storage = deferred();
  const resources = deferred();
  const listening = deferred();
  const events = [];
  const computer = { close: async () => events.push('computer closed') };
  const lifecycle = createDesktopLifecycle({
    prepareRuntime: async ({ onStorageReady }) => {
      events.push('storage starting');
      await storage.promise;
      await onStorageReady(computer);
      listening.resolve();
      await resources.promise;
      return computer;
    },
    validateStart: async () => {},
    startEngine: async ({ runtime, pending }) => {
      assert.equal(runtime, computer);
      events.push(pending ? 'backend listening' : 'runtime ready');
    },
    stopEngine: async () => events.push('engine stopped'),
    onRuntimeStatus: () => {},
  });
  const running = lifecycle.start();
  assert.equal(running, lifecycle.start());
  await new Promise(setImmediate);
  assert.deepEqual(events, ['storage starting']);
  storage.resolve();
  await listening.promise;
  assert.equal(lifecycle.busy, true);
  assert.deepEqual(events, ['storage starting', 'backend listening']);
  resources.resolve();
  await running;
  assert.deepEqual(events, ['storage starting', 'backend listening', 'runtime ready']);
  const stopped = lifecycle.close();
  assert.equal(stopped, lifecycle.close());
  await stopped;
  assert.deepEqual(events.slice(-2), ['engine stopped', 'computer closed']);
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
    initialState = 'running',
    storedProfile,
    prepareRuntime,
    nativePageLoaded,
    enginePageLoaded,
    readyRenderers = true,
    notificationsSupported = false,
    updateLoginItems = () => true,
    loginItemStatus = () => ({}),
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
    openExternal,
  } = {},
) {
  const storage = storedProfile
    ? { ...storedProfile, store: storedProfile.reopen() }
    : await fixture(t, platform);
  if (!storedProfile && initialState !== 'fresh') {
    await storage.store.save({
      notifications: true,
      launchAtLogin: true,
      onboardingCompleted: true,
    });
    await storage.store.save({ notifications: false, launchAtLogin: false });
  }
  const windows = [];
  const children = [];
  const helpers = [];
  const paths = new Map();
  const handlers = new Map();
  const rendererReady = (window) =>
    handlers.get('nod:renderer-ready')?.({
      sender: window.webContents,
      senderFrame: window.webContents.mainFrame,
    });
  const notifications = [];
  const externalURLs = [];
  const updateMenu = {};
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
  });
  let openAtLogin = false;
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
      getLoginItemSettings: () => {
        const login = {
          status: openAtLogin ? 'enabled' : 'not-registered',
          executableWillLaunchAtLogin: openAtLogin,
          ...loginItemStatus(),
        };
        return platform === 'darwin'
          ? {
              status: login.status,
              executableWillLaunchAtLogin: false,
              openAtLogin: login.status === 'enabled',
              wasOpenedAtLogin: false,
            }
          : {
              launchItems: [],
              executableWillLaunchAtLogin: login.executableWillLaunchAtLogin,
              openAtLogin,
              wasOpenedAtLogin: false,
            };
      },
      setLoginItemSettings: (value) => {
        if (updateLoginItems(value)) openAtLogin = value.openAtLogin;
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
    shell: {
      showItemInFolder: reveal,
      openExternal: async (url) => {
        externalURLs.push(url);
        await openExternal?.(url);
      },
    },
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
        ? Promise.resolve(JSON.stringify({ nodBuild: buildMetadata }))
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
    Date,
    setTimeout,
    clearTimeout,
    fetch: request,
    createSettingsStore: () => storage.store,
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
          if (prepareRuntime) return prepareRuntime(options);
          const runtime = { env: {} };
          await options.onStorageReady?.(runtime);
          return runtime;
        },
      }),
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
    MessageChannelMain: class {
      port1 = { end: 'engine' };
      port2 = { end: 'helper' };
    },
    utilityProcess: {
      fork(file, args, options) {
        if (/[\\/]onepassword\.mjs$/.test(file)) {
          const helper = Object.assign(new EventEmitter(), { file, args, options, sent: [] });
          helper.postMessage = (message, transfer) => helper.sent.push({ message, transfer });
          helper.kill = () => {
            helper.killed = true;
          };
          helpers.push(helper);
          return helper;
        }
        assert.ok(allowStart, 'The healthy engine must not restart.');
        assert.ok(Object.values(options.env).every((value) => typeof value === 'string'));
        const child = new EventEmitter();
        assert.ok(file.endsWith('/engine.mjs') || file.endsWith('\\engine.mjs'));
        child.kind = 'engine';
        child.sent = [];
        child.transfers = [];
        child.postMessage = (message, transfer) => {
          child.sent.push(message);
          if (transfer) child.transfers.push({ message, transfer });
        };
        child.environment = options.env;
        child.port = options.env.PORT;
        child.stdout = { resume() {} };
        child.stderr = Object.assign(new EventEmitter(), { resume() {} });
        child.kill = () => {
          child.killed = true;
          child.emit('exit', 0);
        };
        if (reportReady)
          setImmediate(() =>
            child.emit('message', { type: 'nod-ready', port: Number(options.env.PORT) }),
          );
        children.push(child);
        return child;
      },
    },
    BrowserWindow: class extends EventEmitter {
      constructor(options = {}) {
        super();
        this.sent = [];
        this.bounds = {
          x: options.x ?? 0,
          y: options.y ?? 0,
          width: options.width,
          height: options.height,
        };
        this.visible = options.show !== false;
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
        if (this.visible) this.focus();
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
      isMinimized() {
        return this.minimized === true;
      }
      loadURL(url) {
        this.url = url;
        this.loading = true;
        this.webContents.mainFrame = {
          url,
          routingId: this.webContents.id,
          processId: this.webContents.id + 100,
        };
        return Promise.resolve(
          typeof enginePageLoaded === 'function' ? enginePageLoaded() : enginePageLoaded,
        ).then(async () => {
          this.loading = false;
          this.webContents.emit('did-finish-load');
          if (readyRenderers && !this.isDestroyed()) await rendererReady(this);
        });
      }
      loadFile(path, options) {
        this.path = path;
        this.query = options?.query;
        this.webContents.mainFrame = { url: pathToFileURL(path).href };
        return Promise.resolve(
          typeof nativePageLoaded === 'function' ? nativePageLoaded() : nativePageLoaded,
        ).then(async () => {
          if (readyRenderers && !this.isDestroyed()) await rendererReady(this);
        });
      }
      show() {
        this.minimized = false;
        this.visible = true;
        this.focus();
      }
      minimize() {
        this.minimized = true;
        this.visible = false;
        this.focused = false;
      }
      showInactive() {
        this.inactiveShows = (this.inactiveShows ?? 0) + 1;
        this.visible = true;
      }
      focus() {
        for (const window of windows) window.focused = false;
        this.focused = true;
      }
      getBounds() {
        return this.bounds;
      }
      getNormalBounds() {
        return this.normalBounds ?? this.bounds;
      }
      setBounds(bounds) {
        this.bounds = { ...bounds };
      }
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
    engineRuntimeReady = true;
    engineOrigin = 'http://127.0.0.1:4310';
    engineBound = true;
    onboardingCompleted = true;
    status.phase = 'ready';
    ${initialState === 'running' ? '' : "engine = undefined; enginePreferencesReady = false; engineRuntimeReady = false; engineOrigin = ''; engineBound = false; onboardingCompleted = false; status.phase = 'idle';"}
    ${source.slice(source.indexOf('      const appSession ='), source.indexOf('      const image = nativeImage'))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:renderer-ready'"), source.indexOf("      ipcMain.handle('nod:feedback:context'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:feedback:context'"), source.indexOf("      ipcMain.handle('nod:preferences:get'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:preferences:get'"), source.indexOf("      ipcMain.handle('nod:prepare'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:prepare'"), source.indexOf("      ipcMain.handle('nod:runtime:import'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:runtime:install-wsl'"), source.indexOf("      ipcMain.handle('nod:chat-read:get'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('nod:external'"), source.indexOf('      try {', source.indexOf("      ipcMain.handle('nod:external'")))}
    globalThis.running = {
      prepare,
      launch: async () => { ${source.slice(source.lastIndexOf('      try {\n        const saved = await settings.get();'), source.indexOf('    })', source.lastIndexOf('      try {\n        const saved = await settings.get();')))} },
      settle: () => preparing ?? Promise.resolve(),
      close: async () => { quitting = true; await lifecycle.close(); },
      profileRoot,
      profileOwner,
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
  return {
    ...context.running,
    windows,
    children,
    helpers,
    storage,
    handlers,
    notifications,
    externalURLs,
    rendererReady,
    updateMenu,
    headers: (details) => new Promise((resolve) => requestHeaders(details, resolve)),
  };
}

test('the normal engine uses the release boundary for analytics during first setup', async (t) => {
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
        initialState: 'fresh',
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
          ['engine'],
        );
        assert.ok(
          f.children.every(
            (child) => child.environment.NOD_ANALYTICS_ENVIRONMENT === scenario.expected,
          ),
        );
        if (scenario.buildMetadata.testProfile)
          assert.ok(
            f.children.every((child) => child.environment.NOD_ANALYTICS_ENABLED === 'false'),
          );
      } finally {
        await f.close();
      }
    });
  }
});

test('Windows onboarding waits for storage before unlocking credentials and exposes prerequisite recovery', async (t) => {
  const f = await runningDesktop(
    t,
    async () => assert.fail('No backend can run without storage.'),
    {
      initialState: 'fresh',
      platform: 'win32',
      allowStart: true,
      prepareRuntime: async () => {
        throw Object.assign(new Error('Synthetic WSL missing'), { code: 'NOD_WSL_REQUIRED' });
      },
    },
  );
  f.storage.store.environment = async () =>
    assert.fail('No credentials are needed before storage.');
  try {
    await f.launch();
    await f.settle();
    assert.equal(f.children.length, 0);
    assert.equal(f.status().needsWsl, true);
    assert.equal(f.windows.filter((window) => window.isVisible()).length, 1);
  } finally {
    await f.close();
  }
});

test('native Welcome is visible before storage and system-key access and accepts only nonsecret choices', async (t) => {
  const storage = deferred();
  const loaded = deferred();
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'fresh',
    allowStart: true,
    nativePageLoaded: loaded.promise,
    prepareRuntime: async ({ onStorageReady }) => {
      await storage.promise;
      const runtime = { env: {} };
      await onStorageReady(runtime);
      return runtime;
    },
  });
  const environment = f.storage.store.environment;
  let unlocked = 0;
  f.storage.store.environment = async () => {
    assert.ok(f.windows.some((window) => window.isVisible()));
    unlocked++;
    return environment();
  };
  try {
    const launched = f.launch();
    for (let i = 0; !f.windows.length && i < 50; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(unlocked, 0);
    loaded.resolve();
    await launched;
    const window = f.windows[0];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    await f.handlers.get('nod:settings:save')(event, {
      welcome: { usageData: true, continued: false },
    });
    await assert.rejects(
      f.handlers.get('nod:settings:save')(event, {
        welcome: { usageData: true, continued: false, apiKey: 'synthetic-secret' },
      }),
    );
    assert.equal(unlocked, 0);
    assert.equal(f.children.length, 0);
    storage.resolve();
    await f.settle();
    assert.equal(unlocked, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.windows[0].isDestroyed(), false);
    assert.deepEqual((await f.storage.store.get()).welcome, { usageData: true, continued: false });
  } finally {
    loaded.resolve();
    storage.resolve();
    await f.close();
  }
});

test('native startup recovery keeps current status and serializes retry, prerequisite installation, and runtime import', async (t) => {
  for (const initialResult of ['stale response', 'stale failure']) {
    await t.test(initialResult, async (t) => {
      const output = await mkdtemp(join(tmpdir(), 'nod-native-recovery-'));
      t.after(() => rm(output, { recursive: true, force: true }));
      await buildDesktopUI(output);
      const page = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
        url: 'file:///synthetic/setup.html?firstSetup=false',
        runScripts: 'outside-only',
      });
      t.after(() => page.window.close());
      const initial = deferred();
      const retry = deferred();
      let publish;
      const calls = [];
      let imports = 0;
      page.window.nodDesktop = {
        onStatus(listener) {
          publish = listener;
        },
        onPreferences() {},
        getPreferences: async () => ({ theme: 'light' }),
        getSettings: async () => ({}),
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

test('native startup preserves saved metadata failures until retry without replaying acknowledged consent', async (t) => {
  for (const failedMethod of ['getSettings', 'getPreferences']) {
    await t.test(failedMethod, async (t) => {
      const output = await mkdtemp(join(tmpdir(), 'nod-native-metadata-'));
      t.after(() => rm(output, { recursive: true, force: true }));
      await buildDesktopUI(output);
      const page = new JSDOM(await readFile(join(output, 'index.html'), 'utf8'), {
        url: 'file:///synthetic/setup.html?firstSetup=true',
        runScripts: 'outside-only',
      });
      t.after(() => page.window.close());
      const metadata = deferred();
      let publish;
      let reads = 0;
      let prepares = 0;
      let acknowledgments = 0;
      let consentRendered = false;
      const observer = new page.window.MutationObserver(() => {
        consentRendered ||= Boolean(page.window.document.querySelector('[role="switch"]'));
      });
      observer.observe(page.window.document, { childList: true, subtree: true });
      t.after(() => observer.disconnect());
      const values = {
        getSettings: { welcome: { usageData: false, continued: true, acknowledged: true } },
        getPreferences: { theme: 'light' },
      };
      page.window.nodDesktop = {
        onStatus(listener) {
          publish = listener;
        },
        onPreferences() {},
        status: async () => ({ phase: 'preparing' }),
        ...Object.fromEntries(
          Object.entries(values).map(([method, value]) => [
            method,
            () =>
              method === failedMethod && reads++ === 0 ? metadata.promise : Promise.resolve(value),
          ]),
        ),
        ready: async () => {
          acknowledgments++;
        },
        prepare: async () => {
          prepares++;
          return { phase: 'starting' };
        },
        saveSettings: () => assert.fail('Acknowledged consent must not be resubmitted.'),
      };
      page.window.eval(await readFile(join(output, 'setup.js'), 'utf8'));
      const settle = async (predicate) => {
        for (let attempt = 0; attempt < 100 && !predicate(); attempt++)
          await new Promise((accept) => setTimeout(accept, 10));
        assert.ok(predicate());
      };
      await settle(() => publish);
      publish({ phase: 'ready' });
      assert.equal(acknowledgments, 0);
      metadata.reject(new page.window.Error('Synthetic saved metadata failure'));
      await settle(() => page.window.document.querySelector('[role="alert"]'));
      publish({ phase: 'preparing' });
      await new Promise((accept) => setTimeout(accept, 20));
      assert.ok(page.window.document.querySelector('[role="alert"]'));
      await settle(() => acknowledgments > 0);
      page.window.document.querySelector('button').click();
      await settle(() => prepares === 1 && !page.window.document.querySelector('[role="alert"]'));
      assert.equal(reads, 2);
      assert.equal(consentRendered, false);
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
    assert.equal(f.status().unlockingKeys, true);
    const closing = f.close();
    unlocked.resolve(true);
    await Promise.all([launching, closing]);
    assert.equal(f.children.length, 0);
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
  } finally {
    unlocked.resolve(true);
    await f.close();
  }
});

test('native key-store failure needs an explicit retry and never completes onboarding', async (t) => {
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'fresh',
    allowStart: true,
  });
  const environment = f.storage.store.environment;
  let failing = true;
  f.storage.store.environment = () =>
    failing ? Promise.reject(new Error('Synthetic key-store denial')) : environment();
  try {
    await f.launch();
    await f.settle();
    assert.equal(f.status().phase, 'error');
    assert.equal(f.children.length, 0);
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
    const window = f.windows[0];
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    failing = false;
    await Promise.all([
      f.handlers.get('nod:prepare')(event, { retry: true }),
      f.handlers.get('nod:prepare')(event, { retry: true }),
    ]);
    assert.equal(f.children.length, 1);
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
  } finally {
    await f.close();
  }
});

test('native onboarding starts one normal backend at storage readiness and keeps its origin through full runtime readiness', async (t) => {
  const storage = deferred();
  const resources = deferred();
  const connected = deferred();
  let writes = 0;
  const f = await runningDesktop(
    t,
    async (url, options) => {
      if (new URL(url).pathname === '/api/account') {
        writes++;
        assert.equal(options.method, 'PATCH');
        assert.equal(options.headers.Origin, new URL(url).origin);
        assert.deepEqual(JSON.parse(options.body), { usageData: true });
        return Response.json({ settings: { usageData: true } });
      }
      return Response.json({ ok: true });
    },
    {
      initialState: 'fresh',
      allowStart: true,
      prepareRuntime: async ({ onStorageReady }) => {
        await storage.promise;
        const runtime = { env: { DATABASE_URL: 'postgresql://synthetic.invalid/test' } };
        await onStorageReady(runtime);
        connected.resolve();
        await resources.promise;
        return runtime;
      },
    },
  );
  try {
    await f.launch();
    const shell = f.windows[0];
    await f.handlers.get('nod:settings:save')(
      { sender: shell.webContents, senderFrame: shell.webContents.mainFrame },
      { welcome: { usageData: true, continued: true } },
    );
    const opening = f.handlers.get('nod:prepare')({
      sender: shell.webContents,
      senderFrame: shell.webContents.mainFrame,
    });
    await new Promise(setImmediate);
    assert.equal(f.status().phase, 'preparing');
    assert.equal(f.status().error, undefined);
    assert.equal(f.children.length, 0);
    assert.equal(writes, 0);
    storage.resolve();
    await connected.promise;
    assert.equal(f.children.length, 1);
    const engine = f.children[0];
    assert.equal(engine.environment.NOD_DESKTOP_RUNTIME_PENDING, 'true');
    assert.equal(
      engine.sent.some((message) => message.type === 'nod-runtime-ready'),
      false,
    );
    const window = f.windows.at(-1);
    const origin = new URL(window.url).origin;
    assert.equal(new URL(window.url).searchParams.get('welcome'), 'complete');
    assert.equal((await f.storage.store.get()).welcome.acknowledged, true);
    assert.equal(writes, 1);
    const request = (url, extra = {}) => ({
      url,
      webContentsId: window.webContents.id,
      frame: window.webContents.mainFrame,
      resourceType: 'xhr',
      requestHeaders: { 'X-nod-Desktop-Token': 'forged' },
      ...extra,
    });
    assert.equal(
      (await f.headers(request(`${origin}/api/session`))).requestHeaders['x-nod-desktop-token'],
      engine.environment.NOD_DESKTOP_AUTH_TOKEN,
    );
    for (const details of [
      request(`${origin}/api/session`, { webContentsId: -1 }),
      request(`${origin}/api/session`, { frame: { routingId: -1, processId: -1 } }),
      request('https://external.example.test/api/session'),
    ])
      assert.ok(
        Object.keys((await f.headers(details)).requestHeaders).every(
          (name) => name.toLowerCase() !== 'x-nod-desktop-token',
        ),
      );
    resources.resolve();
    await opening;
    await f.settle();
    assert.equal(f.children.length, 1);
    assert.equal(new URL(window.url).origin, origin);
    assert.equal(engine.sent.filter((message) => message.type === 'nod-runtime-ready').length, 1);
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
    assert.equal(f.status().phase, 'ready');
  } finally {
    storage.resolve();
    resources.resolve();
    await f.close();
  }
});

test('runtime handoff and readiness respect closed, minimized and background windows', async (t) => {
  for (const scenario of [
    'closed',
    'minimized',
    'background',
    'welcome-closed',
    'welcome-minimized',
    'upgrade-closed',
  ]) {
    await t.test(scenario, async (t) => {
      const storage = deferred();
      const connected = deferred();
      const resources = deferred();
      const f = await runningDesktop(
        t,
        async (url) =>
          Response.json(
            url.endsWith('/api/account') ? { settings: { usageData: true } } : { ok: true },
          ),
        {
          initialState: scenario === 'upgrade-closed' ? 'upgrade' : 'fresh',
          allowStart: true,
          prepareRuntime: async ({ onStorageReady }) => {
            await storage.promise;
            const runtime = { env: {} };
            await onStorageReady(runtime);
            connected.resolve();
            await resources.promise;
            return runtime;
          },
        },
      );
      if (scenario !== 'upgrade-closed')
        await f.storage.store.save({ welcome: { usageData: true, continued: true } });
      try {
        await f.launch();
        const shell = f.windows[0];
        if (scenario.endsWith('-closed')) shell.destroy();
        if (scenario === 'welcome-minimized') {
          shell.normalBounds = { x: 80, y: 120, width: 940, height: 720 };
          shell.bounds = { x: -32000, y: -32000, width: 160, height: 28 };
          shell.visible = false;
          shell.focused = false;
        }
        storage.resolve();
        await connected.promise;
        const window = f.windows.find((window) => window.url);
        if (scenario.endsWith('-closed')) assert.equal(window, undefined);
        else {
          assert.ok(window);
          if (scenario === 'welcome-minimized') assert.deepEqual(window.bounds, shell.normalBounds);
          window.focused = false;
          if (scenario === 'closed') window.destroy();
          if (scenario.endsWith('minimized')) window.visible = false;
        }
        const count = f.windows.length;
        const inactiveShows = window?.inactiveShows ?? 0;
        resources.resolve();
        await f.settle();
        assert.equal(f.status().phase, 'ready');
        assert.equal(f.windows.length, count);
        assert.equal(window?.inactiveShows ?? 0, inactiveShows);
        if (window) {
          assert.equal(Boolean(window.isFocused()), false);
          assert.equal(window.isVisible(), scenario === 'background');
        }
      } finally {
        storage.resolve();
        resources.resolve();
        await f.close();
      }
    });
  }
});

test('native windows wait for owned renderer readiness before replacing startup', async (t) => {
  for (const scenario of [
    'foreground',
    'background',
    'minimized',
    'closed',
    'resized',
    'late-load-failure',
    'early-load-failure',
    'load-failure',
    'upgrade-load-failure',
    'upgrade-replay-load-failure',
    'reopen-load-failure',
    'closed-activate-load-failure',
  ]) {
    await t.test(scenario, async (t) => {
      const storage = deferred();
      const connected = deferred();
      const loaded = deferred();
      const runtimeFinished = deferred();
      let retried = false;
      const f = await runningDesktop(
        t,
        async (url) =>
          Response.json(
            url.endsWith('/api/account') ? { settings: { usageData: false } } : { ok: true },
          ),
        {
          initialState: scenario.startsWith('upgrade-') ? 'upgrade' : 'fresh',
          argv: scenario.includes('replay') ? ['--onboarding'] : [],
          allowStart: true,
          readyRenderers: false,
          enginePageLoaded: () => (retried ? Promise.resolve() : loaded.promise),
          prepareRuntime: async ({ onStorageReady }) => {
            await storage.promise;
            const runtime = { env: {} };
            await onStorageReady(runtime);
            connected.resolve();
            if (scenario === 'early-load-failure') await runtimeFinished.promise;
            return runtime;
          },
        },
      );
      if (!scenario.startsWith('upgrade-'))
        await f.storage.store.save({ welcome: { usageData: false, continued: true } });
      try {
        const launched = f.launch();
        for (let i = 0; !f.windows.length && i < 50; i++) await new Promise(setImmediate);
        const setup = f.windows[0];
        assert.ok(setup);
        assert.equal(setup.isVisible(), false);
        await f.rendererReady(setup);
        await launched;
        assert.equal(setup.isVisible(), true);
        storage.resolve();
        await connected.promise;
        if (scenario !== 'early-load-failure') await f.settle();
        const engine = f.windows.find((window) => window.url);
        assert.ok(engine);
        assert.equal(engine.isVisible(), false);
        assert.equal(setup.isDestroyed(), false);
        if (scenario !== 'early-load-failure') await f.settle();
        assert.equal(engine.isVisible(), false);
        const frame = engine.webContents.mainFrame;
        const ready = f.handlers.get('nod:renderer-ready');
        for (const event of [
          { sender: { mainFrame: frame }, senderFrame: frame },
          { sender: engine.webContents, senderFrame: { ...frame } },
        ])
          await assert.rejects(
            Promise.resolve().then(() => ready(event)),
            /unavailable/,
          );
        assert.equal(engine.isVisible(), false);
        if (scenario === 'late-load-failure') {
          await f.rendererReady(engine);
          assert.equal(engine.isVisible(), true);
          loaded.reject(new Error('Synthetic initial navigation abort'));
          await new Promise(setImmediate);
          assert.equal(engine.isDestroyed(), false);
          assert.equal(f.status().phase, 'ready');
          assert.equal(f.status().windowError, undefined);
          return;
        }
        if (scenario.endsWith('load-failure')) {
          if (scenario === 'closed-activate-load-failure') {
            setup.destroy();
            f.showEngine();
          }
          loaded.reject(new Error('Synthetic page failure'));
          await new Promise(setImmediate);
          assert.equal(engine.isDestroyed(), true);
          const recovery = f.windows.find((window) => window.path && !window.isDestroyed());
          assert.ok(recovery);
          if (recovery !== setup) await f.rendererReady(recovery);
          assert.equal(recovery.isVisible(), true);
          assert.equal(f.status().phase, scenario === 'early-load-failure' ? 'preparing' : 'ready');
          assert.ok(f.status().windowError);
          const backend = f.children[0];
          retried = true;
          let retry;
          if (scenario === 'reopen-load-failure') f.showEngine();
          else
            retry = f.handlers.get('nod:prepare')(
              { sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame },
              { retry: true },
            );
          if (scenario === 'early-load-failure') await new Promise(setImmediate);
          else await retry;
          const replacement = f.windows.find((window) => window.url && !window.isDestroyed());
          assert.ok(replacement);
          assert.notEqual(replacement, engine);
          assert.equal(replacement.url, engine.url);
          assert.equal(replacement.isVisible(), false);
          assert.equal(recovery.isDestroyed(), false);
          await new Promise(setImmediate);
          await f.rendererReady(replacement);
          assert.equal(replacement.isVisible(), true);
          assert.equal(recovery.isDestroyed(), true);
          assert.equal(f.status().phase, scenario === 'early-load-failure' ? 'preparing' : 'ready');
          assert.equal(f.status().windowError, undefined);
          assert.equal(f.children.length, 1);
          assert.equal(f.children[0], backend);
          runtimeFinished.resolve();
          await retry;
          return;
        }
        loaded.resolve();
        await new Promise(setImmediate);
        assert.equal(engine.isVisible(), false);
        if (!['foreground', 'resized'].includes(scenario)) setup.focused = false;
        if (scenario === 'resized') setup.bounds = { x: 150, y: 75, width: 1300, height: 900 };
        if (scenario === 'minimized') {
          setup.minimized = true;
          setup.visible = false;
        }
        if (scenario === 'closed') setup.destroy();
        await f.rendererReady(engine);
        assert.equal(
          engine.isVisible(),
          ['foreground', 'background', 'resized'].includes(scenario),
        );
        assert.equal(Boolean(engine.isFocused()), ['foreground', 'resized'].includes(scenario));
        if (scenario === 'resized') assert.deepEqual(engine.getBounds(), setup.getNormalBounds());
        assert.equal(setup.isDestroyed(), true);
        if (scenario === 'minimized') {
          assert.equal(engine.isMinimized(), true);
          assert.equal(Boolean(engine.isFocused()), false);
          f.showEngine();
          assert.equal(f.windows.length, 2);
          assert.equal(engine.isVisible(), true);
          assert.equal(engine.isMinimized(), false);
          assert.equal(engine.isFocused(), true);
        }
        if (scenario === 'foreground') {
          const child = new engine.constructor({ show: false });
          engine.webContents.emit('did-create-window', child);
          await child.loadURL(`${new URL(engine.url).origin}/payments/synthetic-request`);
          await f.rendererReady(child);
          assert.equal(child.isVisible(), false);
          child.destroy();
        }
        engine.focused = false;
        engine.visible = false;
        await f.rendererReady(engine);
        assert.equal(engine.isVisible(), false);
      } finally {
        storage.resolve();
        loaded.resolve();
        runtimeFinished.resolve();
        await f.settle();
        await f.close();
      }
    });
  }
});

test('a missing native setup renderer offers explicit recovery without hidden key access or automatic retry', async (t) => {
  for (const failure of ['timeout', 'load-failure']) {
    await t.test(failure, async (t) => {
      const prompts = [];
      const loaded = deferred();
      let reopened = false;
      let retryAllowed = false;
      let keyReads = 0;
      let keyAccessFailed = true;
      let unlocking;
      const wait = setTimeout;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const f = await runningDesktop(
        t,
        async (url) => {
          assert.ok(retryAllowed);
          return Response.json(
            url.endsWith('/api/account') ? { settings: { usageData: false } } : { ok: true },
          );
        },
        {
          initialState: failure === 'timeout' ? 'upgrade' : 'fresh',
          allowStart: true,
          readyRenderers: false,
          nativePageLoaded: () => (reopened ? Promise.resolve() : loaded.promise),
          prepareRuntime: async ({ onStorageReady }) => {
            assert.ok(retryAllowed, 'Runtime startup must wait for explicit retry.');
            const runtime = { env: {} };
            await onStorageReady(runtime);
            return runtime;
          },
          prompt: (value) => {
            prompts.push(value);
            return { response: 0 };
          },
        },
      );
      if (failure === 'load-failure')
        await f.storage.store.save({ welcome: { usageData: false, continued: true } });
      const environment = f.storage.store.environment;
      f.storage.store.environment = () => {
        assert.ok(retryAllowed, 'No hidden Keychain request is allowed.');
        assert.ok(f.windows.some((window) => window.path && window.isVisible()));
        keyReads++;
        unlocking = { active: f.status().unlockingKeys, windowError: f.status().windowError };
        if (keyAccessFailed) throw new Error('Synthetic key access unavailable');
        return environment();
      };
      try {
        const launched = f.launch();
        for (let attempt = 0; !f.windows.length && attempt < 100; attempt++)
          await new Promise(setImmediate);
        const window = f.windows[0];
        assert.ok(window);
        assert.equal(window.isVisible(), false);
        if (failure === 'timeout') {
          loaded.resolve();
          t.mock.timers.tick(30_000);
        } else {
          loaded.reject(new Error('Synthetic setup page failure'));
          await new Promise(setImmediate);
          assert.equal(prompts.length, 1);
        }
        await launched;
        assert.equal(prompts.length, 1);
        assert.equal(window.isDestroyed(), true);
        assert.equal(f.children.length, 0);
        t.mock.timers.tick(30_000);
        assert.equal(prompts.length, 1);
        assert.equal(f.windows.length, 1);
        reopened = true;
        f.showEngine();
        const recovery = f.windows.at(-1);
        assert.notEqual(recovery, window);
        await f.rendererReady(recovery);
        assert.equal(recovery.isVisible(), true);
        assert.ok(f.status().windowError);
        assert.equal(f.children.length, 0);
        assert.equal(keyReads, 0);
        retryAllowed = true;
        const retry = async () => {
          let retried = false;
          const result = f.handlers
            .get('nod:prepare')(
              { sender: recovery.webContents, senderFrame: recovery.webContents.mainFrame },
              { retry: true },
            )
            .then(() => {
              retried = true;
            });
          for (let attempt = 0; !retried && attempt < 100; attempt++) {
            await new Promise((resolve) => wait(resolve, 5));
            t.mock.timers.tick(100);
          }
          assert.equal(retried, true);
          await result;
        };
        await retry();
        assert.equal(f.status().phase, 'error');
        assert.match(f.status().error, /Synthetic key access unavailable/);
        assert.equal(f.status().windowError, undefined);
        assert.deepEqual(unlocking, { active: true, windowError: undefined });
        assert.equal(f.children.length, 0);
        assert.equal(recovery.isVisible(), true);
        keyAccessFailed = false;
        await retry();
        const engine = f.windows.find((window) => window.url);
        assert.ok(engine);
        assert.equal(engine.isVisible(), false);
        await f.rendererReady(engine);
        assert.equal(engine.isVisible(), true);
        assert.equal(recovery.isDestroyed(), true);
        assert.equal(f.status().phase, 'ready');
        assert.equal(f.status().windowError, undefined);
        assert.equal(f.children.length, 1);
        assert.ok(keyReads > 0);
      } finally {
        loaded.resolve();
        await f.close();
      }
    });
  }
});

test('completed upgrades retain settings and only explicit replay repeats onboarding', async (t) => {
  for (const initialState of ['upgrade', 'replay']) {
    await t.test(initialState, async (t) => {
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState,
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
          ['engine'],
        );
        assert.equal(f.children.at(-1).environment.NOD_DESKTOP_RUNTIME_PENDING, 'true');
        assert.equal(f.children.at(-1).environment.NOD_DESKTOP_LEGACY_INTEGRATION, undefined);
        if (initialState === 'replay')
          assert.ok(f.windows.some((window) => window.url?.endsWith('/onboarding?replay=1')));
        else
          assert.ok(
            f.windows.every(
              (window) => !window.url || new URL(window.url).pathname !== '/onboarding',
            ),
          );
        assert.deepEqual(await f.storage.store.environment(), before);
        assert.deepEqual(await f.storage.store.get(), preferences);
      } finally {
        await f.close();
      }
    });
  }
});

test('failed Welcome transfer preserves the saved answer and retries without a second choice or engine', async (t) => {
  let failing = true;
  let writes = 0;
  const f = await runningDesktop(
    t,
    async (url) => {
      if (url.endsWith('/api/account')) {
        writes++;
        if (failing) throw new Error('Synthetic disconnected transfer');
        return Response.json({ settings: { usageData: true } });
      }
      return Response.json({ ok: true });
    },
    { initialState: 'fresh', allowStart: true },
  );
  try {
    await f.launch();
    await f.settle();
    const shell = f.windows[0];
    const event = { sender: shell.webContents, senderFrame: shell.webContents.mainFrame };
    const choice = { usageData: true, continued: true };
    assert.deepEqual(
      (await f.handlers.get('nod:settings:save')(event, { welcome: choice })).welcome,
      choice,
    );
    assert.equal(writes, 0);
    await assert.rejects(f.handlers.get('nod:prepare')(event));
    assert.deepEqual((await f.storage.store.get()).welcome, choice);
    assert.equal(shell.isDestroyed(), false);
    failing = false;
    shell.focused = false;
    await f.handlers.get('nod:prepare')(event, { retry: true });
    const background = f.windows.find((window) => window.url);
    assert.ok(background);
    assert.equal(background.isVisible(), true);
    assert.equal(Boolean(background.isFocused()), false);
    assert.equal(shell.isDestroyed(), true);
    assert.equal(writes, 2);
    assert.equal(f.children.length, 1);
    assert.equal((await f.storage.store.get()).welcome.acknowledged, true);
    assert.ok(f.windows.some((window) => window.url?.endsWith('/onboarding?welcome=complete')));
  } finally {
    await f.close();
  }
});

test('a failed saved Welcome transfer leaves storage and the normal backend ready for explicit retry', async (t) => {
  let failing = true;
  let writes = 0;
  let attempts = 0;
  let stopped = 0;
  let handedOff = false;
  const f = await runningDesktop(
    t,
    async (url) => {
      if (url.endsWith('/api/account')) {
        writes++;
        if (failing) throw new Error('Synthetic consent save unavailable');
        return Response.json({ settings: { usageData: true } });
      }
      return Response.json({ ok: true });
    },
    {
      initialState: 'fresh',
      allowStart: true,
      prepareRuntime: async ({ onStorageReady }) => {
        attempts++;
        const runtime = {
          env: {},
          close: async () => {
            stopped++;
          },
        };
        await onStorageReady(runtime);
        handedOff = true;
        return runtime;
      },
    },
  );
  await f.storage.store.save({ welcome: { usageData: true, continued: true } });
  try {
    await f.launch();
    await f.settle();
    assert.equal(handedOff, true);
    assert.equal(attempts, 1);
    assert.equal(writes, 1);
    assert.equal(stopped, 0);
    assert.equal(f.children.length, 1);
    assert.equal(f.status().phase, 'error');
    assert.equal(f.windows[0].isDestroyed(), false);
    failing = false;
    const shell = f.windows[0];
    await f.handlers.get('nod:prepare')(
      { sender: shell.webContents, senderFrame: shell.webContents.mainFrame },
      { retry: true },
    );
    assert.equal(writes, 2);
    assert.equal(attempts, 1);
    assert.equal(f.children.length, 1);
    assert.equal(f.status().phase, 'ready');
    assert.equal((await f.storage.store.get()).welcome.acknowledged, true);
  } finally {
    await f.close();
  }
  assert.equal(stopped, 1);
});

test('one explicit retry after an engine exit also retries the saved Welcome choice', async (t) => {
  let failing = true;
  let writes = 0;
  const f = await runningDesktop(
    t,
    async (url) => {
      if (url.endsWith('/api/account')) {
        writes++;
        if (failing) throw new Error('Synthetic consent save unavailable');
        return Response.json({ settings: { usageData: true } });
      }
      return Response.json({ ok: true });
    },
    { initialState: 'fresh', allowStart: true },
  );
  await f.storage.store.save({ welcome: { usageData: true, continued: true } });
  try {
    await f.launch();
    await f.settle();
    assert.equal(writes, 1);
    assert.equal(f.status().phase, 'error');
    f.children[0].emit('exit', 1);
    await new Promise(setImmediate);
    assert.equal(writes, 1);
    assert.equal(f.children.length, 1);
    failing = false;
    const shell = f.windows.find((window) => !window.isDestroyed() && window.path);
    await f.handlers.get('nod:prepare')(
      { sender: shell.webContents, senderFrame: shell.webContents.mainFrame },
      { retry: true },
    );
    assert.equal(writes, 2);
    assert.equal(f.children.length, 2);
    assert.equal(f.status().phase, 'ready');
    assert.equal((await f.storage.store.get()).welcome.acknowledged, true);
    assert.ok(f.windows.some((window) => window.url));
  } finally {
    await f.close();
  }
});

test('session reconciliation retries after runtime startup without rebuilding the computer or engine', async (t) => {
  for (const failure of ['session', 'settings']) {
    await t.test(failure, async (t) => {
      let failing = true;
      let reads = 0;
      let attempts = 0;
      let stopped = 0;
      const f = await runningDesktop(
        t,
        async (url) => {
          if (url.endsWith('/api/session')) {
            reads++;
            if (reads > 1 && failing && failure === 'session')
              throw new Error('Synthetic session unavailable');
            return Response.json({ settings: { onboardingCompleted: reads > 1 } });
          }
          return Response.json({ ok: true });
        },
        {
          initialState: 'fresh',
          allowStart: true,
          prepareRuntime: async ({ onStorageReady }) => {
            attempts++;
            const runtime = { env: {}, close: async () => stopped++ };
            await onStorageReady(runtime);
            return runtime;
          },
        },
      );
      await f.storage.store.save({ notifications: true, launchAtLogin: true });
      const save = f.storage.store.save;
      f.storage.store.save = async (value) => {
        if (value.onboardingCompleted && failing && failure === 'settings')
          throw new Error('Synthetic settings unavailable');
        return save(value);
      };
      try {
        await f.launch();
        await f.settle();
        assert.equal(f.status().phase, 'error');
        assert.equal(reads, 2);
        assert.equal(attempts, 1);
        assert.equal(stopped, 0);
        assert.equal(f.children.length, 1);
        failing = false;
        const shell = f.windows[0];
        const result = await f.handlers.get('nod:prepare')(
          { sender: shell.webContents, senderFrame: shell.webContents.mainFrame },
          { retry: true },
        );
        assert.equal(result.phase, 'ready');
        assert.equal(reads, 3);
        assert.equal(attempts, 1);
        assert.equal(stopped, 0);
        assert.equal(f.children.length, 1);
        assert.equal((await f.storage.store.get()).onboardingCompleted, true);
        assert.equal(
          f.children[0].sent.filter((message) => message.type === 'nod-runtime-ready').length,
          1,
        );
      } finally {
        await f.close();
      }
      assert.equal(stopped, 1);
    });
  }
});

test('partial onboarding restart keeps acknowledged consent and normal app progress until durable completion', async (t) => {
  let usageData = true;
  let completed = false;
  let writes = 0;
  const request = async (url, options) => {
    if (url.endsWith('/api/account')) {
      writes++;
      usageData = JSON.parse(options.body).usageData;
      return Response.json({ settings: { usageData } });
    }
    if (url.endsWith('/api/session'))
      return Response.json({ settings: { onboardingCompleted: completed, usageData } });
    return Response.json({ ok: true });
  };
  const first = await runningDesktop(t, request, { initialState: 'fresh', allowStart: true });
  try {
    await first.launch();
    await first.settle();
    const shell = first.windows[0];
    const event = { sender: shell.webContents, senderFrame: shell.webContents.mainFrame };
    await first.handlers.get('nod:settings:save')(event, {
      welcome: { usageData: true, continued: true },
    });
    await first.handlers.get('nod:prepare')(event);
    assert.equal(writes, 1);
  } finally {
    await first.close();
  }
  usageData = false;
  const next = await runningDesktop(t, request, {
    initialState: 'fresh',
    allowStart: true,
    storedProfile: first.storage,
  });
  try {
    await next.launch();
    await next.settle();
    assert.equal(writes, 1);
    assert.equal(usageData, false);
    const window = next.windows.find((window) => window.url);
    assert.ok(window);
    assert.equal(new URL(window.url).pathname, '/onboarding');
    assert.equal(new URL(window.url).searchParams.get('welcome'), 'complete');
    assert.equal((await next.storage.store.get()).welcome.acknowledged, true);
    await next.storage.store.save({ notifications: true, launchAtLogin: true });
    completed = true;
    await next.handlers.get('nod:settings:save')(
      { sender: window.webContents, senderFrame: window.webContents.mainFrame },
      { onboardingCompleted: true },
    );
    assert.equal((await next.storage.store.get()).welcome, undefined);
    assert.equal(writes, 1);
  } finally {
    await next.close();
  }
});

test('completed backend onboarding resumes required native preferences without changing consent', async (t) => {
  const f = await runningDesktop(
    t,
    async (url, options) => {
      assert.notEqual(options?.method, 'PATCH');
      return Response.json(
        url.endsWith('/api/session')
          ? { settings: { onboardingCompleted: true, usageData: false } }
          : { ok: true },
      );
    },
    { initialState: 'fresh', allowStart: true },
  );
  await f.storage.store.save({ welcome: { usageData: true, continued: true } });
  try {
    await f.launch();
    await f.settle();
    assert.equal((await f.storage.store.get()).onboardingCompleted, false);
    assert.equal((await f.storage.store.get()).notifications, false);
    const recovery = f.windows.find(
      (window) => window.url && new URL(window.url).pathname === '/onboarding',
    );
    assert.ok(recovery);
    assert.equal(new URL(recovery.url).searchParams.get('preferences'), 'required');
    assert.ok(f.windows.every((window) => !window.url?.includes('welcome=complete')));
  } finally {
    await f.close();
  }
});

test('workspace failure leaves the pending backend intact and an explicit retry releases it once', async (t) => {
  let attempts = 0;
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    initialState: 'upgrade',
    allowStart: true,
    prepareRuntime: async ({ onStorageReady }) => {
      const runtime = { env: {} };
      await onStorageReady(runtime);
      if (++attempts === 1) throw new Error('Synthetic browser startup failure');
      return runtime;
    },
  });
  try {
    await f.launch();
    await f.settle();
    assert.equal(f.status().phase, 'error');
    assert.equal(f.children.length, 1);
    assert.equal(f.children[0].sent.length, 0);
    assert.equal(f.windows[0].isDestroyed(), false);
    assert.equal(
      f.windows.some((window) => window.url),
      false,
    );
    f.showEngine();
    assert.equal(
      f.windows.some((window) => window.url),
      false,
    );
    await f.prepare();
    assert.equal(attempts, 1);
    await f.prepare({ retry: true });
    assert.equal(attempts, 2);
    assert.equal(f.children.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.children[0].sent)), [
      { type: 'nod-runtime-ready' },
    ]);
    assert.equal(f.status().phase, 'ready');
    assert.equal(f.windows[0].isDestroyed(), true);
    assert.ok(f.windows.some((window) => window.url));
  } finally {
    await f.close();
  }
});

test('native upgrades preserve the existing settings and vault through successful or failed startup', async (t) => {
  for (const failed of [false, true]) {
    await t.test(failed ? 'failed runtime' : 'ready runtime', async (t) => {
      const storage = await fixture(t);
      await storage.store.save({
        onboardingCompleted: true,
        notifications: true,
        launchAtLogin: true,
        theme: 'dark',
      });
      const environment = await storage.store.environment();
      const saved = JSON.parse(await readFile(storage.path, 'utf8'));
      saved.secrets.composioApiKey = 'retired-ciphertext-must-not-be-unlocked';
      saved.keyMetadata = {
        composioApiKey: { suffix: 'test', source: 'manual', updatedAt: '2026-01-01T00:00:00.000Z' },
      };
      const previous = JSON.stringify(saved, null, 2);
      await writeFile(storage.path, previous);
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState: 'upgrade',
        allowStart: true,
        storedProfile: storage,
        prepareRuntime: async ({ onStorageReady }) => {
          const runtime = { env: {} };
          await onStorageReady(runtime);
          if (failed) throw new Error('Synthetic browser startup failure');
          return runtime;
        },
      });
      try {
        await f.launch();
        await f.settle();
        assert.equal(f.status().phase, failed ? 'error' : 'ready');
        assert.equal(f.children[0].environment.NOD_VAULT_KEY, environment.NOD_VAULT_KEY);
        assert.deepEqual(
          JSON.parse(JSON.stringify(f.children[0].sent)),
          failed ? [] : [{ type: 'nod-runtime-ready' }],
        );
        assert.equal((await f.storage.store.get()).onboardingCompleted, true);
        assert.equal((await f.storage.store.get()).theme, 'dark');
        assert.equal(await readFile(storage.path, 'utf8'), previous);
      } finally {
        await f.close();
      }
    });
  }
});

test('native quit aborts storage startup without creating a late engine', async (t) => {
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
  for (let i = 0; !signal && i < 100; i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(signal);
  const closing = f.close();
  await new Promise(setImmediate);
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
    [],
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
            NOD_COMPOSIO_PROXY_URL: scenario.url,
            COMPOSIO_API_KEY: 'synthetic-inherited-project-key',
            ...(scenario.isolated ? { NOD_DESKTOP_USER_DATA: join(path, 'isolated') } : {}),
          }),
        },
      );
      f.crash();
      assert.equal((await f.prepare()).phase, 'ready');
      const environment = f.children[0].environment;
      const allowed = scenario.isolated && !scenario.packaged;
      assert.equal(environment.COMPOSIO_API_KEY, undefined);
      assert.equal(environment.NOD_COMPOSIO_PROXY_URL, allowed ? scenario.url : undefined);
      assert.equal(Boolean(environment.NOD_DESKTOP_USER_DATA), Boolean(allowed));
      assert.equal(
        environment.NOD_DATA_ROOT,
        allowed
          ? join(dirname(f.storage.path), 'isolated', 'profiles', 'local')
          : join(dirname(f.storage.path), 'nod', 'profiles', 'local'),
      );
      const expected = allowed ? scenario.url : 'https://composio.n8n.cloud';
      const script = `
        import assert from 'node:assert/strict';
        import { createHash } from 'node:crypto';
        let requests = 0;
        globalThis.fetch = async (resource, options) => {
          const request = new Request(resource, options);
          const url = new URL(request.url);
          assert.equal(url.origin, ${JSON.stringify(expected)});
          assert.equal(request.headers.has('x-api-key'), false);
          assert.ok(request.headers.get('x-nod-signature'));
          requests++;
          if (url.pathname === '/v2/access/enroll') {
            assert.equal(request.method, 'POST');
            const userId = 'nod_' + createHash('sha256').update(Buffer.from(request.headers.get('x-nod-public-key'), 'base64url')).digest('hex');
            return Response.json({ state: 'enabled', userId });
          }
          assert.equal(url.pathname, '/v2/api/v3.1/toolkits');
          assert.equal(request.method, 'GET');
          return Response.json({ items: [] });
        };
        const { createDefaultAdapters } = await import('./src/server/composition.ts');
        const { pool } = await import('./src/server/db.ts');
        let identity;
        pool.query = async (sql, values) => {
          if (sql.startsWith('SELECT public_key FROM integration_identities'))
            return { rows: identity ? [{ public_key: identity }] : [], rowCount: identity ? 1 : 0 };
          if (sql.startsWith('INSERT INTO integration_identities')) identity = values[1];
          return { rows: [], rowCount: 1 };
        };
        pool.connect = async () => ({ query: (...args) => pool.query(...args), release() {} });
        if (${Boolean(scenario.invalid)}) {
          assert.throws(() => createDefaultAdapters(), /proxy address/);
          assert.equal(requests, 0);
        } else {
          const adapters = createDefaultAdapters();
          adapters.keyStore.getKey = async () => Buffer.alloc(32, 7);
          await adapters.integrations.listServices();
          assert.equal(requests, 2);
          await adapters.integrationBrowser.close();
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
              NOD_ANALYTICS_ENABLED: 'false',
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
        NOD_DESKTOP_USER_DATA: 'relative-profile',
        NOD_COMPOSIO_PROXY_URL: 'http://127.0.0.1:8787',
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

test('Telegram pairing opens the native app with the exact nonce and falls back to HTTPS', async (t) => {
  let rejectNative = false;
  const f = await runningDesktop(t, () => assert.fail('No engine request is needed.'), {
    openExternal: async (url) => {
      if (rejectNative && url.startsWith('tg:')) throw new Error('No Telegram app.');
    },
  });
  f.showEngine();
  const sender = f.windows.at(-1).webContents;
  const event = { sender, senderFrame: sender.mainFrame };
  const invoke = (url) => f.handlers.get('nod:external')(event, url);
  const nonce = 'Abcd1234_-'.repeat(3) + 'AB';
  const url = `https://t.me/fixture_bot?start=${nonce}`;
  await invoke(url);
  const native = `tg://resolve?domain=fixture_bot&start=${nonce}`;
  assert.deepEqual(f.externalURLs, [native]);
  rejectNative = true;
  await invoke(url);
  assert.deepEqual(f.externalURLs.slice(-2), [native, url]);
  for (const value of [
    url + '&extra=yes',
    url + '&start=' + nonce,
    url + '#fragment',
    url.replace('t.me', 'example.test'),
    url.replace(nonce, 'short'),
    url.replace('https:', 'http:'),
  ]) {
    await invoke(value);
    assert.equal(f.externalURLs.at(-1), value);
  }
  await assert.rejects(invoke(native), /unavailable/);
});

test('native settings reject foreign windows, subframes, AI credentials, and web onboarding writes', async (t) => {
  const f = await runningDesktop(
    t,
    () => assert.fail('Settings must not make an engine request.'),
    { platform: 'win32' },
  );
  const { NOD_VAULT_KEY: vaultKey } = await f.storage.store.environment();
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
  const get = (target = event) => invoke('nod:settings:get', target);
  const save = (value, target = event) => invoke('nod:settings:save', target, value);
  assert.equal(f.handlers.has('nod:settings:reveal'), false);
  for (const rejected of [
    { sender: { mainFrame: frame }, senderFrame: frame },
    { sender: window.webContents, senderFrame: { url: frame.url } },
  ]) {
    await assert.rejects(get(rejected));
    await assert.rejects(save({ composioApiKey: 'synthetic-injected-key' }, rejected));
  }
  for (const url of [
    'https://example.test/',
    'https://example.test/settings',
    'http://127.0.0.1:4310/api/files/synthetic',
    'http://127.0.0.1:4310/settings/foreign',
  ]) {
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
  await invoke('nod:preferences:theme', event, 'light');
  assert.equal((await f.storage.store.get()).theme, 'light');
  await invoke('nod:external', event, 'https://example.test/');
  assert.deepEqual(f.externalURLs, ['https://example.test/']);
  window.loading = false;
  await invoke('nod:settings:open', event, 'models');
  assert.ok(
    window.sent.some(([channel, value]) => channel === 'nod:settings:focus' && value === 'models'),
  );
  for (const path of ['/settings', '/settings/models', '/settings/memory']) {
    frame.url = `http://127.0.0.1:4310${path}`;
    assert.equal((await get()).theme, 'light');
    assert.equal((await invoke('nod:preferences:get', event)).theme, 'light');
    await save({ theme: 'dark' });
    assert.equal((await invoke('nod:preferences:get', event)).theme, 'dark');
    await invoke('nod:preferences:theme', event, 'light');
    await assert.rejects(get({ sender: window.webContents, senderFrame: { url: frame.url } }));
  }
  window.destroy();
  await assert.rejects(save({ theme: 'light' }));
  f.setReady(false);
  f.showSettings();
  const setup = f.windows.at(-1).webContents;
  const setupEvent = { sender: setup, senderFrame: setup.mainFrame };
  for (const [channel, value] of [
    ['nod:preferences:theme', 'dark'],
    ['nod:external', 'https://example.test/'],
    ['nod:settings:open', 'models'],
  ])
    await assert.rejects(invoke(channel, setupEvent, value), /This action is unavailable/);
  f.status().runtime = { phase: 'error', needsWsl: true };
  for (const rejected of [
    { sender: window.webContents, senderFrame: frame },
    { sender: { mainFrame: setup.mainFrame }, senderFrame: setup.mainFrame },
    { sender: setup, senderFrame: { url: setup.mainFrame.url } },
  ])
    await assert.rejects(invoke('nod:runtime:install-wsl', rejected));
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

test('the engine token waits for the engine nod started to report its port', async (t) => {
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

test('the engine reaches 1Password only through a separate helper that may load its library', async (t) => {
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
    allowStart: true,
    environment: { HOME: '/Users/synthetic', OPENAI_API_KEY: 'sk-synthetic-provider-key' },
  });
  f.crash();
  assert.equal((await f.prepare()).phase, 'ready');
  const [engine] = f.children;
  assert.equal(f.helpers.length, 0);
  engine.emit('message', { type: 'nod-1password-open' });
  assert.equal(f.helpers.length, 1);
  const [helper] = f.helpers;
  assert.match(helper.file, /[\\/]desktop[\\/]main[\\/]onepassword\.mjs$/);
  assert.equal(helper.options.allowLoadingUnsignedLibraries, true);
  assert.equal(helper.options.serviceName, 'nod 1Password');
  assert.deepEqual(JSON.parse(JSON.stringify(helper.options.env)), { HOME: '/Users/synthetic' });
  assert.deepEqual(JSON.parse(JSON.stringify(helper.args)), ['0.0.0-test']);
  assert.deepEqual(JSON.parse(JSON.stringify(helper.sent)), [
    { message: { type: 'nod-1password-port' }, transfer: [{ end: 'helper' }] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(engine.transfers)), [
    { message: { type: 'nod-1password-port' }, transfer: [{ end: 'engine' }] },
  ]);
  engine.emit('exit', 1);
  assert.equal(helper.killed, true);
});

test('a stale engine cannot open a 1Password helper', async (t) => {
  const f = await runningDesktop(t, async () => Response.json({ ok: true }), { allowStart: true });
  f.crash();
  assert.equal((await f.prepare()).phase, 'ready');
  const [stale] = f.children;
  stale.emit('exit', 1);
  stale.emit('message', { type: 'nod-1password-open' });
  assert.equal(f.helpers.length, 0);
});

async function fixture(t, platform = 'win32') {
  const directory = await mkdtemp(join(tmpdir(), 'nod-desktop-settings-'));
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
  'Windows DPAPI keeps the Vault and completed setup across real Electron restarts behind private ACLs that reapply without admin privileges',
  { skip: process.platform !== 'win32', timeout: 300_000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'nod-dpapi-restart-'));
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
app.setPath('userData', process.env.NOD_STORAGE_TEST_USER_DATA);
app.whenReady().then(async () => {
  assert.equal(safeStorage.isEncryptionAvailable(), true);
  const profile = process.env.NOD_STORAGE_TEST_PROFILE;
  const settingsPath = join(profile, 'settings.json');
  const store = createSettingsStore(settingsPath, safeStorage);
  if (process.argv.at(-1) === 'write') {
    await store.save({ notifications: true, launchAtLogin: true, onboardingCompleted: true });
    await store.save({notifications:false});
  }
  const { NOD_VAULT_KEY } = await store.environment();
  const key = Buffer.from(NOD_VAULT_KEY, 'base64');
  const binding = ['synthetic-owner', 'synthetic-account'];
  const secret = 'synthetic-private-provider-key';
  const ciphertextPath = join(profile, 'vault');
  if (process.argv.at(-1) === 'write')
    await writeFile(ciphertextPath, sealVaultValue(key, binding, secret));
  const ciphertext = await readFile(ciphertextPath, 'utf8');
  assert.equal(openVaultValue(key, binding, ciphertext), secret);
  assert.throws(() => openVaultValue(key, ['different-owner', binding[1]], ciphertext));
  const settings = await readFile(settingsPath);
  assert.equal(settings.includes(NOD_VAULT_KEY), false);
  assert.equal(ciphertext.includes(secret), false);
  process.stdout.write('NOD_STORAGE_RESULT=' + JSON.stringify({
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
      NOD_STORAGE_TEST_PROFILE: profile,
      NOD_STORAGE_TEST_USER_DATA: join(directory, 'electron'),
    };
    delete environment.ELECTRON_RUN_AS_NODE;
    const execute = (file, args, env = environment) =>
      new Promise((resolve, reject) => {
        execFile(file, args, { env, timeout: 45_000, windowsHide: true }, (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });
    const powershell = join(
      process.env.SYSTEMROOT,
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const { default: electron } = await import('../node_modules/electron/index.js');
    const run = async (mode) => {
      const output = await execute(electron, [script, mode]);
      const result = output.match(/NOD_STORAGE_RESULT=([^\r\n]+)/);
      assert.ok(result, 'The Electron process must return its storage receipt.');
      return JSON.parse(result[1]);
    };
    const first = await run('write');
    await execute(
      powershell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        fileURLToPath(new URL('../scripts/drop-admin-privileges.ps1', import.meta.url)),
        '-ProcessId',
        String(process.pid),
      ],
      windowsEnvironment(),
    );
    await protectWindowsProfile(profile, engineRoot);
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
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$ErrorActionPreference = 'Stop'
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$owner = $identity.User.Value
$expected = @($owner, 'S-1-5-18', 'S-1-5-32-544')
$results = foreach ($path in @($env:NOD_STORAGE_TEST_PROFILE, (Join-Path $env:NOD_STORAGE_TEST_PROFILE 'settings.json'), (Join-Path $env:NOD_STORAGE_TEST_PROFILE 'vault'))) {
  $acl = Get-Acl -LiteralPath $path
  $expectedOwner = if ($path -eq $env:NOD_STORAGE_TEST_PROFILE) { $owner } else { $identity.Owner.Value }
  $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
  [pscustomobject]@{
    private = ($rules.Count -eq 3 -and @($rules | Where-Object { $_.IdentityReference.Value -notin $expected -or $_.AccessControlType -ne 'Allow' -or $_.FileSystemRights -ne 'FullControl' }).Count -eq 0)
    owner = ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $expectedOwner)
    protected = $acl.AreAccessRulesProtected
  }
}
ConvertTo-Json -InputObject @($results) -Compress`,
        ],
        { ...windowsEnvironment(), NOD_STORAGE_TEST_PROFILE: profile },
      ),
    );
    assert.equal(acl.length, 3);
    assert.ok(
      acl.every((value) => value.private && value.owner),
      JSON.stringify(acl),
    );
    assert.equal(acl[0].protected, true);
  },
);

test('startup reads preserve older settings for rollback until an owner preference changes', async (t) => {
  const f = await fixture(t);
  await f.store.save({
    theme: 'dark',
    notifications: true,
    launchAtLogin: true,
    onboardingCompleted: true,
  });
  const expected = await f.store.environment();
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  saved.secrets.composioApiKey = 'unreadable-retired-ciphertext';
  saved.secrets.integrationConfiguration = 'unreadable-retired-config';
  saved.keyMetadata = {
    composioApiKey: { suffix: 'test', source: 'manual', updatedAt: '2026-01-01T00:00:00.000Z' },
  };
  const previous = JSON.stringify(saved, null, 2);
  await writeFile(f.path, previous);
  const store = createSettingsStore(f.path, {
    ...f.encryption,
    decryptString: () => assert.fail('Reading preferences must not decrypt retired app keys.'),
    decryptStringAsync: () => assert.fail('Reading preferences must not decrypt retired app keys.'),
  });
  const settings = await store.get();
  assert.equal(settings.theme, 'dark');
  assert.equal(settings.notifications, true);
  assert.equal(settings.onboardingCompleted, true);
  assert.equal(await readFile(f.path, 'utf8'), previous);
  const blocked = createSettingsStore(f.path, {
    ...f.encryption,
    isEncryptionAvailable: () => false,
    isAsyncEncryptionAvailable: async () => false,
  });
  await assert.rejects(blocked.environment(), /unlock/i);
  assert.equal(await readFile(f.path, 'utf8'), previous);
  assert.deepEqual(await f.reopen().environment(), expected);
  assert.equal(await readFile(f.path, 'utf8'), previous);
  await store.save({ theme: 'light' });
  const current = JSON.parse(await readFile(f.path, 'utf8'));
  assert.equal(current.theme, 'light');
  assert.deepEqual(current.secrets, { vaultKey: saved.secrets.vaultKey });
  assert.equal(Object.hasOwn(current, 'keyMetadata'), false);
  assert.deepEqual(await f.reopen().environment(), expected);
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
  await new Promise(setImmediate);
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
    { ...saved, notifications: undefined },
    { ...saved, secrets: null },
    { ...saved, secrets: { vaultKey: 123 } },
    { ...saved, secrets: { ...saved.secrets, vaultKey: '' } },
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
  const vault = environments[0].NOD_VAULT_KEY;
  assert.equal(Buffer.from(vault, 'base64').length, 32);
  for (const environment of environments) assert.deepEqual(environment, { NOD_VAULT_KEY: vault });
  assert.equal((await f.reopen().environment()).NOD_VAULT_KEY, vault);
  assert.ok(!(await readFile(f.path, 'utf8')).includes(vault));
  await f.store.save({ notifications: true, launchAtLogin: true, onboardingCompleted: true });
  assert.equal((await f.store.environment()).NOD_VAULT_KEY, vault);
});

test('settings withhold completion when temporary bytes fail to persist', async (t) => {
  const f = await fixture(t);
  await f.store.save({ notifications: true, launchAtLogin: true });
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
    await f.store.save({ notifications: true, launchAtLogin: true });
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
  const capture = f.handlers.get('nod:feedback:capture');
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
    '/usage',
    '/vault',
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
    'importRuntime',
  ])
    assert.equal(bridge[field], undefined);
  let received;
  bridge.onPreferences((...values) => {
    received = values;
  });
  const value = { theme: 'dark', resolvedTheme: 'dark', notifications: true, launchAtLogin: false };
  listeners.get('nod:preferences')({ sender: 'privileged-synthetic-ipc' }, value);
  assert.deepEqual(received, [value]);
  bridge.onStatus((...values) => {
    received = values;
  });
  const status = { phase: 'preparing', runtime: { phase: 'starting' } };
  listeners.get('nod:status')({ sender: 'privileged-synthetic-ipc' }, status);
  assert.deepEqual(received, [status]);
});

async function chatReadFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nod-chat-read-'));
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
  const directory = await mkdtemp(join(tmpdir(), 'nod-native-preferences-'));
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
    file: `nod-Runtime-${platform}-${'b'.repeat(12)}.tar.gz`,
    bytes: 180,
    sha256: 'c'.repeat(64),
  };
  const runtime = {
    platform,
    ...(official ? { releaseTag: 'nod-v0.1.9' } : {}),
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
    tag_name: 'nod-v0.2.0',
    draft: false,
    prerelease: true,
    assets: [
      item(101, name('release'), 300),
      item(103, `nod-${arch}.zip`, 1000),
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
    update: { file: `nod-${arch}.zip`, bytes: 1000, sha256: 'e'.repeat(64) },
  };
  const base = sourceUrl || 'https://api.github.com/repos/n8n-io/nod';
  const assetPath = (owner, entry) =>
    sourceUrl
      ? `${base}/releases/${owner.id}/assets/${entry.id}/${entry.name}`
      : `${base}/releases/assets/${entry.id}`;
  const values = new Map([
    [
      `${base}/releases${sourceUrl ? '' : '?per_page=100'}`,
      [
        { ...release, id: 11, tag_name: 'nod-v0.1.0' },
        { ...release, id: 13, tag_name: 'nod-v9.0.0', draft: true },
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
        url: `https://github.com/n8n-io/nod/releases/download/nod-v0.2.0/nod-${arch}.zip`,
        name: 'nod 0.2.0',
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
      createUpdateSource({ sourceUrl: `https://updates.example.invalid/nod${suffix}` }),
    );
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/nod-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    const candidate = await f.source.latest('0.1.0');
    assert.equal(candidate.version, '0.2.0');
    assert.equal(candidate.runtime.archive.sha256, f.runtime.archive.sha256);
    assert.equal(
      candidate.downloadUrl,
      sourceUrl
        ? `${sourceUrl}/releases/18/assets/201/${f.runtime.archive.file}`
        : 'https://api.github.com/repos/n8n-io/nod/releases/assets/201',
    );
    assert.equal(
      candidate.feedUrl,
      sourceUrl
        ? `${sourceUrl}/releases/12/feed/103?version=0.1.0&platform=darwin-arm64`
        : 'https://github.com/n8n-io/nod/releases/download/nod-v0.2.0/update.json',
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
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/nod-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    const broken = { ...f.release, id: 15, tag_name: 'nod-v0.3.0', assets: [] };
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
        queueMicrotask(() => native.emit('update-downloaded', {}, '', 'nod 0.2.0'));
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
      restart: async () => assert.fail('Background readiness cannot restart nod.'),
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
    await f.handlers.get('nod:settings:save')(
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
  for (const sourceUrl of [undefined, 'https://updates.example.invalid/nod-desktop']) {
    const f = updateReleaseFixture(sourceUrl);
    assert.equal(await f.source.latest('0.2.0'), undefined);
    assert.equal(
      await f.source.runtimeDownloadUrl(f.runtime),
      sourceUrl
        ? `${sourceUrl}/releases/18/assets/201/${f.runtime.archive.file}`
        : 'https://api.github.com/repos/n8n-io/nod/releases/assets/201',
    );
    for (const change of [
      (runtime) => (runtime.fingerprint = '../other'),
      (runtime) => (runtime.id = 'invalid'),
      (runtime) => (runtime.archive.file = '../runtime.tar.gz'),
      (runtime) => (runtime.archive.file = `nod-Runtime-darwin-arm64-${'f'.repeat(12)}.tar.gz`),
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
  native.emit('update-downloaded', {}, '', 'nod 0.2.0');
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
  native.emit('update-downloaded', {}, '', 'nod 0.2.0');
  assert.equal((await first).version, '0.2.0');
  assert.equal((await updater.check()).version, '0.2.0');
  assert.equal(selections, 1);
  updater.dispose();
  const wrongNative = new EventEmitter();
  wrongNative.setFeedURL = () => {};
  wrongNative.checkForUpdates = () =>
    queueMicrotask(() => wrongNative.emit('update-downloaded', {}, '', 'nod 0.1.0'));
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
  const root = await mkdtemp(join(tmpdir(), 'nod-windows-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = 'https://updates.example.invalid/nod-desktop';
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const bytes = {
    'nod-Setup-x64.exe': Buffer.from('synthetic Windows installer'),
    'nod-Runtime-win32-x64.tar.gz': Buffer.from('synthetic Windows runtime pack'),
  };
  const entry = (file) => ({ file, bytes: bytes[file].length, sha256: digest(bytes[file]) });
  const manifest = {
    version: '0.2.0',
    platform: 'win32-x64',
    source: 'a'.repeat(40),
    signing: { mode: 'unsigned' },
    installer: entry('nod-Setup-x64.exe'),
    runtime: entry('nod-Runtime-win32-x64.tar.gz'),
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
    tag_name: 'nod-v0.2.0',
    draft: false,
    assets: [
      item(301, 'release-win32-x64.json', 400, 'f'.repeat(64)),
      item(302, 'nod-Setup-x64.exe', manifest.installer.bytes, manifest.installer.sha256),
      item(303, 'nod-Runtime-win32-x64.tar.gz', manifest.runtime.bytes, manifest.runtime.sha256),
    ],
  };
  const served = { ...bytes };
  const downloads = [];
  const request = async (url) => {
    if (url === `${base}/releases`)
      return Response.json([{ ...release, id: 11, tag_name: 'nod-v0.1.0' }, release]);
    if (url === `${base}/releases/12` || url === `${base}/tags/nod-v0.2.0`)
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
  await installRuntime(bytes['nod-Runtime-win32-x64.tar.gz']);
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
  assert.deepEqual(downloads, ['nod-Setup-x64.exe']);
  assert.deepEqual(await readdir(join(directory, '0.2.0')), ['nod-Setup-x64.exe']);
  assert.deepEqual(
    await readFile(join(directory, '0.2.0', 'nod-Setup-x64.exe')),
    bytes['nod-Setup-x64.exe'],
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
  assert.deepEqual(downloads, ['nod-Runtime-win32-x64.tar.gz', 'nod-Setup-x64.exe']);
  for (const [name, value] of Object.entries(bytes))
    assert.deepEqual(await readFile(join(directory, '0.2.0', name)), value);

  const source = createUpdateSource({ sourceUrl: base, os: 'win32', fetch: request });
  const runtime = {
    releaseTag: 'nod-v0.2.0',
    guest: { bytes: manifest.runtime.bytes, sha256: manifest.runtime.sha256 },
  };
  assert.equal(
    await source.runtimeDownloadUrl(runtime),
    `${base}/releases/12/assets/303/nod-Runtime-win32-x64.tar.gz`,
  );
  await assert.rejects(
    source.runtimeDownloadUrl({ ...runtime, guest: { ...runtime.guest, sha256: 'e'.repeat(64) } }),
  );

  served['nod-Setup-x64.exe'] = Buffer.alloc(bytes['nod-Setup-x64.exe'].length, 'x');
  await assert.rejects(stageWindowsUpdate(candidate, { directory, resourcesPath, fetch: request }));
  await assert.rejects(stat(directory), { code: 'ENOENT' });

  release.assets[1].digest = `sha256:${'e'.repeat(64)}`;
  await assert.rejects(
    createUpdateSource({ sourceUrl: base, os: 'win32', fetch: request }).latest('0.1.0'),
  );
});

test('Intel updates use their own app assets and an official nod runtime release', async () => {
  const f = updateReleaseFixture('https://updates.example.invalid/nod-desktop', 'x64', true);
  const candidate = await f.source.latest('0.1.0');
  assert.equal(candidate.runtime.platform, 'darwin-x64');
  assert(candidate.feedUrl.endsWith('platform=darwin-x64'));
  assert(f.calls.some((url) => url.endsWith('/release-darwin-x64.json')));
  assert(f.calls.some((url) => url.endsWith('/tags/nod-v0.1.9')));
  f.manifest.platform = 'darwin-arm64';
  await assert.rejects(f.source.latest('0.1.0'));
  f.manifest.platform = 'darwin-x64';
  f.runtime.platform = 'darwin-arm64';
  await assert.rejects(f.source.latest('0.1.0'));
});

test('desktop preference choices resume durably and cannot skip or regress explicit consent', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.get()).onboardingPreferenceStep, 'notifications');
  await assert.rejects(f.store.save({ onboardingCompleted: true }));
  await assert.rejects(f.store.save({ notifications: true, onboardingCompleted: true }));
  assert.equal((await f.store.get()).onboardingCompleted, false);
  await assert.rejects(f.store.save({ launchAtLogin: true, onboardingPreferenceStep: 'complete' }));
  await assert.rejects(f.store.save({ onboardingPreferenceStep: 'launchAtLogin' }));
  await assert.rejects(
    f.store.save({ notifications: false, onboardingPreferenceStep: 'launchAtLogin' }),
  );
  await f.store.save({ notifications: true, onboardingPreferenceStep: 'launchAtLogin' });
  const reopened = f.reopen();
  assert.equal((await reopened.get()).notifications, true);
  assert.equal((await reopened.get()).onboardingPreferenceStep, 'launchAtLogin');
  await reopened.save({ notifications: true, onboardingPreferenceStep: 'launchAtLogin' });
  await assert.rejects(
    reopened.save({ notifications: false, onboardingPreferenceStep: 'launchAtLogin' }),
  );
  await assert.rejects(
    reopened.save({ launchAtLogin: false, onboardingPreferenceStep: 'complete' }),
  );
  await reopened.save({ launchAtLogin: true, onboardingPreferenceStep: 'complete' });
  await reopened.save({ launchAtLogin: true, onboardingPreferenceStep: 'complete' });
  assert.equal((await f.reopen().get()).onboardingPreferenceStep, 'complete');
  const saved = JSON.parse(await readFile(f.path, 'utf8'));
  delete saved.onboardingPreferenceStep;
  saved.onboardingCompleted = true;
  saved.notifications = false;
  saved.launchAtLogin = false;
  await writeFile(f.path, JSON.stringify(saved));
  assert.equal((await f.reopen().get()).onboardingPreferenceStep, 'complete');
  assert.equal((await f.reopen().get()).notifications, false);
  assert.equal((await f.reopen().get()).launchAtLogin, false);
});

test('desktop preference steps and completion require the owned normal app and durable server completion', async (t) => {
  for (const platform of ['darwin', 'win32'])
    await t.test(platform, async (t) => {
      let completed = false;
      let loginItemsWritable = false;
      let loginStatus = {};
      let registered = false;
      const f = await runningDesktop(
        t,
        async (url) =>
          new URL(url).pathname === '/api/account'
            ? Response.json({ settings: { usageData: false } })
            : Response.json({ ok: true, settings: { onboardingCompleted: completed } }),
        {
          initialState: 'fresh',
          allowStart: true,
          platform,
          updateLoginItems: (value) => {
            if (loginItemsWritable) registered = value.openAtLogin;
            return loginItemsWritable;
          },
          loginItemStatus: () => loginStatus,
        },
      );
      await f.storage.store.save({ welcome: { usageData: false, continued: true } });
      try {
        await f.launch();
        await f.settle();
        const window = f.windows.at(-1);
        const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
        const save = f.handlers.get('nod:settings:save');
        await assert.rejects(
          save(
            { ...event, senderFrame: { url: window.url } },
            { notifications: true, onboardingPreferenceStep: 'launchAtLogin' },
          ),
        );
        await assert.rejects(save(event, { welcome: { usageData: true, continued: true } }));
        await assert.rejects(save(event, { onboardingCompleted: true }));
        await assert.rejects(
          save(event, { notifications: false, onboardingPreferenceStep: 'launchAtLogin' }),
        );
        await save(event, { notifications: true, onboardingPreferenceStep: 'launchAtLogin' });
        await assert.rejects(
          save(event, { launchAtLogin: true, onboardingPreferenceStep: 'complete' }),
          /login items/,
        );
        assert.equal((await f.storage.reopen().get()).launchAtLogin, false);
        assert.equal((await f.storage.reopen().get()).onboardingPreferenceStep, 'launchAtLogin');
        loginItemsWritable = true;
        for (const status of platform === 'darwin'
          ? [{ status: 'requires-approval' }, { status: 'not-found' }]
          : [{ executableWillLaunchAtLogin: false }]) {
          loginStatus = status;
          await assert.rejects(
            save(event, { launchAtLogin: true, onboardingPreferenceStep: 'complete' }),
            /login items/,
          );
          assert.equal(registered, true);
          assert.equal((await f.storage.reopen().get()).launchAtLogin, false);
          assert.equal((await f.storage.reopen().get()).onboardingPreferenceStep, 'launchAtLogin');
        }
        loginStatus = {};
        await save(event, { launchAtLogin: true, onboardingPreferenceStep: 'complete' });
        assert.equal((await f.storage.reopen().get()).onboardingPreferenceStep, 'complete');
        completed = true;
        await save(event, { onboardingCompleted: true });
        assert.equal((await f.storage.reopen().get()).onboardingCompleted, true);
        await assert.rejects(save(event, { onboardingCompleted: false }));
      } finally {
        await f.close();
      }
    });
});

test('native readiness notification waits for full runtime readiness and reaches opted-in background users once', async (t) => {
  for (const scenario of [
    { enabled: true, focused: false, supported: true, expected: 1 },
    { enabled: false, focused: false, supported: true, expected: 0 },
    { enabled: true, focused: true, supported: true, expected: 0 },
    { enabled: true, focused: false, supported: false, expected: 0 },
  ]) {
    await t.test(JSON.stringify(scenario), async (t) => {
      const resources = deferred();
      const storage = deferred();
      const f = await runningDesktop(t, async () => Response.json({ ok: true }), {
        initialState: 'fresh',
        allowStart: true,
        prepareRuntime: async ({ onStorageReady }) => {
          const runtime = { env: {} };
          await onStorageReady(runtime);
          storage.resolve();
          await resources.promise;
          return runtime;
        },
        notificationsSupported: scenario.supported,
      });
      try {
        await f.storage.store.save({ notifications: scenario.enabled });
        await f.launch();
        await storage.promise;
        const window = f.windows[0];
        window.focused = scenario.focused;
        assert.equal(f.notifications.length, 0);
        resources.resolve();
        await f.settle();
        await new Promise(setImmediate);
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
        resources.resolve();
        await f.close();
      }
    });
  }
});
