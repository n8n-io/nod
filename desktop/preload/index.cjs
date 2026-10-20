const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

contextBridge.exposeInMainWorld('ottoDesktop', {
  ready: () => ipcRenderer.invoke('otto:renderer-ready'),
  status: () => ipcRenderer.invoke('otto:status'),
  getSettings: () => ipcRenderer.invoke('otto:settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('otto:settings:save', input),
  getPreferences: () => ipcRenderer.invoke('otto:preferences:get'),
  prepare: (options) => ipcRenderer.invoke('otto:prepare', options),
  importRuntime: () => ipcRenderer.invoke('otto:runtime:import'),
  installWsl: () => ipcRenderer.invoke('otto:runtime:install-wsl'),
  onStatus: (listener) => subscribe('otto:status', listener),
  onPreferences: (listener) => subscribe('otto:preferences', listener),
});
