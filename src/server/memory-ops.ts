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
  pathOf,
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
    expires: z.iso.date().optional().catch(undefined),
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

export function applyOps(
  tree: Tree,
  raw: unknown[],
  messages: Array<{ id: string; text: string }>,
  now: string,
  origin: 'inferred' | 'stated' = 'inferred',
) {
  const applied: Array<{ operation: 'archive' | 'save'; path: string; text: string }> = [];
  const ops = raw.flatMap((item) => {
    const parsed = reflectOp.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  for (const op of [
    ...ops.filter(({ op }) => op === 'archive'),
    ...ops.filter(({ op }) => op === 'add'),
  ]) {
    const cited = op.m.flatMap((n) => messages[n - 1] ?? []);
    const quoted = cited.filter((m) => fold(m.text).includes(fold(op.quote)));
    if (cited.length !== op.m.length || !quoted.length) continue;
    const sources = union(quoted.map((m) => m.id));
    if (op.op === 'archive') {
      const entry = locate(tree, op.path);
      if (!entry || (origin === 'inferred' && entry.origin !== 'inferred')) continue;
      archive(tree, entry, op.reason, now);
      applied.push({ operation: 'archive', path: op.path, text: entry.text });
      continue;
    }
    if (unsafe(op.text, op.abstract) || (origin === 'inferred' && op.sensitive && !tree.sensitive))
      continue;
    const match = areaEntries(tree, op.area).find((entry) => same(entry.text, op.text));
    if (match) {
      if (origin === 'inferred' && match.origin !== 'inferred') continue;
      match.sources = union(match.sources, sources);
      match.updated = now;
      if (origin === 'stated') {
        match.origin = 'stated';
        if (op.expires) match.expires = op.expires;
      }
      applied.push({ operation: 'save', path: pathOf(match), text: match.text });
      continue;
    }
    const entry = {
      area: op.area,
      slug: freeSlug(tree, op.area, op.slug),
      text: op.text,
      ...(op.abstract ? { abstract: op.abstract } : {}),
      origin,
      updated: now,
      sources,
      ...(op.expires ? { expires: op.expires } : {}),
    };
    tree.entries.push(entry);
    if (!fits(tree)) {
      tree.entries.pop();
      continue;
    }
    applied.push({ operation: 'save', path: pathOf(entry), text: entry.text });
  }
  return applied;
}
