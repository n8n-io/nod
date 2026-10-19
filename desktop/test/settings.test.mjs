import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
import { saveArtifactDownload } from '../main/downloads.mjs';
import { createDesktopLifecycle, desktopSetupMode } from '../main/lifecycle.mjs';
import {
  createDesktopUpdater,
  createUpdateSource,
  startDesktopUpdateChecks,
} from '../main/updates.mjs';
import { stageWindowsUpdate } from '../runtime/windows.mjs';

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
    environment = {},
    platform = 'darwin',
    packaged = false,
    prompt = () => assert.fail('No restart prompt is needed.'),
    reveal = () => assert.fail('No file should be revealed.'),
  } = {},
) {
  const storage = await fixture(t);
  await storage.store.save({
    onboardingCompleted: true,
  });
  const windows = [];
  const children = [];
  const paths = new Map();
  const handlers = new Map();
  const ipc = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
  });
  let openAtLogin = false;
  const context = {
    app: {
      isPackaged: packaged,
      setName() {},
      setPath: (name, path) => paths.set(name, path),
      getPath: (name) => paths.get(name) || dirname(storage.path),
      getVersion: () => '0.0.0-test',
      requestSingleInstanceLock: () => false,
      getLoginItemSettings: () => ({ openAtLogin }),
      setLoginItemSettings: (value) => {
        openAtLogin = value.openAtLogin;
      },
      quit() {},
    },
    process: {
      platform,
      argv: [],
      env: typeof environment === 'function' ? environment(dirname(storage.path)) : environment,
      resourcesPath: dirname(storage.path),
    },
    ipcMain: ipc,
    dialog: { showMessageBox: async (options) => prompt(options) },
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
    createAppPreferencesStore: () => ({ sync: async () => {} }),
    createChatReadCursorStore: () => ({}),
    saveArtifactDownload,
    createReadinessNotice: () => ({ update() {} }),
    createDesktopLifecycle: (options) =>
      createDesktopLifecycle({
        ...options,
        prepareRuntime: async () => {
          await mkdir(join(paths.get('userData'), 'profiles', 'local'), { recursive: true });
          return { env: {} };
        },
      }),
    desktopSetupMode,
    nativeTheme: { shouldUseDarkColors: false },
    safeStorage: storage.encryption,
    Notification: { isSupported: () => false },
    utilityProcess: {
      fork(_file, _args, options) {
        assert.ok(allowStart, 'The healthy engine must not restart.');
        assert.ok(Object.values(options.env).every((value) => typeof value === 'string'));
        const child = new EventEmitter();
        child.environment = options.env;
        child.port = options.env.PORT;
        child.stdout = { resume() {} };
        child.stderr = new EventEmitter();
        child.kill = () => {
          child.killed = true;
          child.emit('exit', 0);
        };
        if (reportReady)
          setImmediate(() =>
            child.emit('message', { type: 'otto-ready', port: Number(options.env.PORT) }),
          );
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
    engineBound = true;
    onboardingCompleted = true;
    status.phase = 'ready';
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:get'"), source.indexOf("      ipcMain.handle('otto:feedback:context'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:feedback:context'"), source.indexOf("      ipcMain.handle('otto:preferences:get'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:settings:save'"), source.indexOf("      ipcMain.handle('otto:prepare'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:prepare'"), source.indexOf("      ipcMain.handle('otto:runtime:warm'"))}
    ${source.slice(source.indexOf("      ipcMain.handle('otto:runtime:install-wsl'"), source.indexOf("      ipcMain.handle('otto:chat-read:get'"))}
    globalThis.running = {
      prepare,
      showEngine,
      showSettings,
      replayOnboarding,
      showFeedback,
      saveEngineDownload,
      setReady: (ready) => { status.phase = ready ? 'ready' : 'starting'; },
      status: () => status,
      crash: () => { engine = undefined; enginePreferencesReady = false; },
    };`,
    context,
  );
  return { ...context.running, windows, children, storage, handlers };
}

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

test('legacy app keys never reach the desktop engine or renderer and its vault remains unchanged', async (t) => {
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
});

test('native onboarding replay reaches product onboarding without restarting or resetting the profile', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('Replay must not make an engine request.'));
  await f.storage.store.environment();
  const before = await readFile(f.storage.path, 'utf8');
  f.showEngine();
  const chat = f.windows.at(-1);
  f.replayOnboarding();
  const intro = f.windows.at(-1);
  assert.equal(intro.query.mode, 'onboarding');
  await f.handlers.get('otto:prepare')({
    sender: intro.webContents,
    senderFrame: intro.webContents.mainFrame,
  });
  assert.equal(chat.url, 'http://127.0.0.1:4310/onboarding?replay=1');
  assert.equal(chat.isDestroyed(), false);
  assert.equal(intro.isDestroyed(), true);
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
    const store = createSettingsStore(f.path, unavailable);
    const fresh = createSettingsStore(join(dirname(f.path), 'fresh.json'), unavailable);
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
    const store = createSettingsStore(f.path, {
      ...f.encryption,
      isEncryptionAvailable: () => assert.fail('Invalid storage must not access the key store.'),
    });
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
