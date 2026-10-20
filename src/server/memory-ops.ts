import { z } from 'zod';
import {
  archive,
  area,
  areaEntries,
  fits,
  fold,
  freeSlug,
  line,
  locate,
  path,
  same,
  slug,
  unsafe,
  type Tree,
} from './memory-tree.ts';

const ordinals = z.array(z.number().int().min(1).max(40)).min(1);

const reflectOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    area,
    slug,
    text: line(),
    abstract: line(120).optional().catch(undefined),
    m: ordinals,
    quote: line(),
    sensitive: z.boolean(),
  }),
  z.object({
    op: z.literal('archive'),
    path,
    reason: z.enum(['obsolete', 'contradicted']),
    m: ordinals,
    quote: line(),
  }),
]);

const union = (...lists: string[][]) => [...new Set(lists.flat())].slice(-5);

export function applyReflect(
  tree: Tree,
  raw: unknown[],
  messages: Array<{ id: string; text: string }>,
  now: string,
) {
  const applied: Array<'archive' | 'save'> = [];
  for (const item of raw) {
    const parsed = reflectOp.safeParse(item);
    if (!parsed.success) continue;
    const op = parsed.data;
    const cited = op.m.flatMap((n) => messages[n - 1] ?? []);
    const quoted = cited.filter((m) => fold(m.text).includes(fold(op.quote)));
    if (cited.length !== op.m.length || !quoted.length) continue;
    const sources = union(quoted.map((m) => m.id));
    if (op.op === 'archive') {
      const entry = locate(tree, op.path);
      if (!entry || entry.origin !== 'inferred') continue;
      archive(tree, entry, op.reason, now);
    } else {
      if (unsafe(op.text, op.abstract) || (op.sensitive && !tree.sensitive)) continue;
      const match = areaEntries(tree, op.area).find((entry) => same(entry.text, op.text));
      if (match) {
        if (match.origin !== 'inferred') continue;
        match.sources = union(match.sources, sources);
        match.updated = now;
      } else {
        tree.entries.push({
          area: op.area,
          slug: freeSlug(tree, op.area, op.slug),
          text: op.text,
          ...(op.abstract ? { abstract: op.abstract } : {}),
          origin: 'inferred',
          updated: now,
          sources,
        });
        if (!fits(tree)) {
          tree.entries.pop();
          continue;
        }
      }
    }
    applied.push(op.op === 'archive' ? 'archive' : 'save');
  }
  return applied;
}
