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
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
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
import { createMacComputer, sandboxProfile } from '../src/providers/macos/owner-computer.ts';
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

if (process.platform !== 'win32') {
  test('Mac helper startup failures settle every request and allow a clean restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-helper-'));
    const helper = join(root, 'helper');
    const started = join(root, 'started');
    const computer = createMacComputer({ dataRoot: root, helper });
    try {
      await writeFile(
        helper,
        `#!/bin/sh\nIFS= read -r request\nprintf started > '${started}'\nexit 7\n`,
        {
          mode: 0o600,
        },
      );
      assert.equal(computer.appControlAvailable, false);
      await assert.rejects(
        Promise.race([
          computer.permissions!(),
          delay(2000).then(() => {
            throw new Error('helper request never settled');
          }),
        ]),
        /unavailable|stopped/,
      );
      assert.equal(existsSync(started), false);
      await chmod(helper, 0o700);
      assert.equal(computer.appControlAvailable, true);
      await assert.rejects(
        Promise.race([
          computer.permissions!(),
          delay(2000).then(() => {
            throw new Error('restarted helper request never settled');
          }),
        ]),
        /stopped/,
      );
      assert.equal(await readFile(started, 'utf8'), 'started');
    } finally {
      computer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('cancelling a Mac helper request stops its pending outside action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-helper-'));
    const helper = join(root, 'helper.cjs');
    const started = join(root, 'started');
    const effect = join(root, 'effect');
    const computer = createMacComputer({ dataRoot: root, helper });
    try {
      await writeFile(
        helper,
        `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stdin.once('data', () => { fs.writeFileSync(${JSON.stringify(started)}, 'ready'); setTimeout(() => fs.writeFileSync(${JSON.stringify(effect)}, 'too late'), 200); });\n`,
        { mode: 0o700 },
      );
      const controller = new AbortController();
      const result = computer.apps!(controller.signal);
      await ready(started);
      controller.abort(new Error('Task cancelled.'));
      await assert.rejects(result, /cancelled/);
      await delay(300);
      assert.equal(existsSync(effect), false);
    } finally {
      computer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Mac helper deadlines stop hung work and reject empty screenshots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-helper-'));
    const helper = join(root, 'helper.cjs');
    const effect = join(root, 'effect');
    const computer = createMacComputer({ dataRoot: root, helper, helperTimeoutMs: 150 });
    try {
      await writeFile(
        helper,
        `#!${process.execPath}\nconst fs = require('node:fs');\nprocess.stdin.once('data', () => setTimeout(() => fs.writeFileSync(${JSON.stringify(effect)}, 'too late'), 250));\n`,
        { mode: 0o700 },
      );
      await assert.rejects(computer.permissions!(), /timed out/);
      await delay(350);
      assert.equal(existsSync(effect), false);
      await writeFile(
        helper,
        `#!${process.execPath}\nconst readline = require('node:readline');\nreadline.createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); process.stdout.write(JSON.stringify({ id: request.id, ok: true, result: { app: { name: 'Fixture', bundleId: 'fixture' }, png: '' } }) + '\\n'); });\n`,
      );
      await assert.rejects(computer.screenshot!('fixture', new AbortController().signal), /PNG/);
    } finally {
      computer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('Mac helper permission failures reach the caller without losing other helper errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-helper-'));
    const helper = join(root, 'helper.cjs');
    const computer = createMacComputer({ dataRoot: root, helper });
    try {
      await writeFile(
        helper,
        `#!${process.execPath}\nconst readline = require('node:readline');\nreadline.createInterface({ input: process.stdin }).on('line', line => { const request = JSON.parse(line); const result = request.op === 'status' ? { ok: true, result: { accessibility: true, screen: true } } : { ok: false, error: request.op === 'screenshot' ? 'screen_permission' : 'fixture-app-failure' }; process.stdout.write(JSON.stringify({ id: request.id, ...result }) + '\\n'); });\n`,
        { mode: 0o700 },
      );
      const signal = new AbortController().signal;
      await assert.rejects(computer.screenshot!('fixture', signal), (error: Error) => {
        assert.ok(error instanceof Error);
        assert.notEqual(error.message, 'screen_permission');
        return true;
      });
      await assert.rejects(computer.apps!(signal), { message: 'fixture-app-failure' });
      assert.deepEqual(await computer.permissions!(), { accessibility: true, screen: true });
    } finally {
      computer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

if (process.platform === 'darwin') {
  test('native Mac helper observes apps it opens without another request waking its run loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-native-launch-'));
    const name = `nod Launch Fixture ${randomUUID()}`;
    const bundleId = `org.example.nod-launch-fixture.${randomUUID()}`;
    const app = join(homedir(), 'Applications', `${name}.app`);
    const helper = join(root, 'helper');
    const source = join(root, 'fixture.swift');
    const pidFile = join(root, 'fixture.pid');
    const computer = createMacComputer({ dataRoot: root, helper, helperTimeoutMs: 10_000 });
    try {
      await mkdir(join(app, 'Contents/MacOS'), { recursive: true });
      await writeFile(
        join(app, 'Contents/Info.plist'),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleName</key><string>${name}</string><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      );
      await writeFile(
        source,
        `import AppKit
let application = NSApplication.shared
application.setActivationPolicy(.regular)
try! String(ProcessInfo.processInfo.processIdentifier).write(toFile: ${JSON.stringify(pidFile)}, atomically: true, encoding: .utf8)
application.run()
`,
      );
      for (const [output, input] of [
        [join(app, 'Contents/MacOS/fixture'), source],
        [helper, fileURLToPath(new URL('../desktop/computer-use/main.swift', import.meta.url))],
      ]) {
        const build = await runProcess('/usr/bin/swiftc', ['-O', '-o', output!, input!], {
          timeoutMs: 30_000,
        });
        assert.equal(build.exitCode, 0, build.stderr);
      }
      const signal = AbortSignal.timeout(15_000);
      assert.equal(
        (await computer.apps!(signal)).some((app) => app.bundleId === bundleId),
        false,
      );
      const opened = await computer.open!(name, signal);
      assert.equal(opened.bundleId, bundleId);
      assert.equal((await computer.resolve!(bundleId, signal))?.bundleId, bundleId);
      assert.equal(
        (await computer.apps!(signal)).some((app) => app.bundleId === bundleId),
        true,
      );
    } finally {
      computer.dispose();
      const pid = await readFile(pidFile, 'utf8').catch(() => undefined);
      if (pid) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      await rm(app, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  test('owner shell cannot connect to accessibility, input or screen capture services', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-ui-services-'));
    const source = join(root, 'probe.c');
    const program = join(root, 'probe');
    const computer = createMacComputer({ dataRoot: join(root, 'data') });
    try {
      await writeFile(
        source,
        `#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  mach_port_t port;
  kern_return_t result;
  if (strcmp(argv[1], "serve") == 0) {
    mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &port);
    mach_port_insert_right(mach_task_self(), port, port, MACH_MSG_TYPE_MAKE_SEND);
    result = bootstrap_register(bootstrap_port, argv[2], port);
    printf("%d\\n", result);
    fflush(stdout);
    if (result != KERN_SUCCESS) return 1;
    sleep(30);
    return 0;
  }
  result = bootstrap_look_up(bootstrap_port, argv[2], &port);
  printf("%d\\n", result);
  return result == KERN_SUCCESS ? 0 : 1;
}
`,
      );
      const build = spawnSync('/usr/bin/clang', ['-o', program, source], { encoding: 'utf8' });
      assert.equal(build.status, 0, build.stderr);
      for (const prefix of [
        'com.apple.axserver',
        'com.apple.windowserver',
        'com.apple.replayd',
        'com.apple.ScreenCaptureKit',
      ]) {
        const service = `${prefix}.nod-fixture.${randomUUID()}`;
        const server = spawn(program, ['serve', service]);
        try {
          const [ready] = await once(server.stdout, 'data', {
            signal: AbortSignal.timeout(5000),
          });
          assert.equal(String(ready).trim(), '0');
          assert.equal(spawnSync(program, ['lookup', service]).status, 0);
          const result = await computer.shell(`'${program}' lookup '${service}'`, {
            signal: new AbortController().signal,
          });
          assert.notEqual(result.exitCode, 0, prefix);
        } finally {
          const closed = once(server, 'close');
          server.kill('SIGKILL');
          await closed;
        }
      }
    } finally {
      computer.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  test('owner shell cannot read or overwrite browser sessions and account stores through aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-owner-home-'));
    try {
      const home = await realpath(root);
      const paths = [
        'Library/Application Support/Google/Chrome/Default/Cookies',
        'Library/Application Support/Firefox/Profiles/fixture/cookies.sqlite',
        'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
        'Library/Group Containers/group.com.apple.notes/NoteStore.sqlite',
        '.codex/auth.json',
        '.claude.json',
        '.config/gh/hosts.yml',
        '.npmrc',
      ];
      await mkdir(join(home, 'Documents'));
      await writeFile(join(home, 'Documents', 'public.txt'), 'synthetic document');
      for (const path of paths) {
        await mkdir(join(home, path, '..'), { recursive: true });
        await writeFile(join(home, path), 'synthetic private account');
      }
      await symlink(join(home, 'Library'), join(home, 'Documents', 'alias'));
      const run = (command: string) =>
        spawnSync(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            sandboxProfile(),
            '-D',
            `DATA=${join(home, 'data')}`,
            '-D',
            `HOME=${home}`,
            '/bin/zsh',
            '-f',
            '-c',
            command,
          ],
          { encoding: 'utf8' },
        );
      assert.equal(
        run(`cat '${join(home, 'Documents', 'public.txt')}'`).stdout,
        'synthetic document',
      );
      for (const path of [
        ...paths,
        'Documents/alias/Application Support/Google/Chrome/Default/Cookies',
      ]) {
        const file = join(home, path);
        const read = run(`cat '${file}'`);
        assert.notEqual(read.status, 0, path);
        assert.doesNotMatch(read.stdout, /synthetic private account/);
        assert.notEqual(run(`printf changed > '${file}'`).status, 0, path);
        assert.equal(await readFile(file, 'utf8'), 'synthetic private account');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('owner shell protects the whole app bundle and separately configured helper', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'nod-app-isolation-'));
    const application = join(root, 'Synthetic.app');
    const engine = join(application, 'Contents/Resources/engine');
    const main = join(application, 'Contents/Resources/app/main/main.mjs');
    const preload = join(application, 'Contents/Resources/app/preload/index.cjs');
    const executable = join(application, 'Contents/MacOS/nod');
    const nested = join(application, 'Contents/Frameworks/nod Helper.app/Contents/MacOS/helper');
    const bundled = join(engine, 'desktop/computer-use/.build/nod-computer-use');
    const helper = join(root, 'standalone/helper');
    const source = join(root, 'source');
    const sourceFile = join(source, 'main.ts');
    const alias = join(root, 'linked-engine');
    const linkedMain = join(root, 'Linked.APP/Contents/Resources/app/main.mjs');
    const linkedHelper = join(root, 'Linked.APP/Contents/MacOS/helper');
    const ordinary = join(root, 'Synthetic.app-backup/document.txt');
    const targets = [main, preload, executable, nested, bundled, helper];
    try {
      for (const file of [...targets, ordinary, sourceFile, linkedMain]) {
        await mkdir(join(file, '..'), { recursive: true });
        await writeFile(file, 'original synthetic code');
      }
      await mkdir(join(linkedHelper, '..'), { recursive: true });
      await symlink(helper, linkedHelper);
      await symlink(engine, alias);
      for (const scenario of [
        { name: 'engine through a symlink', denyRead: [alias], helper, targets },
        { name: 'nested Electron executable', denyRead: [nested], helper, targets },
        {
          name: 'configured helper inside the app',
          denyRead: [source],
          helper: bundled,
          targets: targets.filter((file) => file !== helper),
        },
        {
          name: 'helper symlink leaving its app',
          denyRead: [source],
          helper: linkedHelper,
          targets: [linkedMain, linkedHelper, helper, sourceFile],
        },
      ])
        await t.test(scenario.name, async () => {
          for (const file of targets) await writeFile(file, 'original synthetic code');
          const computer = createMacComputer({ dataRoot: join(root, 'data'), ...scenario });
          const signal = AbortSignal.timeout(10_000);
          const run = (command: string) => computer.shell(command, { signal });
          try {
            for (const file of scenario.targets) {
              const result = await run(`printf changed > '${file}'`);
              assert.notEqual(
                result.exitCode,
                0,
                `Protected write succeeded: ${file.slice(root.length)}; content=${await readFile(file, 'utf8')}`,
              );
              assert.equal(await readFile(file, 'utf8'), 'original synthetic code');
              const read = await run(`cat '${file}'`);
              assert.notEqual(read.exitCode, 0);
              assert.doesNotMatch(read.output, /original synthetic code/);
            }
            assert.equal((await run(`printf allowed > '${ordinary}'`)).exitCode, 0);
            assert.equal((await run(`cat '${ordinary}'`)).output, 'allowed');
            assert.equal((await run(`mv '${ordinary}' '${ordinary}.moved'`)).exitCode, 0);
            assert.equal((await run(`mv '${ordinary}.moved' '${ordinary}'`)).exitCode, 0);
            assert.notEqual(
              (await run(`ln '${scenario.targets[0]}' '${root}/external-hardlink'`)).exitCode,
              0,
            );
            assert.notEqual((await run(`mv '${root}' '${root}-moved'`)).exitCode, 0);
            assert.equal((await lstat(root)).isDirectory(), true);
            const document = join(root, 'unrelated-document.txt');
            assert.equal((await run(`printf allowed > '${document}'`)).exitCode, 0);
            assert.equal(await readFile(document, 'utf8'), 'allowed');
          } finally {
            computer.dispose();
          }
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("commands on the owner's computer get no keys and cannot reach nod's data or other apps", async () => {
    const root = await mkdtemp(join(tmpdir(), 'nod-computer-'));
    const install = await mkdtemp(join(tmpdir(), 'nod-install-'));
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test-secret-not-for-child';
    const computer = createMacComputer({ dataRoot: root, denyRead: [install] });
    try {
      await writeFile(join(root, 'access-key'), 'fixture-key');
      await writeFile(join(install, '.env'), 'OPENAI_API_KEY=fixture-env-key');
      const signal = new AbortController().signal;
      const run = (command: string) => computer.shell(command, { signal });
      assert.equal((await run('printf %s "$OPENAI_API_KEY"')).output, '');
      const key = await run(`cat '${join(root, 'access-key')}'`);
      assert.notEqual(key.exitCode, 0);
      assert.doesNotMatch(key.output, /fixture-key/);
      const env = await run(`cat '${join(install, '.env')}'`);
      assert.notEqual(env.exitCode, 0);
      assert.doesNotMatch(env.output, /fixture-env-key/);
      assert.equal((await run('echo hi | grep -c hi')).output.trim(), '1');
      assert.notEqual((await run("open -a '/nonexistent/nod-fixture.app'")).exitCode, 0);
      assert.notEqual((await run('osascript -e "return 1"')).exitCode, 0);
      assert.notEqual((await run('launchctl submit -l nod.fixture -- /bin/true')).exitCode, 0);
      assert.notEqual((await run('touch ~/Library/LaunchAgents/nod-fixture.plist')).exitCode, 0);
      await assert.rejects(computer.shell('sleep 5', { signal, timeoutMs: 50 }), /stopped/);
    } finally {
      await rm(install, { recursive: true, force: true });
      computer.dispose();
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

test('a missing sealed install comes from its declared source and a failed install runs nothing', async () => {
  const home = await mkdtemp('/tmp/nod-connected-');
  try {
    const launch: WorkspaceCommandLauncher = (_command, args, options) =>
      spawn('python3', args.slice(args.indexOf('-I')), { ...options, cwd: home, stdio: 'pipe' });
    const cli = {
      id: randomUUID(),
      command: 'fixturecli',
      source: { url: 'https://127.0.0.1:9/fixturecli' },
    };
    const result = await runWorkspaceCommand({
      container: 'nod-workspace-fixture',
      threadId: 'fixture',
      args: ['status'],
      environment: { FIXTURE_TOKEN: 'synthetic-connected-token' },
      cli,
      spawn: launch,
    });
    assert.notEqual(result.exitCode, 0);
    assert.match(result.stderr.toString(), /Could not install fixturecli/);
    assert.equal(existsSync(join(home, `nod-cli-${cli.id}`, '.installed')), false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('sealed downloads install only the declared bytes and find the program in archives', async () => {
  const root = await mkdtemp('/tmp/nod-cli-install-');
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
