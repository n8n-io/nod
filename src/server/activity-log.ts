import type { FastifyInstance } from 'fastify';
import type { TrustEntry, TrustSource } from '../shared/trust.ts';
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

export interface ActivityLogEntry {
  at: string;
  request: string;
  source: string;
  did: Array<{ action: string; allowedBy?: string }>;
  costUsd?: number;
  error?: string;
}

interface Sources {
  requests(
    range: ActivityRange,
    limit: number | null,
  ): Promise<{
    timeZone: string;
    locale: string;
    start: Date | null;
    end: Date | null;
    entries: TrustEntry[];
    complete: boolean;
  }>;
  vault(
    start: Date | null,
    end: Date | null,
    limit: number | null,
  ): Promise<{ entries: VaultActivityEntry[]; complete: boolean }>;
}

const localTime = (at: string, timeZone: string) =>
  new Date(at).toLocaleString('sv-SE', { timeZone }).slice(0, 16);

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

function fromVault(entry: VaultActivityEntry, locale: string): ActivityLogEntry {
  return {
    at: entry.at,
    request: entry.task,
    source: 'Vault',
    did: [
      {
        action: vaultActivityTitle(entry, locale),
        allowedBy: entry.because ? becauseText(entry.because) : vaultReasons[entry.reason],
      },
    ],
  };
}

const cell = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function createActivityLog(log: Sources) {
  async function read(input: unknown, limit: number | null) {
    const range = activityRange.parse(input ?? {});
    const requests = await log.requests(range, limit);
    const vault = range.session
      ? { entries: [], complete: true }
      : await log.vault(requests.start, requests.end, limit);
    const merged = [
      ...requests.entries.map(fromRequest),
      ...vault.entries.map((entry) => fromVault(entry, requests.locale)),
    ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const entries = limit === null ? merged : merged.slice(0, limit);
    return {
      timeZone: requests.timeZone,
      entries: entries.map((entry) => ({ ...entry, at: localTime(entry.at, requests.timeZone) })),
      complete: requests.complete && vault.complete && entries.length === merged.length,
    };
  }

  async function csv(input: unknown) {
    const { entries, timeZone } = await read(input, null);
    const rows = [
      [`Time (${timeZone})`, 'Request', 'Source', 'Action', 'Allowed by', 'Model cost (USD)'],
    ];
    for (const entry of [...entries].reverse()) {
      const did = entry.did.length ? entry.did : [{ action: '' }];
      did.forEach((item, index) =>
        rows.push([
          entry.at,
          entry.request,
          entry.source,
          entry.error && !index
            ? `${item.action ? `${item.action} · ` : ''}Failed: ${entry.error}`
            : item.action,
          item.allowedBy ?? '',
          index || entry.costUsd === undefined ? '' : entry.costUsd.toFixed(4),
        ]),
      );
    }
    return `${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
  }

  function registerRoutes(app: FastifyInstance) {
    app.get('/api/trust/export', async (request, reply) =>
      reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Cache-Control', 'private, no-store')
        .header('X-Content-Type-Options', 'nosniff')
        .header(
          'Content-Disposition',
          `attachment; filename="nod-activity-${new Date().toISOString().slice(0, 10)}.csv"`,
        )
        .send(`﻿${await csv(request.query)}`),
    );
  }

  return { read, csv, registerRoutes };
}
