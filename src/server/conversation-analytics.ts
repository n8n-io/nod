import type { Pool } from 'pg';

export async function clearConversationAnalytics(pool: Pool, ownerId: string) {
  for (const table of ['analytics_tasks', 'analytics_turns', 'analytics_consent']) {
    const present = (await pool.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name;
    if (present) await pool.query(`DELETE FROM ${table} WHERE owner_id=$1`, [ownerId]);
  }
}
