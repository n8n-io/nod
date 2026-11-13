import { useEffect, useRef, useState } from 'react';
import { CalendarClock, LoaderCircle, Play, Sparkles } from '../components/icons';
import type { Schedule, ScheduleHistory, ScheduleRun } from '../../shared/contracts';
import { StatusIcon, statusLabels } from '../components/turn-status';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, requestAccountVersion } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { schedulesPath, uncertainScheduleMutation } from '../lib/schedule-reconciliation';
import { scheduleDate, scheduleLabel } from '../lib/schedules';
import { useDateFormat } from '../lib/date-format';
import { DeletePlan } from '../components/delete-plan';
import { MessageText } from '../components/message';
import {
  PauseSwitch,
  PlanDetails,
  ScheduleEditor,
  useDirectChange,
} from '../components/plan-controls';
import { Button, Loading, Notice } from '../components/ui';
import { money } from '../lib/money';

export function ScheduleRow({
  schedule,
  onAsk,
}: {
  schedule: Schedule;
  onAsk(text: string): void;
}) {
  const dateFormat = useDateFormat();
  const [showRuns, setShowRuns] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState('');
  const [resultTurnId, setResultTurnId] = useState<string>();
  const pendingRun = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  const working = useRef(false);
  const change = useDirectChange(schedule.id);
  const date = (value: string) => scheduleDate(value, schedule.timeZone, dateFormat);
  const canPause =
    schedule.enabled ||
    schedule.kind !== 'once' ||
    Boolean(schedule.runAt && Date.parse(schedule.runAt) > Date.now());
  const ranOnce =
    schedule.kind === 'once' &&
    !schedule.enabled &&
    schedule.lastRun &&
    Boolean(schedule.runAt && Date.parse(schedule.runAt) <= Date.now());
  const runLabel = starting
    ? 'Starting…'
    : schedule.activeRun
      ? statusLabels[schedule.activeRun.status]
      : pendingRun.current
        ? 'Try again'
        : 'Run now';
  async function runNow() {
    if (working.current || schedule.activeRun) return;
    working.current = true;
    setStarting(true);
    setRunError('');
    setShowRuns(true);
    setDetailsOpen(true);
    const accountVersion = requestAccountVersion();
    const input = pendingRun.current ?? {
      requestId: crypto.randomUUID(),
      expectedRevision: schedule.revision,
    };
    pendingRun.current = input;
    try {
      const run = await api<{ turnId: string; activeRun: Schedule['activeRun'] }>(
        `${schedulesPath}/${encodeURIComponent(schedule.id)}/run`,
        { method: 'POST', body: JSON.stringify(input), signal: AbortSignal.timeout(45_000) },
      );
      if (accountVersion !== requestAccountVersion()) return;
      pendingRun.current = null;
      setResultTurnId(run.turnId);
      pageDataCache.update<Schedule[]>(
        schedulesPath,
        (items) =>
          items?.map((item) =>
            item.id === schedule.id ? { ...item, activeRun: run.activeRun } : item,
          ) ?? null,
      );
    } catch (cause) {
      if (accountVersion !== requestAccountVersion()) return;
      const uncertain = uncertainScheduleMutation(cause);
      if (!uncertain) pendingRun.current = null;
      setRunError(
        uncertain
          ? `Could not confirm that the run started. ${errorMessage(cause)} Select Try again to check or start the same run.`
          : errorMessage(cause),
      );
    } finally {
      working.current = false;
      setStarting(false);
      if (accountVersion === requestAccountVersion()) {
        pageDataCache.revalidateActive('/api/schedule-runs');
        void pageDataCache.refresh(schedulesPath, true);
      }
    }
  }
  return (
    <article className="saved-plan">
      <div className="saved-plan-title">
        <h2>{schedule.title}</h2>
        <span className="saved-plan-status">
          {ranOnce
            ? statusLabels[schedule.lastRun!.status]
            : !schedule.enabled
              ? 'Paused'
              : schedule.kind === 'once'
                ? 'One time'
                : 'Recurring'}
        </span>
        {canPause && <PauseSwitch schedule={schedule} change={change} />}
      </div>
      <p className="saved-plan-meta">
        <CalendarClock size={16} aria-hidden="true" />
        <span>
          {schedule.kind === 'once'
            ? schedule.runAt
              ? date(schedule.runAt)
              : 'Time unavailable'
            : scheduleLabel(schedule.cron ?? '', dateFormat)}
        </span>
        {schedule.kind === 'recurring' && schedule.nextRun && (
          <span>Next {date(schedule.nextRun)}</span>
        )}
        {schedule.timeZone !== dateFormat.timeZone && <span>{schedule.timeZone}</span>}
        {schedule.monthlyUsd !== null && <span>≈{money(schedule.monthlyUsd)} a month</span>}
      </p>
      {runError && <Notice>{runError}</Notice>}
      <PlanDetails
        label={schedule.title}
        open={detailsOpen}
        onOpenChange={(open) => {
          setDetailsOpen(open);
          if (open) setShowRuns(true);
        }}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={starting || Boolean(schedule.activeRun) || change.busy || change.uncertain}
              aria-label={`${runLabel} for ${schedule.title}`}
              aria-busy={starting}
              aria-live="polite"
              onClick={() => void runNow()}
            >
              {starting ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : schedule.activeRun ? (
                <StatusIcon status={schedule.activeRun.status} />
              ) : (
                <Play size={16} aria-hidden="true" />
              )}
              {runLabel}
            </Button>
            <ScheduleEditor schedule={schedule} change={change} />
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Ask Nod about ${schedule.title}`}
              onClick={() =>
                onAsk(
                  `Help me adjust the schedule ${JSON.stringify(schedule.title)}, ${schedule.kind === 'once' && schedule.runAt ? date(schedule.runAt) : scheduleLabel(schedule.cron ?? '', dateFormat)} (${schedule.timeZone}). Ask me what I want to change.`,
                )
              }
            >
              <Sparkles size={16} aria-hidden="true" />
              Ask Nod
            </Button>
            <DeletePlan id={schedule.id} title={schedule.title} />
          </>
        }
      >
        <p className="saved-plan-description">{schedule.prompt}</p>
        {schedule.baselineObservation?.status === 'verified' && (
          <p className="saved-plan-note">
            Baseline: {schedule.baselineObservation.value} ·{' '}
            {date(schedule.baselineObservation.checkedAt)}
          </p>
        )}
        {showRuns && <ScheduleRuns schedule={schedule} resultTurnId={resultTurnId} />}
      </PlanDetails>
    </article>
  );
}

function ScheduleRunRow({ run, openResult }: { run: ScheduleRun; openResult: boolean }) {
  const dateFormat = useDateFormat();
  const [open, setOpen] = useState(openResult);
  useEffect(() => {
    if (openResult) setOpen(true);
  }, [openResult]);
  const date = (value: string) => scheduleDate(value, run.timeZone, dateFormat);
  return (
    <li className="schedule-run">
      <div className="schedule-run-heading">
        <time dateTime={run.scheduledFor}>{date(run.scheduledFor)}</time>
        <span className="task-status" data-status={run.status}>
          <StatusIcon status={run.status} />
          {statusLabels[run.status]}
        </span>
      </div>
      {run.timeZone !== dateFormat.timeZone && <p className="saved-plan-note">{run.timeZone}</p>}
      {typeof run.costUsd === 'number' && (
        <p className="saved-plan-note">
          {money(run.costUsd)}
          {['queued', 'running', 'waiting'].includes(run.status) ? ' so far' : ' recorded cost'}
        </p>
      )}
      {run.error && <p className="schedule-run-error">{run.error}</p>}
      {run.observation && (
        <p className="saved-plan-note">
          {run.observation.status === 'verified' ? run.observation.value : 'Source unavailable'} ·{' '}
          Checked{' '}
          <time dateTime={run.observation.checkedAt}>{date(run.observation.checkedAt)}</time> ·{' '}
          {run.observation.summary}{' '}
          <a href={run.observation.sourceUrl} target="_blank" rel="noopener noreferrer">
            Source
          </a>
        </p>
      )}
      {run.messageId && (
        <PlanDetails
          label={`${run.title}, ${date(run.scheduledFor)}`}
          summary={run.messagePreview}
          open={open}
          onOpenChange={setOpen}
        >
          <MessageText text={run.messageText ?? run.messagePreview ?? ''} />
        </PlanDetails>
      )}
    </li>
  );
}

function ScheduleRuns({ schedule, resultTurnId }: { schedule: Schedule; resultTurnId?: string }) {
  const history = useScheduleHistory(schedule.id);
  return (
    <section className="schedule-runs" aria-label={`Runs for ${schedule.title}`}>
      <h3>Runs</h3>
      {history.error && (
        <Notice>
          Could not load runs.{' '}
          <Button
            variant="ghost"
            size="sm"
            disabled={history.refreshing}
            onClick={() => void history.refresh()}
          >
            {history.refreshing ? 'Retrying…' : 'Try again'}
          </Button>
        </Notice>
      )}
      {!history.data && history.loading && <Loading label="Loading runs…" />}
      {history.data && !history.runs.length && <p className="saved-plan-note">No runs yet.</p>}
      {history.runs.length > 0 && (
        <ol className="schedule-runs-list">
          {history.runs.map((run) => (
            <ScheduleRunRow key={run.id} run={run} openResult={run.turnId === resultTurnId} />
          ))}
        </ol>
      )}
      {history.earlierError && <Notice>{history.earlierError}</Notice>}
      {history.cursor && (
        <Button
          variant="ghost"
          className="schedule-history-more"
          size="sm"
          disabled={history.loadingEarlier}
          onClick={() => void history.loadEarlier()}
        >
          {history.loadingEarlier ? 'Loading…' : 'Load earlier runs'}
        </Button>
      )}
    </section>
  );
}

function useScheduleHistory(scheduleId: string) {
  const historyPath = `/api/schedule-runs?scheduleId=${encodeURIComponent(scheduleId)}&limit=10`;
  const recent = usePageData<ScheduleHistory>(historyPath);
  const [earlier, setEarlier] = useState<ScheduleHistory | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [earlierError, setEarlierError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const cursor = earlier ? earlier.nextCursor : recent.data?.nextCursor;
  const runs = [
    ...new Map(
      [...(earlier?.runs ?? []), ...(recent.data?.runs ?? [])].map((run) => [run.id, run]),
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
      if (!controller.signal.aborted)
        setEarlier({ runs: [...runs, ...next.runs], nextCursor: next.nextCursor });
    } catch {
      if (!controller.signal.aborted) setEarlierError('Could not load earlier runs.');
    } finally {
      if (!controller.signal.aborted) setLoadingEarlier(false);
    }
  }
  return { ...recent, runs, cursor, loadEarlier, loadingEarlier, earlierError };
}
