import { createHash } from 'node:crypto';
import { z } from 'zod';
import { memoryAreas, type MemorySource, type MemoryView } from '../shared/memory.ts';

export const areas = memoryAreas;
export const maxBytes = 256 * 1024;
export const maxEntries = 300;
export const maxArchive = 40;
export const indexBudget = 6000;

export const personalSecret =
  /\b(?:password|passcode|passphrase|otp|pin|2fa|api[ _-]?key|secret|token|bearer|private[ _-]?key|security code|cvv|cvc|verification code|recovery code|palavra[ _-]?passe|senha|código de verificação)\b|\bsk-[A-Za-z0-9_-]{12,}|\b(?:\d[ -]?){14,19}\b/i;
const injection =
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,40}\b(?:instructions?|rules?|prompts?)\b|\bauthorized_keys\b|\bcurl\b[^\n]*\|\s*(?:ba)?sh\b|https?:\/\/[^\s/@]+:[^\s/@]+@|[\u200b\u200e\u200f\u202a-\u202e\u2060-\u2064\ufeff]/iu;
const slugPattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
const legacyKinds = { fact: 'about', preference: 'preferences', pattern: 'lessons' } as const;
const legacy =
  /^## ([0-9a-f-]{36})\nKind: (fact|preference|pattern)\nUpdated: (\d{4}-\d\d-\d\dT[^\n]+)\nSources: ([0-9a-f-, ]+)\n\n([^\n]+)$/;

export function unsafe(...texts: Array<string | undefined>) {
  return texts.some((text) => !!text && (personalSecret.test(text) || injection.test(text)));
}

export const id = z.uuid();
export const area = z.enum(areas);
export const slug = z
  .string()
  .regex(new RegExp(`^${slugPattern}$`))
  .max(48);
export const path = z.string().regex(new RegExp(`^(?:${areas.join('|')})/${slugPattern}$`));
export const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value));
const timestamp = z.iso.datetime({ offset: true });

const entryFields = z.object({
  area,
  slug,
  text: line(600),
  abstract: line(120).optional(),
  origin: z.enum(['stated', 'inferred']),
  updated: timestamp,
  edited: timestamp.optional(),
  sources: z.array(id).max(5),
  expires: z.iso.date().optional(),
});
const evidenced = (entry: z.infer<typeof entryFields>) =>
  entry.sources.length > 0 || !!entry.edited;
const entrySchema = entryFields.refine(evidenced);
const archivedSchema = entryFields
  .extend({
    archived: timestamp,
    reason: z.enum([
      'superseded',
      'merged',
      'duplicate',
      'expired',
      'stale',
      'obsolete',
      'contradicted',
    ]),
    by: path.optional(),
  })
  .refine(evidenced);
const overviewSchema = z.object({
  text: line(1200),
  digest: z.string().regex(/^[0-9a-f]{12}$/),
});
const watermark = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\/[0-9a-f-]{36}$/;

export type Area = z.infer<typeof area>;
export type Entry = z.infer<typeof entrySchema>;
export type Archived = z.infer<typeof archivedSchema>;
export type Reason = Archived['reason'];
export interface Tree {
  enabled: boolean;
  sensitive: boolean;
  reflected: string | null;
  retries: number;
  entries: Entry[];
  overviews: Partial<Record<Area, z.infer<typeof overviewSchema>>>;
  consolidated: Partial<Record<Area, string>>;
  archive: Archived[];
}

export const emptyTree = (): Tree => ({
  enabled: true,
  sensitive: false,
  reflected: null,
  retries: 0,
  entries: [],
  overviews: {},
  consolidated: {},
  archive: [],
});
export const isEmpty = (tree: Tree) =>
  tree.enabled &&
  !tree.sensitive &&
  !tree.reflected &&
  !tree.entries.length &&
  !tree.archive.length;

export const pathOf = (entry: { area: Area; slug: string }) => `${entry.area}/${entry.slug}`;
export const bySlug = (a: Entry, b: Entry) => a.slug.localeCompare(b.slug);
export const locate = (tree: Tree, target: string) =>
  tree.entries.find((entry) => pathOf(entry) === target);
export const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const tokens = (value: string) =>
  [...segmenter.segment(fold(value))].filter((part) => part.isWordLike).map((part) => part.segment);
export const words = (value: string) =>
  tokens(value).filter((word) => word.length > 1 || /\p{N}/u.test(word) || cjk.test(word));
export const same = (a: string, b: string) => {
  const left = tokens(a).join(' ');
  return !!left && left === tokens(b).join(' ');
};

const numbers = (set: Set<string>) =>
  [...set]
    .filter((word) => /\p{N}/u.test(word))
    .sort()
    .join(' ');

export function similar(a: string, b: string, threshold: number) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (numbers(left) !== numbers(right)) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  return !!shared && shared / (left.size + right.size - shared) >= threshold;
}

export const abstractOf = (entry: Entry) =>
  entry.abstract ??
  (entry.text.length <= 120 ? entry.text : `${entry.text.slice(0, 119).trimEnd()}…`);
export const statusOf = (entry: Entry) =>
  entry.origin === 'stated' ? 'stated' : entry.sources.length > 1 ? 'observed' : 'tentative';

export function freeSlug(tree: Tree, target: Area, base: string) {
  const taken = new Set(tree.entries.filter((entry) => entry.area === target).map((e) => e.slug));
  let value = base;
  for (let n = 2; taken.has(value); n++) value = `${base.slice(0, 44)}-${n}`;
  return value;
}

export const slugFor = (tree: Tree, target: Area, text: string) =>
  freeSlug(
    tree,
    target,
    fold(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 || /\d/.test(word))
      .slice(0, 6)
      .join('-')
      .slice(0, 44)
      .replace(/-+$/, '') || 'note',
  );

export function digest(entries: Entry[]) {
  return createHash('sha256')
    .update(
      entries
        .toSorted(bySlug)
        .map((entry) => `${entry.slug}\n${entry.text}\n${entry.abstract ?? ''}`)
        .join('\n\n'),
    )
    .digest('hex')
    .slice(0, 12);
}

export const areaEntries = (tree: Tree, target: Area) =>
  tree.entries.filter((entry) => entry.area === target);

export function archive(tree: Tree, entry: Entry, reason: Reason, now: string, by?: string) {
  tree.entries = tree.entries.filter((item) => item !== entry);
  tree.archive = [
    ...tree.archive,
    { ...entry, archived: now, reason, ...(by ? { by } : {}) },
  ].slice(-maxArchive);
}

export function parse(bytes?: Uint8Array): Tree {
  const tree = emptyTree();
  if (!bytes) return tree;
  const body = new TextDecoder().decode(bytes);
  const seen = new Set<string>();
  const keep = (entry: Entry) => {
    if (unsafe(entry.text, entry.abstract) || seen.has(pathOf(entry))) return;
    seen.add(pathOf(entry));
    tree.entries.push(entry);
  };
  if (body.startsWith('# Memory')) {
    for (const part of body.split(/\n(?=## )/)) {
      const match = legacy.exec(part.trim());
      if (!match) continue;
      const target = legacyKinds[match[2] as keyof typeof legacyKinds];
      const entry = entrySchema.safeParse({
        area: target,
        slug: slugFor(tree, target, match[5]),
        text: match[5],
        origin: match[2] === 'pattern' ? 'inferred' : 'stated',
        updated: match[3],
        sources: match[4].split(', '),
      });
      if (entry.success) keep(entry.data);
    }
    return tree;
  }
  let doc: Record<string, unknown>;
  try {
    doc = z.record(z.string(), z.unknown()).parse(JSON.parse(body));
  } catch {
    return tree;
  }
  tree.enabled = doc.enabled !== false;
  tree.sensitive = doc.sensitive === true;
  tree.reflected =
    typeof doc.reflected === 'string' && watermark.test(doc.reflected) ? doc.reflected : null;
  tree.retries = z.number().int().min(0).max(9).catch(0).parse(doc.retries);
  for (const raw of Array.isArray(doc.entries) ? doc.entries : []) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) keep(entry.data);
  }
  for (const raw of Array.isArray(doc.archive) ? doc.archive : []) {
    const entry = archivedSchema.safeParse(raw);
    if (entry.success && !unsafe(entry.data.text, entry.data.abstract))
      tree.archive.push(entry.data);
  }
  for (const target of areas) {
    const overview = overviewSchema.safeParse((doc.overviews as Record<string, unknown>)?.[target]);
    if (overview.success && !unsafe(overview.data.text)) tree.overviews[target] = overview.data;
    const attempt = timestamp.safeParse((doc.consolidated as Record<string, unknown>)?.[target]);
    if (attempt.success) tree.consolidated[target] = attempt.data;
  }
  return tree;
}

export function render(tree: Tree) {
  const write = (archived: Archived[]) =>
    new TextEncoder().encode(
      JSON.stringify(
        {
          version: 2,
          enabled: tree.enabled,
          sensitive: tree.sensitive,
          reflected: tree.reflected,
          retries: tree.retries,
          entries: tree.entries.toSorted(
            (a, b) => areas.indexOf(a.area) - areas.indexOf(b.area) || bySlug(a, b),
          ),
          overviews: Object.fromEntries(
            areas.flatMap((target) => {
              const overview = tree.overviews[target];
              return overview?.digest === digest(areaEntries(tree, target))
                ? [[target, overview]]
                : [];
            }),
          ),
          consolidated: tree.consolidated,
          archive: archived,
        },
        null,
        1,
      ),
    );
  let bytes = write(tree.archive);
  for (let drop = 1; bytes.length > maxBytes && drop <= tree.archive.length; drop++)
    bytes = write(tree.archive.slice(drop));
  if (bytes.length > maxBytes) throw new Error('The memory file is full.');
  return bytes;
}

export function indexLayout(tree: Tree, options: { tentative?: boolean; budget?: number } = {}) {
  const budget = options.budget ?? indexBudget;
  const listed = tree.entries.filter(
    (entry) => options.tentative || statusOf(entry) !== 'tentative',
  );
  const row = (entry: Entry) =>
    `${entry.slug}: ${abstractOf(entry)}${statusOf(entry) === 'tentative' ? ' (tentative)' : ''}`;
  const ranked = listed.toSorted(
    (a, b) =>
      Number(statusOf(b) === 'stated') - Number(statusOf(a) === 'stated') ||
      b.updated.localeCompare(a.updated) ||
      pathOf(a).localeCompare(pathOf(b)),
  );
  let used = 2 + areas.length * 40;
  const shown = new Set<Entry>();
  for (const entry of ranked) {
    const cost = JSON.stringify(row(entry)).length + 1;
    if (used + cost > budget) break;
    used += cost;
    shown.add(entry);
  }
  const index: Record<string, string[]> = {};
  for (const target of areas) {
    const all = listed.filter((entry) => entry.area === target);
    if (!all.length) continue;
    const visible = all
      .filter((entry) => shown.has(entry))
      .toSorted(
        (a, b) =>
          Number(statusOf(b) === 'stated') - Number(statusOf(a) === 'stated') || bySlug(a, b),
      );
    index[target] = [
      ...visible.map(row),
      ...(all.length > visible.length ? [`+${all.length - visible.length} more`] : []),
    ];
  }
  return {
    text: JSON.stringify(index),
    hidden: listed.length - shown.size,
    shown: new Set([...shown].map(pathOf)),
  };
}

const matches = (tokens: string[], term: string) =>
  tokens.some(
    (token) => token === term || ((term.length > 2 || cjk.test(term)) && token.startsWith(term)),
  );

export const brief = (entry: Entry) => ({
  path: pathOf(entry),
  abstract: abstractOf(entry),
  status: statusOf(entry),
});

export function find(tree: Tree, query: string, within?: Area) {
  const terms = [...new Set(words(query))];
  return tree.entries
    .filter((entry) => !within || entry.area === within)
    .map((entry) => {
      const name = words(entry.slug);
      const brief = words(abstractOf(entry));
      const body = words(entry.text);
      const score = terms.reduce(
        (sum, term) =>
          sum +
          (matches(name, term) ? 3 : 0) +
          (matches(brief, term) ? 2 : 0) +
          (matches(body, term) ? 1 : 0),
        0,
      );
      return { entry, score };
    })
    .filter((hit) => hit.score > 0)
    .toSorted((a, b) => b.score - a.score || b.entry.updated.localeCompare(a.entry.updated))
    .slice(0, 10)
    .map(({ entry }) => brief(entry));
}

export function open(tree: Tree, target: string) {
  const owner = area.safeParse(target);
  if (owner.success) {
    const overview = tree.overviews[owner.data];
    return {
      path: owner.data,
      ...(overview ? { overview: overview.text } : {}),
      entries: areaEntries(tree, owner.data).toSorted(bySlug).map(brief),
    };
  }
  const entry = locate(tree, target);
  if (!entry) throw new Error('The memory entry was not found.');
  return {
    path: pathOf(entry),
    text: entry.text,
    status: statusOf(entry),
    evidence: entry.sources.length,
    updated: entry.updated,
    ...(entry.expires ? { expires: entry.expires } : {}),
  };
}

export function view(
  tree: Tree,
  source: (id: string) => MemorySource,
): Omit<MemoryView, 'profile'> {
  const index = indexLayout(tree);
  return {
    saving: tree.enabled,
    sensitive: tree.sensitive,
    notes: tree.entries
      .toSorted((a, b) => b.updated.localeCompare(a.updated) || pathOf(a).localeCompare(pathOf(b)))
      .map((entry) => ({
        path: pathOf(entry),
        area: entry.area,
        text: entry.text,
        status: statusOf(entry),
        inMind: index.shown.has(pathOf(entry)),
        updated: entry.updated,
        edited: entry.edited ?? null,
        expires: entry.expires ?? null,
        sources: entry.sources.map(source),
      })),
    archive: tree.archive.toReversed().map((entry) => ({
      path: pathOf(entry),
      area: entry.area,
      text: entry.text,
      reason: entry.reason,
      by: entry.by ?? null,
      archived: entry.archived,
      sources: entry.sources.map(source),
    })),
  };
}
