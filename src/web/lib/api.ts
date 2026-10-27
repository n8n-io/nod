import type { ModelWorkspace } from '../../shared/models';
import { feedbackActivity } from './feedback-activity';
import { setFeedbackErrorOwner } from './feedback-errors';

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
  const failure = (reason: string) => {
    if (generation !== accountGeneration) return;
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
      method: options.method?.toUpperCase() ?? 'GET',
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
    if (!response.ok) failure('http');
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

async function requireOk(response: Response, signal?: AbortSignal) {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
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
  throw new ApiError(
    typeof body?.error === 'string' ? body.error : 'The request could not be completed. Try again.',
    response.status,
    typeof body?.step === 'string' ? body.step : undefined,
    workspaces,
  );
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
