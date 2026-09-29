import { SessionManager, type FileEntry } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import type { AgentToolResult } from '../../ports/agent.ts';
import type { PrivateObjectStore } from '../../ports/object-storage.ts';

const maximum = 15 * 1024 * 1024;
const pendingType = 'otto_tool_pending';
const completedType = 'otto_tool_completed';
const failure = () =>
  new Error(
    'The assistant session could not be saved. Stop and restore storage before continuing.',
  );

function entries(bytes: Uint8Array): FileEntry[] {
  try {
    const rows = Buffer.from(bytes)
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    if (
      !rows.length ||
      rows[0]?.type !== 'session' ||
      typeof rows[0].id !== 'string' ||
      typeof rows[0].cwd !== 'string'
    )
      throw failure();
    const ids = new Set<string>();
    for (const row of rows.slice(1)) {
      if (
        !row ||
        typeof row.type !== 'string' ||
        row.type === 'session' ||
        typeof row.id !== 'string' ||
        ids.has(row.id) ||
        (row.parentId !== null && !ids.has(row.parentId))
      )
        throw failure();
      if (row.type === 'message' && (!row.message || typeof row.message.role !== 'string'))
        throw failure();
      ids.add(row.id);
    }
    return rows as FileEntry[];
  } catch {
    throw failure();
  }
}

export async function createPiCheckpoint(options: {
  store: PrivateObjectStore;
  taskId: string;
  directory: string;
  fresh?: boolean;
}) {
  const key = `sessions/${options.taskId}.jsonl`;
  const saved = await options.store.read(key, maximum);
  const manager = SessionManager.inMemory(
    options.directory,
    undefined,
    saved && !options.fresh ? entries(saved.bytes) : undefined,
  );
  let version = saved?.version ?? null;
  let failed = false;
  let tail = Promise.resolve();
  const calls = new Map<string, { name: string; result?: AgentToolResult }>();
  const results = new Set<string>();
  for (const entry of manager.getEntries()) {
    if (entry.type === 'message' && entry.message.role === 'toolResult')
      results.add(entry.message.toolCallId);
    if (entry.type !== 'custom' || ![pendingType, completedType].includes(entry.customType))
      continue;
    const data = entry.data as
      { callId?: string; name?: string; result?: AgentToolResult } | undefined;
    if (!data || typeof data.callId !== 'string' || typeof data.name !== 'string') throw failure();
    if (entry.customType === pendingType) calls.set(data.callId, { name: data.name });
    else {
      const call = calls.get(data.callId);
      if (!call || call.name !== data.name || !Array.isArray(data.result?.content)) throw failure();
      call.result = data.result;
    }
  }
  for (const [callId, call] of calls) {
    if (!call.result)
      throw new Error(
        'An assistant action was interrupted before its result was saved. Reconcile that action before resuming this task.',
      );
    if (!results.has(callId))
      manager.appendMessage({
        role: 'toolResult',
        toolCallId: callId,
        toolName: call.name,
        content: call.result.content,
        details: {},
        isError: false,
        timestamp: Date.now(),
      });
  }
  function checkpoint() {
    const next = tail.then(async () => {
      if (failed) throw failure();
      try {
        const bytes = Buffer.from(
          [{ ...manager.getHeader(), ottoRevision: randomUUID() }, ...manager.getEntries()]
            .map((entry) => JSON.stringify(entry))
            .join('\n') + '\n',
        );
        if (bytes.byteLength > maximum) throw failure();
        version = await options.store.write(key, bytes, { expectedVersion: version });
      } catch {
        failed = true;
        throw failure();
      }
    });
    tail = next.catch(() => {});
    return next;
  }
  await checkpoint();
  return {
    manager,
    checkpoint,
    async execute(callId: string, name: string, action: () => Promise<AgentToolResult>) {
      if (failed || calls.has(callId)) throw failure();
      calls.set(callId, { name });
      manager.appendCustomEntry(pendingType, { callId, name });
      await checkpoint();
      let result;
      try {
        result = await action();
      } catch {
        failed = true;
        throw new Error('An assistant action failed before its result could be confirmed.');
      }
      manager.appendCustomEntry(completedType, { callId, name, result });
      await checkpoint();
      calls.set(callId, { name, result });
      return result;
    },
  };
}
