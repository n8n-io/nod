const { contextBridge, ipcRenderer } = require('electron');

const focusListeners = new Set();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let pendingFocus;
ipcRenderer.on('otto:focus-message', (_event, value) => {
  if (value !== null && (!value || !uuid.test(value.threadId) || !uuid.test(value.messageId)))
    return;
  const target = value === null ? null : { threadId: value.threadId, messageId: value.messageId };
  if (focusListeners.size === 0) pendingFocus = target;
  else for (const listener of focusListeners) listener(target);
});

contextBridge.exposeInMainWorld('ottoDesktop', {
  openSettings: (section = 'general') => ipcRenderer.invoke('otto:settings:open', section),
  openExternal: (url) => ipcRenderer.invoke('otto:external', url),
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
