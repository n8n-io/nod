import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { z } from 'zod';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';
import { snapshotAnalytics, type CaptureAnalytics } from './analytics.ts';
import { captureSettingChanges } from './analytics-settings.ts';
import { activeThreadSql } from './history.ts';
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
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();
const findInput = z.object({ query: z.string().trim().min(1), area: area.optional() }).strict();
const readInput = z.object({ path: z.union([area, path]) }).strict();
const noteInput = z.object({ area, text: line(), expires: z.iso.date().optional() }).strict();
const importInput = z
  .object({ notes: z.array(z.object({ area, text: z.string() }).strict()) })
  .strict();
const restateInput = z.array(z.object({ area, slug, text: line() }).strict()).min(1);
const changeInput = z
  .object({
    text: line().optional(),
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
export const controlInput = z
  .object({ enabled: z.boolean().optional(), clear: z.boolean().default(false) })
  .strict()
  .refine((input) => input.enabled !== undefined || input.clear, {
    message: 'Choose whether to turn memory on, turn it off or clear it.',
  });
export const forgetInput = z.object({ path }).strict();
export const forgetReview = z.object({ path, note: z.string() }).strict();
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
  pool: Pick<Pool, 'query'>;
  ownerId: string;
  store: PrivateObjectStore;
  analytics?: CaptureAnalytics;
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
    return [
      ...(tree.enabled ? [] : ['savingEnabled: false']),
      ...(tree.sensitive ? ['sensitiveTopics: allowed'] : []),
      ...Object.entries(indexLayout(tree, { tentative: true })).flatMap(([area, rows]) =>
        rows.map((row) => `${area}/${row}`),
      ),
    ].join('\n');
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

  async function control(raw: unknown) {
    const input = controlInput.parse(raw);
    const capture = snapshotAnalytics(options.analytics);
    const mark = await watermark();
    const result = await edit(
      (tree) => {
        const before = { enabled: tree.enabled };
        const invalidate =
          input.clear || (input.enabled !== undefined && input.enabled !== tree.enabled);
        if (input.enabled !== undefined) tree.enabled = input.enabled;
        if (invalidate) tree.generation++;
        if (input.clear) {
          tree.entries = [];
          tree.archive = [];
          tree.skills = [];
        }
        tree.reflected = mark;
        tree.retries = 0;
        return { before, after: { enabled: tree.enabled }, cleared: input.clear };
      },
      { allowDisabled: true },
    );
    captureSettingChanges(capture, 'agent', result.before, result.after, {
      enabled: 'memory_enabled',
    });
    return { ...result.after, cleared: result.cleared };
  }

  function noteText(tree: Tree, target: string) {
    return (locate(tree, target) ?? tree.archive.find((item) => pathOf(item) === target))?.text;
  }

  async function forget(raw: unknown, expected?: string) {
    const target = path.parse(raw);
    return edit(
      (tree) => {
        if (expected !== undefined && noteText(tree, target) !== expected)
          fail('The note changed. Review it before asking again.', 409);
        const entry = locate(tree, target);
        const archived = tree.archive.length;
        const versions = new Set([target]);
        for (let size = 0; size !== versions.size;) {
          size = versions.size;
          for (const item of tree.archive)
            if (item.by && versions.has(item.by)) versions.add(pathOf(item));
        }
        tree.archive = tree.archive.filter((item) => !versions.has(pathOf(item)));
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
      fail('Passwords, codes, card numbers and instructions to Nod can’t be saved as notes.');
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
    const valid = notes.flatMap((note) => {
      const text = line().safeParse(note.text);
      return text.success && !unsafe(text.data)
        ? [{ area: area.parse(note.area), text: text.data }]
        : [];
    });
    return owned((tree, now) => {
      let added = 0;
      let confirmed = 0;
      for (const note of valid) {
        const match = areaEntries(tree, note.area).find((entry) => same(entry.text, note.text));
        if (match?.origin === 'inferred') {
          Object.assign(match, { origin: 'stated', updated: now, edited: now });
          confirmed++;
        }
        if (match) continue;
        tree.entries.push({
          area: note.area,
          slug: slugFor(tree, note.area, note.text),
          text: note.text,
          origin: 'stated',
          updated: now,
          edited: now,
          sources: [],
        });
        added++;
      }
      return {
        added,
        existing: valid.length - added,
        skipped: notes.length - valid.length,
        saved: added + confirmed > 0,
      };
    });
  }

  async function importNotes(raw: unknown) {
    return adopt(importInput.parse(raw).notes);
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
        tree.entries.push({ ...note, origin: 'stated', updated: now, edited: now, sources: [] });
      }
    });
  }

  async function style(raw: string, generation?: number) {
    const text = line().parse(raw);
    safe(text);
    return edit((tree) => {
      if (generation !== undefined && tree.generation !== generation)
        throw new Error('Memory changed while writing style was being learned.');
      const now = new Date().toISOString();
      const current = locate(tree, 'preferences/writing-style');
      if (current && (current.origin !== 'email' || current.text === text)) return;
      if (current) archive(tree, current, 'superseded', now);
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
    return owned((tree, now) => {
      const entry = locate(tree, at) ?? fail('This note is no longer in memory.', 404);
      const text = input.text ?? entry.text;
      const expires = input.expires === undefined ? entry.expires : (input.expires ?? undefined);
      const rewritten = text !== entry.text;
      if (!rewritten && expires === entry.expires && !input.confirm) return false;
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
          ...(!rewritten && entry.fact ? { fact: entry.fact } : {}),
          ...(!rewritten && entry.quote ? { quote: entry.quote } : {}),
          origin: rewritten || input.confirm ? 'stated' : entry.origin,
          updated: now,
          edited: now,
          sources: rewritten ? [] : entry.sources,
          ...(expires ? { expires } : {}),
        },
      ];
      return true;
    });
  }

  async function archiveNote(raw: unknown) {
    const target = path.parse(raw);
    await owned((tree, now) => {
      const entry = locate(tree, target) ?? fail('This note is no longer in memory.', 404);
      archive(tree, entry, 'manual', now);
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
      tree.archive = tree.archive.filter((entry) => entry !== item);
      if (current && replaces) archive(tree, current, 'superseded', now);
      const entry: Entry = {
        area: item.area,
        slug: current && !replaces ? freeSlug(tree, item.area, item.slug) : item.slug,
        text: item.text,
        ...(item.abstract ? { abstract: item.abstract } : {}),
        ...(item.fact ? { fact: item.fact } : {}),
        ...(item.quote ? { quote: item.quote } : {}),
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
      const removed = tree.archive.find(
        (entry) => pathOf(entry) === input.path && entry.archived === input.archived,
      );
      const kept = tree.archive.filter(
        (entry) => !(pathOf(entry) === input.path && entry.archived === input.archived),
      );
      if (kept.length === tree.archive.length) fail('This note is no longer in the archive.', 404);
      tree.archive = kept.map((entry) =>
        entry.by === input.path && removed?.by ? { ...entry, by: removed.by } : entry,
      );
    });
  }

  async function settings(raw: unknown) {
    const input = settingsInput.parse(raw);
    const capture = snapshotAnalytics(options.analytics);
    const mark = await watermark();
    const change = await owned((tree) => {
      const before = { enabled: tree.enabled, sensitive: tree.sensitive };
      if (input.saving !== undefined && input.saving !== tree.enabled) {
        tree.enabled = input.saving;
        tree.generation++;
        tree.reflected = mark;
        tree.retries = 0;
      }
      if (input.sensitive !== undefined && input.sensitive !== tree.sensitive) {
        tree.sensitive = input.sensitive;
        tree.generation++;
      }
      return { before, after: { enabled: tree.enabled, sensitive: tree.sensitive } };
    });
    captureSettingChanges(capture, 'owner', change.before, change.after, {
      enabled: 'memory_enabled',
      sensitive: 'memory_sensitive',
    });
  }

  async function sources(ids: string[]) {
    const { rows } = await options.pool.query(
      `SELECT m.id,m.text,m.created_at,split_part(COALESCE(u.channel,'web'),':',1) AS channel,
       COALESCE(${activeThreadSql()},false) AS can_open
       FROM messages m LEFT JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
       WHERE m.owner_id=$1 AND m.role='user' AND m.id=ANY($2::uuid[])`,
      [options.ownerId, ids],
    );
    return new Map(
      rows.map((row) => [
        row.id as string,
        {
          id: row.id,
          text: row.text,
          at: row.created_at.toISOString(),
          channel: row.channel,
          canOpenInCurrentChat: row.can_open === true,
        },
      ]),
    );
  }

  async function view() {
    const { tree } = await load();
    const ids = [...new Set([...tree.entries, ...tree.archive].flatMap((entry) => entry.sources))];
    const found = await sources(ids);
    const learnedIn = tree.skills.flatMap((skill) => skill.turn ?? []);
    const turns = new Map(
      learnedIn.length
        ? (
            await options.pool.query(
              'SELECT id,left(prompt,200) AS prompt FROM turns WHERE owner_id=$1 AND id=ANY($2::uuid[])',
              [options.ownerId, learnedIn],
            )
          ).rows.map((row) => [row.id as string, String(row.prompt)])
        : [],
    );
    return memoryView(
      tree,
      (source) => found.get(source) ?? { id: source, text: null, at: null, channel: null },
      (turn) => (turn && turns.get(turn)) || null,
    );
  }

  return {
    context,
    enabled: async () => (await load()).tree.enabled,
    currentSource,
    control,
    forget,
    edit,
    add,
    adopt,
    importNotes,
    restate,
    style,
    change,
    archiveNote,
    restore,
    forgetArchived,
    settings,
    view,
    load: async () => (await load()).tree,
    find: async (raw: unknown) => {
      const input = findInput.parse(raw);
      return find((await load()).tree, input.query, input.area);
    },
    read: async (raw: unknown) => {
      const { tree } = await load();
      const result = open(tree, readInput.parse(raw).path);
      if (!('sources' in result)) return result;
      const quote = locate(tree, result.path)?.quote;
      const found = await sources(result.sources);
      return {
        ...result,
        sources: result.sources.map((id) => {
          const source = found.get(id) ?? { id, text: null, at: null, channel: null };
          return {
            ...source,
            text: quote && source.text && fold(source.text).includes(fold(quote)) ? quote : null,
          };
        }),
      };
    },
    note: async (raw: unknown) => noteText((await load()).tree, path.parse(raw)),
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
