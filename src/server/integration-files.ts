import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentImage } from '../ports/agent.ts';
import { IntegrationDownload, type IntegrationFile } from '../ports/integrations.ts';

const viewableImages = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const workspaceFileInput = z
  .object({
    workspaceFile: z.string().min(1).max(4096),
    mimeType: z.string().regex(/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/),
    name: z
      .string()
      .trim()
      .min(1)
      .regex(/^[^/\\\u0000-\u001f\u007f]+$/)
      .optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

const workspaceFileReference = workspaceFileInput.extend({
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

type WorkspaceFileReference = z.infer<typeof workspaceFileReference>;

export function fileDigest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function pinnedWorkspaceFiles(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  if ('workspaceFile' in value) {
    const input = workspaceFileReference.safeParse(value);
    return input.success && input.data.sha256 !== undefined && input.data.size !== undefined;
  }
  return Object.values(value).every(pinnedWorkspaceFiles);
}

export async function pinWorkspaceFiles(
  value: unknown,
  read: (input: WorkspaceFileReference) => Promise<Uint8Array>,
): Promise<unknown> {
  if (!value || typeof value !== 'object') return value;
  if ('workspaceFile' in value) {
    const input = workspaceFileReference.parse(value);
    const bytes = await read(input);
    return { ...input, size: bytes.byteLength, sha256: fileDigest(bytes) };
  }
  if (Array.isArray(value)) {
    const result = [];
    for (const item of value) result.push(await pinWorkspaceFiles(item, read));
    return result;
  }
  const entries = [];
  for (const [key, item] of Object.entries(value))
    entries.push([key, await pinWorkspaceFiles(item, read)]);
  return Object.fromEntries(entries);
}

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
  read: (input: WorkspaceFileReference) => Promise<IntegrationFile>,
  upload: (file: IntegrationFile) => Promise<Record<string, unknown>>,
): Promise<unknown> {
  const files = new Map<object, IntegrationFile>();
  async function readFiles(value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') return;
    if ('workspaceFile' in value) {
      files.set(value, await read(workspaceFileReference.parse(value)));
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

export function isIntegrationFile(value: unknown): value is IntegrationFile {
  return Boolean(
    value &&
    typeof value === 'object' &&
    (value as IntegrationFile).bytes instanceof Uint8Array &&
    typeof (value as IntegrationFile).name === 'string' &&
    typeof (value as IntegrationFile).mimeType === 'string',
  );
}

export async function saveIntegrationFiles(
  value: unknown,
  save: (file: IntegrationFile) => Promise<string>,
): Promise<{ value: unknown; images: AgentImage[] }> {
  const images: AgentImage[] = [];
  async function visit(item: unknown): Promise<unknown> {
    if (item instanceof IntegrationDownload) return visit(await item.start());
    if (isIntegrationFile(item)) {
      const file = { name: item.name, mimeType: item.mimeType, size: item.bytes.byteLength };
      const workspaceFile = await save(item);
      if (
        viewableImages.has(item.mimeType) &&
        item.bytes.byteLength <= 5 * 1024 * 1024 &&
        images.length < 4
      )
        images.push({
          type: 'image',
          data: Buffer.from(item.bytes).toString('base64'),
          mimeType: item.mimeType,
        });
      return { workspaceFile, ...file };
    }
    if (Array.isArray(item)) {
      const result = [];
      for (const entry of item) result.push(await visit(entry));
      return result;
    }
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) return item;
    const entries = [];
    for (const [key, entry] of Object.entries(item)) entries.push([key, await visit(entry)]);
    return Object.fromEntries(entries);
  }
  return { value: await visit(value), images };
}
