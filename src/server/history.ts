import { z } from 'zod';
import type { Pool } from 'pg';
export function activeThreadSql(alias = 'm') {
  return `${alias}.thread_id=(SELECT th.id FROM threads th WHERE th.owner_id=${alias}.owner_id AND th.archived_at IS NULL)`;
}

const inputSchema = z
  .object({
    query: z.string().trim().min(1).max(4000).optional(),
    before: z.uuid().optional(),
    cursor: z.uuid().optional(),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    around: z.uuid().optional(),
    order: z.enum(['relevance', 'newest']).default('relevance'),
  })
  .refine((input) => input.query || input.around || input.from || input.to, {
    message: 'Search with query, from or to, or read around a result id.',
  })
  .refine((input) => !input.from || !input.to || input.from <= input.to, {
    message: 'The start date must not follow the end date.',
  });

export interface HistoryMessage {
  id: string;
  role: string;
  text: string;
  shortened: boolean;
  created_at: Date;
  match?: boolean;
}

export function createHistorySearch({
  pool,
  ownerId,
}: {
  pool: Pick<Pool, 'query'>;
  ownerId: string;
}) {
  return async function search(raw: unknown) {
    const { query, before, cursor, from, to, around, order } = inputSchema.parse(raw);
    if (around) {
      const { rows } = await pool.query<HistoryMessage>(
        `WITH hit AS (SELECT m.created_at,m.id FROM messages m WHERE m.id=$2 AND m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}),
         nearby AS (
           (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')} AND (m.created_at,m.id)<(hit.created_at,hit.id) ORDER BY m.created_at DESC,m.id DESC LIMIT 5)
           UNION ALL (SELECT m.* FROM messages m,hit WHERE m.id=hit.id)
           UNION ALL (SELECT m.* FROM messages m,hit WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')} AND (m.created_at,m.id)>(hit.created_at,hit.id) ORDER BY m.created_at,m.id LIMIT 5))
         SELECT id,role,CASE WHEN id=$2 THEN text ELSE left(text,6000) END AS text,id<>$2 AND length(text)>6000 AS shortened,turn_id,created_at FROM nearby ORDER BY created_at,id`,
        [ownerId, around],
      );
      if (!rows.length) throw new Error('This history result is unavailable.');
      return { messages: rows, complete: true, totalMatches: 1, nextCursor: null };
    }
    const boundary = before
      ? (
          await pool.query<{ at: Date }>(
            `SELECT m.created_at AS at FROM messages m WHERE m.id=$2 AND m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}
           UNION ALL SELECT u.created_at FROM turns u WHERE u.id=$2 AND u.owner_id=$1 AND ${activeThreadSql('u')} LIMIT 1`,
            [ownerId, before],
          )
        ).rows[0]
      : undefined;
    if (before && !boundary) throw new Error('This history result is unavailable.');
    const terms = `WITH terms AS (SELECT replace(plainto_tsquery('english',coalesce($2,''))::text,'&','|')::tsquery AS q,
      coalesce((SELECT time_zone FROM preferences WHERE owner_id=$1),'UTC') AS zone)`;
    const scope = (alias: string) =>
      `${alias}.owner_id=$1 AND ${activeThreadSql(alias)}
       AND ($3::timestamptz IS NULL OR (${alias}.created_at,${alias}.id)<($3,$4::uuid))
       AND ($5::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date>=$5)
       AND ($6::date IS NULL OR (${alias}.created_at AT TIME ZONE terms.zone)::date<=$6)`;
    const where = (alias: string, column: string) =>
      `${scope(alias)} AND ($2::text IS NULL OR to_tsvector('english',${column}) @@ terms.q)`;
    const ordered = (alias: string, column: string) =>
      `${query && order === 'relevance' ? `ts_rank_cd(to_tsvector('english',${column}),terms.q,1) DESC,` : ''}${alias}.created_at DESC,${alias}.id DESC`;
    const values = [
      ownerId,
      query ?? null,
      boundary?.at ?? null,
      before ?? null,
      from ?? null,
      to ?? null,
    ];
    const turns = await pool.query(
      `${terms} SELECT u.id,left(u.prompt,200) AS title,u.status,u.source,u.created_at,split_part(u.channel,':',1) AS channel
       FROM turns u CROSS JOIN terms WHERE ${where('u', 'u.prompt')} ORDER BY ${ordered('u', 'u.prompt')} LIMIT 15`,
      values,
    );
    const page = await pool.query<HistoryMessage & { place: string; total: number }>(
      `${terms}, corpus AS (
         SELECT m.id,m.role,m.text,m.created_at,to_tsvector('english',m.text) AS v
         FROM messages m CROSS JOIN terms WHERE ${scope('m')} AND m.hidden_at IS NULL),
       docs AS (SELECT corpus.* FROM corpus CROSS JOIN terms WHERE $2::text IS NULL OR corpus.v @@ terms.q),
       weights AS (
         SELECT w,ln(1+((SELECT count(*) FROM corpus)-count(*)+0.5)/(count(*)+0.5)) AS idf
         FROM (SELECT DISTINCT lexeme AS w FROM unnest(tsvector_to_array(to_tsvector('english',coalesce($2,'')))) lexeme) words
         JOIN docs ON docs.v @@ quote_literal(w)::tsquery GROUP BY w),
       scores AS (
         SELECT d.id,d.role,d.text,d.created_at,coalesce(sum(weights.idf),0) AS score
         FROM docs d LEFT JOIN weights ON d.v @@ quote_literal(weights.w)::tsquery
         GROUP BY d.id,d.role,d.text,d.created_at),
       ranked AS (
         SELECT id,role,text,created_at,row_number() OVER (ORDER BY ${query && order === 'relevance' ? 'score DESC,' : ''}created_at DESC,id DESC) AS place FROM scores),
       position AS (SELECT place FROM ranked WHERE id=$7::uuid),
       hits AS (SELECT * FROM ranked WHERE $7::uuid IS NULL OR place>(SELECT place FROM position) ORDER BY place LIMIT 21)
       SELECT hits.id,hits.role,left(hits.text,6000) AS text,length(hits.text)>6000 AS shortened,hits.created_at,hits.place,
         (SELECT count(*)::int FROM ranked) AS total FROM hits ORDER BY place`,
      [...values, cursor ?? null],
    );
    if (cursor && !page.rows.length) {
      const { rows } = await pool.query(
        `${terms} SELECT m.id FROM messages m CROSS JOIN terms WHERE ${where('m', 'm.text')} AND m.hidden_at IS NULL AND m.id=$7::uuid`,
        [...values, cursor],
      );
      if (!rows.length) throw new Error('This history cursor does not match the search.');
    }
    const picked = page.rows.slice(0, 20);
    const nextCursor = page.rows.length > 20 ? picked.at(-1)!.id : null;
    const { rows: messages } = await pool.query<HistoryMessage>(
      `WITH terms AS (SELECT replace(plainto_tsquery('english',coalesce($4,''))::text,'&','|')::tsquery AS q),
       thread AS (
         SELECT m.id,m.role,m.text,m.turn_id,m.created_at,row_number() OVER (ORDER BY m.created_at,m.id) AS n
         FROM messages m WHERE m.owner_id=$1 AND m.hidden_at IS NULL AND ${activeThreadSql('m')}),
       picked AS (SELECT t.n,ids.place,t.id FROM unnest($2::uuid[]) WITH ORDINALITY ids(id,place) JOIN thread t ON t.id=ids.id),
       shown AS (
         SELECT t.*,bool_or(p.id=t.id) AS match,min(p.place) AS place FROM thread t
         JOIN picked p ON t.n BETWEEN p.n-$3 AND p.n+$3 GROUP BY t.id,t.role,t.text,t.turn_id,t.created_at,t.n)
       SELECT s.id,s.role,CASE WHEN length(s.text)<=1200 THEN s.text
         ELSE ts_headline('english',s.text,terms.q,'StartSel="",StopSel="",MaxWords=60,MinWords=20,MaxFragments=3,FragmentDelimiter=" … "') END AS text,
         length(s.text)>1200 AS shortened,s.turn_id,s.created_at,
         split_part(COALESCE(u.channel,'web'),':',1) AS channel,s.match
       FROM shown s CROSS JOIN terms LEFT JOIN turns u ON u.id=s.turn_id AND u.owner_id=$1 ORDER BY s.place,s.n`,
      [ownerId, picked.map((row) => row.id), query ? 1 : 0, query ?? null],
    );
    return {
      turns: turns.rows,
      messages,
      complete: !nextCursor,
      totalMatches: page.rows[0]?.total ?? 0,
      nextCursor,
    };
  };
}
