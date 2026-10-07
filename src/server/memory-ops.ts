import { z } from 'zod';
import {
  archive,
  area,
  areaEntries,
  digest,
  fold,
  freeSlug,
  line,
  locate,
  maxEntries,
  path,
  same,
  slug,
  unsafe,
  type Area,
  type Entry,
  type Tree,
} from './memory-tree.ts';

export const maxReflectOps = 6;
const ordinals = z.array(z.number().int().min(1).max(40)).min(1).max(3);

const reflectOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    area,
    slug,
    text: line(300),
    abstract: line(120).optional(),
    m: ordinals,
    quote: line(160),
    sensitive: z.boolean(),
  }),
  z.object({
    op: z.literal('archive'),
    path,
    reason: z.enum(['obsolete', 'contradicted']),
    m: ordinals,
    quote: line(160),
  }),
]);

const consolidateOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('merge'),
    keep: path,
    drop: z.array(path).min(1).max(7),
  }),
  z.object({
    op: z.literal('archive'),
    path,
    by: path,
    reason: z.enum(['superseded', 'contradicted']),
  }),
  z.object({ op: z.literal('abstract'), path, abstract: line(120) }),
  z.object({ op: z.literal('overview'), area, text: line(1200) }),
]);

const rank = (entry: Entry) => (entry.origin === 'stated' ? 2 : 1);
const union = (...lists: string[][]) => [...new Set(lists.flat())].slice(-5);

export function applyReflect(
  tree: Tree,
  raw: unknown[],
  messages: Array<{ id: string; text: string }>,
  now: string,
) {
  let applied = 0;
  for (const item of raw.slice(0, maxReflectOps)) {
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
        if (tree.entries.length >= maxEntries) continue;
        tree.entries.push({
          area: op.area,
          slug: freeSlug(tree, op.area, op.slug),
          text: op.text,
          ...(op.abstract ? { abstract: op.abstract } : {}),
          origin: 'inferred',
          updated: now,
          sources,
        });
      }
    }
    applied++;
  }
  return applied;
}

export function applyConsolidate(tree: Tree, target: Area, raw: unknown[], now: string) {
  let applied = 0;
  let overview: string | undefined;
  for (const item of raw.slice(0, 20)) {
    const parsed = consolidateOp.safeParse(item);
    if (!parsed.success) continue;
    const op = parsed.data;
    if (op.op === 'overview') {
      if (op.area === target && !unsafe(op.text)) overview = op.text;
      continue;
    }
    if (op.op === 'merge') {
      const keep = locate(tree, op.keep);
      const drops = op.drop.map((target) => locate(tree, target));
      const group = [keep, ...drops].filter((entry): entry is Entry => !!entry);
      if (
        group.length !== op.drop.length + 1 ||
        new Set(group).size !== group.length ||
        group.some((entry) => entry.area !== target || rank(entry) > rank(keep!))
      )
        continue;
      keep!.sources = union(...group.map((entry) => entry.sources));
      keep!.updated = group
        .map((entry) => entry.updated)
        .sort()
        .at(-1)!;
      keep!.expires = group.every((entry) => entry.expires)
        ? group
            .map((entry) => entry.expires!)
            .sort()
            .at(-1)
        : undefined;
      for (const drop of group.slice(1)) archive(tree, drop, 'merged', now, op.keep);
    } else if (op.op === 'archive') {
      const entry = locate(tree, op.path);
      const by = locate(tree, op.by);
      if (
        !entry ||
        !by ||
        entry === by ||
        entry.area !== target ||
        rank(by) < rank(entry) ||
        by.updated <= entry.updated
      )
        continue;
      archive(tree, entry, op.reason, now, op.by);
    } else {
      const entry = locate(tree, op.path);
      if (!entry || entry.area !== target || unsafe(op.abstract)) continue;
      entry.abstract = op.abstract;
    }
    applied++;
  }
  if (overview) {
    tree.overviews[target] = { text: overview, digest: digest(areaEntries(tree, target)) };
    applied++;
  }
  return applied;
}
