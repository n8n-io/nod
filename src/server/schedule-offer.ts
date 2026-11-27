import type { Pool, PoolClient } from 'pg';
import { ownerId } from './config.ts';

export type ScheduleOfferPhase = 'open' | 'pending';
export type ScheduleOfferAnswer = 'offer' | 'declined';

export async function scheduleOfferPhase(
  database: Pool | PoolClient,
  owner = ownerId,
): Promise<ScheduleOfferPhase | undefined> {
  const { rows } = await database.query<{ active: boolean; open: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM schedules WHERE owner_id=$1 AND kind='recurring')
         AND p.schedule_offer_declined_at IS NULL
         AND (p.schedule_offer_first_at IS NULL OR p.schedule_offer_first_at > now() - interval '3 days')
         AS active,
       (p.schedule_offer_at IS NULL OR p.schedule_offer_at <= now() - interval '1 day') AS open
     FROM (SELECT $1::text AS owner_id) o LEFT JOIN preferences p ON p.owner_id=o.owner_id`,
    [owner],
  );
  const row = rows[0];
  if (!row?.active) return undefined;
  return row.open ? 'open' : 'pending';
}

export async function recordScheduleOffer(
  client: PoolClient,
  answer: ScheduleOfferAnswer,
  owner = ownerId,
) {
  await client.query(
    answer === 'offer'
      ? `INSERT INTO preferences (owner_id, schedule_offer_first_at, schedule_offer_at) VALUES ($1, now(), now())
         ON CONFLICT (owner_id) DO UPDATE SET schedule_offer_at=now(),
           schedule_offer_first_at=COALESCE(preferences.schedule_offer_first_at, now())`
      : `INSERT INTO preferences (owner_id, schedule_offer_declined_at) VALUES ($1, now())
         ON CONFLICT (owner_id) DO UPDATE SET schedule_offer_declined_at=now()`,
    [owner],
  );
}
