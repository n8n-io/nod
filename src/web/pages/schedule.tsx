import { useEffect, useRef, useState } from 'react';
import { CalendarClock, Sparkles } from '../components/icons';
import type { Schedule, ScheduleHistory, ScheduleRun } from '../../shared/contracts';
import { StatusIcon, statusLabels } from '../components/turn-status';
import { usePageData } from '../hooks/use-page-data';
import { api } from '../lib/api';
import { scheduleDate, scheduleLabel } from '../lib/schedules';
import { useDateFormat } from '../lib/date-format';
import { DeletePlan } from '../components/delete-plan';
import { MessageText } from '../components/message';
import {
  AskNod,
  PauseSwitch,
  PlanDetails,
  ScheduleTiming,
  useDirectChange,
} from '../components/plan-controls';
import { Button } from '../components/ui';
import { money } from '../lib/money';

const historyPath = '/api/schedule-runs?limit=20';

export function ScheduleRow({
  schedule,
  onAsk,
}: {
  schedule: Schedule;
  onAsk(text: string): void;
}) {
  const dateFormat = useDateFormat();
  const change = useDirectChange(schedule.id);
  const [asking, setAsking] = useState(false);
  const date = (value: string) => scheduleDate(value, schedule.timeZone, dateFormat);
  const canPause =
    schedule.enabled ||
    schedule.kind !== 'once' ||
    Boolean(schedule.runAt && Date.parse(schedule.runAt) > Date.now());
  return (
    <article className="saved-plan">
      <div className="saved-plan-title">
        <h2>{schedule.title}</h2>
        <span className="saved-plan-status">
          {!schedule.enabled ? 'Paused' : schedule.kind === 'once' ? 'One time' : 'Recurring'}
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
      <PlanDetails
        label={schedule.title}
        summary={schedule.prompt}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={asking}
              aria-label={`Ask nod about ${schedule.title}`}
              onClick={() => setAsking(!asking)}
            >
              <Sparkles size={16} aria-hidden="true" />
              Ask nod
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
        <ScheduleTiming
          key={`${schedule.kind}:${schedule.cron}:${schedule.runAt}:${schedule.timeZone}`}
          schedule={schedule}
          change={change}
        />
      </PlanDetails>
      {asking && (
        <AskNod
          subject={{ title: schedule.title }}
          onAsk={onAsk}
          onClose={() => setAsking(false)}
        />
      )}
    </article>
  );
}

export function ScheduleRunRow({ run }: { run: ScheduleRun }) {
  const dateFormat = useDateFormat();
  const date = (value: string) => scheduleDate(value, run.timeZone, dateFormat);
  return (
    <article className="saved-plan schedule-run">
      <div className="saved-plan-title">
        <h2>{run.title}</h2>
        <span className="task-status" data-status={run.status}>
          <StatusIcon status={run.status} />
          {statusLabels[run.status]}
        </span>
      </div>
      <p className="saved-plan-meta">
        <CalendarClock size={16} aria-hidden="true" />
        <time dateTime={run.scheduledFor}>{date(run.scheduledFor)}</time>
        {run.timeZone !== dateFormat.timeZone && <span>{run.timeZone}</span>}
      </p>
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
      {run.messageId ? (
        <PlanDetails label={run.title} summary={run.messagePreview}>
          <MessageText text={run.messageText ?? run.messagePreview ?? ''} />
        </PlanDetails>
      ) : (
        !run.observation && <p className="saved-plan-note">No message</p>
      )}
    </article>
  );
}

export function useScheduleHistory() {
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
