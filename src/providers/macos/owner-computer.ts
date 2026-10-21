import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import type {
  ComputerPermissionKind,
  MacApp,
  MacAppAction,
  OwnerComputer,
} from '../../ports/owner-computer.ts';

const outputBytes = 256 * 1024;
const defaultTimeoutMs = 10 * 60_000;

export function sandboxProfile(denyRead: string[] = []) {
  const extra = denyRead
    .map((path) => `(deny file-read* file-write* (subpath "${path.replace(/(["\\])/g, '\\$1')}"))`)
    .join('\n');
  return `(version 1)
(allow default)
(deny process-info* (target others))
(deny file-read* file-write* (subpath (param "DATA")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/Library/Keychains")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/.docker")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/.otto-desktop")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/.colima")) (subpath (string-append (param "HOME") "/.lima")) (subpath (string-append (param "HOME") "/.orbstack")) (subpath (string-append (param "HOME") "/.rd")))
(deny file-read* file-write* (subpath (string-append (param "HOME") "/.ssh")) (subpath (string-append (param "HOME") "/.aws")) (subpath (string-append (param "HOME") "/.gnupg")) (subpath (string-append (param "HOME") "/.config/gh")) (subpath (string-append (param "HOME") "/.config/gcloud")) (subpath (string-append (param "HOME") "/.kube")) (literal (string-append (param "HOME") "/.netrc")))
${extra}
(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd") (global-name "com.apple.security.agent"))
(deny lsopen)
(deny file-write* (subpath (string-append (param "HOME") "/Library/LaunchAgents")) (subpath "/Library/LaunchAgents") (subpath "/Library/LaunchDaemons") (subpath (string-append (param "HOME") "/Library/Application Support/com.apple.backgroundtaskmanagementagent")) (regex (string-append "^" (param "HOME") "/\\\\.(zshrc|zshenv|zprofile|zlogin|bashrc|bash_profile|profile|bash_login|zlogout)$")))
(deny appleevent-send)
(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/usr/bin/automator") (literal "/usr/bin/shortcuts") (literal "/usr/bin/security") (literal "/bin/launchctl") (literal "/usr/bin/crontab") (literal "/usr/bin/at"))
`;
}

function realpath(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
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
}): OwnerComputer {
  const home = homedir();
  const profile = sandboxProfile((options.denyRead ?? []).map(realpath));
  const data = realpath(options.dataRoot);
  let helper: ChildProcessWithoutNullStreams | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const trees = new Map<string, Map<string, string>>();

  function start() {
    if (helper) return helper;
    if (!options.helper || !existsSync(options.helper))
      throw new Error(
        'Mac app control needs the Otto desktop app. Use the shell action for files and commands.',
      );
    const child = spawn(options.helper, [], { stdio: ['pipe', 'pipe', 'pipe'], env: {} });
    child.stderr.resume();
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
    child.on('exit', () => {
      if (helper === child) helper = undefined;
      for (const waiting of pending.values())
        waiting.reject(
          new Error('Otto Computer Use stopped. Try the step again after a fresh look.'),
        );
      pending.clear();
      trees.clear();
    });
    child.on('error', () => {});
    helper = child;
    return child;
  }

  function call<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const child = start();
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        reject(signal!.reason instanceof Error ? signal!.reason : new Error('Task cancelled.'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  return {
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
        const stop = (reason: string) => {
          stopped = reason;
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {}
        };
        const timer = setTimeout(() => stop('timeout'), timeoutMs);
        const abort = () => stop('aborted');
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.on('data', output.push);
        child.stderr.on('data', output.push);
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
      const labels = new Map<string, string>();
      for (const line of result.tree.split('\n')) {
        const ref = /\[ref=(e\d+)\]$/.exec(line)?.[1];
        if (ref && !labels.has(ref))
          labels.set(
            ref,
            line
              .trim()
              .replace(/^- /, '')
              .replace(/ \[ref=e\d+\]$/, ''),
          );
      }
      trees.clear();
      trees.set(result.app.bundleId, labels);
      return {
        app: result.app,
        tree: result.truncated ? `${result.tree}\n[tree truncated]` : result.tree,
      };
    },
    label: (bundleId, ref) => trees.get(bundleId)?.get(ref),
    act: async (action, signal) => {
      await call({ op: 'act', ...action }, signal);
    },
    async screenshot(app, signal) {
      const result = await call<{ app: MacApp; png: string }>({ op: 'screenshot', app }, signal);
      return { app: result.app, png: Buffer.from(result.png, 'base64') };
    },
    permissions: () => call<Record<ComputerPermissionKind, boolean>>({ op: 'status' }),
    requestPermission: (kind) =>
      call<Record<ComputerPermissionKind, boolean>>({ op: 'request', permission: kind }),
    dispose() {
      helper?.kill();
      helper = undefined;
    },
  };
}

function permissionMessage(error: string) {
  if (error === 'accessibility_permission')
    return 'Otto needs Accessibility permission to use Mac apps. Ask the owner to allow it in Settings, under Your computer.';
  if (error === 'screen_permission')
    return 'Otto needs Screen Recording permission to see app windows. Ask the owner to allow it in Settings, under Your computer.';
  return error;
}
