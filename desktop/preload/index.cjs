const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

contextBridge.exposeInMainWorld('ottoDesktop', {
  status: () => ipcRenderer.invoke('otto:status'),
  getSettings: () => ipcRenderer.invoke('otto:settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('otto:settings:save', input),
  revealKey: (field) => ipcRenderer.invoke('otto:settings:reveal', field),
  getPreferences: () => ipcRenderer.invoke('otto:preferences:get'),
  setTheme: (theme) => ipcRenderer.invoke('otto:preferences:theme', theme),
  prepare: (options) => ipcRenderer.invoke('otto:prepare', options),
  warmRuntime: (options) => ipcRenderer.invoke('otto:runtime:warm', options),
  replayOnboarding: () => ipcRenderer.invoke('otto:onboarding:replay'),
  importRuntime: () => ipcRenderer.invoke('otto:runtime:import'),
  getAppPreferences: () => ipcRenderer.invoke('otto:app-preferences:get'),
  saveAppPreferences: (patch) => ipcRenderer.invoke('otto:app-preferences:save', patch),
  openExternal: (url) => ipcRenderer.invoke('otto:external', url),
  openSettings: (section = 'general') => ipcRenderer.invoke('otto:settings:open', section),
  quit: () => ipcRenderer.invoke('otto:quit'),
  onStatus: (listener) => subscribe('otto:status', listener),
  onPreferences: (listener) => subscribe('otto:preferences', listener),
  onNavigate: (listener) => subscribe('otto:navigate', listener),
});
