import type { Pool } from 'pg';
import type { Activity } from '../shared/contracts.ts';
import { events, type ServerEvent } from './events.ts';
import { logFailure } from './failure-log.ts';
import { ownerStarted } from './thread.ts';
import type { KeepAwake } from '../ports/keep-awake.ts';

export type LiveWork = Activity & {
  channel: string;
  messageId?: string;
  receivedMessageIds?: string[];
};

const query = `SELECT DISTINCT ON (u.session_id) u.id,u.channel,u.status,COALESCE(u.started_at,u.created_at) AS since,
    ${ownerStarted()} AS owner_started,t.id AS task_id,t.title,o.site,o.calling,o.tool,
    GREATEST(COALESCE(u.started_at,u.created_at),w.last) AS quiet_since,
    COALESCE(t.message_id,(SELECT m.id FROM messages m WHERE m.turn_id=u.id AND m.owner_id=u.owner_id
      AND m.role='assistant' ORDER BY m.created_at,m.id LIMIT 1)) AS message_id,
    CASE WHEN w.steered>COALESCE(s.created_at,'-infinity') THEN NULL
      WHEN s.type='retry' AND w.last>s.created_at THEN t.now_text ELSE COALESCE(s.summary,t.now_text) END AS step,
    CASE WHEN u.status='running' THEN ARRAY(SELECT q.message_id FROM turns q WHERE q.owner_id=u.owner_id
      AND q.session_id=u.session_id AND q.status='queued' AND q.source IN ('user','task') AND q.message_id IS NOT NULL
      ORDER BY q.created_at,q.id) END AS received_message_ids
  FROM turns u
  JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id AND th.archived_at IS NULL
  LEFT JOIN LATERAL (SELECT id,title,now_text,message_id FROM tasks WHERE owner_id=u.owner_id AND session_id=u.session_id
    ORDER BY created_at DESC LIMIT 1) t ON true
  LEFT JOIN LATERAL (SELECT type,summary,created_at FROM turn_events WHERE turn_id=u.id AND type IN ('step','thought','retry')
    ORDER BY created_at DESC,id DESC LIMIT 1) s ON true
  LEFT JOIN LATERAL (SELECT true AS calling,e.site,e.summary AS tool FROM turn_events e WHERE e.turn_id=u.id AND e.type='tool_start'
    AND e.call_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM turn_events c WHERE c.turn_id=e.turn_id
      AND c.call_id=e.call_id AND c.type IN ('tool_complete','tool_failed'))
    ORDER BY (e.site IS NOT NULL) DESC,e.created_at DESC,e.id DESC LIMIT 1) o ON true
  CROSS JOIN LATERAL (SELECT
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id) AS last,
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id AND type='steered') AS steered,
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id
       AND type IN ('started','steered','step','thought','tool_start','tool_complete','tool_failed','agent_start')) AS worked,
    (SELECT max(created_at) FROM turn_events WHERE turn_id=u.id AND type='final') AS finished) w
  WHERE u.owner_id=$1 AND u.status IN ('queued','running') AND (${ownerStarted()} OR t.id IS NOT NULL)
    AND (w.finished IS NULL OR w.worked>w.finished)
  ORDER BY u.session_id,u.status='running' DESC,u.created_at,u.id`;

const toolLabels = new Map([
  ['codemode', 'Running code'],
  ['bash', 'Running a command'],
  ['read', 'Reading files'],
  ['ls', 'Reading files'],
  ['find', 'Reading files'],
  ['write', 'Writing a file'],
  ['edit', 'Editing a file'],
  ['web search', 'Searching the web'],
  ['fetch content', 'Reading a web page'],
  ['get search content', 'Reading search results'],
  ['browser', 'Using the browser'],
  ['delegate', 'Working with helpers'],
  ['create audio', 'Making audio'],
  ['share file', 'Preparing a file'],
]);

export function createActivity({
  pool,
  ownerId,
  model,
  keepAwake,
  recheckMs = 60_000,
}: {
  pool: Pool;
  ownerId: string;
  model?: () => string | undefined;
  keepAwake?: KeepAwake;
  recheckMs?: number;
}) {
  let last = '[]';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let publishing = Promise.resolve();
  let statusChanged = false;
  let working = false;
  let recheck: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  async function checkWorking() {
    if (!keepAwake) return;
    let next = false;
    let failed = false;
    try {
      const { rows } = await pool.query(
        "SELECT EXISTS(SELECT 1 FROM turns WHERE owner_id=$1 AND status='running') AS working",
        [ownerId],
      );
      next = rows[0].working;
    } catch (cause) {
      failed = true;
      logFailure('working_read_failed', cause);
    }
    if (closed) return;
    if ((next || failed) !== (recheck !== undefined)) {
      clearInterval(recheck);
      recheck =
        next || failed
          ? setInterval(() => {
              publishing = publishing.then(checkWorking);
            }, recheckMs)
          : undefined;
      recheck?.unref?.();
    }
    if (next === working) return;
    working = next;
    keepAwake.set(working);
  }

  async function read(): Promise<LiveWork[]> {
    const { rows } = await pool.query(query, [ownerId]);
    const name = model?.();
    return rows
      .map((row) => ({
        turnId: row.id,
        taskId: row.task_id,
        title: row.title,
        step: row.step,
        site: row.site,
        since: row.since.toISOString(),
        doing: (row.status === 'queued'
          ? 'queued'
          : row.calling
            ? 'tool'
            : 'model') as Activity['doing'],
        quietSince: row.quiet_since.toISOString(),
        ...(row.calling && !row.site && toolLabels.has(row.tool)
          ? { tool: toolLabels.get(row.tool) }
          : {}),
        ...(name ? { model: name } : {}),
        channel: row.channel,
        ...(row.message_id ? { messageId: row.message_id } : {}),
        ...(row.received_message_ids?.length
          ? { received: true as const, receivedMessageIds: row.received_message_ids }
          : {}),
        ...(row.owner_started ? {} : { background: true as const }),
      }))
      .sort((a, b) => a.since.localeCompare(b.since));
  }

  const visible = (items: LiveWork[]): Activity[] =>
    items.map(
      ({ channel: _channel, messageId: _message, receivedMessageIds: _received, ...item }) => item,
    );

  function publish() {
    const changed = statusChanged;
    statusChanged = false;
    publishing = publishing
      .then(async () => {
        const items = visible(await read());
        const next = JSON.stringify(items);
        if (next === last) return;
        last = next;
        events.emit('event', { type: 'activity', ownerId, items });
      })
      .catch((cause) => logFailure('activity_read_failed', cause));
    if (changed) publishing = publishing.then(checkWorking);
  }

  const listen = (event: ServerEvent) => {
    if (event.type !== 'refresh' && event.type !== 'working') return;
    if (event.type === 'refresh') statusChanged = true;
    if (timer) return;
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
      publishing = publishing.then(checkWorking);
    },
    close() {
      events.off('event', listen);
      clearTimeout(timer);
      closed = true;
      clearInterval(recheck);
    },
  };
}
