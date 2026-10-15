import { posix, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectedCli, Workspace } from '../../ports/computer.ts';
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
  const full = posix.resolve(base, path);
  if (full !== base && !full.startsWith(base + '/'))
    throw new Error('Files must stay within the task workspace.');
  return full;
}

const artifactChunk = 8 * 1024 * 1024;

export const artifactReadProgram = `import os,sys,json,stat
r=json.load(sys.stdin)
fds=[]
try:
 limit=int(r['maxBytes'])
 offset=int(r['offset'])
 if limit<1 or offset<0: raise ValueError()
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
 if not stat.S_ISREG(info.st_mode) or info.st_size>limit or offset>info.st_size: raise ValueError()
 identity='%d:%d:%d:%d:%d'%(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
 if r.get('identity') not in (None,identity): raise ValueError()
 want=min(${artifactChunk},info.st_size-offset)
 data=bytearray()
 while len(data)<want:
  chunk=os.pread(fd,want-len(data),offset+len(data))
  if not chunk: raise ValueError()
  data.extend(chunk)
 sys.stdout.buffer.write(identity.encode()+b'\\n'+data)
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
  if offset<0 or len(data)>524288: raise ValueError()
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
    instructions:
      'Your Linux workspace uses Docker networking without an Otto egress firewall. Node, Python (with pdfplumber and pillow_heif), pipx, git, curl, ripgrep, jq, ffmpeg, yt-dlp, poppler-utils, qpdf, Ghostscript and Tesseract OCR are installed. Python also has pypdf, openpyxl, python-docx and python-pptx, and LibreOffice (soffice) converts office files. Install trusted Python libraries with pip install <package>, trusted CLIs with npm install -g <package> or pipx install <package>; /home/node persists across tasks and restarts. A connected app CLI never runs from here: Otto installs its own copy from the source you propose. You run as an unprivileged user without sudo or a graphical display; use a CLI or browser web app. Keep outputs in this workspace and install tools here, not on the user’s device.',
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
  session?: boolean;
};
type CommandResult = { stdout: Buffer; stderr: Buffer; exitCode: number };

export function createCommandWorkspace(options: {
  workspaceRoot: string;
  instructions: string;
  runCommand(id: string, args: string[], input: CommandInput): Promise<CommandResult>;
  runConnectedCommand?(
    id: string,
    args: string[],
    input: CommandInput & { environment: Record<string, string>; cli: ConnectedCli },
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
    dispose: async () => {
      disposed = true;
      lifecycle.abort();
      await Promise.allSettled([...pending]);
    },
    async writeArtifact(id, path, bytes, signal) {
      threadIdentity(id);
      if (!bytes.byteLength) throw new Error('A file needs at least one byte.');
      const base = `/workspace/${id}`;
      const target = posix.relative(base, workspaceFile(id, path));
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
      if (!Number.isInteger(maxBytes) || maxBytes < 1)
        throw new Error('The artifact size limit is invalid.');
      const base = `/workspace/${id}`;
      const target = posix.relative(base, workspaceFile(id, path));
      const chunks: Buffer[] = [];
      let identity: string | undefined;
      let offset = 0;
      let size = 0;
      do {
        const { stdout } = await helper(
          id,
          artifactReadProgram,
          { base, path: target, maxBytes, offset, identity },
          { maxBytes: artifactChunk + 1024 },
        );
        const line = stdout.indexOf(10);
        const header = stdout.subarray(0, Math.max(line, 0)).toString();
        if (line < 0 || (identity !== undefined && header !== identity))
          throw new Error('The workspace file changed while it was read.');
        identity = header;
        size = Number(header.split(':')[2]);
        const data = stdout.subarray(line + 1);
        if (!data.byteLength && offset < size)
          throw new Error('The workspace file operation failed.');
        chunks.push(data);
        offset += data.byteLength;
      } while (offset < size);
      if (offset !== size) throw new Error('The workspace file operation failed.');
      return Buffer.concat(chunks, offset);
    },
    open(input) {
      const id = threadIdentity(input.threadId);
      if (resolve(input.workspacePath) !== resolve(options.workspaceRoot, id))
        throw new Error('The task workspace does not match its configured root.');
      const connected = options.runConnectedCommand;
      return {
        path: `/workspace/${id}`,
        instructions: options.instructions,
        async exec(script, { input: stdin, signal, timeoutMs = 600_000, onData, notices } = {}) {
          const result = await command(id, ['bash', '-c', script], {
            input: stdin,
            signal: signal ? AbortSignal.any([signal, input.signal]) : input.signal,
            timeoutMs: Math.max(1000, timeoutMs),
            onData: onData ?? (() => {}),
            session: notices,
          });
          return { exitCode: result.exitCode };
        },
        ...(connected
          ? {
              runConnectedCli: async (
                cli: ConnectedCli,
                args: string[],
                environment: Record<string, string>,
                timeoutSeconds = 3540,
              ) => {
                const result = await supervise(
                  (signal) =>
                    connected(id, args, {
                      cli,
                      environment,
                      signal,
                      timeoutMs: Math.max(1, timeoutSeconds) * 1000,
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
