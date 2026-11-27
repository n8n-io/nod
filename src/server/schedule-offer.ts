import type { Pool, PoolClient } from 'pg';
import { ownerId } from './config.ts';

export const scheduleOfferPause = '3 days';

export async function scheduleOfferAllowed(database: Pool | PoolClient, owner = ownerId) {
  const { rows } = await database.query<{ allowed: boolean }>(
    `SELECT NOT EXISTS (SELECT 1 FROM schedules WHERE owner_id=$1 AND kind='recurring')
       AND NOT EXISTS (SELECT 1 FROM preferences WHERE owner_id=$1 AND schedule_offer_at > now() - $2::interval)
       AS allowed`,
    [owner, scheduleOfferPause],
  );
  return rows[0]?.allowed === true;
}

export async function recordScheduleOffer(client: PoolClient, owner = ownerId) {
  await client.query(
    `INSERT INTO preferences (owner_id, schedule_offer_at) VALUES ($1, now())
     ON CONFLICT (owner_id) DO UPDATE SET schedule_offer_at = now()`,
    [owner],
  );
}
