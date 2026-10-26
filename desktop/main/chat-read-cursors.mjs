import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const maximumIds = 2048;
const maximumThreads = 32;

function exactFields(value, fields) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  );
}

function validId(value) {
  return typeof value === 'string' && uuid.test(value);
}

function cursor(value) {
  if (
    !exactFields(value, ['createdAt', 'messageIds']) ||
    typeof value.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt ||
    !Array.isArray(value.messageIds) ||
    value.messageIds.length > maximumIds ||
    !value.messageIds.every(validId)
  )
    throw new Error('The chat read position is invalid.');
  return { createdAt: value.createdAt, messageIds: [...new Set(value.messageIds)].sort() };
}

export function createChatReadCursorStore(path, { owner }) {
  let state;
  let operations = Promise.resolve();
  function serialized(operation) {
    const result = operations.then(operation);
    operations = result.catch(() => {});
    return result;
  }
  async function authorize(ownerId, threadId) {
    if (!validId(ownerId) || !validId(threadId)) throw new Error('The chat identity is invalid.');
    let expected;
    try {
      expected = await owner();
    } catch {
      throw new Error('Nod could not read its local profile identity.');
    }
    if (!validId(expected) || expected !== ownerId)
      throw new Error('This chat does not belong to the local profile.');
  }
  async function read(ownerId) {
    if (state) {
      if (state.ownerId !== ownerId)
        throw new Error('The saved chat read positions belong to another profile.');
      return state;
    }
    try {
      if ((await stat(path)).size > 4 * 1024 * 1024) throw new Error();
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (
        !exactFields(value, ['version', 'ownerId', 'threads']) ||
        value.version !== 1 ||
        value.ownerId !== ownerId ||
        !Array.isArray(value.threads) ||
        value.threads.length > maximumThreads
      )
        throw new Error();
      const seen = new Set();
      const threads = value.threads.map((entry) => {
        if (
          !exactFields(entry, ['threadId', 'cursor']) ||
          !validId(entry.threadId) ||
          seen.has(entry.threadId)
        )
          throw new Error();
        seen.add(entry.threadId);
        return { threadId: entry.threadId, cursor: cursor(entry.cursor) };
      });
      state = { version: 1, ownerId, threads };
    } catch (error) {
      if (error.code !== 'ENOENT')
        throw new Error('Nod could not open its saved chat read positions.');
      state = { version: 1, ownerId, threads: [] };
    }
    return state;
  }
  async function write(value) {
    const temporary = `${path}.${randomUUID()}.pending`;
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, path);
      state = value;
    } catch {
      throw new Error('Nod could not save its chat read position.');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return {
    get(ownerId, threadId) {
      return serialized(async () => {
        await authorize(ownerId, threadId);
        const saved = await read(ownerId);
        const value = saved.threads.find((entry) => entry.threadId === threadId)?.cursor;
        return value ? cursor(value) : null;
      });
    },
    async set(ownerId, threadId, input) {
      const next = cursor(input);
      return serialized(async () => {
        await authorize(ownerId, threadId);
        const saved = await read(ownerId);
        const previous = saved.threads.find((entry) => entry.threadId === threadId)?.cursor;
        if (previous && next.createdAt < previous.createdAt) return;
        if (previous?.createdAt === next.createdAt) {
          next.messageIds = [...new Set([...previous.messageIds, ...next.messageIds])].sort();
          if (next.messageIds.length > maximumIds)
            throw new Error('The chat read position contains too many messages.');
          if (next.messageIds.length === previous.messageIds.length) return;
        }
        const threads = saved.threads.filter((entry) => entry.threadId !== threadId);
        threads.push({ threadId, cursor: next });
        await write({ version: 1, ownerId, threads: threads.slice(-maximumThreads) });
      });
    },
    flush: () => operations,
  };
}
