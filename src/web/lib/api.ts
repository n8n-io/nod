import type { ModelWorkspace } from '../../shared/models';
import { feedbackActivity } from './feedback-activity';
import { feedbackClient } from './feedback-client';
import { recordFeedbackError, setFeedbackErrorOwner } from './feedback-errors';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly step?: string,
    readonly workspaces?: ModelWorkspace[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const routeWords = new Set(
  'accounts activity archive around audio authorize azure catalog commands complete connect connections context details disconnect discovery done endpoints entries export forget icon import instance introduction keep-out keys limit mcp model model-setup navigate notes oauth opened pairing prepare preview profile reaction reconnect refresh renew report reset restore retry routes schedule-draft screen search selection sessions setup-cancel setup-return setup-status skills status steps stop stream suggestions survey-seen telegram updates-email voices welcome whatsapp work'.split(
    ' ',
  ),
);

let requestAccount: string | null = null;
let accountGeneration = 0;
const privateRequests = new Set<AbortController>();

export function requestAccountVersion() {
  return accountGeneration;
}

export function setRequestAccount(id: string | null) {
  if (id === requestAccount) return;
  requestAccount = id;
  accountGeneration++;
  feedbackActivity.clear();
  setFeedbackErrorOwner(id);
  for (const request of privateRequests) request.abort();
  privateRequests.clear();
}

async function request<T>(
  path: string,
  options: RequestInit,
  consume: (response: Response, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData))
    headers.set('Content-Type', 'application/json');
  const expectedAccount = !['/api/session', '/api/access'].includes(path) ? requestAccount : null;
  const generation = accountGeneration;
  const controller = expectedAccount ? new AbortController() : null;
  if (expectedAccount) {
    headers.set('X-nod-Account', expectedAccount);
    privateRequests.add(controller!);
  }
  const signal = controller
    ? options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal
    : (options.signal ?? undefined);
  let status = 0;
  const method = options.method?.toUpperCase() ?? 'GET';
  const failed = (detail: string) => {
    if (generation !== accountGeneration) return;
    const route = path
      .split('?')[0]
      .split('/')
      .map((segment, index) => (index < 3 || routeWords.has(segment) ? segment : ':id'))
      .join('/');
    recordFeedbackError('error', `api ${method} ${route} ${detail}`);
  };
  const failure = (reason: string) => {
    if (generation !== accountGeneration) return;
    if (reason !== 'http') failed(status ? `${status} ${reason}` : reason);
    const segment = path.split(/[/?]/)[2];
    const area =
      (
        {
          messages: 'chat',
          thread: 'chat',
          conversation: 'chat',
          state: 'chat',
          apps: 'apps',
          integrations: 'apps',
          models: 'models',
          browser: 'browser',
          'browser-handoff': 'browser',
          channels: 'channels',
          'channel-settings': 'channels',
          tasks: 'tasks',
          schedules: 'tasks',
          'schedule-runs': 'tasks',
          usage: 'usage',
          vault: 'vault',
          'credential-requests': 'vault',
          'payment-requests': 'vault',
          preferences: 'settings',
          privacy: 'settings',
          configuration: 'settings',
          trust: 'settings',
          account: 'settings',
          onboarding: 'onboarding',
          feedback: 'feedback',
        } as Record<string, string>
      )[segment] ?? 'other';
    feedbackActivity.record('request_failed', {
      area,
      method,
      status,
      reason,
    });
  };
  try {
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: 'same-origin',
      signal,
    });
    if (
      controller?.signal.aborted ||
      options.signal?.aborted ||
      (expectedAccount && generation !== accountGeneration)
    )
      throw new DOMException('The account changed.', 'AbortError');
    status = response.status;
    const date = Date.parse(response.headers.get('Date') ?? '');
    if (Number.isFinite(date)) feedbackClient.clockOffsetMs = date - Date.now();
    if (!response.ok) {
      failure('http');
      void response
        .clone()
        .json()
        .catch(() => null)
        .then((body: { error?: unknown; message?: unknown; code?: unknown } | null) => {
          const message = [body?.message, body?.error].find((value) => typeof value === 'string');
          const code = typeof body?.code === 'string' ? ` (${body.code})` : '';
          failed(
            `${response.status}${message || code ? `: ${message ?? ''}${code}` : ''}`.slice(0, 500),
          );
        });
    }
    if (
      expectedAccount &&
      response.status === 401 &&
      typeof window !== 'undefined' &&
      generation === accountGeneration &&
      !options.signal?.aborted
    )
      window.dispatchEvent(new Event('nod:unauthorized'));
    const result = await consume(response, signal);
    if (
      controller?.signal.aborted ||
      options.signal?.aborted ||
      (expectedAccount && generation !== accountGeneration)
    )
      throw new DOMException('The account changed.', 'AbortError');
    return result;
  } catch (error) {
    const timedOut = signal?.aborted && signal.reason?.name === 'TimeoutError';
    if ((!signal?.aborted || timedOut) && (status === 0 || status < 400))
      failure(timedOut ? 'timeout' : status === 0 ? 'network' : 'invalid_response');
    throw error;
  } finally {
    if (controller) privateRequests.delete(controller);
  }
}

export async function responseError(response: Response, signal?: AbortSignal) {
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    message?: unknown;
    step?: unknown;
    workspaces?: unknown;
  } | null;
  signal?.throwIfAborted();
  const workspaces =
    Array.isArray(body?.workspaces) &&
    body.workspaces.every(
      (workspace: unknown): workspace is ModelWorkspace =>
        typeof workspace === 'object' &&
        workspace !== null &&
        'id' in workspace &&
        typeof workspace.id === 'string' &&
        'name' in workspace &&
        typeof workspace.name === 'string',
    )
      ? body.workspaces.map(({ id, name }) => ({ id, name }))
      : undefined;
  const reason = [body?.error, body?.message].find(
    (value): value is string => typeof value === 'string' && !!value.trim(),
  );
  return new ApiError(
    reason ?? `The request could not be completed (HTTP ${response.status}).`,
    response.status,
    typeof body?.step === 'string' ? body.step : undefined,
    workspaces,
  );
}

async function requireOk(response: Response, signal?: AbortSignal) {
  if (!response.ok) throw await responseError(response, signal);
}

export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  return request(path, options, async (response, signal) => {
    await requireOk(response, signal);
    return response.json() as Promise<T>;
  });
}

export function apiResponse(path: string, options: RequestInit = {}): Promise<Response> {
  return request(
    path,
    options,
    async (response) =>
      new Response(response.status === 204 ? null : await response.arrayBuffer(), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
  );
}

export function apiStream(
  path: string,
  options: RequestInit,
  consume: (body: ReadableStream<Uint8Array>, signal?: AbortSignal) => Promise<void>,
) {
  return request(path, options, async (response, signal) => {
    await requireOk(response, signal);
    if (!response.body) throw new Error('The browser view could not connect.');
    await consume(response.body, signal);
  });
}

export async function apiBytes(path: string, limit: number, options: RequestInit = {}) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  await apiStream(path, options, async (body, signal) => {
    const reader = body.getReader();
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > limit) throw new Error('The file is too large to preview.');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  });
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function post<T>(path: string, body: unknown = {}) {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
