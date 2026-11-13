import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const usage = `usage:
  node render.mjs stills <page.html> <t1,t2,...> [out-dir]
  node render.mjs video  <page.html> <out.mp4> [--fps 60] [--duration seconds]
  node render.mjs sound  <page.html> <out.json>
  node render.mjs eval   <page.html> <js-expression>`;
const [mode, pageArg, ...rest] = process.argv.slice(2);
if (!mode || !pageArg) {
  console.error(usage);
  process.exit(1);
}
const flag = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : fallback;
};
const page = resolve(pageArg);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const b of builds) {
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const candidate = join(
          cache,
          b,
          arch,
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        );
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(system)) return system;
  throw new Error('No Chrome found. Set CHROME to a Chrome or Chromium binary.');
}

const port = Number(process.env.PORT ?? 9300 + Math.floor(Math.random() * 600));
const profile = mkdtempSync(join(tmpdir(), 'nod-video-chrome-'));
const browser = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    '--font-render-hinting=none',
    '--window-size=540,540',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try {
    browser.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);

async function target() {
  for (let i = 0; i < 75; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const pageTarget = list.find((entry) => entry.type === 'page');
      if (pageTarget) return pageTarget.webSocketDebuggerUrl;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome did not open a debugging target on port ${port}`);
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { ok, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.error
      ? reject(new Error(`${data.error.message} ${data.error.data ?? ''}`))
      : ok(data.result);
  } else if (data.method) events.push(data);
});
const send = (method, params = {}) =>
  new Promise((ok, reject) => {
    const n = ++id;
    pending.set(n, { ok, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`${d.exception?.description ?? d.text} (line ${d.lineNumber})`);
  }
  return result.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 540,
  height: 540,
  deviceScaleFactor: 2,
  mobile: false,
});
await send('Page.navigate', { url: `file://${page}` });
for (let i = 0; i < 100 && !events.some((e) => e.method === 'Page.loadEventFired'); i++)
  await new Promise((r) => setTimeout(r, 100));
const pageErrors = events.filter((e) => e.method === 'Runtime.exceptionThrown');
if (pageErrors.length) {
  console.error(
    pageErrors
      .map(
        (e) => e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text,
      )
      .join('\n'),
  );
  process.exit(1);
}
await evaluate('window.ready');

const shot = async (t) => {
  await evaluate(`render(${t})`);
  const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  return Buffer.from(data, 'base64');
};

if (mode === 'eval') {
  console.log(JSON.stringify(await evaluate(rest[0]), null, 2));
} else if (mode === 'sound') {
  const sound = await evaluate('window.SOUND ?? null');
  if (!sound) throw new Error('The page does not define window.SOUND');
  writeFileSync(rest[0], JSON.stringify(sound, null, 2));
  console.log(`wrote ${rest[0]}`);
} else if (mode === 'stills') {
  const out = resolve(rest[1] ?? join(dirname(page), `${basename(page, '.html')}-stills`));
  mkdirSync(out, { recursive: true });
  const times = rest[0].split(',').map(Number);
  for (const t of times)
    writeFileSync(join(out, `t${t.toFixed(2).padStart(5, '0')}.png`), await shot(t));
  console.log(`wrote ${times.length} stills to ${out}`);
} else if (mode === 'video') {
  const output = resolve(rest[0]);
  const fps = Number(flag('fps', 60));
  const duration = Number(flag('duration', 0)) || (await evaluate('window.DURATION ?? null'));
  if (!duration) throw new Error('Pass --duration or set window.DURATION in the page');
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-c:v',
      'png',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-r',
      String(fps),
      output,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const frames = Math.round(duration * fps);
  const started = Date.now();
  for (let f = 0; f < frames; f++) {
    const png = await shot(f / fps);
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (f % 300 === 0) console.log(`frame ${f}/${frames}`);
  }
  ffmpeg.stdin.end();
  await new Promise((r) => ffmpeg.on('close', r));
  console.log(
    `wrote ${output} (${duration}s, ${frames} frames) in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
} else {
  console.error(usage);
  process.exit(1);
}
ws.close();
cleanup();
process.exit(0);
