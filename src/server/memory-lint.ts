import { archive, areaEntries, areas, pathOf, same, type Entry, type Tree } from './memory-tree.ts';

const staleMs = 60 * 86_400_000;
const rank = (entry: Entry) => (entry.origin === 'stated' ? 2 : 1);
const better = (a: Entry, b: Entry) =>
  rank(a) - rank(b) || a.sources.length - b.sources.length || a.updated.localeCompare(b.updated);

export function repair(tree: Tree, now: Date) {
  const iso = now.toISOString();
  let changes = 0;
  for (const entry of [...tree.entries]) {
    if (entry.expires && entry.expires < iso.slice(0, 10)) archive(tree, entry, 'expired', iso);
    else if (
      entry.origin === 'inferred' &&
      (!entry.fact || entry.fact.kind === 'plan') &&
      entry.sources.length < 2 &&
      now.getTime() - Date.parse(entry.updated) > staleMs
    )
      archive(tree, entry, 'stale', iso);
    else continue;
    changes++;
  }
  for (const target of areas) {
    const group = areaEntries(tree, target);
    for (const [index, first] of group.entries()) {
      for (const second of group.slice(index + 1)) {
        if (!tree.entries.includes(first)) break;
        if (!tree.entries.includes(second) || !same(first.text, second.text)) continue;
        const [keep, drop] = better(first, second) >= 0 ? [first, second] : [second, first];
        keep.sources = [...new Set([...keep.sources, ...drop.sources])].slice(-5);
        keep.quote ??= drop.quote;
        keep.expires =
          keep.expires && drop.expires ? [keep.expires, drop.expires].sort().at(-1) : undefined;
        archive(tree, drop, 'duplicate', iso, pathOf(keep));
        changes++;
      }
    }
  }
  return changes;
}
