const { contextBridge, ipcRenderer } = require('electron');

const focusListeners = new Set();
const settingsListeners = new Set();
const feedbackListeners = new Set();
let pendingSettings;
let pendingFeedback = false;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let pendingFocus;
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

ipcRenderer.on('otto:feedback:open', () => {
  if (!feedbackListeners.size) pendingFeedback = true;
  else for (const listener of feedbackListeners) listener();
});

contextBridge.exposeInMainWorld('ottoDesktop', {
  ready: () => ipcRenderer.invoke('otto:renderer-ready'),
  status: () => ipcRenderer.invoke('otto:status'),
  prepare: (options) => ipcRenderer.invoke('otto:prepare', options),
  onStatus: (listener) => {
    const receive = (_event, value) => listener(value);
    ipcRenderer.on('otto:status', receive);
    return () => ipcRenderer.removeListener('otto:status', receive);
  },
  openSettings: (section = 'general') => ipcRenderer.invoke('otto:settings:open', section),
  openExternal: (url) => ipcRenderer.invoke('otto:external', url),
  getSettings: () => ipcRenderer.invoke('otto:settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('otto:settings:save', input),
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
  getFeedbackContext: () => ipcRenderer.invoke('otto:feedback:context'),
  captureFeedbackScreenshot: () => ipcRenderer.invoke('otto:feedback:capture'),
  onFeedbackRequested: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('A feedback listener is required.');
    feedbackListeners.add(listener);
    if (pendingFeedback) {
      pendingFeedback = false;
      listener();
    }
    return () => feedbackListeners.delete(listener);
  },
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
