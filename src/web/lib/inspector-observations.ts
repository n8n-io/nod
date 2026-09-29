import { formatNumber } from './date-format';
import type { TaskEvent } from '../../shared/contracts';
import type {
  InspectorObservationsResponse,
  InspectorFailure,
  ToolCall,
} from '../../shared/inspector';

export type ToolStatusFilter = 'all' | ToolCall['status'];

export function formatInspectorJson(value: unknown) {
  return JSON.stringify(value, null, 2) ?? 'Not recorded';
}

export function formatModelCost(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Price unavailable';
  if (value > 0 && value < 0.000001) return '< USD 0.000001';
  return `USD ${formatNumber(value, { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

export function formatToolDuration(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0) return 'Not recorded';
  if (value < 1000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)} s`;
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function filterToolCalls(calls: ToolCall[], query: string, status: ToolStatusFilter) {
  const search = query.trim().toLocaleLowerCase();
  return calls.filter(
    (call) =>
      (status === 'all' || call.status === status) &&
      (!search ||
        [
          call.name,
          call.error ?? '',
          formatInspectorJson(call.input),
          formatInspectorJson(call.output),
        ].some((value) => value.toLocaleLowerCase().includes(search))),
  );
}

export function mergeObservationPage(
  current: InspectorObservationsResponse,
  page: InspectorObservationsResponse,
  kind: 'older' | 'refresh',
): InspectorObservationsResponse {
  const calls =
    kind === 'refresh' ? [...current.calls, ...page.calls] : [...page.calls, ...current.calls];
  const usage =
    kind === 'refresh' ? [...current.usage, ...page.usage] : [...page.usage, ...current.usage];
  const failures =
    kind === 'refresh'
      ? [...(current.failures ?? []), ...(page.failures ?? [])]
      : [...(page.failures ?? []), ...(current.failures ?? [])];
  const cursor = kind === 'older' ? page : current;
  return {
    scope: kind === 'refresh' ? page.scope : current.scope,
    taskId: kind === 'refresh' ? page.taskId : current.taskId,
    calls: [...new Map(calls.map((call) => [call.id, call])).values()].sort(
      (a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id),
    ),
    usage: [...new Map(usage.map((request) => [request.id, request])).values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
    ),
    failures: [...new Map(failures.map((failure) => [failure.id, failure])).values()].sort(
      (a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id),
    ),
    summary: kind === 'refresh' ? page.summary : current.summary,
    toolUsage: kind === 'refresh' ? page.toolUsage : current.toolUsage,
    hasOlder: cursor.hasOlder,
    nextBefore: cursor.nextBefore,
    nextBeforeId: cursor.nextBeforeId,
  };
}

export async function completeObservationRefresh(
  current: InspectorObservationsResponse,
  newest: InspectorObservationsResponse,
  load: (cursor: { before: string; beforeId?: string }) => Promise<InspectorObservationsResponse>,
  signal: AbortSignal,
): Promise<{ data: InspectorObservationsResponse; reset: boolean }> {
  signal.throwIfAborted();
  if (
    newest.summary.calls < current.summary.calls ||
    newest.summary.modelRequests < current.summary.modelRequests ||
    (newest.summary.failures ?? 0) < (current.summary.failures ?? 0)
  )
    return { data: newest, reset: true };
  const known = new Set(
    [...current.calls, ...current.usage, ...(current.failures ?? [])].map((row) => row.id),
  );
  if (!known.size) return { data: newest, reset: true };
  const running = new Set(
    current.calls.filter((call) => call.status === 'running').map((call) => call.id),
  );
  let combined = newest;
  let page = newest;
  const visited = new Set<string>();
  let overlaps = false;
  while (true) {
    overlaps ||= [...page.calls, ...page.usage, ...(page.failures ?? [])].some((row) =>
      known.has(row.id),
    );
    for (const call of page.calls) running.delete(call.id);
    if (overlaps && !running.size) break;
    if (!page.hasOlder) return { data: newest, reset: true };
    if (!page.nextBefore)
      throw new Error('The recording page is incomplete. Refreshing will retry.');
    const cursor = JSON.stringify([page.nextBefore, page.nextBeforeId]);
    if (visited.has(cursor))
      throw new Error('The recording cursor did not advance. Refreshing will retry.');
    visited.add(cursor);
    page = await load({ before: page.nextBefore, beforeId: page.nextBeforeId });
    signal.throwIfAborted();
    combined = mergeObservationPage(combined, page, 'older');
  }
  return { data: mergeObservationPage(current, combined, 'refresh'), reset: false };
}

export interface ActivityItem {
  id: string;
  title: string;
  status: ToolCall['status'] | 'info';
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  diagnostic?: unknown;
}

export function compactActivityText(text: string, limit = 160) {
  if (
    /^(Hourly review of active goals, current context|A relevance check selected this hourly review)/i.test(
      text.trim(),
    )
  )
    return 'Hourly goal and context review';
  if (/^A relevance check selected this event/i.test(text.trim()))
    return 'Connection update review';
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}

export function groupTaskActivity(
  events: TaskEvent[],
  calls?: ToolCall[],
  failures: InspectorFailure[] = [],
): ActivityItem[] {
  if (failures.length) {
    const recorded = new Map(
      failures.map((failure) => [`${failure.taskId}:${failure.occurredAt}`, failure]),
    );
    const matching = new Map(
      events
        .filter((event) => event.type === 'failed')
        .map((event) => [event.id, recorded.get(`${event.taskId}:${event.createdAt}`)]),
    );
    const matched = new Set<string>();
    const items = groupTaskActivity(events, calls).map((item) => {
      const failure = matching.get(item.id);
      if (!failure) return item;
      matched.add(failure.id);
      return { ...item, diagnostic: failure.diagnostic };
    });
    return [
      ...items,
      ...failures
        .filter((failure) => !matched.has(failure.id))
        .map((failure): ActivityItem => ({
          id: failure.id,
          title: 'Task failed',
          status: 'failed',
          startedAt: failure.occurredAt,
          finishedAt: failure.occurredAt,
          durationMs: null,
          diagnostic: failure.diagnostic,
        })),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  if (calls) {
    const represented = new Set<string>();
    for (const call of [...calls].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      const candidates = events.filter(
        (event) =>
          !represented.has(event.id) &&
          event.taskId === call.taskId &&
          event.summary.trim().replaceAll('_', ' ').toLowerCase() ===
            call.name.replaceAll('_', ' ').toLowerCase() &&
          event.createdAt >= call.startedAt &&
          (!call.finishedAt || event.createdAt <= call.finishedAt),
      );
      const start = candidates
        .filter((event) => event.type === 'tool_start')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      if (start) represented.add(start.id);
      if (call.finishedAt) {
        const end = candidates
          .filter((event) => ['tool_complete', 'tool_failed'].includes(event.type))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (end) represented.add(end.id);
      }
    }
    return [
      ...groupTaskActivity(events.filter((event) => !represented.has(event.id))),
      ...calls.map((call) => ({
        id: call.id,
        title: compactActivityText(call.name.replaceAll('_', ' ')),
        status: call.status,
        startedAt: call.startedAt,
        finishedAt: call.finishedAt,
        durationMs: call.durationMs,
      })),
    ].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }
  const items: ActivityItem[] = [];
  const pending = new Map<string, ActivityItem[]>();
  const ambiguous = new Set<string>();
  const labels: Record<string, string> = {
    started: 'Task started',
    queued: 'Task queued',
    succeeded: 'Task completed',
    completed: 'Task completed',
    cancelled: 'Task cancelled',
    failed: 'Task failed',
    waiting_credentials: 'Waiting for sign-in',
    waiting_user: 'Waiting for your input',
  };
  for (const event of [...events].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const key = `${event.taskId}:${event.summary.trim().toLowerCase()}`;
    if (event.type === 'tool_start') {
      const item: ActivityItem = {
        id: event.id,
        title: compactActivityText(event.summary.replaceAll('_', ' ')),
        status: 'running',
        startedAt: event.createdAt,
        finishedAt: null,
        durationMs: null,
      };
      const queue = pending.get(key) ?? [];
      if (queue.length) {
        for (const active of queue) ambiguous.add(active.id);
        ambiguous.add(item.id);
      }
      queue.push(item);
      pending.set(key, queue);
      items.push(item);
    } else if (event.type === 'tool_complete' || event.type === 'tool_failed') {
      const queue = pending.get(key);
      const item = queue?.shift();
      if (item) {
        item.status = event.type === 'tool_failed' ? 'failed' : 'succeeded';
        item.finishedAt = event.createdAt;
        item.durationMs = ambiguous.has(item.id)
          ? null
          : Math.max(0, Date.parse(event.createdAt) - Date.parse(item.startedAt));
      } else {
        items.push({
          id: event.id,
          title: compactActivityText(event.summary.replaceAll('_', ' ')),
          status: event.type === 'tool_failed' ? 'failed' : 'succeeded',
          startedAt: event.createdAt,
          finishedAt: event.createdAt,
          durationMs: null,
        });
      }
    } else {
      if (['failed', 'succeeded', 'cancelled'].includes(event.type)) {
        for (const [pendingKey, queue] of pending) {
          if (!pendingKey.startsWith(`${event.taskId}:`)) continue;
          for (const active of queue) {
            active.status = 'interrupted';
            active.finishedAt = event.createdAt;
          }
          pending.delete(pendingKey);
        }
      }
      items.push({
        id: event.id,
        title: labels[event.type] ?? compactActivityText(event.summary),
        status: event.type === 'failed' ? 'failed' : 'info',
        startedAt: event.createdAt,
        finishedAt: event.createdAt,
        durationMs: null,
      });
    }
  }
  return items.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
