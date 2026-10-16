import { randomBytes } from 'node:crypto';

export type WriteKind = 'draft' | 'send' | 'create' | 'update' | 'post' | 'delete';
export type Args = Record<string, any>;

export interface Tool {
  slug: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write?: WriteKind;
  run(args: Args): unknown;
}

export interface Upload {
  name: string;
  mimeType: string;
  bytes: Buffer;
}

export const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
});
export const str = (description: string) => ({ type: 'string', description });
export const num = (description: string) => ({ type: 'integer', description });
export const bool = (description: string) => ({ type: 'boolean', description });
export const list = (items: unknown, description: string) => ({
  type: 'array',
  items,
  description,
});
export const uploadable = (description: string) => ({
  type: 'object',
  description,
  file_uploadable: true,
  properties: { name: str('File name.'), mimetype: str('MIME type.'), s3key: str('Upload key.') },
  required: ['name', 'mimetype', 's3key'],
});
export const id = (prefix = '') => prefix + randomBytes(8).toString('hex');
export const iso = (at: number) => new Date(at).toISOString();

const uploads = new Map<string, Upload>();

export function storeUpload(file: Upload) {
  const key = `uploads/${id()}/${file.name}`;
  uploads.set(key, file);
  return { name: file.name, mimetype: file.mimeType, s3key: key };
}

export function readUploads(value: unknown): Upload[] {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((item) => {
    const key = item && typeof item === 'object' ? String((item as Args).s3key ?? '') : '';
    const file = uploads.get(key);
    if (!file) throw new Error('The attachment was not uploaded. Upload the file first.');
    return file;
  });
}

export function words(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(words).filter(Boolean).join('\n');
  if (value && typeof value === 'object')
    return Object.entries(value)
      .filter(
        ([key]) =>
          ![
            'type',
            'object',
            'color',
            'annotations',
            'href',
            'link',
            'block_property',
            'language',
          ].includes(key),
      )
      .map(([, item]) => words(item))
      .filter(Boolean)
      .join(' ');
  return '';
}
