import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type { ChannelProvider, PhoneOffer } from '../shared/contracts.ts';

type ChannelState = {
  provider: string;
  status: string;
  ownerLinked: boolean;
  available?: boolean;
};

const phoneChannels: ChannelProvider[] = ['telegram', 'whatsapp'];

export function channelConnected(channel: ChannelState) {
  return channel.status === 'configured' && channel.ownerLinked && channel.available !== false;
}

export function createPhoneOffer(dependencies: {
  pool: Pool;
  ownerId: string;
  channels(): Promise<ChannelState[] | undefined>;
  refresh(): void;
}) {
  const { pool, ownerId } = dependencies;

  async function channels(client: Pool | PoolClient = pool): Promise<ChannelProvider[]> {
    const dismissed = (
      await client.query<{ dismissed: boolean }>(
        'SELECT phone_offer_dismissed AS dismissed FROM preferences WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.dismissed;
    if (dismissed) return [];
    const states = (await dependencies.channels()) ?? [];
    if (states.some(channelConnected)) return [];
    return phoneChannels.filter((provider) =>
      states.some((channel) => channel.provider === provider),
    );
  }

  async function saved(client: PoolClient, turnId: string) {
    if (!(await channels(client)).length) return;
    await client.query(
      `WITH RECURSIVE chain(id,next,source,depth) AS (
         SELECT id,parent_turn_id,source,0 FROM turns WHERE id=$2 AND owner_id=$1 AND session_id=thread_id
         UNION ALL
         SELECT u.id,u.parent_turn_id,u.source,c.depth+1 FROM chain c
         JOIN turns u ON u.id=c.next AND u.owner_id=$1 WHERE c.depth<200
       )
       INSERT INTO preferences(owner_id,phone_offer_turn)
       SELECT $1,$2 WHERE (SELECT source FROM chain ORDER BY depth DESC LIMIT 1)='user'
       ON CONFLICT(owner_id) DO UPDATE SET phone_offer_turn=EXCLUDED.phone_offer_turn
       WHERE NOT preferences.phone_offer_dismissed`,
      [ownerId, turnId],
    );
  }

  async function pending(): Promise<PhoneOffer | undefined> {
    const turnId = (
      await pool.query<{ turnId: string | null }>(
        'SELECT phone_offer_turn AS "turnId" FROM preferences WHERE owner_id=$1',
        [ownerId],
      )
    ).rows[0]?.turnId;
    if (!turnId) return undefined;
    const offered = await channels();
    return offered.length ? { turnId, channels: offered } : undefined;
  }

  async function answer(choice: ChannelProvider | 'not_now') {
    await pool.query(
      `INSERT INTO preferences(owner_id,phone_offer_dismissed) VALUES($1,$2)
       ON CONFLICT(owner_id) DO UPDATE SET phone_offer_turn=NULL,
       phone_offer_dismissed=preferences.phone_offer_dismissed OR EXCLUDED.phone_offer_dismissed`,
      [ownerId, choice === 'not_now'],
    );
    dependencies.refresh();
  }

  function registerRoutes(app: FastifyInstance) {
    app.post('/api/phone-offer', async (request) => {
      const { choice } = z
        .object({ choice: z.enum(['telegram', 'whatsapp', 'not_now']) })
        .strict()
        .parse(request.body);
      await answer(choice);
      return { ok: true };
    });
  }

  return { channels, saved, pending, answer, registerRoutes };
}
