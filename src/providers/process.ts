import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}

export function serviceEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      'PATH',
      'TMPDIR',
      'LANG',
      'DOCKER_HOST',
      'DOCKER_CONTEXT',
      'DOCKER_CONFIG',
      'SYSTEMROOT',
      'USERPROFILE',
      'LOCALAPPDATA',
      'TEMP',
      'TMP',
      'OTTO_WSL_DISTRIBUTION',
    ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : [])),
  );
}

export function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? serviceEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    let size = 0;
    let stopped = false;
    const maxBytes = options.maxBytes ?? 64 * 1024;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (size < maxBytes) target.push(chunk.subarray(0, maxBytes - size));
      size += chunk.length;
      if (size > maxBytes) stop();
    };
    child.stdout.on('data', (chunk) => capture(chunks, chunk));
    child.stderr.on('data', (chunk) => capture(errors, chunk));
    child.on('error', () => reject(new Error('The required runtime executable is unavailable.')));
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return reject(new Error('Task cancelled.'));
      if (stopped) return reject(new Error('Runtime command exceeded its time or output limit.'));
      resolve({
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errors).toString('utf8'),
        exitCode: code ?? 1,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
