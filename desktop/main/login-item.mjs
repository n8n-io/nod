import { app } from 'electron';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const autostartEntry =
  '[Desktop Entry]\nType=Application\nName=Nod\nExec=flatpak run io.n8n.Nod\nX-Flatpak=io.n8n.Nod\n';
const autostartPath = () =>
  join(
    process.env.HOST_XDG_CONFIG_HOME || join(homedir(), '.config'),
    'autostart',
    'io.n8n.Nod.desktop',
  );

export function opensAtLogin() {
  if (process.platform !== 'linux') {
    const login = app.getLoginItemSettings();
    return process.platform === 'win32' ? login.executableWillLaunchAtLogin : login.openAtLogin;
  }
  try {
    return readFileSync(autostartPath(), 'utf8') === autostartEntry;
  } catch {
    return false;
  }
}

export function setOpenAtLogin(open) {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: open });
  if (!open) return rmSync(autostartPath(), { force: true });
  if (process.env.FLATPAK_ID !== 'io.n8n.Nod') throw new Error('Open at login needs the Flatpak.');
  mkdirSync(dirname(autostartPath()), { recursive: true });
  writeFileSync(autostartPath(), autostartEntry);
}
