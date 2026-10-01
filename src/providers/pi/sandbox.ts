import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  truncateTail,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import type { WorkspaceSession } from '../../ports/computer.ts';

const outputBytes = 40_000;
const outputLines = 1_800;
const imageTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const listProgram =
  "import os,sys\nfor e in os.scandir(sys.argv[1]): sys.stdout.write(e.name+'\\0'+('d' if e.is_dir() else 'f')+'\\0')";

function quote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function createSandbox(workspace: WorkspaceSession, timeZone?: string) {
  async function run(script: string, options: { input?: string; signal?: AbortSignal } = {}) {
    const chunks: Buffer[] = [];
    const { exitCode } = await workspace.exec(script, {
      ...options,
      onData: (chunk) => chunks.push(chunk),
    });
    return { exitCode, output: Buffer.concat(chunks) };
  }
  async function check(script: string) {
    return (await run(script)).exitCode === 0;
  }
  async function readBytes(path: string) {
    const { exitCode, output } = await run(`cat -- ${quote(path)}`);
    if (exitCode) throw new Error(`File not found or not readable: ${path}`);
    return output;
  }
  async function writeBytes(path: string, bytes: Buffer) {
    const step = 512 * 1024;
    const temporary = posix.join(
      posix.dirname(path),
      `.${posix.basename(path)}.${randomUUID()}.tmp`,
    );
    try {
      for (let offset = 0; offset === 0 || offset < bytes.length; offset += step) {
        const { exitCode } = await run(`base64 -d ${offset ? '>>' : '>'} ${quote(temporary)}`, {
          input: bytes.subarray(offset, offset + step).toString('base64'),
        });
        if (exitCode) throw new Error(`Could not write ${path}.`);
      }
      const mode = `[ ! -e ${quote(path)} ] || chmod --reference=${quote(path)} ${quote(temporary)} 2>/dev/null`;
      if (!(await check(`${mode}; mv -f -- ${quote(temporary)} ${quote(path)}`)))
        throw new Error(`Could not write ${path}.`);
    } catch (error) {
      await run(`rm -f -- ${quote(temporary)}`).catch(() => {});
      throw error;
    }
  }
  const directories = new Map<string, boolean>();
  async function bash(
    command: string,
    cwd: string,
    options: { onData(data: Buffer): void; signal?: AbortSignal; timeout?: number },
  ) {
    const seconds = Math.max(1, Math.min(Math.ceil(options.timeout ?? 600), 3600));
    const file = `${workspace.path}/.otto/outputs/bash-${randomUUID()}.log`;
    const marker = `\notto-timeout-${randomUUID()}`;
    const script = [
      `cd -- ${quote(cwd)} || exit 1`,
      `mkdir -p ${quote(posix.dirname(file))}`,
      ...(timeZone ? [`export TZ=${quote(timeZone)}`] : []),
      'start=$(date +%s)',
      `timeout -k 5 ${seconds} bash -c ${quote(command)} > ${quote(file)} 2>&1 < /dev/null`,
      'code=$?',
      `size=$(wc -c < ${quote(file)}); lines=$(wc -l < ${quote(file)})`,
      `if [ "$size" -gt ${outputBytes} ] || [ "$lines" -gt ${outputLines} ]; then`,
      `  tail -n ${outputLines} ${quote(file)} | tail -c ${outputBytes}`,
      `  printf '\\n\\n[Output truncated: %s bytes, %s lines in total. Full output: %s]\\n' "$size" "$lines" ${quote(file)}`,
      `else cat -- ${quote(file)}; rm -f -- ${quote(file)}; fi`,
      `if [ "$code" -eq 124 ] && [ $(($(date +%s) - start)) -ge ${seconds} ]; then printf %s ${quote(marker)}; fi`,
      'exit $code',
    ].join('\n');
    const chunks: Buffer[] = [];
    const { exitCode } = await workspace.exec(script, {
      signal: options.signal,
      timeoutMs: (seconds + 30) * 1000,
      onData: (chunk) => chunks.push(chunk),
    });
    const output = Buffer.concat(chunks).toString('utf8');
    const timedOut = output.endsWith(marker);
    const text = truncateTail(timedOut ? output.slice(0, -marker.length) : output, {
      maxBytes: outputBytes + 5_000,
      maxLines: outputLines + 100,
    }).content;
    if (text) options.onData(Buffer.from(text));
    if (timedOut) throw new Error(`timeout:${seconds}`);
    if (exitCode) throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);
    return { exitCode };
  }
  const glob = async (
    pattern: string,
    root: string,
    options: { ignore: string[]; limit: number },
  ) => {
    const program = [
      'import os,sys,fnmatch,json',
      'root,pattern,limit=sys.argv[1],sys.argv[2],int(sys.argv[3])',
      "patterns=[pattern] if '/' in pattern else ['**/'+pattern]",
      "patterns+=[p.replace('**/','') for p in patterns]",
      'ignore=json.loads(sys.argv[4])',
      "ignore+=[p.replace('**/','') for p in ignore]",
      'at=lambda base,name: os.path.relpath(os.path.join(base,name),root)',
      'skip=lambda path: any(fnmatch.fnmatchcase(path,p) for p in ignore)',
      'found=0',
      'for base,dirs,files in os.walk(root):',
      " dirs[:]=[d for d in dirs if not skip(at(base,d)+'/')]",
      ' for name in dirs+[f for f in files if not skip(at(base,f))]:',
      '  rel=at(base,name)',
      '  if any(fnmatch.fnmatchcase(rel,p) for p in patterns):',
      "   sys.stdout.write(rel+('/' if name in dirs else '')+'\\0'); found+=1",
      '   if found>=limit: sys.exit(0)',
    ].join('\n');
    const { exitCode, output } = await run(
      `python3 -c ${quote(program)} ${quote(root)} ${quote(pattern)} ${options.limit} ${quote(JSON.stringify(options.ignore))}`,
    );
    if (exitCode) throw new Error(`Could not search ${root}.`);
    return output.toString('utf8').split('\0').filter(Boolean);
  };
  const cwd = workspace.path;
  return [
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
          if (!(await check(`mkdir -p -- ${quote(dir)}`)))
            throw new Error(`Could not create ${dir}.`);
        },
      },
    }),
    createFindToolDefinition(cwd, {
      operations: { exists: (path) => check(`[ -e ${quote(path)} ]`), glob },
    }),
    createLsToolDefinition(cwd, {
      operations: {
        exists: (path) => check(`[ -e ${quote(path)} ]`),
        stat: async (path) => {
          const directory = directories.get(path) ?? (await check(`[ -d ${quote(path)} ]`));
          directories.delete(path);
          return { isDirectory: () => directory };
        },
        readdir: async (path) => {
          const { exitCode, output } = await run(`python3 -c ${quote(listProgram)} ${quote(path)}`);
          if (exitCode) throw new Error(`Cannot read directory: ${path}`);
          const parts = output.toString('utf8').split('\0');
          const names: string[] = [];
          for (let index = 0; index + 1 < parts.length; index += 2) {
            names.push(parts[index]);
            directories.set(posix.join(path, parts[index]), parts[index + 1] === 'd');
          }
          return names;
        },
      },
    }),
  ] as ToolDefinition[];
}
