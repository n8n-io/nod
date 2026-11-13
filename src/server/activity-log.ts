import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { TrustEntry, TrustSource, TrustStep } from '../shared/trust.ts';
import { actionText, becauseText } from '../shared/trust.ts';
import type { VaultActivityEntry } from '../shared/contracts.ts';
import { vaultActivityTitle, vaultReasons } from '../shared/vault-activity.ts';
import { activityRange, type ActivityRange } from './ledger.ts';

const sources: Record<TrustSource, string> = {
  chat: 'Chat',
  task: 'Task',
  started: 'Task Nod started',
  schedule: 'Schedule',
  event: 'App event',
  check: 'Activity check',
  resume: 'Continued work',
};

const kinds: Record<TrustStep['kind'], string> = {
  model: 'Model',
  action: 'Action',
  tool: 'Tool',
  note: 'Note',
  reply: 'Reply',
};

const chunkSize = 200;
const pageRows = 5000;

export interface ActivityLogEntry {
  at: string;
  request: string;
  source: string;
  did: Array<{ action: string; allowedBy?: string }>;
  costUsd?: number;
  error?: string;
}

interface Span {
  session?: string;
  timeZone: string;
  locale: string;
  start: Date | null;
  end: Date | null;
}

type Cursor = { at: string; id: string };

interface Sources {
  bounds(range: ActivityRange): Promise<Span>;
  within(
    range: ActivityRange,
    limit: number,
  ): Promise<Span & { entries: TrustEntry[]; complete: boolean }>;
  chunk(
    span: Span,
    after: Cursor | null,
    size: number,
  ): Promise<{ entries: TrustEntry[]; next: Cursor | null }>;
  vault(
    start: Date | string | null,
    end: Date | string | null,
    limit: number | null,
  ): Promise<{ entries: VaultActivityEntry[]; complete: boolean }>;
  vaultPage(
    start: Date | string | null,
    end: Date | string | null,
    after: Cursor | null,
    limit: number,
  ): Promise<{ entries: VaultActivityEntry[]; next: Cursor | null }>;
  steps(
    turnIds: string[],
    page: { offset: number; limit: number },
  ): Promise<Map<string, TrustStep[]>>;
}

const clock = (timeZone: string) => {
  const format = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (at: string | Date, seconds = false) =>
    format.format(new Date(at)).slice(0, seconds ? 19 : 16);
};

function fromRequest(entry: TrustEntry): ActivityLogEntry {
  return {
    at: entry.at,
    request: entry.title,
    source: sources[entry.source],
    did: entry.actions.map((action) => ({
      action: actionText(action),
      ...(action.because ? { allowedBy: becauseText(action.because) } : {}),
    })),
    ...(entry.costUsd !== null ? { costUsd: entry.costUsd } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  };
}

function vaultReason(entry: VaultActivityEntry) {
  return entry.because ? becauseText(entry.because) : vaultReasons[entry.reason];
}

function fromVault(entry: VaultActivityEntry, locale: string): ActivityLogEntry {
  return {
    at: entry.at,
    request: entry.task,
    source: 'Vault',
    did: [{ action: vaultActivityTitle(entry, locale), allowedBy: vaultReason(entry) }],
  };
}

const cell = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r\n]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

const line = (row: Array<string | number | undefined>) => `${row.map(cell).join(',')}\r\n`;

export function createActivityLog(log: Sources) {
  async function read(input: unknown, limit: number) {
    const range = activityRange.parse(input ?? {});
    const requests = await log.within(range, limit);
    const vault = range.session
      ? { entries: [], complete: true }
      : await log.vault(requests.start, requests.end, limit);
    const merged = [
      ...requests.entries.map(fromRequest),
      ...vault.entries.map((entry) => fromVault(entry, requests.locale)),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const entries = merged.slice(0, limit);
    const time = clock(requests.timeZone);
    return {
      timeZone: requests.timeZone,
      entries: entries.map((entry) => ({ ...entry, at: time(entry.at) })),
      complete: requests.complete && vault.complete && entries.length === merged.length,
    };
  }

  async function* csv(span: Span) {
    const local = clock(span.timeZone);
    const time = (at: string) => local(at, true);
    const vaultLine = (use: VaultActivityEntry) =>
      line([
        time(use.at),
        use.task,
        'Vault',
        'Vault',
        vaultActivityTitle(use, span.locale),
        '',
        vaultReason(use),
        '',
      ]);
    yield `\ufeff${line([`Time (${span.timeZone})`, 'Request', 'Source', 'Kind', 'Step', 'Detail', 'Allowed by', 'Cost (USD)'])}`;
    let after: Cursor | null = null;
    let from: Date | string | null = span.start;
    for (;;) {
      const { entries, next }: { entries: TrustEntry[]; next: Cursor | null } = await log.chunk(
        span,
        after,
        chunkSize,
      );
      const last = entries.length < chunkSize || !next;
      const until = last ? span.end : next.at;
      const pending: VaultActivityEntry[] = [];
      let vaultAfter: Cursor | null = null;
      let vaultDone = Boolean(span.session);
      async function* vaultBefore(before: string | null) {
        for (;;) {
          if (!pending.length && !vaultDone) {
            const page = await log.vaultPage(from, until, vaultAfter, pageRows);
            pending.push(...page.entries);
            vaultAfter = page.next;
            vaultDone = page.entries.length < pageRows;
          }
          let out = '';
          while (
            pending.length &&
            (before === null || Date.parse(pending[0]!.at) < Date.parse(before))
          )
            out += vaultLine(pending.shift()!);
          if (out) yield out;
          if (pending.length || vaultDone) return;
        }
      }
      const base = (entry: TrustEntry) => [entry.title, sources[entry.source]];
      const close = (entry: TrustEntry) =>
        entry.error ? line([time(entry.at), ...base(entry), 'Error', entry.error, '', '', '']) : '';
      const index = new Map(entries.map((entry, position) => [entry.id, position]));
      const ids = entries.map((entry) => entry.id);
      let position = 0;
      let open: TrustEntry | null = null;
      for (let offset = 0; ids.length; offset += pageRows) {
        const page = await log.steps(ids, { offset, limit: pageRows });
        let count = 0;
        let out = '';
        for (const [turnId, list] of page) {
          count += list.length;
          const at = index.get(turnId)!;
          if (open && open.id !== turnId) {
            out += close(open);
            open = null;
          }
          while (!open && position <= at) {
            const entry = entries[position]!;
            if (out) yield out;
            out = '';
            yield* vaultBefore(entry.at);
            if (position < at) {
              out += line([
                time(entry.at),
                ...base(entry),
                '',
                '',
                '',
                '',
                entry.costUsd?.toFixed(6),
              ]);
              out += close(entry);
            } else open = entry;
            position++;
          }
          for (const step of list)
            out += line([
              time(step.at),
              ...base(open!),
              kinds[step.kind],
              `${step.title}${step.failed ? ' (failed)' : ''}`,
              step.detail ?? '',
              step.because ? becauseText(step.because) : '',
              step.costUsd?.toFixed(6),
            ]);
        }
        if (out) yield out;
        if (count < pageRows) break;
      }
      let out = open ? close(open) : '';
      for (; position < entries.length; position++) {
        const entry = entries[position]!;
        if (out) yield out;
        out = '';
        yield* vaultBefore(entry.at);
        out += line([time(entry.at), ...base(entry), '', '', '', '', entry.costUsd?.toFixed(6)]);
        out += close(entry);
      }
      if (out) yield out;
      yield* vaultBefore(null);
      if (last) return;
      after = next;
      from = until;
    }
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/trust/export', async (request, reply) => {
      const span = await log.bounds(activityRange.parse(request.query ?? {}));
      const day = clock(span.timeZone)(new Date()).slice(0, 10);
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Disposition', `attachment; filename="nod-activity-${day}.csv"`)
        .send(Readable.from(csv(span)));
    });
  }

  return { read, registerRoutes };
}
