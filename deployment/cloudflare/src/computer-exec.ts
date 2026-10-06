import { RuntimeControlError } from './protocol.ts';

const unavailable = () => new RuntimeControlError(503);

function release(process: ExecProcess, kill: boolean) {
  if (kill) {
    try {
      process.kill(9);
    } catch {}
  }
  for (const dispose of [
    () => process.stdin?.abort(),
    () => process.stdout?.cancel(),
    () => process.stderr?.cancel(),
  ]) {
    try {
      void dispose()?.catch(() => {});
    } catch {}
  }
}

type ExecOptions<T> = {
  timeoutMs: number;
  launch(signal: AbortSignal): ExecProcess | Promise<ExecProcess>;
  consume(process: ExecProcess, signal: AbortSignal): Promise<T>;
};

async function useComputerExec<T>(options: ExecOptions<T>, retain: boolean): Promise<T> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 180_000
  )
    throw unavailable();
  const controller = new AbortController();
  const signal = controller.signal;
  let process: ExecProcess | undefined;
  let finished = false;
  let rejectAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(unavailable());
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    return await Promise.race([
      cancelled,
      (async () => {
        const launched = await options.launch(signal);
        void launched.exitCode.catch(() => {});
        if (finished || signal.aborted) {
          release(launched, true);
          throw unavailable();
        }
        process = launched;
        const [result, code] = await Promise.all([
          options.consume(launched, signal),
          retain ? 0 : launched.exitCode,
        ]);
        if (signal.aborted || !Number.isSafeInteger(code) || code !== 0) throw unavailable();
        return result;
      })(),
    ]);
  } catch {
    controller.abort();
    if (process) release(process, true);
    throw unavailable();
  } finally {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', rejectAbort);
    if (process && !retain) release(process, false);
  }
}

export function runComputerExec<T>(options: ExecOptions<T>) {
  return useComputerExec(options, false);
}

export function launchComputerExec(options: Omit<ExecOptions<ExecProcess>, 'consume'>) {
  return useComputerExec({ ...options, consume: async (process) => process }, true);
}

export function refusedCommand(message: string): ExecProcess {
  let respond = () => {};
  return {
    pid: 0,
    isPty: false,
    stdin: new WritableStream<Uint8Array>({
      write(chunk) {
        if (chunk.includes(10)) respond();
      },
      close() {
        respond();
      },
    }),
    stdout: new ReadableStream<Uint8Array>({
      start(controller) {
        respond = () => {
          respond = () => {};
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ type: 'exit', code: 0, reason: 'refused', message }) + '\n',
            ),
          );
          controller.close();
        };
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exitCode: Promise.resolve(0),
    async output() {
      throw unavailable();
    },
    kill() {},
    resize() {},
  };
}
