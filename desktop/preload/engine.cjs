const { contextBridge, ipcRenderer } = require('electron');

const focusListeners = new Set();
const settingsListeners = new Set();
let pendingSettings;
const restartChecks = new Set();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let pendingFocus;
let restartLock;
ipcRenderer.on('otto:update:prepare', (_event, token) => {
  if (typeof token !== 'string' || !uuid.test(token)) return;
  let blocked = true;
  try {
    blocked =
      Boolean(restartLock) ||
      !restartChecks.size ||
      [...restartChecks].some((check) => check() !== true);
    if (!blocked) {
      restartLock = { token, inert: document.documentElement.inert };
      document.documentElement.inert = true;
    }
  } catch {
    blocked = true;
  }
  ipcRenderer.send('otto:update:prepared', { token, blocked });
});
ipcRenderer.on('otto:update:resume', (_event, token) => {
  if (restartLock?.token !== token) return;
  document.documentElement.inert = restartLock.inert;
  restartLock = undefined;
});
ipcRenderer.on('otto:focus-message', (_event, value) => {
  if (value !== null && (!value || !uuid.test(value.threadId) || !uuid.test(value.messageId)))
    return;
  const target = value === null ? null : { threadId: value.threadId, messageId: value.messageId };
  if (focusListeners.size === 0) pendingFocus = target;
  else for (const listener of focusListeners) listener(target);
});

ipcRenderer.on('otto:settings:focus', (_event, section) => {
  if (!['general', 'models', 'preferences'].includes(section)) return;
  if (!settingsListeners.size) pendingSettings = section;
  else for (const listener of settingsListeners) listener(section);
});

contextBridge.exposeInMainWorld('ottoDesktop', {
  getAnalyticsConfiguration: () => ipcRenderer.invoke('otto:analytics:configuration'),
  onPrepareUpdate: (check) => {
    if (typeof check !== 'function') throw new TypeError('A restart check is required.');
    restartChecks.add(check);
    return () => restartChecks.delete(check);
  },
  openSettings: (section = 'general') => ipcRenderer.invoke('otto:settings:open', section),
  openExternal: (url) => ipcRenderer.invoke('otto:external', url),
  getSettings: () => ipcRenderer.invoke('otto:settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('otto:settings:save', input),
  revealComposioKey: () => ipcRenderer.invoke('otto:settings:reveal', 'composioApiKey'),
  applySettings: () => ipcRenderer.invoke('otto:settings:apply'),
  onOpenSettings: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A settings listener is required.');
    settingsListeners.add(listener);
    if (pendingSettings !== undefined) {
      const section = pendingSettings;
      pendingSettings = undefined;
      listener(section);
    }
    return () => settingsListeners.delete(listener);
  },
  getPreferences: () => ipcRenderer.invoke('otto:preferences:get'),
  getBuildInfo: () => ipcRenderer.invoke('otto:build-info'),
  setTheme: (theme) => ipcRenderer.invoke('otto:preferences:theme', theme),
  getChatReadCursor: (ownerId, threadId) =>
    ipcRenderer.invoke('otto:chat-read:get', ownerId, threadId),
  setChatReadCursor: (ownerId, threadId, cursor) =>
    ipcRenderer.invoke('otto:chat-read:set', ownerId, threadId, cursor),
  onFocusMessage: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A message listener is required.');
    focusListeners.add(listener);
    if (pendingFocus !== undefined) {
      const target = pendingFocus;
      pendingFocus = undefined;
      listener(target);
    }
    return () => focusListeners.delete(listener);
  },
  onPreferences: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('otto:preferences', receive);
    return () => ipcRenderer.removeListener('otto:preferences', receive);
  },
});
