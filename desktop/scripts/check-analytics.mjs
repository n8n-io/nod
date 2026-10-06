import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { completeDesktopSetup, trackDesktopAnalytics } from '../main/analytics.mjs';

const source = fileURLToPath(import.meta.url);
const root = resolve(dirname(source), '../..');

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)('electron');
  const result = await promisify(execFile)(electron, [source], {
    cwd: root,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  process.stdout.write(result.stdout);
} else {
  void checkNativeAnalytics();
}

async function checkNativeAnalytics() {
  const { app, BrowserWindow, session } = await import('electron');
  app.on('window-all-closed', () => {});
  const directory = await mkdtemp(join(tmpdir(), 'otto-native-analytics-'));
  app.setPath('userData', join(directory, 'profile'));
  let failure;
  try {
    const ui = join(directory, 'ui');
    await cp(join(root, 'dist', 'desktop-ui'), ui, { recursive: true });
    const html = await readFile(join(ui, 'index.html'), 'utf8');
    await writeFile(
      join(ui, 'index.html'),
      html.replace(
        '</main>',
        '<p id="private-marker">SYNTHETIC_PRIVATE_INITIAL</p><input id="private-input" value="SYNTHETIC_PRIVATE_INPUT" /></main>',
      ),
    );
    const preload = join(directory, 'preload.cjs');
    await writeFile(
      preload,
      `const { contextBridge } = require('electron');
let attempts = 0;
let onStatus;
const firstSetup = process.argv.includes('--otto-fixture-first-setup');
contextBridge.exposeInMainWorld('ottoDesktop', {
  getAnalyticsConfiguration: async () => ({
    enabled: process.argv.includes('--otto-fixture-enabled'),
    distinctId: 'local:11111111-1111-4111-8111-111111111111',
    deployment: 'local', environment: 'development',
  }),
  getPreferences: async () => ({ theme: 'light', notifications: false, launchAtLogin: false }),
  status: async () => ({ phase: firstSetup ? 'idle' : 'preparing' }),
  saveSettings: async () => ({}),
  prepare: async () => {
    if (firstSetup && ++attempts === 1) throw new Error('Synthetic runtime preparation failure');
    const status = { phase: 'ready' };
    onStatus?.(status);
    onStatus?.(status);
    return status;
  },
  onStatus: (listener) => { onStatus = listener; },
  onPreferences: () => {}, onNavigate: () => {},
});`,
    );
    await app.whenReady();
    for (const { enabled, firstSetup, transport } of [
      { enabled: true, firstSetup: true, transport: 'slow' },
      { enabled: false, firstSetup: true, transport: 'normal' },
      { enabled: true, firstSetup: false, transport: 'normal' },
      { enabled: true, firstSetup: false, transport: 'hung' },
    ]) {
      const partition = `otto-analytics-fixture-${randomUUID()}`;
      const target = session.fromPartition(partition);
      const calls = [];
      const failures = [];
      let completionUploaded = false;
      await target.protocol.handle('http', () => {
        failures.push('Unexpected HTTP request');
        return new Response('', { status: 403 });
      });
      await target.protocol.handle('https', async (request) => {
        const url = new URL(request.url);
        if (!['eu.i.posthog.com', 'eu-assets.i.posthog.com'].includes(url.hostname)) {
          failures.push('Unexpected HTTPS destination');
          return new Response('', { status: 403 });
        }
        const raw = Buffer.from(await request.arrayBuffer());
        const text =
          url.searchParams.get('compression') === 'gzip-js'
            ? gunzipSync(raw).toString()
            : raw.toString();
        const payload = raw.length
          ? JSON.parse(
              text.startsWith('data=')
                ? Buffer.from(new URLSearchParams(text).get('data'), 'base64').toString()
                : text,
            )
          : undefined;
        calls.push({ path: url.pathname, payload });
        if (payload && transport === 'hung') await new Promise(() => {});
        if (
          transport === 'slow' &&
          payload?.batch?.some((event) => event.event === 'otto_desktop_setup_completed')
        ) {
          await new Promise((accept) => setTimeout(accept, 1300));
          assert.equal(window.isDestroyed(), false);
          completionUploaded = true;
        }
        return Response.json(
          url.pathname.endsWith('/config')
            ? {
                hasFeatureFlags: false,
                sessionRecording: { sampleRate: 1, minimumDurationMilliseconds: 0 },
              }
            : { status: 1 },
        );
      });
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          partition,
          additionalArguments: [
            enabled ? '--otto-fixture-enabled' : '--otto-fixture-disabled',
            firstSetup ? '--otto-fixture-first-setup' : '--otto-fixture-returning',
          ],
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      trackDesktopAnalytics(window);
      window.webContents.on('console-message', (event) => {
        if (
          event.level === 'error' &&
          !event.message.includes("'frame-ancestors' is ignored when delivered via a <meta>")
        )
          failures.push(event.message);
      });
      await window.loadFile(join(ui, 'index.html'), {
        query: { mode: firstSetup ? 'onboarding' : 'loading', firstSetup: String(firstSetup) },
      });
      await new Promise((accept) => setTimeout(accept, 1000));
      assert.equal(
        await window.webContents.executeJavaScript(
          "!document.getElementById('continue').disabled && Boolean(window.ottoSetupAnalytics)",
        ),
        true,
      );
      await window.webContents.executeJavaScript(`
document.getElementById('private-marker').textContent = 'SYNTHETIC_PRIVATE_CHANGED';
document.getElementById('private-input').value = 'SYNTHETIC_PRIVATE_CHANGED_INPUT';
document.getElementById('private-input').dispatchEvent(new Event('input', { bubbles: true }));`);
      if (firstSetup)
        await window.webContents.executeJavaScript("document.getElementById('continue').click()");
      await new Promise((accept) => setTimeout(accept, enabled ? 6000 : 1000));
      assert.equal(
        await window.webContents.executeJavaScript("!document.getElementById('retry').hidden"),
        firstSetup,
      );
      assert.equal(
        calls
          .flatMap(({ payload }) => payload?.batch ?? [])
          .filter((event) => event.event === 'otto_desktop_setup_completed').length,
        0,
      );
      if (firstSetup)
        await window.webContents.executeJavaScript(`(async () => {
document.getElementById('retry').click();
await new Promise((accept) => setTimeout(accept, 0));
})()`);
      else await window.webContents.executeJavaScript('window.ottoDesktop.prepare()');
      const closing = Date.now();
      await completeDesktopSetup(window);
      const closeDuration = Date.now() - closing;
      if (transport === 'slow') {
        assert.equal(completionUploaded, true);
        assert.ok(closeDuration >= 1000);
      }
      if (transport === 'hung') assert.ok(closeDuration >= 4900 && closeDuration < 7000);
      if (transport === 'normal') assert.ok(closeDuration < 1000);
      assert.equal(window.isDestroyed(), true);
      await new Promise((accept) => setTimeout(accept, 1000));
      assert.deepEqual(failures, []);
      if (!enabled) {
        assert.deepEqual(calls, []);
        continue;
      }
      const events = calls.flatMap(({ payload }) => payload?.batch ?? []);
      assert.equal(
        events.filter((event) => event.event === 'otto_desktop_setup_completed').length,
        firstSetup ? 1 : 0,
      );
      assert.ok(
        events.some(
          (event) =>
            event.event === 'otto_desktop_setup_step_viewed' && event.properties.step === 'ready',
        ),
      );
      assert.ok(
        events.every(
          (event) =>
            event.properties.distinct_id === 'local:11111111-1111-4111-8111-111111111111' &&
            event.properties.surface === 'desktop' &&
            event.properties.environment === 'development',
        ),
      );
      assert.ok(
        events.some((event) => ['active', 'sampled'].includes(event.properties.$recording_status)),
      );
      const recordings = calls
        .filter(({ path }) => path === '/s/')
        .flatMap(({ payload }) => payload)
        .flatMap((event) => event.properties.$snapshot_data)
        .map(decodeSnapshot);
      assert.ok(recordings.some((event) => event.type === 2));
      assert.ok(recordings.some((event) => event.type === 3));
      const snapshots = JSON.stringify(recordings);
      assert.ok(snapshots.includes('Open at login'));
      assert.ok(!snapshots.includes('SYNTHETIC_PRIVATE'));
      assert.ok(!snapshots.includes(directory));
    }
    await checkSharedSession(BrowserWindow, session, ui, preload);
    console.log(
      'Native analytics: first-time completion, returning startup, shared-session window isolation, bounded slow and stalled upload drains, full and incremental replay, masking, and disabled collection passed. All network requests were intercepted locally.',
    );
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    await rm(directory, { recursive: true, force: true });
    app.exit(failure ? 1 : 0);
  }
}

async function checkSharedSession(BrowserWindow, session, ui, preload) {
  const partition = 'otto-analytics-shared-fixture';
  const target = session.fromPartition(partition);
  const requests = Array.from({ length: 4 }, () => ({
    started: Promise.withResolvers(),
    response: Promise.withResolvers(),
  }));
  const windows = [];
  await target.protocol.handle('http', () => new Response('', { status: 403 }));
  await target.protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    const pending = requests[Number(url.pathname.slice('/fixture/'.length))];
    assert.equal(url.origin, 'https://eu.i.posthog.com');
    assert.ok(url.pathname.startsWith('/fixture/') && pending);
    pending.started.resolve();
    await pending.response.promise;
    return Response.json({ ok: true });
  });
  const createWindow = async () => {
    const window = new BrowserWindow({
      show: false,
      webPreferences: {
        preload,
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    windows.push(window);
    trackDesktopAnalytics(window);
    await window.loadFile(join(ui, 'index.html'), {
      query: { mode: 'loading', firstSetup: 'false' },
    });
    assert.equal(window.webContents.session, target);
    return window;
  };
  const request = async (window, index) => {
    await window.webContents.executeJavaScript(
      `void fetch('https://eu.i.posthog.com/fixture/${index}', { mode: 'no-cors' }).catch(() => {})`,
    );
    await requests[index].started.promise;
  };
  try {
    const first = await createWindow();
    const second = await createWindow();
    await request(first, 0);
    await request(second, 1);
    const firstDrain = completeDesktopSetup(first);
    const secondDrain = completeDesktopSetup(second);
    await new Promise((accept) => setTimeout(accept, 150));
    assert.equal(first.isDestroyed(), false);
    assert.equal(second.isDestroyed(), false);
    requests[0].response.resolve();
    await firstDrain;
    assert.equal(first.isDestroyed(), true);
    assert.equal(second.isDestroyed(), false);
    await request(second, 2);
    requests[1].response.resolve();
    await new Promise((accept) => setTimeout(accept, 150));
    assert.equal(second.isDestroyed(), false);
    requests[2].response.resolve();
    await secondDrain;
    assert.equal(second.isDestroyed(), true);
    const reopened = await createWindow();
    await request(reopened, 3);
    const reopenedDrain = completeDesktopSetup(reopened);
    await new Promise((accept) => setTimeout(accept, 150));
    assert.equal(reopened.isDestroyed(), false);
    requests[3].response.resolve();
    await reopenedDrain;
    assert.equal(reopened.isDestroyed(), true);
    assert.equal(session.fromPartition(partition), target);
  } finally {
    for (const request of requests) request.response.resolve();
    for (const window of windows) if (!window.isDestroyed()) window.destroy();
  }
}

function decodeSnapshot(value) {
  if (typeof value === 'string' && value.charCodeAt(0) === 31 && value.charCodeAt(1) === 139)
    return decodeSnapshot(JSON.parse(gunzipSync(Buffer.from(value, 'latin1')).toString()));
  if (Array.isArray(value)) return value.map(decodeSnapshot);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeSnapshot(item)]),
    );
  return value;
}
