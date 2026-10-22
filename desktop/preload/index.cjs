const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, listener) {
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

contextBridge.exposeInMainWorld('nodDesktop', {
  ready: () => ipcRenderer.invoke('nod:renderer-ready'),
  status: () => ipcRenderer.invoke('nod:status'),
  getSettings: () => ipcRenderer.invoke('nod:settings:get'),
  saveSettings: (input) => ipcRenderer.invoke('nod:settings:save', input),
  getPreferences: () => ipcRenderer.invoke('nod:preferences:get'),
  prepare: (options) => ipcRenderer.invoke('nod:prepare', options),
  importRuntime: () => ipcRenderer.invoke('nod:runtime:import'),
  installWsl: () => ipcRenderer.invoke('nod:runtime:install-wsl'),
  onStatus: (listener) => subscribe('nod:status', listener),
  onPreferences: (listener) => subscribe('nod:preferences', listener),
});
