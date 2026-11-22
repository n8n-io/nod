import { z } from 'zod';
import { IntegrationDownload } from '../../ports/integrations.ts';
import { fileBytes } from '../../shared/files.ts';
import { appFile } from '../app-files.ts';

const transitFileId = /^[a-f0-9]{32}(?:\.[a-z0-9]{1,16})?$/;

const transitFile = z
  .object({
    fileId: z.string().regex(transitFileId),
    downloadUrl: z.string().min(1).optional(),
    transitUrl: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    fileName: z.string().min(1).optional(),
    mimeType: z.string().min(1).optional(),
  })
  .refine((file) => (file.downloadUrl ?? file.transitUrl) && (file.name ?? file.fileName));

function stringProperty(value: unknown) {
  return Boolean(
    value && typeof value === 'object' && (value as Record<string, unknown>).type === 'string',
  );
}

export function transitFileInputSchema(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as Record<string, unknown>;
  if (schema.type !== 'object') return false;
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return false;
  const entries = properties as Record<string, unknown>;
  const names = Object.keys(entries);
  if (!names.every((name) => ['fileId', 'name', 'mimeType'].includes(name))) return false;
  if (!names.every((name) => stringProperty(entries[name]))) return false;
  const required = schema.required;
  if (!Array.isArray(required) || !required.includes('fileId')) return false;
  if (!required.every((name) => name === 'fileId')) return false;
  const description = (entries.fileId as Record<string, unknown> | undefined)?.description;
  return (
    (names.length === 3 && schema.additionalProperties === false) ||
    (typeof description === 'string' && /\btransit file\b/i.test(description))
  );
}

function transitFileIdField(value: unknown) {
  if (!stringProperty(value)) return false;
  const description = (value as Record<string, unknown>).description;
  return typeof description === 'string' && /\btransit file\b/i.test(description);
}

export function markTransitFileInputs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(markTransitFileInputs);
  if (!value || typeof value !== 'object') return value;
  if (transitFileInputSchema(value)) return { ...value, file_uploadable: true };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'fileId' && transitFileIdField(item)
        ? { ...(item as object), file_uploadable: true }
        : markTransitFileInputs(item),
    ]),
  );
}

export function unwrapTransitFileIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrapTransitFileIds);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const wrapped = z.object({ fileId: z.string() }).strict().safeParse(item);
      return [
        key,
        key === 'fileId' && wrapped.success ? wrapped.data.fileId : unwrapTransitFileIds(item),
      ];
    }),
  );
}

export function createOpenConnectorFiles(options: { origin: string; request?: typeof fetch }) {
  const request = options.request ?? fetch;
  async function download(fileId: string, signal: AbortSignal): Promise<Uint8Array> {
    const deadline = AbortSignal.timeout(30_000);
    const operation = AbortSignal.any([signal, deadline]);
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await request(`${options.origin}/api/files/${encodeURIComponent(fileId)}`, {
        redirect: 'error',
        signal: operation,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new Error(
        deadline.aborted
          ? `OpenConnector did not serve transit file ${fileId} within 30 s.`
          : `OpenConnector could not be reached for transit file ${fileId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > fileBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(
          `OpenConnector served transit file ${fileId} larger than ${fileBytes / 1024 / 1024} MB.`,
        );
      }
      chunks.push(chunk.value);
    }
    const bytes = Buffer.concat(chunks);
    if (!response.ok) {
      const detail = bytes.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500);
      throw new Error(
        `OpenConnector answered HTTP ${response.status} for transit file ${fileId}${detail ? `: ${detail}` : '.'}${response.status === 404 ? ' The file has expired, or it was returned by a hosted connection and is not stored in this OpenConnector.' : ''}`,
      );
    }
    if (!bytes.byteLength) throw new Error(`OpenConnector served transit file ${fileId} empty.`);
    return bytes;
  }
  return async (result: unknown, signal: AbortSignal): Promise<unknown> => {
    const visit = async (value: unknown): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(visit));
      if (!value || Object.getPrototypeOf(value) !== Object.prototype) return value;
      const found = transitFile.safeParse(value);
      if (found.success) {
        const { fileId } = found.data;
        const name = (found.data.name ?? found.data.fileName)!
          .replace(/[\u0000-\u001f\u007f]/g, ' ')
          .slice(0, 255);
        const mimeType = found.data.mimeType ?? 'application/octet-stream';
        return new IntegrationDownload(async () => {
          try {
            return appFile(name, mimeType, await download(fileId, signal));
          } catch (error) {
            signal.throwIfAborted();
            return {
              name,
              mimeType,
              error: `The file could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        });
      }
      return Object.fromEntries(
        await Promise.all(
          Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
            key,
            await visit(item),
          ]),
        ),
      );
    };
    return visit(result);
  };
}
