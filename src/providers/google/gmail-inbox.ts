import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  IntegrationInboxCursorExpired,
  IntegrationInboxTransientError,
  type IntegrationInboxPoll,
} from '../../ports/integrations.ts';
import type { GoogleProxy } from './verification-email.ts';

export async function pollGmailInbox(
  client: GoogleProxy,
  accountId: string,
  cursor: string | null,
  signal: AbortSignal,
): Promise<IntegrationInboxPoll> {
  const deadline = AbortSignal.timeout(25_000);
  const operation = AbortSignal.any([signal, deadline]);
  let phase = 'cursor';
  let category = 'cursor';
  let status: number | undefined;
  const id = z.string().regex(/^[a-zA-Z0-9_-]{1,200}$/);
  const historyId = z.string().regex(/^\d{1,32}$/);
  const addedMessage = z.object({ message: z.object({ id }) });
  const mailHeader = z.object({ name: z.string(), value: z.string() });
  const stateSchema = z.object({
    accountId: z.string().min(1).max(200),
    historyId,
    pageToken: z.string().min(1).max(2048).optional(),
    pending: z.array(id).max(1000).default([]),
    finalHistoryId: historyId.optional(),
  });
  let retriesRemaining = 2;
  const retryableStatus = (value: unknown): value is number =>
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value === 408 || value === 429 || (value >= 500 && value <= 599));
  function proxyCode(value: unknown) {
    if (!value || typeof value !== 'object') return undefined;
    const detail = (value as Record<string, unknown>).error;
    const candidate =
      typeof detail === 'string'
        ? detail
        : detail && typeof detail === 'object'
          ? ((detail as Record<string, unknown>).code ?? (detail as Record<string, unknown>).error)
          : undefined;
    const code = z
      .enum([
        'installation_busy',
        'public_budget_exceeded',
        'rate_limited',
        'service_unavailable',
        'security_service_unavailable',
      ])
      .safeParse(candidate);
    return code.success ? code.data : undefined;
  }
  function transientFailure(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 3 && current && typeof current === 'object'; depth++) {
      const detail = current as Record<string, unknown>;
      const code = proxyCode(detail.error);
      if (retryableStatus(detail.status))
        return new IntegrationInboxTransientError(detail.status, code);
      if (detail.reason === 'unavailable' || detail.reason === 'timeout')
        return new IntegrationInboxTransientError(undefined, code);
      if (current instanceof Error) {
        const kind = current.constructor.name;
        if (kind === 'APIConnectionError' || kind === 'APIConnectionTimeoutError')
          return new IntegrationInboxTransientError(undefined, code);
      }
      current = detail.cause;
    }
  }
  async function get(path: string, parameters: Array<[string, string | number]>) {
    for (;;) {
      operation.throwIfAborted();
      phase = path === 'profile' ? 'baseline' : path === 'history' ? 'history' : 'message';
      category = 'request';
      status = undefined;
      try {
        const response = await client.proxyExecute(
          {
            connectedAccountId: accountId,
            endpoint: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
            method: 'GET',
            parameters: parameters.map(([name, value]) => ({ in: 'query', name, value })),
          },
          { signal: operation },
        );
        operation.throwIfAborted();
        status = response.status;
        if (response.status === 404 && path.startsWith('messages/')) return null;
        if (response.status === 404 && path === 'history')
          throw new IntegrationInboxCursorExpired();
        category = 'http';
        if (response.status !== 200) {
          if (retryableStatus(response.status))
            throw new IntegrationInboxTransientError(response.status, proxyCode(response.data));
          throw new Error();
        }
        category = 'response_size';
        if (JSON.stringify(response.data).length > 1_000_000) {
          if (path === 'history') throw new IntegrationInboxCursorExpired();
          throw new Error();
        }
        category = 'response';
        return response.data;
      } catch (error) {
        if (operation.aborted) throw error;
        const transient =
          error instanceof IntegrationInboxTransientError ? error : transientFailure(error);
        if (!transient) throw error;
        if (
          !retriesRemaining ||
          (transient.code &&
            (transient.code === 'public_budget_exceeded' ||
              !(error instanceof IntegrationInboxTransientError)))
        )
          throw transient;
        const attempt = 2 - retriesRemaining;
        retriesRemaining--;
        await delay(350 * 2 ** attempt + Math.floor(Math.random() * 150), undefined, {
          signal: operation,
        });
      }
    }
  }
  try {
    if (cursor === null) {
      const baseline = z
        .object({ historyId })
        .parse(await get('profile', [['fields', 'historyId']]));
      return {
        cursor: JSON.stringify(stateSchema.parse({ accountId, historyId: baseline.historyId })),
        hasMore: false,
        messages: [],
      };
    }
    if (cursor.length > 220_000) throw new Error();
    const state = stateSchema.parse(JSON.parse(cursor));
    if (state.accountId !== accountId) throw new Error();
    if (!state.pending.length) {
      const page = z
        .object({
          historyId,
          nextPageToken: z.string().min(1).max(2048).optional(),
          history: z
            .array(
              z.object({
                messagesAdded: z.array(addedMessage).optional(),
              }),
            )
            .max(20)
            .optional(),
        })
        .parse(
          await get('history', [
            ['startHistoryId', state.historyId],
            ['historyTypes', 'messageAdded'],
            ['labelId', 'INBOX'],
            ['maxResults', 20],
            ['fields', 'history/messagesAdded/message/id,historyId,nextPageToken'],
            ...(state.pageToken ? [['pageToken', state.pageToken] as [string, string]] : []),
          ]),
        );
      const pending = stateSchema.shape.pending.safeParse([
        ...new Set(
          page.history?.flatMap(
            (entry) => entry.messagesAdded?.map(({ message }) => message.id) ?? [],
          ),
        ),
      ]);
      if (!pending.success) throw new IntegrationInboxCursorExpired();
      state.pending = pending.data;
      state.pageToken = page.nextPageToken;
      state.finalHistoryId = page.nextPageToken ? undefined : page.historyId;
    }
    const messages = [];
    let consumed = 0;
    let retryAfterMs: number | undefined;
    for (const pendingId of state.pending.slice(0, 20)) {
      let response;
      try {
        response = await get(`messages/${pendingId}`, [
          ['format', 'metadata'],
          ['fields', 'id,threadId,internalDate,labelIds,payload/headers'],
        ]);
      } catch (error) {
        if (!signal.aborted && consumed) {
          if (deadline.aborted) {
            retryAfterMs = 60_000;
            break;
          }
          if (error instanceof IntegrationInboxTransientError) {
            retryAfterMs = error.retryAfterMs;
            console.warn(
              JSON.stringify({
                event: 'gmail_inbox_poll_deferred',
                timestamp: new Date().toISOString(),
                phase,
                category,
                ...(error.status === undefined ? {} : { status: error.status }),
                ...(error.code ? { code: error.code } : {}),
                consumed,
              }),
            );
            break;
          }
        }
        throw error;
      }
      if (response === null) {
        consumed++;
        continue;
      }
      const message = z
        .object({
          id,
          threadId: id,
          internalDate: z.string().regex(/^\d{1,16}$/),
          labelIds: z.array(z.string().max(200)).max(100).default([]),
          payload: z.object({
            headers: z.array(mailHeader).default([]),
          }),
        })
        .parse(response);
      if (message.id !== pendingId) {
        category = 'identity';
        throw new Error();
      }
      consumed++;
      if (!message.labelIds.includes('INBOX')) continue;
      const header = (name: string) =>
        message.payload.headers
          .find((item) => item.name.toLowerCase() === name)
          ?.value.replace(/[\u0000-\u001f]/g, ' ')
          .slice(0, 1000) ?? '';
      messages.push({
        id: message.id,
        threadId: message.threadId,
        subject: header('subject'),
        sender: header('from'),
        receivedAt: new Date(Number(message.internalDate)).toISOString(),
      });
    }
    signal.throwIfAborted();
    state.pending = state.pending.slice(consumed);
    if (!state.pending.length && state.finalHistoryId) {
      state.historyId = state.finalHistoryId;
      delete state.finalHistoryId;
    }
    return {
      cursor: JSON.stringify(state),
      hasMore: Boolean(state.pending.length || state.pageToken),
      ...(retryAfterMs ? { retryAfterMs } : {}),
      messages,
    };
  } catch (error) {
    if (signal.aborted) throw new DOMException('Inbox check was cancelled.', 'AbortError');
    const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
    const errorKind =
      error instanceof Error
        ? new Map([
            ['APIConnectionError', 'connection'],
            ['APIConnectionTimeoutError', 'connection_timeout'],
            ['APIUserAbortError', 'request_aborted'],
            ['ComposioRequestCancelledError', 'request_cancelled'],
            ['ValidationError', 'validation'],
            ['SyntaxError', 'invalid_json'],
            ['TypeError', 'type'],
          ]).get(error.constructor.name)
        : undefined;
    const causes: Record<string, unknown>[] = [];
    let cause: unknown = error;
    for (let depth = 0; depth < 3 && cause && typeof cause === 'object'; depth++) {
      const current = cause as Record<string, unknown>;
      causes.push(current);
      cause = current.cause;
    }
    const httpStatus = [
      status,
      ...causes.flatMap((cause) => [cause.status, cause.statusCode]),
    ].find(
      (value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599,
    );
    const causeCode = causes
      .map((cause) => cause.code)
      .find(
        (code): code is string =>
          typeof code === 'string' &&
          [
            'ECONNRESET',
            'ECONNREFUSED',
            'EHOSTUNREACH',
            'ENETUNREACH',
            'ENOTFOUND',
            'EAI_AGAIN',
            'ETIMEDOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
            'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_SOCKET',
          ].includes(code),
      );
    const fields = [
      'accountId',
      'historyId',
      'pending',
      'pageToken',
      'finalHistoryId',
      'history',
      'messagesAdded',
      'message',
      'id',
      'threadId',
      'internalDate',
      'labelIds',
      'payload',
      'headers',
      'name',
      'value',
    ];
    console.warn(
      JSON.stringify({
        event: 'gmail_inbox_poll_failed',
        timestamp: new Date().toISOString(),
        phase,
        category: issue
          ? 'schema'
          : error instanceof IntegrationInboxCursorExpired
            ? 'expired'
            : error instanceof RangeError
              ? 'date'
              : operation.aborted
                ? 'timeout'
                : category,
        ...(httpStatus === undefined ? {} : { status: httpStatus }),
        ...(error instanceof IntegrationInboxTransientError && error.code
          ? { code: error.code }
          : {}),
        ...(errorKind ? { errorKind } : {}),
        ...(causeCode ? { causeCode } : {}),
        ...(issue
          ? {
              issue: issue.code,
              field: issue.path
                .slice(0, 8)
                .map((part) =>
                  typeof part === 'number'
                    ? '[]'
                    : typeof part === 'string' && fields.includes(part)
                      ? part
                      : 'unknown',
                )
                .join('.'),
            }
          : {}),
      }),
    );
    if (error instanceof IntegrationInboxCursorExpired) throw error;
    if (error instanceof IntegrationInboxTransientError) throw error;
    if (deadline.aborted) throw new IntegrationInboxTransientError(httpStatus);
    throw new Error('The Gmail inbox could not be checked.');
  }
}
