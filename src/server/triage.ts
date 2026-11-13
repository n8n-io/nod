import { createHash } from 'node:crypto';
import { pool } from './db.ts';
import { transaction } from './transaction.ts';
import { ownerId } from './config.ts';
import { boss } from './thread.ts';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { WorkConsumers } from './work-admission.ts';
import { logFailure } from './failure-log.ts';
import { createPreferencesStore } from './preferences.ts';
import type { CaptureAnalytics } from './analytics.ts';

const preferencesStore = createPreferencesStore(pool, ownerId);
export const getPreferences = preferencesStore.get;

export function createTriage(options: {
  consumers?: WorkConsumers;
  analytics?: CaptureAnalytics;
  heartbeatKey?: string;
  signal(sourceId: string, client: PoolClient, summary: string): Promise<void>;
  due(): Promise<unknown>;
  sweep?(): Promise<void>;
}) {
  const heartbeatMinute =
    createHash('sha256')
      .update(options.heartbeatKey ?? ownerId)
      .digest()[0] % 5;
  const updatePreferences = createPreferencesStore(pool, ownerId, options.analytics).update;
  async function heartbeat() {
    await options.sweep?.();
    await options.due().catch((error: unknown) => logFailure('proactive_due', error));
  }
  async function recordEvent(
    summary: string,
    _eventId: string,
    current?: (client: PoolClient) => Promise<boolean>,
    connectionId?: string | string[],
  ) {
    const sources = Array.isArray(connectionId) ? connectionId : connectionId ? [connectionId] : [];
    if (!sources.length) return false;
    return transaction(async (client) => {
      if (current && !(await current(client))) return false;
      for (const source of new Set(sources)) await options.signal(source, client, summary);
      return true;
    }, pool);
  }
  async function triageEvent(...event: Parameters<typeof recordEvent>) {
    if (!(await recordEvent(...event))) return;
    const queued = await options.due();
    return typeof queued === 'string' ? queued : undefined;
  }
  async function initializeHeartbeat() {
    await boss.createQueue('heartbeat', { retryLimit: 0 });
    await boss.schedule('heartbeat', `${heartbeatMinute}-59/5 * * * *`, {}, { tz: 'UTC' });
    const start = () => boss.work('heartbeat', heartbeat);
    if (options.consumers)
      await options.consumers.register({
        start,
        stop: (id) => boss.offWork('heartbeat', { id, wait: true }),
      });
    else await start();
  }
  function registerTriageRoutes(app: FastifyInstance) {
    app.get('/api/preferences', getPreferences);
    app.patch('/api/preferences', async (request) =>
      updatePreferences(
        request.body,
        request.headers['x-nod-settings-source'] === 'automatic' ? 'system' : 'owner',
      ),
    );
  }
  return {
    getPreferences,
    updatePreferences,
    recordEvent,
    triageEvent,
    heartbeat,
    initializeHeartbeat,
    registerRoutes: registerTriageRoutes,
  };
}
