import { useEffect, useId, useRef, useState } from 'react';
import { PageTitle } from '../components/page-title';
import { CalendarClock, ChevronDown, MessageCircle } from 'lucide-react';
import type { Schedule, ScheduleHistory, ScheduleRun } from '../../shared/contracts';
import { Button, Loading, Notice } from '../components/ui';
import { activeStatuses, StatusIcon, statusLabels } from '../components/turn-status';
import { usePageData } from '../hooks/use-page-data';
import { api } from '../lib/api';
import { scheduleDate, scheduleLabel } from '../lib/schedules';
import { focusChatMessage } from '../lib/secondary-pages';
import { useDateFormat } from '../lib/date-format';
import { DeletePlan } from '../components/delete-plan';
import { MessageText } from '../components/message';
import { NewPlan, PlanFooter, PlanToast } from '../components/plan-controls';

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
    <article className={`schedule-run${open ? ' schedule-run-open' : ''}`}>
      <div className="schedule-run-heading">
        <h2>{run.title}</h2>
        <span className={`schedule-run-status schedule-run-${run.status}`}>
          <StatusIcon status={run.status} />
          {run.status === 'succeeded' ? 'Finished' : statusLabels[run.status]}
        </span>
      </div>
      <p>
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
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open the message from ${run.title} in the conversation`}
                onClick={() => focusChatMessage(run.messageId!)}
              >
                <MessageCircle size={16} aria-hidden="true" />
                Open in conversation
              </Button>
            </div>
          )}
        </>
      ) : (
        !run.observation && <p className="schedule-run-empty">No message</p>
      )}
    </article>
  );
}

function ScheduleHistoryView() {
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
  return (
    <>
      {error && (
        <Notice>
          Could not load schedule history.{' '}
          <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? 'Retrying…' : 'Try again'}
          </Button>
        </Notice>
      )}
      {!data ? (
        loading ? (
          <Loading label="Loading history…" />
        ) : null
      ) : runs.length ? (
        <>
          <div className="schedule-run-list">
            {runs.map((run) => (
              <ScheduleRunRow key={run.id} run={run} />
            ))}
          </div>
          {earlierError && <Notice>{earlierError}</Notice>}
          {cursor && (
            <Button
              variant="ghost"
              className="schedule-history-more"
              size="sm"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </Button>
          )}
        </>
      ) : (
        <div className="secondary-empty">
          <h2>No runs yet</h2>
          <p>Scheduled tasks appear here when they start.</p>
        </div>
      )}
    </>
  );
}

export function SchedulePage({ onAsk }: { onAsk(text: string): void }) {
  const {
    data: schedules,
    error,
    loading,
    refreshing,
    refresh,
  } = usePageData<Schedule[]>('/api/schedules');
  const [view, setView] = useState<'upcoming' | 'history'>('upcoming');
  const upcoming = (schedules ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRun)
    .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!) || a.id.localeCompare(b.id));
  const inactive = (schedules ?? []).filter(
    (schedule) =>
      !upcoming.includes(schedule) &&
      (schedule.kind !== 'once' || schedule.lastRun?.scheduledFor !== schedule.runAt),
  );
  return (
    <div className="content-page secondary-page">
      <PlanToast />
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/schedule" />
          <p>Your scheduled tasks.</p>
        </div>
        <div className="secondary-heading-actions">
          <NewPlan onAsk={onAsk} />
        </div>
      </header>
      <div
        className="schedule-views"
        role="tablist"
        aria-label="Schedule views"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'upcoming'
              : event.key === 'End'
                ? 'history'
                : view === 'upcoming'
                  ? 'history'
                  : 'upcoming';
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`#schedule-tab-${next}`)?.focus();
        }}
      >
        {(['upcoming', 'history'] as const).map((item) => (
          <button
            key={item}
            id={`schedule-tab-${item}`}
            role="tab"
            tabIndex={view === item ? 0 : -1}
            aria-selected={view === item}
            aria-controls={`schedule-panel-${item}`}
            onClick={() => setView(item)}
          >
            {item === 'upcoming' ? 'Upcoming' : 'History'}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`schedule-panel-${view}`}
        aria-labelledby={`schedule-tab-${view}`}
        tabIndex={0}
      >
        {view === 'history' ? (
          <ScheduleHistoryView />
        ) : (
          <>
            {error && (
              <Notice>
                Could not load schedules.{' '}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={refreshing}
                  onClick={() => void refresh()}
                >
                  {refreshing ? 'Retrying…' : 'Try again'}
                </Button>
              </Notice>
            )}
            {!schedules ? (
              loading ? (
                <Loading label="Loading schedule…" />
              ) : null
            ) : (
              <>
                {upcoming.length ? (
                  <div className="saved-plan-list">
                    {upcoming.map((schedule) => (
                      <ScheduleRow key={schedule.id} schedule={schedule} onAsk={onAsk} />
                    ))}
                  </div>
                ) : (
                  <div className="secondary-empty">
                    <h2>No upcoming tasks</h2>
                    <p>Schedule a one-time task or something that repeats.</p>
                  </div>
                )}
                {inactive.length > 0 && (
                  <details className="schedule-inactive" open={!upcoming.length}>
                    <summary>
                      Not scheduled <span>{inactive.length}</span>
                    </summary>
                    <div className="saved-plan-list">
                      {inactive.map((schedule) => (
                        <ScheduleRow key={schedule.id} schedule={schedule} onAsk={onAsk} />
                      ))}
                    </div>
                  </details>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
