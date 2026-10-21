import {
  app,
  autoUpdater,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
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
import { execFile, spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
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
import { createDesktopLifecycle, desktopSetupMode } from './lifecycle.mjs';
import {
  createDesktopUpdater,
  createUpdateSource,
  createWeeklyId,
  startDesktopUpdateChecks,
} from './updates.mjs';
import { windowsInstallCommand } from './windows-update.mjs';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = app.isPackaged
  ? join(process.resourcesPath, 'engine')
  : resolve(desktopRoot, '..');
const setupPath = app.isPackaged
  ? join(desktopRoot, 'ui', 'index.html')
  : join(engineRoot, 'dist', 'desktop-ui', 'index.html');
const setupURL = pathToFileURL(setupPath).href;
app.setName('Otto');
const developmentDataRoot = !app.isPackaged ? process.env.OTTO_DESKTOP_USER_DATA : undefined;
if (developmentDataRoot && !isAbsolute(developmentDataRoot))
  throw new Error('The development profile path must be absolute.');
app.setPath('userData', developmentDataRoot || join(app.getPath('appData'), 'Otto'));
const profileRoot = join(app.getPath('userData'), 'profiles', 'local');
const windowsUpdates = join(process.env.LOCALAPPDATA || app.getPath('temp'), 'Otto', 'updates');
const settings = createSettingsStore(join(profileRoot, 'settings.json'), safeStorage);
const analyticsConfiguration = createDesktopAnalytics(join(profileRoot, 'analytics-id'), {
  packaged: app.isPackaged,
});
let setupWindow;
let engineWindow;
let pendingFeedback = false;
let engine;
let enginePreferencesReady = false;
let preparing;
let onboardingCompleted = false;
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
let replayingOnboarding = process.argv.includes('--onboarding');
let replayingProductOnboarding = replayingOnboarding;
let stopNotifications;
let setupNavigation = { mode: 'settings', section: 'general' };
let preferences = { theme: 'system', notifications: false, launchAtLogin: false };
const displayedNotifications = new Set();
let status = {
  platform: process.platform,
  unlockingKeys: false,
  phase: 'idle',
  message: 'Set up Otto on your computer.',
  runtime: {
    phase: 'idle',
    message: 'Your computer will prepare in the background.',
    needsRuntimeArchive: false,
  },
};
const knownSecrets = new Set();
const engineWindows = new Set();
const appPreferences = createAppPreferencesStore(join(profileRoot, 'preferences.json'), {
  request: (path, options) => engineRequest(path, options),
  isReady: () => Boolean(engine) && enginePreferencesReady && !closingEngine && !quitting,
});
const chatReadCursors = createChatReadCursorStore(join(profileRoot, 'chat-read-cursors.json'), {
  owner: async () => JSON.parse(await readFile(join(profileRoot, 'profile.json'), 'utf8')).ownerId,
});

const lifecycle = createDesktopLifecycle({
  prepareRuntime: async ({ signal, onStatus }) => {
    await mkdir(profileRoot, { recursive: true, mode: 0o700 });
    await writeDiagnostic('Preparing local runtime.').catch(() => {});
    const { prepareRuntime } = await import(
      pathToFileURL(join(engineRoot, 'desktop', 'runtime', 'index.mjs')).href
    );
    const prepared = await prepareRuntime({
      dataRoot: profileRoot,
      resourcesPath: engineRoot,
      resolveDownloadUrl: updateSource?.runtimeDownloadUrl,
      signal,
      onStatus,
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
    if (preparing && status.phase !== 'starting' && value.phase !== 'error')
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
      title: 'Otto is ready',
      body:
        onboardingCompleted && !replayingOnboarding
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
    runtimePhase: status.runtime.phase,
    guided: guidedStartup,
    enabled: preferences.notifications,
    foreground: foregroundWindow(),
    quitting,
    completed: onboardingCompleted && !replayingOnboarding,
    engineReady: Boolean(engine) && status.phase === 'ready',
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
    if (window && !window.isDestroyed()) window.webContents.send('otto:status', status);
  if (tray) tray.setToolTip(`Otto — ${status.phase === 'ready' ? 'Running' : status.message}`);
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
    window.setBackgroundColor(value.resolvedTheme === 'dark' ? '#1e1b21' : '#fdfcfe');
    window.webContents.send('otto:preferences', value);
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
    title: 'Otto',
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
        'otto:focus-message',
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
        message: 'Otto could not save the file to Downloads.',
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
        '/you',
        '/tasks',
        '/memory',
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
            partition: 'persist:otto-app',
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

function showSettings(section = 'general', _mode, reset = false) {
  if (quitting) return;
  const mode = desktopSetupMode({
    completed: onboardingCompleted,
    replaying: replayingOnboarding,
    running: Boolean(engine) && status.phase === 'ready',
  });
  if (mode === 'settings') {
    showEngine();
    const window = engineWindow;
    if (!window || window.isDestroyed()) return;
    const open = () => {
      if (!window.isDestroyed()) window.webContents.send('otto:settings:focus', section);
    };
    if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', open);
    else open();
    return;
  }
  const changedMode = setupNavigation.mode !== mode;
  setupNavigation = { section, mode, reset };
  if (setupWindow && !setupWindow.isDestroyed()) {
    if (changedMode) setupWindow.setSize(600, 540);
    setupWindow.webContents.send('otto:navigate', setupNavigation);
    setupWindow.show();
    setupWindow.focus();
    return;
  }
  setupWindow = new BrowserWindow({
    width: 600,
    height: 540,
    minWidth: 520,
    minHeight: 500,
    title: 'Otto',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1b21' : '#fdfcfe',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'otto-settings',
    },
  });
  const window = setupWindow;
  protectWindow(window);
  window.on('closed', () => {
    if (setupWindow === window) setupWindow = undefined;
  });
  void window.loadFile(setupPath, {
    query: { mode, section, firstSetup: String(!onboardingCompleted) },
  });
}

function showEngine() {
  if (quitting) return;
  if (!onboardingCompleted || replayingOnboarding || !engineOrigin || status.phase !== 'ready') {
    showSettings(setupNavigation.section, setupNavigation.mode);
    return;
  }
  if (engineWindow && !engineWindow.isDestroyed()) {
    if (replayingProductOnboarding) {
      replayingProductOnboarding = false;
      void engineWindow.loadURL(`${engineOrigin}/onboarding?replay=1`);
    }
    engineWindow.show();
    engineWindow.focus();
    deliverFeedbackRequest(engineWindow);
    return;
  }
  engineWindow = new BrowserWindow({
    width: 1200,
    height: 860,
    minWidth: 700,
    minHeight: 600,
    title: 'Otto',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1b21' : '#fdfcfe',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 17 } } : {}),
    webPreferences: {
      preload: join(desktopRoot, 'preload', 'engine.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:otto-app',
    },
  });
  engineWindows.add(engineWindow);
  protectWindow(engineWindow, engineOrigin);
  const window = engineWindow;
  window.webContents.on('did-finish-load', () => deliverFeedbackRequest(window));
  engineWindow.on('closed', () => {
    engineWindows.delete(window);
    engineWindow = undefined;
  });
  const destination = replayingProductOnboarding
    ? `${engineOrigin}/onboarding?replay=1`
    : engineOrigin;
  replayingProductOnboarding = false;
  void engineWindow.loadURL(destination);
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
  window.webContents.send('otto:feedback:open');
}

async function feedbackContext() {
  let computerName = '';
  if (process.platform === 'darwin')
    computerName = await new Promise((resolve) => {
      execFile(
        '/usr/sbin/scutil',
        ['--get', 'ComputerName'],
        { encoding: 'utf8', timeout: 2_000, maxBuffer: 8_192 },
        (error, value) => resolve(error ? '' : value.trim()),
      );
    });
  const { ottoBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  return {
    computerName: (computerName || hostname()).trim().slice(0, 200) || null,
    appVersion: app.getVersion(),
    appRelease: typeof ottoBuild?.source === 'string' ? ottoBuild.source : null,
    appModified: typeof ottoBuild?.modified === 'boolean' ? ottoBuild.modified : null,
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
    /^\/(?:trust|vault|credentials|payments|browser|browser-connect|onboarding)(?:\/|$)/.test(
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
      ...(developmentDataRoot ? ['OTTO_DESKTOP_USER_DATA', 'OTTO_COMPOSIO_PROXY_URL'] : []),
      'OTTO_FEEDBACK_ENABLED',
      'OTTO_FEEDBACK_URL',
      'OTTO_FEEDBACK_TOKEN',
      'OTTO_FEEDBACK_RECEIPT_URL_PREFIX',
      'OTTO_TRACES_URL',
      'OTTO_TRACES_TOKEN',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ]
      .filter((key) => typeof process.env[key] === 'string')
      .map((key) => [key, process.env[key]]),
  );
}

async function profileOwner() {
  const path = join(profileRoot, 'profile.json');
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.ownerId)
    )
      throw new Error('The local profile identity is invalid.');
    return value.ownerId;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const ownerId = randomUUID();
    await writeFile(path, JSON.stringify({ ownerId }), { flag: 'wx', mode: 0o600 });
    return ownerId;
  }
}

async function engineRequest(path, options = {}) {
  if (!engineBound) throw new Error('Otto is not ready.');
  return fetch(`${engineOrigin}${path}`, {
    ...options,
    headers: { ...options.headers, 'x-otto-desktop-token': authToken },
    signal: options.signal ?? AbortSignal.timeout(5000),
  });
}

async function stopEngine() {
  enginePreferencesReady = false;
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
          reject(new Error('The previous Otto process has not stopped. Quit and reopen the app.')),
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

async function finishEnginePreparation() {
  await appPreferences.sync();
  if (quitting || !engine) throw new Error('Otto is closing.');
  await writeDiagnostic('Engine ready.').catch(() => {});
  update({ phase: 'ready', message: 'Otto is running on your computer.', progress: undefined });
  synchronizeNotifications();
  if (!replayingOnboarding) {
    if (pendingFeedback || foregroundWindow()) showEngine();
    const completedWindow = setupWindow;
    setupWindow = undefined;
    if (completedWindow && !completedWindow.isDestroyed()) completedWindow.destroy();
  }
  if (pendingPreload) {
    const assets = pendingPreload;
    pendingPreload = undefined;
    void preloadUpdateImages(assets);
  }
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
        { label: 'Open Otto', click: showEngine },
        { label: 'Settings…', click: () => showSettings() },
        { label: 'Send feedback…', click: showFeedback },
        {
          label,
          enabled: Boolean(updates) && !checkingUpdates,
          click: () => void checkForUpdates(),
        },
        { type: 'separator' },
        { label: 'Quit Otto', click: () => app.quit() },
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
    try {
      const candidate = await updates.check();
      updateFailed = false;
      if (quitting) return;
      if (!candidate) {
        release();
        if (manual)
          await dialog.showMessageBox({ message: 'Otto is up to date.', buttons: ['OK'] });
        return;
      }
      if (!manual && (await notifyUpdate(candidate))) return;
      release();
      const { response } = await dialog.showMessageBox({
        message: `Otto ${candidate.version} is ready.`,
        buttons: ['Restart', 'Later'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0 && !quitting) await updates.restart();
    } catch (error) {
      if (quitting) return;
      if (!updates.ready) updateFailed = true;
      await writeDiagnostic(error.message).catch(() => {});
      if (!manual && !updates.ready) throw error;
      release();
      await dialog.showMessageBox({
        type: 'warning',
        message: updates.ready
          ? 'Otto could not restart yet.'
          : 'Otto could not check for updates.',
        detail: bounded(error.message),
        buttons: ['OK'],
      });
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
    title: `Otto ${candidate.version} is ready`,
    body: 'Restart Otto to use the new version.',
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
            turn?.visible
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
    message: work.length ? 'Otto is still working.' : 'Otto could not check its current work.',
    detail: work.length
      ? `Restarting now stops ${new Intl.ListFormat('en').format(work)}. You can ask Otto to continue afterwards.`
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

async function quit(complete) {
  quitting = true;
  stopUpdateChecks?.();
  const stoppingUpdates = updates?.dispose();
  updateReadinessNotice();
  stopNotifications?.();
  for (const notification of displayedNotifications) notification.close();
  await stoppingUpdates;
  await chatReadCursors.flush().catch(() => {});
  await finishQuit(complete);
}

async function finishQuit(complete) {
  while (true) {
    try {
      await lifecycle.close();
      await complete();
      return;
    } catch (error) {
      await writeDiagnostic(error.message).catch(() => {});
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Otto could not finish shutting down.',
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
  const selected = await settings.get();
  if (quitting) throw new Error('Otto is closing.');
  if (!selected.onboardingCompleted)
    throw new Error('Choose your preferences to finish setting up Otto.');
}

async function startEngine({ runtime, signal }) {
  if (engine && enginePreferencesReady) return finishEnginePreparation();
  if (engine) {
    if (!(await confirmRestart()))
      throw Object.assign(new Error('Restart Otto when it finishes its current work.'), {
        code: 'OTTO_RESTART_DEFERRED',
      });
    await stopEngine();
  }
  if (quitting) throw new Error('Otto is closing.');
  const port = await availablePort();
  if (quitting || signal.aborted) throw new Error('Otto is closing.');
  engineBound = false;
  authToken = randomBytes(32).toString('base64url');
  knownSecrets.add(authToken);
  engineOrigin = `http://127.0.0.1:${port}`;
  update({ phase: 'starting', message: 'Unlocking your saved API keys…', unlockingKeys: true });
  await new Promise((accept) => setTimeout(accept, 50));
  if (quitting || signal.aborted) throw new Error('Otto is closing.');
  const providerEnvironment = await settings.environment();
  if (providerEnvironment.OTTO_VAULT_KEY) knownSecrets.add(providerEnvironment.OTTO_VAULT_KEY);
  if (runtime.env.DATABASE_URL) knownSecrets.add(runtime.env.DATABASE_URL);
  if (process.env.OTTO_FEEDBACK_TOKEN) knownSecrets.add(process.env.OTTO_FEEDBACK_TOKEN);
  const { ottoBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
  const tracesToken =
    typeof ottoBuild?.tracesToken === 'string'
      ? ottoBuild.tracesToken
      : process.env.OTTO_TRACES_TOKEN;
  if (tracesToken) knownSecrets.add(tracesToken);
  const analytics = await analyticsConfiguration().catch(() => ({ enabled: false }));
  const environment = {
    ...baseEnvironment(),
    ...runtime.env,
    ...providerEnvironment,
    NODE_ENV: 'production',
    PORT: String(port),
    OTTO_DESKTOP: 'true',
    OTTO_APP_VERSION: app.getVersion(),
    OTTO_DESKTOP_OWNER_ID: await profileOwner(),
    OTTO_DESKTOP_AUTH_TOKEN: authToken,
    OTTO_ANALYTICS_ENABLED: String(analytics.enabled),
    OTTO_ANALYTICS_ENVIRONMENT:
      app.isPackaged && ottoBuild?.release === true && /^\d+\.\d+\.\d+$/.test(app.getVersion())
        ? 'production'
        : 'development',
    OTTO_PUBLIC_URL: engineOrigin,
    OTTO_DATA_ROOT: profileRoot,
    OTTO_WEB_ROOT: join(engineRoot, 'dist', 'web'),
    ...(process.env.OTTO_FEEDBACK_URL === '' ? { OTTO_FEEDBACK_ENABLED: 'false' } : {}),
    ...(tracesToken ? { OTTO_TRACES_TOKEN: tracesToken } : {}),
    PI_CODING_AGENT_DIR: join(profileRoot, 'pi'),
  };
  if (quitting || signal.aborted) throw new Error('Otto is closing.');
  update({
    phase: 'starting',
    message: 'Starting Otto.',
    needsRuntimeArchive: false,
    unlockingKeys: false,
  });
  const child = utilityProcess.fork(join(engineRoot, 'desktop', 'main', 'engine.mjs'), [], {
    cwd: engineRoot,
    env: environment,
    stdio: 'pipe',
    serviceName: 'Otto engine',
  });
  engine = child;
  child.on('message', (message) => {
    if (engine === child && message?.type === 'otto-ready' && message.port === port)
      engineBound = true;
  });
  child.stdout?.resume();
  let diagnostics = '';
  child.stderr?.on('data', (chunk) => {
    if (status.phase !== 'starting') return;
    diagnostics = (diagnostics + chunk.toString()).slice(-4000);
    const lines = diagnostics.split('\n');
    diagnostics = lines.pop() || '';
    for (const line of lines)
      if (
        /^(?:Error|TypeError|SyntaxError|ReferenceError|RangeError)(?::| \[)/.test(line) &&
        !line.includes('{')
      )
        void writeDiagnostic(line).catch(() => {});
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
    for (const window of engineWindows) if (!window.isDestroyed()) window.destroy();
    engineWindows.clear();
    if (!quitting && !closingEngine) {
      update({
        phase: 'error',
        message: 'Otto stopped unexpectedly.',
        error: 'Open settings and choose Start Otto to recover.',
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
    throw new Error('Otto could not start. Check your settings and try again.');
  }
  enginePreferencesReady = true;
  return finishEnginePreparation();
}

async function prepare(options = {}) {
  if (preparing) return preparing;
  update({
    phase: 'preparing',
    message: status.runtime.message,
    progress: status.runtime.progress,
    needsRuntimeArchive: false,
  });
  preparing = lifecycle
    .start({ retry: options?.retry === true })
    .catch((error) => {
      void writeDiagnostic(error.message).catch(() => {});
      const deferred =
        error.code === 'OTTO_RESTART_DEFERRED' &&
        engine &&
        enginePreferencesReady &&
        !closingEngine &&
        !quitting;
      update({
        phase: deferred ? 'ready' : 'error',
        message: bounded(error.message),
        error: bounded(error.message),
        needsRuntimeArchive: error.code === 'RUNTIME_ARCHIVE_REQUIRED',
        needsWsl: error.code === 'OTTO_WSL_REQUIRED',
      });
      return status;
    })
    .finally(() => {
      preparing = undefined;
    });
  return preparing;
}

async function warmRuntime(options = {}) {
  try {
    await lifecycle.warmup({ retry: options?.retry === true });
  } catch (error) {
    void writeDiagnostic(error.message).catch(() => {});
  }
  return status;
}

function replayOnboarding() {
  replayingOnboarding = true;
  replayingProductOnboarding = true;
  showSettings('general', 'onboarding', true);
  return status;
}

async function importRuntime() {
  if (lifecycle.busy || quitting)
    throw new Error('Wait for Otto to finish its current setup step.');
  const chosen = await dialog.showOpenDialog(setupWindow, {
    title: 'Choose the Otto Runtime pack',
    buttonLabel: 'Install runtime',
    properties: ['openFile'],
    filters: [{ name: 'Otto Runtime pack', extensions: ['gz', 'tgz'] }],
  });
  if (chosen.canceled || !chosen.filePaths[0] || quitting) return status;
  if (lifecycle.busy) throw new Error('Wait for Otto to finish its current setup step.');
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
    if (onboardingCompleted && !replayingOnboarding) return prepare();
  } catch (error) {
    void writeDiagnostic(error.message).catch(() => {});
    if (onboardingCompleted && !replayingOnboarding)
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
      if (app.isPackaged && process.platform === 'darwin' && !app.isInApplicationsFolder()) {
        const { response } = await dialog.showMessageBox({
          message: 'Move Otto to your Applications folder?',
          detail: 'Otto can update itself only from Applications.',
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
      if (app.isPackaged && ['darwin', 'win32'].includes(process.platform)) {
        const { ottoBuild } = JSON.parse(await readFile(join(desktopRoot, 'package.json'), 'utf8'));
        const windows = process.platform === 'win32';
        if (windows) await rm(windowsUpdates, { recursive: true, force: true }).catch(() => {});
        updateSource = createUpdateSource({
          sourceUrl: ottoBuild?.updateSourceUrl,
          weeklyId: createWeeklyId(join(profileRoot, 'update-week.json')),
        });
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
      const appSession = session.fromPartition('persist:otto-app');
      appSession.on('will-download', saveEngineDownload);
      appSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === 'x-otto-desktop-token') delete headers[key];
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
          engineOrigin &&
          new URL(details.url).origin === engineOrigin &&
          window &&
          ((details.resourceType === 'mainFrame' && trustedAppURL(details.url)) || trustedFrame)
        )
          headers['x-otto-desktop-token'] = authToken;
        callback({ requestHeaders: headers });
      });
      const image = nativeImage.createFromPath(join(desktopRoot, 'main', 'trayTemplate.png'));
      image.setTemplateImage(true);
      tray = new Tray(image);
      if (process.platform !== 'darwin') tray.on('click', showEngine);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Otto',
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
      ipcMain.handle('otto:status', (event) => {
        allowSetup(event);
        return status;
      });
      ipcMain.handle('otto:settings:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return readDesktopSettings();
      });
      ipcMain.handle('otto:feedback:context', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return feedbackContext();
      });
      ipcMain.handle('otto:feedback:capture', (event) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return captureFeedbackScreenshot(event).catch(() => null);
      });
      ipcMain.handle('otto:preferences:get', (event) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return publicPreferences();
      });
      ipcMain.handle('otto:preferences:theme', async (event, theme) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('Otto is closing.');
        applyPreferences(await settings.save({ theme }));
        return publicPreferences();
      });
      ipcMain.handle('otto:settings:save', async (event, value) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        const allowed = ['theme', 'notifications', 'launchAtLogin'];
        if (isSetup(event)) allowed.push('onboardingCompleted');
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((field) => !allowed.includes(field))
        )
          throw new Error('These settings are not supported.');
        if (quitting) throw new Error('Otto is closing.');
        const loginChanged = typeof value.launchAtLogin === 'boolean';
        const previousLogin = loginChanged ? app.getLoginItemSettings().openAtLogin : undefined;
        if (loginChanged) app.setLoginItemSettings({ openAtLogin: value.launchAtLogin });
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
        applyPreferences(saved);
        if (!['preparing', 'starting', 'error'].includes(status.phase))
          update({ message: 'Ready.' });
        return readDesktopSettings();
      });
      ipcMain.handle('otto:prepare', (event, options) => {
        allowSetup(event);
        replayingOnboarding = false;
        return prepare(options);
      });
      ipcMain.handle('otto:runtime:warm', (event, options) => {
        allowSetup(event);
        return warmRuntime(options);
      });
      ipcMain.handle('otto:onboarding:replay', (event) => {
        allowSetup(event);
        return replayOnboarding();
      });
      ipcMain.handle('otto:runtime:import', (event) => {
        allowSetup(event);
        return importRuntime();
      });
      ipcMain.handle('otto:runtime:install-wsl', async (event) => {
        allowSetup(event);
        if (process.platform !== 'win32' || lifecycle.busy || quitting || !status.runtime.needsWsl)
          throw new Error('This setup action is unavailable.');
        const { response } = await dialog.showMessageBox(setupWindow, {
          type: 'question',
          message: 'Install Windows Subsystem for Linux?',
          detail:
            'Windows will ask for administrator approval. Restart your PC after installation, then open Otto again.',
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
          message: 'Restart your PC, then open Otto again.',
          error: 'Restart your PC, then open Otto again.',
          needsWsl: false,
        });
        return status;
      });
      ipcMain.handle('otto:chat-read:get', (event, ownerId, threadId) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        return chatReadCursors.get(ownerId, threadId);
      });
      ipcMain.handle('otto:chat-read:set', (event, ownerId, threadId, cursor) => {
        if (!isEngine(event)) throw new Error('This action is unavailable.');
        if (quitting) throw new Error('Otto is closing.');
        return chatReadCursors.set(ownerId, threadId, cursor);
      });
      ipcMain.handle('otto:external', (event, url) => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        return openExternal(url);
      });
      ipcMain.handle('otto:settings:open', (event, section = 'general') => {
        if (!isSetup(event) && !isEngine(event)) throw new Error('This action is unavailable.');
        if (!['general', 'models', 'preferences'].includes(section))
          throw new Error('Choose a settings section.');
        showSettings(section);
      });
      ipcMain.handle('otto:quit', (event) => {
        allowSetup(event);
        app.quit();
      });
      try {
        const saved = await settings.get();
        onboardingCompleted = saved.onboardingCompleted;
        applyPreferences(saved);
        const onboarding = replayingOnboarding || !saved.onboardingCompleted;
        guidedStartup = onboarding;
        showSettings('general', onboarding ? 'onboarding' : 'settings');
        void warmRuntime();
        if (!replayingOnboarding && saved.onboardingCompleted) void prepare();
      } catch (error) {
        showSettings('general', 'onboarding');
        update({ phase: 'error', message: bounded(error.message), error: bounded(error.message) });
      }
    })
    .catch((error) => {
      void writeDiagnostic(bounded(error.message)).finally(() => app.quit());
    });
}
