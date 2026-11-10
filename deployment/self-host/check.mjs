import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundle = process.argv[2] && resolve(process.argv[2]);
const scratch = await mkdtemp(join(tmpdir(), 'nod-host-check-'));
let directory = bundle
  ? join(scratch, 'installation')
  : fileURLToPath(new URL('.', import.meta.url));
if (bundle) await cp(bundle, directory, { recursive: true, mode: constants.COPYFILE_FICLONE });
let project = `nod-check-${randomUUID()}`;
let envFile = join(bundle ? directory : scratch, '.env');
const installations = [{ directory, envFile, project }];
const environment = Object.fromEntries(
  ['PATH', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME', 'TMPDIR'].flatMap((name) =>
    process.env[name] ? [[name, process.env[name]]] : [],
  ),
);
if (!bundle) environment.NOD_ENV_FILE = envFile;
const command = (args, input, executable = 'docker') =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: directory,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(output).toString());
      else reject(new Error(`Hosting check failed (${code}): ${Buffer.concat(errors).toString()}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
const compose = (...args) =>
  command([
    'compose',
    '--project-directory',
    directory,
    '--file',
    join(directory, 'compose.yaml'),
    '--env-file',
    envFile,
    ...args,
  ]);
const shell = (...args) => command(args, undefined, 'sh');
const listener = createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://localhost:${port}`;
environment.PORT = String(port);
let originalToken = randomBytes(32).toString('base64url');
let password = randomBytes(32).toString('base64url');
let vault = randomBytes(32).toString('base64');
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
  if (bundle) {
    const proxy = await readFile(join(directory, 'docker-proxy.mjs'));
    await writeFile(join(directory, 'docker-proxy.mjs'), 'corrupt bundle');
    await assert.rejects(shell('install.sh'), /Bundle checksum failed/);
    await assert.rejects(readFile(envFile), { code: 'ENOENT' });
    await writeFile(join(directory, 'docker-proxy.mjs'), proxy);
    const architecture = await readFile(join(directory, 'architecture'), 'utf8');
    const checksums = await readFile(join(directory, 'checksums.sha256'), 'utf8');
    const wrongArchitecture = architecture.trim() === 'amd64' ? 'arm64\n' : 'amd64\n';
    await writeFile(join(directory, 'architecture'), wrongArchitecture);
    await writeFile(
      join(directory, 'checksums.sha256'),
      checksums.replace(
        /^[a-f0-9]{64}  architecture$/m,
        `${createHash('sha256').update(wrongArchitecture).digest('hex')}  architecture`,
      ),
    );
    await assert.rejects(shell('install.sh'), /Docker requires/);
    await assert.rejects(readFile(envFile), { code: 'ENOENT' });
    await writeFile(join(directory, 'architecture'), architecture);
    await writeFile(join(directory, 'checksums.sha256'), checksums);
    await shell('setup.sh');
    const generated = await readFile(envFile, 'utf8');
    project = generated.match(/^COMPOSE_PROJECT_NAME=(.+)$/m)?.[1];
    assert.ok(project);
    assert.equal(
      (
        await command([
          'ps',
          '--all',
          '--quiet',
          '--filter',
          `label=com.docker.compose.project=${project}`,
        ])
      ).trim(),
      '',
    );
    assert.equal(
      (await command(['volume', 'ls', '--quiet', '--filter', `name=^${project}_`])).trim(),
      '',
    );
    installations[0].project = project;
    const installed = await shell('install.sh');
    originalToken = generated.match(/^NOD_AUTH_TOKEN=(.+)$/m)?.[1];
    password = generated.match(/^NOD_POSTGRES_PASSWORD=(.+)$/m)?.[1];
    vault = generated.match(/^NOD_VAULT_KEY=(.+)$/m)?.[1];
    assert.match(originalToken, /^[a-f0-9]{64}$/);
    assert.match(password, /^[a-f0-9]{64}$/);
    assert.equal(Buffer.from(vault, 'base64').length, 32);
    for (const secret of [originalToken, password, vault]) assert.ok(!installed.includes(secret));
    assert.ok(installed.includes(origin));
    assert.equal(
      (await compose('exec', '-T', 'server', 'node', '-p', 'process.env.NOD_APP_VERSION')).trim(),
      (await readFile(join(directory, 'source-revision'), 'utf8')).trim(),
    );
    await writeEnvironment(originalToken);
    console.log(
      'Standalone installation generates private keys and rejects corrupt or wrong-architecture bundles.',
    );
  } else {
    await writeEnvironment(originalToken);
    await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '120');
  }
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
  const providerKeys = JSON.parse(
    await command([
      'exec',
      `${project}-server-1`,
      'node',
      '--import',
      'tsx',
      '--input-type=module',
      '-e',
      "import {modelProviderInfo} from './src/shared/models.ts';console.log(JSON.stringify(Object.values(modelProviderInfo).map(provider=>provider.env)))",
    ]),
  );
  const providerEnvironment = Object.fromEntries(
    providerKeys.map((key) => [key, `synthetic-${randomBytes(24).toString('hex')}`]),
  );
  const savedEnvironment = await readFile(envFile, 'utf8');
  try {
    await writeFile(
      envFile,
      [
        savedEnvironment,
        ...Object.entries(providerEnvironment).map(([key, value]) => `${key}=${value}`),
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    for (const service of ['server', 'workspace', 'browser'])
      await compose(
        'run',
        '--rm',
        '--no-deps',
        '--entrypoint',
        'node',
        service,
        '-e',
        `const assert=require('node:assert/strict');for(const [key,value] of Object.entries(${JSON.stringify(providerEnvironment)}))assert.equal(process.env[key],${service === 'server' ? 'value' : 'undefined'},key);`,
      );
  } finally {
    await writeFile(envFile, savedEnvironment, { mode: 0o600 });
  }
  console.log(
    `${providerKeys.length} provider credential variables reach only the server container.`,
  );
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
    import { createHash } from 'node:crypto';
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
      const result=await session.exec('printf synthetic-persistence > probe.txt && test ! -S /var/run/docker.sock && test -z "$NOD_AUTH_TOKEN" && test -z "$NOD_VAULT_KEY" && test ! -e /app/.env && printf synthetic-output',{onData:chunk=>chunks.push(chunk)});
      assert.equal(result.exitCode,0);
      assert.equal(Buffer.concat(chunks).toString(),'synthetic-output');
      assert.equal(await readFile(path+'/probe.txt','utf8'),'synthetic-persistence');
      await pool.query('CREATE TABLE nod_hosting_probe (value text NOT NULL)');
      await pool.query('INSERT INTO nod_hosting_probe VALUES ($1)',['synthetic-persistence']);
      await writeFile(root+'/hosting-probe','synthetic-persistence');
      await assert.rejects(browser.act(id,{action:'snapshot'}),error=>error.code==='browser_not_open');
      const opened=await browser.act(id,{action:'open',url:'https://example.com/'});
      assert.equal(new URL(opened.url).hostname,'example.com');
      assert.ok(opened.text.includes('This domain is for use in documentation examples'),opened.text);
      const marker='nod-browser-'+id;
      await browser.act(id,{action:'evaluate',script:'(() => { const heading=document.createElement("h1"); heading.textContent='+JSON.stringify(marker)+'; const button=document.createElement("button"); button.textContent="Complete synthetic check"; button.onclick=()=>{heading.textContent+=" complete";}; document.body.replaceChildren(heading,button); })()'});
      assert.ok((await browser.act(id,{action:'snapshot'})).text.includes(marker));
      await browser.act(id,{action:'click',selector:'button'});
      assert.ok((await browser.act(id,{action:'snapshot'})).text.includes(marker+' complete'));
      const screenshot=await browser.screenshot(id);
      assert.ok(screenshot && screenshot.length>1000);
      assert.equal(screenshot.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      assert.equal(screenshot.subarray(12,16).toString(),'IHDR');
      assert.ok(screenshot.readUInt32BE(16)>0 && screenshot.readUInt32BE(20)>0);
      console.log('Chromium opened a public page, rendered and clicked a synthetic control, and captured a PNG ('+screenshot.length+' bytes, sha256 '+createHash('sha256').update(screenshot).digest('hex')+').');
      const denied=await fetch('http://runtime:2375/containers/json');
      assert.equal(denied.status,403);
      const control=await session.exec(${JSON.stringify(networkScript)});
      assert.equal(control.exitCode,0);
    } finally {await workspace.dispose();await browser.dispose();await pool.end();}
  `;
  console.log(
    (
      await command(
        ['exec', '-i', `${project}-server-1`, 'node', '--import', 'tsx', '--input-type=module'],
        probe,
      )
    ).trim(),
  );
  console.log(
    'Workspace execution, Chromium rendering, secret isolation, and private runtime network passed.',
  );
  const firstPostgres = (await compose('ps', '--quiet', 'postgres')).trim();
  const firstDirectory = directory;
  const firstEnvFile = envFile;
  const firstEnvOverride = environment.NOD_ENV_FILE;
  const secondDirectory = join(scratch, 'another installation with spaces');
  await mkdir(secondDirectory);
  for (const file of ['setup.sh', '.env.example', 'compose.yaml'])
    await cp(join(directory, file), join(secondDirectory, file));
  try {
    directory = secondDirectory;
    envFile = join(directory, '.env');
    delete environment.NOD_ENV_FILE;
    environment.COMPOSE_PROJECT_NAME = project;
    await assert.rejects(shell('setup.sh'), /Compose project already has resources/);
    await assert.rejects(readFile(envFile), { code: 'ENOENT' });
    delete environment.COMPOSE_PROJECT_NAME;
    await shell('setup.sh');
    const secondProject = (await readFile(envFile, 'utf8')).match(
      /^COMPOSE_PROJECT_NAME=(.+)$/m,
    )?.[1];
    assert.ok(secondProject);
    assert.notEqual(secondProject, project);
    installations.push({ directory, envFile, project: secondProject });
    await compose('up', '-d', '--wait', '--wait-timeout', '120', 'postgres');
    assert.equal(
      (
        await compose(
          'exec',
          '-T',
          'postgres',
          'psql',
          '-U',
          'nod',
          '-d',
          'nod',
          '-Atc',
          "SELECT to_regclass('public.nod_hosting_probe');",
        )
      ).trim(),
      '',
    );
    await compose('down', '--volumes', '--remove-orphans');
  } finally {
    directory = firstDirectory;
    envFile = firstEnvFile;
    delete environment.COMPOSE_PROJECT_NAME;
    if (firstEnvOverride) environment.NOD_ENV_FILE = firstEnvOverride;
  }
  assert.equal((await compose('ps', '--quiet', 'postgres')).trim(), firstPostgres);
  assert.equal(
    (
      await compose(
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'nod',
        '-d',
        'nod',
        '-Atc',
        'SELECT value FROM nod_hosting_probe;',
      )
    ).trim(),
    'synthetic-persistence',
  );
  console.log('Fresh installations use independent data; occupied project names are refused.');
  const replacement = randomBytes(32).toString('base64url');
  await writeEnvironment(replacement);
  if (bundle) {
    const saved = await readFile(envFile, 'utf8');
    await shell('install.sh');
    assert.equal(await readFile(envFile, 'utf8'), saved);
  } else
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
  if (bundle) {
    const backup = join(scratch, 'backup');
    const running = (await compose('ps', '--status', 'running', '--services'))
      .trim()
      .split('\n')
      .sort();
    await shell('backup.sh', backup);
    assert.equal(
      await readFile(join(backup, 'source-commit'), 'utf8'),
      await readFile(join(directory, 'source-revision'), 'utf8'),
    );
    assert.deepEqual(
      (await compose('ps', '--status', 'running', '--services')).trim().split('\n').sort(),
      running,
    );
    await compose('down');
    directory = join(scratch, 'restored');
    envFile = join(directory, '.env');
    const restoredProject = `${project}-restored`;
    installations.push({ directory, envFile, project: restoredProject });
    await cp(bundle, directory, { recursive: true, mode: constants.COPYFILE_FICLONE });
    environment.COMPOSE_PROJECT_NAME = restoredProject;
    await shell('restore.sh', backup, restoredProject);
    await shell('install.sh');
    assert.equal((await request(replacement)).status, 200);
    await command(
      [
        'exec',
        '-i',
        `${restoredProject}-server-1`,
        'node',
        '--import',
        'tsx',
        '--input-type=module',
      ],
      `import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {pool} from './src/server/db.ts';
      assert.equal(await readFile(process.env.NOD_DATA_ROOT+'/hosting-probe','utf8'),'synthetic-persistence');
      assert.equal(await readFile(process.env.NOD_DATA_ROOT+'/workspaces/${id}/probe.txt','utf8'),'synthetic-persistence');
      assert.equal((await pool.query('SELECT value FROM nod_hosting_probe')).rows[0].value,'synthetic-persistence');
      await pool.end();`,
    );
    console.log(
      'Standalone bundle backup and fresh-project restore preserve authentication, workspace, server state, and PostgreSQL.',
    );
  }
} finally {
  for (const installation of installations) {
    await command([
      'compose',
      '--project-directory',
      installation.directory,
      '--file',
      join(installation.directory, 'compose.yaml'),
      '--env-file',
      installation.envFile,
      '--project-name',
      installation.project,
      'down',
      '--volumes',
      '--remove-orphans',
    ]).catch(() => {});
  }
  await rm(scratch, { recursive: true, force: true });
}
