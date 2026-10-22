import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readlinkSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { ComputerPermissionKind, MacApp, OwnerComputer } from '../../ports/owner-computer.ts';

const outputBytes = 256 * 1024;
const defaultTimeoutMs = 10 * 60_000;

export function sandboxProfile(denyRead: string[] = []) {
  const parents = new Set<string>();
  for (const path of denyRead)
    for (let parent = dirname(path); parent !== dirname(parent); parent = dirname(parent))
      parents.add(parent);
  const extra = denyRead
    .map((path) => `(deny file-read* file-write* (subpath "${path.replace(/(["\\])/g, '\\$1')}"))`)
    .join('\n');
  const fixed = [...parents]
    .map((path) => `(deny file-write-unlink (literal "${path.replace(/(["\\])/g, '\\$1')}"))`)
    .join('\n');
  return `(version 1)
(allow default)
(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid SYS_posix_spawn))
(deny process-info* (target others))
(deny file-read* file-write* (subpath (param "DATA")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/Library")) (regex (string-append "^" (regex-quote (param "HOME")) "/\\\\.[^/]+($|/)")))
${extra}
${fixed}
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))
(deny mach-lookup (local-name-prefix "com.apple.axserver") (global-name-prefix "com.apple.axserver") (global-name-prefix "com.apple.windowserver") (global-name-prefix "com.apple.replayd") (global-name-prefix "com.apple.ScreenCaptureKit"))
(deny lsopen)
(deny file-write* (subpath (string-append (param "HOME") "/Library/LaunchAgents")) (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons") (subpath (string-append (param "HOME") "/Library/Application Support/com.apple.backgroundtaskmanagementagent")) (regex (string-append "^" (regex-quote (param "HOME")) "/\\\\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|bash_login|zlogout)$")))
(deny appleevent-send)
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts") (literal "/usr/bin/security") (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at"))
`;
}

export function resolveComputerPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink())
      return resolveComputerPath(resolve(dirname(absolute), readlinkSync(absolute)));
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(resolveComputerPath(parent), basename(absolute));
  }
}

function capture() {
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let dropped = 0;
  return {
    push(chunk: Buffer) {
      if (head.length < outputBytes / 4) {
        const room = outputBytes / 4 - head.length;
        head = Buffer.concat([head, chunk.subarray(0, room)]);
        chunk = chunk.subarray(room);
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > (outputBytes * 3) / 4) {
        dropped += tail.length - (outputBytes * 3) / 4;
        tail = tail.subarray(tail.length - (outputBytes * 3) / 4);
      }
    },
    text() {
      return dropped
        ? `${head.toString('utf8')}\n[${dropped} bytes omitted]\n${tail.toString('utf8')}`
        : `${head.toString('utf8')}${tail.toString('utf8')}`;
    },
  };
}

export function createMacComputer(options: {
  dataRoot: string;
  helper?: string;
  denyRead?: string[];
  helperTimeoutMs?: number;
}): OwnerComputer {
  const home = homedir();
  const protectedPaths = new Set(
    [...(options.denyRead ?? []), ...(options.helper ? [options.helper] : [])].flatMap((path) => [
      resolve(path),
      resolveComputerPath(resolve(path)),
    ]),
  );
  for (const path of [...protectedPaths]) {
    for (
      let directory = dirname(path);
      directory !== dirname(directory);
      directory = dirname(directory)
    ) {
      if (directory.toLowerCase().endsWith('.app')) {
        protectedPaths.add(directory);
        protectedPaths.add(resolveComputerPath(directory));
      }
    }
  }
  const profile = sandboxProfile([...protectedPaths]);
  const data = resolveComputerPath(options.dataRoot);
  let helper: ChildProcessWithoutNullStreams | undefined;
  let nextId = 0;
  const pending = new Map<
    number,
    {
      child: ChildProcessWithoutNullStreams;
      resolve(value: unknown): void;
      reject(error: Error): void;
    }
  >();

  function stop(child: ChildProcessWithoutNullStreams, error: Error) {
    if (helper === child) helper = undefined;
    child.kill('SIGKILL');
    for (const [id, waiting] of pending) {
      if (waiting.child !== child) continue;
      pending.delete(id);
      waiting.reject(error);
    }
  }

  function start() {
    if (helper) return helper;
    if (!options.helper || !existsSync(options.helper))
      throw new Error(
        'Mac app control needs nod Computer Use. For a source install, run pnpm run computer:build, or use the nod desktop app. The shell action is still available.',
      );
    const child = spawn(options.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    helper = child;
    child.stderr.resume();
    child.stdin.on('error', () => stop(child, new Error('nod Computer Use is unavailable.')));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiting = typeof message.id === 'number' ? pending.get(message.id) : undefined;
      if (!waiting) return;
      pending.delete(message.id!);
      if (message.ok) waiting.resolve(message.result);
      else
        waiting.reject(new Error(permissionMessage(message.error ?? 'The Mac app step failed.')));
    });
    child.on('close', () =>
      stop(child, new Error('nod Computer Use stopped. Look again to check what completed.')),
    );
    child.on('error', () => stop(child, new Error('nod Computer Use is unavailable.')));
    return child;
  }

  function call<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const child = start();
    const id = ++nextId;
    const timeoutMs =
      options.helperTimeoutMs ??
      (request.op === 'act' && request.action === 'type' ? 120_000 : 60_000);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        stop(
          child,
          signal!.reason instanceof Error ? signal!.reason : new Error('Task cancelled.'),
        );
      };
      const timer = setTimeout(
        () =>
          stop(child, new Error('nod Computer Use timed out. Look again to check what completed.')),
        timeoutMs,
      );
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, {
        child,
        resolve: (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  return {
    get appControlAvailable() {
      if (!options.helper) return false;
      try {
        accessSync(options.helper, constants.X_OK);
        return statSync(options.helper).isFile();
      } catch {
        return false;
      }
    },
    shell(command, { signal, timeoutMs = defaultTimeoutMs }) {
      signal.throwIfAborted();
      return new Promise((resolve, reject) => {
        const child = spawn(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            profile,
            '-D',
            `DATA=${data}`,
            '-D',
            `HOME=${home}`,
            '/bin/zsh',
            '-f',
            '-c',
            command,
          ],
          {
            cwd: home,
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
              PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
              HOME: home,
              LANG: 'en_US.UTF-8',
              TMPDIR: process.env.TMPDIR ?? '/tmp',
              TERM: 'dumb',
            },
          },
        );
        const output = capture();
        let stopped: string | undefined;
        const kill = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        };
        const stop = (reason: string) => {
          stopped = reason;
          kill();
        };
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        const abort = () => stop('aborted');
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', output.push);
        child.stderr.on('data', output.push);
        child.once('exit', kill);
        child.on('error', () => reject(new Error('The shell on your computer is unavailable.')));
        child.on('close', (code) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', abort);
          if (stopped === 'aborted') return reject(new Error('Task cancelled.'));
          if (stopped === 'timeout')
            return reject(
              new Error(
                `The command ran past ${Math.round(timeoutMs / 1000)} seconds and was stopped.`,
              ),
            );
          resolve({ exitCode: code ?? 1, output: output.text() });
        });
      });
    },
    apps: (signal) => call<MacApp[]>({ op: 'apps' }, signal),
    resolve: (app, signal) =>
      call<MacApp>({ op: 'resolve', app }, signal).catch((error: Error) => {
        if (/is not running/.test(error.message)) return null;
        throw error;
      }),
    identify: (app, signal) =>
      call<MacApp>({ op: 'identify', app }, signal).catch((error: Error) => {
        if (/No app named/.test(error.message)) return null;
        throw error;
      }),
    open: (app, signal) => call<MacApp>({ op: 'open', app }, signal),
    async look(app, signal) {
      const result = await call<{ app: MacApp; tree: string; truncated: boolean }>(
        { op: 'look', app },
        signal,
      );
      return {
        app: result.app,
        tree: result.truncated ? `${result.tree}\n[tree truncated]` : result.tree,
      };
    },
    inspect: (app, ref, signal) =>
      call<{ label: string; token: string }>({ op: 'inspect', app, ref }, signal),
    act: async (action, signal) => {
      await call({ op: 'act', ...action }, signal);
    },
    async screenshot(app, signal) {
      const result = await call<{ app: MacApp; png: string }>({ op: 'screenshot', app }, signal);
      const png = Buffer.from(result.png, 'base64');
      if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
        throw new Error('nod Computer Use did not return a PNG screenshot.');
      return { app: result.app, png };
    },
    permissions: () => call<Record<ComputerPermissionKind, boolean>>({ op: 'status' }),
    requestPermission: (kind) =>
      call<Record<ComputerPermissionKind, boolean>>({ op: 'request', permission: kind }),
    dispose() {
      if (helper) stop(helper, new Error('nod Computer Use stopped.'));
    },
  };
}

function permissionMessage(error: string) {
  if (error === 'accessibility_permission')
    return 'nod needs Accessibility permission to use Mac apps. Ask the owner to allow it in Settings, under Your computer.';
  if (error === 'screen_permission')
    return 'macOS refused screen capture. Ask the owner to review Screen Recording permission in macOS Settings, then retry the screenshot.';
  return error;
}
