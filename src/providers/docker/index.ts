import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../../ports/computer.ts';
import { threadIdentity } from '../../ports/thread-identity.ts';
import {
  runWorkspaceCommand,
  WorkspaceCommandError,
  type WorkspaceCommandLauncher,
} from './command.ts';

export function workspaceFile(id: string, path: string): string {
  const base = `/workspace/${threadIdentity(id)}`;
  if (!path || path.includes('\0') || path.includes('\\'))
    throw new Error('A workspace file path is required.');
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + '/'))
    throw new Error('Files must stay within the task workspace.');
  return full;
}

export const artifactReadProgram = `import os,sys,json,stat
r=json.load(sys.stdin)
fds=[]
try:
 limit=int(r['maxBytes'])
 if not 1<=limit<=15728640: raise ValueError()
 parts=r['path'].split('/')
 if not parts or any(p in ['', '.', '..'] for p in parts): raise ValueError()
 fd=os.open(r['base'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fds.append(fd)
 for part in parts[:-1]:
  fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  fds.append(fd)
 fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
 fds.append(fd)
 info=os.fstat(fd)
 if not stat.S_ISREG(info.st_mode) or info.st_size>limit: raise ValueError()
 data=bytearray()
 while len(data)<=limit:
  chunk=os.read(fd,min(65536,limit+1-len(data)))
  if not chunk: break
  data.extend(chunk)
 if len(data)>limit: raise ValueError()
 sys.stdout.buffer.write(data)
except Exception:
 sys.exit(1)
finally:
 for fd in reversed(fds): os.close(fd)
`;

export const artifactWriteProgram = `import os,sys,json,stat,base64
r=json.load(sys.stdin)
fds=[]
try:
 parts=r['path'].split('/')
 if not parts or any(p in ['', '.', '..'] for p in parts): raise ValueError()
 temporary=r['temporary']
 if not temporary.startswith('.otto-upload-') or '/' in temporary: raise ValueError()
 fd=os.open(r['base'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
 fds.append(fd)
 for part in parts[:-1]:
  try: os.mkdir(part,mode=0o700,dir_fd=fd)
  except FileExistsError: pass
  fd=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
  fds.append(fd)
 if r.get('remove'):
  try: os.unlink(temporary,dir_fd=fd)
  except FileNotFoundError: pass
 else:
  offset=int(r['offset'])
  data=base64.b64decode(r['data'],validate=True)
  if offset<0 or len(data)>524288 or offset+len(data)>15728640: raise ValueError()
  flags=os.O_WRONLY|os.O_NOFOLLOW|os.O_NONBLOCK
  flags=flags|(os.O_CREAT|os.O_EXCL if offset==0 else os.O_APPEND)
  file=os.open(temporary,flags,mode=0o600,dir_fd=fd)
  fds.append(file)
  info=os.fstat(file)
  if not stat.S_ISREG(info.st_mode) or info.st_size!=offset: raise ValueError()
  while data:
   written=os.write(file,data)
   if written<1: raise ValueError()
   data=data[written:]
  if r['done']:
   os.fsync(file)
   os.replace(temporary,parts[-1],src_dir_fd=fd,dst_dir_fd=fd)
   os.fsync(fd)
except Exception:
 sys.exit(1)
finally:
 for fd in reversed(fds): os.close(fd)
`;

export function createDockerWorkspace(options: {
  container: string;
  workspaceRoot: string;
  spawn?: WorkspaceCommandLauncher;
}): Workspace {
  return createCommandWorkspace({
    workspaceRoot: options.workspaceRoot,
    status: `${options.container}; Linux · internet enabled`,
    instructions:
      'Your Linux workspace uses Docker networking without an Otto egress firewall. Node, Python, pipx, git, curl, ripgrep, ffmpeg, yt-dlp and poppler-utils are installed. Install trusted CLIs with npm install -g <package> or pipx install <package>; /home/node persists across tasks and restarts. You run as an unprivileged user without sudo or a graphical display; use a CLI or browser web app. Keep outputs in this workspace and install tools here, not on the user’s device.',
    runCommand: (id, args, input) =>
      runWorkspaceCommand({
        container: options.container,
        threadId: id,
        args,
        ...input,
        spawn: options.spawn,
      }),
    runConnectedCommand: (id, args, input) =>
      runWorkspaceCommand({
        container: options.container,
        threadId: id,
        args,
        ...input,
        connected: true,
        spawn: options.spawn,
      }),
  });
}

type CommandInput = {
  input?: string;
  environment?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
  onData?(chunk: Buffer): void;
};
type CommandResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

export function createCommandWorkspace(options: {
  workspaceRoot: string;
  status: string;
  instructions: string;
  runCommand(id: string, args: string[], input: CommandInput): Promise<CommandResult>;
  runConnectedCommand?(
    id: string,
    args: string[],
    input: CommandInput & { environment: Record<string, string> },
  ): Promise<CommandResult>;
}): Workspace {
  let unavailable = false;
  let disposed = false;
  const lifecycle = new AbortController();
  const pending = new Set<Promise<unknown>>();
  async function supervise(
    run: (signal: AbortSignal) => Promise<CommandResult>,
    signal?: AbortSignal,
  ) {
    if (unavailable || disposed)
      throw new Error('The workspace is unavailable. Restart Otto before continuing.');
    const operation = run(signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal);
    pending.add(operation);
    try {
      return await operation;
    } catch (error) {
      if (error instanceof WorkspaceCommandError && error.uncertain) {
        unavailable = true;
        lifecycle.abort();
        await Promise.allSettled([...pending]);
      }
      throw error;
    } finally {
      pending.delete(operation);
    }
  }
  const command = (id: string, args: string[], input: CommandInput = {}) =>
    supervise((signal) => options.runCommand(id, args, { ...input, signal }), input.signal);
  async function helper(id: string, program: string, request: unknown, input: CommandInput) {
    const result = await command(id, ['python3', '-c', program], {
      ...input,
      input: JSON.stringify(request),
    });
    if (result.exitCode) throw new Error('The workspace file operation failed.');
    return result;
  }
  return {
    connectedCliAvailable: Boolean(options.runConnectedCommand),
    status: () => (unavailable ? 'Workspace needs a restart.' : options.status),
    dispose: async () => {
      disposed = true;
      lifecycle.abort();
      await Promise.allSettled([...pending]);
    },
    async writeArtifact(id, path, bytes, signal) {
      threadIdentity(id);
      if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024)
        throw new Error('Files must be between 1 byte and 15 MB.');
      const base = `/workspace/${id}`;
      const target = relative(base, workspaceFile(id, path));
      const temporary = `.otto-upload-${randomUUID()}`;
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += 512 * 1024) {
          const chunk = bytes.subarray(offset, offset + 512 * 1024);
          await helper(
            id,
            artifactWriteProgram,
            {
              base,
              path: target,
              temporary,
              offset,
              data: Buffer.from(chunk).toString('base64'),
              done: offset + chunk.byteLength === bytes.byteLength,
            },
            { maxBytes: 1024, signal },
          );
        }
      } catch (error) {
        await helper(
          id,
          artifactWriteProgram,
          { base, path: target, temporary, remove: true },
          { maxBytes: 1024 },
        ).catch(() => {});
        throw error;
      }
    },
    async readArtifact(id, path, maxBytes) {
      threadIdentity(id);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 15 * 1024 * 1024)
        throw new Error('The artifact size limit is invalid.');
      const base = `/workspace/${id}`;
      const result = await helper(
        id,
        artifactReadProgram,
        { base, path: relative(base, workspaceFile(id, path)), maxBytes },
        { maxBytes },
      );
      return result.stdout;
    },
    open(input) {
      const id = threadIdentity(input.threadId);
      if (resolve(input.workspacePath) !== resolve(options.workspaceRoot, id))
        throw new Error('The task workspace does not match its configured root.');
      const connected = options.runConnectedCommand;
      return {
        path: `/workspace/${id}`,
        instructions: options.instructions,
        async exec(script, { input: stdin, signal, timeoutMs = 600_000, onData } = {}) {
          const result = await command(id, ['bash', '-c', script], {
            input: stdin,
            signal: signal ? AbortSignal.any([signal, input.signal]) : input.signal,
            timeoutMs: Math.max(1000, Math.min(timeoutMs, 3_600_000)),
            onData: onData ?? (() => {}),
          });
          return { exitCode: result.exitCode };
        },
        ...(connected
          ? {
              executeProgram: async (
                program: string,
                args: string[],
                environment: Record<string, string>,
                timeoutSeconds = 30,
              ) => {
                const result = await supervise(
                  (signal) =>
                    connected(id, [program, ...args], {
                      environment,
                      signal,
                      timeoutMs: Math.max(1, Math.min(timeoutSeconds, 3600)) * 1000,
                    }),
                  input.signal,
                );
                return {
                  exitCode: result.exitCode,
                  output: Buffer.concat([result.stdout, result.stderr]).toString('utf8'),
                };
              },
            }
          : {}),
      };
    },
  };
}
