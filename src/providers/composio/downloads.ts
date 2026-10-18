import { publicUrl, type AddressResolver } from '../agent-browser/network.ts';
import { requestPublicPreview, type PreviewRequest } from '../public-web/link-preview.ts';
import { appFile } from '../app-files.ts';
import { IntegrationDownload } from '../../ports/integrations.ts';
import { fileBytes } from '../../shared/files.ts';

async function interrupted<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        abort = () => reject(new DOMException('File download was cancelled.', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export function createComposioFiles(
  options: {
    resolver?: AddressResolver;
    request?: PreviewRequest;
  } = {},
) {
  const request = options.request ?? requestPublicPreview;
  async function download(url: string, signal: AbortSignal): Promise<Uint8Array> {
    let current = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      signal.throwIfAborted();
      if (new URL(current).protocol !== 'https:') throw new Error('The file address is invalid.');
      const resolved = await interrupted(() => publicUrl(current, options.resolver), signal);
      signal.throwIfAborted();
      const response = await interrupted(
        () =>
          request({
            ...resolved,
            signal,
            maxBytes: fileBytes,
            metadata: false,
            purpose: 'download',
          }),
        signal,
      );
      signal.throwIfAborted();
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!response.headers.location) throw new Error('The file redirect is invalid.');
        current = new URL(response.headers.location, resolved.url).href;
        continue;
      }
      if (response.status !== 200) throw new Error('The file response is unavailable.');
      return response.body;
    }
    throw new Error('Too many file redirects.');
  }
  const envelope = (result: unknown): unknown => {
    const data = (result as { data?: unknown } | null)?.data;
    const response = (data as { response?: unknown } | null)?.response;
    if (typeof response !== 'string' || !response.includes('"s3url"')) return result;
    try {
      return {
        ...(result as object),
        data: { ...(data as object), response: JSON.parse(response) },
      };
    } catch {
      return result;
    }
  };
  return async (result: unknown, signal: AbortSignal): Promise<unknown> => {
    const visit = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(visit));
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
      const record = value as Record<string, unknown>;
      if (typeof record.s3url !== 'string')
        return Object.fromEntries(
          await Promise.all(
            Object.entries(record).map(async ([key, item]) => [key, await visit(item)]),
          ),
        );
      const url = record.s3url;
      const name = record.name ?? new URL(url, 'https://invalid').pathname;
      const mimeType = record.mimetype ?? record.mimeType;
      return new IntegrationDownload(async () => {
        try {
          const operation = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
          return appFile(name, mimeType, await download(url, operation));
        } catch (error) {
          signal.throwIfAborted();
          return {
            name,
            mimeType,
            error: `The file could not be downloaded: ${(error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/g, '[file URL]')}`,
          };
        }
      });
    };
    return visit(envelope(result));
  };
}
