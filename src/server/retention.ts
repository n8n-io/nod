import type { Pool } from 'pg';

const hour = 3_600_000;

export function createRetention(pool: Pool, ownerId: string, table: string, column: string) {
  let lastPruned = -Infinity;
  let pruning: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  function prune(force = false, database: Pool = pool): Promise<void> {
    if (pruning) return pruning;
    if (!force && Date.now() - lastPruned < hour) return Promise.resolve();
    pruning = database
      .query(`DELETE FROM ${table} WHERE owner_id=$1 AND ${column} < now() - interval '7 days'`, [
        ownerId,
      ])
      .then(() => {
        lastPruned = Date.now();
      })
      .finally(() => {
        pruning = undefined;
      });
    return pruning;
  }
  return {
    prune,
    schedule() {
      if (timer) return;
      timer = setInterval(() => {
        void prune(true).catch(() => {});
      }, hour);
      timer.unref();
    },
    async stop() {
      clearInterval(timer);
      timer = undefined;
      await Promise.allSettled([pruning]);
    },
  };
}
