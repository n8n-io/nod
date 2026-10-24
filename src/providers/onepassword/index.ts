import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PasswordManagerError, type PasswordManager } from '../../ports/password-manager.ts';
import { helperReply, loginsValue, loginValue, type HelperRequest } from './protocol.ts';

export interface OnePasswordChannel {
  send(message: HelperRequest): void;
  receive(listener: (message: unknown) => void): void;
  closed(listener: () => void): void;
  close(): void;
}

type Call = HelperRequest extends infer Request
  ? Request extends HelperRequest
    ? Omit<Request, 'id'>
    : never
  : never;

type ElectronPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
};

type ElectronMessage = { data: unknown; ports: ElectronPort[] };

const helper = fileURLToPath(new URL('./helper.ts', import.meta.url));
const helperEnvironment = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'PATH',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
];

export function forkedOnePassword(version: string) {
  return async (): Promise<OnePasswordChannel> => {
    const child = fork(helper, [version], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: Object.fromEntries(
        helperEnvironment.flatMap((name) =>
          process.env[name] === undefined ? [] : [[name, process.env[name]]],
        ),
      ),
    });
    await once(child, 'spawn');
    child.on('error', () => child.kill());
    return {
      send: (message) => {
        child.send(message, (error) => {
          if (error) child.kill();
        });
      },
      receive: (listener) => child.on('message', listener),
      closed: (listener) => child.once('exit', () => listener()),
      close: () => child.kill(),
    };
  };
}

export function desktopOnePassword() {
  return () =>
    new Promise<OnePasswordChannel>((resolve, reject) => {
      const parent = (
        process as NodeJS.Process & {
          parentPort?: {
            on(event: 'message', listener: (event: ElectronMessage) => void): void;
            removeListener(event: 'message', listener: (event: ElectronMessage) => void): void;
            postMessage(message: unknown): void;
          };
        }
      ).parentPort;
      if (!parent) {
        reject(new Error('The 1Password helper needs nod desktop.'));
        return;
      }
      const listener = ({ data, ports }: ElectronMessage) => {
        if ((data as { type?: unknown } | null)?.type !== 'nod-1password-port') return;
        clearTimeout(timer);
        parent.removeListener('message', listener);
        const [port] = ports;
        if (!port) {
          reject(new Error('nod couldn’t start its 1Password helper.'));
          return;
        }
        port.start();
        resolve({
          send: (message) => port.postMessage(message),
          receive: (receiver) => port.on('message', (event) => receiver(event.data)),
          closed: (receiver) => port.on('close', receiver),
          close: () => port.close(),
        });
      };
      const timer = setTimeout(() => {
        parent.removeListener('message', listener);
        reject(new Error('nod couldn’t start its 1Password helper.'));
      }, 15_000);
      parent.on('message', listener);
      parent.postMessage({ type: 'nod-1password-open' });
    });
}

export function createOnePassword(options: {
  open(): Promise<OnePasswordChannel>;
  idleMs?: number;
  answerMs?: number;
}): PasswordManager {
  const idleMs = options.idleMs ?? 10 * 60_000;
  const answerMs = options.answerMs ?? 120_000;
  const waiting = new Map<
    number,
    {
      channel: OnePasswordChannel;
      resolve(value: unknown): void;
      reject(error: PasswordManagerError): void;
    }
  >();
  const ended = new WeakSet<OnePasswordChannel>();
  let current: Promise<OnePasswordChannel> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;

  function stop(channel: OnePasswordChannel, message: string) {
    for (const waiter of waiting.values())
      if (waiter.channel === channel) waiter.reject(new PasswordManagerError('failed', message));
  }

  function connect() {
    if (current) return current;
    const opening: Promise<OnePasswordChannel> = options.open().then(
      (channel) => {
        channel.receive((raw) => {
          const reply = helperReply.safeParse(raw);
          const waiter = reply.success ? waiting.get(reply.data.id) : undefined;
          if (!reply.success || !waiter) return;
          if (reply.data.ok) waiter.resolve(reply.data.value);
          else waiter.reject(new PasswordManagerError(reply.data.reason, reply.data.message));
        });
        channel.closed(() => {
          ended.add(channel);
          if (current === opening) current = undefined;
          stop(channel, 'The 1Password helper stopped. Try again.');
        });
        return channel;
      },
      (error: unknown) => {
        if (current === opening) current = undefined;
        throw new PasswordManagerError(
          'unavailable',
          error instanceof Error ? error.message : 'nod couldn’t start its 1Password helper.',
        );
      },
    );
    current = opening;
    return opening;
  }

  async function call(request: Call, signal?: AbortSignal) {
    signal?.throwIfAborted();
    clearTimeout(idle);
    try {
      const channel = await connect();
      signal?.throwIfAborted();
      const id = ++sequence;
      return await new Promise<unknown>((resolve, reject) => {
        const settle = (error: PasswordManagerError | undefined, value?: unknown) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          waiting.delete(id);
          if (error) reject(error);
          else resolve(value);
        };
        const abort = () =>
          settle(new PasswordManagerError('failed', 'The 1Password request was cancelled.'));
        const timer = setTimeout(
          () => settle(new PasswordManagerError('failed', '1Password didn’t answer in time.')),
          answerMs,
        );
        waiting.set(id, {
          channel,
          resolve: (value) => settle(undefined, value),
          reject: (error) => settle(error),
        });
        signal?.addEventListener('abort', abort, { once: true });
        try {
          if (ended.has(channel)) throw new Error('closed');
          channel.send({ ...request, id });
        } catch {
          settle(new PasswordManagerError('failed', 'The 1Password helper stopped. Try again.'));
        }
      });
    } finally {
      if (!waiting.size) {
        idle = setTimeout(() => void close(), idleMs);
        idle.unref?.();
      }
    }
  }

  function answer<T>(
    schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
    value: unknown,
  ) {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new PasswordManagerError('failed', 'The 1Password helper sent an unexpected answer.');
    return parsed.data;
  }

  async function close() {
    clearTimeout(idle);
    const opened = current;
    current = undefined;
    const channel = await opened?.catch(() => undefined);
    if (!channel) return;
    stop(channel, 'nod closed its 1Password helper.');
    channel.close();
  }

  return {
    name: '1Password',
    logins: async (account, origin, signal) =>
      answer(loginsValue, await call({ method: 'logins', account, origin }, signal)),
    login: async (account, origin, item, signal) =>
      answer(loginValue, await call({ method: 'login', account, origin, item }, signal)),
    close,
  };
}
