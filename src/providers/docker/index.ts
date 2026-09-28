import { relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Workspace } from '../../ports/computer.ts';
import { WorkspaceExitError } from '../../ports/computer.ts';
import { taskId } from '../../ports/task-identity.ts';
import {
  runWorkspaceCommand,
  WorkspaceCommandError,
  type WorkspaceCommandLauncher,
} from './command.ts';

export function workspaceFile(id: string, path: string): string {
  const base = `/workspace/${taskId(id)}`;
  if (!path || path.includes('\0') || path.includes('\\'))
    throw new Error('A workspace file path is required.');
  const full = resolve(base, path);
  if (full !== base && !full.startsWith(base + '/'))
    throw new Error('Files must stay within the task workspace.');
  return full;
}

const fileProgram = `import os,sys,json\nr=json.load(sys.stdin)\nbase=os.path.realpath(r['base'])\np=os.path.realpath(r['path'])\nif os.path.commonpath([base,p])!=base: raise ValueError('Path outside workspace')\nif r['action']=='read':\n with open(p,'rb') as f: data=f.read(65537)\n if len(data)>65536: raise ValueError('File too large; use bounded shell commands')\n sys.stdout.write(data.decode('utf-8'))\nelse:\n os.makedirs(os.path.dirname(p),exist_ok=True)\n with open(p,'w',encoding='utf-8') as f: f.write(r['content'])\n print('File saved')`;

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
      'This is your own Linux computer, not the user’s personal device. It uses normal Docker networking with no Otto egress firewall. Internet and other reachable destinations follow the host and Docker network configuration. Node, Python, pipx, git, curl, and ffmpeg are installed. Install trusted CLI tools with npm install -g <package> or pipx install <package>; /home/node persists across tasks and restarts. You are an unprivileged user and cannot use sudo. There is no graphical desktop or display, so native GUI applications cannot run here; use a supported CLI or the browser web app. Keep task outputs under this task workspace; do not ask the user to install your tools on their device.',
    runCommand: (id, args, input) =>
      runWorkspaceCommand({
        container: options.container,
        taskId: id,
        args,
        ...input,
        spawn: options.spawn,
      }),
    runConnectedCommand: (id, args, input) =>
      runWorkspaceCommand({
        container: options.container,
        taskId: id,
        args,
        ...input,
        connected: true,
        spawn: options.spawn,
      }),
  });
}

export function createCommandWorkspace(options: {
  workspaceRoot: string;
  status: string;
  instructions: string;
  runCommand(
    id: string,
    args: string[],
    input: {
      input?: string;
      environment?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }>;
  runConnectedCommand?(
    id: string,
    args: string[],
    input: {
      environment: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<{ stdout: Buffer; stderr: Buffer; exitCode: number }>;
}): Workspace {
  let unavailable = false;
  let disposed = false;
  const lifecycle = new AbortController();
  const pending = new Set<Promise<unknown>>();
  async function command(
    id: string,
    args: string[],
    input: {
      input?: string;
      environment?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
      maxBytes?: number;
    } = {},
  ) {
    if (unavailable || disposed)
      throw new Error('The workspace is unavailable. Restart Otto before continuing.');
    const operation = options.runCommand(id, args, {
      ...input,
      signal: input.signal ? AbortSignal.any([input.signal, lifecycle.signal]) : lifecycle.signal,
    });
    pending.add(operation);
    try {
      const result = await operation;
      if (result.exitCode)
        throw new WorkspaceExitError(
          result.exitCode,
          Buffer.concat([result.stdout, result.stderr]).toString('utf8'),
        );
      return result;
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
  async function textCommand(
    id: string,
    args: string[],
    input: {
      input?: string;
      environment?: Record<string, string>;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ) {
    const result = await command(id, args, input);
    return Buffer.concat([result.stdout, result.stderr]).toString('utf8');
  }
  async function connectedCommand(
    id: string,
    args: string[],
    environment: Record<string, string>,
    signal: AbortSignal,
    timeoutMs: number,
  ) {
    if (!options.runConnectedCommand) throw new Error('Connected CLI commands are unavailable.');
    if (unavailable || disposed)
      throw new Error('The workspace is unavailable. Restart Otto before continuing.');
    const operation = options.runConnectedCommand(id, args, {
      environment,
      signal: AbortSignal.any([signal, lifecycle.signal]),
      timeoutMs,
    });
    pending.add(operation);
    try {
      const result = await operation;
      return {
        exitCode: result.exitCode,
        output: Buffer.concat([result.stdout, result.stderr]).toString('utf8'),
      };
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
  return {
    connectedCliAvailable: Boolean(options.runConnectedCommand),
    status: () => (unavailable ? 'Workspace needs a restart.' : options.status),
    dispose: async () => {
      disposed = true;
      lifecycle.abort();
      await Promise.allSettled([...pending]);
    },
    async writeArtifact(id, path, bytes, signal) {
      taskId(id);
      if (!bytes.byteLength || bytes.byteLength > 15 * 1024 * 1024)
        throw new Error('Files must be between 1 byte and 15 MB.');
      const base = `/workspace/${id}`;
      const target = relative(base, workspaceFile(id, path));
      const temporary = `.otto-upload-${randomUUID()}`;
      try {
        for (let offset = 0; offset < bytes.byteLength; offset += 512 * 1024) {
          const chunk = bytes.subarray(offset, offset + 512 * 1024);
          await command(id, ['python3', '-c', artifactWriteProgram], {
            input: JSON.stringify({
              base,
              path: target,
              temporary,
              offset,
              data: Buffer.from(chunk).toString('base64'),
              done: offset + chunk.byteLength === bytes.byteLength,
            }),
            maxBytes: 1024,
            signal,
          });
        }
      } catch (error) {
        await command(id, ['python3', '-c', artifactWriteProgram], {
          input: JSON.stringify({ base, path: target, temporary, remove: true }),
          maxBytes: 1024,
        }).catch(() => {});
        throw error;
      }
    },
    async readArtifact(id, path, maxBytes) {
      taskId(id);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 15 * 1024 * 1024)
        throw new Error('The artifact size limit is invalid.');
      const base = `/workspace/${id}`;
      const result = await command(id, ['python3', '-c', artifactReadProgram], {
        input: JSON.stringify({ base, path: relative(base, workspaceFile(id, path)), maxBytes }),
        maxBytes,
      });
      return result.stdout;
    },
    open(input) {
      const id = taskId(input.taskId);
      if (resolve(input.workspacePath) !== resolve(options.workspaceRoot, id))
        throw new Error('The task workspace does not match its configured root.');
      const base = `/workspace/${id}`;
      const file = (action: 'read' | 'write', path: string, content?: string) =>
        textCommand(id, ['python3', '-c', fileProgram], {
          input: JSON.stringify({ action, base, path: workspaceFile(id, path), content }),
          signal: input.signal,
        });
      return {
        path: base,
        instructions: options.instructions,
        execute: (command, timeoutSeconds = 30) =>
          textCommand(id, ['sh', '-c', command], {
            signal: input.signal,
            timeoutMs: Math.max(1, Math.min(timeoutSeconds, 120)) * 1000,
          }),
        ...(options.runConnectedCommand
          ? {
              executeProgram: async (
                program: string,
                args: string[],
                environment: Record<string, string>,
                timeoutSeconds = 30,
              ) => {
                return connectedCommand(
                  id,
                  [program, ...args],
                  environment,
                  input.signal,
                  Math.max(1, Math.min(timeoutSeconds, 120)) * 1000,
                );
              },
            }
          : {}),
        readFile: (path) => file('read', path),
        writeFile: async (path, content) => {
          if (Buffer.byteLength(content) > 256 * 1024)
            throw new Error('File content exceeds 256 KB.');
          return file('write', path, content);
        },
      };
    },
  };
}
