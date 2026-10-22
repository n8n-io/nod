import { spawn } from 'node:child_process';

export interface ProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
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
      'NOD_WSL_DISTRIBUTION',
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
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill('SIGKILL');
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);
    const abort = () => stop();
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', () => reject(new Error('The required runtime executable is unavailable.')));
    child.on('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) return reject(new Error('Task cancelled.'));
      if (stopped) return reject(new Error('Runtime command exceeded its time limit.'));
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
