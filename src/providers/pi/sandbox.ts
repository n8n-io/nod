import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, posix } from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { WorkspaceSession } from '../../ports/computer.ts';

const streamBytes = 1024 * 1024;
const helperPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const rawCommand =
  /[|&;<>\n\r`$\\]|^\s*\w+=\S*|(?:^|\s)["']?(?:--(?:json|porcelain|raw|format|pretty|output|outfile|output-file|null|zero)(?:[-=\s"']|$)|-[oO]|-(?:0|z|print0)(?:[\s"']|$))/;
const invocationWrapper =
  /^\s*(?:\S*\/)?(?:npm|pnpm|yarn|bun|npx|bunx|python[\d.]*|uv|poetry|pipenv|pipx|env|command|exec|sudo|doas)(?:\s|$)/;
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function workspacePath(path: string) {
  return process.platform === 'win32' ? path.replace(/^[a-z]:/i, '').replaceAll('\\', '/') : path;
}

async function run(
  workspace: WorkspaceSession,
  script: string,
  options: { input?: string; signal?: AbortSignal } = {},
) {
  const chunks: Buffer[] = [];
  const { exitCode } = await workspace.exec(`export PATH=${quote(helperPath)}\n${script}`, {
    ...options,
    onData: (chunk) => chunks.push(chunk),
  });
  return { exitCode, output: Buffer.concat(chunks) };
}

export async function writeWorkspaceFile(
  workspace: WorkspaceSession,
  path: string,
  bytes: Buffer,
  signal?: AbortSignal,
) {
  const step = 512 * 1024;
  const temporary = posix.join(posix.dirname(path), `.${posix.basename(path)}.${randomUUID()}.tmp`);
  try {
    for (let offset = 0; offset === 0 || offset < bytes.length; offset += step) {
      const { exitCode } = await run(
        workspace,
        `base64 -d ${offset ? '>>' : '>'} ${quote(temporary)}`,
        { input: bytes.subarray(offset, offset + step).toString('base64'), signal },
      );
      if (exitCode) throw new Error(`Could not write ${path}.`);
    }
    const mode = `[ ! -e ${quote(path)} ] || chmod --reference=${quote(path)} ${quote(temporary)} 2>/dev/null`;
    const replace = `[ ! -d ${quote(path)} ] && { ${mode}; mv -f -- ${quote(temporary)} ${quote(path)}; }`;
    if ((await run(workspace, replace, { signal })).exitCode)
      throw new Error(`Could not write ${path}.`);
  } catch (error) {
    await run(workspace, `rm -f -- ${quote(temporary)}`).catch(() => {});
    throw error;
  }
}

function hostOutputs(text: string) {
  const root = tmpdir()
    .replaceAll('\\', '/')
    .split('/')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\\\/]');
  const pattern = new RegExp(
    `${root}[\\\\/](?:pi-(?:bash|codemode)-[a-f0-9]{16}\\.(?:log|txt|png|jpg|gif|webp)|pi-web-pdf[\\\\/][a-z0-9-]{1,100}\\.md)`,
    process.platform === 'win32' ? 'gi' : 'g',
  );
  return text.match(pattern) ?? [];
}

async function readHostOutput(path: string, owned: string[]) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error();
  const file = await open(
    path,
    process.platform === 'win32'
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.ino !== before.ino ||
      info.dev !== before.dev ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error();
    owned.push(path);
    if (info.size > 64 * 1024 * 1024) throw new Error();
    const bytes = Buffer.alloc(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== info.size) throw new Error();
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function moveHostOutputs(texts: string[], workspace: WorkspaceSession, signal?: AbortSignal) {
  const paths = [...new Set(texts.flatMap(hostOutputs))];
  const moved = new Map<string, string>();
  const owned: string[] = [];
  if (!paths.length) return moved;
  try {
    const directory = posix.join(workspace.path, '.nod/outputs');
    for (const path of paths) {
      const bytes = await readHostOutput(path, owned).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (!bytes) continue;
      signal?.throwIfAborted();
      if (!moved.size && (await run(workspace, `mkdir -p -- '${directory}'`, { signal })).exitCode)
        throw new Error();
      const name = basename(path);
      const target = posix.join(
        directory,
        name.startsWith('pi-') ? name : `pdf-${randomUUID().slice(0, 8)}-${name}`,
      );
      await writeWorkspaceFile(workspace, target, bytes, signal);
      moved.set(path, target);
    }
    return moved;
  } catch {
    throw new Error('The full output could not be saved in the workspace.');
  } finally {
    await Promise.all(owned.map((path) => unlink(path).catch(() => {})));
  }
}

export async function workspaceOutputs(
  run: () => Promise<Awaited<ReturnType<ToolDefinition['execute']>>>,
  workspace: WorkspaceSession,
  signal?: AbortSignal,
) {
  let result;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof Error && hostOutputs(error.message).length)
      for (const [from, to] of await moveHostOutputs([error.message], workspace, signal))
        error.message = error.message.replaceAll(from, to);
    throw error;
  }
  const details = result.details as { fullOutputPath?: unknown } | undefined;
  const structured = result.structuredContent as { full_output_path?: unknown } | undefined;
  const moved = await moveHostOutputs(
    [
      ...result.content.flatMap((item) => (item.type === 'text' ? [item.text] : [])),
      ...[details?.fullOutputPath, structured?.full_output_path].filter(
        (path): path is string => typeof path === 'string',
      ),
    ],
    workspace,
    signal,
  );
  if (!moved.size) return result;
  const swap = (text: string) =>
    [...moved].reduce((value, [from, to]) => value.replaceAll(from, to), text);
  return {
    ...result,
    content: result.content.map((item) =>
      item.type === 'text' ? { ...item, text: swap(item.text) } : item,
    ),
    ...(typeof details?.fullOutputPath === 'string'
      ? { details: { ...details, fullOutputPath: swap(details.fullOutputPath) } }
      : {}),
    ...(typeof structured?.full_output_path === 'string'
      ? {
          structuredContent: {
            ...structured,
            full_output_path: swap(structured.full_output_path),
          },
        }
      : {}),
  };
}

export function createSandbox(workspace: WorkspaceSession, timeZone?: string) {
  async function check(script: string) {
    return (await run(workspace, script)).exitCode === 0;
  }
  async function readBytes(path: string) {
    path = workspacePath(path);
    const { exitCode, output } = await run(workspace, `cat -- ${quote(path)}`);
    if (exitCode) throw new Error(`File not found or not readable: ${path}`);
    return output;
  }
  const writeBytes = (path: string, bytes: Buffer) =>
    writeWorkspaceFile(workspace, workspacePath(path), bytes);
  async function bash(
    command: string,
    cwd: string,
    options: { onData(data: Buffer): void; signal?: AbortSignal; timeout?: number },
  ) {
    const seconds = Math.max(1, Math.ceil(options.timeout ?? 3540));
    const file = `${workspace.path}/.nod/outputs/bash-${randomUUID()}.log`;
    const diagnostics = `${file}.timeout`;
    const marker = `\nnod-timeout-${randomUUID()}`;
    const script = [
      'nod_path=${nod_workspace_path-$PATH}',
      `export PATH=${quote(helperPath)}`,
      `cd -- ${quote(cwd)} || exit 1`,
      `mkdir -p ${quote(posix.dirname(file))}`,
      ...(timeZone ? [`export TZ=${quote(timeZone)}`] : []),
      'export RTK_TELEMETRY_DISABLED=1',
      `nod_command=${quote(command)}`,
      ...(!rawCommand.test(command) && !/^\s*(?:git\s+log\s*$|find(?:\s|$))/.test(command)
        ? [
            'nod_rewrite=$(timeout -k 1 2 /usr/local/bin/rtk rewrite "$nod_command" 2>/dev/null)',
            'nod_rewrite_code=$?',
            `if { [ "$nod_rewrite_code" -eq 0 ] || [ "$nod_rewrite_code" -eq 3 ]; } && [ -n "$nod_rewrite" ]${invocationWrapper.test(command) ? ' && [ "$nod_rewrite" = "rtk $nod_command" ]' : ''}; then case "$nod_rewrite" in "rtk "*) nod_command="/usr/local/bin/$nod_rewrite";; esac; fi`,
          ]
        : []),
      `timeout --verbose -k 5 ${seconds} /bin/bash --noprofile --norc -p -c ${quote('PATH="$1"; export PATH; exec /bin/bash -c "$2" 2>&1')} bash "$nod_path" "$nod_command" > ${quote(file)} 2> ${quote(diagnostics)} < /dev/null`,
      'code=$?',
      'timed_out=0',
      `if { [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; } && [ -s ${quote(diagnostics)} ]; then timed_out=1; fi`,
      `cat -- ${quote(diagnostics)} >> ${quote(file)}; rm -f -- ${quote(diagnostics)}`,
      `size=$(($(wc -c < ${quote(file)})))`,
      `if [ "$size" -gt ${streamBytes} ]; then`,
      `  head -c ${streamBytes / 2} ${quote(file)}`,
      `  printf '\\n\\n[... %s bytes omitted ...]\\n\\n' $((size - ${streamBytes}))`,
      `  tail -c ${streamBytes / 2} ${quote(file)}`,
      `  printf '\\n\\n[Complete output (%s bytes): %s]\\n' "$size" ${quote(file)}`,
      `else cat -- ${quote(file)}; rm -f -- ${quote(file)}; fi`,
      `if [ "$timed_out" -eq 1 ]; then printf %s ${quote(marker)}; fi`,
      'exit $code',
    ].join('\n');
    const chunks: Buffer[] = [];
    const { exitCode } = await workspace.exec(script, {
      signal: options.signal,
      timeoutMs: (seconds + 30) * 1000,
      onData: (chunk) => chunks.push(chunk),
      notices: true,
    });
    const output = Buffer.concat(chunks);
    const timedOut = output.toString('latin1').endsWith(marker);
    const text = timedOut ? output.subarray(0, output.length - Buffer.byteLength(marker)) : output;
    if (text.length) options.onData(text);
    if (timedOut) throw new Error(`timeout:${seconds}`);
    return { exitCode };
  }
  const cwd = workspace.path;
  const tools = [
    createReadToolDefinition(cwd, {
      operations: {
        readFile: readBytes,
        access: async () => {},
        detectImageMimeType: async (path) => imageTypes[posix.extname(path).toLowerCase()] ?? null,
      },
    }),
    createBashToolDefinition(cwd, {
      operations: { exec: bash },
      exposeSessionEnvironment: false,
      spawnHook: (context) => ({ ...context, env: {} }),
    }),
    createEditToolDefinition(cwd, {
      operations: {
        readFile: readBytes,
        writeFile: (path, content) => writeBytes(path, Buffer.from(content, 'utf8')),
        access: async () => {},
      },
    }),
    createWriteToolDefinition(cwd, {
      operations: {
        writeFile: (path, content) => writeBytes(path, Buffer.from(content, 'utf8')),
        mkdir: async (dir) => {
          dir = workspacePath(dir);
          if (!(await check(`mkdir -p -- ${quote(dir)}`)))
            throw new Error(`Could not create ${dir}.`);
        },
      },
    }),
  ] as ToolDefinition[];
  return tools.map((definition): ToolDefinition => ({
    ...definition,
    ...(definition.name === 'bash'
      ? {
          description: `${definition.description}\nSimple commands run through RTK for compact output; use rtk proxy <command> for raw output.`,
        }
      : {}),
    execute: async (id, params, signal, onUpdate, context) => {
      const result = await workspaceOutputs(
        () => definition.execute(id, params, signal, onUpdate, { ...context, cwd }),
        workspace,
        signal,
      );
      if (definition.name === 'write' && !result.isError)
        result.content.push({
          type: 'text',
          text: "This file is private in the workspace. Call share_file to attach it before you claim delivery. A workspace path does not open on the user's device.",
        });
      return result;
    },
  }));
}
