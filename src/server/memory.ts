import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { PrivateObjectStore } from '../ports/object-storage.ts';

const key = 'memory/MEMORY.md';
const maxBytes = 64 * 1024;
const maxEntries = 50;
const id = z.uuid();
const kind = z.enum(['fact', 'preference', 'pattern']);
export const personalSecret =
  /\b(?:password|passcode|passphrase|otp|pin|2fa|api[ _-]?key|secret|token|bearer|private[ _-]?key|security code|cvv|cvc|verification code|recovery code|palavra[ _-]?passe|senha|código de verificação)\b|\bsk-[A-Za-z0-9_-]{12,}|\b(?:\d[ -]?){14,19}\b/i;
const block =
  /^## ([0-9a-f-]{36})\nKind: (fact|preference|pattern)\nUpdated: (\d{4}-\d\d-\d\dT[^\n]+)\nSources: ([0-9a-f-, ]+)\n\n([^\n]+)$/;
const entrySchema = z.object({
  id,
  kind,
  updated: z.iso.datetime({ offset: true }),
  sources: z.array(id).min(1).max(5),
  text: z.string().min(1).max(300),
});

const saveInput = z
  .object({
    id: id.optional(),
    kind,
    text: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .refine((text) => !/[\r\n]/.test(text)),
    replace: z.boolean().optional(),
  })
  .strict();

type Entry = z.infer<typeof entrySchema>;

function validate(raw: unknown) {
  const input = saveInput.parse(raw);
  if (personalSecret.test(input.text))
    throw new Error('Sign-in details and payment secrets cannot be remembered.');
  return input;
}

// Invalid or secret-bearing blocks are skipped so one bad entry cannot disable or leak memory; the next write drops them.
function parse(bytes?: Uint8Array): Entry[] {
  if (!bytes) return [];
  const body = new TextDecoder().decode(bytes).replace(/^# Memory\n/, '');
  const entries = new Map<string, Entry>();
  for (const part of body.split(/\n(?=## )/)) {
    const match = block.exec(part.trim());
    const entry = entrySchema.safeParse(
      match && {
        id: match[1],
        kind: match[2],
        updated: match[3],
        sources: match[4].split(', '),
        text: match[5],
      },
    );
    if (entry.success && !personalSecret.test(entry.data.text) && !entries.has(entry.data.id))
      entries.set(entry.data.id, entry.data);
  }
  return [...entries.values()];
}

function render(entries: Entry[]) {
  const body = entries
    .map(
      (entry) =>
        `## ${entry.id}\nKind: ${entry.kind}\nUpdated: ${entry.updated}\nSources: ${entry.sources.join(', ')}\n\n${entry.text}`,
    )
    .join('\n\n');
  const bytes = new TextEncoder().encode(`# Memory\n${body ? `\n${body}\n` : ''}`);
  if (bytes.length > maxBytes) throw new Error('The memory file is full.');
  return bytes;
}

function visible(entry: Entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    text: entry.text,
    status:
      entry.kind === 'pattern' ? (entry.sources.length > 1 ? 'observed' : 'tentative') : 'stated',
    sources: entry.sources,
    updated: entry.updated,
  };
}

export function createMemoryService(options: {
  pool: Pool;
  ownerId: string;
  store: PrivateObjectStore;
}) {
  // Threads that predate the table may already hold outside content in their Pi sessions, so mark them all once.
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

  // A thread is marked before Pi first receives web, file, app or earlier-conversation content.
  // Pi keeps that content in its session, so inferred saves need confirmation until the thread is reset.
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

  async function read() {
    const object = await options.store.read(key, maxBytes);
    return { entries: parse(object?.bytes), version: object?.version ?? null };
  }

  async function context() {
    const { entries } = await read();
    return entries
      .toSorted((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, maxEntries)
      .map((entry) => visible(entry))
      .map(({ id, kind, text, status }) => ({ id, kind, text, status }));
  }

  async function list() {
    return (await read()).entries.map(visible);
  }

  async function cites(messageId: string | null) {
    return (await read()).entries.some((entry) => !!messageId && entry.sources.includes(messageId));
  }

  // An approval is already bound to its requesting user message, so it skips the current-turn check.
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
    const current = await read();
    const existing = input.id
      ? current.entries.find((entry) => entry.id === input.id)
      : current.entries.find((entry) => entry.text.toLowerCase() === input.text.toLowerCase());
    if (input.id && !existing) throw new Error('The memory entry was not found.');
    if (existing && existing.kind !== input.kind && !input.replace)
      throw new Error('A change of memory type needs a replacement.');
    if (existing && existing.text !== input.text && !input.replace)
      throw new Error('A change of memory text needs a replacement.');
    const entry: Entry = {
      id: existing?.id ?? randomUUID(),
      kind: input.kind,
      text: input.text,
      sources: input.replace
        ? [sourceMessageId]
        : [...new Set([...(existing?.sources ?? []), sourceMessageId])].slice(-5),
      updated: new Date().toISOString(),
    };
    const entries = existing
      ? current.entries.map((item) => (item.id === existing.id ? entry : item))
      : [...current.entries, entry];
    if (!existing && entries.length > maxEntries) throw new Error('The memory file is full.');
    await options.store.write(key, render(entries), { expectedVersion: current.version });
    return visible(entry);
  }

  async function forget(raw: unknown) {
    const selected = id.parse(raw);
    const current = await read();
    const entries = current.entries.filter((entry) => entry.id !== selected);
    if (entries.length === current.entries.length)
      throw new Error('The memory entry was not found.');
    await options.store.write(key, render(entries), { expectedVersion: current.version });
    return { ok: true };
  }

  return { initialize, markUntrusted, untrusted, validate, context, list, cites, save, forget };
}
