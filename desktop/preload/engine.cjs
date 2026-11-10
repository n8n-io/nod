const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...values) =>
  ipcRenderer.invoke(channel, ...values).catch((error) => {
    throw new Error(
      String(error?.message).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''),
    );
  });

const focusListeners = new Set();
const settingsListeners = new Set();
const navigationListeners = new Set();
let pendingNavigation;
const feedbackListeners = new Set();
let pendingSettings;
let pendingFeedback = false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let pendingFocus;
ipcRenderer.on('nod:focus-message', (_event, value) => {
  if (value !== null && (!value || !uuid.test(value.threadId) || !uuid.test(value.messageId)))
    return;
  const target = value === null ? null : { threadId: value.threadId, messageId: value.messageId };
  if (focusListeners.size === 0) pendingFocus = target;
  else for (const listener of focusListeners) listener(target);
});

ipcRenderer.on('nod:settings:focus', (_event, section) => {
  if (!['general', 'models', 'preferences'].includes(section)) return;
  if (!settingsListeners.size) pendingSettings = section;
  else for (const listener of settingsListeners) listener(section);
});

ipcRenderer.on('nod:navigate', (_event, path) => {
  if (typeof path !== 'string') return;
  if (!navigationListeners.size) pendingNavigation = path;
  else for (const listener of navigationListeners) listener(path);
});

ipcRenderer.on('nod:feedback:open', () => {
  if (!feedbackListeners.size) pendingFeedback = true;
  else for (const listener of feedbackListeners) listener();
});

contextBridge.exposeInMainWorld('nodDesktop', {
  remote: process.argv.includes('--nod-remote'),
  fileAction: (id, action) => invoke('nod:file:action', id, action),
  fileMenu: (id, image) => invoke('nod:file:menu', id, image),
  ready: () => invoke('nod:renderer-ready'),
  status: () => invoke('nod:status'),
  updateStatus: () => invoke('nod:updates:status'),
  dismissUpdate: (version) => invoke('nod:updates:dismiss', version),
  restartUpdate: () => invoke('nod:updates:restart'),
  prepare: (options) => invoke('nod:prepare', options),
  onStatus: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('nod:status', receive);
    return () => ipcRenderer.removeListener('nod:status', receive);
  },
  onUpdateStatus: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('nod:updates:status', receive);
    return () => ipcRenderer.removeListener('nod:updates:status', receive);
  },
  openSettings: (section = 'general') => invoke('nod:settings:open', section),
  onNavigate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A navigation listener is required.');
    navigationListeners.add(listener);
    if (pendingNavigation !== undefined) {
      const path = pendingNavigation;
      pendingNavigation = undefined;
      listener(path);
    }
    return () => navigationListeners.delete(listener);
  },
  openExternal: (url) => invoke('nod:external', url),
  getSettings: () => invoke('nod:settings:get'),
  saveSettings: (input) => invoke('nod:settings:save', input),
  removeAllData: () => invoke('nod:data:remove'),
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
  getPreferences: () => invoke('nod:preferences:get'),
  takeAppOpening: (consented, distinctId) => invoke('nod:analytics:opening', consented, distinctId),
  getFeedbackContext: () => invoke('nod:feedback:context'),
  captureFeedbackScreenshot: () => invoke('nod:feedback:capture'),
  onFeedbackRequested: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A feedback listener is required.');
    feedbackListeners.add(listener);
    if (pendingFeedback) {
      pendingFeedback = false;
      listener();
    }
    return () => feedbackListeners.delete(listener);
  },
  setTheme: (theme) => invoke('nod:preferences:theme', theme),
  getChatReadCursor: (ownerId, threadId) => invoke('nod:chat-read:get', ownerId, threadId),
  setChatReadCursor: (ownerId, threadId, cursor) =>
    invoke('nod:chat-read:set', ownerId, threadId, cursor),
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
    ipcRenderer.on('nod:preferences', receive);
    return () => ipcRenderer.removeListener('nod:preferences', receive);
  },
});
