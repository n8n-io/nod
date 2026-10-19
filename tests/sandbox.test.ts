import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { WorkspaceSession } from '../src/ports/computer.ts';
import { threadIdentity } from '../src/ports/thread-identity.ts';
import { isPublicAddress, publicUrl } from '../src/providers/agent-browser/network.ts';
import {
  cliInstallProgram,
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
  const parent = await mkdtemp(join(tmpdir(), 'otto-local-directories-'));
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
    '100.100.100.200',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fd00::1',
    '2001:db8::1',
    '2002:7f00:1::',
    '3fff::1',
    '3fff:fff::1',
  ])
    assert.equal(isPublicAddress(address), false, address);
  for (const address of [
    '93.184.216.34',
    '1.1.1.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
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
  const directory = await mkdtemp('/tmp/otto-command-');
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
        container: 'otto-workspace-fixture',
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
async function ready(path: string) {
  for (let i = 0; i < 200; i++) {
    if (await exists(path)) return;
    await delay(10);
  }
  throw new Error('The synthetic process did not start.');
}

test('cancel waits for the remote process group, including a child ignoring TERM', async () => {
  const f = await local();
  const controller = new AbortController();
  try {
    const command =
      'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); open("ready","w").close(); time.sleep(3); open("late","w").write("unexpected")';
    const operation = f.run(['sh', '-c', `python3 -c '${command}' & wait`], {
      signal: controller.signal,
    });
    const rejected = assert.rejects(
      operation,
      (error: unknown) =>
        error instanceof WorkspaceCommandError &&
        !error.uncertain &&
        error.message === 'Task cancelled.',
    );
    await ready(join(f.directory, 'ready'));
    const started = Date.now();
    controller.abort();
    await rejected;
    assert.ok(Date.now() - started >= 1800);
    await delay(1500);
    assert.equal(await exists(join(f.directory, 'late')), false);
    assert.equal((await f.run(['printf', 'ready again'])).stdout.toString(), 'ready again');
  } finally {
    controller.abort();
    await f.close();
  }
});

test('process-group probes wait through transient permission errors and fence persistent uncertainty', async (t) => {
  for (const persistent of [false, true])
    await t.test(persistent ? 'persistent denial' : 'transient denial', async () => {
      const f = await local(`import os,errno
probe_calls=0
original_killpg=os.killpg
original_isdir=os.path.isdir
def probe(group,value):
 global probe_calls
 if value==0:
  probe_calls+=1
  with open('probes','a') as file: file.write('x')
  if ${persistent ? 'True' : 'probe_calls==1'}: raise PermissionError(errno.EPERM,'Synthetic process-group denial')
 return original_killpg(group,value)
os.killpg=probe
os.path.isdir=lambda path: False if path=='/proc' else original_isdir(path)
`);
      const controller = new AbortController();
      try {
        const operation = f.run(
          [
            'python3',
            '-c',
            'import time;open("ready","w").close();time.sleep(0.5);open("late","w").close()',
          ],
          { signal: controller.signal, drainTimeoutMs: 1000 },
        );
        const rejected = assert.rejects(
          operation,
          (error: unknown) =>
            error instanceof WorkspaceCommandError && error.uncertain === persistent,
        );
        await ready(join(f.directory, 'ready'));
        controller.abort();
        await rejected;
        assert.ok((await readFile(join(f.directory, 'probes'), 'utf8')).length >= 2);
        await delay(600);
        assert.equal(await exists(join(f.directory, 'late')), false);
      } finally {
        controller.abort();
        await f.close();
      }
    });
});

test(
  'cancel reaches a command that moved itself into a new process group',
  { skip: !existsSync('/proc') },
  async () => {
    const f = await local();
    const controller = new AbortController();
    try {
      const command =
        'import os,time; os.setpgid(0,0); open("ready","w").close(); time.sleep(2); open("late","w").write("unexpected")';
      const operation = f.run(['sh', '-c', `python3 -c '${command}' & wait`], {
        signal: controller.signal,
      });
      const rejected = assert.rejects(operation, /Task cancelled/);
      await ready(join(f.directory, 'ready'));
      controller.abort();
      await rejected;
      await delay(2200);
      assert.equal(await exists(join(f.directory, 'late')), false);
    } finally {
      controller.abort();
      await f.close();
    }
  },
);

test('connected CLIs run only their sealed install with a clean environment', async () => {
  const root = await mkdtemp('/tmp/otto-connected-');
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
    const prefix = join(home, `otto-cli-${cli.id}`);
    await mkdir(join(prefix, 'bin'), { recursive: true });
    await writeFile(join(prefix, 'bin', 'fixturecli'), '#!/bin/sh\nenv\necho "argv $*"\n', {
      mode: 0o755,
    });
    await writeFile(join(prefix, '.installed'), '');
    const launches: string[][] = [];
    const run = (args: string[], selected?: typeof cli) =>
      runWorkspaceCommand({
        container: 'otto-workspace-fixture',
        threadId: 'fixture',
        args,
        environment: { FIXTURE_TOKEN: 'synthetic-connected-token' },
        cli: selected,
        spawn: (_command, dockerArgs, options) => {
          launches.push(dockerArgs);
          const argv = dockerArgs.slice(dockerArgs.indexOf('otto-workspace-fixture') + 1);
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
    const other = join(home, `otto-cli-${randomUUID()}`);
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

test('a missing sealed install comes from its declared source and a failed install runs nothing', async () => {
  const home = await mkdtemp('/tmp/otto-connected-');
  try {
    const launch: WorkspaceCommandLauncher = (_command, args, options) =>
      spawn('python3', args.slice(args.indexOf('-I')), { ...options, cwd: home, stdio: 'pipe' });
    const cli = {
      id: randomUUID(),
      command: 'fixturecli',
      source: { url: 'https://127.0.0.1:9/fixturecli' },
    };
    const result = await runWorkspaceCommand({
      container: 'otto-workspace-fixture',
      threadId: 'fixture',
      args: ['status'],
      environment: { FIXTURE_TOKEN: 'synthetic-connected-token' },
      cli,
      spawn: launch,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /Could not install fixturecli/);
    assert.equal(existsSync(join(home, `otto-cli-${cli.id}`, '.installed')), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('sealed downloads install only the declared bytes and find the program in archives', async () => {
  const root = await mkdtemp('/tmp/otto-cli-install-');
  try {
    const release = join(root, 'release');
    await mkdir(join(release, 'tool-1.0', 'bin'), { recursive: true });
    await writeFile(
      join(release, 'tool-1.0', 'bin', 'fixturecli'),
      '#!/bin/sh\necho sealed "$@"\n',
      {
        mode: 0o755,
      },
    );
    await writeFile(join(release, 'tool-1.0', 'README'), 'synthetic');
    const archive = join(root, 'release.tar.gz');
    spawnSync('tar', ['-czf', archive, '-C', release, 'tool-1.0'], {
      env: { PATH: '/usr/bin:/bin', COPYFILE_DISABLE: '1' },
    });
    const tools = join(root, 'tools');
    await mkdir(tools);
    await writeFile(
      join(tools, 'curl'),
      `#!/bin/sh\nwhile [ "$1" != --output ]; do shift; done\ncp ${archive} "$2"\n`,
      { mode: 0o755 },
    );
    const sha256 = createHash('sha256')
      .update(await readFile(archive))
      .digest('hex');
    const install = (name: string, digest: string) =>
      spawnSync(
        'python3',
        [
          '-I',
          '-c',
          cliInstallProgram,
          join(root, name),
          JSON.stringify({
            id: randomUUID(),
            command: 'fixturecli',
            source: { url: 'https://example.test/release.tar.gz', sha256: digest },
          }),
        ],
        { env: { PATH: `${tools}:/usr/bin:/bin` }, encoding: 'utf8' },
      );
    const refused = install('refused', 'f'.repeat(64));
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /sha256/);
    assert.equal(existsSync(join(root, 'refused', 'bin', 'fixturecli')), false);
    assert.equal(existsSync(join(root, 'refused', '.installed')), false);
    const installed = install('installed', sha256);
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(
      spawnSync(join(root, 'installed', 'bin', 'fixturecli'), ['ok'], { encoding: 'utf8' }).stdout,
      'sealed ok\n',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact descriptor reads reject symlinks, special files and oversized data', async () => {
  const f = await local();
  try {
    const base = join(f.directory, 'task');
    await mkdir(join(base, 'nested'), { recursive: true });
    await writeFile(join(base, 'nested', 'ok'), Buffer.from([0, 255, 4]));
    await writeFile(join(f.directory, 'private'), 'synthetic outside value');
    await symlink(join(f.directory, 'private'), join(base, 'linked'));
    await symlink(f.directory, join(base, 'linked-directory'));
    const read = (path: string, maxBytes = 100, offset = 0, identity?: string) =>
      f.run(['python3', '-c', artifactReadProgram], {
        input: JSON.stringify({ base, path, maxBytes, offset, identity }),
        maxBytes: maxBytes + 1024,
      });
    const ok = (await read('nested/ok')).stdout;
    const identity = ok.subarray(0, ok.indexOf(10)).toString();
    assert.deepEqual(ok.subarray(ok.indexOf(10) + 1), Buffer.from([0, 255, 4]));
    const tail = (await read('nested/ok', 100, 1, identity)).stdout;
    assert.deepEqual(tail.subarray(tail.indexOf(10) + 1), Buffer.from([255, 4]));
    await writeFile(join(base, 'nested', 'ok'), Buffer.from([1, 2, 3, 4]));
    assert.notEqual((await read('nested/ok', 100, 3, identity)).exitCode, 0);
    for (const path of [
      'linked',
      'linked-directory/private',
      '../private',
      'nested/../nested/ok',
      '.',
    ])
      assert.notEqual((await read(path)).exitCode, 0, path);
    assert.notEqual((await read('nested/ok', 2)).exitCode, 0);
    await f.run(['mkfifo', join(base, 'pipe')]);
    assert.notEqual((await read('pipe')).exitCode, 0);
  } finally {
    await f.close();
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
    container: 'otto-workspace-fixture',
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
    await assert.rejects(execute(session, 'later'), /Restart Otto/);
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
  const outside = await mkdtemp('/tmp/otto-upload-outside-');
  let launches = 0;
  const workspace = createCommandWorkspace({
    workspaceRoot: f.directory,
    instructions: 'fixture',
    runCommand: async (_id, args, input) => {
      launches++;
      const request = JSON.parse(input.input!);
      assert.ok([artifactWriteProgram, artifactReadProgram].includes(args[2]));
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

// Computer checkpoints: integrity, traversal and symlink containment.

const helper = fileURLToPath(
  new URL('../src/providers/cloudflare-computer/checkpoint.py', import.meta.url),
);
const failure = 'Computer checkpoint failed.\n';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');

function run(args: string[], input?: Buffer) {
  return new Promise<{ code: number | null; stdout: Buffer; stderr: string }>((resolve, reject) => {
    const child = spawn('python3', ['-B', helper, ...args], {
      env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
      stdio: 'pipe',
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (value: Buffer) => stdout.push(value));
    child.stderr.on('data', (value: Buffer) => stderr.push(value));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString() }),
    );
    child.stdin.end(input);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'otto-checkpoint-'));
  const source = join(directory, 'source');
  const target = join(directory, 'restored');
  await mkdir(source, { mode: 0o700 });
  return {
    directory,
    source,
    target,
    create: (...args: string[]) => run(['create', source, ...args]),
    restore: (input: Buffer, ...args: string[]) => run(['restore', target, ...args], input),
    async noStaging() {
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name.startsWith('.otto-checkpoint-')),
        [],
      );
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

type Entry = { name: string; type?: string; data?: Buffer; link?: string; mode?: number };

function header(entry: Entry, size = entry.data?.length ?? 0) {
  const value = Buffer.alloc(512);
  value.write(entry.name, 0, 100);
  value.write((entry.mode ?? 0o700).toString(8).padStart(7, '0') + '\0', 100, 8);
  value.write('0000000\0', 108, 8);
  value.write('0000000\0', 116, 8);
  value.write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  value.write('00000000000\0', 136, 12);
  value.fill(32, 148, 156);
  value.write(entry.type ?? '0', 156, 1);
  if (entry.link) value.write(entry.link, 157, 100);
  value.write('ustar\0' + '00', 257, 8);
  const checksum = [...value].reduce((sum, byte) => sum + byte, 0);
  value.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return value;
}

function pax(key: string, value: string) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (Buffer.byteLength(String(length) + body) !== length)
    length = Buffer.byteLength(String(length) + body);
  return Buffer.from(String(length) + body);
}

function archive(entries: Entry[]) {
  const buffers: Buffer[] = [header({ name: '.', type: '5' })];
  for (const entry of entries) {
    if ((entry.type ?? '0') === '0') {
      const digest = pax('otto.sha256', hash(entry.data ?? Buffer.alloc(0)));
      buffers.push(
        header({ name: 'PaxHeader', type: 'x' }, digest.length),
        digest,
        Buffer.alloc((512 - (digest.length % 512)) % 512),
      );
    }
    buffers.push(header(entry));
    if (entry.data) {
      buffers.push(entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512));
    }
  }
  return Buffer.concat([...buffers, Buffer.alloc(1024)]);
}

function rejected(result: Awaited<ReturnType<typeof run>>) {
  assert.equal(result.code, 1);
  assert.equal(result.stderr, failure);
}

test('checkpoint roundtrip preserves private files, executable modes, npm-style symlinks and absolute venv-style links', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.source, 'package'), { mode: 0o700 });
    await mkdir(join(f.source, '.bin'), { mode: 0o700 });
    await writeFile(join(f.source, 'package', 'run'), Buffer.from([0, 255, 128, 10]), {
      mode: 0o700,
    });
    await chmod(join(f.source, 'package', 'run'), 0o4700);
    await writeFile(join(f.source, 'private'), 'synthetic private value', { mode: 0o600 });
    await symlink('../package/run', join(f.source, '.bin', 'run'));
    await symlink('package', join(f.source, 'package-alias'));
    await symlink('/usr/bin/python3', join(f.source, 'python3'));
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    assert.equal(captured.stderr, '');
    await mkdir(f.target, { mode: 0o700 });
    const restored = await f.restore(captured.stdout, '--sha256', hash(captured.stdout));
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(restored.stdout.length, 0);
    assert.equal(await readFile(join(f.target, 'private'), 'utf8'), 'synthetic private value');
    assert.deepEqual(await readFile(join(f.target, '.bin', 'run')), Buffer.from([0, 255, 128, 10]));
    assert.equal(await readlink(join(f.target, '.bin', 'run')), '../package/run');
    assert.equal(await readlink(join(f.target, 'package-alias')), 'package');
    assert.equal(await readlink(join(f.target, 'python3')), '/usr/bin/python3');
    assert.equal((await lstat(f.target)).mode & 0o7777, 0o700);
    assert.equal((await lstat(join(f.target, 'private'))).mode & 0o7777, 0o600);
    assert.equal((await lstat(join(f.target, 'package', 'run'))).mode & 0o7777, 0o700);
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('restore rejects header corruption, content corruption, truncation and unconsumed trailing data', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.source, 'secret-file'), 'synthetic secret payload '.repeat(4096));
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    assert.deepEqual([...captured.stdout.subarray(0, 2)], [0x1f, 0x8b]);
    const legacy = gunzipSync(captured.stdout);
    assert.ok(captured.stdout.length * 10 < legacy.length);
    const damaged = (input: Buffer, offset: number) => {
      const value = Buffer.from(input);
      value[offset] ^= 1;
      return value;
    };
    for (const input of [
      damaged(captured.stdout, 0),
      damaged(captured.stdout, captured.stdout.length >> 1),
      damaged(captured.stdout, captured.stdout.length - 5),
      captured.stdout.subarray(0, captured.stdout.length >> 1),
      captured.stdout.subarray(0, captured.stdout.length - 1),
      Buffer.concat([captured.stdout, Buffer.from('private trailing text')]),
      Buffer.concat([captured.stdout, Buffer.alloc(512)]),
      Buffer.concat([captured.stdout, captured.stdout]),
      damaged(legacy, 0),
      damaged(legacy, legacy.indexOf('synthetic secret payload')),
      legacy.subarray(0, legacy.indexOf('synthetic secret payload') + 3),
      legacy.subarray(0, legacy.length - 1),
      legacy.subarray(0, legacy.length - 512),
      Buffer.concat([legacy, Buffer.from('private trailing text')]),
      Buffer.concat([legacy, Buffer.alloc(1)]),
      Buffer.alloc(1024),
    ]) {
      rejected(await f.restore(input));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
    for (const input of [captured.stdout, legacy, Buffer.concat([legacy, Buffer.alloc(512)])]) {
      const restored = await f.restore(input, '--sha256', hash(input));
      assert.equal(restored.code, 0, restored.stderr);
      assert.equal(
        await readFile(join(f.target, 'secret-file'), 'utf8'),
        'synthetic secret payload '.repeat(4096),
      );
      await rm(f.target, { recursive: true });
    }
    rejected(await f.restore(captured.stdout, '--sha256', hash(legacy)));
  } finally {
    await f.close();
  }
});

test('restore rejects traversal, symlink pivots, duplicates, conflicting parents and special members', async () => {
  const f = await fixture();
  try {
    const sentinel = join(f.directory, 'sentinel');
    await writeFile(sentinel, 'untouched synthetic sentinel', { mode: 0o600 });
    const cases: Entry[][] = [
      [{ name: '../sentinel', data: Buffer.from('overwrite') }],
      [{ name: sentinel, data: Buffer.from('overwrite') }],
      [{ name: 'sub/../sentinel', data: Buffer.from('overwrite') }],
      [
        { name: 'pivot', type: '2', link: '..' },
        { name: 'pivot/sentinel', data: Buffer.from('overwrite') },
      ],
      [{ name: 'pivot', type: '2', link: '../sentinel' }],
      [
        { name: 'pivot', type: '2', link: '/tmp' },
        { name: 'pivot/sentinel', data: Buffer.from('overwrite') },
      ],
      [
        { name: 'a', type: '2', link: 'b' },
        { name: 'b', type: '2', link: 'a' },
      ],
      [{ name: 'loop', type: '2', link: '.' }],
      [
        { name: 'same', data: Buffer.alloc(0) },
        { name: 'same', data: Buffer.alloc(0) },
      ],
      [
        { name: 'file', data: Buffer.alloc(0) },
        { name: 'file/child', data: Buffer.alloc(0) },
      ],
      [{ name: 'missing/child', data: Buffer.alloc(0) }],
      [{ name: 'hard', type: '1', link: 'sentinel' }],
      ...['3', '4', '6', '7', 'S', 'g', 'L'].map((type) => [{ name: 'special', type }]),
    ];
    for (const entries of cases) {
      rejected(await f.restore(archive(entries)));
      assert.equal(await readFile(sentinel, 'utf8'), 'untouched synthetic sentinel');
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
  } finally {
    await f.close();
  }
});

test('restore preserves nonempty targets and refuses target or parent symlinks', async () => {
  const f = await fixture();
  try {
    const input = archive([{ name: 'replacement', data: Buffer.from('new') }]);
    await mkdir(f.target);
    await writeFile(join(f.target, 'original'), 'untouched');
    rejected(await f.restore(input));
    assert.equal(await readFile(join(f.target, 'original'), 'utf8'), 'untouched');
    await rm(f.target, { recursive: true });
    await symlink(f.source, f.target);
    rejected(await f.restore(input));
    assert.deepEqual(await readdir(f.source), []);
    rejected(await run(['restore', join(f.target, 'child')], input));
    rejected(await run(['create', f.target]));
    await f.noStaging();
  } finally {
    await f.close();
  }
});

test('create rejects escaping or cyclic links without leaking private paths and skips FIFOs and sockets', async () => {
  const f = await fixture();
  try {
    const privateName = 'synthetic-private-token';
    await symlink('../outside', join(f.source, privateName));
    rejected(await f.create());
    await rm(join(f.source, privateName));
    await symlink('b', join(f.source, 'a'));
    await symlink('a', join(f.source, 'b'));
    rejected(await f.create());
    await rm(join(f.source, 'a'));
    await rm(join(f.source, 'b'));
    await symlink('/usr', join(f.source, 'a'));
    await symlink('a/bin', join(f.source, 'b'));
    rejected(await f.create());
    await rm(join(f.source, 'a'));
    await rm(join(f.source, 'b'));
    const fifo = spawn('python3', [
      '-c',
      'import os,sys;os.mkfifo(sys.argv[1])',
      join(f.source, privateName),
    ]);
    const [code] = await once(fifo, 'close');
    assert.equal(code, 0);
    await writeFile(join(f.source, 'kept'), 'synthetic kept file');
    const server = createServer();
    const socket = join(f.source, 'socket');
    server.listen(socket);
    await once(server, 'listening');
    try {
      const captured = await f.create();
      assert.equal(captured.code, 0, captured.stderr);
      assert.equal(captured.stderr, '');
      assert.equal((await f.restore(captured.stdout)).code, 0);
      assert.deepEqual((await readdir(f.target)).sort(), ['kept']);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
    await f.noStaging();
  } finally {
    await f.close();
  }
});
