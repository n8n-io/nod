import { z } from 'zod';
import type { IntegrationFile } from '../ports/integrations.ts';

export const workspaceFileInput = z
  .object({
    workspaceFile: z.string().min(1).max(4096),
    mimeType: z
      .string()
      .max(200)
      .regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    name: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .optional(),
  })
  .strict();

export function hasWorkspaceFiles(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    ('workspaceFile' in value || Object.values(value).some(hasWorkspaceFiles)),
  );
}

export function workspaceFileSchemas(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(workspaceFileSchemas);
  if (!value || typeof value !== 'object') return value;
  if ('file_uploadable' in value && value.file_uploadable === true)
    return { anyOf: [z.toJSONSchema(workspaceFileInput), value] };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, workspaceFileSchemas(item)]),
  );
}

export async function uploadWorkspaceFiles(
  value: unknown,
  read: (input: z.infer<typeof workspaceFileInput>) => Promise<IntegrationFile>,
  upload: (file: IntegrationFile) => Promise<Record<string, unknown>>,
): Promise<unknown> {
  const files = new Map<object, IntegrationFile>();
  async function readFiles(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    if ('workspaceFile' in value) {
      files.set(value, await read(workspaceFileInput.parse(value)));
      return;
    }
    for (const item of Object.values(value)) await readFiles(item);
  }
  async function uploadFiles(value: unknown): Promise<unknown> {
    if (!value || typeof value !== 'object') return value;
    const file = files.get(value);
    if (file) return upload(file);
    if (Array.isArray(value)) {
      const result = [];
      for (const item of value) result.push(await uploadFiles(item));
      return result;
    }
    const entries = [];
    for (const [key, item] of Object.entries(value)) entries.push([key, await uploadFiles(item)]);
    return Object.fromEntries(entries);
  }
  await readFiles(value);
  return uploadFiles(value);
}
