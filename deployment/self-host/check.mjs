import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('.', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'nod-host-check-'));
const project = `nod-check-${randomUUID()}`;
const envFile = join(scratch, '.env');
const environment = Object.fromEntries(
  ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME', 'TMPDIR'].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : [],
  ),
);
environment.NOD_ENV_FILE = envFile;
const command = (args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString());
      else reject(new Error(`Docker check failed (${code}): ${Buffer.concat(errors).toString()}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
const compose = (...args) =>
  command(['compose', '--project-directory', directory, '--env-file', envFile, ...args]);
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://localhost:${port}`;
environment.PORT = String(port);
const originalToken = randomBytes(32).toString('base64url');
const password = randomBytes(32).toString('base64url');
const vault = randomBytes(32).toString('base64');
const example = await readFile(join(directory, '.env.example'), 'utf8');
const writeEnvironment = (token) =>
  writeFile(
    envFile,
    [
      example,
      `COMPOSE_PROJECT_NAME=${project}`,
      `NOD_AUTH_TOKEN=${token}`,
      `NOD_POSTGRES_PASSWORD=${password}`,
      `NOD_VAULT_KEY=${vault}`,
      `NOD_IMAGE_TAG=${process.env.NOD_IMAGE_TAG || 'local'}`,
      'NOD_ANALYTICS_ENABLED=false',
      'NOD_FEEDBACK_ENABLED=false',
      'NOD_COMPOSIO_PROXY_URL=',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
const request = (token, options = {}) =>
  fetch(origin + '/api/session', {
    ...options,
    headers: { ...(token && { authorization: `Bearer ${token}` }), ...options.headers },
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
try {
  await writeEnvironment(originalToken);
  await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
  assert.equal((await request()).status, 401);
  assert.equal((await request('synthetic-invalid-token')).status, 401);
  assert.equal(
    (await request(originalToken, { headers: { Origin: 'https://untrusted.invalid' } })).status,
    403,
  );
  const wrongHost = await new Promise((resolve, reject) => {
    const connection = http.get(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/session',
        headers: { host: 'untrusted.invalid', authorization: `Bearer ${originalToken}` },
        timeout: 10_000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    connection.on('error', reject);
    connection.on('timeout', () => connection.destroy(new Error('Host check timed out.')));
  });
  assert.equal(wrongHost, 403);
  const session = await request(originalToken);
  assert.equal(session.status, 200);
  assert.ok((await session.json()).user.id);
  const login = await fetch(origin + '/api/access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ key: originalToken }),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.equal(
    (await request(undefined, { headers: { Cookie: cookie.split(';')[0] } })).status,
    200,
  );
  console.log('Shell PORT override, Bearer, web cookie, and Host/Origin authentication passed.');
  const runtimeAddress = (
    await command([
      'inspect',
      '--format',
      '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      `${project}-runtime-1`,
    ])
  ).trim();
  assert.match(runtimeAddress, /^\d+\.\d+\.\d+\.\d+$/);
  const networkScript = `node -e 'const socket=require("node:net").connect({host:"${runtimeAddress}",port:2375});socket.on("connect",()=>process.exit(1));socket.on("error",()=>process.exit(0));setTimeout(()=>process.exit(0),1500);'`;
  const id = randomUUID();
  const probe = `
    import assert from 'node:assert/strict';
    import { mkdir, readFile, writeFile } from 'node:fs/promises';
    import { createDockerWorkspace } from './src/providers/docker/index.ts';
    import { createContainerBrowserComputer } from './src/providers/container-browser/index.ts';
    import { pool } from './src/server/db.ts';
    const id=${JSON.stringify(id)};
    const root=process.env.NOD_DATA_ROOT;
    const path=root+'/workspaces/'+id;
    await mkdir(path,{recursive:true});
    const workspace=createDockerWorkspace({container:process.env.WORKSPACE_CONTAINER,workspaceRoot:root+'/workspaces'});
    const browser=createContainerBrowserComputer({container:process.env.BROWSER_CONTAINER,dataRoot:root});
    try {
      const chunks=[];
      const session=workspace.open({threadId:id,workspacePath:path,signal:new AbortController().signal});
      const result=await session.exec('printf synthetic-persistence > probe.txt; test ! -S /var/run/docker.sock; test -z "$NOD_AUTH_TOKEN"; test -z "$NOD_VAULT_KEY"; test ! -e /app/.env; printf synthetic-output',{onData:chunk=>chunks.push(chunk)});
      assert.equal(result.exitCode,0);
      assert.equal(Buffer.concat(chunks).toString(),'synthetic-output');
      assert.equal(await readFile(path+'/probe.txt','utf8'),'synthetic-persistence');
      await pool.query('CREATE TABLE nod_hosting_probe (value text NOT NULL)');
      await pool.query('INSERT INTO nod_hosting_probe VALUES ($1)',['synthetic-persistence']);
      await writeFile(root+'/hosting-probe','synthetic-persistence');
      await assert.rejects(browser.act(id,{action:'snapshot'}),error=>error.code==='browser_not_open');
      const denied=await fetch('http://runtime:2375/containers/json');
      assert.equal(denied.status,403);
      const control=await session.exec(${JSON.stringify(networkScript)});
      assert.equal(control.exitCode,0);
    } finally {await workspace.dispose();await browser.dispose();await pool.end();}
  `;
  await command(
    ['exec', '-i', `${project}-server-1`, 'node', '--import', 'tsx', '--input-type=module'],
    probe,
  );
  console.log(
    'Workspace execution, browser bridge, secret isolation, and private runtime network passed.',
  );
  const replacement = randomBytes(32).toString('base64url');
  await writeEnvironment(replacement);
  await compose(
    'up',
    '-d',
    '--no-build',
    '--force-recreate',
    '--wait',
    '--wait-timeout',
    '120',
    'server',
    'workspace',
    'browser',
  );
  assert.equal((await request(originalToken)).status, 401);
  assert.equal(
    (await request(undefined, { headers: { Cookie: cookie.split(';')[0] } })).status,
    401,
  );
  assert.equal((await request(replacement)).status, 200);
  await command(
    ['exec', '-i', `${project}-server-1`, 'node', '--import', 'tsx', '--input-type=module'],
    `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pool} from './src/server/db.ts';
     assert.equal(await readFile(process.env.NOD_DATA_ROOT+'/hosting-probe','utf8'),'synthetic-persistence');
     assert.equal(await readFile(process.env.NOD_DATA_ROOT+'/workspaces/${id}/probe.txt','utf8'),'synthetic-persistence');
     assert.equal((await pool.query('SELECT value FROM nod_hosting_probe')).rows[0].value,'synthetic-persistence');
     await pool.end();`,
  );
  const logs = await compose('logs', '--no-color', 'server', 'runtime');
  for (const secret of [originalToken, replacement, password, vault])
    assert.ok(!logs.includes(secret));
  console.log(
    'Container replacement preserves data; token rotation revokes old Bearer and cookie access without logging secrets.',
  );
} finally {
  await compose('down', '--volumes', '--remove-orphans').catch(() => {});
  await rm(scratch, { recursive: true, force: true });
}
