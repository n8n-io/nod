import { z } from 'zod';
import {
  archive,
  area,
  areaEntries,
  fits,
  factSchema,
  foldQuote,
  line,
  lines,
  locate,
  pathOf,
  same,
  slugFor,
  unsafe,
  type Entry,
  type Tree,
} from './memory-tree.ts';

const ordinals = z.array(z.number().int()).min(1);
const support = lines().optional().catch(undefined);

const reflectOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    area,
    slug: z.string(),
    text: lines(),
    abstract: line(120).optional().catch(undefined),
    expires: z.iso.date().optional().catch(undefined),
    m: ordinals,
    quote: support,
    sensitive: z.boolean(),
    fact: factSchema.optional().catch(undefined),
    replaces: z.array(z.string()).max(8).optional(),
  }),
  z.object({
    op: z.literal('archive'),
    path: z.string(),
    reason: z.enum(['obsolete', 'contradicted']),
    m: ordinals,
    quote: support,
  }),
]);

const union = (...lists: string[][]) => [...new Set(lists.flat())].slice(-5);

export type Rejection = 'invalid' | 'source' | 'quote' | 'secret' | 'full';

export function applyOps(
  tree: Tree,
  raw: unknown[],
  messages: Array<{ id: string; text: string }>,
  now: string,
  origin: 'inferred' | 'stated' = 'inferred',
) {
  const applied: Array<{ operation: 'archive' | 'save'; path: string; text: string }> = [];
  const rejected: Rejection[] = [];
  const ops = raw.flatMap((item) => {
    const parsed = reflectOp.safeParse(item);
    if (parsed.success) return [parsed.data];
    rejected.push('invalid');
    return [];
  });
  const replace = (op: Extract<z.infer<typeof reflectOp>, { op: 'add' }>, target: string) => {
    for (const previous of op.replaces ?? []) {
      const entry = locate(tree, previous);
      if (!entry || previous === target || (origin === 'inferred' && entry.origin !== 'inferred'))
        continue;
      archive(tree, entry, 'superseded', now, target);
      applied.push({ operation: 'archive', path: previous, text: entry.text });
    }
  };
  for (const op of [
    ...ops.filter(({ op }) => op === 'archive'),
    ...ops.filter(({ op }) => op === 'add'),
  ]) {
    const cited = op.m.flatMap((n) => messages[n - 1] ?? []);
    const quote = op.quote && foldQuote(op.quote).trim() ? op.quote : undefined;
    const quoted = quote ? cited.filter((m) => foldQuote(m.text).includes(foldQuote(quote))) : [];
    if (!cited.length) {
      rejected.push('source');
      continue;
    }
    if (origin === 'inferred' && !quoted.length) {
      rejected.push('quote');
      continue;
    }
    if (unsafe(op.quote)) {
      rejected.push('secret');
      continue;
    }
    const sources = union((quoted.length ? quoted : cited).map((m) => m.id));
    const kept = quoted.length && quote && quote.length <= 400 ? quote : undefined;
    if (op.op === 'archive') {
      const entry = locate(tree, op.path);
      if (!entry || (origin === 'inferred' && entry.origin !== 'inferred')) continue;
      archive(tree, entry, op.reason, now);
      applied.push({ operation: 'archive', path: op.path, text: entry.text });
      continue;
    }
    if (unsafe(op.text, op.abstract, ...(op.fact?.entities ?? []))) {
      rejected.push('secret');
      continue;
    }
    if (origin === 'inferred' && op.sensitive && !tree.sensitive) continue;
    const match = areaEntries(tree, op.area).find((entry) => same(entry.text, op.text));
    const previous = { entries: tree.entries, archive: tree.archive, applied: applied.length };
    let entry: Entry;
    if (match) {
      if (origin === 'inferred' && match.origin !== 'inferred') continue;
      entry = { ...match, sources: union(match.sources, sources), updated: now };
      if (kept) entry.quote = kept;
      if (origin === 'stated') {
        entry.origin = 'stated';
        if (op.expires) entry.expires = op.expires;
      }
      if (op.fact) entry.fact = op.fact;
      tree.entries = tree.entries.map((item) => (item === match ? entry : item));
    } else {
      entry = {
        area: op.area,
        slug: slugFor(tree, op.area, op.slug),
        text: op.text,
        ...(op.abstract ? { abstract: op.abstract } : {}),
        origin,
        updated: now,
        sources,
        ...(kept ? { quote: kept } : {}),
        ...(op.expires ? { expires: op.expires } : {}),
        ...(op.fact ? { fact: op.fact } : {}),
      };
      tree.entries = [...tree.entries, entry];
    }
    replace(op, pathOf(entry));
    if (!fits(tree)) {
      tree.entries = previous.entries;
      tree.archive = previous.archive;
      applied.length = previous.applied;
      rejected.push('full');
      continue;
    }
    applied.push({ operation: 'save', path: pathOf(entry), text: entry.text });
  }
  return { applied, rejected };
}
