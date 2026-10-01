import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { Embedder } from '../ports/embedder.ts';
import { pathOf, type Entry } from './memory-tree.ts';

const batch = 100;

export const embeddedText = (entry: Entry) => `${entry.slug.replaceAll('-', ' ')}: ${entry.text}`;
const fingerprint = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16);

function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    left += a[index] ** 2;
    right += b[index] ** 2;
  }
  return left && right ? dot / Math.sqrt(left * right) : 0;
}

export function createMemoryVectors(options: { pool: Pool; ownerId: string; embedder?: Embedder }) {
  const { pool, ownerId, embedder } = options;

  async function initialize() {
    await pool.query(
      'CREATE TABLE IF NOT EXISTS memory_vectors (owner_id text NOT NULL, path text NOT NULL, model text NOT NULL, digest text NOT NULL, embedding real[] NOT NULL, PRIMARY KEY (owner_id, path))',
    );
  }

  async function similarity(entries: Entry[], query: string) {
    const scores = new Map<string, number>();
    if (!embedder?.configured || !entries.length) return scores;
    try {
      const stored = new Map<string, { digest: string; embedding: number[] }>(
        (
          await pool.query(
            'SELECT path,digest,embedding FROM memory_vectors WHERE owner_id=$1 AND model=$2',
            [ownerId, embedder.model],
          )
        ).rows.map((row) => [row.path, row]),
      );
      const wanted = entries.map((entry) => {
        const text = embeddedText(entry);
        return { path: pathOf(entry), text, digest: fingerprint(text) };
      });
      const missing = wanted.filter((item) => stored.get(item.path)?.digest !== item.digest);
      const texts = [query, ...missing.map((item) => item.text)];
      const vectors: number[][] = [];
      for (let from = 0; from < texts.length; from += batch)
        vectors.push(...(await embedder.embed(texts.slice(from, from + batch))));
      for (const [index, item] of missing.entries()) {
        const embedding = vectors[index + 1];
        stored.set(item.path, { digest: item.digest, embedding });
        await pool.query(
          'INSERT INTO memory_vectors(owner_id,path,model,digest,embedding) VALUES($1,$2,$3,$4,$5) ON CONFLICT (owner_id,path) DO UPDATE SET model=EXCLUDED.model,digest=EXCLUDED.digest,embedding=EXCLUDED.embedding',
          [ownerId, item.path, embedder.model, item.digest, embedding],
        );
      }
      await pool.query('DELETE FROM memory_vectors WHERE owner_id=$1 AND NOT (path = ANY($2))', [
        ownerId,
        wanted.map((item) => item.path),
      ]);
      for (const item of wanted)
        scores.set(item.path, cosine(vectors[0], stored.get(item.path)!.embedding));
    } catch {
      scores.clear();
    }
    return scores;
  }

  async function drop(path: string) {
    await pool.query('DELETE FROM memory_vectors WHERE owner_id=$1 AND path=$2', [ownerId, path]);
  }

  return { initialize, similarity, drop };
}
