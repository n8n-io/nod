import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
async function windowsPoint(point, signal, bounds) {
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    fileURLToPath(new URL('./windows-screen-point.ps1', import.meta.url)),
  ];
  if (bounds)
    args.push(
      '-Left',
      String(bounds.x),
      '-Top',
      String(bounds.y),
      '-Width',
      String(bounds.width),
      '-Height',
      String(bounds.height),
    );
  if (point) args.push('-Point', '-X', String(point.x), '-Y', String(point.y));
  const { stdout } = await exec(
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args,
    { windowsHide: true, timeout: 10000, signal },
  );
  return JSON.parse(stdout);
}

export function monitorSharing({ desktopCapturer, screen, policy, inspect = windowsPoint }) {
  let latest;
  let serial = 0;
  const list = () =>
    screen.getAllDisplays().map((d) => ({
      display: String(d.id),
      primary: d.id === screen.getPrimaryDisplay().id,
      bounds: d.bounds,
      scale: d.scaleFactor,
      rotation: d.rotation,
    }));
  let expiry;
  function clear() {
    serial++;
    latest = undefined;
    clearTimeout(expiry);
  }
  async function allowed(d, keptOut, signal) {
    const origin = screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y });
    const bounds = {
      ...origin,
      width: Math.round(d.bounds.width * d.scale),
      height: Math.round(d.bounds.height * d.scale),
    };
    const { programs } = await inspect(null, signal, bounds);
    if (
      !Array.isArray(programs) ||
      programs.some((app) => {
        const rule = policy.computerAppRule(app, keptOut);
        return (
          rule.kind === 'blocked' &&
          [
            'an app the owner keeps Nod out of',
            'a password manager',
            'a crypto wallet',
            'system settings or security',
            'a terminal',
            'an app that runs scripts or commands',
          ].includes(rule.why)
        );
      })
    )
      throw Error('Minimize protected windows on this monitor before sharing it.');
    signal.throwIfAborted();
  }
  async function capture(d, signal) {
    const factor = Math.min(1, 1536 / d.bounds.width, 1024 / d.bounds.height);
    const size = {
      width: Math.max(1, Math.round(d.bounds.width * factor)),
      height: Math.max(1, Math.round(d.bounds.height * factor)),
    };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: size,
      fetchWindowIcons: false,
    });
    signal.throwIfAborted();
    const source = sources.find((s) => s.display_id === d.display);
    if (!source || source.thumbnail.isEmpty()) throw Error('The selected display is unavailable.');
    return source.thumbnail.resize({ ...size, quality: 'good' });
  }
  async function request(input, signal) {
    signal.throwIfAborted();
    if (input.ownerChat !== true || !input.turn || !Array.isArray(input.keptOut))
      throw Error('Monitor access needs a current owner chat.');
    const displays = list();
    if (input.op === 'displays') return { displays };
    if (input.op === 'screen') {
      clear();
      const n = serial;
      const d = input.display
        ? displays.find((d) => d.display === input.display)
        : displays.find((d) => d.primary);
      if (!d) throw Error('Select a display returned by displays.');
      await allowed(d, input.keptOut, signal);
      const image = await capture(d, signal);
      await allowed(d, input.keptOut, signal);
      if (n !== serial || !list().some((v) => JSON.stringify(v) === JSON.stringify(d)))
        throw Error('The display changed; capture it again.');
      const { width, height } = image.getSize();
      latest = { id: randomUUID(), turn: input.turn, d, image, width, height, at: Date.now() };
      expiry = setTimeout(clear, 120000);
      expiry.unref?.();
      return {
        image: image.toPNG().toString('base64'),
        frame: latest.id,
        display: d.display,
        width,
        height,
      };
    }
    if (input.op !== 'point') throw Error('Unknown monitor operation.');
    const f = latest;
    if (
      !f ||
      f.id !== input.frame ||
      f.turn !== input.turn ||
      Date.now() - f.at > 120000 ||
      !displays.some((d) => JSON.stringify(d) === JSON.stringify(f.d))
    )
      throw Error('Capture this display again.');
    const { x, y } = input;
    if (![x, y].every(Number.isSafeInteger) || x < 0 || y < 0 || x >= f.width || y >= f.height)
      throw Error('Point lies outside the image.');
    await allowed(f.d, input.keptOut, signal);
    const live = await capture(f.d, signal);
    const left = Math.max(0, x - 18),
      top = Math.max(0, y - 18);
    const patch = {
      x: left,
      y: top,
      width: Math.min(f.width - left, 37),
      height: Math.min(f.height - top, 37),
    };
    if (!live.crop(patch).toBitmap().equals(f.image.crop(patch).toBitmap()))
      throw Error('The point changed since the image; capture it again.');
    const physical = screen.dipToScreenPoint({
      x: f.d.bounds.x + Math.floor(((x + 0.5) * f.d.bounds.width) / f.width),
      y: f.d.bounds.y + Math.floor(((y + 0.5) * f.d.bounds.height) / f.height),
    });
    const hit = await inspect(physical, signal);
    signal.throwIfAborted();
    if (
      latest !== f ||
      !hit.app ||
      policy.computerAppRule(hit.app, input.keptOut).kind === 'blocked'
    )
      throw Error('This desktop surface is protected.');
    return { app: hit.app, pid: hit.pid, window: hit.window, name: hit.name, role: hit.role };
  }
  return Object.assign(request, { clear });
}
