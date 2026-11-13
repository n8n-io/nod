import { z } from 'zod';
import { cardNumber } from './personal-data.ts';
import { secretToken } from './redaction.ts';
import {
  memoryAreas,
  noteChars,
  skillChars,
  skillDescriptionChars,
  type MemorySource,
  type MemoryView,
} from '../shared/memory.ts';

export const areas = memoryAreas;
export const maxBytes = 256 * 1024;

const digitRun = /\d+(?:[ -]\d+)*/g;
const keyOrLoginLink = new RegExp(
  String.raw`https?:\/\/[^\s/@]+:[^\s/@]+@|` + secretToken.source,
  'i',
);
function holdsCard(run: string) {
  const groups = run.split(/[ -]/);
  for (let start = 0; start < groups.length; start++) {
    let digits = '';
    for (let end = start; end < groups.length; end++) {
      digits += groups[end];
      if (digits.length > 19) break;
      if (cardNumber(digits)) return true;
    }
  }
  return false;
}
export function personalSecret(text: string) {
  return keyOrLoginLink.test(text) || [...text.matchAll(digitRun)].some(([run]) => holdsCard(run));
}
const slugPattern = '[a-z0-9]+(?:-[a-z0-9]+)*';
export function unsafe(...texts: Array<string | undefined>) {
  return texts.some((text) => !!text && personalSecret(text));
}

export const id = z.uuid();
export const area = z.enum(areas);
export const slug = z
  .string()
  .regex(new RegExp(`^${slugPattern}$`))
  .max(48);
export const path = z.string().regex(new RegExp(`^(?:${areas.join('|')})/${slugPattern}$`));
export const line = (max = noteChars) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value));
const timestamp = z.iso.datetime({ offset: true });
export const skillName = z
  .string()
  .regex(new RegExp(`^${slugPattern}$`))
  .max(64);
export const skillDescription = line(skillDescriptionChars);
export const skillBody = z
  .string()
  .trim()
  .min(1)
  .max(skillChars)
  .refine((value) => !/[^\P{Cc}\t\n]/u.test(value));
const skillSchema = z.object({
  name: skillName,
  description: skillDescription,
  body: skillBody,
  learned: timestamp,
  updated: timestamp,
  used: timestamp.optional(),
  edited: timestamp.optional(),
  turn: z.uuid().optional(),
});

export const factSchema = z
  .object({
    kind: z.enum(['fact', 'preference', 'plan', 'event', 'possession']),
    entities: z.array(line(120)).max(12),
    occurredOn: z.iso.date().optional(),
    validFrom: z.iso.date().optional(),
    validTo: z.iso.date().optional(),
  })
  .strict()
  .refine((fact) => !fact.validFrom || !fact.validTo || fact.validFrom <= fact.validTo);

const entryFields = z.object({
  area,
  slug,
  text: line(),
  abstract: line(120).optional(),
  origin: z.enum(['stated', 'inferred', 'email']),
  updated: timestamp,
  edited: timestamp.optional(),
  sources: z.array(id).max(5),
  expires: z.iso.date().optional(),
  fact: factSchema.optional().catch(undefined),
  quote: line(400).optional().catch(undefined),
});
const evidenced = (entry: z.infer<typeof entryFields>) =>
  entry.sources.length > 0 || !!entry.edited || entry.origin === 'email';
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
      'manual',
    ]),
    by: path.optional(),
  })
  .refine(evidenced);
const watermark = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z\/[0-9a-f-]{36}$/;

export type Area = z.infer<typeof area>;
export type Entry = z.infer<typeof entrySchema>;
export type Archived = z.infer<typeof archivedSchema>;
type Reason = Archived['reason'];
export type Skill = z.infer<typeof skillSchema>;
export interface Tree {
  enabled: boolean;
  sensitive: boolean;
  reflected: string | null;
  generation: number;
  retries: number;
  entries: Entry[];
  archive: Archived[];
  skills: Skill[];
}

export const emptyTree = (): Tree => ({
  enabled: true,
  sensitive: false,
  reflected: null,
  generation: 0,
  retries: 0,
  entries: [],
  archive: [],
  skills: [],
});
export const isEmpty = (tree: Tree) =>
  tree.enabled &&
  !tree.sensitive &&
  !tree.reflected &&
  !tree.entries.length &&
  !tree.archive.length &&
  !tree.skills.length;

export const pathOf = (entry: { area: Area; slug: string }) => `${entry.area}/${entry.slug}`;
const bySlug = (a: Entry, b: Entry) => a.slug.localeCompare(b.slug);
export const locate = (tree: Tree, target: string) =>
  tree.entries.find((entry) => pathOf(entry) === target);
export const fold = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const tokens = (value: string) =>
  [...segmenter.segment(fold(value))].filter((part) => part.isWordLike).map((part) => part.segment);
const words = (value: string) =>
  tokens(value).filter((word) => word.length > 1 || /\p{N}/u.test(word) || cjk.test(word));
export const same = (a: string, b: string) => {
  const left = tokens(a).join(' ');
  return !!left && left === tokens(b).join(' ');
};

const abstractOf = (entry: Entry) => entry.abstract ?? entry.text;
export const statusOf = (entry: Entry) =>
  entry.origin === 'stated'
    ? 'stated'
    : entry.origin === 'email' || entry.sources.length > 1
      ? 'observed'
      : 'tentative';

export function freeSlug(tree: Tree, target: Area, base: string) {
  const taken = new Set(tree.entries.filter((entry) => entry.area === target).map((e) => e.slug));
  let value = base;
  for (let n = 2; taken.has(value); n++)
    value = `${base.slice(0, 47 - String(n).length).replace(/-+$/, '')}-${n}`;
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

export const areaEntries = (tree: Tree, target: Area) =>
  tree.entries.filter((entry) => entry.area === target);

export function archive(tree: Tree, entry: Entry, reason: Reason, now: string, by?: string) {
  tree.entries = tree.entries.filter((item) => item !== entry);
  tree.archive = [...tree.archive, { ...entry, archived: now, reason, ...(by ? { by } : {}) }];
}

export function parse(bytes?: Uint8Array): Tree {
  const tree = emptyTree();
  if (!bytes) return tree;
  const body = new TextDecoder().decode(bytes);
  const seen = new Set<string>();
  const keep = (entry: Entry) => {
    if (
      unsafe(entry.text, entry.abstract, entry.quote, ...(entry.fact?.entities ?? [])) ||
      seen.has(pathOf(entry))
    )
      return;
    seen.add(pathOf(entry));
    tree.entries.push(entry);
  };
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
  tree.generation = z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .catch(0)
    .parse(doc.generation);
  tree.retries = z.number().int().min(0).max(9).catch(0).parse(doc.retries);
  for (const raw of Array.isArray(doc.entries) ? doc.entries : []) {
    const entry = entrySchema.safeParse(raw);
    if (entry.success) keep(entry.data);
  }
  for (const raw of Array.isArray(doc.archive) ? doc.archive : []) {
    const entry = archivedSchema.safeParse(raw);
    if (
      entry.success &&
      !unsafe(
        entry.data.text,
        entry.data.abstract,
        entry.data.quote,
        ...(entry.data.fact?.entities ?? []),
      )
    )
      tree.archive.push(entry.data);
  }
  for (const raw of Array.isArray(doc.skills) ? doc.skills : []) {
    const skill = skillSchema.safeParse(raw);
    if (
      skill.success &&
      !unsafe(skill.data.description, skill.data.body) &&
      !tree.skills.some((item) => item.name === skill.data.name)
    )
      tree.skills.push(skill.data);
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
          generation: tree.generation,
          retries: tree.retries,
          entries: tree.entries.toSorted(
            (a, b) => areas.indexOf(a.area) - areas.indexOf(b.area) || bySlug(a, b),
          ),
          archive: archived,
          ...(tree.skills.length
            ? { skills: tree.skills.toSorted((a, b) => a.name.localeCompare(b.name)) }
            : {}),
        },
        null,
        1,
      ),
    );
  let bytes = write(tree.archive);
  for (let drop = 1; bytes.length > maxBytes && drop <= tree.archive.length; drop++)
    bytes = write(tree.archive.slice(drop));
  if (bytes.length > maxBytes)
    throw Object.assign(new Error('Memory is full. Forget a note first.'), { statusCode: 400 });
  return bytes;
}

export function fits(tree: Tree) {
  try {
    render(tree);
    return true;
  } catch {
    return false;
  }
}

export function indexLayout(tree: Tree, options: { tentative?: boolean } = {}) {
  const index: Record<string, string[]> = {};
  for (const target of areas) {
    const rows = tree.entries
      .filter(
        (entry) => entry.area === target && (options.tentative || statusOf(entry) !== 'tentative'),
      )
      .toSorted(
        (a, b) =>
          Number(statusOf(b) === 'stated') - Number(statusOf(a) === 'stated') || bySlug(a, b),
      )
      .map(
        (entry) =>
          `${entry.slug}: ${entry.text}${statusOf(entry) === 'tentative' ? ' (tentative)' : ''}`,
      );
    if (rows.length) index[target] = rows;
  }
  return index;
}

const matches = (tokens: string[], term: string) =>
  tokens.some(
    (token) => token === term || ((term.length > 2 || cjk.test(term)) && token.startsWith(term)),
  );

const brief = (entry: Entry) => ({
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
  if (owner.success)
    return {
      path: owner.data,
      entries: areaEntries(tree, owner.data).toSorted(bySlug).map(brief),
    };
  const entry = locate(tree, target);
  if (!entry) throw new Error('The memory entry was not found.');
  return {
    path: pathOf(entry),
    text: entry.text,
    status: statusOf(entry),
    evidence: entry.sources.length,
    sources: entry.sources,
    ...(entry.fact ? { fact: entry.fact } : {}),
    updated: entry.updated,
    ...(entry.expires ? { expires: entry.expires } : {}),
  };
}

export function view(
  tree: Tree,
  source: (id: string) => MemorySource,
  task: (turn: string | undefined) => string | null = () => null,
): MemoryView {
  const sources = (entry: Entry) =>
    entry.sources.map((id) => {
      const found = source(id);
      return entry.quote && found.text && fold(found.text).includes(fold(entry.quote))
        ? { ...found, quote: entry.quote }
        : found;
    });
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
        updated: entry.updated,
        edited: entry.edited ?? null,
        expires: entry.expires ?? null,
        learnedFrom: entry.origin === 'email' ? ('email' as const) : null,
        sources: sources(entry),
        ...(entry.fact ? { fact: entry.fact } : {}),
      })),
    archive: tree.archive.toReversed().map((entry) => ({
      path: pathOf(entry),
      area: entry.area,
      text: entry.text,
      reason: entry.reason,
      by: entry.by ?? null,
      archived: entry.archived,
      sources: sources(entry),
      ...(entry.fact ? { fact: entry.fact } : {}),
    })),
    skills: tree.skills
      .toSorted((a, b) => b.updated.localeCompare(a.updated) || a.name.localeCompare(b.name))
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        body: skill.body,
        learned: skill.learned,
        updated: skill.updated,
        edited: skill.edited ?? null,
        task: task(skill.turn),
      })),
  };
}
