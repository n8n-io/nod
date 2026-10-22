import type { Pool } from 'pg';
import type { Activity } from '../shared/contracts.ts';
import { events, type ServerEvent } from './events.ts';
import { logFailure } from './failure-log.ts';
import { ownerStarted } from './thread.ts';

export type LiveWork = Activity & { channel: string };

const query = `SELECT DISTINCT ON (u.session_id) u.id,u.channel,COALESCE(u.started_at,u.created_at) AS since,
    t.id AS task_id,t.title,w.site,
    COALESCE((SELECT e.summary FROM turn_events e WHERE e.turn_id=u.id AND e.type='step'
       AND e.created_at>COALESCE(w.spoke,'-infinity') ORDER BY e.created_at DESC,e.id DESC LIMIT 1),t.now_text) AS step
  FROM turns u
  JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id AND th.archived_at IS NULL
  LEFT JOIN LATERAL (SELECT id,title,now_text FROM tasks WHERE owner_id=u.owner_id AND session_id=u.session_id
    ORDER BY created_at DESC LIMIT 1) t ON true
  CROSS JOIN LATERAL (SELECT
    (SELECT site FROM turn_events WHERE turn_id=u.id AND type IN ('tool_start','tool_complete','tool_failed')
       ORDER BY created_at DESC,id DESC LIMIT 1) AS site,
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id
       AND type IN ('started','steered','step','tool_start','tool_complete','tool_failed','agent_start')) AS worked,
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id AND type='final') AS finished,
    (SELECT max(created_at) FROM messages WHERE turn_id=u.id AND owner_id=u.owner_id AND role='assistant') AS spoke) w
  WHERE u.owner_id=$1 AND u.status IN ('queued','running') AND ${ownerStarted()}
    AND (w.finished IS NULL OR w.worked>w.finished)
  ORDER BY u.session_id,u.status='running' DESC,u.created_at,u.id`;

export function createActivity({ pool, ownerId }: { pool: Pool; ownerId: string }) {
  let last = '[]';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishing = Promise.resolve();

  async function read(): Promise<LiveWork[]> {
    const { rows } = await pool.query(query, [ownerId]);
    return rows
      .map((row) => ({
        turnId: row.id,
        taskId: row.task_id,
        title: row.title,
        step: row.step,
        site: row.site,
        since: row.since.toISOString(),
        channel: row.channel,
      }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  const visible = (items: LiveWork[]): Activity[] =>
    items.map(({ turnId, taskId, title, step, site, since }) => ({
      turnId,
      taskId,
      title,
      step,
      site,
      since,
    }));

  function publish() {
    publishing = publishing
      .then(async () => {
        const items = visible(await read());
        const next = JSON.stringify(items);
        if (next === last) return;
        last = next;
        events.emit('event', { type: 'activity', ownerId, items });
      })
      .catch((cause) => logFailure('activity_read_failed', cause));
  }

  const listen = (event: ServerEvent) => {
    if ((event.type !== 'refresh' && event.type !== 'working') || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      publish();
    }, 250);
    timer.unref?.();
  };

  return {
    read,
    current: async () => visible(await read()),
    start() {
      events.on('event', listen);
    },
    close() {
      events.off('event', listen);
      clearTimeout(timer);
    },
  };
}
