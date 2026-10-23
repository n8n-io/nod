import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname } from 'node:path';
import { build } from 'esbuild';

const output = resolve(process.argv[2] ?? '.local/nod-media');
await mkdir(output, { recursive: true });
await build({
  entryPoints: ['docs/media/trust-tour.tsx'],
  bundle: true,
  outfile: `${output}/tour.js`,
  jsx: 'automatic',
  loader: { '.woff2': 'file' },
  logLevel: 'warning',
  plugins: [
    {
      name: 'compiled-styles',
      setup(builder) {
        builder.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'css' }));
      },
    },
  ],
});
const css = (await readdir('dist/web/assets')).find(
  (name) => name.startsWith('index-') && name.endsWith('.css'),
);
assert(css, 'Run pnpm run build before capture.');
await writeFile(
  `${output}/tour.css`,
  `${await readFile(`dist/web/assets/${css}`, 'utf8')}\n${await readFile('docs/media/trust-tour.css', 'utf8')}`,
);
const mime = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname;
    if (path === '/') {
      response.setHeader('Content-Type', 'text/html');
      response.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/tour.css"></head><body><div id="root"></div><script src="/tour.js"></script></body></html>',
      );
      return;
    }
    const root = path.startsWith('/tour.') ? output : resolve('public');
    const file = resolve(root, `.${path}`);
    assert(file.startsWith(`${root}/`));
    response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(`${tmpdir()}/nod-media-chrome-`);
let chrome;
let socket;
try {
  chrome = spawn(
    process.env.NOD_MEDIA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await once(chrome, 'spawn');
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number((await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n')[0]);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert(port, 'Chrome did not start.');
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(
        message.params.exceptionDetails.exception?.description ??
          message.params.exceptionDetails.text,
      );
    pending.get(message.id)?.(message);
  };
  const send = async (method, params = {}) => {
    const current = ++id;
    const result = await Promise.race([
      new Promise((resolve) => {
        pending.set(current, resolve);
        socket.send(JSON.stringify({ id: current, method, params }));
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`${method} timed out.`)), 30000).unref(),
      ),
    ]);
    pending.delete(current);
    assert(!result.error, result.error?.message);
    return result.result;
  };
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert(!result.exceptionDetails, result.exceptionDetails?.exception?.description);
    return result.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  for (let i = 0; i < 100 && !(await evaluate('window.mediaReady === true')); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  assert(await evaluate('window.mediaReady === true'), 'The media page did not load.');
  await evaluate('document.fonts.ready');
  const scenes = await evaluate('window.mediaScenes');
  for (let i = 0; i < scenes.length; i++) {
    await evaluate(`window.renderMedia(${i})`);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await evaluate('document.activeElement?.blur()');
    assert(!(await evaluate('/otto/i.test(document.body.innerText)')), 'An old name remains.');
    if (i === 1)
      assert.equal(
        await evaluate('getComputedStyle(document.querySelector(".message-text")).fontSize'),
        '22px',
      );
    if (scenes[i].view === 'usage')
      assert(
        await evaluate('document.body.innerText.includes("nod spent")'),
        'Usage did not load.',
      );
    const screenshot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await writeFile(`${output}/scene-${i}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  await mkdir(`${output}/screens`, { recursive: true });
  for (const [name, width, height, kind, theme, limit] of [
    ['card-usage-light', 660, 495, 'usage-card', 'light'],
    ['card-usage-dark', 660, 495, 'usage-card', 'dark'],
    ['usage-light', 1000, 680, 'usage', 'light'],
    ['vault-light', 1000, 680, 'vault', 'light'],
    ['usage-task-limit', 1000, 680, 'usage-limit', 'light', true],
    ['verify-code-page', 800, 450, 'code', 'light'],
  ]) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await evaluate(
      `document.documentElement.dataset.theme=${JSON.stringify(theme)}; window.renderMedia(0,${JSON.stringify(kind)})`,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (limit) {
      await evaluate(
        `Array.from(document.querySelectorAll('button')).find(button => button.textContent.includes('$5')).click()`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    await evaluate('document.activeElement?.blur()');
    assert(
      !(await evaluate(
        '/could not be opened|No media fixture|Opening your form/.test(document.body.innerText)',
      )),
      'A capture has an error state.',
    );
    assert(!(await evaluate('/otto/i.test(document.body.innerText)')), 'An old name remains.');
    const clip = limit
      ? await evaluate(
          `(() => {const a=document.querySelector('.usage-sentence').getBoundingClientRect();const b=document.querySelector('.statement-pop').getBoundingClientRect();const x=Math.max(0,Math.min(a.x,b.x)-16),y=Math.max(0,Math.min(a.y,b.y)-16);return {x,y,width:Math.min(innerWidth-x,Math.max(a.right,b.right)-x+16),height:Math.max(a.bottom,b.bottom)-y+16,scale:1};})()`,
        )
      : undefined;
    const screenshot = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(clip && { clip }),
    });
    await writeFile(`${output}/screens/${name}.png`, Buffer.from(screenshot.data, 'base64'));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(await evaluate('window.mediaMissingPaths'), [], 'An API fixture is missing.');
  await writeFile(`${output}/scenes.json`, JSON.stringify(scenes, null, 2));
  console.log(`Captured ${scenes.length} scenes with no page errors.`);
} finally {
  socket?.close();
  chrome?.kill();
  server.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
