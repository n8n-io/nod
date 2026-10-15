import type { IntegrationFile } from '../ports/integrations.ts';
import { fileBytes, fileName } from '../shared/files.ts';

const mime = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const extensions: Record<string, string[]> = {
  'image/png': ['.png'],
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/gif': ['.gif'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
};

export function appFile(name: unknown, mimeType: unknown, bytes: Uint8Array): IntegrationFile {
  if (!bytes.byteLength || bytes.byteLength > fileBytes)
    throw new Error('The file size is unsupported.');
  const type = typeof mimeType === 'string' ? mimeType.split(';')[0]!.trim().toLowerCase() : '';
  const safeType = mime.test(type) ? type : 'application/octet-stream';
  let safeName = (typeof name === 'string' ? name : '')
    .split(/[\\/]/)
    .at(-1)!
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!safeName || safeName === '.' || safeName === '..') safeName = 'file';
  const known = extensions[safeType];
  if (known && !known.some((extension) => safeName.toLowerCase().endsWith(extension)))
    safeName += known[0];
  return { name: fileName(safeName), mimeType: safeType, bytes };
}

export function mcpFiles(result: unknown): unknown {
  if (
    !result ||
    typeof result !== 'object' ||
    !Array.isArray((result as Record<string, unknown>).content)
  )
    return result;
  const record = result as Record<string, unknown> & { content: unknown[] };
  return {
    ...record,
    content: record.content.map((block, index) => {
      if (!block || typeof block !== 'object') return block;
      const item = block as Record<string, unknown>;
      const resource =
        item.type === 'resource' && item.resource && typeof item.resource === 'object'
          ? (item.resource as Record<string, unknown>)
          : undefined;
      const data = item.type === 'image' || item.type === 'audio' ? item.data : resource?.blob;
      if (typeof data !== 'string') return block;
      if (data.length > Math.ceil(fileBytes / 3) * 4 + 4)
        return {
          type: item.type,
          mimeType: (resource ?? item).mimeType,
          error: 'The file is too large.',
        };
      const source = resource ?? item;
      const uri = typeof source.uri === 'string' ? source.uri.split(/[?#]/)[0] : undefined;
      try {
        return appFile(
          uri || `${item.type}-${index + 1}`,
          source.mimeType,
          Buffer.from(data, 'base64'),
        );
      } catch (error) {
        return {
          type: item.type,
          mimeType: source.mimeType,
          error: `The file could not be opened: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }),
  };
}
