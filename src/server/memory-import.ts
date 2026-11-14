import { z } from 'zod';
import {
  area,
  areaEntries,
  importedSchema,
  line,
  pathOf,
  same,
  slugFor,
  unsafe,
  type Entry,
  type Tree,
} from './memory-tree.ts';

const included = new Set(['note', 'summary', 'decisions', 'links']);
const sourceOf = (uri: string) => {
  const parsed = new URL(uri);
  return `${parsed.protocol}//${parsed.host}`;
};

const record = importedSchema
  .extend({ area: area.default('about'), text: line(), locked: z.boolean().default(false) })
  .strict();

export const manifestSchema = z
  .object({
    version: z.literal(1),
    include: z.array(z.literal('transcript')).max(1).default([]),
    records: z.array(record).min(1).max(200),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<string>();
    input.records.forEach((item, index) => {
      if (seen.has(item.id))
        context.addIssue({
          code: 'custom',
          path: ['records', index, 'id'],
          message: `Record ID ${item.id} appears more than once.`,
        });
      seen.add(item.id);
    });
  });

export type Manifest = z.infer<typeof manifestSchema>;

export type ImportDecision = { id: string } & (
  | { decision: 'added' | 'same' | 'existing' | 'locked' | 'archived'; path: string }
  | { decision: 'proposal'; path: string; current: string; text: string; revision: string }
  | { decision: 'excluded' | 'secret' }
);

export function parseManifest(raw: unknown): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success)
    throw Object.assign(
      new Error(`The import manifest is invalid.\n${z.prettifyError(parsed.error)}`),
      { statusCode: 400 },
    );
  return parsed.data;
}

export function applyManifest(tree: Tree, input: Manifest, now: string) {
  const allowed = new Set([...included, ...input.include]);
  return input.records.map(({ area, text, locked, ...source }): ImportDecision => {
    const { id } = source;
    const matches = (entry: Entry) =>
      entry.imported?.id === id && sourceOf(entry.imported.uri) === sourceOf(source.uri);
    if (!allowed.has(source.class)) return { id, decision: 'excluded' };
    if (unsafe(text, source.uri, source.id, source.revision)) return { id, decision: 'secret' };
    const saved = tree.entries.find(matches);
    if (saved) {
      const path = pathOf(saved);
      if (saved.imported?.revision === source.revision) return { id, decision: 'same', path };
      if (locked) return { id, decision: 'locked', path };
      if (same(saved.text, text)) {
        saved.imported = source;
        return { id, decision: 'same', path };
      }
      return {
        id,
        decision: 'proposal',
        path,
        current: saved.text,
        text,
        revision: source.revision,
      };
    }
    const archived = tree.archive.findLast(matches);
    if (archived) return { id, decision: 'archived', path: pathOf(archived) };
    const match = areaEntries(tree, area).find((entry) => same(entry.text, text));
    if (match) return { id, decision: 'existing', path: pathOf(match) };
    const entry: Entry = {
      area,
      slug: slugFor(tree, area, text),
      text,
      origin: 'stated',
      updated: now,
      edited: now,
      sources: [],
      imported: source,
    };
    tree.entries.push(entry);
    return { id, decision: 'added', path: pathOf(entry) };
  });
}
