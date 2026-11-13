import { spawn } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const [worktreeArg, fixturesArg, planArg, outArg] = process.argv.slice(2);
if (!outArg) {
  console.error('usage: node capture.mjs <nod-worktree> <fixtures.json> <plan.json> <out-dir>');
  process.exit(1);
}
const worktree = resolve(worktreeArg);
const fixtureSource = resolve(fixturesArg);
const plan = JSON.parse(readFileSync(resolve(planArg), 'utf8'));
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const fixtures = join(mkdtempSync(join(tmpdir(), 'nod-capture-fixtures-')), 'fixtures.json');
copyFileSync(fixtureSource, fixtures);
const here = dirname(fileURLToPath(import.meta.url));
copyFileSync(join(here, 'vite.capture.config.ts'), join(worktree, 'vite.capture.config.ts'));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  if (existsSync(cache)) {
    for (const b of readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse())
      for (const arch of ['chrome-mac-arm64', 'chrome-mac']) {
        const c = join(
          cache,
          b,
          arch,
          'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
        );
        if (existsSync(c)) return c;
      }
  }
  const system = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(system)) return system;
  throw new Error('No Chrome found. Set CHROME to a Chrome or Chromium binary.');
}

const vitePort = Number(process.env.NOD_CAPTURE_PORT ?? 4395);
const log = join(out, 'api.log');
writeFileSync(log, '');
const vite = spawn(
  join(worktree, 'node_modules/.bin/vite'),
  ['--config', 'vite.capture.config.ts'],
  {
    cwd: worktree,
    env: {
      ...process.env,
      NOD_CAPTURE_FIXTURES: fixtures,
      NOD_CAPTURE_LOG: log,
      NOD_CAPTURE_PORT: String(vitePort),
    },
    stdio: 'ignore',
  },
);
const port = 9300 + Math.floor(Math.random() * 600);
const profile = mkdtempSync(join(tmpdir(), 'nod-capture-chrome-'));
const vw = plan.viewport?.width ?? 900,
  vh = plan.viewport?.height ?? 700;
const browser = spawn(
  findChrome(),
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--hide-scrollbars',
    '--font-render-hinting=none',
    `--window-size=${vw},${vh}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try {
    browser.kill();
  } catch {}
  try {
    rmSync(join(worktree, 'vite.capture.config.ts'), { force: true });
  } catch {}
  try {
    vite.kill();
  } catch {}
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {}
};
process.on('exit', cleanup);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 150; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${vitePort}/`)).ok) break;
  } catch {}
  await sleep(200);
}
let wsUrl;
for (let i = 0; i < 75 && !wsUrl; i++) {
  try {
    wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(
      (e) => e.type === 'page',
    )?.webSocketDebuggerUrl;
  } catch {}
  if (!wsUrl) await sleep(200);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { ok, reject } = pending.get(data.id);
    pending.delete(data.id);
    data.error ? reject(new Error(data.error.message)) : ok(data.result);
  } else if (data.method === 'Runtime.exceptionThrown')
    errors.push(
      data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text,
    );
});
const send = (method, params = {}) =>
  new Promise((ok, reject) => {
    const n = ++id;
    pending.set(n, { ok, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: vw,
  height: vh,
  deviceScaleFactor: plan.viewport?.scale ?? 2,
  mobile: false,
});
if (plan.time)
  await send('Emulation.setTimezoneOverride', { timezoneId: plan.time.zone ?? 'Europe/Berlin' });
if (plan.time?.now)
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `{const o=${Date.parse(plan.time.now)}-Date.now(),D=Date;Date=class extends D{constructor(...a){a.length?super(...a):super(D.now()+o)}static now(){return D.now()+o}};}`,
  });

const find = (target) =>
  `(()=>{const t=${JSON.stringify(target)};if(t.selector)return document.querySelectorAll(t.selector)[t.index??0]??null;const all=[...document.querySelectorAll(t.within??'button,a,[role=button],summary')].filter(e=>e.offsetParent!==null&&e.textContent.trim().replace(/\\s+/g,' ')${'.includes(t.text)'});return all[t.index??0]??null;})()`;
const rectOf = (target) =>
  evaluate(
    `(()=>{const e=${find(target)};if(!e)return null;const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};})()`,
  );
const shots = {};
for (const step of plan.steps) {
  if (step.goto) {
    await send('Page.navigate', { url: `http://127.0.0.1:${vitePort}${step.goto}` });
    await sleep(step.wait ?? 2500);
  } else if (step.click) {
    const r = await rectOf(step.click);
    if (!r) throw new Error(`click target not found: ${JSON.stringify(step.click)}`);
    const x = r.x + r.w / 2,
      y = r.y + r.h / 2;
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
      await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    await sleep(step.wait ?? 600);
  } else if (step.hover) {
    const r = await rectOf(step.hover);
    if (!r) throw new Error(`hover target not found: ${JSON.stringify(step.hover)}`);
    await send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: r.x + r.w / 2,
      y: r.y + r.h / 2,
    });
    await sleep(step.wait ?? 300);
  } else if (step.fixtures) {
    const data = JSON.parse(readFileSync(fixtures, 'utf8'));
    writeFileSync(fixtures, JSON.stringify({ ...data, ...step.fixtures }, null, 2));
    await sleep(step.wait ?? 0);
  } else if (step.eval) {
    await evaluate(step.eval);
    await sleep(step.wait ?? 300);
  } else if (step.wait) {
    await sleep(step.wait);
  } else if (step.shot) {
    const rects = {};
    for (const [name, target] of Object.entries(step.rects ?? {})) {
      rects[name] = await rectOf(target);
      if (!rects[name])
        throw new Error(
          `rect target not found for ${step.shot}.${name}: ${JSON.stringify(target)}`,
        );
    }
    let clip = step.clip ? await rectOf(step.clip) : null;
    if (step.clip && !clip) throw new Error(`clip target not found for ${step.shot}`);
    if (clip) {
      const pad = step.clip.pad ?? 0;
      const y = Math.max(0, clip.y - pad);
      clip = step.clip.toBottom
        ? { x: 0, y, w: vw, h: Math.min(vh - y, step.clip.height ?? vh) }
        : {
            x: Math.max(0, clip.x - pad),
            y,
            w: Math.min(vw, clip.w + pad * 2),
            h: clip.h + pad * 2,
          };
      for (const r of Object.values(rects)) {
        r.x -= clip.x;
        r.y -= clip.y;
      }
    }
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      ...(clip ? { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 } } : {}),
    });
    writeFileSync(join(out, `${step.shot}.png`), Buffer.from(data, 'base64'));
    shots[step.shot] = { width: clip?.w ?? vw, height: clip?.h ?? vh, rects };
    console.log(`shot ${step.shot}`);
  }
}
writeFileSync(join(out, 'shots.js'), `window.SHOTS=${JSON.stringify(shots)};`);
const misses = [
  ...new Set(
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l.startsWith('MISS')),
  ),
];
if (misses.length) console.log(`requests without a fixture:\n${misses.join('\n')}`);
if (errors.length) console.log(`page errors:\n${[...new Set(errors)].join('\n')}`);
rmSync(join(worktree, 'vite.capture.config.ts'), { force: true });
process.exit(0);
