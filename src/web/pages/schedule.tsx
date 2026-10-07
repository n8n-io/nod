import { useEffect, useId, useRef, useState } from 'react';
import { CalendarClock, ChevronDown } from 'lucide-react';
import type { Schedule, ScheduleHistory, ScheduleRun } from '../../shared/contracts';
import { activeStatuses, StatusIcon, statusLabels } from '../components/turn-status';
import { usePageData } from '../hooks/use-page-data';
import { api } from '../lib/api';
import { scheduleDate, scheduleLabel } from '../lib/schedules';
import { useDateFormat } from '../lib/date-format';
import { DeletePlan } from '../components/delete-plan';
import { MessageText } from '../components/message';
import { PlanFooter } from '../components/plan-controls';

const historyPath = '/api/schedule-runs?limit=20';

export function ScheduleRow({
  schedule,
  onAsk,
}: {
  schedule: Schedule;
  onAsk(text: string): void;
}) {
  const dateFormat = useDateFormat();
  const canResume =
    schedule.kind !== 'once' || Boolean(schedule.runAt && Date.parse(schedule.runAt) > Date.now());
  return (
    <article className="saved-plan saved-schedule">
      <div className="saved-plan-title">
        <h2>{schedule.title}</h2>
        <span className="saved-plan-status">
          {!schedule.enabled ? 'Paused' : schedule.kind === 'once' ? 'One time' : 'Recurring'}
        </span>
      </div>
      <p className="saved-schedule-time">
        <CalendarClock size={16} aria-hidden="true" />
        {schedule.kind === 'once'
          ? schedule.runAt
            ? scheduleDate(schedule.runAt, schedule.timeZone, dateFormat)
            : 'Time unavailable'
          : scheduleLabel(schedule.cron ?? '', dateFormat)}
        <span>{schedule.timeZone}</span>
      </p>
      <p className="saved-plan-description">{schedule.prompt}</p>
      {schedule.baselineObservation?.status === 'verified' && (
        <p className="saved-schedule-time">
          Baseline: {schedule.baselineObservation.value} ·{' '}
          {scheduleDate(schedule.baselineObservation.checkedAt, schedule.timeZone, dateFormat)}
        </p>
      )}
      <PlanFooter
        item={schedule}
        canPause={schedule.enabled || canResume}
        meta={
          schedule.kind === 'recurring' && schedule.nextRun
            ? `Next ${scheduleDate(schedule.nextRun, schedule.timeZone, dateFormat)}`
            : ''
        }
        remove={<DeletePlan id={schedule.id} title={schedule.title} />}
        onAsk={onAsk}
      />
    </article>
  );
}

export function ScheduleRunRow({ run }: { run: ScheduleRun }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const dateFormat = useDateFormat();
  return (
    <article className={`saved-plan schedule-run${open ? ' schedule-run-open' : ''}`}>
      <div className="saved-plan-title">
        <h2>{run.title}</h2>
        <span className="task-status" data-status={run.status}>
          <StatusIcon status={run.status} />
          {statusLabels[run.status]}
        </span>
      </div>
      <p className="saved-schedule-time">
        <CalendarClock size={16} aria-hidden="true" />
        <time dateTime={run.scheduledFor}>
          {scheduleDate(run.scheduledFor, run.timeZone, dateFormat)}
        </time>
        <span>{run.timeZone}</span>
      </p>
      {run.error && <p className="schedule-run-error">{run.error}</p>}
      {run.observation && (
        <p>
          {run.observation.status === 'verified' ? run.observation.value : 'Source unavailable'} ·{' '}
          Checked{' '}
          <time dateTime={run.observation.checkedAt}>
            {scheduleDate(run.observation.checkedAt, run.timeZone, dateFormat)}
          </time>{' '}
          · {run.observation.summary}{' '}
          <a href={run.observation.sourceUrl} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </p>
      )}
      {run.messageId ? (
        <>
          <button
            type="button"
            className="schedule-run-preview"
            aria-expanded={open}
            aria-controls={open ? bodyId : undefined}
            aria-label={`${open ? 'Hide' : 'Read'} the message from ${run.title}`}
            onClick={() => setOpen(!open)}
          >
            {!open && <span>{run.messagePreview}</span>}
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {open && (
            <div className="schedule-run-body" id={bodyId}>
              <MessageText text={run.messageText ?? run.messagePreview ?? ''} />
            </div>
          )}
        </>
      ) : (
        !run.observation && <p className="schedule-run-empty">No message</p>
      )}
    </article>
  );
}

export function useScheduleHistory() {
  const { data, error, loading, refreshing, refresh } = usePageData<ScheduleHistory>(historyPath);
  const [earlier, setEarlier] = useState<ScheduleHistory | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState('');
  const request = useRef<AbortController | null>(null);
  const earlierSnapshot = useRef(earlier);
  const pageRuns = useRef(new Map<string, Set<string>>());
  earlierSnapshot.current = earlier;
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!data) return;
    const recentIds = new Set(data.runs.map((run) => run.id));
    const pending = new Map(
      (earlierSnapshot.current?.runs ?? [])
        .filter((run) => activeStatuses.includes(run.status) && !recentIds.has(run.id))
        .map((run) => [run.id, run.createdAt]),
    );
    if (!pending.size) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
    const known = [...pageRuns.current]
      .filter(([, ids]) => [...ids].some((id) => pending.has(id)))
      .map(([cursor]) => cursor);
    const refreshed = new Map<string, ScheduleHistory>();
    async function refreshPage(cursor: string) {
      if (refreshed.has(cursor)) return refreshed.get(cursor)!;
      const next = await api<ScheduleHistory>(
        `${historyPath}&cursor=${encodeURIComponent(cursor)}`,
        { signal },
      );
      signal.throwIfAborted();
      refreshed.set(cursor, next);
      pageRuns.current.set(cursor, new Set(next.runs.map((run) => run.id)));
      for (const run of next.runs) pending.delete(run.id);
      setEarlier((previous) =>
        previous
          ? {
              ...previous,
              runs: [
                ...new Map([...previous.runs, ...next.runs].map((run) => [run.id, run])).values(),
              ],
            }
          : previous,
      );
      return next;
    }
    void (async () => {
      for (const cursor of known) {
        if (!pending.size) break;
        await refreshPage(cursor);
      }
      let cursor = data.nextCursor;
      const visited = new Set<string>();
      while (pending.size && cursor && !visited.has(cursor)) {
        visited.add(cursor);
        const next = await refreshPage(cursor);
        const oldest = [...pending.values()].sort()[0];
        if (oldest && next.runs.at(-1)?.createdAt && next.runs.at(-1)!.createdAt < oldest) break;
        cursor = next.nextCursor;
      }
      if (!signal.aborted) setEarlierError('');
    })().catch(() => {
      if (!controller.signal.aborted) setEarlierError('Could not load schedule history.');
    });
    return () => controller.abort();
  }, [data]);
  const cursor = earlier ? earlier.nextCursor : data?.nextCursor;
  const runs = [
    ...new Map(
      [...(earlier?.runs ?? []), ...(data?.runs ?? [])].map((run) => [run.id, run]),
    ).values(),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  async function loadEarlier() {
    if (!cursor || loadingEarlier) return;
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    setLoadingEarlier(true);
    setEarlierError('');
    try {
      const next = await api<ScheduleHistory>(
        `${historyPath}&cursor=${encodeURIComponent(cursor)}`,
        { signal: controller.signal },
      );
      if (!controller.signal.aborted) {
        pageRuns.current.set(cursor, new Set(next.runs.map((run) => run.id)));
        setEarlier((previous) => ({
          runs: [...(previous?.runs ?? []), ...(data?.runs ?? []), ...next.runs],
          nextCursor: next.nextCursor,
        }));
      }
    } catch {
      if (!controller.signal.aborted) setEarlierError('Could not load schedule history.');
    } finally {
      if (!controller.signal.aborted) setLoadingEarlier(false);
    }
  }
  return {
    data,
    error,
    loading,
    refreshing,
    refresh,
    runs,
    cursor,
    loadEarlier,
    loadingEarlier,
    earlierError,
  };
}
