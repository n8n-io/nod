import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';
import {
  archive,
  area,
  areaEntries,
  find,
  fold,
  freeSlug,
  id,
  indexLayout,
  isEmpty,
  line,
  locate,
  maxBytes,
  maxEntries,
  open,
  parse,
  path,
  pathOf,
  render,
  same,
  slug,
  slugFor,
  unsafe,
  view as memoryView,
  type Area,
  type Entry,
  type Tree,
} from './memory-tree.ts';

const key = 'memory/MEMORY.md';
const nilId = '00000000-0000-0000-0000-000000000000';
const learnInput = z
  .object({
    area,
    slug: slug.optional(),
    quote: z.string().max(4000),
    expires: z.iso.date().optional(),
    replace: z.boolean().optional(),
  })
  .strict();
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
const findInput = z
  .object({ query: z.string().trim().min(1).max(200), area: area.optional() })
  .strict();
const readInput = z.object({ path: z.union([area, path]) }).strict();
const noteInput = z.object({ area, text: line(600), expires: z.iso.date().optional() }).strict();
const restateInput = z
  .array(z.object({ area, slug, text: line(600) }).strict())
  .min(1)
  .max(10);
const changeInput = z
  .object({
    text: line(600).optional(),
    expires: z.iso.date().nullable().optional(),
    confirm: z.literal(true).optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 0);
const archivedInput = z.object({ path, archived: z.iso.datetime({ offset: true }) }).strict();
const settingsInput = z
  .object({ saving: z.boolean().optional(), sensitive: z.boolean().optional() })
  .strict()
  .refine((input) => Object.keys(input).length > 0);
function fail(message: string, statusCode = 400): never {
  throw Object.assign(new Error(message), { statusCode });
}

export async function importMemoryFile(store: PrivateObjectStore, directory: string) {
  const bytes = await readFile(join(directory, 'MEMORY.md')).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
  if (bytes)
    await store.write(key, bytes, { expectedVersion: null }).catch((error) => {
      if (!(error instanceof ObjectStoreConflict)) throw error;
    });
  await rm(directory, { recursive: true, force: true });
}

export function createMemoryService(options: {
  pool: Pool;
  ownerId: string;
  store: PrivateObjectStore;
}) {
  async function load() {
    const object = await options.store.read(key, maxBytes);
    return { tree: parse(object?.bytes), bytes: object?.bytes, version: object?.version ?? null };
  }

  async function edit<T>(change: (tree: Tree) => T, { allowDisabled = false } = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = await load();
      if (!current.tree.enabled && !allowDisabled) throw new Error('Memory is turned off.');
      const result = change(current.tree);
      const bytes = render(current.tree);
      if (current.bytes ? Buffer.from(current.bytes).equals(bytes) : isEmpty(current.tree))
        return result;
      try {
        await options.store.write(key, bytes, { expectedVersion: current.version });
        return result;
      } catch (error) {
        if (!(error instanceof ObjectStoreConflict) || attempt === 2) throw error;
      }
    }
  }

  async function context() {
    const { tree } = await load();
    const index = indexLayout(tree).text;
    const settings = {
      ...(tree.enabled ? {} : { savingEnabled: false }),
      ...(tree.sensitive ? { sensitiveTopics: 'allowed' } : {}),
    };
    return Object.keys(settings).length
      ? JSON.stringify({ ...settings, ...JSON.parse(index) })
      : index;
  }

  async function watermark() {
    const { rows } = await options.pool.query(
      `SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return `${rows[0].now}/${nilId}`;
  }

  async function currentSource(
    provenance: { sourceMessageId: string | null; turnId: string },
    quote: string,
  ) {
    const source = await options.pool.query(
      "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND role='user' AND turn_id=$3",
      [id.parse(provenance.sourceMessageId), options.ownerId, id.parse(provenance.turnId)],
    );
    if (!source.rowCount || flat(String(source.rows[0].text)) !== flat(quote))
      throw new Error('The complete current owned user message is required.');
  }

  async function learn(
    raw: unknown,
    provenance: { sourceMessageId: string | null; turnId: string },
  ) {
    const input = learnInput.parse(raw);
    const text = line(600).parse(flat(input.quote));
    if (unsafe(text))
      throw new Error(
        'Sign-in details, payment secrets and instructions to the assistant cannot be remembered.',
      );
    await currentSource(provenance, text);
    const sourceMessageId = id.parse(provenance.sourceMessageId);
    return edit((tree) => {
      const now = new Date().toISOString();
      const match = input.slug
        ? undefined
        : areaEntries(tree, input.area).find((entry) => fold(entry.text) === fold(text));
      const name = input.slug ?? match?.slug ?? slugFor(tree, input.area, text);
      const existing = locate(tree, `${input.area}/${name}`);
      const replaced = !!existing && existing.text !== text;
      if (replaced && !input.replace)
        throw new Error(
          'A change of memory text needs a replacement. For an additional fact or exception, choose a distinct new slug. Use replace:true only for a correction that preserves the details still valid.',
        );
      if (!existing && tree.entries.length >= maxEntries)
        throw new Error('The memory is full. Forget entries first.');
      if (existing && replaced) archive(tree, existing, 'superseded', now);
      const abstract = replaced ? undefined : existing?.abstract;
      const expires = input.expires ?? (replaced ? undefined : existing?.expires);
      const entry: Entry = {
        area: input.area,
        slug: name,
        text,
        ...(abstract ? { abstract } : {}),
        origin: 'stated',
        updated: now,
        sources: replaced
          ? [sourceMessageId]
          : [...new Set([...(existing?.sources ?? []), sourceMessageId])].slice(-5),
        ...(expires ? { expires } : {}),
      };
      tree.entries = [...tree.entries.filter((item) => item !== existing), entry];
      return { path: pathOf(entry), text: entry.text, status: 'stated' };
    });
  }

  async function control(
    raw: unknown,
    provenance: { sourceMessageId: string | null; turnId: string },
  ) {
    const input = z
      .object({
        enabled: z.boolean().optional(),
        clear: z.boolean().default(false),
        quote: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(raw);
    if (input.enabled === undefined && !input.clear)
      throw new Error('Choose whether to turn memory on, turn it off or clear it.');
    await currentSource(provenance, input.quote);
    const mark = await watermark();
    return edit(
      (tree) => {
        if (input.enabled !== undefined) tree.enabled = input.enabled;
        if (input.clear) {
          tree.entries = [];
          tree.archive = [];
        }
        tree.reflected = mark;
        tree.retries = 0;
        return { enabled: tree.enabled, cleared: input.clear };
      },
      { allowDisabled: true },
    );
  }

  async function forget(raw: unknown) {
    const target = path.parse(raw);
    return edit(
      (tree) => {
        const entry = locate(tree, target);
        const archived = tree.archive.length;
        tree.archive = tree.archive.filter((item) => pathOf(item) !== target && item.by !== target);
        if (!entry && tree.archive.length === archived)
          fail('This note is no longer in memory.', 404);
        tree.entries = tree.entries.filter((item) => item !== entry);
        return { ok: true };
      },
      { allowDisabled: true },
    );
  }

  function owned<T>(change: (tree: Tree, now: string) => T) {
    return edit((tree) => change(tree, new Date().toISOString()), { allowDisabled: true });
  }

  function safe(text: string | undefined) {
    if (unsafe(text))
      fail('Passwords, codes, card numbers and instructions to Otto can’t be saved as notes.');
  }

  function duplicate(tree: Tree, target: Area, text: string, except?: Entry) {
    if (areaEntries(tree, target).some((entry) => entry !== except && same(entry.text, text)))
      fail('You already have this note.');
  }

  async function add(raw: unknown) {
    const input = noteInput.parse(raw);
    safe(input.text);
    return owned((tree, now) => {
      duplicate(tree, input.area, input.text);
      if (tree.entries.length >= maxEntries) fail('Memory is full. Forget a note first.');
      const entry: Entry = {
        area: input.area,
        slug: slugFor(tree, input.area, input.text),
        text: input.text,
        origin: 'stated',
        updated: now,
        edited: now,
        sources: [],
        ...(input.expires ? { expires: input.expires } : {}),
      };
      tree.entries.push(entry);
      return pathOf(entry);
    });
  }

  async function adopt(notes: Array<{ area: Area; text: string }>) {
    const valid = notes.map((note) => ({
      area: area.parse(note.area),
      text: line(600).parse(note.text),
    }));
    return owned((tree, now) =>
      valid.every((note) => {
        if (unsafe(note.text)) return true;
        const match = areaEntries(tree, note.area).find((entry) => same(entry.text, note.text));
        if (match?.origin === 'inferred')
          Object.assign(match, { origin: 'stated', updated: now, edited: now });
        if (match) return true;
        if (tree.entries.length >= maxEntries) return false;
        tree.entries.push({
          area: note.area,
          slug: slugFor(tree, note.area, note.text),
          text: note.text,
          origin: 'stated',
          updated: now,
          edited: now,
          sources: [],
        });
        return true;
      }),
    );
  }

  async function restate(raw: unknown) {
    const notes = restateInput.parse(raw);
    notes.forEach((note) => safe(note.text));
    return owned((tree, now) => {
      for (const note of notes) {
        const current = locate(tree, pathOf(note));
        if (current?.origin === 'stated' && current.text === note.text) continue;
        if (current) archive(tree, current, 'superseded', now);
        if (areaEntries(tree, note.area).some((entry) => same(entry.text, note.text))) continue;
        if (tree.entries.length >= maxEntries) fail('Memory is full. Forget a note first.');
        tree.entries.push({ ...note, origin: 'stated', updated: now, edited: now, sources: [] });
      }
    });
  }

  async function style(raw: string) {
    const text = line(600).parse(raw);
    safe(text);
    return edit((tree) => {
      const now = new Date().toISOString();
      const current = locate(tree, 'preferences/writing-style');
      if (current && (current.origin !== 'email' || current.text === text)) return;
      if (current) archive(tree, current, 'superseded', now);
      else if (tree.entries.length >= maxEntries) fail('Memory is full. Forget a note first.');
      tree.entries.push({
        area: 'preferences',
        slug: 'writing-style',
        text,
        origin: 'email',
        updated: now,
        sources: [],
      });
    });
  }

  async function change(target: string, raw: unknown) {
    const at = path.parse(target);
    const input = changeInput.parse(raw);
    safe(input.text);
    await owned((tree, now) => {
      const entry = locate(tree, at) ?? fail('This note is no longer in memory.', 404);
      const text = input.text ?? entry.text;
      const expires = input.expires === undefined ? entry.expires : (input.expires ?? undefined);
      const rewritten = text !== entry.text;
      if (!rewritten && expires === entry.expires && !input.confirm) return;
      if (rewritten) {
        duplicate(tree, entry.area, text, entry);
        archive(tree, entry, 'superseded', now);
      }
      tree.entries = [
        ...tree.entries.filter((item) => item !== entry),
        {
          area: entry.area,
          slug: entry.slug,
          text,
          ...(!rewritten && entry.abstract ? { abstract: entry.abstract } : {}),
          origin: rewritten || input.confirm ? 'stated' : entry.origin,
          updated: now,
          edited: now,
          sources: rewritten ? [] : entry.sources,
          ...(expires ? { expires } : {}),
        },
      ];
    });
  }

  async function restore(raw: unknown) {
    const input = archivedInput.parse(raw);
    return owned((tree, now) => {
      const item =
        tree.archive.find(
          (entry) => pathOf(entry) === input.path && entry.archived === input.archived,
        ) ?? fail('This note is no longer in the archive.', 404);
      const current = locate(tree, input.path);
      const replaces =
        !!current && item.reason === 'superseded' && (item.by ?? input.path) === input.path;
      duplicate(tree, item.area, item.text, replaces ? current : undefined);
      if (!replaces && tree.entries.length >= maxEntries)
        fail('Memory is full. Forget a note first.');
      tree.archive = tree.archive.filter((entry) => entry !== item);
      if (current && replaces) archive(tree, current, 'superseded', now);
      const entry: Entry = {
        area: item.area,
        slug: current && !replaces ? freeSlug(tree, item.area, item.slug) : item.slug,
        text: item.text,
        ...(item.abstract ? { abstract: item.abstract } : {}),
        origin: 'stated',
        updated: now,
        edited: now,
        sources: item.sources,
        ...(item.expires && item.expires >= now.slice(0, 10) ? { expires: item.expires } : {}),
      };
      tree.entries.push(entry);
      return pathOf(entry);
    });
  }

  async function forgetArchived(raw: unknown) {
    const input = archivedInput.parse(raw);
    await owned((tree) => {
      const kept = tree.archive.filter(
        (entry) => !(pathOf(entry) === input.path && entry.archived === input.archived),
      );
      if (kept.length === tree.archive.length) fail('This note is no longer in the archive.', 404);
      tree.archive = kept;
    });
  }

  async function settings(raw: unknown) {
    const input = settingsInput.parse(raw);
    const mark = await watermark();
    await owned((tree) => {
      if (input.saving !== undefined && input.saving !== tree.enabled) {
        tree.enabled = input.saving;
        tree.reflected = mark;
        tree.retries = 0;
      }
      if (input.sensitive !== undefined) tree.sensitive = input.sensitive;
    });
  }

  async function view() {
    const { tree } = await load();
    const ids = [...new Set([...tree.entries, ...tree.archive].flatMap((entry) => entry.sources))];
    const { rows } = await options.pool.query(
      `SELECT m.id,left(m.text,600) AS text,m.created_at,split_part(COALESCE(u.channel,'web'),':',1) AS channel
       FROM messages m LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.role='user' AND m.id=ANY($2::uuid[])`,
      [options.ownerId, ids],
    );
    const found = new Map(
      rows.map((row) => [
        row.id as string,
        { id: row.id, text: row.text, at: row.created_at.toISOString(), channel: row.channel },
      ]),
    );
    return memoryView(
      tree,
      (source) => found.get(source) ?? { id: source, text: null, at: null, channel: null },
    );
  }

  return {
    context,
    enabled: async () => (await load()).tree.enabled,
    learn,
    control,
    forget,
    edit,
    add,
    adopt,
    restate,
    style,
    change,
    restore,
    forgetArchived,
    settings,
    view,
    load: async () => (await load()).tree,
    find: async (raw: unknown) => {
      const input = findInput.parse(raw);
      return find((await load()).tree, input.query, input.area);
    },
    read: async (raw: unknown) => open((await load()).tree, readInput.parse(raw).path),
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
