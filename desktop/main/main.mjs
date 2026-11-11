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
  net,
  Notification,
  powerMonitor,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  utilityProcess,
} from 'electron';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createSettingsStore,
  desktopContentPolicy,
  serverOrigin,
  setupResource,
} from './settings.mjs';
import { createDesktopAnalytics } from './analytics.mjs';
import {
  assistantNotificationPreview,
  createReadinessNotice,
  createUnreadBadge,
  isQuietTime,
  watchAssistantMessages,
} from './notifications.mjs';
import { createAppPreferencesStore } from './app-preferences.mjs';
import { createChatReadCursorStore } from './chat-read-cursors.mjs';
import { registerArtifactFileHandlers } from './artifact-file-handlers.mjs';
import { saveArtifactDownload } from './downloads.mjs';
import { createDesktopLifecycle, startupErrorDetails } from './lifecycle.mjs';
import { createMacEncryption } from './mac-encryption.mjs';
import { createDesktopUpdater, createUpdateSource, startDesktopUpdateChecks } from './updates.mjs';
import { startWindowsInstall } from './windows-update.mjs';
import { appOpenPath } from './app-links.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = app.isPackaged
  ? join(process.resourcesPath, 'engine')
  : resolve(desktopRoot, '..');
const notificationIcon = join(engineRoot, app.isPackaged ? 'dist/web' : 'public', 'nod-logo.png');
const appPages = JSON.parse(readFileSync(join(engineRoot, 'src/shared/app-pages.json'), 'utf8'));
const posthogConfig = JSON.parse(
  readFileSync(join(engineRoot, 'src/shared/posthog-host.json'), 'utf8'),
);
const posthogHost = posthogConfig.host;
const appContentPolicy = desktopContentPolicy(posthogHost);
let pendingAppPath = process.argv.map((value) => appOpenPath(value, appPages)).find(Boolean);
let appLinksReady = false;
app.on('open-url', (event, value) => {
  event.preventDefault();
  const path = appOpenPath(value, appPages);
  if (!path) return;
  pendingAppPath = path;
  if (appLinksReady) showEngine();
});
const setupPath = app.isPackaged
  ? join(desktopRoot, 'ui', 'index.html')
  : join(engineRoot, 'dist', 'desktop-ui', 'index.html');
const setupURL = 'nod-setup://app/index.html';
protocol.registerSchemesAsPrivileged([
  { scheme: 'nod-setup', privileges: { standard: true, secure: true } },
]);
if (app.isPackaged)
  for (const name of [
    'remote-debugging-port',
    'remote-debugging-pipe',
    'auto-open-devtools-for-tabs',
  ])
    app.commandLine.removeSwitch(name);
const rendererSecurity = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  devTools: !app.isPackaged,
};
const testInstall =
  app.isPackaged &&
  JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8')).nodBuild?.testProfile ===
    true;
const appName = testInstall ? 'nod Setup Test' : 'Nod';
app.setName(process.platform === 'darwin' && app.isPackaged && !testInstall ? 'nod' : appName);
const developmentDataRoot =
  !app.isPackaged || testInstall ? process.env.NOD_DESKTOP_USER_DATA : undefined;
if (developmentDataRoot && !isAbsolute(developmentDataRoot))
  throw new Error('The development profile path must be absolute.');
app.setPath(
  'userData',
  developmentDataRoot || join(app.getPath('appData'), testInstall ? 'nod Setup Test' : 'nod'),
);
const profileRoot = join(app.getPath('userData'), 'profiles', 'local');
const freshLocalProfile = await stat(profileRoot).then(
  () => false,
  (error) => error.code === 'ENOENT',
);
const resumePath = join(profileRoot, 'update-resume.json');
const resumeRead = readFile(resumePath, 'utf8').catch(() => undefined);
const windowsUpdates = join(process.env.LOCALAPPDATA || app.getPath('temp'), 'nod', 'updates');
const settings = createSettingsStore(
  join(profileRoot, 'settings.json'),
  process.platform === 'darwin' && app.isPackaged && !testInstall
    ? createMacEncryption(safeStorage)
    : safeStorage,
);
const analyticsConfiguration = createDesktopAnalytics(join(profileRoot, 'analytics-id'), {
  packaged: app.isPackaged,
  env: process.env,
});
let appOpeningAt;
let freshAppOpening;
let freshAppOpenCapture;
let appOpeningDeferred = false;
let appOpeningConsentVersion = 0;
const claimedAppOpens = new Set();
const appUIOpenings = new Map();
function deferAppOpening() {
  appOpeningDeferred = true;
  appOpeningConsentVersion++;
  freshAppOpening = undefined;
  appUIOpenings.clear();
}
let setupWindow;
let setupWindowLoaded;
let engineWindow;
let engineFocusRequested = false;
let resumeWindow;
let resumePort;
let pendingFeedback = false;
let engine;
let engineFailure;
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
let updateRequestedManually = false;
let updatePhase = 'idle';
let updateProgress;
let updateFailed = false;
let dismissedUpdateVersion;
let pendingPreload;
let stopUpdateChecks;
let disposeArtifactFiles;
let closingEngine = false;
let tray;
let engineOrigin = '';
let engineBound = false;
let authToken = '';
let remoteConnection;
let connectionSettingsOpen = false;
let onboardingSetupOpen = false;
let connectionReturnsToOnboarding = false;
let clientPartition = 'persist:nod-app';
let replayingProductOnboarding = process.argv.includes('--onboarding');
let stopNotifications;
let unreadBadge;
let preferences = { theme: 'system', notifications: false, launchAtLogin: false };
const displayedNotifications = new Set();
let status = {
  platform: process.platform,
  unlockingKeys: false,
  phase: 'idle',
  stage: 'computer',
  message: 'Set up Nod on your computer.',
  runtime: {
    phase: 'idle',
    stage: 'computer',
    message: 'Your computer will prepare in the background.',
    needsRuntimeArchive: false,
  },
};
const knownSecrets = new Set();
const engineWindows = new Set();
let downloadShown = false;
let bounceWhenReady = false;
const pendingRenderers = new Map();
let appPreferences = createAppPreferencesStore(join(profileRoot, 'preferences.json'), {
  request: (path, options) => engineRequest(path, options),
  isReady: () => Boolean(engine) && enginePreferencesReady && !closingEngine && !quitting,
});
let chatReadCursors = createChatReadCursorStore(join(profileRoot, 'chat-read-cursors.json'), {
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
    const runtime = {
      ...value,
      message: bounded(value.message),
      details: value.details ? bounded(value.details, 256 * 1024) : undefined,
    };
    if (value.phase === 'error')
      void writeDiagnostic([runtime.message, runtime.details].filter(Boolean).join('\n')).catch(
        () => {},
      );
    if (
      preparing &&
      !engineFailure &&
      !welcomeTransferError &&
      status.phase !== 'starting' &&
      value.phase !== 'error'
    )
      update({
        runtime,
        phase: 'preparing',
        stage: runtime.stage,
        message: runtime.message,
        progress: value.progress,
        secondsLeft: value.secondsLeft,
        needsRuntimeArchive: false,
      });
    else
      update({
        runtime,
        ...(runtime.phase === 'error' ? { error: runtime.message, details: runtime.details } : {}),
      });
  },
});

const readinessNotice = createReadinessNotice({
  notify: async (eligible) => {
    const saved = await appPreferences.get();
    if (!eligible() || quitting || !preferences.notifications || foregroundWindow()) return false;
    if (!Notification.isSupported() || isQuietTime(saved.preferences)) return true;
    const notification = new Notification({
      title: 'Nod is ready',
      icon: notificationIcon,
      body: onboardingCompleted
        ? 'Your workspace and browser are ready.'
        : 'Your computer is ready. Come back to finish setup.',
    });
    displayedNotifications.add(notification);
    notification.on('show', () => {
      if (!displayedNotifications.has(notification) || !preferences.notifications || quitting)
        notification.close();
    });
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

function focusedEngineWindow() {
  return [...engineWindows].some((window) => !window.isDestroyed() && window.isFocused());
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

function bounded(value, limit = 2000) {
  let message = String(value || 'The operation could not be completed.');
  for (const secret of knownSecrets)
    if (secret.length > 7) message = message.replaceAll(secret, '[redacted]');
  return message.replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, limit);
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
  if (value.details) status.details = bounded(value.details, 256 * 1024);
  else if (Object.hasOwn(value, 'details') || Object.hasOwn(value, 'error') || value.phase)
    delete status.details;
  for (const window of [setupWindow, engineWindow])
    if (window && !window.isDestroyed()) window.webContents.send('nod:status', status);
  if (tray) tray.setToolTip(`Nod — ${status.phase === 'ready' ? 'Running' : status.message}`);
  showDownloadProgress();
  updateReadinessNotice();
}

function showDownloadProgress() {
  const progress = status.runtime?.progress;
  const downloading = Number.isFinite(progress);
  if (downloading || downloadShown)
    for (const window of [setupWindow, engineWindow])
      if (window && !window.isDestroyed()) window.setProgressBar(downloading ? progress : -1);
  downloadShown = downloading;
  bounceWhenReady ||= downloading;
  if (!bounceWhenReady || downloading || !status.engineReady) return;
  bounceWhenReady = false;
  if (!foregroundWindow()) app.dock?.bounce('informational');
}

function publicPreferences() {
  return {
    ...preferences,
    resolvedTheme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
  };
}

async function readDesktopSettings() {
  return {
    ...(remoteConnection
      ? { onboardingCompleted: true, onboardingPreferenceStep: 'complete' }
      : await settings.get()),
    ...publicPreferences(),
  };
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
  if (
    !preferences.notifications ||
    !(engine || remoteConnection) ||
    status.phase !== 'ready' ||
    quitting
  ) {
    const clear = !preferences.notifications || quitting;
    stopNotifications?.({ clear });
    stopNotifications = undefined;
    if (clear) {
      unreadBadge?.stop();
      unreadBadge = undefined;
      for (const notification of displayedNotifications) notification.close();
      displayedNotifications.clear();
    }
    return;
  }
  if (!stopNotifications) {
    const cursors = chatReadCursors;
    const owner = remoteConnection?.cursorOwner;
    const badge = createUnreadBadge({
      initialCount: unreadBadge?.count,
      request: (path, options) => engineRequest(path, options),
      readCursor: async (threadId) => cursors.get(owner ?? (await profileOwner()), threadId),
      writeCursor: async (threadId, cursor) =>
        cursors.set(owner ?? (await profileOwner()), threadId, cursor),
      onCount: (count) => {
        if (unreadBadge === badge)
          app.dock?.setBadge(count ? (count >= 100 ? '99+' : String(count)) : '');
      },
    });
    unreadBadge = badge;
    const stop = watchAssistantMessages({
      request: (path, options) => engineRequest(path, options),
      onState: (state) => badge.update(state),
      onMessage: (message, threadId) =>
        void notifyAssistantMessage(message, threadId).catch(() => {}),
    });
    stopNotifications = (options) => {
      stop();
      badge.stop(options);
      if (options?.clear !== false && unreadBadge === badge) unreadBadge = undefined;
    };
  }
}

async function notifyAssistantMessage(message, threadId) {
  if (!preferences.notifications || !Notification.isSupported() || quitting) return;
  if ([...engineWindows].some((window) => !window.isDestroyed() && window.isFocused())) return;
  const sourceEngine = remoteConnection || engine;
  const saved = await appPreferences.get();
  if (
    !sourceEngine ||
    (remoteConnection || engine) !== sourceEngine ||
    !preferences.notifications ||
    quitting ||
    isQuietTime(saved.preferences) ||
    [...engineWindows].some((window) => !window.isDestroyed() && window.isFocused())
  )
    return;
  const notification = new Notification({
    title: 'Nod',
    icon: notificationIcon,
    body: assistantNotificationPreview(message, knownSecrets),
  });
  displayedNotifications.add(notification);
  notification.on('show', () => {
    if (!displayedNotifications.has(notification) || !preferences.notifications || quitting)
      notification.close();
  });
  notification.on('click', () => {
    if (quitting) return;
    showEngine();
    const window = engineWindow;
    if (!window || window.isDestroyed() || status.phase !== 'ready') return;
    const focus = () => {
      if (quitting || window.isDestroyed() || status.phase !== 'ready') return;
      window.webContents.send(
        'nod:focus-message',
        (remoteConnection || engine) === sourceEngine ? { threadId, messageId: message.id } : null,
      );
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', focus);
    else focus();
  });
  notification.on('close', () => displayedNotifications.delete(notification));
  notification.on('failed', () => displayedNotifications.delete(notification));
  app.dock?.bounce('informational');
  notification.show();
}

function showNotificationConfirmation() {
  if (!preferences.notifications || quitting || !Notification.isSupported()) return;
  const notification = new Notification({
    title: 'Nod',
    icon: notificationIcon,
    body: 'Notifications are on.',
  });
  displayedNotifications.add(notification);
  notification.on('show', () => {
    if (!displayedNotifications.has(notification) || !preferences.notifications || quitting)
      notification.close();
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
  const line = bounded(value, 256 * 1024)
    .replaceAll(engineRoot, '<engine>')
    .replaceAll(profileRoot, '<profile>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<address>');
  await appendFile(path, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function isSetupURL(url) {
  return setupResource(url) === 'index.html';
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

function isTrustedAppFrame(sender, details) {
  return Boolean(
    engineBound &&
    details?.isMainFrame === true &&
    trustedAppURL(details.requestingUrl) &&
    (details.securityOrigin === undefined || trustedAppURL(details.securityOrigin)) &&
    isEngine({ sender, senderFrame: sender?.mainFrame }),
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
        message: 'Nod could not save the file to Downloads.',
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
      (appOpenPath(`nod://open${url.pathname}`, appPages) !== null ||
        ['/onboarding', '/you', '/memory', '/trust', '/browser', '/privacy', '/privacy/'].includes(
          url.pathname,
        ) ||
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
  window.webContents.on('will-prevent-unload', (event) => {
    if (quitting) event.preventDefault();
  });
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
            ...rendererSecurity,
            partition: clientPartition,
            additionalArguments: remoteConnection ? ['--nod-remote'] : [],
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
  if (!loading && onboardingCompleted && (engine || remoteConnection) && status.phase === 'ready') {
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
  const resumed = resumeWindow;
  resumeWindow = undefined;
  setupWindow = new BrowserWindow({
    show: false,
    ...(resumed?.bounds ?? { width: 1200, height: 860 }),
    minWidth: 700,
    minHeight: 600,
    title: 'Nod',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 20, y: 17 } } : {}),
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'index.cjs'),
      ...rendererSecurity,
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
    update({ windowError: 'Nod could not open setup. Try again.' });
    void dialog.showMessageBox({
      type: 'error',
      message: 'Nod could not open setup.',
      detail: 'Close and reopen Nod to try again. Your progress is saved.',
      buttons: ['OK'],
    });
  };
  waitForRenderer(
    window,
    () => {
      if ((!quitting || status.phase === 'updating') && !window.isDestroyed()) {
        window.show();
        if (
          section === 'general' &&
          !onboardingCompleted &&
          !welcomePassed &&
          !remoteConnection &&
          !connectionSettingsOpen &&
          !onboardingSetupOpen
        ) {
          appOpeningAt ??= Date.now();
          captureFreshAppOpen();
        }
        if (resumed?.maximized) window.maximize();
      }
      presented();
    },
    failed,
  );
  protectWindow(window);
  window.on('closed', () => {
    pendingRenderers.delete(window);
    presented();
    if (setupWindow === window) {
      setupWindow = undefined;
      connectionSettingsOpen = false;
      onboardingSetupOpen = false;
    }
  });
  setupWindowLoaded = Promise.all([
    window
      .loadURL(
        `${setupURL}?${new URLSearchParams({
          firstSetup: String(!onboardingCompleted),
          ...(section === 'server' ? { server: 'true' } : {}),
          ...(section === 'onboarding'
            ? { onboarding: 'true', remote: String(Boolean(remoteConnection || status.remote)) }
            : {}),
          ...(status.unlockingKeys ? { unlocking: process.platform } : {}),
        })}`,
      )
      .catch(failed),
    ready,
  ]);
  return setupWindowLoaded;
}

function showEngine({ focus = true } = {}) {
  if (quitting) return;
  if (
    (connectionSettingsOpen || onboardingSetupOpen) &&
    setupWindow &&
    !setupWindow.isDestroyed()
  ) {
    if (focus) {
      setupWindow.show();
      setupWindow.focus();
    }
    return;
  }
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
    deliverAppLink(engineWindow);
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
    title: 'Nod',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#fafafa',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 20, y: 17 } } : {}),
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'engine.cjs'),
      ...rendererSecurity,
      partition: clientPartition,
      additionalArguments: remoteConnection ? ['--nod-remote'] : [],
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
    update({ windowError: 'Nod could not open. Try again.' });
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
          if (startup.isMaximized()) window.maximize();
        }
        startup.destroy();
      } else if (!previousSetup || engineFocusRequested) {
        if (focus || engineFocusRequested) window.show();
        else window.showInactive();
      }
      deliverFeedbackRequest(window);
      deliverAppLink(window);
      void loaded.then(() => {
        if (!quitting && !window.isDestroyed() && replayingProductOnboarding) showEngine();
      });
    },
    failed,
  );
  window.webContents.on('did-finish-load', () => {
    deliverFeedbackRequest(window);
    deliverAppLink(window);
  });
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

function deliverAppLink(window) {
  if (
    quitting ||
    !pendingAppPath ||
    !onboardingCompleted ||
    window.isDestroyed() ||
    pendingRenderers.has(window) ||
    window.webContents.isLoadingMainFrame()
  )
    return;
  window.webContents.send('nod:navigate', pendingAppPath);
  pendingAppPath = undefined;
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

function availablePort(preferred = 0) {
  return new Promise((accept, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(preferred, '127.0.0.1', () => {
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
      'NOD_ONBOARDING_EMAIL_URL',
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
      serviceName: 'Nod 1Password',
      allowLoadingUnsignedLibraries: true,
    },
  );
  const { port1, port2 } = new MessageChannelMain();
  helper.postMessage({ type: 'nod-1password-port' }, [port2]);
  owner.postMessage({ type: 'nod-1password-port' }, [port1]);
  owner.once('exit', () => helper.kill());
}

async function moveToTrash(child, { id, path }) {
  if (typeof id !== 'string' || typeof path !== 'string' || !isAbsolute(path)) return;
  const error = await shell.trashItem(path).then(
    () => undefined,
    () => 'The item could not be moved to the Trash.',
  );
  if (engine === child)
    child.postMessage({ type: 'nod-trash-result', id, ...(error ? { error } : {}) });
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

async function captureNativeAnalytics({
  event,
  distinctId,
  openedAt,
  uuid,
  properties,
  verifyConsent,
}) {
  try {
    const route = event === 'server_connection_verified' ? '/server' : '/onboarding';
    const { nodBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
    const saved = await settings.get();
    if (saved.welcome?.usageData === false) deferAppOpening();
    if (appOpeningDeferred) return false;
    if (verifyConsent && !(await verifyConsent())) return false;
    if (appOpeningDeferred) return false;
    const response = await fetch(`${posthogConfig.host}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3_000),
      body: JSON.stringify({
        api_key: posthogConfig.key,
        event,
        distinct_id: distinctId,
        uuid,
        timestamp: new Date(openedAt).toISOString(),
        properties: {
          analytics_schema: posthogConfig.schemaVersion,
          environment: analyticsEnvironment(nodBuild),
          surface: 'desktop',
          app_version: app.getVersion(),
          ...properties,
          route,
          $current_url: `https://app.example${route}`,
          $pathname: route,
          $host: 'app.example',
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
    });
    if (response.status !== 200) {
      void response.body?.cancel().catch(() => {});
      return false;
    }
    const result = await response.json();
    const limited = result?.quota_limited;
    const accepted =
      result?.status === 'Ok' &&
      (limited == null ||
        limited === '' ||
        (Array.isArray(limited) && limited.length === 0) ||
        (typeof limited === 'object' && Object.keys(limited).length === 0));
    return accepted;
  } catch {
    return false;
  }
}

function captureFreshAppOpen() {
  if (
    !freshLocalProfile ||
    !app.isPackaged ||
    testInstall ||
    process.env.NOD_ANALYTICS_ENABLED === 'false' ||
    process.env.NOD_ANALYTICS_ID ||
    freshAppOpenCapture
  )
    return;
  freshAppOpenCapture = (async () => {
    const saved = await settings.get().catch(() => null);
    if (
      !saved ||
      saved.serverUrl ||
      saved.onboardingCompleted ||
      saved.welcome ||
      remoteConnection ||
      onboardingCompleted ||
      welcomePassed ||
      connectionSettingsOpen ||
      onboardingSetupOpen
    )
      return false;
    const analytics = await analyticsConfiguration().catch(() => null);
    if (!analytics?.enabled || !analytics.distinctId) return false;
    const openedAt = appOpeningAt ?? Date.now();
    const uuid = randomUUID();
    freshAppOpening = { distinctId: analytics.distinctId, openedAt, uuid };
    const accepted = await captureNativeAnalytics({
      event: 'app_opened',
      distinctId: analytics.distinctId,
      openedAt,
      uuid,
      properties: { entry: 'native_setup', server_connection_telemetry_available: true },
    });
    if (accepted) claimedAppOpens.add(analytics.distinctId);
    return accepted;
  })().catch(() => false);
}

function captureStartupPath(path) {
  if (appOpeningDeferred || onboardingCompleted || welcomePassed || remoteConnection) return;
  const openedAt = Date.now();
  return Promise.resolve(freshAppOpenCapture)
    .then(async () => {
      if (appOpeningDeferred) return;
      const saved = await settings.get();
      if (
        appOpeningDeferred ||
        saved.welcome?.usageData === false ||
        saved.welcome?.continued === true
      )
        return;
      if (
        saved.welcome?.usageData !== true &&
        !(freshLocalProfile && freshAppOpening && !saved.welcome)
      )
        return;
      const analytics = await analyticsConfiguration();
      if (!analytics.enabled || !analytics.distinctId) return;
      if (freshAppOpening && freshAppOpening.distinctId !== analytics.distinctId) return;
      return captureNativeAnalytics({
        event: 'startup_path_selected',
        distinctId: analytics.distinctId,
        openedAt,
        uuid: randomUUID(),
        properties: { path },
      });
    })
    .catch(() => {});
}

async function engineRequest(path, options = {}) {
  if (!engineBound) throw new Error('Nod is not ready.');
  return fetch(`${engineOrigin}${path}`, {
    ...options,
    headers: { ...options.headers, ...authenticationHeaders() },
    redirect: 'error',
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
}

function authenticationHeaders() {
  return remoteConnection
    ? { Authorization: `Bearer ${authToken}` }
    : { 'x-nod-desktop-token': authToken };
}

function configureAppSession() {
  const appSession = session.fromPartition(clientPartition);
  if (app.isPackaged)
    appSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType !== 'mainFrame' || !trustedAppURL(details.url)) return callback({});
      const headers = { ...details.responseHeaders };
      const name =
        Object.keys(headers).find((key) => key.toLowerCase() === 'content-security-policy') ??
        'Content-Security-Policy';
      headers[name] = [...(headers[name] ?? []), appContentPolicy];
      callback({ responseHeaders: headers });
    });
  appSession.setPermissionCheckHandler((sender, permission, origin, details) => {
    return (
      (permission === 'notifications' ||
        permission === 'clipboard-sanitized-write' ||
        (permission === 'media' && details.mediaType === 'audio')) &&
      trustedAppURL(origin) &&
      isTrustedAppFrame(sender, details)
    );
  });
  appSession.setPermissionRequestHandler((sender, permission, callback, details) => {
    callback(
      (permission === 'notifications' ||
        permission === 'clipboard-sanitized-write' ||
        (permission === 'media' &&
          details.mediaTypes?.length === 1 &&
          details.mediaTypes[0] === 'audio')) &&
        isTrustedAppFrame(sender, details),
    );
  });
  appSession.on('will-download', saveEngineDownload);
  appSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    for (const key of Object.keys(headers))
      if (['x-nod-desktop-token', 'authorization'].includes(key.toLowerCase())) delete headers[key];
    const window = [...engineWindows].find(
      (candidate) => !candidate.isDestroyed() && details.webContentsId === candidate.webContents.id,
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
      Object.assign(headers, authenticationHeaders());
    callback({ requestHeaders: headers });
  });
}

function showConnectionSettings() {
  if (quitting) return;
  const returnToOnboarding = onboardingSetupOpen;
  captureStartupPath('remote');
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
  connectionReturnsToOnboarding = returnToOnboarding;
  connectionSettingsOpen = true;
  return showSettings('server', true);
}

async function checkRemoteConnection(connection) {
  const url = serverOrigin(connection.url);
  if (typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{43,}$/.test(connection.token))
    throw new Error('Enter the authentication token configured on your server.');
  knownSecrets.add(connection.token);
  let response;
  try {
    response = await fetch(`${url}/api/session`, {
      headers: { Authorization: `Bearer ${connection.token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Error('Could not reach your server. Check its address and HTTPS certificate.');
  }
  if (response.status === 401 || response.status === 403)
    throw new Error('Your server rejected this token. Check its address and authentication token.');
  let account;
  try {
    account = await response.json();
  } catch {}
  if (
    !response.ok ||
    !account ||
    typeof account.user?.id !== 'string' ||
    !account.user.id ||
    account.user.id.length > 200 ||
    typeof account.settings?.onboardingCompleted !== 'boolean'
  )
    throw new Error('This address did not respond as a Nod server.');
  const revision = account.settings.usageDataRevision;
  const usageDataRevision =
    typeof revision === 'string' && /^(?:0|[1-9]\d{0,18})$/.test(revision) ? revision : null;
  return {
    url,
    token: connection.token,
    owner: account.user.id,
    usageDataRevision,
    analyticsAllowed:
      usageDataRevision !== null &&
      account.settings.usageData === true &&
      account.analytics?.enabled === true,
  };
}

async function startRemote(connection) {
  update({ remote: true, phase: 'starting', message: 'Connecting to your server.' });
  const connected = await checkRemoteConnection(connection);
  if (quitting) return;
  remoteConnection = { url: connected.url, token: connected.token, owner: connected.owner };
  const activeConnection = remoteConnection;
  engineOrigin = connected.url;
  authToken = connected.token;
  engineBound = true;
  enginePreferencesReady = true;
  engineRuntimeReady = true;
  onboardingCompleted = true;
  welcomePassed = true;
  const id = createHash('sha256').update(`${connected.url}\0${connected.owner}`).digest('hex');
  const directory = join(app.getPath('userData'), 'profiles', 'servers', id);
  clientPartition = `persist:nod-server-${id}`;
  configureAppSession();
  appPreferences = createAppPreferencesStore(join(directory, 'preferences.json'), {
    request: (path, options) => engineRequest(path, options),
    isReady: () => engineBound && !quitting,
  });
  const cursorOwner = `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
  remoteConnection.cursorOwner = cursorOwner;
  chatReadCursors = createChatReadCursorStore(join(directory, 'chat-read-cursors.json'), {
    owner: async () => cursorOwner,
  });
  update({
    phase: 'ready',
    message: 'Connected to your server.',
    needsServerConnection: false,
    engineReady: true,
    runtime: { phase: 'ready', message: 'Your server is ready.' },
  });
  synchronizeNotifications();
  showEngine();
  if (connected.analyticsAllowed && !testInstall)
    void analyticsConfiguration()
      .then((analytics) => {
        if (!analytics.enabled || !analytics.distinctId || quitting) return;
        return captureNativeAnalytics({
          event: 'server_connection_verified',
          distinctId: analytics.distinctId,
          openedAt: Date.now(),
          uuid: randomUUID(),
          properties: {},
          verifyConsent: async () => {
            if (quitting || remoteConnection !== activeConnection) return false;
            const current = await checkRemoteConnection(activeConnection);
            return (
              !quitting &&
              remoteConnection === activeConnection &&
              current.owner === connected.owner &&
              current.analyticsAllowed &&
              current.usageDataRevision === connected.usageDataRevision
            );
          },
        });
      })
      .catch(() => {});
  return status;
}

async function saveConnection(input) {
  if (quitting) throw new Error('Nod is closing.');
  if (input !== null) {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new Error('Enter your server address and authentication token.');
    await checkRemoteConnection(input);
  }
  if (!(await confirmRestart())) return;
  await settings.saveConnection(input);
  await quit(() => {
    app.relaunch();
    app.exit();
  });
}

async function stopEngine() {
  enginePreferencesReady = false;
  engineRuntimeReady = false;
  stopNotifications?.();
  stopNotifications = undefined;
  unreadBadge?.stop();
  unreadBadge = undefined;
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
          reject(new Error('The previous Nod process has not stopped. Quit and reopen the app.')),
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
      if (!response.ok) throw new Error('Nod could not save your choice. Try again.');
      const result = await response.json();
      if (result.settings?.usageData !== saved.welcome.usageData)
        throw new Error('Nod could not confirm your choice. Try again.');
      await settings.acknowledgeWelcome(saved.welcome);
    }
    if (engineFailure) throw new Error(engineFailure);
    welcomeNavigation = true;
    welcomePassed = true;
    welcomeTransferError = undefined;
    update({
      phase: engineRuntimeReady ? 'ready' : 'preparing',
      message: engineRuntimeReady ? 'Nod is running on your computer.' : status.runtime.message,
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
  if (quitting || !engine) throw new Error(engineFailure || 'Nod is closing.');
  if (!onboardingCompleted) {
    const response = await engineRequest('/api/session');
    if (response.ok && (await response.json()).settings?.onboardingCompleted === true) {
      const saved = await settings.get();
      if (saved.onboardingPreferenceStep === 'complete' || saved.launchAtLogin) {
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
  if (quitting || !engine) throw new Error(engineFailure || 'Nod is closing.');
  if (!pending && !engineRuntimeReady) {
    engine.postMessage({ type: 'nod-runtime-ready' });
    engineRuntimeReady = true;
  }
  update({
    phase: pending ? 'preparing' : 'ready',
    stage: pending ? status.runtime.stage : 'ready',
    message: pending ? status.runtime.message : 'Nod is running on your computer.',
    progress: pending ? status.runtime.progress : undefined,
    secondsLeft: pending ? status.runtime.secondsLeft : undefined,
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

function publicUpdateStatus() {
  return {
    phase: updatePhase,
    checking: Boolean(checkingUpdates),
    ...(updateProgress === undefined ? {} : { progress: updateProgress }),
    ...(updates?.ready ? { readyVersion: updates.ready.version } : {}),
    ...(dismissedUpdateVersion ? { dismissedVersion: dismissedUpdateVersion } : {}),
  };
}

function publishUpdateStatus() {
  const value = publicUpdateStatus();
  for (const window of engineWindows)
    if (!window.isDestroyed()) window.webContents.send('nod:updates:status', value);
}

function refreshUpdateMenu() {
  if (quitting) return;
  const label =
    updatePhase === 'downloading' && updateProgress !== undefined
      ? `Downloading update… ${updateProgress}%`
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
  const restartLabel = updates?.ready
    ? `Restart to update to ${updates.ready.version}…`
    : 'Restart to update…';
  const restartItem = Menu.getApplicationMenu?.()?.getMenuItemById('desktop-restart');
  if (restartItem) {
    restartItem.label = restartLabel;
    restartItem.visible = Boolean(updates?.ready);
    restartItem.enabled = Boolean(updates?.ready) && !checkingUpdates;
  }
  if (tray)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Nod', click: showEngine },
        { label: 'Settings…', click: () => showSettings() },
        { label: 'Send feedback…', click: showFeedback },
        {
          label,
          enabled: Boolean(updates) && !checkingUpdates,
          click: () => void checkForUpdates(),
        },
        {
          label: restartLabel,
          visible: Boolean(updates?.ready),
          enabled: Boolean(updates?.ready) && !checkingUpdates,
          click: () => void checkForUpdates(true, true),
        },
        { type: 'separator' },
        { label: 'Quit Nod', click: () => app.quit() },
      ]),
    );
  publishUpdateStatus();
}

async function checkForUpdates(manual = true, restartReady = false) {
  if (!updates || quitting) return;
  if (checkingUpdates) {
    if (manual) updateRequestedManually = true;
    return checkingUpdates;
  }
  updateRequestedManually = manual;
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
        const previousVersion = updates.ready?.version;
        const candidate = restartReady ? updates.ready : await updates.check();
        updateFailed = false;
        if (quitting) return;
        if (!candidate) {
          if (updateRequestedManually)
            await dialog.showMessageBox({ message: 'Nod is up to date.', buttons: ['OK'] });
          return;
        }
        if (!updateRequestedManually) {
          if (candidate.version !== previousVersion) await notifyUpdate(candidate);
          if (!updateRequestedManually || quitting) return;
        }
        const { response } = await dialog.showMessageBox({
          message: `Nod ${candidate.version} is ready.`,
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
        if (!restarting) updateFailed = true;
        await writeDiagnostic(error.message).catch(() => {});
        if (quitting) return;
        if (!updateRequestedManually && !restarting) throw error;
        const { response } = await dialog.showMessageBox({
          type: 'info',
          message: restarting ? 'Couldn’t restart Nod' : 'Couldn’t check for updates',
          detail: 'You can keep using Nod and try again later.',
          buttons: [restarting ? 'Retry restart' : 'Try again', 'Not now'],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0 || quitting) return;
      }
    }
  })().finally(release);
  checkingUpdates = checking;
  refreshUpdateMenu();
  return checking;
}

async function notifyUpdate(candidate) {
  if (
    !preferences.notifications ||
    !Notification.isSupported() ||
    quitting ||
    focusedEngineWindow()
  )
    return false;
  if (
    isQuietTime((await appPreferences.get()).preferences) ||
    !preferences.notifications ||
    quitting ||
    focusedEngineWindow()
  )
    return true;
  const notification = new Notification({
    title: `Nod ${candidate.version} is ready`,
    icon: notificationIcon,
    body: 'Restart Nod to use the new version.',
  });
  displayedNotifications.add(notification);
  notification.on('show', () => {
    if (
      !displayedNotifications.has(notification) ||
      !preferences.notifications ||
      quitting ||
      focusedEngineWindow()
    )
      notification.close();
  });
  notification.on('click', () => {
    if (!quitting && (checkingUpdates || updates?.ready)) void checkForUpdates(true, true);
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
  update({ phase: 'updating', message: 'Updating…' });
  const window = [engineWindow, setupWindow].find((item) => item && !item.isDestroyed());
  if (engineWindow && !engineWindow.isDestroyed()) engineWindow.show();
  else await showSettings('general', true);
  await rememberState(window);
  await quit(installUpdate);
}

async function rememberState(window) {
  session.fromPartition(clientPartition).flushStorageData();
  const state = JSON.stringify({
    path: URL.parse(window?.webContents.getURL() ?? '')?.pathname,
    bounds: window?.getNormalBounds(),
    maximized: window?.isMaximized(),
    port: remoteConnection ? undefined : Number(URL.parse(engineOrigin)?.port) || undefined,
  });
  await mkdir(profileRoot, { recursive: true, mode: 0o700 })
    .then(() => writeFile(resumePath, state, { mode: 0o600 }))
    .catch(() => {});
}

async function resumeState() {
  const text = await resumeRead;
  if (text === undefined) return;
  await rm(resumePath, { force: true }).catch(() => {});
  try {
    const saved = JSON.parse(text);
    pendingAppPath ||= appOpenPath(`nod://open${saved.path}`, appPages) || undefined;
    if (Number.isInteger(saved.port) && saved.port > 1023 && saved.port < 65536)
      resumePort = saved.port;
    const { x, y, width, height } = saved.bounds;
    if (
      [x, y, width, height].every(Number.isInteger) &&
      screen
        .getAllDisplays()
        .some(
          ({ workArea: area }) =>
            x < area.x + area.width &&
            x + width > area.x &&
            y < area.y + area.height &&
            y + height > area.y,
        )
    )
      resumeWindow = { bounds: { x, y, width, height }, maximized: saved.maximized === true };
  } catch {}
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
    message: work.length ? 'Nod is still working.' : 'Nod could not check its current work.',
    detail: work.length
      ? `Restarting now stops ${new Intl.ListFormat('en').format(work)}. You can ask Nod to continue afterwards.`
      : 'Restarting now may stop a task in progress.',
    buttons: ['Restart now', 'Later'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  return response === 0 && !quitting;
}

async function installUpdate() {
  if (process.platform === 'win32') {
    await startWindowsInstall({
      directory: join(windowsUpdates, updates.ready.version),
      appPath: process.execPath,
      pid: process.pid,
      systemRoot: process.env.SystemRoot,
    });
    installingUpdate = true;
    app.exit();
    return;
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

async function quit(complete, failure = 'Nod could not finish shutting down.') {
  quitting = true;
  stopUpdateChecks?.();
  const stoppingUpdates = updates?.dispose();
  updateReadinessNotice();
  stopNotifications?.();
  unreadBadge?.stop();
  unreadBadge = undefined;
  for (const notification of displayedNotifications) notification.close();
  await stoppingUpdates;
  await chatReadCursors.flush().catch(() => {});
  await finishQuit(complete, failure);
}

async function removeAllData() {
  if (quitting) return;
  if (remoteConnection) return replayOnboarding();
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: 'Remove all data and start over?',
    detail:
      'This permanently deletes your conversations, unsent drafts, files, memory, saved logins, cards, model and app connections, and settings from this computer. You cannot undo this.\n\nNod stays installed and restarts automatically. You will need to complete setup again.',
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
    app.relaunch();
    app.exit();
  }, 'Nod could not remove all its data.');
}

async function finishQuit(complete, failure) {
  while (true) {
    try {
      await disposeArtifactFiles?.();
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
  if (quitting) throw new Error('Nod is closing.');
}

async function startEngine({ runtime, signal, pending = false }) {
  if (engineFailure) throw new Error(engineFailure);
  if (engine && enginePreferencesReady) return finishEnginePreparation(pending);
  if (engine) {
    if (!(await confirmRestart()))
      throw Object.assign(new Error('Restart Nod when it finishes its current work.'), {
        code: 'NOD_RESTART_DEFERRED',
      });
    await stopEngine();
  }
  if (quitting) throw new Error('Nod is closing.');
  const startup = setupWindow;
  if (startup && pendingRenderers.has(startup)) await setupWindowLoaded;
  if (quitting || signal.aborted) throw new Error('Nod is closing.');
  if (startup?.isDestroyed() || status.windowError)
    throw new Error('Nod could not open setup. Reopen the window, then try again.');
  const port = await availablePort(resumePort).catch(() => availablePort());
  if (quitting || signal.aborted) throw new Error('Nod is closing.');
  engineBound = false;
  authToken = randomBytes(32).toString('base64url');
  knownSecrets.add(authToken);
  engineOrigin = `http://127.0.0.1:${port}`;
  update({
    phase: 'starting',
    stage: 'storage',
    message: 'Unlocking your saved API keys…',
    unlockingKeys: true,
  });
  await new Promise((accept) => setTimeout(accept, 50));
  if (quitting || signal.aborted) throw new Error('Nod is closing.');
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
    NOD_HOST: '127.0.0.1',
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
  if (quitting || signal.aborted) throw new Error('Nod is closing.');
  update({
    phase: 'starting',
    message: 'Starting Nod.',
    needsRuntimeArchive: false,
    unlockingKeys: false,
  });
  const child = utilityProcess.fork(join(engineRoot, 'desktop', 'main', 'engine.mjs'), [], {
    cwd: engineRoot,
    env: environment,
    stdio: 'pipe',
    serviceName: 'Nod engine',
  });
  engine = child;
  child.on('message', (message) => {
    if (engine === child && message?.type === 'nod-ready' && message.port === port) {
      engineBound = true;
    }
    if (engine === child && message?.type === 'nod-1password-open') openOnePassword(child);
    if (engine === child && message?.type === 'nod-trash') void moveToTrash(child, message);
  });
  child.stdout?.resume();
  let diagnostics = '';
  let failure = '';
  child.stderr?.on('data', (chunk) => {
    if (enginePreferencesReady && engineRuntimeReady) return;
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
    if (!closingEngine)
      failure =
        (status.phase === 'error' && status.error) ||
        (status.runtime.phase === 'error' && status.runtime.message) ||
        failure ||
        `Nod’s background service stopped${enginePreferencesReady ? '' : ' before it was ready'}${Number.isInteger(code) ? ` (code ${code})` : ''}. Try again to restart it.`;
    stopNotifications?.({ clear: closingEngine || quitting });
    stopNotifications = undefined;
    if (!closingEngine) void writeDiagnostic(`Engine exited with code ${code}.`).catch(() => {});
    engine = undefined;
    enginePreferencesReady = false;
    engineOrigin = '';
    engineBound = false;
    authToken = '';
    engineRuntimeReady = false;
    update({ engineReady: false });
    if (status.phase !== 'updating') {
      for (const window of engineWindows) if (!window.isDestroyed()) window.destroy();
      engineWindows.clear();
    }
    if (!quitting && !closingEngine) {
      engineFailure = failure;
      update({
        phase: 'error',
        message: failure,
        error: failure,
      });
      showSettings('general', true);
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
  if (!ready || engine !== child || signal.aborted) {
    await stopEngine();
    throw new Error(
      failure || 'Nod’s background service did not respond. Try again to restart it.',
    );
  }
  enginePreferencesReady = true;
  return finishEnginePreparation(pending);
}

async function prepare(options = {}) {
  if (engineFailure && options?.retry !== true) return status;
  if (preparing) {
    const retryAfterFailure = options?.retry === true && status.phase === 'error';
    await preparing;
    return retryAfterFailure ? prepare(options) : status;
  }
  if (options?.retry === true) engineFailure = undefined;
  preparing = (async () => {
    if (status.remote)
      update({
        phase: 'starting',
        unlockingKeys: true,
        message: 'Unlocking your saved server token…',
      });
    const connection = await settings.connection();
    if (quitting) return status;
    if (status.unlockingKeys) update({ unlockingKeys: false });
    if (connection) return startRemote(connection);
    update({
      phase: 'preparing',
      windowError: undefined,
      needsServerConnection: false,
      message: status.runtime.message,
      progress: status.runtime.progress,
      secondsLeft: status.runtime.secondsLeft,
      needsRuntimeArchive: false,
    });
    return lifecycle.start({ retry: options?.retry === true });
  })()
    .catch((error) => {
      void writeDiagnostic(startupErrorDetails(error)).catch(() => {});
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
        details: startupErrorDetails(error),
        needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
        needsWsl: error.code === 'NOD_WSL_REQUIRED',
        needsServerConnection: error.code === 'NOD_SERVER_TOKEN_UNAVAILABLE',
      });
      return status;
    })
    .finally(() => {
      preparing = undefined;
    });
  return preparing;
}

function replayOnboarding() {
  if (quitting) return status;
  if (onboardingSetupOpen && setupWindow && !setupWindow.isDestroyed()) {
    showEngine();
    return status;
  }
  if (setupWindow && !setupWindow.isDestroyed()) setupWindow.destroy();
  onboardingSetupOpen = true;
  void showSettings('onboarding', true);
  return status;
}

async function importRuntime() {
  if (lifecycle.busy || quitting) throw new Error('Wait for Nod to finish its current setup step.');
  const chosen = await dialog.showOpenDialog(setupWindow, {
    title: 'Choose the Nod Runtime pack',
    buttonLabel: 'Install runtime',
    properties: ['openFile'],
    filters: [{ name: 'Nod Runtime pack', extensions: ['gz', 'tgz'] }],
  });
  if (chosen.canceled || !chosen.filePaths[0] || quitting) return status;
  if (lifecycle.busy) throw new Error('Wait for Nod to finish its current setup step.');
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
else if (process.argv.includes('--quit')) app.exit();
else {
  if (testInstall) process.on('SIGTERM', () => app.quit());
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--quit')) return void app.quit();
    const path = argv.map((value) => appOpenPath(value, appPages)).find(Boolean);
    if (path) pendingAppPath = path;
    showEngine();
  });
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
      app.setName(appName);
      const setupSession = session.fromPartition('nod-settings');
      setupSession.setPermissionCheckHandler(() => false);
      setupSession.setPermissionRequestHandler((_sender, _permission, callback) => callback(false));
      setupSession.protocol.handle('nod-setup', async (request) => {
        const file = setupResource(request.url);
        if (!file || !['GET', 'HEAD'].includes(request.method))
          return new Response('Not found', { status: 404 });
        const response = await net.fetch(pathToFileURL(join(dirname(setupPath), file)).href);
        const headers = new Headers(response.headers);
        headers.set(
          'Content-Security-Policy',
          "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        );
        headers.set('X-Content-Type-Options', 'nosniff');
        return new Response(request.method === 'HEAD' ? null : response.body, { headers });
      });
      appLinksReady = true;
      if (app.isPackaged && !testInstall) app.setAsDefaultProtocolClient('nod');
      if (
        app.isPackaged &&
        !testInstall &&
        process.platform === 'darwin' &&
        !app.isInApplicationsFolder()
      ) {
        const { response } = await dialog.showMessageBox({
          message: 'Move Nod to your Applications folder?',
          detail: 'Nod can update itself only from Applications.',
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
          prepareRuntime: async (candidate, signal, report) => {
            const saved = await settings.get();
            const includeRuntime =
              !saved.serverUrl && (saved.onboardingCompleted || saved.welcome?.continued === true);
            if (windows) {
              const { stageWindowsUpdate } = await import(
                pathToFileURL(join(engineRoot, 'desktop/runtime/windows.mjs')).href
              );
              return stageWindowsUpdate(candidate, {
                directory: windowsUpdates,
                resourcesPath: engineRoot,
                signal,
                includeRuntime,
                onProgress: (progress) => report('downloading', progress),
              });
            }
            if (!includeRuntime) return;
            const { prepareRuntimeUpdate } = await import(
              pathToFileURL(join(engineRoot, 'desktop/runtime/assets.mjs')).href
            );
            const assets = await prepareRuntimeUpdate(candidate.runtime, {
              resourcesPath: engineRoot,
              downloadUrl: candidate.downloadUrl,
              signal,
              onStatus: ({ progress }) => {
                if (Number.isFinite(progress)) report('downloading', progress);
              },
            });
            report('preparing');
            if (!engine || closingEngine) pendingPreload = assets;
            else await preloadUpdateImages(assets, signal);
          },
          restart: restartForUpdate,
          onStatus: (phase, progress) => {
            const percent = Number.isFinite(progress)
              ? Math.min(100, Math.max(0, Math.floor(progress * 100)))
              : undefined;
            if (phase === updatePhase && percent === updateProgress) return;
            updatePhase = phase;
            updateProgress = percent;
            refreshUpdateMenu();
          },
        });
        stopUpdateChecks = startDesktopUpdateChecks({
          check: () => checkForUpdates(false),
          powerMonitor,
        });
      }
      nativeTheme.on('updated', publishPreferences);
      configureAppSession();
      const image = nativeImage.createFromPath(join(desktopRoot, 'main', 'trayTemplate.png'));
      image.setTemplateImage(true);
      tray = new Tray(image);
      if (process.platform !== 'darwin') tray.on('click', showEngine);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Nod',
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
                id: 'desktop-restart',
                label: 'Restart to update…',
                visible: false,
                click: () => void checkForUpdates(true, true),
              },
              { label: 'Replay onboarding…', click: replayOnboarding },
              {
                id: 'remove-local-data',
                label: 'Remove all data…',
                click: () => void removeAllData(),
              },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          {
            label: 'View',
            submenu: [
              { role: 'reload' },
              ...(!app.isPackaged ? [{ role: 'forceReload' }, { role: 'toggleDevTools' }] : []),
              { type: 'separator' },
              { role: 'resetZoom' },
              { role: 'zoomIn' },
              { role: 'zoomOut' },
              { type: 'separator' },
              { role: 'togglefullscreen' },
            ],
          },
          { role: 'windowMenu' },
        ]),
      );
      refreshUpdateMenu();
      disposeArtifactFiles = registerArtifactFileHandlers({
        isEngine,
        origin: () => engineOrigin,
        headers: authenticationHeaders,
        window: () => engineWindow,
        icon: join(desktopRoot, 'assets/nod-macos.png'),
      });
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
      ipcMain.handle('nod:updates:status', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return publicUpdateStatus();
      });
      ipcMain.handle('nod:updates:dismiss', (event, version) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (typeof version !== 'string' || updates?.ready?.version !== version) return;
        dismissedUpdateVersion = version;
        publishUpdateStatus();
      });
      ipcMain.handle('nod:updates:restart', async (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if ((!updates?.ready && !checkingUpdates) || quitting)
          throw new Error('No desktop update is ready.');
        await checkForUpdates(true, true);
      });
      ipcMain.handle('nod:settings:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return readDesktopSettings();
      });
      ipcMain.handle('nod:connection:get', (event) => {
        allowSetup(event);
        return settings.get().then((value) => ({ url: value.serverUrl || '' }));
      });
      ipcMain.handle('nod:connection:save', (event, value) => {
        allowSetup(event);
        return saveConnection(value);
      });
      ipcMain.handle('nod:connection:open', (event) => {
        allowSetup(event);
        return showConnectionSettings();
      });
      ipcMain.handle('nod:connection:close', (event) => {
        allowSetup(event);
        const returnToOnboarding = connectionSettingsOpen && connectionReturnsToOnboarding;
        captureStartupPath('welcome');
        setupWindow.destroy();
        if (returnToOnboarding) replayOnboarding();
        else showEngine();
      });
      ipcMain.handle('nod:onboarding:continue', (event) => {
        allowSetup(event);
        if (!onboardingSetupOpen) throw new Error('This setup action is unavailable.');
        setupWindow.destroy();
        replayingProductOnboarding = onboardingCompleted;
        showEngine();
      });
      ipcMain.handle('nod:feedback:context', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return feedbackContext();
      });
      ipcMain.handle('nod:feedback:capture', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return captureFeedbackScreenshot(event).catch(() => null);
      });
      ipcMain.handle('nod:analytics:opening', async (event, consented, distinctId) => {
        if (
          !isEngine(event) ||
          event.sender !== engineWindow?.webContents ||
          typeof consented !== 'boolean'
        )
          throw new Error('This action is unavailable.');
        if (!consented) {
          deferAppOpening();
          return null;
        }
        if (
          typeof distinctId !== 'string' ||
          !/^local:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            distinctId,
          )
        )
          throw new Error('The analytics installation ID is invalid.');
        const consentVersion = appOpeningConsentVersion;
        await freshAppOpenCapture;
        if (consentVersion !== appOpeningConsentVersion) return null;
        if (claimedAppOpens.has(distinctId)) return null;
        const native =
          !remoteConnection && !appOpeningDeferred && freshAppOpening?.distinctId === distinctId
            ? freshAppOpening
            : null;
        let opening = appUIOpenings.get(distinctId);
        if (!opening) {
          opening = {
            openedAt: native?.openedAt ?? Date.now(),
            uuid: native?.uuid ?? randomUUID(),
            entry: native ? 'native_setup' : 'app_ui',
            ...(native ? { serverConnectionTelemetryAvailable: true } : {}),
          };
          appUIOpenings.set(distinctId, opening);
        }
        return opening;
      });
      ipcMain.handle('nod:preferences:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return publicPreferences();
      });
      ipcMain.handle('nod:startup-log:show', async (event) => {
        if (!isSetup(event)) throw new Error('This action is unavailable.');
        await writeDiagnostic(
          [status.error || status.runtime.message || status.message, status.details]
            .filter(Boolean)
            .join('\n'),
        );
        if (!isSetup(event)) throw new Error('This action is unavailable.');
        shell.showItemInFolder(join(profileRoot, 'logs', 'startup.log'));
      });
      ipcMain.handle('nod:preferences:theme', async (event, theme) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('Nod is closing.');
        applyPreferences(await settings.save({ theme }));
        return publicPreferences();
      });
      ipcMain.handle('nod:settings:save', async (event, value) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        const allowed = ['theme', 'notifications', 'launchAtLogin'];
        if (isEngine(event) && !remoteConnection) allowed.push('onboardingCompleted');
        if (isEngine(event) && !onboardingCompleted) allowed.push('onboardingPreferenceStep');
        if (isSetup(event) && !onboardingCompleted) allowed.push('welcome');
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((field) => !allowed.includes(field))
        )
          throw new Error('These settings are not supported.');
        if (quitting) throw new Error('Nod is closing.');
        if (value.onboardingCompleted !== undefined) {
          const response = await engineRequest('/api/session');
          if (
            value.onboardingCompleted !== true ||
            !response.ok ||
            (await response.json()).settings?.onboardingCompleted !== true
          )
            throw new Error('Finish onboarding before continuing.');
        }
        let loginChanged = typeof value.launchAtLogin === 'boolean';
        let previousLogin;
        if (loginChanged) {
          try {
            previousLogin = app.getLoginItemSettings().openAtLogin;
            app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
            const login = app.getLoginItemSettings();
            if (
              (process.platform === 'win32'
                ? login.executableWillLaunchAtLogin
                : login.openAtLogin) !== value.launchAtLogin
            )
              throw new Error(
                'Open at login could not be updated. Check Nod in your computer’s login items, then try again.',
              );
          } catch (error) {
            if (value.onboardingPreferenceStep !== 'complete' || value.launchAtLogin !== true)
              throw error;
            if (typeof previousLogin === 'boolean') {
              try {
                app.setLoginItemSettings({ openAtLogin: previousLogin });
              } catch {}
            }
            value = { ...value };
            delete value.launchAtLogin;
            loginChanged = false;
          }
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
        if (value.welcome?.usageData === false) deferAppOpening();
        if (value.welcome?.continued === false) captureStartupPath('local');
        onboardingCompleted = remoteConnection ? true : saved.onboardingCompleted;
        if (onboardingCompleted) nativePreferencesPending = false;
        const confirmNotifications = value.notifications === true && !preferences.notifications;
        applyPreferences(saved);
        if (confirmNotifications) showNotificationConfirmation();
        for (const window of engineWindows) deliverAppLink(window);
        if (!['preparing', 'starting', 'error'].includes(status.phase))
          update({ message: 'Ready.' });
        return readDesktopSettings();
      });
      ipcMain.handle('nod:prepare', async (event, options) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        if (options?.retry === true && !enginePreferencesReady) welcomeTransferError = undefined;
        await transferWelcome();
        if (options?.retry === true && status.windowError) {
          showEngine();
          if (enginePreferencesReady && status.runtime.phase !== 'error') return status;
        }
        if (engineRuntimeReady || (!options?.retry && enginePreferencesReady && preparing))
          return status;
        return prepare(options);
      });
      ipcMain.handle('nod:warmup', async (event) => {
        allowSetup(event);
        const saved = await settings.get();
        if (onboardingCompleted || status.remote || quitting || saved.serverUrl) return;
        if (!(await settings.hasSavedKeys())) lifecycle.allowEngine();
        void lifecycle.warmup().catch(() => {});
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
            'Windows will ask for administrator approval. Restart your PC after installation, then open Nod again.',
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
          message: 'Restart your PC, then open Nod again.',
          error: 'Restart your PC, then open Nod again.',
          needsWsl: false,
        });
        return status;
      });
      ipcMain.handle('nod:chat-read:get', (event, ownerId, threadId) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (remoteConnection && ownerId !== remoteConnection.owner)
          throw new Error('This chat does not belong to your server.');
        return chatReadCursors.get(remoteConnection?.cursorOwner || ownerId, threadId);
      });
      ipcMain.handle('nod:chat-read:set', async (event, ownerId, threadId, cursor) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('Nod is closing.');
        if (remoteConnection && ownerId !== remoteConnection.owner)
          throw new Error('This chat does not belong to your server.');
        await chatReadCursors.set(remoteConnection?.cursorOwner || ownerId, threadId, cursor);
        void unreadBadge?.refresh().catch(() => {});
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
        await resumeState();
        const removeData = Menu.getApplicationMenu?.()?.getMenuItemById('remove-local-data');
        if (removeData) removeData.enabled = !saved.serverUrl;
        onboardingCompleted = Boolean(saved.serverUrl) || saved.onboardingCompleted;
        update({ remote: Boolean(saved.serverUrl) });
        applyPreferences(saved);
        guidedStartup = !saved.serverUrl && !saved.onboardingCompleted;
        const presented = showSettings('general', true);
        if (saved.serverUrl || saved.onboardingCompleted || saved.welcome) void prepare();
        await presented;
      } catch (error) {
        showSettings('general', true);
        update({ phase: 'error', message: bounded(error.message), error: bounded(error.message) });
      }
    })
    .catch((error) => {
      void writeDiagnostic(bounded(error.message)).finally(() => app.quit());
    });
}
