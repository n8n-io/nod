const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...values) =>
  ipcRenderer.invoke(channel, ...values).catch((error) => {
    throw new Error(
      String(error?.message).replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, ''),
    );
  });

function subscribe(channel, listener) {
  const receive = (_event, value) => listener(value);
  ipcRenderer.on(channel, receive);
  return () => ipcRenderer.removeListener(channel, receive);
}

contextBridge.exposeInMainWorld('nodDesktop', {
  ready: () => invoke('nod:renderer-ready'),
  status: () => invoke('nod:status'),
  getSettings: () => invoke('nod:settings:get'),
  getConnection: () => invoke('nod:connection:get'),
  saveConnection: (input) => invoke('nod:connection:save', input),
  openConnectionSettings: () => invoke('nod:connection:open'),
  closeConnectionSettings: () => invoke('nod:connection:close'),
  continueOnboarding: () => invoke('nod:onboarding:continue'),
  saveSettings: (input) => invoke('nod:settings:save', input),
  getPreferences: () => invoke('nod:preferences:get'),
  prepare: (options) => invoke('nod:prepare', options),
  warmup: () => invoke('nod:warmup'),
  importRuntime: () => invoke('nod:runtime:import'),
  installWsl: () => invoke('nod:runtime:install-wsl'),
  showStartupLog: () => invoke('nod:startup-log:show'),
  onStatus: (listener) => subscribe('nod:status', listener),
  onPreferences: (listener) => subscribe('nod:preferences', listener),
});
