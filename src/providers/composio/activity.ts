import { createHash } from 'node:crypto';
import type { Composio } from '@composio/core';
import { z } from 'zod';
import {
  ObservationCursorExpired,
  type ObservationRecord,
  type ObservationBatch,
} from '../../ports/proactivity.ts';
import type { ActivityReader } from '../../ports/integrations.ts';
import { messageSchema, messageText } from './verification-email.ts';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,1024}$/);
const page = z.string().min(1).max(2048);
const version = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
type Client = Pick<Composio['tools'], 'proxyExecute'>;
type Query = Parameters<ActivityReader['read']>[1];
const emailIdentity = (accountId: string, email: string | null) =>
  email && z.email().safeParse(email).success ? email.trim().toLowerCase() : accountId;

export function composioActivity(client: Client): Record<string, ActivityReader> {
  return {
    gmail: {
      read: (accountId, input, signal) => readGmail(client, accountId, input, signal),
      identity: emailIdentity,
    },
    googlecalendar: {
      read: (accountId, input, signal) => readCalendar(client, accountId, input, signal),
      changeToken: (accountId, signal) => calendarChangeToken(client, accountId, signal),
      identity: emailIdentity,
    },
  };
}

function reader(client: Client, accountId: string, input: Query, signal: AbortSignal) {
  const ids = input.ids && z.array(id).min(1).max(10).parse(input.ids);
  const cursor = input.cursor && page.parse(input.cursor);
  const since = input.since && z.iso.datetime({ offset: true }).parse(input.since);
  const asOf = input.asOf
    ? new Date(z.iso.datetime({ offset: true }).parse(input.asOf)).getTime()
    : Date.now();
  let active = 0;
  const waiting: Array<() => void> = [];
  const get = async (
    endpoint: string,
    parameters: Array<[string, string | number]>,
    operation = signal,
    limit = 1_000_000,
  ) => {
    while (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve));
    if (operation.aborted) {
      waiting.shift()?.();
      throw operation.reason;
    }
    active++;
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error('The source request timed out.')),
      10000,
    );
    const stop = AbortSignal.any([operation, deadline.signal]);
    let onAbort = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(stop.reason);
        stop.addEventListener('abort', onAbort, { once: true });
        if (stop.aborted) onAbort();
      });
      const result = await Promise.race([
        client.proxyExecute(
          {
            connectedAccountId: accountId,
            endpoint,
            method: 'GET',
            parameters: parameters.map(([name, value]) => ({ in: 'query' as const, name, value })),
          },
          { signal: stop },
        ),
        aborted,
      ]);
      stop.throwIfAborted();
      if (result.status === 404 || result.status === 410) return null;
      if (result.status === 400 && parameters.some(([name]) => name === 'pageToken'))
        throw new ObservationCursorExpired('The source page expired.');
      if (result.status !== 200) throw new Error('The source could not be checked.');
      if (JSON.stringify(result.data).length > limit)
        throw new Error('The source record was too large.');
      return result.data;
    } finally {
      clearTimeout(timer);
      stop.removeEventListener('abort', onAbort);
      active--;
      waiting.shift()?.();
    }
  };
  const recordsFor = async (
    values: string[],
    load: (id: string, stop: AbortSignal) => Promise<ObservationRecord>,
  ) => {
    const records: ObservationRecord[] = new Array(values.length);
    let index = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, values.length) }, async () => {
        while (index < values.length) {
          const current = index++;
          signal.throwIfAborted();
          const deadline = new AbortController();
          const timer = setTimeout(
            () => deadline.abort(new Error('The source record timed out.')),
            ids ? 15000 : 5000,
          );
          try {
            records[current] = await load(
              values[current],
              AbortSignal.any([signal, deadline.signal]),
            );
          } catch {
            signal.throwIfAborted();
            records[current] = {
              id: values[current],
              version: 'unknown',
              available: false,
              error: 'unavailable',
              data: {},
            };
          } finally {
            clearTimeout(timer);
          }
        }
      }),
    );
    return records;
  };
  return { ids, cursor, since, asOf, get, recordsFor };
}

async function readGmail(
  client: Client,
  accountId: string,
  input: Query,
  signal: AbortSignal,
): Promise<ObservationBatch> {
  const { ids, cursor, since, asOf, get, recordsFor } = reader(client, accountId, input, signal);
  const base = 'https://gmail.googleapis.com/gmail/v1/users/me/threads';
  const list = ids
    ? { threads: ids.map((id) => ({ id })), nextPageToken: undefined }
    : z
        .object({
          threads: z.array(z.object({ id })).max(20).default([]),
          nextPageToken: page.optional(),
        })
        .parse(
          await get(base, [
            [
              'q',
              `after:${Math.floor(Math.max(asOf - 30 * 86400000, since ? new Date(since).getTime() : 0) / 1000)} before:${Math.ceil(asOf / 1000) + 1} -in:spam -in:trash`,
            ],
            ['maxResults', 20],
            ['fields', 'threads/id,nextPageToken'],
            ...(cursor ? [['pageToken', cursor] as [string, string]] : []),
          ]),
        );
  const records = await recordsFor(
    list.threads.map((item) => item.id),
    async (threadId, stop) => {
      const raw = await get(
        `${base}/${threadId}`,
        [
          ['format', 'metadata'],
          ['fields', 'id,historyId,messages(id,internalDate,labelIds)'],
        ],
        stop,
        2_000_000,
      );
      if (raw === null) return { id: threadId, version: 'unavailable', available: false, data: {} };
      const thread = z
        .object({
          id,
          historyId: z.string().optional(),
          messages: z
            .array(
              z.object({
                id,
                internalDate: z.string().regex(/^\d{1,16}$/),
                labelIds: z.array(z.string()).max(100).optional(),
              }),
            )
            .min(1),
        })
        .parse(raw);
      if (thread.id !== threadId) throw new Error('The source identity changed.');
      const messages = thread.messages
        .filter(
          (message) =>
            !message.labelIds?.some((label) => ['DRAFT', 'SPAM', 'TRASH'].includes(label)),
        )
        .sort((a, b) => Number(a.internalDate) - Number(b.internalDate));
      if (!messages.length)
        return {
          id: threadId,
          version: version(
            messages.map(({ id, internalDate, labelIds }) => ({
              id,
              internalDate,
              sent: labelIds?.includes('SENT') ?? false,
            })),
          ),
          available: false,
          data: {},
        };
      const selected = messages.slice(ids ? -8 : -1);
      const loaded = await Promise.all(
        selected.map(async (message) => {
          const value = await get(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}`,
            [
              ['format', ids ? 'full' : 'metadata'],
              [
                'fields',
                ids
                  ? 'id,internalDate,labelIds,snippet,payload'
                  : 'id,internalDate,labelIds,snippet,payload/headers',
              ],
              ...(!ids
                ? ([
                    ['metadataHeaders', 'From'],
                    ['metadataHeaders', 'To'],
                    ['metadataHeaders', 'Subject'],
                  ] as Array<[string, string]>)
                : []),
            ],
            stop,
          );
          const mail = messageSchema
            .extend({ snippet: z.string().max(2000).optional() })
            .parse(value);
          if (mail.id !== message.id) throw new Error('The source identity changed.');
          const body = ids ? messageText(mail.payload) : undefined;
          const header = (name: string) =>
            mail.payload.headers
              .find((item) => item.name.toLowerCase() === name)
              ?.value.slice(0, 2000) ?? '';
          const text = body ?? mail.snippet ?? '';
          return {
            id: mail.id,
            from: header('from'),
            to: header('to'),
            subject: header('subject'),
            receivedAt: new Date(Number(mail.internalDate)).toISOString(),
            sent: mail.labelIds?.includes('SENT') ?? false,
            text: text.slice(0, 8000),
            truncated: !ids || body === undefined || text.length > 8000,
          };
        }),
      );
      const latest = z.object({ id, historyId: z.string().optional() }).parse(
        await get(
          `${base}/${threadId}`,
          [
            ['format', 'minimal'],
            ['fields', 'id,historyId'],
          ],
          stop,
        ),
      );
      if (latest.id !== threadId || latest.historyId !== thread.historyId)
        throw new Error('The source changed during its read.');
      return {
        id: threadId,
        version: version(
          messages.map(({ id, internalDate, labelIds }) => ({
            id,
            internalDate,
            sent: labelIds?.includes('SENT') ?? false,
          })),
        ),
        available: true,
        url: `https://mail.google.com/mail/u/0/#all/${threadId}`,
        data: { truncated: !ids || messages.length > 8, messages: loaded },
      };
    },
  );
  return { records, ...(list.nextPageToken ? { nextCursor: list.nextPageToken } : {}) };
}

async function readCalendar(
  client: Client,
  accountId: string,
  input: Query,
  signal: AbortSignal,
): Promise<ObservationBatch> {
  const { ids, cursor, since, asOf, get, recordsFor } = reader(client, accountId, input, signal);
  const day = Date.parse(new Date(asOf).toISOString().slice(0, 10));
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  const event = z.object({
    id,
    etag: z.string().max(500).optional(),
    status: z.string().max(50),
    summary: z.string().max(2000).optional(),
    description: z.string().max(16000).optional(),
    location: z.string().max(2000).optional(),
    updated: z.string().max(100).optional(),
    start: z
      .object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .optional(),
    end: z
      .object({
        dateTime: z.string().optional(),
        date: z.string().optional(),
        timeZone: z.string().optional(),
      })
      .optional(),
    organizer: z
      .object({ email: z.string().max(500).optional(), self: z.boolean().optional() })
      .optional(),
    attendees: z
      .array(
        z.object({
          email: z.string().max(500).optional(),
          self: z.boolean().optional(),
          responseStatus: z.string().max(50).optional(),
        }),
      )
      .optional(),
  });
  const list = ids
    ? { items: ids.map((id) => ({ id })), nextPageToken: undefined }
    : z
        .object({
          items: z.array(z.object({ id }).passthrough()).max(20).default([]),
          nextPageToken: page.optional(),
        })
        .parse(
          await get(base, [
            ['timeMin', new Date(day - 86400000).toISOString()],
            ['timeMax', new Date(day + 31 * 86400000).toISOString()],
            ['singleEvents', 'true'],
            ['showDeleted', 'true'],
            ['maxResults', 20],
            ['orderBy', 'startTime'],
            ...(since &&
            new Date(since).toISOString().slice(0, 10) === new Date(asOf).toISOString().slice(0, 10)
              ? [['updatedMin', since] as [string, string]]
              : []),
            ...(cursor ? [['pageToken', cursor] as [string, string]] : []),
          ]),
        );
  const records = await recordsFor(
    list.items.map((item) => item.id),
    async (eventId, stop) => {
      const value = ids
        ? await get(`${base}/${eventId}`, [], stop)
        : list.items.find((item) => item.id === eventId);
      if (value === null)
        return { id: eventId, version: 'unavailable', available: false, data: {} };
      const item = event.parse(value);
      if (item.id !== eventId) throw new Error('The source identity changed.');
      return { id: item.id, version: version(item), available: true, data: item };
    },
  );
  return { records, ...(list.nextPageToken ? { nextCursor: list.nextPageToken } : {}) };
}

async function calendarChangeToken(
  client: Client,
  accountId: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await client.proxyExecute(
    {
      connectedAccountId: accountId,
      endpoint: 'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      method: 'GET',
      parameters: [
        { in: 'query', name: 'fields', value: 'etag' },
        { in: 'query', name: 'maxResults', value: 1 },
      ],
    },
    { signal },
  );
  signal.throwIfAborted();
  if (result.status !== 200) throw new Error('The source change check failed.');
  const { etag } = z.object({ etag: z.string().min(1).max(1024) }).parse(result.data);
  return version([etag, new Date().toISOString().slice(0, 10)]);
}
