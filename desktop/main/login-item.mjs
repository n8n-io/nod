import { app } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const backgroundSwitch = '--background';
const flatpak = () => process.env.FLATPAK_ID === 'io.n8n.Nod';
const autostartEntry = (background = true) =>
  `[Desktop Entry]\nType=Application\nName=Nod\nExec=${flatpak() ? 'flatpak run io.n8n.Nod' : 'nod'}${background ? ` ${backgroundSwitch}` : ''}\n${flatpak() ? 'X-Flatpak=io.n8n.Nod\n' : ''}`;
const autostartPath = () =>
  join(
    (flatpak() ? process.env.HOST_XDG_CONFIG_HOME : process.env.XDG_CONFIG_HOME) ||
      join(homedir(), '.config'),
    'autostart',
    'io.n8n.Nod.desktop',
  );

export function opensAtLogin() {
  if (process.platform !== 'linux') {
    const login = app.getLoginItemSettings();
    return process.platform === 'win32' ? login.executableWillLaunchAtLogin : login.openAtLogin;
  }
  try {
    return [autostartEntry(), autostartEntry(false)].includes(
      readFileSync(autostartPath(), 'utf8'),
    );
  } catch {
    return false;
  }
}

export function setOpenAtLogin(open) {
  if (process.platform === 'win32')
    return app.setLoginItemSettings({ openAtLogin: open, args: [backgroundSwitch] });
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: open });
  if (!open) return rmSync(autostartPath(), { force: true });
  if (!flatpak() && process.env.NOD_PACKAGE !== 'rpm')
    throw new Error('Open at login needs the Flatpak or the RPM package.');
  mkdirSync(dirname(autostartPath()), { recursive: true });
  writeFileSync(autostartPath(), autostartEntry());
}

export function refreshLoginItem() {
  if (process.platform !== 'darwin' && opensAtLogin()) setOpenAtLogin(true);
}

export function launchedInBackground(argv) {
  return argv.includes(backgroundSwitch);
}

export function openedAtLogin() {
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin === true;
  return launchedInBackground(process.argv);
}
