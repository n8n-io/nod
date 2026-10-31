import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { transaction } from './transaction.ts';
import type {
  ProductSurvey,
  ProductSurveyEvent,
  ProductSurveyOffer,
} from '../shared/product-surveys.ts';

export function createProductSurveys(pool: Pool) {
  async function eligible(owner: string, client: PoolClient): Promise<ProductSurvey | null> {
    const result = await client.query<{
      count: number;
      days: number;
      age: number | null;
      inactive: number | null;
      last_success: number | null;
    }>(
      `WITH RECURSIVE lineage AS (
         SELECT u.id,u.source,u.parent_turn_id,u.thread_id,u.session_id,m.id AS message_id,u.status,u.finished_at,
           COALESCE(m.created_at,u.created_at) AS requested_at,ARRAY[u.id] AS visited
         FROM turns u LEFT JOIN messages m ON m.id=u.message_id AND m.owner_id=$1
           AND m.thread_id=u.thread_id AND m.role='user'
         WHERE u.owner_id=$1 AND u.source IN ('user','task','resume')
         UNION ALL
         SELECT p.id,p.source,p.parent_turn_id,p.thread_id,p.session_id,m.id,l.status,l.finished_at,
           COALESCE(m.created_at,p.created_at),l.visited||p.id
         FROM lineage l JOIN turns p ON p.id=l.parent_turn_id AND p.owner_id=$1
           AND p.thread_id=l.thread_id AND p.session_id=l.session_id
         LEFT JOIN messages m ON m.id=p.message_id AND m.owner_id=$1 AND m.thread_id=p.thread_id AND m.role='user'
         WHERE l.source='resume' AND l.message_id IS NULL AND NOT p.id=ANY(l.visited)
       ), requests AS (
         SELECT COALESCE(message_id,id) AS request_id,
           min(finished_at) FILTER (WHERE status='succeeded') AS first_success,
           max(finished_at) FILTER (WHERE status='succeeded') AS last_success,
           max(requested_at) AS last_activity
         FROM lineage
         WHERE source='user' OR (source IN ('task','resume') AND message_id IS NOT NULL)
         GROUP BY COALESCE(message_id,id)
       )
       SELECT count(first_success)::integer AS count,
         count(DISTINCT first_success::date)::integer AS days,
         extract(epoch FROM now()-min(first_success))/86400 AS age,
         extract(epoch FROM now()-max(last_success))/86400 AS last_success,
         extract(epoch FROM now()-max(last_activity))/86400 AS inactive
       FROM requests`,
      [owner],
    );
    const activity = result.rows[0];
    if (!activity || activity.count < 3 || activity.inactive === null) return null;
    if (Number(activity.inactive) >= 7) return 'churn';
    if (
      activity.days >= 3 &&
      Number(activity.age) >= 7 &&
      activity.last_success !== null &&
      Number(activity.last_success) <= 3
    )
      return 'nps';
    return null;
  }
  return {
    async initialize() {
      await pool.query(`CREATE TABLE IF NOT EXISTS product_surveys (
        owner_id text NOT NULL,survey text NOT NULL CHECK(survey IN ('nps','churn')),
        submission_id uuid NOT NULL,status text NOT NULL CHECK(status IN ('offered','shown','sent','dismissed')),
        created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(owner_id,survey)
      );
      ALTER TABLE product_surveys ADD COLUMN IF NOT EXISTS answer jsonb`);
    },
    async offer(owner: string): Promise<ProductSurveyOffer | null> {
      return transaction(async (client) => {
        const survey = await eligible(owner, client);
        if (!survey) return null;
        await client.query(
          `INSERT INTO product_surveys(owner_id,survey,submission_id,status) VALUES($1,$2,$3,'offered')
           ON CONFLICT(owner_id,survey) DO NOTHING`,
          [owner, survey, randomUUID()],
        );
        const result = await client.query<ProductSurveyOffer>(
          `SELECT survey,submission_id::text FROM product_surveys
           WHERE owner_id=$1 AND survey=$2 AND status IN ('offered','shown')`,
          [owner, survey],
        );
        return result.rows[0] ?? null;
      }, pool);
    },
    async respond(owner: string, input: ProductSurveyEvent) {
      return transaction(async (client) => {
        const saved = await client.query<{
          status: ProductSurveyEvent['status'] | 'offered';
          answer: unknown;
        }>(
          'SELECT status,answer FROM product_surveys WHERE owner_id=$1 AND survey=$2 AND submission_id=$3 FOR UPDATE',
          [owner, input.survey, input.submission_id],
        );
        const row = saved.rows[0];
        const answer =
          input.status === 'sent'
            ? input.survey === 'nps'
              ? { score: input.score }
              : { reason: input.reason }
            : null;
        if (!row) return { accepted: false, changed: false };
        if (row.status === input.status) {
          const accepted =
            input.status !== 'sent' || JSON.stringify(row.answer) === JSON.stringify(answer);
          return { accepted, changed: false };
        }
        const previous =
          input.status === 'shown'
            ? ['offered']
            : input.status === 'dismissed'
              ? ['offered', 'shown']
              : ['shown'];
        if (!previous.includes(row.status) || (await eligible(owner, client)) !== input.survey)
          return { accepted: false, changed: false };
        await client.query(
          'UPDATE product_surveys SET status=$4,answer=$5::jsonb,updated_at=now() WHERE owner_id=$1 AND survey=$2 AND submission_id=$3',
          [
            owner,
            input.survey,
            input.submission_id,
            input.status,
            answer ? JSON.stringify(answer) : null,
          ],
        );
        return { accepted: true, changed: true };
      }, pool);
    },
  };
}

export type ProductSurveys = ReturnType<typeof createProductSurveys>;
