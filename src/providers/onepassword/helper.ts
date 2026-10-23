import { PasswordManagerError } from '../../ports/password-manager.ts';
import { helperRequest } from './protocol.ts';
import { onePasswordVault } from './vault.ts';

type ElectronPort = {
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
  on(event: 'close', listener: () => void): void;
  postMessage(message: unknown): void;
  start(): void;
};

type Channel = {
  send(message: unknown): void;
  receive(listener: (message: unknown) => void): void;
  closed(listener: () => void): void;
};

function parent(): Promise<Channel> {
  const electron = (
    process as NodeJS.Process & {
      parentPort?: {
        once(event: 'message', listener: (event: { ports: ElectronPort[] }) => void): void;
      };
    }
  ).parentPort;
  if (electron)
    return new Promise((resolve) =>
      electron.once('message', ({ ports: [port] }) => {
        if (!port) process.exit(1);
        port.start();
        resolve({
          send: (message) => port.postMessage(message),
          receive: (listener) => port.on('message', (event) => listener(event.data)),
          closed: (listener) => port.on('close', listener),
        });
      }),
    );
  if (!process.send) throw new Error('The 1Password helper needs a parent process.');
  return Promise.resolve({
    send: (message) => process.send!(message),
    receive: (listener) => process.on('message', listener),
    closed: (listener) => process.on('disconnect', listener),
  });
}

const vault = onePasswordVault(process.argv[2] || 'source');
const channel = await parent();
channel.closed(() => process.exit(0));
channel.receive(async (raw) => {
  const parsed = helperRequest.safeParse(raw);
  if (!parsed.success) return;
  const request = parsed.data;
  try {
    const value =
      request.method === 'logins'
        ? await vault.logins(request.account, request.origin)
        : await vault.login(request.account, request.origin, request.item);
    channel.send({ id: request.id, ok: true, value });
  } catch (error) {
    const failure =
      error instanceof PasswordManagerError
        ? error
        : new PasswordManagerError('failed', 'The 1Password request failed.');
    channel.send({
      id: request.id,
      ok: false,
      reason: failure.reason,
      message: failure.message.slice(0, 500),
    });
  }
});
