import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MessageChannelMain,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  safeStorage,
  session,
  shell,
  Tray,
  utilityProcess,
} from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSettingsStore } from './settings.mjs';
import { createDesktopAnalytics } from './analytics.mjs';
import {
  assistantNotificationPreview,
  createReadinessNotice,
  isQuietTime,
  watchAssistantMessages,
} from './notifications.mjs';
import { createAppPreferencesStore } from './app-preferences.mjs';
import { createChatReadCursorStore } from './chat-read-cursors.mjs';
import { saveArtifactDownload } from './downloads.mjs';
import { createDesktopLifecycle } from './lifecycle.mjs';
import { createDesktopUpdater, createUpdateSource, startDesktopUpdateChecks } from './updates.mjs';
import { windowsInstallCommand } from './windows-update.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = app.isPackaged
  ? join(process.resourcesPath, 'engine')
  : resolve(desktopRoot, '..');
const setupPath = app.isPackaged
  ? join(desktopRoot, 'ui', 'index.html')
  : join(engineRoot, 'dist', 'desktop-ui', 'index.html');
const setupURL = pathToFileURL(setupPath).href;
const testInstall =
  app.isPackaged &&
  JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')).nodBuild?.testProfile ===
    true;
app.setName(testInstall ? 'nod Setup Test' : 'nod');
const developmentDataRoot =
  !app.isPackaged || testInstall ? process.env.NOD_DESKTOP_USER_DATA : undefined;
if (developmentDataRoot && !isAbsolute(developmentDataRoot))
  throw new Error('The development profile path must be absolute.');
app.setPath(
  'userData',
  developmentDataRoot || join(app.getPath('appData'), testInstall ? 'nod Setup Test' : 'nod'),
);
const profileRoot = join(app.getPath('userData'), 'profiles', 'local');
const windowsUpdates = join(process.env.LOCALAPPDATA || app.getPath('temp'), 'nod', 'updates');
const settings = createSettingsStore(join(profileRoot, 'settings.json'), safeStorage);
const analyticsConfiguration = createDesktopAnalytics(join(profileRoot, 'analytics-id'), {
  packaged: app.isPackaged,
});
let setupWindow;
let setupWindowLoaded;
let engineWindow;
let engineFocusRequested = false;
let pendingFeedback = false;
let engine;
let welcomePassed = false;
let welcomeNavigation = false;
let transferringWelcome;
let welcomeTransferError;
let engineRuntimeReady = false;
let enginePreferencesReady = false;
let preparing;
let onboardingCompleted = false;
let nativePreferencesPending = false;
let guidedStartup = false;
let quitting = false;
let installingUpdate = false;
let updateSource;
let updates;
let checkingUpdates;
let updatePhase = 'idle';
let updateFailed = false;
let pendingPreload;
let stopUpdateChecks;
let closingEngine = false;
let tray;
let engineOrigin = '';
let engineBound = false;
let authToken = '';
let replayingProductOnboarding = process.argv.includes('--onboarding');
let stopNotifications;
let preferences = { theme: 'system', notifications: false, launchAtLogin: false };
const displayedNotifications = new Set();
let status = {
  platform: process.platform,
  unlockingKeys: false,
  phase: 'idle',
  message: 'Set up nod on your computer.',
  runtime: {
    phase: 'idle',
    message: 'Your computer will prepare in the background.',
    needsRuntimeArchive: false,
  },
};
const knownSecrets = new Set();
const engineWindows = new Set();
const pendingRenderers = new Map();
const appPreferences = createAppPreferencesStore(join(profileRoot, 'preferences.json'), {
  request: (path, options) => engineRequest(path, options),
  isReady: () => Boolean(engine) && enginePreferencesReady && !closingEngine && !quitting,
});
const chatReadCursors = createChatReadCursorStore(join(profileRoot, 'chat-read-cursors.json'), {
  owner: async () => JSON.parse(await readFile(join(profileRoot, 'profile.json'), 'utf8')).ownerId,
});

const lifecycle = createDesktopLifecycle({
  prepareRuntime: async ({ signal, onStatus, onStorageReady }) => {
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    await writeDiagnostic('Preparing local runtime.').catch(() => {});
    const { prepareRuntime } = await import(
      pathToFileURL(join(engineRoot, 'desktop', 'runtime', 'index.mjs')).href
    );
    const prepared = await prepareRuntime({
      dataRoot: profileRoot,
      resourcesPath: engineRoot,
      preserveRuntimeCache: testInstall,
      resolveDownloadUrl: updateSource?.runtimeDownloadUrl,
      signal,
      onStatus,
      onStorageReady,
    });
    await writeDiagnostic('Local runtime prepared.').catch(() => {});
    return prepared;
  },
  validateStart,
  startEngine,
  stopEngine,
  stopRuntime: async () => {
    const { stopRuntime } = await import(
      pathToFileURL(join(engineRoot, 'desktop', 'runtime', 'index.mjs')).href
    );
    await stopRuntime({ dataRoot: profileRoot, resourcesPath: engineRoot });
  },
  onRuntimeStatus: (value) => {
    const runtime = { ...value, message: bounded(value.message) };
    if (
      preparing &&
      !welcomeTransferError &&
      status.phase !== 'starting' &&
      value.phase !== 'error'
    )
      update({
        runtime,
        phase: 'preparing',
        message: runtime.message,
        progress: value.progress,
        needsRuntimeArchive: false,
      });
    else update({ runtime });
  },
});

const readinessNotice = createReadinessNotice({
  notify: async (eligible) => {
    const saved = await appPreferences.get();
    if (!eligible() || quitting || !preferences.notifications || foregroundWindow()) return false;
    if (!Notification.isSupported() || isQuietTime(saved.preferences)) return true;
    const notification = new Notification({
      title: 'nod is ready',
      body: onboardingCompleted
        ? 'Your workspace and browser are ready.'
        : 'Your computer is ready. Come back to finish setup.',
    });
    displayedNotifications.add(notification);
    notification.on('click', () => {
      if (!quitting) showEngine();
    });
    notification.on('close', () => displayedNotifications.delete(notification));
    notification.on('failed', () => displayedNotifications.delete(notification));
    notification.show();
    return true;
  },
});

function foregroundWindow() {
  return [setupWindow, ...engineWindows].some(
    (window) => window && !window.isDestroyed() && window.isFocused(),
  );
}

function updateReadinessNotice() {
  void readinessNotice.update({
    runtimePhase: engineRuntimeReady ? status.runtime.phase : 'preparing',
    guided: guidedStartup,
    enabled: preferences.notifications,
    foreground: foregroundWindow(),
    quitting,
    completed: onboardingCompleted,
    engineReady: Boolean(engine) && engineRuntimeReady && status.phase === 'ready',
  });
}

function bounded(value) {
  let message = String(value || 'The operation could not be completed.');
  for (const secret of knownSecrets)
    if (secret.length > 7) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 400);
}

function update(value) {
  status = {
    ...status,
    ...value,
    message: bounded(value.message || status.message),
  };
  if (value.phase === 'ready' || value.phase === 'error') status.unlockingKeys = false;
  if (value.error) status.error = bounded(value.error);
  else if (Object.hasOwn(value, 'error') || (value.phase && value.phase !== 'error'))
    delete status.error;
  for (const window of [setupWindow, engineWindow])
    if (window && !window.isDestroyed()) window.webContents.send('nod:status', status);
  if (tray) tray.setToolTip(`nod — ${status.phase === 'ready' ? 'Running' : status.message}`);
  updateReadinessNotice();
}

function publicPreferences() {
  return {
    ...preferences,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  };
}

async function readDesktopSettings() {
  return { ...(await settings.get()), ...publicPreferences() };
}

function publishPreferences() {
  const value = publicPreferences();
  for (const window of [setupWindow, ...engineWindows]) {
    if (!window || window.isDestroyed()) continue;
    window.setBackgroundColor(value.resolvedTheme === 'dark' ? '#191919' : '#fafafa');
    window.webContents.send('nod:preferences', value);
  }
}

function applyPreferences(saved) {
  preferences = {
    theme: saved.theme,
    notifications: saved.notifications,
    launchAtLogin: saved.launchAtLogin,
  };
  nativeTheme.themeSource = saved.theme;
  publishPreferences();
  synchronizeNotifications();
  updateReadinessNotice();
}

function synchronizeNotifications() {
  if (!preferences.notifications || !engine || status.phase !== 'ready' || quitting) {
    stopNotifications?.();
    stopNotifications = undefined;
    return;
  }
  if (!stopNotifications && Notification.isSupported())
    stopNotifications = watchAssistantMessages({
      request: (path, options) => engineRequest(path, options),
      onMessage: (message, threadId) =>
        void notifyAssistantMessage(message, threadId).catch(() => {}),
    });
}

async function notifyAssistantMessage(message, threadId) {
  if (!preferences.notifications || !Notification.isSupported() || quitting) return;
  if ([...engineWindows].some((window) => !window.isDestroyed() && window.isFocused())) return;
  const sourceEngine = engine;
  const saved = await appPreferences.get();
  if (
    !sourceEngine ||
    engine !== sourceEngine ||
    !preferences.notifications ||
    quitting ||
    isQuietTime(saved.preferences) ||
    [...engineWindows].some((window) => !window.isDestroyed() && window.isFocused())
  )
    return;
  const notification = new Notification({
    title: 'nod',
    body: assistantNotificationPreview(message, knownSecrets),
  });
  displayedNotifications.add(notification);
  notification.on('click', () => {
    if (quitting) return;
    showEngine();
    const window = engineWindow;
    if (!window || window.isDestroyed() || status.phase !== 'ready') return;
    const focus = () => {
      if (quitting || window.isDestroyed() || status.phase !== 'ready') return;
      window.webContents.send(
        'nod:focus-message',
        engine === sourceEngine ? { threadId, messageId: message.id } : null,
      );
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', focus);
    else focus();
  });
  notification.on('close', () => displayedNotifications.delete(notification));
  notification.on('failed', () => displayedNotifications.delete(notification));
  notification.show();
}

async function writeDiagnostic(value) {
  const directory = join(profileRoot, 'logs');
  const path = join(directory, 'startup.log');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await stat(path).catch(() => undefined))?.size > 64 * 1024)
    await writeFile(path, '', { mode: 0o600 });
  const line = bounded(value)
    .replaceAll(engineRoot, '<engine>')
    .replaceAll(profileRoot, '<profile>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<address>');
  await appendFile(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function isSetupURL(url) {
  try {
    const target = new URL(url);
    return target.protocol === 'file:' && target.pathname === new URL(setupURL).pathname;
  } catch {
    return false;
  }
}

function isSetup(event) {
  return (
    setupWindow &&
    !setupWindow.isDestroyed() &&
    event.sender === setupWindow.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    isSetupURL(event.senderFrame?.url)
  );
}

function isEngine(event) {
  return (
    [...engineWindows].some(
      (window) => !window.isDestroyed() && event.sender === window.webContents,
    ) &&
    event.senderFrame === event.sender.mainFrame &&
    trustedAppURL(event.senderFrame?.url)
  );
}

function saveEngineDownload(event, item, sender, frame) {
  if (!isEngine({ sender, senderFrame: frame })) return;
  saveArtifactDownload(event, item, {
    origin: engineOrigin,
    directory: app.getPath('downloads'),
    onError: async (recoveryPath) => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'nod could not save the file to Downloads.',
        detail: recoveryPath
          ? 'The downloaded file is available in a temporary folder.'
          : 'Try downloading the file again.',
        buttons: recoveryPath ? ['Show file', 'Close'] : ['OK'],
        cancelId: recoveryPath ? 1 : 0,
        noLink: true,
      });
      if (recoveryPath && response === 0) shell.showItemInFolder(recoveryPath);
    },
  });
}

function trustedAppURL(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === engineOrigin &&
      ([
        '/',
        '/onboarding',
        '/apps',
        '/channels',
        '/settings',
        '/settings/models',
        '/settings/memory',
        '/you',
        '/tasks',
        '/memory',
        '/usage',
        '/vault',
        '/trust',
        '/browser',
        '/privacy',
        '/privacy/',
      ].includes(url.pathname) ||
        /^\/(vault|credentials|payments|approvals|browser-connect)\/[A-Za-z0-9_-]+\/?$/.test(
          url.pathname,
        ))
    );
  } catch {
    return false;
  }
}

function allowSetup(event) {
  if (!isSetup(event)) throw new Error('This action is unavailable.');
}

async function openExternal(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('This link is unavailable.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('This link is unavailable.');
  const bot = /^\/([A-Za-z0-9_]{1,64})$/.exec(url.pathname)?.[1];
  const start = url.searchParams.get('start');
  if (
    url.protocol === 'https:' &&
    url.hostname === 't.me' &&
    !url.port &&
    !url.hash &&
    bot &&
    start &&
    /^[A-Za-z0-9_-]{32}$/.test(start) &&
    [...url.searchParams].length === 1
  ) {
    const native = new URL('tg://resolve');
    native.searchParams.set('domain', bot);
    native.searchParams.set('start', start);
    try {
      await shell.openExternal(native.href);
      return;
    } catch {}
  }
  await shell.openExternal(url.href);
}

function protectWindow(window, origin) {
  window.on('focus', updateReadinessNotice);
  for (const event of ['blur', 'hide', 'closed'])
    window.on(event, () => setTimeout(updateReadinessNotice, 100));
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (quitting) return { action: 'deny' };
    if (origin && trustedAppURL(url))
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 820,
          webPreferences: {
            preload: join(desktopRoot, 'preload', 'engine.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            partition: 'persist:nod-app',
          },
        },
      };
    void openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  window.webContents.on('did-create-window', (child) => {
    engineWindows.add(child);
    protectWindow(child, engineOrigin);
    child.on('closed', () => engineWindows.delete(child));
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (quitting) return event.preventDefault();
    if ((!origin && isSetupURL(url)) || (origin && trustedAppURL(url))) return;
    event.preventDefault();
    void openExternal(url).catch(() => {});
  });
  window.webContents.on('will-redirect', (event, url) => {
    if ((!origin && isSetupURL(url)) || (origin && trustedAppURL(url))) return;
    event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
}

function waitForRenderer(window, present, failed) {
  const timeout = setTimeout(failed, 30_000);
  timeout.unref?.();
  pendingRenderers.set(window, () => {
    clearTimeout(timeout);
    present();
  });
  window.once('closed', () => {
    clearTimeout(timeout);
    pendingRenderers.delete(window);
  });
}

function showSettings(section = 'general', loading = false) {
  if (quitting) return;
  if (!loading && onboardingCompleted && engine && status.phase === 'ready') {
    showEngine();
    const window = engineWindow;
    if (!window || window.isDestroyed()) return;
    const open = () => {
      if (!window.isDestroyed()) window.webContents.send('nod:settings:focus', section);
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', open);
    else open();
    return;
  }
  if (setupWindow && !setupWindow.isDestroyed()) {
    const window = setupWindow;
    if (!pendingRenderers.has(window)) {
      window.show();
      window.focus();
    }
    return setupWindowLoaded.then(() => {
      if (window.isDestroyed()) return;
      window.webContents.send('nod:status', status);
    });
  }
  setupWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 860,
    minWidth: 700,
    minHeight: 600,
    title: 'nod',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'nod-settings',
    },
  });
  const window = setupWindow;
  let presented;
  const ready = new Promise((resolve) => {
    presented = resolve;
  });
  const failed = () => {
    if (quitting || window.isDestroyed() || !pendingRenderers.has(window)) return;
    window.destroy();
    update({ windowError: 'nod could not open setup. Try again.' });
    void dialog.showMessageBox({
      type: 'error',
      message: 'nod could not open setup.',
      detail: 'Close and reopen nod to try again. Your progress is saved.',
      buttons: ['OK'],
    });
  };
  waitForRenderer(
    window,
    () => {
      if (!quitting && !window.isDestroyed()) window.show();
      presented();
    },
    failed,
  );
  protectWindow(window);
  window.on('closed', () => {
    pendingRenderers.delete(window);
    presented();
    if (setupWindow === window) setupWindow = undefined;
  });
  setupWindowLoaded = Promise.all([
    window
      .loadFile(setupPath, {
        query: {
          firstSetup: String(!onboardingCompleted),
          ...(status.unlockingKeys ? { unlocking: process.platform } : {}),
        },
      })
      .catch(failed),
    ready,
  ]);
  return setupWindowLoaded;
}

function showEngine({ focus = true } = {}) {
  if (quitting) return;
  if (
    !enginePreferencesReady ||
    !engineOrigin ||
    (onboardingCompleted && !engineRuntimeReady) ||
    (!onboardingCompleted && !welcomePassed)
  ) {
    showSettings('general', true);
    return;
  }
  if (engineWindow && !engineWindow.isDestroyed()) {
    if (pendingRenderers.has(engineWindow)) {
      if (focus && setupWindow) void showSettings('general', true);
      else if (focus) engineFocusRequested = true;
      return;
    }
    if (replayingProductOnboarding) {
      replayingProductOnboarding = false;
      void engineWindow.loadURL(`${engineOrigin}/onboarding?replay=1`);
    }
    if (focus) {
      engineWindow.show();
      engineWindow.focus();
    } else engineWindow.showInactive();
    deliverFeedbackRequest(engineWindow);
    return;
  }
  const previousSetup = setupWindow;
  const initialWelcome = welcomeNavigation;
  const initialReplay = replayingProductOnboarding;
  engineFocusRequested = false;
  update({ windowError: undefined });
  engineWindow = new BrowserWindow({
    show: false,
    ...(setupWindow && !setupWindow.isDestroyed()
      ? setupWindow.getNormalBounds()
      : { width: 1200, height: 860 }),
    minWidth: 700,
    minHeight: 600,
    title: 'nod',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'engine.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:nod-app',
    },
  });
  engineWindows.add(engineWindow);
  protectWindow(engineWindow, engineOrigin);
  const window = engineWindow;
  const failed = () => {
    if (quitting || window.isDestroyed() || !pendingRenderers.has(window)) return;
    welcomeNavigation ||= initialWelcome;
    replayingProductOnboarding ||= initialReplay;
    window.destroy();
    update({ windowError: 'nod could not open. Try again.' });
    if (!setupWindow && (!previousSetup || engineFocusRequested))
      void showSettings('general', true);
  };
  waitForRenderer(
    window,
    () => {
      if (quitting || window.isDestroyed()) return;
      const startup = setupWindow;
      if (startup && !startup.isDestroyed()) {
        window.setBounds(startup.getNormalBounds());
        const waiting = pendingRenderers.has(startup);
        if (startup.isMinimized()) window.minimize();
        else if (startup.isVisible() || waiting) {
          if (startup.isFocused() || waiting) window.show();
          else window.showInactive();
        }
        startup.destroy();
      } else if (!previousSetup || engineFocusRequested) {
        if (focus || engineFocusRequested) window.show();
        else window.showInactive();
      }
      deliverFeedbackRequest(window);
      void loaded.then(() => {
        if (!quitting && !window.isDestroyed() && replayingProductOnboarding) showEngine();
      });
    },
    failed,
  );
  window.webContents.on('did-finish-load', () => deliverFeedbackRequest(window));
  engineWindow.on('closed', () => {
    pendingRenderers.delete(window);
    engineWindows.delete(window);
    if (engineWindow === window) engineWindow = undefined;
  });
  const destination = nativePreferencesPending
    ? `${engineOrigin}/onboarding?preferences=required`
    : welcomeNavigation
      ? `${engineOrigin}/onboarding?welcome=complete`
      : replayingProductOnboarding
        ? `${engineOrigin}/onboarding?replay=1`
        : engineOrigin;
  welcomeNavigation = false;
  replayingProductOnboarding = false;
  const loaded = window.loadURL(destination).catch(failed);
}

function showFeedback() {
  if (quitting) return;
  pendingFeedback = true;
  showEngine();
}

function deliverFeedbackRequest(window) {
  if (
    quitting ||
    !pendingFeedback ||
    window.isDestroyed() ||
    window.webContents.isLoadingMainFrame()
  )
    return;
  pendingFeedback = false;
  window.webContents.send('nod:feedback:open');
}

async function feedbackContext() {
  const { nodBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  return {
    appVersion: app.getVersion(),
    appRelease: typeof nodBuild?.source === 'string' ? nodBuild.source : null,
    appModified: typeof nodBuild?.modified === 'boolean' ? nodBuild.modified : null,
    development: !app.isPackaged,
    source: 'desktop',
    platform: `${process.platform}-${process.arch}`,
  };
}

async function captureFeedbackScreenshot(event) {
  const window = [...engineWindows].find((window) => event.sender === window.webContents);
  const url = event.senderFrame.url;
  if (
    !window?.isVisible() ||
    /^\/(?:usage|trust|vault|credentials|payments|browser|browser-connect|onboarding)(?:\/|$)/.test(
      new URL(url).pathname,
    )
  )
    return null;
  const contents = event.sender;
  const safe = async () =>
    isEngine(event) &&
    contents.getURL() === url &&
    (await contents.executeJavaScript(`!document.querySelector(
      '[data-analytics-private], .browser-handoff, .pending-attachments, input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"], dialog[open], [role="dialog"]:not(.feedback-intro), [role="alertdialog"], iframe, webview'
    ) && !Array.from(document.querySelectorAll('input, textarea, [contenteditable]')).some((element) => {
      if (element instanceof HTMLInputElement)
        return !['hidden', 'button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color'].includes(element.type) && !!element.value;
      if (element instanceof HTMLTextAreaElement) return !!element.value;
      return element.getAttribute('contenteditable')?.toLowerCase() !== 'false' &&
        (!!element.textContent?.trim() || !!element.querySelector('img, canvas, video, audio, svg, iframe, object, embed'));
    })`));
  if (!(await safe())) return null;
  let image = await contents.capturePage(undefined, { stayHidden: true });
  if (image.isEmpty() || !(await safe())) return null;
  const { width, height } = image.getSize();
  const scale = Math.min(1, 1600 / Math.max(width, height));
  if (scale < 1)
    image = image.resize({
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    });
  const bytes = image.toJPEG(85);
  return bytes.length && bytes.length <= 2 * 1024 * 1024 ? bytes : null;
}

function availablePort() {
  return new Promise((accept, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close((error) => (error ? reject(error) : accept(port)));
    });
  });
}

function baseEnvironment() {
  return Object.fromEntries(
    [
      'HOME',
      'USER',
      'LOGNAME',
      'TMPDIR',
      'LANG',
      'LC_ALL',
      'PATH',
      'SHELL',
      'SYSTEMROOT',
      'USERPROFILE',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      ...(developmentDataRoot ? ['NOD_DESKTOP_USER_DATA', 'NOD_COMPOSIO_PROXY_URL'] : []),
      'NOD_FEEDBACK_ENABLED',
      'NOD_FEEDBACK_URL',
      'NOD_FEEDBACK_TOKEN',
      'NOD_FEEDBACK_RECEIPT_URL_PREFIX',
      'NOD_TRACES_URL',
      'NOD_TRACES_TOKEN',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ]
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  );
}

function openOnePassword(owner) {
  const helper = utilityProcess.fork(
    join(engineRoot, 'desktop', 'main', 'onepassword.mjs'),
    [app.getVersion()],
    {
      cwd: engineRoot,
      env: Object.fromEntries(
        ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'TMP']
          .concat(['PATH', 'LANG'])
          .filter((key) => typeof process.env[key] === 'string')
          .map((key) => [key, process.env[key]]),
      ),
      stdio: 'ignore',
      serviceName: 'nod 1Password',
      allowLoadingUnsignedLibraries: true,
    },
  );
  const { port1, port2 } = new MessageChannelMain();
  helper.postMessage({ type: 'nod-1password-port' }, [port2]);
  owner.postMessage({ type: 'nod-1password-port' }, [port1]);
  owner.once('exit', () => helper.kill());
}

async function profileOwner() {
  const path = join(profileRoot, 'profile.json');
  async function published() {
    if (process.platform === 'win32') return;
    const directory = await open(profileRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  try {
    const file = await open(path, 'r+');
    try {
      const value = JSON.parse(await file.readFile('utf8'));
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.ownerId)
      )
        throw new Error('The local profile identity is invalid.');
      await file.sync();
      await published();
      return value.ownerId;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const ownerId = randomUUID();
    const temporary = join(profileRoot, `.profile-${randomUUID()}`);
    try {
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ ownerId }));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      await published();
    } finally {
      await rm(temporary, { force: true });
    }
    return ownerId;
  }
}

function analyticsEnvironment(metadata) {
  return !testInstall &&
    app.isPackaged &&
    metadata?.release === true &&
    /^\d+\.\d+\.\d+$/.test(app.getVersion())
    ? 'production'
    : 'development';
}

async function engineRequest(path, options = {}) {
  if (!engineBound) throw new Error('nod is not ready.');
  return fetch(`${engineOrigin}${path}`, {
    ...options,
    headers: { ...options.headers, 'x-nod-desktop-token': authToken },
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
}

async function stopEngine() {
  enginePreferencesReady = false;
  engineRuntimeReady = false;
  stopNotifications?.();
  stopNotifications = undefined;
  if (!engine) return;
  closingEngine = true;
  const child = engine;
  await new Promise((accept, reject) => {
    let finalTimeout;
    const timeout = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {}
      }
      finalTimeout = setTimeout(
        () =>
          reject(new Error('The previous nod process has not stopped. Quit and reopen the app.')),
        5000,
      );
    }, 20_000);
    child.once('exit', () => {
      clearTimeout(timeout);
      clearTimeout(finalTimeout);
      accept();
    });
    child.kill();
  });
  if (engine === child) engine = undefined;
  closingEngine = false;
}

async function transferWelcome() {
  if (transferringWelcome) return transferringWelcome;
  if (!enginePreferencesReady || quitting) return;
  transferringWelcome = (async () => {
    if (onboardingCompleted || welcomePassed) return;
    const saved = await settings.get();
    if (!saved.welcome?.continued) return;
    if (!saved.welcome.acknowledged) {
      const response = await engineRequest('/api/account', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Origin: engineOrigin },
        body: JSON.stringify({ usageData: saved.welcome.usageData }),
      });
      if (!response.ok) throw new Error('nod could not save your choice. Try again.');
      const result = await response.json();
      if (result.settings?.usageData !== saved.welcome.usageData)
        throw new Error('nod could not confirm your choice. Try again.');
      await settings.acknowledgeWelcome(saved.welcome);
    }
    welcomeNavigation = true;
    welcomePassed = true;
    welcomeTransferError = undefined;
    update({
      phase: engineRuntimeReady ? 'ready' : 'preparing',
      message: engineRuntimeReady ? 'nod is running on your computer.' : status.runtime.message,
      error: undefined,
    });
    if (pendingFeedback || foregroundWindow()) showEngine();
    else if (setupWindow && !setupWindow.isDestroyed()) showEngine({ focus: false });
  })()
    .catch((error) => {
      welcomeTransferError = bounded(error.message);
      update({ phase: 'error', error: welcomeTransferError, message: welcomeTransferError });
      throw error;
    })
    .finally(() => {
      transferringWelcome = undefined;
    });
  return transferringWelcome;
}

async function finishEnginePreparation(pending = false) {
  await appPreferences.sync();
  if (quitting || !engine) throw new Error('nod is closing.');
  if (!onboardingCompleted) {
    const response = await engineRequest('/api/session');
    if (response.ok && (await response.json()).settings?.onboardingCompleted === true) {
      const saved = await settings.get();
      if (saved.notifications && saved.launchAtLogin) {
        applyPreferences(await settings.save({ onboardingCompleted: true }));
        onboardingCompleted = true;
        nativePreferencesPending = false;
      } else {
        nativePreferencesPending = true;
        welcomePassed = true;
        welcomeNavigation = false;
      }
    }
  }
  if (!pending && !engineRuntimeReady) {
    engine.postMessage({ type: 'nod-runtime-ready' });
    engineRuntimeReady = true;
  }
  update({
    phase: pending ? 'preparing' : 'ready',
    message: pending ? status.runtime.message : 'nod is running on your computer.',
    progress: pending ? status.runtime.progress : undefined,
    engineReady: true,
  });
  if (!welcomeTransferError) await transferWelcome().catch(() => {});
  if (welcomeTransferError)
    update({ phase: 'error', error: welcomeTransferError, message: welcomeTransferError });
  if ((!pending && onboardingCompleted) || welcomePassed) {
    if (pendingFeedback || foregroundWindow()) showEngine();
    else if (setupWindow && !setupWindow.isDestroyed()) showEngine({ focus: false });
  }
  synchronizeNotifications();
  if (!pending && pendingPreload) {
    const assets = pendingPreload;
    pendingPreload = undefined;
    void preloadUpdateImages(assets);
  }
  updateReadinessNotice();
  return status;
}

function refreshUpdateMenu() {
  if (quitting) return;
  const label = updates?.ready
    ? `Restart to update to ${updates.ready.version}…`
    : {
        checking: 'Checking for updates…',
        preparing: 'Preparing update…',
        downloading: 'Downloading update…',
      }[updatePhase] || (updateFailed ? 'Update Failed. Try Again…' : 'Check for Updates…');
  const item = Menu.getApplicationMenu?.()?.getMenuItemById('desktop-update');
  if (item) {
    item.label = label;
    item.enabled = Boolean(updates) && !checkingUpdates;
  }
  if (tray)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open nod', click: showEngine },
        { label: 'Settings…', click: () => showSettings() },
        { label: 'Send feedback…', click: showFeedback },
        {
          label,
          enabled: Boolean(updates) && !checkingUpdates,
          click: () => void checkForUpdates(),
        },
        { type: 'separator' },
        { label: 'Quit nod', click: () => app.quit() },
      ]),
    );
}

async function checkForUpdates(manual = true) {
  if (!updates || quitting || (!manual && updates.ready)) return;
  if (checkingUpdates) return checkingUpdates;
  const release = () => {
    if (checkingUpdates === checking) checkingUpdates = undefined;
    refreshUpdateMenu();
  };
  const checking = (async () => {
    let restarting = false;
    while (!quitting) {
      try {
        if (restarting) {
          await updates.restart();
          return;
        }
        const candidate = updates.ready ?? (await updates.check());
        updateFailed = false;
        if (quitting) return;
        if (!candidate) {
          if (manual)
            await dialog.showMessageBox({ message: 'nod is up to date.', buttons: ['OK'] });
          return;
        }
        if (!manual) {
          await notifyUpdate(candidate);
          return;
        }
        const { response } = await dialog.showMessageBox({
          message: `nod ${candidate.version} is ready.`,
          buttons: ['Restart', 'Later'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0 || quitting) return;
        restarting = true;
        await updates.restart();
        return;
      } catch (error) {
        if (quitting) return;
        if (!updates.ready) updateFailed = true;
        await writeDiagnostic(error.message).catch(() => {});
        if (!manual && !restarting) throw error;
        const ready = Boolean(updates.ready);
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message: ready ? 'Couldn’t restart nod' : 'Couldn’t check for updates',
          detail: 'You can keep using nod and try again later.',
          buttons: [ready ? 'Retry restart' : 'Try again', 'Not now'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0 || quitting) return;
        restarting = ready;
      }
    }
  })().finally(release);
  checkingUpdates = checking;
  refreshUpdateMenu();
  return checking;
}

async function notifyUpdate(candidate) {
  if (!preferences.notifications || !Notification.isSupported()) return false;
  if (isQuietTime((await appPreferences.get()).preferences)) return true;
  const notification = new Notification({
    title: `nod ${candidate.version} is ready`,
    body: 'Restart nod to use the new version.',
  });
  displayedNotifications.add(notification);
  notification.on('click', () => {
    if (!quitting && updates?.ready) void checkForUpdates();
  });
  notification.on('close', () => displayedNotifications.delete(notification));
  notification.on('failed', () => displayedNotifications.delete(notification));
  notification.show();
  return true;
}

async function preloadUpdateImages(assets, signal) {
  const { preloadRuntimeImages } = await import(
    pathToFileURL(join(engineRoot, 'desktop/runtime/index.mjs')).href
  );
  await preloadRuntimeImages({ dataRoot: profileRoot, assets, signal }).catch(
    (error) => void writeDiagnostic(error.message).catch(() => {}),
  );
}

async function restartForUpdate() {
  if (quitting || !(await confirmRestart())) return;
  await quit(installUpdate);
}

async function confirmRestart() {
  if (!engine) return true;
  let running;
  try {
    const response = await engineRequest('/api/desktop/status');
    if (response.ok) running = (await response.json()).running;
  } catch {}
  if (Array.isArray(running) && !running.length) return true;
  const work = Array.isArray(running)
    ? [
        ...new Set(
          running.map((turn) =>
            turn?.task
              ? 'a task'
              : turn?.visible
                ? 'a reply in your chat'
                : turn?.source === 'schedule'
                  ? 'a scheduled task'
                  : 'a background check',
          ),
        ),
      ]
    : [];
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: work.length ? 'nod is still working.' : 'nod could not check its current work.',
    detail: work.length
      ? `Restarting now stops ${new Intl.ListFormat('en').format(work)}. You can ask nod to continue afterwards.`
      : 'Restarting now may stop a task in progress.',
    buttons: ['Restart now', 'Later'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0 && !quitting;
}

function installUpdate() {
  if (process.platform === 'win32') {
    const { command, args, env } = windowsInstallCommand({
      directory: join(windowsUpdates, updates.ready.version),
      appPath: process.execPath,
      pid: process.pid,
      systemRoot: process.env.SystemRoot,
    });
    spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env },
    }).unref();
    installingUpdate = true;
    app.exit();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      autoUpdater.removeListener('error', failed);
      app.removeListener('before-quit', accepted);
    };
    const failed = (error) => {
      cleanup();
      installingUpdate = false;
      reject(error);
    };
    const accepted = () => {
      cleanup();
      resolve();
    };
    autoUpdater.once('error', failed);
    app.once('before-quit', accepted);
    installingUpdate = true;
    try {
      autoUpdater.quitAndInstall();
    } catch (error) {
      failed(error);
    }
  });
}

async function quit(complete, failure = 'nod could not finish shutting down.') {
  quitting = true;
  stopUpdateChecks?.();
  const stoppingUpdates = updates?.dispose();
  updateReadinessNotice();
  stopNotifications?.();
  for (const notification of displayedNotifications) notification.close();
  await stoppingUpdates;
  await chatReadCursors.flush().catch(() => {});
  await finishQuit(complete, failure);
}

async function removeAllData() {
  if (quitting) return;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Remove all nod data?',
    detail:
      'Your conversations, files, memory, logins, cards and settings are deleted from this computer. nod then quits.',
    buttons: ['Remove all data', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response !== 0 || quitting) return;
  await quit(async () => {
    const { removeProfile } = await import(
      pathToFileURL(join(engineRoot, 'desktop', 'runtime', 'index.mjs')).href
    );
    app.setLoginItemSettings({ openAtLogin: false });
    const browser = session.fromPartition('persist:nod-app');
    await browser.clearStorageData();
    await browser.clearCache();
    await removeProfile({ dataRoot: profileRoot, resourcesPath: engineRoot });
    app.exit();
  }, 'nod could not remove all its data.');
}

async function finishQuit(complete, failure) {
  while (true) {
    try {
      await lifecycle.close();
      await complete();
      return;
    } catch (error) {
      await writeDiagnostic(error.message).catch(() => {});
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: failure,
        detail: 'Try again to finish quitting.',
        buttons: ['Try again', 'Quit anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1) {
        app.exit();
        return;
      }
    }
  }
}

async function validateStart() {
  await settings.get();
  if (quitting) throw new Error('nod is closing.');
}

async function startEngine({ runtime, signal, pending = false }) {
  if (engine && enginePreferencesReady) return finishEnginePreparation(pending);
  if (engine) {
    if (!(await confirmRestart()))
      throw Object.assign(new Error('Restart nod when it finishes its current work.'), {
        code: 'NOD_RESTART_DEFERRED',
      });
    await stopEngine();
  }
  if (quitting) throw new Error('nod is closing.');
  const port = await availablePort();
  if (quitting || signal.aborted) throw new Error('nod is closing.');
  engineBound = false;
  authToken = randomBytes(32).toString('base64url');
  knownSecrets.add(authToken);
  engineOrigin = `http://127.0.0.1:${port}`;
  update({ phase: 'starting', message: 'Unlocking your saved API keys…', unlockingKeys: true });
  await new Promise((accept) => setTimeout(accept, 50));
  if (quitting || signal.aborted) throw new Error('nod is closing.');
  const providerEnvironment = await settings.environment();
  const owner = await profileOwner();
  if (providerEnvironment.NOD_VAULT_KEY) knownSecrets.add(providerEnvironment.NOD_VAULT_KEY);
  if (runtime.env.DATABASE_URL) knownSecrets.add(runtime.env.DATABASE_URL);
  if (process.env.NOD_FEEDBACK_TOKEN) knownSecrets.add(process.env.NOD_FEEDBACK_TOKEN);
  const { nodBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const tracesToken =
    typeof nodBuild?.tracesToken === 'string' ? nodBuild.tracesToken : process.env.NOD_TRACES_TOKEN;
  if (tracesToken) knownSecrets.add(tracesToken);
  const analytics = await analyticsConfiguration().catch(() => ({ enabled: false }));
  const environment = {
    ...baseEnvironment(),
    ...runtime.env,
    ...providerEnvironment,
    NODE_ENV: 'production',
    PORT: String(port),
    NOD_DESKTOP: 'true',
    NOD_APP_VERSION: app.getVersion(),
    NOD_DESKTOP_OWNER_ID: owner,
    NOD_DESKTOP_AUTH_TOKEN: authToken,
    NOD_DESKTOP_RUNTIME_PENDING: 'true',
    NOD_ANALYTICS_ENABLED: String(!testInstall && analytics.enabled),
    NOD_ANALYTICS_ENVIRONMENT: analyticsEnvironment(nodBuild),
    NOD_PUBLIC_URL: engineOrigin,
    NOD_DATA_ROOT: profileRoot,
    NOD_WEB_ROOT: join(engineRoot, 'dist', 'web'),
    ...(process.env.NOD_FEEDBACK_URL === '' ? { NOD_FEEDBACK_ENABLED: 'false' } : {}),
    ...(tracesToken ? { NOD_TRACES_TOKEN: tracesToken } : {}),
    PI_CODING_AGENT_DIR: join(profileRoot, 'pi'),
  };
  if (quitting || signal.aborted) throw new Error('nod is closing.');
  update({
    phase: 'starting',
    message: 'Starting nod.',
    needsRuntimeArchive: false,
    unlockingKeys: false,
  });
  const child = utilityProcess.fork(join(engineRoot, 'desktop', 'main', 'engine.mjs'), [], {
    cwd: engineRoot,
    env: environment,
    stdio: 'pipe',
    serviceName: 'nod engine',
  });
  engine = child;
  child.on('message', (message) => {
    if (engine === child && message?.type === 'nod-ready' && message.port === port) {
      engineBound = true;
    }
    if (engine === child && message?.type === 'nod-1password-open') openOnePassword(child);
  });
  child.stdout?.resume();
  let diagnostics = '';
  let failure = '';
  child.stderr?.on('data', (chunk) => {
    if (status.phase !== 'starting') return;
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
    const lines = diagnostics.split('\n');
    diagnostics = lines.pop() || '';
    for (const line of lines)
      if (
        /^(?:Error|TypeError|SyntaxError|ReferenceError|RangeError)(?::| \[)/.test(line) &&
        !line.includes('{')
      ) {
        failure = line.replace(/^\w+(?: \[[^\]]*\])?: /, '').replace(/https?:\/\/\S+/g, '<url>');
        void writeDiagnostic(line).catch(() => {});
      }
  });
  child.on('exit', (code) => {
    if (engine !== child) return;
    stopNotifications?.();
    stopNotifications = undefined;
    if (!closingEngine) void writeDiagnostic(`Engine exited with code ${code}.`).catch(() => {});
    engine = undefined;
    enginePreferencesReady = false;
    engineOrigin = '';
    engineBound = false;
    authToken = '';
    engineRuntimeReady = false;
    update({ engineReady: false });
    for (const window of engineWindows) if (!window.isDestroyed()) window.destroy();
    engineWindows.clear();
    if (!quitting && !closingEngine) {
      update({
        phase: 'error',
        message: 'nod stopped unexpectedly.',
        error: 'Open settings and choose Start nod to recover.',
      });
      showSettings();
    }
  });
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline && engine === child && !signal.aborted) {
    try {
      const response = await engineRequest('/api/health');
      if (response.ok && (await response.json()).ok === true) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((accept) => setTimeout(accept, 300));
  }
  if (!ready) {
    await stopEngine();
    throw new Error(failure || 'nod could not start. Check your settings and try again.');
  }
  enginePreferencesReady = true;
  return finishEnginePreparation(pending);
}

async function prepare(options = {}) {
  if (preparing) return preparing;
  update({
    phase: 'preparing',
    windowError: undefined,
    message: status.runtime.message,
    progress: status.runtime.progress,
    needsRuntimeArchive: false,
  });
  preparing = lifecycle
    .start({ retry: options?.retry === true })
    .catch((error) => {
      void writeDiagnostic(error.message).catch(() => {});
      const deferred =
        error.code === 'NOD_RESTART_DEFERRED' &&
        engine &&
        enginePreferencesReady &&
        !closingEngine &&
        !quitting;
      update({
        phase: deferred ? 'ready' : 'error',
        message: bounded(error.message),
        error: bounded(error.message),
        needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
        needsWsl: error.code === 'NOD_WSL_REQUIRED',
      });
      return status;
    })
    .finally(() => {
      preparing = undefined;
    });
  return preparing;
}

function replayOnboarding() {
  replayingProductOnboarding = onboardingCompleted;
  showEngine();
  return status;
}

async function importRuntime() {
  if (lifecycle.busy || quitting) throw new Error('Wait for nod to finish its current setup step.');
  const chosen = await dialog.showOpenDialog(setupWindow, {
    title: 'Choose the nod Runtime pack',
    buttonLabel: 'Install runtime',
    properties: ['openFile'],
    filters: [{ name: 'nod Runtime pack', extensions: ['gz', 'tgz'] }],
  });
  if (chosen.canceled || !chosen.filePaths[0] || quitting) return status;
  if (lifecycle.busy) throw new Error('Wait for nod to finish its current setup step.');
  try {
    await lifecycle.install(async ({ signal, onStatus }) => {
      const { installRuntimeArchive } = await import(
        pathToFileURL(join(engineRoot, 'desktop', 'runtime', 'index.mjs')).href
      );
      await installRuntimeArchive({
        archivePath: chosen.filePaths[0],
        resourcesPath: engineRoot,
        signal,
        onStatus,
      });
    });
    return prepare();
  } catch (error) {
    void writeDiagnostic(error.message).catch(() => {});
    if (onboardingCompleted)
      update({
        phase: 'error',
        message: bounded(error.message),
        needsRuntimeArchive: status.runtime.needsRuntimeArchive,
      });
  }
  return status;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  if (testInstall) process.on('SIGTERM', () => app.quit());
  app.on('second-instance', () => showEngine());
  app.on('activate', () => showEngine());
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (installingUpdate) return;
    event.preventDefault();
    if (quitting) return;
    void quit(() => app.exit()).catch(
      (error) => void writeDiagnostic(error.message).catch(() => {}),
    );
  });
  void app
    .whenReady()
    .then(async () => {
      if (
        app.isPackaged &&
        !testInstall &&
        process.platform === 'darwin' &&
        !app.isInApplicationsFolder()
      ) {
        const { response } = await dialog.showMessageBox({
          message: 'Move nod to your Applications folder?',
          detail: 'nod can update itself only from Applications.',
          buttons: ['Move to Applications', 'Not Now'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 0) {
          try {
            if (app.moveToApplicationsFolder()) return;
          } catch (error) {
            await writeDiagnostic(error.message).catch(() => {});
          }
        }
      }
      if (app.isPackaged && !testInstall && ['darwin', 'win32'].includes(process.platform)) {
        const { nodBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
        const windows = process.platform === 'win32';
        if (windows) await rm(windowsUpdates, { recursive: true, force: true }).catch(() => {});
        updateSource = createUpdateSource({ sourceUrl: nodBuild?.updateSourceUrl });
        updates = createDesktopUpdater({
          source: updateSource,
          currentVersion: app.getVersion(),
          native: windows ? undefined : autoUpdater,
          prepareRuntime: async (candidate, signal) => {
            if (windows) {
              const { stageWindowsUpdate } = await import(
                pathToFileURL(join(engineRoot, 'desktop/runtime/windows.mjs')).href
              );
              return stageWindowsUpdate(candidate, {
                directory: windowsUpdates,
                resourcesPath: engineRoot,
                signal,
              });
            }
            const { prepareRuntimeUpdate } = await import(
              pathToFileURL(join(engineRoot, 'desktop/runtime/assets.mjs')).href
            );
            const assets = await prepareRuntimeUpdate(candidate.runtime, {
              resourcesPath: engineRoot,
              downloadUrl: candidate.downloadUrl,
              signal,
            });
            if (!engine || closingEngine) pendingPreload = assets;
            else await preloadUpdateImages(assets, signal);
          },
          restart: restartForUpdate,
          onStatus: (phase) => {
            updatePhase = phase;
            refreshUpdateMenu();
          },
        });
        stopUpdateChecks = startDesktopUpdateChecks({
          check: () => checkForUpdates(false),
          powerMonitor,
        });
      }
      nativeTheme.on('updated', publishPreferences);
      const appSession = session.fromPartition('persist:nod-app');
      appSession.on('will-download', saveEngineDownload);
      appSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === 'x-nod-desktop-token') delete headers[key];
        const window = [...engineWindows].find(
          (candidate) =>
            !candidate.isDestroyed() && details.webContentsId === candidate.webContents.id,
        );
        const main = window?.webContents.mainFrame;
        const trustedFrame =
          main &&
          details.frame?.routingId === main.routingId &&
          details.frame?.processId === main.processId &&
          trustedAppURL(main.url);
        if (
          engineBound &&
          new URL(details.url).origin === engineOrigin &&
          window &&
          ((details.resourceType === 'mainFrame' && trustedAppURL(details.url)) || trustedFrame)
        )
          headers['x-nod-desktop-token'] = authToken;
        callback({ requestHeaders: headers });
      });
      const image = nativeImage.createFromPath(join(desktopRoot, 'main', 'trayTemplate.png'));
      image.setTemplateImage(true);
      tray = new Tray(image);
      if (process.platform !== 'darwin') tray.on('click', showEngine);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'nod',
            submenu: [
              { role: 'about' },
              { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showSettings() },
              { label: 'Send feedback…', click: showFeedback },
              {
                id: 'desktop-update',
                label: 'Check for Updates…',
                enabled: Boolean(updates),
                click: () => void checkForUpdates(),
              },
              {
                label: 'Replay onboarding…',
                click: replayOnboarding,
              },
              { label: 'Remove all data…', click: () => void removeAllData() },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      refreshUpdateMenu();
      ipcMain.handle('nod:renderer-ready', (event) => {
        const window = isSetup(event)
          ? setupWindow
          : isEngine(event)
            ? [...engineWindows].find((candidate) => candidate.webContents === event.sender)
            : undefined;
        if (!window) throw new Error('This action is unavailable.');
        const present = pendingRenderers.get(window);
        pendingRenderers.delete(window);
        present?.();
      });
      ipcMain.handle('nod:status', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return status;
      });
      ipcMain.handle('nod:settings:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return readDesktopSettings();
      });
      ipcMain.handle('nod:feedback:context', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return feedbackContext();
      });
      ipcMain.handle('nod:feedback:capture', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return captureFeedbackScreenshot(event).catch(() => null);
      });
      ipcMain.handle('nod:preferences:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return publicPreferences();
      });
      ipcMain.handle('nod:preferences:theme', async (event, theme) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('nod is closing.');
        applyPreferences(await settings.save({ theme }));
        return publicPreferences();
      });
      ipcMain.handle('nod:settings:save', async (event, value) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        const allowed = ['theme', 'notifications', 'launchAtLogin'];
        if (isEngine(event)) allowed.push('onboardingCompleted');
        if (isEngine(event) && !onboardingCompleted) allowed.push('onboardingPreferenceStep');
        if (isSetup(event) && !onboardingCompleted) allowed.push('welcome');
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((field) => !allowed.includes(field))
        )
          throw new Error('These settings are not supported.');
        if (quitting) throw new Error('nod is closing.');
        if (value.onboardingCompleted !== undefined) {
          const response = await engineRequest('/api/session');
          if (
            value.onboardingCompleted !== true ||
            !response.ok ||
            (await response.json()).settings?.onboardingCompleted !== true
          )
            throw new Error('Finish onboarding before continuing.');
        }
        const loginChanged = typeof value.launchAtLogin === 'boolean';
        const previousLogin = loginChanged ? app.getLoginItemSettings().openAtLogin : undefined;
        if (loginChanged) {
          app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
          const login = app.getLoginItemSettings();
          if (
            (process.platform === 'win32'
              ? login.executableWillLaunchAtLogin
              : login.openAtLogin) !== value.launchAtLogin
          )
            throw new Error(
              'Open at login could not be updated. Check nod in your computer’s login items, then try again.',
            );
        }
        let saved;
        try {
          saved = await settings.save(value);
        } catch (error) {
          if (loginChanged) {
            try {
              app.setLoginItemSettings({ openAtLogin: previousLogin });
            } catch {}
          }
          throw error;
        }
        onboardingCompleted = saved.onboardingCompleted;
        if (onboardingCompleted) nativePreferencesPending = false;
        applyPreferences(saved);
        if (!['preparing', 'starting', 'error'].includes(status.phase))
          update({ message: 'Ready.' });
        return readDesktopSettings();
      });
      ipcMain.handle('nod:prepare', async (event, options) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        if (options?.retry === true && !enginePreferencesReady) welcomeTransferError = undefined;
        await transferWelcome();
        if (options?.retry === true && status.windowError) showEngine();
        if (engineRuntimeReady) return status;
        return prepare(options);
      });
      ipcMain.handle('nod:runtime:import', (event) => {
        allowSetup(event);
        return importRuntime();
      });
      ipcMain.handle('nod:runtime:install-wsl', async (event) => {
        allowSetup(event);
        if (process.platform !== 'win32' || lifecycle.busy || quitting || !status.runtime.needsWsl)
          throw new Error('This setup action is unavailable.');
        const { response } = await dialog.showMessageBox(setupWindow, {
          type: 'question',
          message: 'Install Windows Subsystem for Linux?',
          detail:
            'Windows will ask for administrator approval. Restart your PC after installation, then open nod again.',
          buttons: ['Install WSL', 'Cancel'],
          defaultId: 0,
          cancelId: 1,
          noLink: true,
        });
        if (response === 1) return status;
        const { installWsl } = await import(
          pathToFileURL(join(engineRoot, 'desktop/runtime/windows.mjs')).href
        );
        await lifecycle.install(installWsl, { warmup: false });
        update({
          phase: 'error',
          message: 'Restart your PC, then open nod again.',
          error: 'Restart your PC, then open nod again.',
          needsWsl: false,
        });
        return status;
      });
      ipcMain.handle('nod:chat-read:get', (event, ownerId, threadId) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return chatReadCursors.get(ownerId, threadId);
      });
      ipcMain.handle('nod:chat-read:set', (event, ownerId, threadId, cursor) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('nod is closing.');
        return chatReadCursors.set(ownerId, threadId, cursor);
      });
      ipcMain.handle('nod:external', (event, url) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return openExternal(url);
      });
      ipcMain.handle('nod:data:remove', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return removeAllData();
      });
      ipcMain.handle('nod:settings:open', (event, section = 'general') => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (!['general', 'models', 'preferences'].includes(section))
          throw new Error('Choose a settings section.');
        showSettings(section);
      });
      try {
        const saved = await settings.get();
        onboardingCompleted = saved.onboardingCompleted;
        applyPreferences(saved);
        guidedStartup = !saved.onboardingCompleted;
        await showSettings('general', true);
        if (setupWindow && !setupWindow.isDestroyed()) void prepare();
      } catch (error) {
        showSettings('general', true);
        update({ phase: 'error', message: bounded(error.message), error: bounded(error.message) });
      }
    })
    .catch((error) => {
      void writeDiagnostic(bounded(error.message)).finally(() => app.quit());
    });
}
