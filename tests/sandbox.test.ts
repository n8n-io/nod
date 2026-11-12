import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import type { WorkspaceSession } from '../src/ports/computer.ts';
import { threadIdentity } from '../src/ports/thread-identity.ts';
import { isPublicAddress, publicUrl } from '../src/providers/agent-browser/network.ts';
import {
  connectedUser,
  runSupervisedCommand,
  runWorkspaceCommand,
  workspaceCommandProgram,
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
import { createLocalFiles, localFileRules } from '../src/server/local-files.ts';
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

test('workspace transport startup grace preserves the command deadline', async () => {
  const run = (command: string) =>
    runSupervisedCommand({
      args: ['sh', '-c', command],
      timeoutMs: 250,
      transportGraceMs: 2000,
      launch: () =>
        spawn('python3', [
          '-I',
          '-u',
          '-c',
          'import time; time.sleep(1.6)\n' + workspaceCommandProgram,
        ]),
    });
  const result = await run('printf ready; printf problem >&2; exit 37');
  assert.equal(result.stdout.toString(), 'ready');
  assert.equal(result.stderr.toString(), 'problem');
  assert.equal(result.exitCode, 37);
  await assert.rejects(run('sleep 1; printf too-late'), (error: unknown) => {
    assert.ok(error instanceof WorkspaceCommandError);
    assert.equal(error.uncertain, false);
    assert.match(error.message, /time or output limit/);
    return true;
  });
});

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
    const run = (args: string[], selected?: typeof cli) =>
      runWorkspaceCommand({
        container: 'nod-workspace-fixture',
        threadId: 'fixture',
        args,
        environment: { FIXTURE_TOKEN: 'synthetic-connected-token' },
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

test('an uncertain workspace operation cancels and drains commands already in flight', async () => {
  const processes: Array<ReturnType<WorkspaceCommandLauncher>> = [];
  let signalCancellation: () => void = () => {};
  const cancelled = new Promise<void>((resolve) => {
    signalCancellation = resolve;
  });
  const launch: WorkspaceCommandLauncher = () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill() {
        return true;
      },
    });
    child.stdin.on('data', (data) => {
      if (data.toString() === '{"type":"cancel"}\n') signalCancellation();
    });
    processes.push(child as unknown as ReturnType<WorkspaceCommandLauncher>);
    return processes.at(-1)!;
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
  let failureSettled = false;
  const failed = assert.rejects(execute(session, 'first'), /did not stop safely/).finally(() => {
    failureSettled = true;
  });
  const drained = assert.rejects(execute(session, 'second'), /Task cancelled/);
  let acknowledged = false;
  const acknowledge = () => {
    if (acknowledged) return;
    acknowledged = true;
    processes[1].stdout.emit('data', '{"type":"exit","code":-15,"reason":"cancelled"}\n');
    processes[1].emit('close', 0);
  };
  try {
    processes[0].emit('close', 1);
    await Promise.race([
      cancelled,
      delay(500).then(() => {
        throw new Error('Existing command was not cancelled.');
      }),
    ]);
    await assert.rejects(execute(session, 'later'), /Restart Nod/);
    assert.equal(processes.length, 2);
    assert.equal(failureSettled, false);
    acknowledge();
    await Promise.all([failed, drained]);
  } finally {
    acknowledge();
    await workspace.dispose();
    await Promise.allSettled([failed, drained]);
  }
});

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
  const pool = {
    query: async (sql: string, values: string[]) => {
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
    assert.deepEqual(
      await files.prepare('LOCAL_FILES_READ', { path: `${shared}/sorted/../a.txt` }),
      { path: join(shared, 'a.txt') },
    );
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
    const imported = (await files.execute('LOCAL_FILES_IMPORT', { path: latin })) as {
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
    await files.keepOut(turn, `${sorted}/`, pool);
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
      ((await files.execute('LOCAL_FILES_READ', { path: note })) as { text: string }).text,
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
