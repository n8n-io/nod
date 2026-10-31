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
         SELECT id,source,parent_turn_id,status,created_at,started_at,finished_at,ARRAY[id] AS visited
         FROM turns WHERE owner_id=$1 AND source IN ('user','resume')
         UNION ALL
         SELECT p.id,p.source,p.parent_turn_id,l.status,l.created_at,l.started_at,l.finished_at,l.visited||p.id
         FROM lineage l JOIN turns p ON p.id=l.parent_turn_id AND p.owner_id=$1
         WHERE l.source='resume' AND NOT p.id=ANY(l.visited)
       )
       SELECT count(*) FILTER (WHERE status='succeeded')::integer AS count,
         count(DISTINCT finished_at::date) FILTER (WHERE status='succeeded')::integer AS days,
         extract(epoch FROM now()-(min(finished_at) FILTER (WHERE status='succeeded')))/86400 AS age,
         extract(epoch FROM now()-(max(finished_at) FILTER (WHERE status='succeeded')))/86400 AS last_success,
         extract(epoch FROM now()-max(GREATEST(created_at,started_at,finished_at)))/86400 AS inactive
       FROM lineage WHERE source='user'`,
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
