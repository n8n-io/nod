import { Sandbox } from 'e2b';

export interface E2BCommand {
  sendStdin(data: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  wait(): Promise<{ exitCode: number }>;
  disconnect(): Promise<void>;
}

export type E2BCommandRole = 'browser' | 'workspace' | 'connected';

export interface E2BSandbox {
  id: string;
  ready(): Promise<void>;
  start(input: {
    role: E2BCommandRole;
    command: string;
    stdout(data: string): void;
    stderr(data: string): void;
  }): Promise<E2BCommand>;
  keepAlive(): Promise<void>;
  pause(): Promise<boolean>;
}

export interface E2BClient {
  create(templateId: string, metadata: Record<string, string>): Promise<E2BSandbox>;
  connect(resourceId: string): Promise<E2BSandbox>;
}

export function createE2BClient(options: {
  apiKey: string;
  sandboxTimeoutMs?: number;
  requestTimeoutMs?: number;
  retries?: number;
}): E2BClient {
  if (!options.apiKey.trim()) throw new Error('An E2B API key is required.');
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const timeoutMs = options.sandboxTimeoutMs ?? 30 * 60_000;
  const connection = {
    apiKey: options.apiKey,
    requestTimeoutMs,
    ...(options.retries === undefined ? {} : { retries: options.retries }),
  };
  function wrap(sandbox: Sandbox): E2BSandbox {
    return {
      id: sandbox.sandboxId,
      async ready() {
        try {
          const result = await sandbox.commands.run('python3 /opt/otto/computer-guard.py check', {
            user: 'root',
            envs: {},
            timeoutMs: 30_000,
            requestTimeoutMs,
          });
          if (result.exitCode !== 0 || result.stdout !== '{"ready":true}\n' || result.stderr !== '')
            throw new Error();
        } catch {
          throw new Error('The remote computer did not pass its readiness check.');
        }
      },
      async start(input) {
        if (input.role !== 'browser' && input.role !== 'workspace' && input.role !== 'connected')
          throw new Error('The remote computer command is invalid.');
        const handle = await sandbox.commands.run(input.command, {
          background: true,
          stdin: true,
          user:
            input.role === 'browser'
              ? 'otto-browser'
              : input.role === 'connected'
                ? 'otto-connected'
                : 'node',
          envs: {},
          timeoutMs: 180_000,
          requestTimeoutMs,
          onStdout: input.stdout,
          onStderr: input.stderr,
        });
        return {
          sendStdin: (data) => handle.sendStdin(data, { requestTimeoutMs }),
          closeStdin: () => handle.closeStdin({ requestTimeoutMs }),
          wait: () => handle.wait(),
          disconnect: () => handle.disconnect(),
        };
      },
      keepAlive: () => sandbox.setTimeout(timeoutMs, { requestTimeoutMs }),
      pause: () => sandbox.pause({ requestTimeoutMs }),
    };
  }
  return {
    create: async (templateId, metadata) =>
      wrap(
        await Sandbox.create(templateId, {
          ...connection,
          timeoutMs,
          metadata,
          lifecycle: { onTimeout: 'pause', autoResume: false },
          envs: {},
          network: { allowPublicTraffic: false },
        }),
      ),
    connect: async (resourceId) =>
      wrap(await Sandbox.connect(resourceId, { ...connection, timeoutMs, onResume: 'restore' })),
  };
}
