import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import type { WorkspaceSession } from '../src/ports/computer.ts';
import { threadIdentity } from '../src/ports/thread-identity.ts';
import { isPublicAddress, publicUrl } from '../src/providers/agent-browser/network.ts';
import {
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
import { workspaceNetwork } from '../scripts/e2e-workspace.ts';
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
  for (const path of ['/etc/passwd', '../task-b/private.txt', '..\\secret', 'file\0name'])
    assert.throws(() => workspaceFile('task-a', path));
  assert.throws(() => threadIdentity('../escape'));
});

test('workspace artifact reads reject paths outside the container task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'otto-runtime-'));
  try {
    const workspace = join(directory, 'task-a');
    await mkdir(workspace);
    await writeFile(join(directory, 'private.txt'), 'fixture');
    await symlink(join(directory, 'private.txt'), join(workspace, 'escape.txt'));
    let launched = 0;
    const runner = createDockerWorkspace({
      container: 'otto-workspace',
      workspaceRoot: directory,
      spawn: () => {
        launched++;
        throw new Error('Unexpected workspace launch.');
      },
    });
    runner.open({
      threadId: 'task-a',
      workspacePath: workspace,
      signal: new AbortController().signal,
    });
    await assert.rejects(
      runner.readArtifact!('task-a', '../private.txt', 1024),
      /^Error: Files must stay within the task workspace\.$/,
    );
    assert.equal(launched, 0);
    assert.throws(() =>
      runner.open({
        threadId: 'task-b',
        workspacePath: workspace,
        signal: new AbortController().signal,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    await assert.rejects(
      runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
        maxBytes: 100,
      }),
      /limit/,
    );
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

const connection = { NetworkID: 'a'.repeat(64) };

test('the acceptance workspace rejects privileged, absent, malformed and ambiguous network attachments', () => {
  for (const inspected of [
    '',
    'container:guard',
    'null',
    '[]',
    '{}',
    JSON.stringify({ host: connection }),
    JSON.stringify({ none: connection }),
    JSON.stringify({ 'container:guard': connection }),
    JSON.stringify({ '--network=host': connection }),
    JSON.stringify({ 'normal\n--privileged': connection }),
    JSON.stringify({ bridge: connection, another: connection }),
    JSON.stringify({ bridge: {} }),
    JSON.stringify({ bridge: { NetworkID: '' } }),
    JSON.stringify({ bridge: { NetworkID: 42 } }),
    JSON.stringify({ bridge: null }),
  ])
    assert.throws(
      () => workspaceNetwork(inspected),
      /^Error: Start the Otto workspace on a normal Docker network first\.$/,
    );
});

// Supervised workspace commands: cancellation, bounds, uncertain fencing and file containment.

async function execute(session: WorkspaceSession, command: string) {
  const chunks: Buffer[] = [];
  const { exitCode } = await session.exec(command, { onData: (chunk) => chunks.push(chunk) });
  const output = Buffer.concat(chunks).toString('utf8');
  if (exitCode) throw new Error(`Workspace command exited with ${exitCode}: ${output}`);
  return output;
}

async function local() {
  const directory = await mkdtemp('/tmp/otto-command-');
  const launch: WorkspaceCommandLauncher = (_command, args, options) =>
    spawn('python3', ['-u', '-c', args.at(-1)!], { ...options, cwd: directory, stdio: 'pipe' });
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

test('output overflow and timeout drain the remote command before rejecting', async () => {
  for (const limited of [true, false]) {
    const f = await local();
    try {
      const operation = f.run(
        [
          'python3',
          '-c',
          `${limited ? 'import sys;sys.stdout.write("x"*20000);sys.stdout.flush();' : ''}import time;time.sleep(1);open("late","w").close()`,
        ],
        { maxBytes: 1024, timeoutMs: limited ? 3000 : 100 },
      );
      await assert.rejects(
        operation,
        (error: unknown) =>
          error instanceof WorkspaceCommandError && !error.uncertain && /limit/.test(error.message),
      );
      await delay(1100);
      assert.equal(await exists(join(f.directory, 'late')), false);
    } finally {
      await f.close();
    }
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
    const read = (path: string, maxBytes = 100) =>
      f.run(['python3', '-c', artifactReadProgram], {
        input: JSON.stringify({ base, path, maxBytes }),
        maxBytes,
      });
    assert.deepEqual((await read('nested/ok')).stdout, Buffer.from([0, 255, 4]));
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
    status: 'fixture',
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
    const bytes = Buffer.alloc(1024 * 1024 + 13);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    await workspace.writeArtifact!('fixture', 'nested/file.bin', bytes);
    assert.deepEqual(
      Buffer.from(await workspace.readArtifact!('fixture', 'nested/file.bin', bytes.length)),
      bytes,
    );
    await symlink(outside, join(f.directory, 'escape'));
    await assert.rejects(
      workspace.writeArtifact!('fixture', 'escape/private.bin', bytes),
      /workspace file operation failed/,
    );
    assert.equal(await exists(join(outside, 'private.bin')), false);
    const before = launches;
    await assert.rejects(
      workspace.writeArtifact!('fixture', '../foreign/file', bytes),
      /stay within/,
    );
    assert.equal(launches, before);
    await assert.rejects(
      workspace.writeArtifact!('fixture', 'too-large', Buffer.alloc(15 * 1024 * 1024 + 1)),
      /15 MB/,
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
    await writeFile(join(f.source, 'secret-file'), 'synthetic secret payload');
    const captured = await f.create();
    assert.equal(captured.code, 0, captured.stderr);
    const damagedHeader = Buffer.from(captured.stdout);
    damagedHeader[0] ^= 1;
    const damagedContent = Buffer.from(captured.stdout);
    damagedContent[damagedContent.indexOf('synthetic secret payload')] ^= 1;
    for (const input of [
      damagedHeader,
      damagedContent,
      captured.stdout.subarray(0, captured.stdout.indexOf('synthetic secret payload') + 3),
      captured.stdout.subarray(0, captured.stdout.length - 1),
      captured.stdout.subarray(0, captured.stdout.length - 512),
      Buffer.concat([captured.stdout, Buffer.from('private trailing text')]),
      Buffer.concat([captured.stdout, Buffer.alloc(1)]),
      Buffer.alloc(1024),
    ]) {
      rejected(await f.restore(input));
      await assert.rejects(lstat(f.target), { code: 'ENOENT' });
      await f.noStaging();
    }
    assert.equal((await f.restore(Buffer.concat([captured.stdout, Buffer.alloc(512)]))).code, 0);
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

test('create rejects escaping or cyclic links, FIFOs and sockets without leaking private paths', async () => {
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
    rejected(await f.create());
    await rm(join(f.source, privateName));
    const server = createServer();
    const socket = join(f.source, 'socket');
    server.listen(socket);
    await once(server, 'listening');
    try {
      rejected(await f.create());
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
