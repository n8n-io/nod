import { Fragment, useEffect, useId, useRef, useState, type MouseEvent } from 'react';
import {
  ChevronDown,
  LoaderCircle,
  MessageCircle,
  Play,
  Sparkles,
  Square,
} from '../components/icons';
import type { Activity, Schedule, ScheduleHistory, ScheduleRun } from '../../shared/contracts';
import { StatusIcon, statusLabels } from '../components/turn-status';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage, requestAccountVersion } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { schedulesPath, uncertainScheduleMutation } from '../lib/schedule-reconciliation';
import { scheduleDate, scheduleLabel } from '../lib/schedules';
import { useDateFormat } from '../lib/date-format';
import { DeletePlan } from '../components/delete-plan';
import { LiveLine } from '../components/live-line';
import { MessageText } from '../components/message';
import { PauseSwitch, ScheduleEditor, useDirectChange } from '../components/plan-controls';
import { Button, Loading, Notice } from '../components/ui';
import { money } from '../lib/money';
import { ScheduleCost, ScheduleModel } from '../components/model-choices';

export function ScheduleRow({
  schedule,
  activity,
  onAsk,
  defaultOpen = false,
}: {
  schedule: Schedule;
  activity: Activity[];
  onAsk(text: string): void;
  defaultOpen?: boolean;
}) {
  const dateFormat = useDateFormat();
  const [showRuns, setShowRuns] = useState(defaultOpen);
  const [open, setOpen] = useState(defaultOpen);
  const detailsId = useId();
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [runError, setRunError] = useState('');
  const [resultTurnId, setResultTurnId] = useState<string>();
  const pendingRun = useRef<{ requestId: string; expectedRevision: number } | null>(null);
  const stoppedTurnId = useRef<string | null>(null);
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
  const { activeRun, lastRun } = schedule;
  const live = activity.find(
    (item) =>
      item.scheduleId === schedule.id &&
      item.doing !== 'queued' &&
      item.turnId !== stoppedTurnId.current &&
      (activeRun
        ? activeRun.status !== 'waiting' && activeRun.turnId === item.turnId
        : !lastRun || (item.runId !== lastRun.id && item.since > lastRun.createdAt)),
  );
  const activeStatus = live ? 'running' : activeRun?.status;
  const questionMessageId = activeStatus === 'waiting' ? activeRun?.questionMessageId : null;
  const runLabel = starting
    ? 'Starting…'
    : activeStatus
      ? statusLabels[activeStatus]
      : pendingRun.current
        ? 'Try again'
        : 'Run now';
  async function runNow() {
    if (working.current || activeStatus) return;
    working.current = true;
    setStarting(true);
    setRunError('');
    setShowRuns(true);
    setOpen(true);
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
  async function stopRun() {
    const turnId = activeRun?.turnId;
    if (working.current || !turnId) return;
    working.current = true;
    setStopping(true);
    setRunError('');
    const accountVersion = requestAccountVersion();
    try {
      await api(
        `${schedulesPath}/${encodeURIComponent(schedule.id)}/runs/${encodeURIComponent(turnId)}/stop`,
        {
          method: 'POST',
          signal: AbortSignal.timeout(45_000),
        },
      );
      if (accountVersion !== requestAccountVersion()) return;
      stoppedTurnId.current = turnId;
      pageDataCache.update<Schedule[]>(
        schedulesPath,
        (items) =>
          items?.map((item) =>
            item.id === schedule.id && item.activeRun?.turnId === turnId
              ? { ...item, activeRun: null }
              : item,
          ) ?? null,
      );
    } catch (cause) {
      if (accountVersion === requestAccountVersion())
        setRunError(
          uncertainScheduleMutation(cause)
            ? `Could not confirm that this run stopped. ${errorMessage(cause)} Check its status before trying again.`
            : errorMessage(cause),
        );
    } finally {
      working.current = false;
      setStopping(false);
      if (accountVersion === requestAccountVersion()) {
        pageDataCache.revalidateActive('/api/schedule-runs');
        void pageDataCache.refresh(schedulesPath, true);
      }
    }
  }
  function toggle() {
    setOpen(!open);
    setShowRuns(true);
  }
  function toggleFromRow(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || target.closest('button, a, input, label')) return;
    toggle();
  }
  const timing = [
    ranOnce
      ? statusLabels[schedule.lastRun!.status]
      : !schedule.enabled
        ? 'Paused'
        : schedule.kind === 'once'
          ? 'One time'
          : null,
    schedule.kind === 'once'
      ? schedule.runAt
        ? date(schedule.runAt)
        : 'Time unavailable'
      : scheduleLabel(schedule.cron ?? '', dateFormat),
    schedule.kind === 'recurring' && schedule.enabled && schedule.nextRun
      ? `next ${date(schedule.nextRun)}`
      : null,
    schedule.timeZone !== dateFormat.timeZone ? schedule.timeZone : null,
  ].filter(Boolean);
  const focusQuestion = () =>
    window.dispatchEvent(
      new CustomEvent('nod:focus-message', { detail: { messageId: questionMessageId } }),
    );
  return (
    <article
      className="schedule-row"
      data-open={open || undefined}
      data-paused={!schedule.enabled || undefined}
    >
      <div className="schedule-row-main" onClick={toggleFromRow}>
        <div className="schedule-row-switch">
          {canPause && <PauseSwitch schedule={schedule} change={change} />}
        </div>
        <div className="schedule-row-name">
          <h2>
            <button
              type="button"
              className="schedule-row-title"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={toggle}
            >
              {schedule.title}
            </button>
          </h2>
          <p className="schedule-row-when">
            <span>
              {timing.map((part, index) => (
                <Fragment key={index}>
                  {index > 0 && '\u00a0· '}
                  <span className="schedule-row-part">{part}</span>
                </Fragment>
              ))}
            </span>
            {questionMessageId ? (
              <button
                type="button"
                className="task-status"
                data-status="needs_you"
                aria-label={`Open the question for ${schedule.title}`}
                onClick={focusQuestion}
              >
                <MessageCircle size={12} aria-hidden="true" />
                Needs your input
              </button>
            ) : (
              activeStatus && (
                <span className="task-status" data-status={activeStatus}>
                  <StatusIcon status={activeStatus} />
                  {statusLabels[activeStatus]}
                </span>
              )
            )}
          </p>
        </div>
        <div className="schedule-row-model">
          <ScheduleModel schedule={schedule} />
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="schedule-row-run"
          disabled={
            starting ||
            Boolean(activeStatus && !questionMessageId) ||
            change.busy ||
            change.uncertain
          }
          aria-label={`${runLabel} for ${schedule.title}`}
          title={runLabel}
          aria-busy={starting}
          aria-live="polite"
          onClick={() => {
            if (questionMessageId) focusQuestion();
            else void runNow();
          }}
        >
          {starting ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : activeStatus ? (
            <StatusIcon status={activeStatus} />
          ) : (
            <Play size={16} aria-hidden="true" />
          )}
        </Button>
        <ChevronDown size={16} className="schedule-row-chevron" aria-hidden="true" />
      </div>
      {live && (
        <div className="schedule-live-line">
          <LiveLine item={live} quiet={false} />
        </div>
      )}
      {runError && <Notice>{runError}</Notice>}
      <div
        className="saved-plan-details schedule-row-details"
        id={detailsId}
        data-open={open}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="saved-plan-details-content">
          <div className="schedule-row-more">
            <p className="saved-plan-description">{schedule.prompt}</p>
            <ScheduleCost schedule={schedule} />
            {schedule.baselineObservation?.status === 'verified' && (
              <p className="saved-plan-note">
                Baseline: {schedule.baselineObservation.value} ·{' '}
                {date(schedule.baselineObservation.checkedAt)}
              </p>
            )}
            <div className="schedule-row-actions">
              {activeRun && (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={stopping || starting}
                  aria-label={`Stop this run for ${schedule.title}`}
                  aria-busy={stopping}
                  onClick={() => void stopRun()}
                >
                  {stopping ? (
                    <LoaderCircle size={16} className="spin" aria-hidden="true" />
                  ) : (
                    <Square size={16} aria-hidden="true" />
                  )}
                  {stopping ? 'Stopping…' : 'Stop this run'}
                </Button>
              )}
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
            </div>
            {showRuns && <ScheduleRuns schedule={schedule} resultTurnId={resultTurnId} />}
          </div>
        </div>
      </div>
    </article>
  );
}

function ScheduleRunLine({
  run,
  selected,
  detailId,
  onSelect,
}: {
  run: ScheduleRun;
  selected: boolean;
  detailId: string;
  onSelect(): void;
}) {
  const dateFormat = useDateFormat();
  return (
    <li>
      <button
        type="button"
        className="schedule-run-line"
        aria-current={selected || undefined}
        aria-controls={detailId}
        onClick={onSelect}
      >
        <time dateTime={run.scheduledFor}>
          {scheduleDate(run.scheduledFor, run.timeZone, dateFormat)}
        </time>
        <span className="task-status" data-status={run.status}>
          <StatusIcon status={run.status} />
          {statusLabels[run.status]}
        </span>
        <span className="schedule-run-preview">
          {run.error ?? run.messagePreview ?? run.observation?.summary ?? ''}
        </span>
        <span className="schedule-run-cost">
          {typeof run.costUsd === 'number' ? money(run.costUsd) : ''}
        </span>
      </button>
    </li>
  );
}

function ScheduleRunDetail({ run, id }: { run: ScheduleRun; id: string }) {
  const dateFormat = useDateFormat();
  const date = (value: string) => scheduleDate(value, run.timeZone, dateFormat);
  const text = run.messageText ?? run.messagePreview ?? '';
  const facts = [
    typeof run.costUsd === 'number'
      ? `${money(run.costUsd)}${['queued', 'running', 'waiting'].includes(run.status) ? ' so far' : ' recorded cost'}`
      : null,
    run.timeZone !== dateFormat.timeZone ? run.timeZone : null,
  ].filter(Boolean);
  return (
    <section
      className="schedule-run-detail"
      id={id}
      aria-label={`${run.title}, ${date(run.scheduledFor)}`}
    >
      <div className="schedule-run-detail-heading">
        <time dateTime={run.scheduledFor}>{date(run.scheduledFor)}</time>
        <span className="task-status" data-status={run.status}>
          <StatusIcon status={run.status} />
          {statusLabels[run.status]}
        </span>
      </div>
      {facts.length > 0 && <p className="saved-plan-note">{facts.join(' · ')}</p>}
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
      {text.trim() && (
        <div className="schedule-run-text">
          <MessageText text={text} />
        </div>
      )}
      {run.attachmentMessageId && (
        <Button
          variant="ghost"
          size="sm"
          className="schedule-run-files"
          onClick={() =>
            window.dispatchEvent(
              new CustomEvent('nod:focus-message', {
                detail: { messageId: run.attachmentMessageId },
              }),
            )
          }
        >
          Show files in chat
        </Button>
      )}
    </section>
  );
}

function ScheduleRuns({ schedule, resultTurnId }: { schedule: Schedule; resultTurnId?: string }) {
  const history = useScheduleHistory(schedule.id);
  const [selectedId, setSelectedId] = useState<string>();
  const detailId = useId();
  useEffect(() => {
    if (resultTurnId) setSelectedId(undefined);
  }, [resultTurnId]);
  const selected =
    history.runs.find((run) => run.id === selectedId) ??
    history.runs.find((run) => run.turnId === resultTurnId) ??
    history.runs[0];
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
      {selected && (
        <div className="schedule-runs-body">
          <div className="schedule-runs-index">
            <ol className="schedule-run-lines">
              {history.runs.map((run) => (
                <ScheduleRunLine
                  key={run.id}
                  run={run}
                  selected={run.id === selected.id}
                  detailId={detailId}
                  onSelect={() => setSelectedId(run.id)}
                />
              ))}
            </ol>
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
          </div>
          <ScheduleRunDetail run={selected} id={detailId} />
        </div>
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
