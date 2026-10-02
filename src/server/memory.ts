import type { Pool } from 'pg';
import { z } from 'zod';
import type { MemoryCurator } from '../ports/memory-curator.ts';
import { ObjectStoreConflict, type PrivateObjectStore } from '../ports/object-storage.ts';
import { relatedPaths } from './memory-search.ts';
import {
  archive,
  area,
  areaEntries,
  brief,
  find,
  fold,
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
  similar,
  slug,
  slugFor,
  unsafe,
  view,
  type Entry,
  type Tree,
} from './memory-tree.ts';

const key = 'memory/MEMORY.md';

const saveInput = z
  .object({
    area,
    slug: slug.optional(),
    text: line(600),
    abstract: line(120).optional(),
    expires: z.iso.date().optional(),
    replace: z.boolean().optional(),
  })
  .strict();
const findInput = z
  .object({ query: z.string().trim().min(1).max(200), area: area.optional() })
  .strict();
const readInput = z.object({ path: z.union([area, path]) }).strict();

export function createMemoryService(options: {
  pool: Pool;
  ownerId: string;
  store: PrivateObjectStore;
  curator?: MemoryCurator;
  onSaved?: (sourceMessageId: string) => Promise<void>;
}) {
  async function initialize() {
    await options.pool.query(`DO $$ BEGIN
      IF to_regclass('memory_untrusted_threads') IS NULL THEN
        CREATE TABLE IF NOT EXISTS memory_untrusted_threads (owner_id text NOT NULL, thread_id uuid NOT NULL, marked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (owner_id, thread_id));
        IF to_regclass('threads') IS NOT NULL THEN
          INSERT INTO memory_untrusted_threads(owner_id,thread_id) SELECT owner_id,id FROM threads ON CONFLICT DO NOTHING;
        END IF;
      END IF;
    END $$`);
  }

  async function markUntrusted(threadId: string) {
    await options.pool.query(
      'INSERT INTO memory_untrusted_threads(owner_id,thread_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [options.ownerId, threadId],
    );
  }

  async function untrusted(threadId: string) {
    const { rowCount } = await options.pool.query(
      'SELECT 1 FROM memory_untrusted_threads WHERE owner_id=$1 AND thread_id=$2',
      [options.ownerId, threadId],
    );
    return !!rowCount;
  }

  async function load() {
    const object = await options.store.read(key, maxBytes);
    return { tree: parse(object?.bytes), bytes: object?.bytes, version: object?.version ?? null };
  }

  async function edit<T>(change: (tree: Tree) => T, allowDisabled = false): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const current = await load();
      if (!current.tree.enabled && !allowDisabled) throw new Error('Memory is turned off.');
      const previous = new Map(
        current.tree.entries.map((entry) => [pathOf(entry), JSON.stringify(entry)]),
      );
      const result = change(current.tree);
      const bytes = render(current.tree);
      if (current.bytes ? Buffer.from(current.bytes).equals(bytes) : isEmpty(current.tree))
        return result;
      try {
        await options.store.write(key, bytes, { expectedVersion: current.version });
        const saved = current.tree.entries.find(
          (entry) => previous.get(pathOf(entry)) !== JSON.stringify(entry),
        );
        if (saved) await options.onSaved?.(saved.sources.at(-1)!);
        return result;
      } catch (error) {
        if (!(error instanceof ObjectStoreConflict) || attempt === 2) throw error;
      }
    }
  }

  function validate(raw: unknown) {
    const input = saveInput.parse(raw);
    if (unsafe(input.text, input.abstract))
      throw new Error(
        'Sign-in details, payment secrets and instructions to the assistant cannot be remembered.',
      );
    return input;
  }

  async function context() {
    const { tree } = await load();
    const index = indexLayout(tree).text;
    return tree.enabled ? index : JSON.stringify({ savingEnabled: false, ...JSON.parse(index) });
  }

  async function currentSource(
    provenance: { sourceMessageId: string | null; turnId: string },
    quote: string,
  ) {
    const source = await options.pool.query(
      "SELECT text FROM messages WHERE id=$1 AND owner_id=$2 AND role='user' AND turn_id=$3",
      [id.parse(provenance.sourceMessageId), options.ownerId, id.parse(provenance.turnId)],
    );
    if (!source.rowCount || String(source.rows[0].text).trim() !== quote)
      throw new Error('The complete current owned user message is required.');
  }

  async function learn(
    raw: unknown,
    provenance: { sourceMessageId: string | null; turnId: string },
  ) {
    const { quote, ...input } = saveInput
      .omit({ text: true, abstract: true })
      .extend({ quote: line(600) })
      .parse(raw);
    await currentSource(provenance, quote);
    return save({ ...input, text: quote }, provenance);
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
    const { rows } = await options.pool.query(
      `SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    return edit((tree) => {
      if (input.enabled !== undefined) tree.enabled = input.enabled;
      if (input.clear) {
        tree.entries = [];
        tree.archive = [];
        tree.overviews = {};
        tree.consolidated = {};
      }
      tree.reflected = `${rows[0].now}/00000000-0000-0000-0000-000000000000`;
      tree.retries = 0;
      return { enabled: tree.enabled, cleared: input.clear };
    }, true);
  }

  async function cites(messageId: string | null) {
    const { tree } = await load();
    return tree.entries.some((entry) => !!messageId && entry.sources.includes(messageId));
  }

  async function save(
    raw: unknown,
    provenance: { sourceMessageId: string | null } & ({ turnId: string } | { approved: true }),
  ) {
    const input = validate(raw);
    const sourceMessageId = id.parse(provenance.sourceMessageId);
    const source = await options.pool.query(
      "SELECT 1 FROM messages WHERE id=$1 AND owner_id=$2 AND role='user' AND ($3::uuid IS NULL OR turn_id=$3)",
      [sourceMessageId, options.ownerId, 'turnId' in provenance ? provenance.turnId : null],
    );
    if (!source.rowCount)
      throw new Error('The current owned user message is required as evidence.');
    return edit((tree) => {
      const now = new Date().toISOString();
      const group = areaEntries(tree, input.area);
      const same = input.slug
        ? undefined
        : group.find((entry) => fold(entry.text) === fold(input.text));
      const near =
        input.slug || same ? undefined : group.find((e) => similar(e.text, input.text, 0.6));
      if (near)
        throw new Error(
          `A similar memory exists at ${pathOf(near)}. Save to its slug to add evidence, or use replace:true for a correction.`,
        );
      const name = input.slug ?? same?.slug ?? slugFor(tree, input.area, input.text);
      const existing = locate(tree, `${input.area}/${name}`);
      const replaced = !!existing && existing.text !== input.text;
      if (replaced && !input.replace)
        throw new Error('A change of memory text needs a replacement.');
      if (!existing && tree.entries.length >= maxEntries)
        throw new Error('The memory is full. Forget entries first.');
      if (existing && replaced) archive(tree, existing, 'superseded', now);
      const abstract = input.abstract ?? (replaced ? undefined : existing?.abstract);
      const expires = input.expires ?? (replaced ? undefined : existing?.expires);
      const entry: Entry = {
        area: input.area,
        slug: name,
        text: input.text,
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

  async function forget(raw: unknown) {
    const target = path.parse(raw);
    return edit((tree) => {
      const entry = locate(tree, target);
      const archived = tree.archive.length;
      tree.archive = tree.archive.filter((item) => pathOf(item) !== target && item.by !== target);
      if (!entry && tree.archive.length === archived)
        throw new Error('The memory entry was not found.');
      tree.entries = tree.entries.filter((item) => item !== entry);
      return { ok: true };
    }, true);
  }

  return {
    initialize,
    markUntrusted,
    untrusted,
    validate,
    context,
    cites,
    enabled: async () => (await load()).tree.enabled,
    saved: async (sourceMessageId: string) => options.onSaved?.(sourceMessageId),
    learn,
    control,
    save,
    forget,
    edit,
    load: async () => (await load()).tree,
    view: async () => view((await load()).tree),
    find: async (raw: unknown) => {
      const input = findInput.parse(raw);
      const { tree } = await load();
      const hits = find(tree, input.query, input.area);
      if (hits.length >= 3 || !options.curator?.configured) return hits;
      const known = new Set(hits.map((hit) => hit.path));
      const extra = (await relatedPaths(options.curator, tree, input.query, input.area))
        .filter((target) => !known.has(target))
        .flatMap((target) => locate(tree, target) ?? []);
      return [...hits, ...extra.map(brief)].slice(0, 10);
    },
    read: async (raw: unknown) => open((await load()).tree, readInput.parse(raw).path),
  };
}

export type MemoryService = ReturnType<typeof createMemoryService>;
