import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

interface FeedbackLogScope {
  turnId?: string;
  sessionId?: string;
  runId?: string;
  parentRunId?: string;
  callId?: string;
}

export interface FeedbackLogEntry {
  event: 'tool_start' | 'tool_end' | 'failure' | 'activity';
  at: number;
  data: unknown;
  scope: FeedbackLogScope;
}

export interface FeedbackLogSnapshot {
  entries: FeedbackLogEntry[];
  coverage: {
    hours: number;
    dropped: number;
    truncated: boolean;
    unavailable: boolean;
  };
}

interface FeedbackLog {
  record(event: string, data?: unknown, scope?: FeedbackLogScope): void;
  snapshot(): Promise<FeedbackLogSnapshot>;
  close(): Promise<void>;
}

const events = new Set(['tool_start', 'tool_end', 'failure', 'activity']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const retentionMs = 86_400_000;
const errorStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const stackFormatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');

function plainErrorFields(value: object) {
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  if (formatter?.get || formatter?.value !== stackFormatter?.value) return false;
  return ['name', 'message'].every((key) => {
    let current: object | null = value;
    for (let depth = 0; current && depth < 10; depth++) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'string';
      current = Object.getPrototypeOf(current);
    }
    return current === null;
  });
}

function capture(value: unknown) {
  let remaining = 96_000;
  let nodes = 0;
  let truncated = false;
  const seen = new WeakSet<object>();
  const omitted = () => {
    truncated = true;
    return '[omitted]';
  };
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 1000 || depth > 10 || remaining <= 0) return omitted();
    if (item === null || item === undefined) return null;
    if (typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item === 'string') {
      if (item.length > Math.min(remaining, 32_000)) return omitted();
      remaining -= item.length;
      return item;
    }
    if (typeof item !== 'object' || ArrayBuffer.isView(item) || item instanceof ArrayBuffer)
      return omitted();
    if (seen.has(item)) return omitted();
    seen.add(item);
    const property = (key: string, nativeStack = false) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor) return null;
      if ('value' in descriptor) return visit(descriptor.value, depth + 1);
      if (
        nativeStack &&
        errorStackGetter &&
        descriptor.get === errorStackGetter &&
        plainErrorFields(item)
      )
        return visit(errorStackGetter.call(item), depth + 1);
      return omitted();
    };
    if (Array.isArray(item)) {
      const result: unknown[] = [];
      const length = Object.getOwnPropertyDescriptor(item, 'length')?.value;
      for (let index = 0; index < Math.min(typeof length === 'number' ? length : 0, 100); index++) {
        if (remaining <= 0 || nodes >= 1000) break;
        result.push(property(String(index)));
      }
      if (result.length < length) result.push(omitted());
      return result;
    }
    const result: Record<string, unknown> = Object.create(null);
    if (item instanceof Error) {
      result.name = 'Error';
      for (const key of ['name', 'message', 'stack', 'cause', 'issues'])
        if (Object.hasOwn(item, key)) result[key] = property(key, key === 'stack');
    }
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key) || Object.hasOwn(result, key)) continue;
      if (++count > 100 || remaining < key.length || nodes >= 1000) {
        result.omitted = omitted();
        break;
      }
      if (key.length > 256) {
        truncated = true;
        continue;
      }
      remaining -= key.length;
      result[key] = property(key);
    }
    return result;
  };
  return { value: visit(value, 0), truncated };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error('Invalid diagnostic journal limit.');
  return value;
}

function scope(value: unknown): FeedbackLogScope {
  if (!value || typeof value !== 'object') return {};
  const input = (key: string): unknown => Object.getOwnPropertyDescriptor(value, key)?.value;
  const output: FeedbackLogScope = {};
  for (const key of ['turnId', 'sessionId', 'runId', 'parentRunId'] as const) {
    const id = input(key);
    if (typeof id === 'string' && uuid.test(id)) output[key] = id;
  }
  const callId = input('callId');
  if (typeof callId === 'string' && /^[A-Za-z0-9_.:-]{1,200}$/.test(callId)) output.callId = callId;
  return output;
}

function entry(value: unknown): FeedbackLogEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (
    typeof input.event !== 'string' ||
    !events.has(input.event) ||
    typeof input.at !== 'number' ||
    !Number.isSafeInteger(input.at) ||
    input.at < 0
  )
    return null;
  return {
    event: input.event as FeedbackLogEntry['event'],
    at: input.at,
    data: input.data ?? null,
    scope: scope(input.scope),
  };
}

export async function createFeedbackLog(options: {
  dataRoot: string;
  ownerId: string;
  sanitize(value: unknown): unknown | Promise<unknown>;
  now?: () => number;
  maxFileBytes?: number;
  maxFiles?: number;
  maxPending?: number;
  snapshotLimit?: number;
}): Promise<FeedbackLog> {
  const maxFileBytes = bounded(options.maxFileBytes, 1_048_576, 4096, 4_194_304);
  const maxFiles = bounded(options.maxFiles, 3, 1, 4);
  const maxPending = bounded(options.maxPending, 100, 1, 1000);
  const snapshotLimit = bounded(options.snapshotLimit, 200, 1, 1000);
  const now = options.now ?? Date.now;
  const parent = join(options.dataRoot, 'feedback-logs');
  const directory = join(parent, createHash('sha256').update(options.ownerId).digest('hex'));
  const file = (index: number) => join(directory, `journal-${index}.jsonl`);
  let dropped = 0;
  let truncated = false;
  let unavailable = false;
  let ready = false;
  let closed = false;
  let pending = 0;
  let sanitizing = 0;
  let nextPruneAt = 0;
  let tail: Promise<void> = Promise.resolve();

  function failed() {
    unavailable = true;
  }

  async function directorySafe(path: string, create = false) {
    if (create)
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('Unsafe diagnostic directory.');
    if (path !== options.dataRoot) await chmod(path, 0o700);
  }

  async function directoriesSafe() {
    await directorySafe(options.dataRoot);
    await directorySafe(parent);
    await directorySafe(directory);
  }

  async function existing(index: number) {
    try {
      const stat = await lstat(file(index));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxFileBytes)
        throw new Error('Unsafe diagnostic journal.');
      return stat;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async function read(index: number) {
    if (!(await existing(index))) return { rows: [] as FeedbackLogEntry[], invalid: false };
    const handle = await open(file(index), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFileBytes)
        throw new Error('Unsafe diagnostic journal.');
      await handle.chmod(0o600);
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) break;
        offset += part.bytesRead;
      }
      const rows: FeedbackLogEntry[] = [];
      let invalid = false;
      for (const line of bytes.subarray(0, offset).toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          const parsed = entry(JSON.parse(line));
          if (!parsed) throw new Error('Invalid diagnostic entry.');
          rows.push(parsed);
        } catch {
          invalid = true;
          dropped++;
          truncated = true;
          failed();
        }
      }
      return { rows, invalid };
    } finally {
      await handle.close();
    }
  }

  async function write(index: number, data: string, append: boolean) {
    await directoriesSafe();
    await existing(index);
    const handle = await open(
      file(index),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_NOFOLLOW |
        (append ? constants.O_APPEND : 0),
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFileBytes)
        throw new Error('Unsafe diagnostic journal.');
      if (Buffer.byteLength(data) + (append ? stat.size : 0) > maxFileBytes)
        throw new Error('Diagnostic journal limit reached.');
      await handle.chmod(0o600);
      if (!append) await handle.truncate(0);
      await handle.writeFile(data, 'utf8');
    } finally {
      await handle.close();
    }
  }

  async function prune() {
    await directoriesSafe();
    const cutoff = now() - retentionMs;
    const rows: FeedbackLogEntry[] = [];
    for (let index = maxFiles - 1; index >= 0; index--) {
      const stored = await read(index);
      const current = stored.rows.filter((row) => row.at >= cutoff && row.at <= now());
      if (stored.invalid || current.length !== stored.rows.length) {
        if (current.length)
          await write(index, current.map((row) => JSON.stringify(row) + '\n').join(''), false);
        else if (await existing(index)) await unlink(file(index));
      }
      rows.push(...current);
    }
    nextPruneAt = now() + 60_000;
    return rows;
  }

  async function rotate() {
    await directoriesSafe();
    const present = await Promise.all(
      Array.from({ length: maxFiles }, (_, index) => existing(index)),
    );
    if (present[maxFiles - 1]) {
      await unlink(file(maxFiles - 1));
      truncated = true;
    }
    for (let index = maxFiles - 2; index >= 0; index--)
      if (present[index]) await rename(file(index), file(index + 1));
  }

  function enqueue<T>(run: () => Promise<T>) {
    const result = tail.then(run);
    tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async function sanitize(value: unknown) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    sanitizing++;
    const result = Promise.resolve().then(() => options.sanitize(value));
    void result.then(
      () => sanitizing--,
      () => sanitizing--,
    );
    try {
      return await Promise.race([
        result,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Diagnostic redaction unavailable.')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  try {
    await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
    await directorySafe(options.dataRoot);
    await directorySafe(parent, true);
    await directorySafe(directory, true);
    await prune();
    truncated ||= Boolean(await existing(maxFiles - 1));
    ready = true;
  } catch {
    failed();
  }

  let cleaning = false;
  const timer = setInterval(() => {
    if (!ready || closed || cleaning || now() < nextPruneAt) return;
    cleaning = true;
    void enqueue(prune)
      .catch(failed)
      .finally(() => {
        cleaning = false;
      });
  }, 60_000);
  timer.unref();

  return {
    record(event, data, rawScope) {
      if (closed || !events.has(event)) return;
      if (!ready || pending >= maxPending || sanitizing >= maxPending) {
        dropped++;
        return;
      }
      const at = now();
      let context: FeedbackLogScope;
      let captured: ReturnType<typeof capture>;
      try {
        context = scope(rawScope);
        captured = capture(data);
      } catch {
        dropped++;
        failed();
        return;
      }
      truncated ||= captured.truncated;
      const sanitized = sanitize(captured.value)
        .then((value) => {
          const safe = capture(value);
          truncated ||= safe.truncated;
          return safe.value;
        })
        .then(
          (value) => ({ ok: true as const, value }),
          () => ({ ok: false as const }),
        );
      pending++;
      void enqueue(async () => {
        try {
          const result = await sanitized;
          if (!result.ok) throw new Error('Diagnostic redaction unavailable.');
          if (now() >= nextPruneAt) await prune();
          const value: FeedbackLogEntry = {
            event: event as FeedbackLogEntry['event'],
            at,
            data: result.value ?? null,
            scope: context,
          };
          let encoded = JSON.stringify(value) + '\n';
          if (Buffer.byteLength(encoded) > Math.min(65_536, maxFileBytes)) {
            value.data = { omitted: true, reason: 'record_too_large' };
            encoded = JSON.stringify(value) + '\n';
            truncated = true;
          }
          if (((await existing(0))?.size ?? 0) + Buffer.byteLength(encoded) > maxFileBytes)
            await rotate();
          await write(0, encoded, true);
        } catch {
          dropped++;
          failed();
        } finally {
          pending--;
        }
      });
    },
    snapshot() {
      return enqueue(async () => {
        let rows: FeedbackLogEntry[] = [];
        if (ready) {
          try {
            rows = await prune();
          } catch {
            failed();
          }
        }
        rows.sort((a, b) => a.at - b.at);
        return {
          entries: rows.slice(-snapshotLimit),
          coverage: {
            hours: 24,
            dropped,
            truncated: truncated || rows.length > snapshotLimit,
            unavailable,
          },
        };
      });
    },
    async close() {
      closed = true;
      clearInterval(timer);
      await tail;
    },
  };
}
