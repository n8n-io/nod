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
import { createAppPreferencesStore } from '../main/app-preferences.mjs';
import { createChatReadCursorStore } from '../main/chat-read-cursors.mjs';
import { validateProviderKey } from '../main/validate-provider.mjs';
import { createDesktopLifecycle, desktopSetupMode } from '../main/lifecycle.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

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
  await f.store.save({ openaiApiKey: 'synthetic-warmup-provider-key' });
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
    assert.equal(
      desktopSetupMode({ completed: true, providerConfigured: false, replaying: false, running }),
      'onboarding',
    );
    assert.equal(desktopSetupMode({ completed: false, replaying: false, running }), 'onboarding');
    assert.equal(desktopSetupMode({ completed: true, replaying: true, running }), 'onboarding');
  }
  assert.equal(desktopSetupMode({ completed: true, replaying: false, running: false }), 'loading');
  assert.equal(desktopSetupMode({ completed: true, replaying: false, running: true }), 'settings');
});

async function runningDesktop(t, request, { allowStart = false } = {}) {
  const storage = await fixture(t);
  await storage.store.save({
    openaiApiKey: 'synthetic-running-provider-key',
    onboardingCompleted: true,
  });
  const windows = [];
  const children = [];
  const context = {
    app: {
      setName() {},
      setPath() {},
      getPath: () => dirname(storage.path),
      requestSingleInstanceLock: () => false,
      quit() {},
    },
    process: { platform: 'darwin', argv: [], env: {} },
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
    validateProviderKey: () => assert.fail('The main process must not validate a key again.'),
    Notification: { isSupported: () => false },
    utilityProcess: {
      fork() {
        assert.ok(allowStart, 'The healthy engine must not restart.');
        const child = new EventEmitter();
        child.stdout = { resume() {} };
        child.stderr = new EventEmitter();
        child.kill = () => child.emit('exit', 0);
        children.push(child);
        return child;
      },
    },
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        this.webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler() {},
          send() {},
        });
        windows.push(this);
      }
      isDestroyed() {
        return this.destroyed === true;
      }
      isFocused() {
        return false;
      }
      loadURL(url) {
        this.url = url;
      }
      loadFile(path) {
        this.path = path;
      }
      show() {}
      focus() {}
      setSize() {}
      destroy() {
        this.destroyed = true;
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
    providerConfigured = true;
    status.phase = 'ready';
    globalThis.running = {
      prepare,
      showEngine,
      status: () => status,
      setRestartRequired: (value) => { restartRequired = value; },
      crash: () => { engine = undefined; enginePreferencesReady = false; },
    };`,
    context,
  );
  return { ...context.running, windows, children, storage };
}

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

test('a deferred provider restart keeps the healthy chat accessible and settings pending', async (t) => {
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

test('deferred restart recovery preserves provider settings without replaying onboarding', async (t) => {
  const running = await runningDesktop(t, async () => Response.json({ activeWork: true }));
  const f = await setupRenderer(t, 'settings', { phase: 'ready' }, running.storage.store);
  running.setRestartRequired(true);
  f.desktop.prepare = running.prepare;
  f.desktop.replayOnboarding = () => assert.fail('Saved provider settings must not replay setup.');
  f.document.querySelector('#provider-key-field .key-action:last-child').click();
  const key = f.document.getElementById('openaiApiKey');
  key.value = 'synthetic-replacement-provider-key';
  key.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await f.submit();
  await f.waitFor(() => !f.document.getElementById('retry').hidden);
  assert.equal(f.document.getElementById('preparation-error').hidden, false);
  assert.equal((await running.storage.store.environment()).OPENAI_API_KEY, key.value);
  f.document.getElementById('edit-settings').click();
  await f.settle();
  assert.equal(f.document.getElementById('settings-form').hidden, false);
  assert.equal(f.document.getElementById('retry-settings').hidden, false);
  assert.equal(f.document.getElementById('error').hidden, false);
  f.document.getElementById('retry-settings').click();
  await f.waitFor(() => !f.document.getElementById('retry').hidden);
  f.callbacks.navigate({ mode: 'settings', section: 'providers' });
  assert.equal(f.document.getElementById('settings-form').hidden, false);
  assert.equal(f.document.getElementById('sidebar').hidden, false);
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

test('saving unchanged provider and general preferences reuses the running engine', async (t) => {
  const f = await runningDesktop(t, () => assert.fail('No restart admission check is needed.'));
  const revision = await f.storage.store.revision();
  await f.storage.store.save({ provider: 'openai' });
  await f.storage.store.save({ theme: 'dark', notifications: true });
  f.setRestartRequired((await f.storage.store.revision()) !== revision);
  const result = await f.prepare();
  assert.equal(result.phase, 'ready');
  assert.equal(result.restartRequired, false);
  assert.equal(result.error, undefined);
});

async function fixture(t, validate) {
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
    store: createSettingsStore(path, encryption, validate),
    reopen: () => createSettingsStore(path, encryption, validate),
  };
}

test('provider keys remain encrypted at rest and only redacted settings reach the renderer', async (t) => {
  const f = await fixture(t);
  const secrets = {
    openaiApiKey: 'synthetic-openai-provider-key',
    anthropicApiKey: 'synthetic-anthropic-provider-key',
    composioApiKey: 'synthetic-composio-provider-key',
  };
  const saved = await f.store.save({
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    ...secrets,
  });
  assert.equal(saved.provider, 'anthropic');
  assert.equal(saved.model, 'claude-sonnet-5-5');
  assert.equal(saved.hasOpenAIKey, true);
  assert.equal(saved.hasAnthropicKey, true);
  assert.equal(saved.hasComposioKey, true);
  for (const field of Object.keys(secrets)) {
    assert.equal(saved.keys[field].suffix, secrets[field].slice(-4));
    assert.equal(saved.keys[field].source, 'manual');
  }
  const disk = await readFile(f.path, 'utf8');
  for (const secret of Object.values(secrets)) {
    assert.ok(!disk.includes(secret));
    assert.ok(!JSON.stringify(saved).includes(secret));
  }
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.deepEqual(await f.reopen().get(), saved);
  const environment = await f.reopen().environment();
  assert.equal(environment.OPENAI_API_KEY, secrets.openaiApiKey);
  assert.equal(environment.ANTHROPIC_API_KEY, secrets.anthropicApiKey);
  assert.equal(environment.COMPOSIO_API_KEY, secrets.composioApiKey);
  assert.equal(Buffer.from(environment.OTTO_VAULT_KEY, 'base64').length, 32);
  assert.equal((await f.reopen().environment()).OTTO_VAULT_KEY, environment.OTTO_VAULT_KEY);
  assert.ok(!disk.includes(environment.OTTO_VAULT_KEY));
});

test('rejected validation preserves the last working keys and later saves still succeed', async (t) => {
  const f = await fixture(t, async (_provider, key) => {
    if (key === 'synthetic-rejected-key') throw new Error('The provider rejected this key.');
  });
  await f.store.save({ openaiApiKey: 'synthetic-working-key' });
  const previous = await readFile(f.path, 'utf8');
  await assert.rejects(
    f.store.save({ openaiApiKey: 'synthetic-rejected-key', model: '' }),
    /provider rejected/,
  );
  assert.equal(await readFile(f.path, 'utf8'), previous);
  assert.equal((await f.store.environment()).OPENAI_API_KEY, 'synthetic-working-key');
  await f.store.save({ openaiApiKey: 'synthetic-replacement-key' });
  assert.equal((await f.reopen().environment()).OPENAI_API_KEY, 'synthetic-replacement-key');
});

test('blank fields preserve keys while explicit removal persists without rotating the vault', async (t) => {
  const f = await fixture(t);
  await f.store.save({
    openaiApiKey: 'synthetic-openai-key',
    anthropicApiKey: 'synthetic-anthropic-key',
    composioApiKey: 'synthetic-composio-key',
  });
  const before = await f.store.environment();
  await f.store.save({ openaiApiKey: '', anthropicApiKey: '   ' });
  assert.equal((await f.store.environment()).OPENAI_API_KEY, before.OPENAI_API_KEY);
  assert.equal((await f.store.environment()).ANTHROPIC_API_KEY, before.ANTHROPIC_API_KEY);
  await f.store.save({ openaiApiKey: null, clearKeys: ['composioApiKey'] });
  const after = await f.reopen().environment();
  assert.equal(after.OPENAI_API_KEY, '');
  assert.equal(after.COMPOSIO_API_KEY, '');
  assert.equal(after.ANTHROPIC_API_KEY, before.ANTHROPIC_API_KEY);
  assert.equal(after.OTTO_VAULT_KEY, before.OTTO_VAULT_KEY);
  assert.equal((await f.reopen().get()).hasOpenAIKey, false);
});

test('encrypted settings import cannot import connected accounts or replace runtime identity', async (t) => {
  const f = await fixture(t);
  await f.store.save(
    {},
    {
      COMPOSIO_GMAIL_AUTH_CONFIG_ID: 'synthetic-auth-config',
      COMPOSIO_CONNECTED_ACCOUNT_ID: 'synthetic-connected-account',
      TELEGRAM_BOT_TOKEN: 'synthetic-bot-token',
      DATABASE_URL: 'synthetic-database-url',
      OTTO_DESKTOP_OWNER_ID: 'synthetic-owner',
      OTTO_DESKTOP_AUTH_TOKEN: 'synthetic-desktop-token',
      OTTO_VAULT_KEY: 'synthetic-vault-key',
    },
  );
  const environment = await f.reopen().environment();
  assert.equal(environment.COMPOSIO_GMAIL_AUTH_CONFIG_ID, 'synthetic-auth-config');
  for (const field of [
    'COMPOSIO_CONNECTED_ACCOUNT_ID',
    'TELEGRAM_BOT_TOKEN',
    'DATABASE_URL',
    'OTTO_DESKTOP_OWNER_ID',
    'OTTO_DESKTOP_AUTH_TOKEN',
  ])
    assert.equal(environment[field], undefined);
  assert.notEqual(environment.OTTO_VAULT_KEY, 'synthetic-vault-key');
  assert.ok(!(await readFile(f.path, 'utf8')).includes('synthetic-auth-config'));
});

test('unavailable or plaintext key stores refuse secret persistence and decryption', async (t) => {
  const f = await fixture(t);
  await f.store.save({ openaiApiKey: 'synthetic-protected-key' });
  const previous = await readFile(f.path, 'utf8');
  for (const unavailable of [
    { ...f.encryption, isEncryptionAvailable: () => false },
    { ...f.encryption, getSelectedStorageBackend: () => 'basic_text' },
  ]) {
    const store = createSettingsStore(f.path, unavailable);
    await assert.rejects(store.save({ openaiApiKey: 'synthetic-new-key' }), /system key store/);
    await assert.rejects(store.environment(), /system key store/);
    assert.equal(await readFile(f.path, 'utf8'), previous);
  }
});

test('unreadable ciphertext fails closed without returning the secret or decryptor error', async (t) => {
  const f = await fixture(t);
  await f.store.save({ openaiApiKey: 'synthetic-private-key' });
  const value = JSON.parse(await readFile(f.path, 'utf8'));
  const ciphertext = Buffer.from(value.secrets.openaiApiKey, 'base64');
  ciphertext[12] ^= 1;
  value.secrets.openaiApiKey = ciphertext.toString('base64');
  await writeFile(f.path, JSON.stringify(value));
  await assert.rejects(f.reopen().environment(), {
    message: 'The system key store could not unlock your saved keys.',
  });
});

test('preferences persist without unlocking keys or changing the running engine configuration', async (t) => {
  const f = await fixture(t);
  await f.store.save({ openaiApiKey: 'synthetic-retained-provider-key' });
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
  assert.equal((await f.reopen().environment()).OPENAI_API_KEY, 'synthetic-retained-provider-key');
  await assert.rejects(store.save({ theme: 'invalid' }), /supported appearance/);
  await assert.rejects(store.save({ notifications: 'true' }), /preferences/);
});

test('explicit reveal permits only provider keys while ordinary reads retain masked metadata', async (t) => {
  const f = await fixture(t);
  const key = 'synthetic-reveal-provider-key';
  await f.store.save({ openaiApiKey: key }, {});
  assert.equal(await f.store.revealKey('openaiApiKey'), key);
  assert.equal(await f.store.revealKey('anthropicApiKey'), '');
  const redacted = await f.store.get();
  assert.equal(redacted.keys.openaiApiKey.source, 'import');
  assert.equal(redacted.keys.openaiApiKey.suffix, '-key');
  assert.ok(!JSON.stringify(redacted).includes(key));
  for (const field of ['vaultKey', 'integrationConfiguration', '__proto__', null])
    await assert.rejects(f.store.revealKey(field), /supported provider key/);
  await f.store.save({ openaiApiKey: null });
  assert.equal(await f.store.revealKey('openaiApiKey'), '');
  assert.deepEqual((await f.store.get()).keys.openaiApiKey, {
    suffix: null,
    source: null,
    updatedAt: null,
  });
});

test('migration preserves encrypted keys and existing models without replaying first-use onboarding', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.store.get()).onboardingCompleted, false);
  await f.store.save({ openaiApiKey: 'synthetic-migrated-provider-key' });
  const previous = JSON.parse(await readFile(f.path, 'utf8'));
  const encrypted = { ...previous.secrets };
  previous.version = 1;
  previous.model = 'synthetic-existing-deployment-model';
  delete previous.keyMetadata;
  delete previous.onboardingCompleted;
  await writeFile(f.path, JSON.stringify(previous));
  const store = f.reopen();
  const migrated = await store.get();
  assert.equal(migrated.onboardingCompleted, true);
  assert.equal(migrated.model, previous.model);
  assert.ok(migrated.models.openai.some(({ id }) => id === previous.model));
  assert.deepEqual(migrated.keys.openaiApiKey, {
    suffix: null,
    source: 'saved',
    updatedAt: null,
  });
  assert.deepEqual(JSON.parse(await readFile(f.path, 'utf8')).secrets, encrypted);
  await store.save({ model: previous.model, theme: 'light' });
  assert.equal((await store.environment()).LLM_MODEL, previous.model);
  assert.equal(await store.revealKey('openaiApiKey'), 'synthetic-migrated-provider-key');
  await assert.rejects(store.save({ model: 'synthetic-unconfigured-model' }), /available model/);
});

test('provider selection uses its recommended model and only engine changes advance its revision', async (t) => {
  const f = await fixture(t);
  const initial = await f.store.get();
  assert.equal((await f.store.environment()).LLM_MODEL, initial.models.openai[0].id);
  const revision = await f.store.revision();
  await f.store.save({ provider: 'anthropic' });
  assert.equal(await f.store.revision(), revision + 1);
  const anthropic = await f.store.get();
  assert.equal((await f.store.environment()).LLM_MODEL, anthropic.models.anthropic[0].id);
  await f.store.save({ model: anthropic.models.anthropic[0].id });
  await f.store.save({ model: '', notifications: true });
  assert.equal(await f.store.revision(), revision + 1);
  await f.store.save({ anthropicApiKey: 'synthetic-anthropic-model-key' });
  assert.equal(await f.store.revision(), revision + 2);
  await f.store.save({ provider: 'openai' });
  assert.equal((await f.store.environment()).LLM_MODEL, initial.models.openai[0].id);
});

test('engine preload exposes preferences without provider-secret capabilities or IPC event objects', async () => {
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
    'getSettings',
    'saveSettings',
    'getAppPreferences',
    'saveAppPreferences',
    'prepare',
    'importRuntime',
  ])
    assert.equal(bridge[field], undefined);
  bridge.getPreferences();
  bridge.setTheme('dark');
  bridge.openSettings('providers');
  const ownerId = randomUUID();
  const threadId = randomUUID();
  const position = { createdAt: '2026-10-02T10:00:00.000Z', messageIds: [randomUUID()] };
  bridge.getChatReadCursor(ownerId, threadId);
  bridge.setChatReadCursor(ownerId, threadId, position);
  assert.deepEqual(calls, [
    ['otto:preferences:get'],
    ['otto:preferences:theme', 'dark'],
    ['otto:settings:open', 'providers'],
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

test('provider validation sends keys only to the intended provider and refuses redirects', async () => {
  const key = 'synthetic-validation-key';
  for (const provider of ['openai', 'anthropic']) {
    let calls = 0;
    await validateProviderKey(provider, key, undefined, async (url, options) => {
      calls++;
      assert.equal(
        url,
        provider === 'openai'
          ? 'https://api.openai.com/v1/models'
          : 'https://api.anthropic.com/v1/models',
      );
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), provider === 'openai' ? `Bearer ${key}` : null);
      assert.equal(headers.get('x-api-key'), provider === 'anthropic' ? key : null);
      assert.equal(options.body, undefined);
      return Response.json({ data: [] });
    });
    assert.equal(calls, 1);
  }
});

test('provider validation errors never return response bodies or transport secrets', async () => {
  const secret = 'synthetic-private-provider-key';
  for (const provider of ['openai', 'anthropic']) {
    for (const send of [
      async () => new Response(`Rejected ${secret}`, { status: 401 }),
      async () => new Response(`Private quota data ${secret}`, { status: 429 }),
      async () => {
        throw new Error(`Transport exposed ${secret}`);
      },
    ])
      await assert.rejects(validateProviderKey(provider, secret, undefined, send), (error) => {
        assert.ok(error instanceof Error);
        assert.ok(!error.message.includes(secret));
        assert.ok(!error.message.includes('Private quota data'));
        assert.ok(!error.message.includes('Transport exposed'));
        return true;
      });
  }
});

test('OpenAI model-listing permission errors can validate restricted keys without accepting other failures', async () => {
  const key = 'synthetic-restricted-provider-key';
  const message =
    'You have insufficient permissions for this operation. Missing scopes: api.model.read. Check your key permissions.';
  for (const body of [{ error: message }, { error: { message } }]) {
    await validateProviderKey('openai', key, undefined, async () =>
      Response.json(body, { status: 403 }),
    );
    for (const [provider, status] of [
      ['anthropic', 403],
      ['openai', 401],
    ])
      await assert.rejects(
        validateProviderKey(provider, key, undefined, async () => Response.json(body, { status })),
        /did not accept this key or its model permissions/,
      );
  }
  for (const body of [
    JSON.stringify({ error: { message: `Permission denied for ${key}.` } }),
    JSON.stringify({ error: { message: 'Missing scopes: api.responses.write.' } }),
    JSON.stringify({ error: { message: 'Missing scopes: api.model.read, api.responses.write.' } }),
    JSON.stringify({ error: { message: null } }),
    JSON.stringify({ error: { message }, padding: 'x'.repeat(4096) }),
    `{"error":"${message}`,
    '',
  ])
    await assert.rejects(
      validateProviderKey(
        'openai',
        key,
        undefined,
        async () => new Response(body, { status: 403 }),
      ),
      (error) => {
        assert.match(error.message, /did not accept this key or its model permissions/);
        assert.ok(!error.message.includes(key));
        assert.ok(!error.message.includes(message));
        return true;
      },
    );
});

test('oversized model-listing permission responses are cancelled before acceptance', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(' '.repeat(4097)));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    validateProviderKey(
      'openai',
      'synthetic-restricted-provider-key',
      undefined,
      async () => new Response(body, { status: 403 }),
    ),
    /did not accept this key or its model permissions/,
  );
  assert.equal(cancelled, true);
});

test('a failed replacement with a provider permission response preserves working encrypted settings', async (t) => {
  const f = await fixture(t, (provider, key, model) =>
    validateProviderKey(provider, key, model, async () =>
      key === 'synthetic-working-key'
        ? Response.json({ object: 'model', id: model })
        : Response.json(
            { error: { message: `Missing scopes: api.responses.write. ${key}` } },
            { status: 403 },
          ),
    ),
  );
  await f.store.save({ openaiApiKey: 'synthetic-working-key' });
  const previous = await readFile(f.path, 'utf8');
  await assert.rejects(
    f.store.save({ openaiApiKey: 'synthetic-rejected-key' }),
    /did not accept this key or its model permissions/,
  );
  assert.equal(await readFile(f.path, 'utf8'), previous);
  assert.equal((await f.reopen().environment()).OPENAI_API_KEY, 'synthetic-working-key');
});

test('model validation reads only the selected provider model and accepts resolved Anthropic aliases', async () => {
  for (const [provider, model, response] of [
    ['openai', 'synthetic-model', { object: 'model', id: 'synthetic-model' }],
    ['anthropic', 'synthetic-alias', { type: 'model', id: 'synthetic-model-20260101' }],
  ]) {
    let requests = 0;
    await validateProviderKey(
      provider,
      'synthetic-model-access-key',
      model,
      async (url, options) => {
        requests++;
        assert.equal(
          url,
          `https://api.${provider === 'openai' ? 'openai' : 'anthropic'}.com/v1/models/${model}`,
        );
        assert.equal(options.method, 'GET');
        assert.equal(options.body, undefined);
        assert.equal(options.redirect, 'error');
        return Response.json(response);
      },
    );
    assert.equal(requests, 1);
  }
  await validateProviderKey('openai', 'synthetic-restricted-key', 'synthetic-model', async () =>
    Response.json({ error: { message: 'Missing scopes: api.model.read.' } }, { status: 403 }),
  );
  await validateProviderKey(
    'openai',
    'synthetic-encoded-key',
    'synthetic/model?scope=x',
    async (url) => {
      assert.equal(url, 'https://api.openai.com/v1/models/synthetic%2Fmodel%3Fscope%3Dx');
      return Response.json({ object: 'model', id: 'synthetic/model?scope=x' });
    },
  );
});

test('unavailable or malformed model responses never validate a key or expose provider payloads', async () => {
  const secret = 'synthetic-model-access-key';
  for (const provider of ['openai', 'anthropic']) {
    for (const response of [
      new Response(`Private model account ${secret}`, { status: 404 }),
      Response.json({ data: [{ id: 'synthetic-model' }] }),
      Response.json({ object: 'unrelated', type: 'unrelated', id: 'synthetic-model' }),
      new Response(`Invalid model payload ${secret}`),
      Response.json({
        object: 'model',
        type: 'model',
        id: 'synthetic-model',
        data: 'x'.repeat(65536),
      }),
    ])
      await assert.rejects(
        validateProviderKey(provider, secret, 'synthetic-model', async () => response),
        (error) => {
          assert.ok(!error.message.includes(secret));
          assert.ok(!error.message.includes('Private model account'));
          assert.ok(error.message.length < 250);
          return true;
        },
      );
  }
  await assert.rejects(
    validateProviderKey('openai', secret, 'synthetic-model', async () =>
      Response.json({ object: 'model', id: 'different-model' }),
    ),
  );
});

test('model access failures preserve provider selection, working keys, and pending removals', async (t) => {
  const requests = [];
  const f = await fixture(t, (provider, key, model) => {
    requests.push({ provider, key, model });
    return validateProviderKey(provider, key, model, async () =>
      (provider === 'anthropic' && model) || key === 'synthetic-unavailable-key'
        ? Response.json({ error: `Unavailable ${key}` }, { status: 404 })
        : model
          ? Response.json({ object: 'model', id: model })
          : Response.json({ data: [] }),
    );
  });
  await f.store.save({
    openaiApiKey: 'synthetic-active-key',
    anthropicApiKey: 'synthetic-unused-key',
    composioApiKey: 'synthetic-apps-key',
  });
  const before = await readFile(f.path, 'utf8');
  const vaultKey = (await f.store.environment()).OTTO_VAULT_KEY;
  await assert.rejects(f.store.save({ provider: 'anthropic', composioApiKey: null }));
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await f.reopen().get()).provider, 'openai');
  assert.equal((await f.reopen().environment()).COMPOSIO_API_KEY, 'synthetic-apps-key');
  assert.equal(requests.at(-1).key, 'synthetic-unused-key');
  assert.equal(requests.at(-1).model, (await f.store.get()).models.anthropic[0].id);
  await assert.rejects(
    f.store.save({ openaiApiKey: 'synthetic-unavailable-key', composioApiKey: null }),
  );
  assert.equal(await readFile(f.path, 'utf8'), before);
  assert.equal((await f.reopen().environment()).OPENAI_API_KEY, 'synthetic-active-key');
  const checked = requests.length;
  await f.store.save({ notifications: true, composioApiKey: null });
  assert.equal(requests.length, checked);
  assert.equal((await f.reopen().environment()).COMPOSIO_API_KEY, '');
  assert.equal((await f.reopen().environment()).OTTO_VAULT_KEY, vaultKey);
});

async function setupRenderer(
  t,
  mode = 'settings',
  initialStatus = { phase: 'ready' },
  savedStore,
  configure = () => {},
) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(await readFile(new URL('../ui/index.html', import.meta.url), 'utf8'), {
    url: `https://otto-settings.test/?mode=${mode}&section=providers`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  t.after(() => dom.window.close());
  const settings = savedStore
    ? await savedStore.get()
    : {
        provider: 'openai',
        model: '',
        theme: 'light',
        hasOpenAIKey: true,
        launchAtLogin: false,
        notifications: false,
        keys: { openaiApiKey: { suffix: 'test', source: 'manual' } },
      };
  const preferences = () => ({
    theme: settings.theme,
    resolvedTheme: settings.theme === 'dark' ? 'dark' : 'light',
    launchAtLogin: settings.launchAtLogin,
    notifications: settings.notifications,
  });
  const saves = [];
  const appPreferenceSaves = [];
  const appPreferences = {
    locale: null,
    timeZone: null,
    hourCycle: 'auto',
    quietHoursEnabled: true,
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  const callbacks = {};
  const desktop = {
    getSettings: async () => structuredClone(settings),
    getPreferences: async () => preferences(),
    status: async () => initialStatus,
    importRuntime: async () => {},
    prepare: async () => ({ phase: 'ready' }),
    onStatus: (callback) => (callbacks.status = callback),
    warmRuntime: async () => initialStatus,
    replayOnboarding: async () =>
      callbacks.navigate?.({ mode: 'onboarding', section: 'providers', reset: true }),
    getAppPreferences: async () => ({
      preferences: structuredClone(appPreferences),
      pending: true,
    }),
    saveAppPreferences: async (input) => {
      appPreferenceSaves.push(structuredClone(input));
      Object.assign(appPreferences, input);
      return { preferences: structuredClone(appPreferences), pending: true };
    },
    onPreferences: (callback) => (callbacks.preferences = callback),
    onNavigate: (callback) => (callbacks.navigate = callback),
    openExternal: async () => {},
    openAppPreferences: async () => {},
    saveSettings: async (input) => {
      saves.push(structuredClone(input));
      if (savedStore) {
        Object.assign(settings, await savedStore.save(structuredClone(input)));
        return structuredClone(settings);
      }
      for (const key of [
        'provider',
        'model',
        'theme',
        'launchAtLogin',
        'notifications',
        'onboardingCompleted',
      ])
        if (input[key] !== undefined) settings[key] = input[key];
      return structuredClone(settings);
    },
  };
  let focused = true;
  dom.window.document.hasFocus = () => focused;
  dom.window.matchMedia = () => ({ matches: false });
  dom.window.ottoDesktop = desktop;
  const setupSource = await readFile(new URL('../ui/setup.js', import.meta.url), 'utf8');
  const preferencesSource = await readFile(
    new URL('../ui/preferences.js', import.meta.url),
    'utf8',
  );
  configure(dom.window);
  dom.window.eval(setupSource);
  dom.window.eval(preferencesSource);
  const settle = () => new Promise(setImmediate);
  await settle();
  return {
    window: dom.window,
    document: dom.window.document,
    desktop,
    callbacks,
    settings,
    saves,
    appPreferences,
    appPreferenceSaves,
    preferences,
    settle,
    async waitFor(predicate) {
      const deadline = Date.now() + 5000;
      while (!predicate() && Date.now() < deadline) await settle();
      assert.ok(predicate());
    },
    focus(value) {
      focused = value;
      dom.window.dispatchEvent(new dom.window.Event(value ? 'focus' : 'blur'));
    },
    async submit() {
      dom.window.document
        .getElementById('settings-form')
        .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
    },
  };
}

test('provider key reveals are fenced after blur or navigation and can be requested again', async (t) => {
  const f = await setupRenderer(t);
  const secret = 'synthetic-revealed-provider-key';
  let resolve;
  f.desktop.revealKey = () => new Promise((done) => (resolve = done));
  const input = f.document.getElementById('openaiApiKey');
  const eye = f.document.querySelector('#provider-key-field .key-action');
  eye.click();
  assert.equal(eye.disabled, true);
  f.focus(false);
  resolve(secret);
  await f.settle();
  assert.ok(!input.value.includes(secret));
  assert.equal(eye.disabled, false);

  f.focus(true);
  eye.click();
  resolve(secret);
  await f.settle();
  assert.equal(input.value, secret);
  f.focus(false);
  assert.ok(!input.value.includes(secret));

  f.focus(true);
  eye.click();
  f.callbacks.navigate({ mode: 'settings', section: 'general' });
  resolve(secret);
  await f.settle();
  assert.ok(!input.value.includes(secret));
  assert.equal(eye.disabled, false);
  assert.ok(!f.document.body.textContent.includes(secret));
});

test('key removal stays staged and cancellable while failed replacements preserve saved secrets', async (t) => {
  const storage = await fixture(t, async (_provider, key) => {
    if (key === 'synthetic-rejected-key') throw new Error('Provider rejected replacement.');
  });
  await storage.store.save({
    openaiApiKey: 'synthetic-working-key',
    composioApiKey: 'synthetic-apps-key',
  });
  const previous = await readFile(storage.path, 'utf8');
  const f = await setupRenderer(t, 'settings', { phase: 'ready' }, storage.store);
  const action = (field, label) =>
    [...f.document.getElementById(field).parentElement.querySelectorAll('button')].find(
      (button) => button.textContent === label,
    );
  action('composioApiKey', 'Change').click();
  action('composioApiKey', 'Remove').click();
  assert.equal(f.saves.length, 0);
  assert.equal(await readFile(storage.path, 'utf8'), previous);
  action('composioApiKey', 'Cancel').click();
  assert.equal(f.document.getElementById('continue').disabled, true);
  assert.equal((await storage.reopen().get()).hasComposioKey, true);
  action('composioApiKey', 'Change').click();
  action('composioApiKey', 'Remove').click();
  action('openaiApiKey', 'Change').click();
  assert.equal(action('openaiApiKey', 'Remove').hidden, true);
  const replacement = f.document.getElementById('openaiApiKey');
  replacement.value = 'synthetic-rejected-key';
  replacement.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await f.submit();
  await f.waitFor(() => !f.document.getElementById('error').hidden);
  assert.equal(await readFile(storage.path, 'utf8'), previous);
  assert.equal(replacement.type, 'password');
  action('openaiApiKey', 'Cancel').click();
  await f.submit();
  await f.waitFor(() => f.document.getElementById('settings-form').hidden);
  assert.deepEqual(f.saves.at(-1), { provider: 'openai', composioApiKey: null });
  const reopened = await storage.reopen().environment();
  assert.equal(reopened.OPENAI_API_KEY, 'synthetic-working-key');
  assert.equal(reopened.COMPOSIO_API_KEY, '');
});

test('removing an unused provider key preserves the active provider and vault across reopen', async (t) => {
  const storage = await fixture(t);
  await storage.store.save({
    openaiApiKey: 'synthetic-active-key',
    anthropicApiKey: 'synthetic-unused-key',
    composioApiKey: 'synthetic-apps-key',
  });
  const previous = await storage.store.environment();
  const f = await setupRenderer(t, 'settings', { phase: 'ready' }, storage.store);
  const radio = f.document.querySelector('input[name="provider"][value="anthropic"]');
  radio.checked = true;
  radio.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  const controls = f.document.getElementById('anthropicApiKey').parentElement;
  const action = (label) =>
    [...controls.querySelectorAll('button')].find((button) => button.textContent === label);
  action('Change').click();
  assert.equal(action('Remove').hidden, false);
  action('Remove').click();
  assert.equal((await storage.reopen().get()).hasAnthropicKey, true);
  await f.submit();
  await f.waitFor(() => f.document.getElementById('settings-form').hidden);
  assert.deepEqual(f.saves.at(-1), { provider: 'openai', anthropicApiKey: null });
  const saved = await storage.reopen().get();
  const environment = await storage.reopen().environment();
  assert.equal(saved.provider, 'openai');
  assert.equal(saved.hasAnthropicKey, false);
  assert.equal(environment.ANTHROPIC_API_KEY, '');
  assert.equal(environment.OPENAI_API_KEY, previous.OPENAI_API_KEY);
  assert.equal(environment.COMPOSIO_API_KEY, previous.COMPOSIO_API_KEY);
  assert.equal(environment.OTTO_VAULT_KEY, previous.OTTO_VAULT_KEY);
  assert.equal(f.document.querySelector('input[name="provider"]:checked').value, 'openai');
});

test('Settings section navigation preserves keyboard focus on the activated control', async (t) => {
  const f = await setupRenderer(t);
  for (const section of ['general', 'preferences', 'providers']) {
    const control = f.document.querySelector(`[data-section="${section}"]`);
    control.focus();
    control.click();
    await f.settle();
    assert.equal(f.document.getElementById(`${section}-panel`).hidden, false);
    assert.equal(f.document.activeElement, control);
  }
});

test('onboarding retains startup choices across native updates and back navigation', async (t) => {
  const f = await setupRenderer(t, 'onboarding');
  await f.submit();
  for (const id of ['launch-at-login', 'notifications']) {
    const control = f.document.getElementById(id);
    control.checked = true;
    control.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  }
  await f.settle();
  f.callbacks.preferences({ ...f.preferences(), resolvedTheme: 'dark' });
  assert.equal(f.document.getElementById('launch-at-login').checked, true);
  assert.equal(f.document.getElementById('notifications').checked, true);
  f.document.getElementById('back').click();
  await f.submit();
  assert.equal(f.document.getElementById('launch-at-login').checked, true);
  assert.equal(f.document.getElementById('notifications').checked, true);
  await f.submit();
  assert.deepEqual(f.saves.at(-1), {
    launchAtLogin: true,
    notifications: true,
    onboardingCompleted: true,
  });
});

test('background runtime updates preserve the current wizard step and unsaved provider draft', async (t) => {
  const f = await setupRenderer(t, 'onboarding', { phase: 'idle' });
  const input = f.document.getElementById('openaiApiKey');
  const draft = 'synthetic-incomplete-provider-draft';
  input.value = draft;
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  for (const phase of ['preparing', 'error', 'ready']) {
    f.callbacks.status({ phase: 'idle', runtime: { phase, message: 'Synthetic runtime status' } });
    f.callbacks.navigate({ mode: 'onboarding', section: 'general', reset: false });
    assert.equal(f.document.getElementById('providers-panel').hidden, false);
    assert.equal(f.document.getElementById('preparation').hidden, true);
    assert.equal(input.value, draft);
  }
  await f.submit();
  assert.equal(f.document.getElementById('general-panel').hidden, false);
  f.callbacks.navigate({ mode: 'onboarding', section: 'providers', reset: false });
  f.callbacks.status({ phase: 'idle', runtime: { phase: 'ready', message: 'Ready' } });
  assert.equal(f.document.getElementById('general-panel').hidden, false);
  assert.equal(f.document.getElementById('preparation').hidden, true);
  assert.equal(f.settings.onboardingCompleted, undefined);
  assert.equal(f.saves[0].openaiApiKey, draft);
});

test('onboarding waits for detected defaults to persist before completion and can retry', async (t) => {
  const f = await setupRenderer(t, 'onboarding', { phase: 'idle' });
  await f.submit();
  const saved = f.desktop.saveAppPreferences;
  f.desktop.saveAppPreferences = async () => {
    throw new Error('Synthetic disk failure');
  };
  await f.submit();
  assert.equal(f.document.getElementById('general-panel').hidden, false);
  assert.equal(f.document.getElementById('preferences-panel').hidden, true);
  assert.equal(f.document.getElementById('preparation').hidden, true);
  assert.ok(!f.saves.some((value) => value.onboardingCompleted));
  const gate = deferred();
  const submitted = deferred();
  f.desktop.saveAppPreferences = async (patch) => {
    submitted.resolve(patch);
    await gate.promise;
    return saved(patch);
  };
  await f.submit();
  const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  assert.deepEqual(structuredClone(await submitted.promise), { timeZone: zone });
  assert.equal(f.document.getElementById('preparation').hidden, true);
  assert.ok(!f.saves.some((value) => value.onboardingCompleted));
  gate.resolve();
  for (let attempt = 0; attempt < 10 && f.document.getElementById('preparation').hidden; attempt++)
    await f.settle();
  assert.equal(f.document.getElementById('preparation').hidden, false);
  assert.equal(f.appPreferences.timeZone, zone);
  assert.equal(f.saves.at(-1).onboardingCompleted, true);
});

test('onboarding preserves configured appearance and date preferences without asking again', async (t) => {
  const f = await setupRenderer(t, 'onboarding', { phase: 'idle' });
  f.settings.theme = 'dark';
  Object.assign(f.appPreferences, {
    locale: 'en-PT',
    timeZone: 'Asia/Tokyo',
    hourCycle: 'h23',
    quietHoursEnabled: false,
    quietStart: '21:30',
    quietEnd: '06:15',
  });
  const before = structuredClone(f.appPreferences);
  await f.submit();
  assert.equal(f.document.getElementById('general-panel').hidden, false);
  assert.equal(f.document.getElementById('preferences-panel').hidden, true);
  assert.equal(f.document.getElementById('appearance-section').hidden, true);
  await f.submit();
  assert.deepEqual(f.appPreferences, before);
  assert.deepEqual(f.appPreferenceSaves, []);
  assert.equal(f.settings.theme, 'dark');
  assert.ok(!f.saves.some((value) => 'theme' in value));
  assert.equal(f.saves.at(-1).onboardingCompleted, true);
});

test('onboarding waits for the initial preferences read before filling only an unset time zone', async (t) => {
  const f = await setupRenderer(t, 'onboarding', { phase: 'idle' });
  const gate = deferred();
  const read = f.desktop.getAppPreferences;
  f.desktop.getAppPreferences = async () => {
    await gate.promise;
    return read();
  };
  await f.submit();
  await f.submit();
  assert.equal(f.document.getElementById('general-panel').hidden, false);
  assert.equal(f.document.getElementById('preparation').hidden, true);
  assert.equal(f.document.getElementById('continue').disabled, true);
  assert.ok(!f.saves.some((value) => value.onboardingCompleted));
  gate.resolve();
  for (let attempt = 0; attempt < 10 && f.document.getElementById('preparation').hidden; attempt++)
    await f.settle();
  assert.equal(f.document.getElementById('preparation').hidden, false);
  assert.deepEqual(f.appPreferenceSaves, [
    {
      timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    },
  ]);
  assert.equal(f.appPreferences.locale, null);
  assert.equal(f.appPreferences.hourCycle, 'auto');
  assert.equal(f.appPreferences.quietHoursEnabled, true);
});

test('disabling quiet hours in Settings clears invalid hidden times without losing earlier choices', async (t) => {
  const f = await setupRenderer(t);
  f.callbacks.navigate({ mode: 'settings', section: 'preferences' });
  await f.settle();
  const start = f.document.getElementById('preference-quiet-start');
  start.value = '';
  start.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await assert.rejects(f.window.ottoPreferencesForm.flush());
  const enabled = f.document.getElementById('preference-quiet-hours');
  enabled.checked = false;
  enabled.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await f.settle();
  await f.window.ottoPreferencesForm.flush();
  assert.equal(f.appPreferences.quietHoursEnabled, false);
  assert.equal(f.appPreferences.quietStart, '22:00');
  assert.equal(f.appPreferences.quietEnd, '08:00');
});

test('an online preference save failure retains the edit and surfaces retry until synchronization succeeds', async (t) => {
  const storage = await preferencesFixture(t);
  storage.state.online = true;
  const f = await setupRenderer(t);
  f.desktop.getAppPreferences = storage.store.get;
  f.desktop.saveAppPreferences = storage.store.save;
  f.callbacks.navigate({ mode: 'settings', section: 'preferences' });
  const clock = f.document.getElementById('preference-clock');
  await f.waitFor(() => clock.value === 'h23');
  storage.state.fail = true;
  clock.value = 'h12';
  clock.dispatchEvent(new f.window.Event('change', { bubbles: true }));
  await f.waitFor(() => !f.document.getElementById('preferences-error').hidden);
  assert.equal(clock.value, 'h12');
  assert.equal(storage.state.server.hourCycle, 'h23');
  assert.deepEqual(JSON.parse(await readFile(storage.path, 'utf8')).pending, { hourCycle: 'h12' });
  await assert.rejects(f.window.ottoPreferencesForm.flush());
  storage.state.fail = false;
  f.window.dispatchEvent(new f.window.Event('otto:preferences-open'));
  await f.waitFor(() => storage.state.server.hourCycle === 'h12');
  await f.window.ottoPreferencesForm.flush();
  assert.equal(f.document.getElementById('preferences-error').hidden, true);
  assert.deepEqual(JSON.parse(await readFile(storage.path, 'utf8')).pending, {});
});

test('native timezone detection stays lazy and cached while covering regions outside the presets', async (t) => {
  for (const [timeZone, region] of [
    ['Asia/Singapore', 'SG'],
    ['Asia/Manila', 'PH'],
    ['Asia/Dubai', 'AE'],
  ]) {
    const formatted = [];
    let regionLookups = 0;
    const f = await setupRenderer(t, 'settings', { phase: 'ready' }, undefined, (window) => {
      const DateTimeFormat = window.Intl.DateTimeFormat;
      window.Intl.Locale = new Proxy(window.Intl.Locale, {
        construct(target, args) {
          if (args[0].startsWith('und-')) regionLookups++;
          return Reflect.construct(target, args);
        },
      });
      window.Intl.DateTimeFormat = function (locale, options) {
        if (options?.weekday) formatted.push(locale);
        return new DateTimeFormat(locale ?? 'en-GB', options ?? { timeZone });
      };
      Object.defineProperty(window.navigator, 'languages', { value: ['en-GB'] });
      Object.defineProperty(window.navigator, 'language', { value: 'en-GB' });
    });
    assert.equal(regionLookups, 0);
    f.callbacks.navigate({ mode: 'settings', section: 'preferences' });
    await f.waitFor(() => formatted.length > 0);
    assert.equal(formatted.at(-1), `en-${region}`, timeZone);
    await f.window.ottoPreferencesForm.flush({ useCurrentTimeZone: true });
    assert.equal(f.appPreferences.timeZone, timeZone);
    const initialLookups = regionLookups;
    assert.ok(initialLookups > 0);
    f.window.dispatchEvent(new f.window.Event('otto:preferences-open'));
    await f.window.ottoPreferencesForm.flush();
    await f.settle();
    assert.equal(regionLookups, initialLookups);
  }
});

test(
  'onboarding notification consent persists before completion and rolls back a failed change',
  { timeout: 10_000 },
  async (t) => {
    const storage = await fixture(t);
    await storage.store.save({ openaiApiKey: 'synthetic-notification-consent-key' });
    const f = await setupRenderer(t, 'onboarding', { phase: 'idle' }, storage.store);
    await f.submit();
    await f.waitFor(
      () =>
        !f.document.getElementById('general-panel').hidden &&
        !f.document.getElementById('notifications').disabled,
    );
    const gate = deferred();
    const submitted = deferred();
    const saved = f.desktop.saveSettings;
    f.desktop.saveSettings = async (input) => {
      submitted.resolve(input);
      await gate.promise;
      return saved(input);
    };
    const notifications = f.document.getElementById('notifications');
    notifications.checked = true;
    notifications.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    assert.deepEqual(structuredClone(await submitted.promise), { notifications: true });
    assert.equal(notifications.disabled, true);
    assert.equal((await storage.reopen().get()).notifications, false);
    gate.resolve();
    await f.waitFor(() => !notifications.disabled);
    const committed = await storage.reopen().get();
    assert.equal(committed.notifications, true);
    assert.equal(committed.onboardingCompleted, false);
    assert.equal(committed.launchAtLogin, false);
    f.desktop.saveSettings = async () => {
      throw new Error('Synthetic disk failure');
    };
    notifications.checked = false;
    notifications.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    await f.settle();
    assert.equal(notifications.checked, true);
    assert.equal((await storage.reopen().get()).notifications, true);
    assert.equal(f.document.getElementById('error').hidden, false);
    f.desktop.saveSettings = saved;
    notifications.checked = false;
    notifications.dispatchEvent(new f.window.Event('change', { bubbles: true }));
    await f.waitFor(() => !notifications.disabled);
    assert.equal((await storage.reopen().get()).notifications, false);
    assert.ok(!f.saves.some((value) => value.onboardingCompleted));
  },
);

test('an early missing-runtime failure retains the native archive recovery action', async (t) => {
  const f = await setupRenderer(t, 'loading', {
    phase: 'error',
    needsRuntimeArchive: true,
    message: 'Runtime required',
  });
  assert.equal(f.document.getElementById('preparation').hidden, false);
  assert.equal(f.document.getElementById('import-runtime').hidden, false);
  let imports = 0;
  f.desktop.importRuntime = async () => {
    imports++;
  };
  f.document.getElementById('import-runtime').click();
  await f.settle();
  assert.equal(imports, 1);
  f.callbacks.navigate({ mode: 'loading', section: 'general' });
  let preparations = 0;
  f.desktop.prepare = async (options) => {
    assert.equal(options.retry, true);
    preparations++;
    return { phase: 'ready' };
  };
  assert.equal(f.document.getElementById('sidebar').hidden, true);
  f.document.getElementById('retry').click();
  await f.settle();
  assert.equal(preparations, 1);
});

async function preferencePersistence(t, edits, expected) {
  const directory = await mkdtemp(join(tmpdir(), 'otto-preferences-renderer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'app-preferences.json');
  const initial = {
    locale: 'en-PT',
    timeZone: 'Europe/Lisbon',
    hourCycle: 'auto',
    quietHoursEnabled: true,
    quietStart: '22:00',
    quietEnd: '08:00',
  };
  await writeFile(path, JSON.stringify({ version: 1, cached: initial, pending: {} }));
  let online = false;
  let server = structuredClone(initial);
  let release;
  const delayed = new Promise((resolve) => (release = resolve));
  let started;
  const requestStarted = new Promise((resolve) => (started = resolve));
  let first = true;
  const store = createAppPreferencesStore(path, {
    isReady: () => online,
    async request(target, options) {
      assert.equal(target, '/api/preferences');
      if (options.method === 'GET' && first) {
        first = false;
        started();
        await delayed;
      }
      if (options.method === 'PATCH') server = { ...server, ...JSON.parse(options.body) };
      return Response.json(server);
    },
  });
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(await readFile(new URL('../ui/index.html', import.meta.url), 'utf8'), {
    url: 'https://otto-settings.test/?mode=settings&section=preferences',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  let alive = true;
  const close = () => {
    alive = false;
    dom.window.close();
  };
  t.after(() => {
    close();
    release();
  });
  const submissions = [];
  const operations = [];
  dom.window.ottoDesktop = {
    getAppPreferences: () => store.get(),
    saveAppPreferences(patch) {
      submissions.push(structuredClone(patch));
      const operation = store.save(structuredClone(patch));
      operations.push(operation);
      return new Promise((resolve, reject) => {
        operation.then(
          (result) => {
            if (alive) resolve(structuredClone(result));
          },
          (error) => {
            if (alive) reject(error);
          },
        );
      });
    },
  };
  dom.window.eval(await readFile(new URL('../ui/preferences.js', import.meta.url), 'utf8'));
  dom.window.dispatchEvent(new dom.window.Event('otto:preferences-open'));
  await store.get();
  await new Promise(setImmediate);
  online = true;
  function change([id, value]) {
    const control = dom.window.document.getElementById(id);
    assert.equal(control.disabled, false);
    if (control.type === 'checkbox') control.checked = value;
    else control.value = value;
    control.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  }
  change(edits[0]);
  await requestStarted;
  for (const edit of edits.slice(1)) change(edit);
  const submittedBeforeClose = structuredClone(submissions);
  close();
  release();
  await Promise.all(operations);
  const reopened = createAppPreferencesStore(path, {
    isReady: () => false,
    request: async () => {
      assert.fail('An offline reopen must read the durable file.');
    },
  });
  const result = await reopened.get();
  assert.deepEqual(
    {
      queuedPreferences: Object.assign({}, initial, ...submittedBeforeClose),
      preferences: result.preferences,
    },
    {
      queuedPreferences: { ...initial, ...expected },
      preferences: { ...initial, ...expected },
    },
  );
}

test('preference edits survive closing Settings during a slow online save', async (t) => {
  for (let repeat = 1; repeat <= 3; repeat++)
    await t.test(`PERSIST-01.v1 repetition ${repeat}`, { timeout: 10_000 }, async (t) => {
      await preferencePersistence(
        t,
        [
          ['preference-region', 'GB'],
          ['preference-clock', 'h23'],
        ],
        { locale: 'en-GB', hourCycle: 'h23' },
      );
    });
});

test('independent preference controls survive closing Settings during a slow save', async (t) => {
  for (let repeat = 1; repeat <= 3; repeat++)
    await t.test(`PERSIST-HOLDOUT-01.v1 repetition ${repeat}`, { timeout: 10_000 }, async (t) => {
      await preferencePersistence(
        t,
        [
          ['preference-quiet-hours', false],
          ['preference-time-zone', 'Asia/Tokyo'],
        ],
        { quietHoursEnabled: false, timeZone: 'Asia/Tokyo' },
      );
    });
});

test('empty-key onboarding validates the provider and commits preferences before preparing', async (t) => {
  for (const [variant, provider, launchAtLogin, notifications] of [
    ['base', 'openai', true, false],
    ['holdout', 'anthropic', false, true],
  ])
    await t.test(`U03H.v1 ${variant}`, { timeout: 10_000 }, async (t) => {
      const storage = await fixture(t);
      const f = await setupRenderer(t, 'onboarding', { phase: 'idle' }, storage.store);
      let preparations = 0;
      f.desktop.prepare = async () => {
        const committed = await storage.reopen().get();
        assert.equal(committed.onboardingCompleted, true);
        assert.equal(committed.launchAtLogin, launchAtLogin);
        assert.equal(committed.notifications, notifications);
        preparations++;
        return { phase: 'ready' };
      };
      const waitUntil = async (predicate) => {
        const deadline = Date.now() + 5000;
        while (!predicate() && Date.now() < deadline) await f.settle();
        assert.ok(predicate());
      };
      const radio = f.document.querySelector(`input[name="provider"][value="${provider}"]`);
      radio.checked = true;
      radio.dispatchEvent(new f.window.Event('change', { bubbles: true }));
      const field = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey';
      const other = provider === 'openai' ? 'anthropicApiKey' : 'openaiApiKey';
      const input = f.document.getElementById(field);
      for (const value of ['', '   ']) {
        input.value = value;
        input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
        await f.submit();
        assert.equal(f.saves.length, 0);
        assert.equal(preparations, 0);
        assert.equal(f.document.getElementById('providers-panel').hidden, false);
        assert.equal(f.document.getElementById('general-panel').hidden, true);
      }
      const key = `synthetic-onboarding-${provider}-key`;
      input.value = key;
      input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
      await f.submit();
      await waitUntil(() => !f.document.getElementById('general-panel').hidden);
      assert.deepEqual(f.saves[0], { provider, [field]: key });
      assert.equal(preparations, 0);
      assert.equal(await storage.store.revealKey(field), key);
      assert.equal(await storage.store.revealKey(other), '');
      for (const [id, value] of [
        ['launch-at-login', launchAtLogin],
        ['notifications', notifications],
      ]) {
        const control = f.document.getElementById(id);
        control.checked = value;
        control.dispatchEvent(new f.window.Event('change', { bubbles: true }));
      }
      await waitUntil(() => !f.document.getElementById('notifications').disabled);
      f.callbacks.preferences({ ...f.preferences(), resolvedTheme: 'dark' });
      f.document.getElementById('back').click();
      await f.submit();
      await waitUntil(() => !f.document.getElementById('general-panel').hidden);
      assert.equal(f.document.getElementById('launch-at-login').checked, launchAtLogin);
      assert.equal(f.document.getElementById('notifications').checked, notifications);
      await f.submit();
      await waitUntil(() => preparations === 1);
      assert.deepEqual(f.saves.at(-1), { launchAtLogin, notifications, onboardingCompleted: true });
      const reopened = storage.reopen();
      assert.equal((await reopened.get()).provider, provider);
      assert.equal(await reopened.revealKey(field), key);
      assert.equal(await reopened.revealKey(other), '');
      assert.ok(!(await readFile(storage.path, 'utf8')).includes(key));
    });
});
