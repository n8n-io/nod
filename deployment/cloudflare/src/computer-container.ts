import { createHash, randomUUID } from 'node:crypto';
import { Container } from '@cloudflare/containers';
import type { DeploymentInput } from '../../../src/ports/deployment.ts';
import { deploymentInputSchema } from '../../../src/server/deployment-auth.ts';
import { checkpointTooLarge, createComputerCheckpoints } from './computer-checkpoints.ts';
import { createComputerCommands } from './computer-commands.ts';
import { launchComputerExec, runComputerExec } from './computer-exec.ts';
import { assertContainerStartupSettled, startContainer } from './container-startup.ts';
import { cleanStoppedComputer } from './computer-deployment.ts';
import {
  createComputerLifecycle,
  type ComputerIdentity,
  type ComputerState,
} from './computer-lifecycle.ts';
import {
  environmentName,
  failure,
  generation,
  ownerIdentity,
  RuntimeControlError,
} from './protocol.ts';
import type { Bindings } from './worker.ts';

export function computerName(environment: string, ownerId: string, role: 'browser' | 'workspace') {
  return `computer:${environmentName(environment)}:${ownerIdentity(ownerId)}:${role}`;
}

function browserNamespace(ownerId: string) {
  return `sk-${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}`;
}

const browserArgs = ['node', '--import', 'tsx', '/app/src/providers/container-browser/bridge.ts'];
const sharedDirectories =
  "import os,sys\nflags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC\nfor path in sys.argv[2:]:\n fd=os.open(sys.argv[1],flags)\n try:\n  for part in path.split('/'):\n   try: os.mkdir(part,0o755,dir_fd=fd)\n   except FileExistsError: pass\n   child=os.open(part,flags,dir_fd=fd)\n   os.close(fd)\n   fd=child\n   os.fchmod(fd,0o755)\n finally: os.close(fd)";
const workspaceCommand = [
  '/usr/bin/setpriv',
  '--no-new-privs',
  '--inh-caps=-all',
  '--ambient-caps=-all',
  '--',
  '/usr/bin/python3',
  '-I',
  '-u',
  '/opt/otto/workspace-command.py',
];
const unavailable = () => new RuntimeControlError(503);

async function readBytes(stream: ReadableStream | null, limit: number, signal: AbortSignal) {
  if (!stream) throw unavailable();
  const reader = stream.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) throw unavailable();
      size += next.value.byteLength;
      if (size > limit) throw unavailable();
      chunks.push(next.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

abstract class ComputerContainer extends Container<Bindings> {
  abstract role: 'browser' | 'workspace';
  defaultPort = 4311;
  sleepAfter = '2m';
  enableInternet = true;
  envVars = {};
  private current:
    | {
        ownerId: string;
        generation: string;
        lifecycle: ReturnType<typeof createComputerLifecycle>;
        commands: ReturnType<typeof createComputerCommands>;
      }
    | undefined;

  private validate(owner: string, version: string) {
    const ownerId = ownerIdentity(owner);
    generation(version);
    const namespace =
      this.role === 'browser' ? this.env.BROWSER_COMPUTERS : this.env.WORKSPACE_COMPUTERS;
    if (
      this.ctx.id.toString() !==
      namespace.idFromName(computerName(this.env.OTTO_ENVIRONMENT, ownerId, this.role)).toString()
    )
      throw new RuntimeControlError(403);
    return ownerId;
  }

  private authorize(identity: ComputerIdentity, stopping: boolean) {
    return this.env.TENANTS.getByName(`tenant:${identity.environment}:${identity.ownerId}`)
      .computerIdentity(identity.ownerId, identity.generation, stopping)
      .then(() => {});
  }

  private exec(args: string[], options: ContainerExecOptions = {}) {
    if (!this.ctx.container?.running) throw unavailable();
    return this.ctx.container.exec(args, options);
  }

  private async helper(args: string[], input?: Uint8Array, keepInputOpen = false) {
    return runComputerExec({
      timeoutMs: 30_000,
      launch: (signal) =>
        this.exec(args, {
          cwd: this.role === 'browser' ? '/app' : '/home/node',
          stdin: input ? 'pipe' : undefined,
          stderr: 'ignore',
          signal,
        }),
      consume: async (process, signal) => {
        const writer = process.stdin?.getWriter();
        const cancel = () => {
          void writer?.abort().catch(() => {});
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
          const [bytes] = await Promise.all([
            readBytes(process.stdout, 16 * 1024, signal),
            (async () => {
              signal.throwIfAborted();
              if (input) {
                if (!writer) throw unavailable();
                await writer.write(input);
                signal.throwIfAborted();
                if (!keepInputOpen) await writer.close();
              }
            })(),
          ]);
          return bytes;
        } finally {
          signal.removeEventListener('abort', cancel);
          void writer?.close().catch(() => {});
          writer?.releaseLock();
        }
      },
    });
  }

  private async select(owner: string, version: string) {
    assertContainerStartupSettled(this);
    const ownerId = this.validate(owner, version);
    const expected: ComputerIdentity = {
      ownerId,
      environment: environmentName(this.env.OTTO_ENVIRONMENT),
      generation: version,
      role: this.role,
    };
    if (this.current?.generation === version && this.current.ownerId === ownerId)
      return this.current;
    const prior = await this.ctx.storage.get<ComputerState>('computer');
    assertContainerStartupSettled(this);
    if (this.current?.generation === version && this.current.ownerId === ownerId)
      return this.current;
    if (
      this.current &&
      (!prior?.stopped || prior.phase === 'uncertain' || this.current.commands.active)
    )
      throw unavailable();
    const token = {};
    const assertSelected = () => {
      if (this.selection !== token) throw unavailable();
    };
    this.selection = token;
    const path =
      this.role === 'browser' ? `/data/${browserNamespace(ownerId)}` : '/home/node/state';
    const checkpoints = (assertCurrent: () => Promise<void>) =>
      createComputerCheckpoints({
        bucket: this.env.TENANT_FILES,
        ...expected,
        assertCurrent,
        waitUntil: (pending) => this.ctx.waitUntil(pending),
      });
    const lifecycle = createComputerLifecycle({
      role: this.role,
      environment: expected.environment,
      read: () => this.ctx.storage.get<ComputerState>('computer'),
      write: async (state) => {
        assertSelected();
        await this.ctx.storage.transaction(async (storage) => {
          const latest = await storage.get<ComputerState>('computer');
          if (
            latest &&
            (latest.ownerId !== state.ownerId ||
              latest.role !== state.role ||
              latest.environment !== state.environment ||
              BigInt(latest.generation) > BigInt(state.generation) ||
              (latest.phase === 'uncertain' &&
                state.phase !== 'uncertain' &&
                (state.phase !== 'ready' || !state.stopped || this.ctx.container?.running)))
          )
            throw unavailable();
          await storage.put('computer', state);
        });
      },
      claimCommand: async (identity, id) => {
        assertSelected();
        if (
          identity.ownerId !== expected.ownerId ||
          identity.environment !== expected.environment ||
          identity.role !== expected.role ||
          BigInt(generation(identity.generation)) > BigInt(expected.generation)
        )
          throw unavailable();
        const key = `command:${identity.generation}:${ownerIdentity(id)}`;
        return this.ctx.storage.transaction(async (storage) => {
          if (await storage.get<boolean>(key)) return false;
          await storage.put(key, true);
          return true;
        });
      },
      authorize: async (identity, stopping) => {
        assertSelected();
        await this.authorize(identity, stopping);
        assertSelected();
      },
      running: () => {
        assertContainerStartupSettled(this);
        return this.ctx.container?.running === true;
      },
      start: async () => {
        assertSelected();
        await startContainer(this, { envVars: {}, timeoutMs: 45_000 });
      },
      destroy: async () => {
        assertSelected();
        assertContainerStartupSettled(this);
        await this.destroy();
        assertContainerStartupSettled(this);
        if (this.ctx.container?.running) throw unavailable();
      },
      restore: async (state, assertCurrent) => {
        if (state.checkpoint) {
          let body: ReadableStream<Uint8Array> | undefined;
          try {
            await runComputerExec({
              timeoutMs: 120_000,
              launch: async (signal) => {
                body = await checkpoints(assertCurrent).open(state.checkpoint!);
                if (signal.aborted) {
                  void body.cancel().catch(() => {});
                  throw unavailable();
                }
                return this.exec(
                  [
                    'python3',
                    '-u',
                    '/opt/otto/checkpoint.py',
                    'restore',
                    path,
                    '--sha256',
                    state.checkpoint!.sha256,
                  ],
                  {
                    stdin: body,
                    stdout: 'ignore',
                    stderr: 'ignore',
                    signal,
                  },
                );
              },
              consume: async () => {},
            });
          } finally {
            void body?.cancel().catch(() => {});
          }
        }
        await assertCurrent();
        await this.helper(
          this.role === 'browser'
            ? [
                'python3',
                '-c',
                'import os,sys;os.umask(0o077);os.makedirs(sys.argv[1],mode=0o700,exist_ok=True)',
                path,
              ]
            : ['python3', '-c', sharedDirectories, '/home/node', 'state/workspace', 'state/tools'],
        );
      },
      checkpoint: async (_state, assertCurrent) => {
        const result = await runComputerExec({
          timeoutMs: 120_000,
          launch: (signal) =>
            this.exec(
              [
                'python3',
                '-u',
                '/opt/otto/checkpoint.py',
                'create',
                path,
                ...(this.role === 'browser' ? ['--browser'] : []),
              ],
              { signal },
            ),
          consume: async (process, signal) => {
            if (!process.stdout) throw unavailable();
            const [report, checkpoint] = await Promise.all([
              readBytes(process.stderr, 64 * 1024, signal),
              checkpoints(assertCurrent)
                .save({ stream: process.stdout, exitCode: process.exitCode, signal })
                .catch(() => undefined),
            ]);
            if (checkpoint && !report.byteLength) return { checkpoint };
            const tooLarge =
              !checkpoint &&
              checkpointTooLarge(report, (file) =>
                file
                  .replace(/^workspace\//, '/workspace/')
                  .replace(/^tools\//, '/home/node/.local/'),
              );
            if (!tooLarge) throw unavailable();
            return { tooLarge };
          },
        });
        if ('tooLarge' in result) throw result.tooLarge;
        return result.checkpoint;
      },
      removeCheckpoint: (checkpoint, assertCurrent) =>
        checkpoints(assertCurrent).remove(checkpoint),
      quiesce: async (_state, stopping) => {
        const id = randomUUID();
        const data = new TextEncoder().encode(
          JSON.stringify({
            type: 'request',
            request: {
              id,
              namespace: browserNamespace(ownerId),
              method: stopping ? 'dispose' : 'quiesce',
            },
          }) + '\n',
        );
        const bytes = await this.helper(browserArgs, data, true);
        const response = JSON.parse(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
        );
        if (
          response.id !== id ||
          response.ok !== true ||
          (stopping ? response.result !== null : typeof response.result !== 'boolean')
        )
          throw unavailable();
        return stopping || response.result === true;
      },
      launch: async (_state, { threadId, connected }) => {
        this.renewActivityTimeout();
        if (this.role === 'browser')
          return launchComputerExec({
            timeoutMs: 30_000,
            launch: (signal) => this.exec(browserArgs, { cwd: '/app', stdin: 'pipe', signal }),
          });
        if (!threadId || !/^[a-zA-Z0-9_-]{1,100}$/.test(threadId)) throw unavailable();
        if (!connected)
          await this.helper([
            'python3',
            '-c',
            sharedDirectories,
            '/home/node',
            `state/workspace/${threadId}`,
          ]);
        return launchComputerExec({
          timeoutMs: 30_000,
          launch: (signal) =>
            this.exec(
              workspaceCommand,
              connected
                ? { user: `${connected}:1002`, cwd: '/var/tmp', stdin: 'pipe', signal }
                : { cwd: `/workspace/${threadId}`, stdin: 'pipe', signal },
            ),
        });
      },
    });
    const commands = createComputerCommands({
      role: this.role,
      authorize: (generation) => lifecycle.authorize(ownerId, generation),
      launch: (input) => lifecycle.launch(ownerId, input),
      completed: (input) => lifecycle.completed(ownerId, input),
      uncertain: (input) => lifecycle.uncertain(ownerId, input.generation),
      live: () => lifecycle.live,
    });
    this.current = { ownerId, generation: version, lifecycle, commands };
    return this.current;
  }

  private selection: object | undefined;

  async request(ownerId: string, version: string, request: Request) {
    try {
      this.validate(ownerId, version);
      await this.authorize(
        {
          ownerId,
          generation: version,
          environment: this.env.OTTO_ENVIRONMENT,
          role: this.role,
        },
        false,
      );
      if (
        request.headers.get('x-otto-generation') !== version ||
        request.headers.get('x-otto-computer-role') !== this.role
      )
        throw new RuntimeControlError(403);
      return await (await this.select(ownerId, version)).commands.fetch(request);
    } catch (error) {
      return failure(error);
    }
  }

  async stopComputer(ownerId: string, version: string) {
    this.validate(ownerId, version);
    await this.authorize(
      { ownerId, generation: version, environment: this.env.OTTO_ENVIRONMENT, role: this.role },
      true,
    );
    const current = await this.select(ownerId, version);
    await current.commands.stop();
    await current.lifecycle.stop(ownerId, version);
    assertContainerStartupSettled(this);
    return { stopped: !this.ctx.container?.running };
  }

  async prepareDeploymentDrain(owner: string, version: string, raw: DeploymentInput) {
    const ownerId = this.validate(owner, version);
    const input = deploymentInputSchema.parse(raw);
    const authorize = async () => {
      await this.env.TENANTS.getByName(
        `tenant:${this.env.OTTO_ENVIRONMENT}:${ownerId}`,
      ).deploymentComputerIdentity(ownerId, version, input);
    };
    await authorize();
    const current = await this.select(ownerId, version);
    return current.lifecycle.drain(ownerId, version, input, {
      authorize,
      active: () => current.commands.active,
    });
  }

  async inspectDeploymentStopped(owner: string, version: string | null) {
    const ownerId = this.validate(owner, version ?? '1');
    const expected = version === null ? null : generation(version);
    const authorize = async () => {
      if (
        !(await this.env.TENANTS.getByName(
          `tenant:${this.env.OTTO_ENVIRONMENT}:${ownerId}`,
        ).deploymentStoppedIdentity(ownerId, expected))
      )
        throw unavailable();
    };
    const physicallyStopped = async () => {
      assertContainerStartupSettled(this);
      const state = await this.getState();
      assertContainerStartupSettled(this);
      return (
        !this.ctx.container?.running && ['stopped', 'stopped_with_code'].includes(state.status)
      );
    };
    await authorize();
    if (this.current)
      return this.current.lifecycle.inspectStopped(ownerId, expected, {
        authorize,
        physicallyStopped,
        active: () => this.current!.commands.active,
      });
    if (this.selection || !(await physicallyStopped())) return false;
    const state = await this.ctx.storage.get<ComputerState>('computer');
    await authorize();
    if (this.selection || this.current || !(await physicallyStopped())) return false;
    return cleanStoppedComputer({
      state,
      ownerId,
      generation: expected,
      environment: this.env.OTTO_ENVIRONMENT,
      role: this.role,
      active: 0,
      running: this.ctx.container?.running === true,
    });
  }

  override async onActivityExpired() {
    if (!this.current) {
      const state = await this.ctx.storage.get<ComputerState>('computer');
      if (state) await this.select(state.ownerId, state.generation);
    }
    if (this.current) await this.current.lifecycle.idle();
    if (this.ctx.container?.running) this.renewActivityTimeout();
  }

  override async onStop() {
    const state = await this.ctx.storage.get<ComputerState>('computer');
    if (state?.phase === 'dirty') {
      await this.ctx.storage.put('computer', { ...state, phase: 'uncertain' });
      if (this.current) this.ctx.waitUntil(this.current.commands.stop());
    }
  }

  override fetch() {
    return Promise.resolve(failure(new RuntimeControlError(404)));
  }
  override onError() {
    throw new Error('The computer is temporarily unavailable.');
  }
}

export class BrowserComputerContainer extends ComputerContainer {
  role = 'browser' as const;
}
export class WorkspaceComputerContainer extends ComputerContainer {
  role = 'workspace' as const;
}
