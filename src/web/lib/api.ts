export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly step?: string,
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
  } finally {
    if (controller) privateRequests.delete(controller);
  }
}

async function requireOk(response: Response, signal?: AbortSignal) {
  if (response.ok) return;
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    step?: unknown;
  } | null;
  signal?.throwIfAborted();
  throw new ApiError(
    typeof body?.error === 'string' ? body.error : 'The request could not be completed. Try again.',
    response.status,
    typeof body?.step === 'string' ? body.step : undefined,
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
