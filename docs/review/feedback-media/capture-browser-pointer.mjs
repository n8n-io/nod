import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const beforeRevision = process.argv[2] || 'e79bf5d2fcfcadb093102c31f1e240b44cd210ce';
const afterRevision = process.argv[3] || 'HEAD';
const output = resolve(
  process.argv[4] || join(repository, '.local/feedback-review/pointer-recapture'),
);
await mkdir(output, { recursive: true });
const snapshots = await mkdtemp(join(output, 'snapshots-'));
const git = (...args) =>
  execFileSync('git', ['-C', repository, ...args], { maxBuffer: 64 * 1024 * 1024 });
const providerPath = 'src/providers/agent-browser/index.ts';
const results = {
  capturedAt: new Date().toISOString(),
  harness: 'capture-browser-pointer.mjs',
  scope:
    'Native Chromium providers from frozen Git source snapshots. Identical synthetic page, viewport, zoom, marker readiness, input and marker removal on both sides. No live account, model or external website.',
  viewport: { width: 1440, height: 900 },
  marker: { rgb: [255, 0, 255], removedBeforeScreenshot: true },
  runs: [],
};
const html =
  '<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#fafafa;font:16px system-ui}button{position:fixed;left:10%;top:10%;width:10%;height:10%;background:#e0ece3;border:2px solid #224c34;border-radius:12px;font:14px system-ui}output{position:fixed;left:20px;top:20px}#landing{position:fixed;width:18px;height:18px;border:3px solid #c84e4e;border-radius:50%;pointer-events:none;transform:translate(-50%,-50%)}#frame{position:fixed;top:0;left:0;font-size:1px;color:#aaa}</style><output>Click the target at 2× page zoom</output><button id="target">Target</button><i id="landing" hidden></i><span id="frame"></span><script>window.lastPointer=null;document.addEventListener("mousedown",event=>{window.lastPointer={x:event.clientX,y:event.clientY,target:event.target.id};const landed=document.querySelector("#landing");landed.hidden=false;landed.style.left=event.clientX+"px";landed.style.top=event.clientY+"px";landed.style.borderColor=event.target.id==="target"?"#20743d":"#c84e4e";document.querySelector("output").textContent="Pointer landed at "+event.clientX+", "+event.clientY+" · "+(event.target.id==="target"?"Target hit":"Target missed")});let count=0;function paint(){document.querySelector("#frame").textContent=String(count++);requestAnimationFrame(paint)}paint();</script>';
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const pixels = createCanvas(1, 1).getContext('2d');
try {
  for (const [name, ref] of [
    ['before', beforeRevision],
    ['after', afterRevision],
  ]) {
    const revision = git('rev-parse', ref).toString().trim();
    const snapshot = join(snapshots, name);
    await mkdir(snapshot);
    execFileSync('tar', ['-x', '-C', snapshot], {
      input: git('archive', revision, 'src', 'package.json'),
    });
    await symlink(join(repository, 'node_modules'), join(snapshot, 'node_modules'), 'dir');
    const { createAgentBrowserComputer } = await import(
      pathToFileURL(join(snapshot, providerPath)).href
    );
    const { existingDaemonCommand } = await import(
      pathToFileURL(join(snapshot, 'src/providers/agent-browser/screens.ts')).href
    );
    const dataRoot = await mkdtemp(join(tmpdir(), 'nod-pointer-review-'));
    let socket = '';
    let inspector;
    const computer = createAgentBrowserComputer({
      dataRoot,
      browserExecutable:
        process.env.NOD_TEST_BROWSER_EXECUTABLE ||
        (process.platform === 'darwin'
          ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
          : undefined),
      headless: true,
      privateNetwork: true,
      viewport: results.viewport,
      daemonCommand: async (path, command, signal, timeout) => {
        socket = path;
        return existingDaemonCommand(path, command, signal, timeout);
      },
    });
    try {
      await computer.act('pointer', { action: 'open', url: `http://127.0.0.1:${address.port}` });
      const { cdpUrl } = await existingDaemonCommand(socket, { action: 'cdp_url' });
      const tabs = await existingDaemonCommand(socket, { action: 'tab_list' });
      const tab = tabs.tabs.find((item) => item.active);
      assert.ok(tab);
      inspector = new WebSocket(String(cdpUrl));
      await once(inspector, 'open', { signal: AbortSignal.timeout(20_000) });
      let sequence = 0;
      const send = (method, params, sessionId) =>
        new Promise((resolve, reject) => {
          const id = ++sequence;
          const cleanup = () => {
            clearTimeout(timeout);
            inspector.removeEventListener('message', receive);
            inspector.removeEventListener('close', fail);
            inspector.removeEventListener('error', fail);
          };
          const fail = () => {
            cleanup();
            reject(
              new Error(`CDP ${method} did not complete: inspector connection closed or failed`),
            );
          };
          const receive = (event) => {
            const message = JSON.parse(String(event.data));
            if (message.id !== id) return;
            cleanup();
            if (message.error) reject(new Error(message.error.message));
            else resolve(message.result);
          };
          const timeout = setTimeout(() => {
            cleanup();
            reject(new Error(`CDP ${method} timed out after 20 seconds`));
          }, 20_000);
          inspector.addEventListener('message', receive);
          inspector.addEventListener('close', fail);
          inspector.addEventListener('error', fail);
          if (inspector.readyState !== WebSocket.OPEN) {
            fail();
            return;
          }
          try {
            inspector.send(
              JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
            );
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
      const { sessionId } = await send('Target.attachToTarget', {
        targetId: tab.targetId,
        flatten: true,
      });
      await send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 }, String(sessionId));
      await existingDaemonCommand(socket, {
        action: 'evaluate',
        script:
          "document.documentElement.style.backgroundColor='rgb(255,0,255)';document.body.style.backgroundColor='rgb(255,0,255)'",
      });
      const controller = new AbortController();
      const frames = computer.view('pointer', controller.signal)[Symbol.asyncIterator]();
      const timeout = setTimeout(() => controller.abort(), 20_000);
      let decodedFrames = 0;
      let markerPixel;
      try {
        for (;;) {
          const frame = await frames.next();
          if (frame.done) {
            throw new Error(
              `${name} browser stream ended before the post-zoom magenta marker arrived`,
            );
          }
          const image = await loadImage(frame.value);
          pixels.drawImage(image, 1 - image.width, 1 - image.height);
          const color = pixels.getImageData(0, 0, 1, 1).data;
          decodedFrames++;
          if (color[0] > 127 && color[1] < 127 && color[2] > 127) {
            markerPixel = [...color];
            break;
          }
        }
        clearTimeout(timeout);
        const input = { x: 0.3, y: 0.3 };
        await computer.control('pointer', { type: 'mouse', event: 'down', ...input });
        await computer.control('pointer', { type: 'mouse', event: 'up', ...input });
        const { result: observed } = await existingDaemonCommand(socket, {
          action: 'evaluate',
          script: 'window.lastPointer',
        });
        assert.deepEqual(
          observed,
          name === 'before' ? { target: '', x: 432, y: 270 } : { target: 'target', x: 216, y: 135 },
        );
        const { result: restoredBackground } = await existingDaemonCommand(socket, {
          action: 'evaluate',
          script:
            "document.documentElement.style.backgroundColor='#fafafa';document.body.style.backgroundColor='#fafafa';({html:getComputedStyle(document.documentElement).backgroundColor,body:getComputedStyle(document.body).backgroundColor})",
        });
        assert.deepEqual(restoredBackground, {
          html: 'rgb(250, 250, 250)',
          body: 'rgb(250, 250, 250)',
        });
        const png = await computer.screenshot('pointer');
        assert.ok(png);
        const screenshot = `pointer-${name}.png`;
        await writeFile(join(output, screenshot), png);
        results.runs.push({
          name,
          sourceRevision: revision,
          sourceObject: git('rev-parse', `${revision}:${providerPath}`).toString().trim(),
          readiness:
            'Wait for the decoded JPEG bottom-right pixel to contain the post-zoom magenta background marker.',
          decodedFrames,
          markerPixel,
          restoredBackground,
          zoom: 2,
          input,
          expected: { x: 216, y: 135 },
          observed,
          screenshot,
          screenshotSha256: createHash('sha256').update(png).digest('hex'),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`No ${name} post-zoom magenta marker frame arrived within 20 seconds`, {
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        controller.abort();
        await frames.return?.();
      }
    } finally {
      inspector?.close();
      await computer.dispose().finally(() => rm(dataRoot, { recursive: true, force: true }));
    }
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(snapshots, { recursive: true, force: true });
}
