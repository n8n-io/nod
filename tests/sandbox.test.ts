import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
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
    await assert.rejects(execute(session, 'later'), /Restart nod/);
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
