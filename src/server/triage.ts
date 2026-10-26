import { pool } from './db.ts';
import { transaction } from './transaction.ts';
import { ownerId } from './config.ts';
import { boss } from './thread.ts';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import type { WorkConsumers } from './work-admission.ts';
import { logFailure } from './failure-log.ts';
import { createPreferencesStore } from './preferences.ts';

const preferencesStore = createPreferencesStore(pool, ownerId);
export const getPreferences = preferencesStore.get;
export const updatePreferences = preferencesStore.update;

export function createTriage(options: {
  consumers?: WorkConsumers;
  signal(sourceId: string, client: PoolClient, summary: string): Promise<void>;
  due(): Promise<unknown>;
  sweep?(): Promise<void>;
}) {
  async function heartbeat() {
    await options.sweep?.();
    await options.due().catch((error: unknown) => logFailure('proactive_due', error));
  }
  async function triageEvent(
    summary: string,
    _eventId: string,
    current?: (client: PoolClient) => Promise<boolean>,
    connectionId?: string | string[],
  ) {
    const sources = Array.isArray(connectionId) ? connectionId : connectionId ? [connectionId] : [];
    if (!sources.length) return;
    const accepted = await transaction(async (client) => {
      if (current && !(await current(client))) return false;
      for (const source of new Set(sources)) await options.signal(source, client, summary);
      return true;
    }, pool);
    if (!accepted) return;
    const queued = await options.due();
    return typeof queued === 'string' ? queued : undefined;
  }
  async function initializeHeartbeat() {
    await boss.createQueue('heartbeat', { retryLimit: 0 });
    await boss.schedule('heartbeat', '*/5 * * * *', {}, { tz: 'UTC' });
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
    app.patch('/api/preferences', async (request) => updatePreferences(request.body));
  }
  return {
    getPreferences,
    updatePreferences,
    triageEvent,
    heartbeat,
    initializeHeartbeat,
    registerRoutes: registerTriageRoutes,
  };
}
