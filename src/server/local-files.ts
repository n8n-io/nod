import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import nodePath from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { IntegrationFile } from '../ports/integrations.ts';
import type { Trash } from '../ports/trash.ts';
import { fileBytes, fileMimeType } from '../shared/files.ts';
import { workspaceFileReference } from './integration-files.ts';
import { IntegrationError } from './integration-connection.ts';
import { addKeepOut, removeKeepOut } from './keep-out.ts';
import { assertStartedByOwner as startedByOwner } from './owner-started.ts';

const readBytes = 256 * 1024;
const writeBytes = 1024 * 1024;
const listLimit = 500;
const batchLimit = 200;
const statBatch = 100;
const noFollow = constants.O_NOFOLLOW ?? 0;
const noBlock = constants.O_NONBLOCK ?? 0;
const homePrefix = process.platform === 'win32' ? /^~(?=$|[/\\])/ : /^~(?=$|\/)/;
function absolutePath(home: string) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.replace(homePrefix, () => home) : value),
    z
      .string()
      .min(1)
      .max(4096)
      .refine(
        (value) =>
          nodePath.isAbsolute(value) &&
          (process.platform !== 'win32' || !value.slice(2).includes(':')),
        'Use an absolute path.',
      ),
  );
}
function localFileSchemas(absolute: ReturnType<typeof absolutePath>) {
  const onePath = z.object({ path: absolute }).strict();
  const observation = onePath.extend({
    version: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  });
  return {
    LOCAL_FILES_LIST: onePath,
    LOCAL_FILES_READ: observation,
    LOCAL_FILES_IMPORT: observation,
    LOCAL_FILES_CREATE_FOLDER: onePath,
    LOCAL_FILES_MOVE: z
      .object({
        moves: z
          .array(z.object({ from: absolute, to: absolute }).strict())
          .min(1)
          .max(batchLimit),
      })
      .strict(),
    LOCAL_FILES_TRASH: z.object({ paths: z.array(absolute).min(1).max(batchLimit) }).strict(),
    LOCAL_FILES_WRITE: z
      .object({
        path: absolute,
        text: z.string().max(writeBytes),
        overwrite: z.boolean().optional(),
      })
      .strict(),
    LOCAL_FILES_EDIT: z
      .object({
        path: absolute,
        edits: z
          .array(z.object({ oldText: z.string().min(1), newText: z.string() }).strict())
          .min(1)
          .max(50),
      })
      .strict(),
    LOCAL_FILES_EXPORT: z
      .object({ file: workspaceFileReference, path: absolute, overwrite: z.boolean().optional() })
      .strict(),
  };
}
type Action = keyof ReturnType<typeof localFileSchemas>;
const actions = new Set(Object.keys(localFileSchemas(absolutePath(homedir()))));
const reads = new Set<Action>(['LOCAL_FILES_LIST', 'LOCAL_FILES_READ', 'LOCAL_FILES_IMPORT']);
const windowsHidden = new Set([
  'desktop.ini',
  'thumbs.db',
  '$recycle.bin',
  'system volume information',
]);
const privateFolders = new Set(['library', 'appdata', 'backups.backupdb']);
const secretNames = [
  /\.(pem|p12|pfx|ppk|kdbx|kdb|keychain|keychain-db|ovpn|gpg|asc|tfstate|1pux|1pif|env)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^wallet\.dat$/i,
  /^ntuser\.dat/i,
  /credentials.*\.csv$/i,
  /^service-account.*\.json$/i,
  /^bitwarden_export/i,
];
const programs: Partial<Record<NodeJS.Platform, RegExp>> = {
  win32:
    /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|msc|msix|msixbundle|appx|appxbundle|appinstaller|application|lnk|pif|scr|cpl|hta|reg|dll|xll|inf|sct|url|appref-ms|jar|chm|scf|iso|img|vhd|vhdx|library-ms|searchconnector-ms|settingcontent-ms)$/i,
  darwin:
    /\.(command|tool|terminal|app|pkg|mpkg|dmg|mobileconfig|workflow|scpt|scptd|applescript|sh|bash|zsh|jar|webloc|inetloc|fileloc)$/i,
  linux: /\.(sh|bash|desktop|run|appimage|jar|flatpak|flatpakref|flatpakrepo)$/i,
};
const run = promisify(execFile);
const maybeLstat = (path: string) => lstat(path).catch(() => undefined);
const fileVersion = (info: BigIntStats) =>
  createHash('sha256')
    .update([info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'))
    .digest('hex');
const changedRead = (path: string, reason?: unknown) =>
  Object.assign(
    new IntegrationError(
      `${path} changed after this file read was checked.${reason === undefined ? '' : ` ${reason instanceof Error ? reason.message : String(reason)}`}`,
      409,
    ),
    { notRun: true },
  );
const keepOutLimit = 100;

async function removeCopied(source: string, copy: string) {
  for (const name of await readdir(copy)) {
    const copied = nodePath.join(copy, name);
    if ((await lstat(copied)).isDirectory())
      await removeCopied(nodePath.join(source, name), copied);
    else await rm(nodePath.join(source, name));
  }
  await rmdir(source);
}

type Turn = { turnId: string; threadId: string };
type Query = Pick<Pool, 'query'>;
export type WorkspaceRead = (input: z.infer<typeof workspaceFileReference>) => Promise<Uint8Array>;

function denied(error: unknown) {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EACCES';
}

function permissionMessage(path: string) {
  return process.platform === 'darwin'
    ? `Nod can't open ${path}. Allow Nod in System Settings, Privacy & Security, Files and Folders (or Full Disk Access), then try again.`
    : `Nod can't open ${path}.`;
}

export function isLocalFilesAction(action: string): action is Action {
  return actions.has(action);
}

export function localFileRules(
  platform: NodeJS.Platform,
  home: string,
  dataRoot: string,
  systemDrive = 'C:',
) {
  const path = platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const key = (value: string) => (platform === 'win32' ? value.toLowerCase() : value);
  const fold = (value: string) => (platform === 'linux' ? value : value.toLowerCase());
  function inside(root: string, target: string) {
    const rel = path.relative(fold(root), fold(target));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  function privateName(name: string) {
    const lower = name.toLowerCase();
    return (
      name.startsWith('.') ||
      (platform === 'win32' && windowsHidden.has(lower)) ||
      privateFolders.has(lower) ||
      secretNames.some((pattern) => pattern.test(name))
    );
  }
  function anchor(target: string) {
    if (inside(home, target)) return home;
    if (platform === 'darwin' && fold(target) !== '/volumes' && inside('/Volumes', target))
      return path.join('/Volumes', target.split(path.sep)[2]!);
    if (
      platform === 'win32' &&
      /^[a-z]:\\/i.test(target) &&
      key(target.slice(0, 2)) !== key(systemDrive)
    )
      return target.slice(0, 3);
    if (platform === 'linux')
      for (const mounts of ['/media', '/run/media']) {
        const [user, drive] = path.relative(mounts, target).split(path.sep);
        if (inside(mounts, target) && user && drive) return path.join(mounts, user, drive);
      }
  }
  return {
    inside,
    same: (left: string, right: string) => key(left) === key(right),
    privateName,
    anchor,
    holdsData: (target: string) => inside(target, dataRoot),
    root: (target: string) => {
      const base = anchor(target);
      return base !== undefined && inside(target, base);
    },
    privatePath(target: string) {
      const base = anchor(target);
      return (
        !base ||
        inside(dataRoot, target) ||
        path.relative(fold(base), fold(target)).split(path.sep).filter(Boolean).some(privateName)
      );
    },
    program: (name: string) => programs[platform]?.test(name) ?? false,
    executable: (name: string, mode: number) =>
      (programs[platform]?.test(name) ?? false) || (platform !== 'win32' && (mode & 0o111) !== 0),
  };
}

export function createLocalFiles(
  pool: Pool,
  ownerId: string,
  options: { dataRoot: string; home?: string; trash?: Trash; available?: boolean },
) {
  const available = options.available ?? true;
  const home = options.home ?? homedir();
  const absolute = absolutePath(home);
  const schemas = localFileSchemas(absolute);
  const rules = Promise.all([
    realpath(home).catch(() => home),
    realpath(options.dataRoot).catch(() => options.dataRoot),
  ]).then(([realHome, realData]) =>
    localFileRules(process.platform, realHome, realData, process.env.SystemDrive),
  );

  async function keptOut(database: Query = pool): Promise<string[]> {
    const { rows } = await database.query<{ local_keep_out: string[] }>(
      'SELECT local_keep_out FROM preferences WHERE owner_id=$1',
      [ownerId],
    );
    return rows[0]?.local_keep_out ?? [];
  }

  async function enabled() {
    if (!available) return false;
    const { rows } = await pool.query<{ local_files_enabled: boolean }>(
      'SELECT local_files_enabled FROM preferences WHERE owner_id=$1',
      [ownerId],
    );
    return rows[0]?.local_files_enabled === true;
  }

  async function assertEnabled() {
    if (!available) throw unavailable();
    if (!(await enabled()))
      throw new IntegrationError(
        'Local file access is off. Request localFilesEnabled: true with notification_preferences_update to ask the owner to turn it on in chat.',
        403,
      );
  }

  async function assertStartedByOwner(turn: Turn | undefined, database: Query = pool) {
    await startedByOwner(
      database,
      ownerId,
      turn,
      "Local files only open in work the owner started: a message, or a schedule the owner set up. Nod didn't touch any file.",
    );
  }

  async function resolvedAsFarAsItExists(path: string) {
    const missing: string[] = [];
    for (let current = path; ; current = nodePath.dirname(current)) {
      const real = await realpath(current).catch(() => undefined);
      if (real) return nodePath.join(real, ...missing.reverse());
      if (nodePath.dirname(current) === current) return path;
      missing.push(nodePath.basename(current));
    }
  }

  async function keepOut(turn: Turn, path: string, database: Query) {
    if (!available) throw unavailable();
    await assertStartedByOwner(turn, database);
    const input = absolute.safeParse(typeof path === 'string' ? path.trim() : path);
    if (!input.success) throw new IntegrationError('Name the absolute path to keep Nod out of.');
    const real = await resolvedAsFarAsItExists(nodePath.resolve(input.data));
    return addKeepOut(database, ownerId, 'local_keep_out', real, keepOutLimit, 'folders');
  }

  function letIn(path: string) {
    return removeKeepOut(pool, ownerId, 'local_keep_out', path);
  }

  function unavailable() {
    return new IntegrationError('Local files work only in the Nod desktop app.', 503);
  }

  function outside(path: string) {
    return new IntegrationError(
      `${path} is outside your home folder and drives, private (hidden, a secret or Nod's own data), or the root of a drive.`,
      403,
    );
  }

  function kept(path: string) {
    return new IntegrationError(
      `The owner told Nod to keep out of ${path}. Nothing was changed.`,
      403,
    );
  }

  async function contained(
    real: string,
    keep: string[],
    allowRoot: boolean,
    shown: string,
    write: boolean,
  ) {
    const rule = await rules;
    if (
      rule.privatePath(real) ||
      (!allowRoot && rule.root(real)) ||
      (write && rule.holdsData(real))
    )
      throw outside(shown);
    if (keep.some((entry) => rule.inside(entry, real) || (write && rule.inside(real, entry))))
      throw kept(shown);
    return real;
  }

  async function existing(
    path: string,
    keep: string[],
    allowRoot: boolean,
    write: boolean,
    shown = path,
  ) {
    const lexical = nodePath.resolve(path);
    const rule = await rules;
    if (rule.privatePath(lexical)) throw outside(shown);
    if (keep.some((entry) => rule.inside(entry, lexical))) throw kept(shown);
    try {
      return await contained(await realpath(path), keep, allowRoot, shown, write);
    } catch (error) {
      if (error instanceof IntegrationError) throw error;
      if (denied(error)) throw new IntegrationError(permissionMessage(path), 403);
      throw new IntegrationError(`${path} does not exist.`, 404);
    }
  }

  async function entry(path: string, keep: string[]) {
    const parent = await existing(
      nodePath.dirname(nodePath.resolve(path)),
      keep,
      true,
      false,
      path,
    );
    const name = nodePath.basename(nodePath.resolve(path));
    if (
      process.platform === 'win32' &&
      (await maybeLstat(nodePath.join(parent, name))) &&
      !(await readdir(parent)).some((listed) => listed.toLowerCase() === name.toLowerCase())
    )
      throw outside(path);
    return contained(nodePath.join(parent, name), keep, false, path, true);
  }

  function resolver(action: Action, keep: string[]) {
    if (action === 'LOCAL_FILES_LIST') return (path: string) => existing(path, keep, true, false);
    if (reads.has(action)) return (path: string) => existing(path, keep, false, false);
    return (path: string) => entry(path, keep);
  }

  async function present(path: string, keep: string[]) {
    const source = await entry(path, keep);
    if (!(await maybeLstat(source))) throw new IntegrationError(`${path} does not exist.`, 404);
    return source;
  }

  async function unchanged(target: string, keep: string[]) {
    if (!(await rules).same(await entry(target, keep), target))
      throw new IntegrationError(`The folder of ${target} changed. Nothing was changed.`, 409);
  }

  async function trashReady() {
    if (!(await options.trash?.ready()))
      throw new IntegrationError(
        "This computer has no Trash Nod can use, so it didn't trash, replace or edit anything.",
        503,
      );
  }

  async function toTrash(source: string, signal?: AbortSignal) {
    await trashReady();
    await options.trash!.put(source, signal);
  }

  function taken(target: string) {
    return new IntegrationError(`${target} already exists.`, 409);
  }

  async function place(source: string, target: string, keep: string[]) {
    await unchanged(target, keep);
    const info = await lstat(source);
    const current = await maybeLstat(target);
    if (
      current &&
      info.ino &&
      current.ino === info.ino &&
      current.dev === info.dev &&
      process.platform !== 'linux' &&
      source !== target &&
      source.toLowerCase() === target.toLowerCase()
    )
      return rename(source, target);
    if (current) throw taken(target);
    const fail = (error: NodeJS.ErrnoException) => {
      throw error.code === 'EEXIST' ? taken(target) : error;
    };
    if (info.isFile()) {
      const linked = await link(source, target).then(
        () => true,
        (error: NodeJS.ErrnoException) => (error.code === 'EEXIST' ? fail(error) : false),
      );
      if (!linked) await copyFile(source, target, constants.COPYFILE_EXCL).catch(fail);
      return rm(source).catch(async (error) => {
        await rm(target, { force: true });
        throw error;
      });
    }
    if (info.isDirectory()) {
      const windows = process.platform === 'win32';
      if (!windows) await mkdir(target).catch(fail);
      return rename(source, target).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EXDEV') {
          if (!windows) await rmdir(target).catch(() => undefined);
          return fail(error);
        }
        if (windows) await mkdir(target).catch(fail);
        try {
          for (const name of await readdir(source))
            await cp(nodePath.join(source, name), nodePath.join(target, name), {
              recursive: true,
              errorOnExist: true,
              force: false,
              verbatimSymlinks: true,
              preserveTimestamps: true,
            });
        } catch (copy) {
          await rm(target, { recursive: true, force: true });
          throw copy;
        }
        await removeCopied(source, target);
      });
    }
    if (info.isSymbolicLink()) {
      const pointer = await readlink(source);
      if (!nodePath.isAbsolute(pointer) && nodePath.dirname(source) !== nodePath.dirname(target))
        throw new IntegrationError(
          `${source} is a relative link, so moving it to another folder would change where it points.`,
        );
      await symlink(pointer, target).catch(fail);
      return rm(source).catch(async (error) => {
        await rm(target, { force: true });
        throw error;
      });
    }
    throw new IntegrationError(`${source} is not a file, folder or link.`);
  }

  async function regularFile(path: string) {
    const info = await maybeLstat(path);
    if (info && !info.isFile()) throw new IntegrationError(`${path} is not a regular file.`);
    if (info && (await rules).executable(path, info.mode))
      throw new IntegrationError(`${path} is executable. Nod only changes plain files.`);
    return info;
  }

  async function replace(
    path: string,
    data: string | Uint8Array,
    previous: Stats | undefined,
    keep: string[],
    signal?: AbortSignal,
  ) {
    if (typeof data === 'string' && Buffer.byteLength(data) > writeBytes)
      throw new IntegrationError('The file text must be at most 1 MB. Nothing was changed.');
    if (previous) await trashReady();
    const folder = nodePath.dirname(path);
    const temporary = nodePath.join(folder, `.nod-${randomUUID()}.tmp`);
    await writeFile(temporary, data, { flag: 'wx' });
    if (!previous)
      return place(temporary, path, keep).catch(async (error) => {
        await rm(temporary, { force: true });
        throw error;
      });
    let backupFolder = '';
    let backup = '';
    try {
      backupFolder = await mkdtemp(nodePath.join(folder, '.nod-'));
      backup = nodePath.join(backupFolder, nodePath.basename(path));
      await chmod(temporary, previous.mode & 0o7777);
      await link(path, backup).catch(() => copyFile(path, backup));
      await unchanged(path, keep);
      await toTrash(path, signal);
    } catch (error) {
      await rm(temporary, { force: true });
      const lost =
        Boolean(backup) && !(await maybeLstat(path)) && Boolean(await maybeLstat(backup));
      const restored =
        lost &&
        (await place(backup, path, keep).then(
          () => true,
          () => false,
        ));
      if (backupFolder) await rm(backupFolder, { recursive: true, force: true });
      if (lost)
        throw new IntegrationError(
          restored
            ? `${path} is unchanged. The Trash answered too late, so a copy of it may also be in the Trash.`
            : `${path} went to the Trash, but its new version wasn't saved. It can be restored from the Trash.`,
          409,
        );
      throw error;
    }
    try {
      await place(temporary, path, keep);
    } catch {
      await rm(temporary, { force: true });
      const restored = await place(backup, path, keep).then(
        () => true,
        () => false,
      );
      await rm(backupFolder, { recursive: true, force: true });
      throw new IntegrationError(
        restored
          ? `${path} was not replaced and is unchanged. A copy of it is in the Trash.`
          : `${path} was not replaced. Its previous version is in the Trash.`,
        409,
      );
    }
    await rm(backupFolder, { recursive: true, force: true });
    return 'moved to the Trash';
  }

  async function quarantine(path: string) {
    if (process.platform === 'win32')
      return writeFile(`${path}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(
        () => undefined,
      );
    if (process.platform !== 'darwin') return;
    const stamp = Math.floor(Date.now() / 1000).toString(16);
    await run('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0081;${stamp};Nod;`, path]).catch(
      () => undefined,
    );
  }

  async function readFile(path: string, limit: number, version?: string, complete = false) {
    const fail = (error: unknown): never => {
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
        notRun: true,
      });
    };
    const checked = await lstat(path).catch(fail);
    if (!checked.isFile()) fail(new IntegrationError(`${path} is not a file.`));
    const file = await open(path, constants.O_RDONLY | noFollow | noBlock).catch(fail);
    let readStarted = false;
    try {
      const opened = await file.stat();
      if (opened.dev !== checked.dev || opened.ino !== checked.ino)
        throw new IntegrationError(`${path} changed while Nod was opening it.`);
      const checkVersion = async () => {
        if (!version) return;
        if (fileVersion(await file.stat({ bigint: true })) !== version) throw changedRead(path);
        const current = await lstat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changedRead(path, error);
          throw error;
        });
        if (fileVersion(current) !== version) throw changedRead(path);
      };
      await checkVersion();
      const size = opened.size;
      if (complete && size > limit)
        throw Object.assign(
          new IntegrationError(`Files up to ${limit / 1024 / 1024} MB can be copied.`),
          { notRun: true },
        );
      const length = Math.min(size, limit);
      readStarted = true;
      const { buffer, bytesRead } = await file.read(Buffer.alloc(length), 0, length, 0);
      await checkVersion();
      return { size, bytes: buffer.subarray(0, bytesRead) };
    } catch (error) {
      if (!readStarted) fail(error);
      throw error;
    } finally {
      await file.close();
    }
  }

  async function each<T>(items: T[], task: (item: T) => Promise<unknown>, signal?: AbortSignal) {
    const done: unknown[] = [];
    const failed: Array<{ item: T; error: string }> = [];
    for (const item of items) {
      signal?.throwIfAborted();
      try {
        done.push(await task(item));
      } catch (error) {
        failed.push({ item, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { done, failed };
  }

  type Input = {
    path: string;
    version?: string;
    moves: Array<{ from: string; to: string }>;
    paths: string[];
    text: string;
    overwrite?: boolean;
    edits: Array<{ oldText: string; newText: string }>;
    file: z.infer<typeof workspaceFileReference>;
  };

  function validate(action: Action, args: Record<string, unknown>) {
    const parsed = schemas[action].safeParse(args);
    if (!parsed.success)
      throw new IntegrationError(
        `Invalid ${action} arguments: ${z.prettifyError(parsed.error)}. Nothing was changed.`,
      );
    return parsed.data as Partial<Input>;
  }

  async function prepare(action: Action, args: Record<string, unknown>) {
    await assertEnabled();
    const input = validate(action, args);
    const real = resolver(action, await keptOut());
    if (input.moves)
      return {
        moves: await Promise.all(
          input.moves.map(async ({ from, to }) => ({ from: await real(from), to: await real(to) })),
        ),
      };
    if (input.paths) return { paths: await Promise.all(input.paths.map(real)) };
    const path = await real(input.path!);
    if (action === 'LOCAL_FILES_READ' || action === 'LOCAL_FILES_IMPORT') {
      const version = fileVersion(
        await lstat(path, { bigint: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw changedRead(path, error);
          throw error;
        }),
      );
      if (input.version && input.version !== version) throw changedRead(path);
      return { ...input, path, version };
    }
    return { ...input, path };
  }

  async function execute(
    action: Action,
    args: Record<string, unknown>,
    context: { signal?: AbortSignal; read?: WorkspaceRead } = {},
  ) {
    await assertEnabled();
    const { signal } = context;
    const input = validate(action, args) as Input;
    signal?.throwIfAborted();
    const keep = await keptOut();
    const rule = await rules;
    const resolve = resolver(action, keep);
    const bound = (resolved: string, requested: string) => {
      if (!rule.same(resolved, requested))
        throw new IntegrationError(
          `${requested} now leads somewhere else than when this action was checked. Nothing was changed.`,
          409,
        );
      return resolved;
    };
    const target = async (path: string) => {
      try {
        return bound(await resolve(path), path);
      } catch (error) {
        if (action === 'LOCAL_FILES_READ' || action === 'LOCAL_FILES_IMPORT')
          throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
            notRun: true,
          });
        throw error;
      }
    };
    if ((action === 'LOCAL_FILES_READ' || action === 'LOCAL_FILES_IMPORT') && !input.version) {
      await target(input.path);
      throw Object.assign(
        new IntegrationError('This file read has no checked version. Request a new read.', 409),
        { notRun: true },
      );
    }
    const destination = async (path: string, source?: string) => {
      const resolved = await target(path);
      if (
        (rule.program(resolved) &&
          !(
            source &&
            nodePath.extname(source).toLowerCase() === nodePath.extname(resolved).toLowerCase()
          )) ||
        (process.platform === 'win32' && /[. ]$/.test(resolved))
      )
        throw new IntegrationError(
          `${path} would be a program or shortcut. Nod only creates plain files.`,
        );
      return resolved;
    };
    if (action === 'LOCAL_FILES_LIST') {
      const path = await target(input.path);
      const names = (await readdir(path, { withFileTypes: true })).filter(
        (item) =>
          !rule.privateName(item.name) &&
          !keep.some((entry) => rule.inside(entry, nodePath.join(path, item.name))),
      );
      const entries = [];
      for (let start = 0; start < names.length; start += statBatch) {
        signal?.throwIfAborted();
        entries.push(
          ...(await Promise.all(
            names.slice(start, start + statBatch).map(async (item) => {
              const info = await maybeLstat(nodePath.join(path, item.name));
              return {
                name: item.name,
                kind: (info ?? item).isDirectory()
                  ? 'folder'
                  : (info ?? item).isSymbolicLink()
                    ? 'link'
                    : 'file',
                size: info?.size,
                modified: info?.mtime.toISOString(),
              };
            }),
          )),
        );
      }
      entries.sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
      return {
        path,
        total: names.length,
        entries: entries.slice(0, listLimit),
        ...(names.length > listLimit ? { truncated: true } : {}),
      };
    }
    if (action === 'LOCAL_FILES_READ') {
      const path = await target(input.path);
      const { size, bytes } = await readFile(path, readBytes, input.version);
      const truncated = size > readBytes;
      if (bytes.includes(0)) return { path, size, binary: true };
      return {
        path,
        size,
        text: new TextDecoder().decode(bytes, { stream: truncated }),
        ...(truncated ? { truncated } : {}),
      };
    }
    if (action === 'LOCAL_FILES_IMPORT') {
      const path = await target(input.path);
      const { size, bytes } = await readFile(path, fileBytes, input.version, true);
      const name = nodePath.basename(path);
      const file: IntegrationFile = { name, mimeType: fileMimeType(name), bytes };
      return { path, size, file };
    }
    if (action === 'LOCAL_FILES_CREATE_FOLDER') {
      const path = await destination(input.path);
      await mkdir(path).catch((error: NodeJS.ErrnoException) => {
        throw error.code === 'EEXIST' ? taken(path) : error;
      });
      return { created: path };
    }
    if (action === 'LOCAL_FILES_WRITE' || action === 'LOCAL_FILES_EXPORT') {
      const path = await destination(input.path);
      const previous = await regularFile(path);
      if (previous && !input.overwrite)
        throw new IntegrationError(`${path} already exists. Set overwrite to replace it.`, 409);
      let data: string | Uint8Array = input.text;
      if (action === 'LOCAL_FILES_EXPORT') {
        if (!context.read) throw new IntegrationError('Workspace files are unavailable.', 503);
        data = await context.read(input.file);
      }
      const previousVersion = await replace(path, data, previous, keep, signal);
      await quarantine(path);
      return { written: path, ...(previousVersion ? { previousVersion } : {}) };
    }
    if (action === 'LOCAL_FILES_EDIT') {
      const path = await target(input.path);
      const info = await regularFile(path);
      if (!info) throw new IntegrationError(`${path} does not exist.`, 404);
      if (info.size > writeBytes)
        throw new IntegrationError('Only files up to 1 MB can be edited.');
      const { bytes } = await readFile(path, writeBytes);
      let text: string;
      try {
        if (bytes.includes(0)) throw new Error();
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw new IntegrationError(`${path} is not a UTF-8 text file. Nothing was changed.`);
      }
      for (const { oldText, newText } of input.edits) {
        const at = text.indexOf(oldText);
        if (at < 0 || text.indexOf(oldText, at + 1) >= 0)
          throw new IntegrationError(
            `Each oldText must appear exactly once in ${path}. Nothing was changed.`,
          );
        text = text.slice(0, at) + newText + text.slice(at + oldText.length);
      }
      const previousVersion = await replace(path, text, info, keep, signal);
      await quarantine(path);
      return { edited: path, previousVersion };
    }
    if (action === 'LOCAL_FILES_MOVE') {
      const { done, failed } = await each(
        input.moves,
        async ({ from, to }) => {
          const checked = bound(await present(from, keep), from);
          const moved = await destination(to, checked);
          const source = bound(await present(from, keep), from);
          await place(source, moved, keep);
          return { from: source, to: moved };
        },
        signal,
      );
      return { moved: done, failed };
    }
    const { done, failed } = await each(
      input.paths,
      async (path) => {
        const source = bound(await present(path, keep), path);
        await toTrash(source, signal);
        return source;
      },
      signal,
    );
    return { trashed: done, failed };
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/local-files/keep-out', async () => ({
      available,
      paths: available ? await keptOut() : [],
    }));
    app.delete('/api/local-files/keep-out', async (request, reply) => {
      if (!available) return reply.code(503).send({ error: unavailable().message });
      const input = z
        .object({ path: z.string().max(4096) })
        .strict()
        .safeParse(request.body);
      if (!input.success)
        return reply.code(400).send({ error: 'Name the folder to let Nod into.' });
      return { available, paths: await letIn(input.data.path) };
    });
  }

  return {
    available,
    enabled,
    keptOut,
    keepOut,
    assertStartedByOwner,
    prepare,
    execute,
    registerRoutes,
  };
}

export type LocalFiles = ReturnType<typeof createLocalFiles>;
