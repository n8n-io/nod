import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createContainerBrowserComputer } from '../../src/providers/container-browser/index.ts';

const execute = promisify(execFile);
const run = async (args) =>
  (await execute('docker', args, { timeout: 30_000, maxBuffer: 32 * 1024 })).stdout.trim();
const name = `nod-browser-build-${randomUUID()}`;
const dataRoot = await mkdtemp(join(tmpdir(), 'nod-browser-build-'));
const computer = createContainerBrowserComputer({ dataRoot, container: name });
try {
  await run([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'dev.nod.desktop.disposable=true',
    '--init',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--read-only',
    '--pids-limit',
    '768',
    '--shm-size',
    '256m',
    '--memory',
    '2g',
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:size=1g',
    '--tmpfs',
    '/home/node:uid=1000,gid=1000,mode=700,size=256m',
    '--tmpfs',
    '/data:uid=1000,gid=1000,mode=700,size=256m',
    process.argv[2] || 'nod-desktop-browser:experiment',
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if ((await run(['inspect', '--format', '{{.State.Running}}', name])) !== 'true')
      throw new Error('The built browser worker exited before its control socket was ready.');
    try {
      await run([
        'exec',
        name,
        'node',
        '-e',
        'const s=require("node:net").connect("/data/control.sock");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>process.exit(1))',
      ]);
      ready = true;
      break;
    } catch {}
    await delay(500);
  }
  assert.ok(ready, 'The built browser control socket did not become ready.');
  await run([
    'exec',
    name,
    'node',
    '-e',
    'const fs=require("node:fs");for(const p of ["/Users","/opt/nod-assets","/var/run/docker.sock"])if(fs.existsSync(p))process.exit(1);if(Object.keys(process.env).some(k=>!["PATH","HOSTNAME","HOME","NODE_VERSION","YARN_VERSION"].includes(k)))process.exit(1)',
  ]);
  const thread = randomUUID();
  const result = await computer.act(thread, { action: 'open', url: 'https://example.com' });
  assert.equal(new URL(result.url).origin, 'https://example.com');
  assert.ok((await computer.screenshot(thread)).length > 100);
  console.log(
    'Built browser worker, public navigation, screenshot, and credential/mount boundaries passed.',
  );
} finally {
  await computer.dispose().catch(() => {});
  await run(['rm', '--force', name]).catch(() => {});
  await rm(dataRoot, { recursive: true, force: true });
}
