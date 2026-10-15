import { useId, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Hourglass,
  LoaderCircle,
  MessageCircle,
  MessageSquare,
} from 'lucide-react';
import type { Schedule, ScheduleRun, Task, TaskDetail, TaskStatus } from '../../shared/contracts';
import { taskHeadline, taskLabels } from '../../shared/task-status';
import { PageTitle } from '../components/page-title';
import { NewPlan, PlanToast, ScheduleTask } from '../components/plan-controls';
import { Button, Loading, Notice } from '../components/ui';
import { MessageText } from '../components/message';
import { usePageData } from '../hooks/use-page-data';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { desktopSettingsAvailable } from '../lib/desktop';
import { post, errorMessage } from '../lib/api';
import { ScheduleRow, ScheduleRunRow, useScheduleHistory } from './schedule';

const icons = {
  queued: Clock,
  failed: CircleAlert,
  working: LoaderCircle,
  needs_you: MessageCircle,
  waiting: Hourglass,
  scheduled: CalendarClock,
  stalled: CircleAlert,
  done: CircleCheck,
  cancelled: CircleSlash,
};
const order: TaskStatus[] = [
  'needs_you',
  'failed',
  'working',
  'queued',
  'stalled',
  'waiting',
  'scheduled',
];
const views = ['current', 'scheduled', 'previous'] as const;
const viewLabels = { current: 'Current', scheduled: 'Scheduled', previous: 'Previous' };
const closed = (task: Task) => task.status === 'done' || task.status === 'cancelled';

function TaskActivity({ id }: { id: string }) {
  const data = usePageData<TaskDetail>(`/api/tasks/${id}`);
  if (data.error) return <Notice>Could not load activity.</Notice>;
  return (
    <ol className="task-activity">
      {data.data?.events.map((event) => (
        <li key={event.id} data-helper={Boolean(event.parentRunId)}>
          <span>
            {event.parentRunId ? 'Helper · ' : ''}
            {event.summary}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function TaskCard({
  task,
  onScheduled,
  onReply,
}: {
  task: Task;
  onScheduled?(): void;
  onReply?(): void;
}) {
  const headingId = useId();
  const [expanded, setExpanded] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const format = useDateFormat();
  const Icon = icons[task.status];
  const when = (value: string) => formatDateTime(value, format, { weekday: true });
  const steps = task.steps ?? [];
  const completed =
    task.status === 'done' ? steps.length : Math.min(task.stepIndex ?? 0, steps.length);
  const state = (index: number) =>
    task.status === 'done' || index < completed
      ? 'done'
      : !closed(task) && index === (task.stepIndex ?? 0)
        ? 'current'
        : 'todo';
  const chevron = <ChevronDown size={16} aria-hidden="true" className="task-preview-chevron" />;
  const line =
    !onReply && expanded && task.status === 'needs_you'
      ? task.now || 'Waiting for your answer'
      : taskHeadline(task);
  return (
    <article
      className="task-preview"
      data-status={task.status}
      aria-labelledby={headingId}
      tabIndex={-1}
      data-message-id={onReply ? task.messageId : undefined}
    >
      <h2 className="task-preview-heading">
        <button
          type="button"
          className="task-preview-head"
          aria-expanded={expanded}
          aria-controls={`${headingId}-body`}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="task-preview-top">
            <span className="task-preview-title" id={headingId}>
              {task.title}
            </span>
            <span className="task-status" data-status={task.status}>
              <Icon
                size={16}
                aria-hidden="true"
                className={task.status === 'working' ? 'spin' : undefined}
              />
              {taskLabels[task.status]}
            </span>
            {!steps.length && chevron}
          </span>
          <span className="task-preview-line">{line}</span>
          {steps.length > 0 && (
            <span className="task-preview-foot">
              <span className="task-steps-bar" aria-hidden="true">
                {steps.map((_, index) => (
                  <i key={index} data-state={state(index)} />
                ))}
              </span>
              <span className="task-preview-count">
                {completed} of {steps.length} steps {chevron}
              </span>
            </span>
          )}
        </button>
      </h2>
      <div className="task-preview-body" id={`${headingId}-body`} hidden={!expanded}>
        {!onReply && task.status === 'needs_you' && task.question && (
          <div className="task-preview-question">
            <MessageText text={task.question} />
          </div>
        )}
        {closed(task) && task.result && (
          <div className="task-preview-result">
            <MessageText text={task.result} />
          </div>
        )}
        {steps.length > 0 && (
          <ol className="task-preview-steps">
            {steps.map((step, index) => {
              const progress = state(index);
              const StepIcon =
                progress === 'done' ? CircleCheck : progress === 'current' ? Icon : Circle;
              return (
                <li
                  key={index}
                  data-state={progress}
                  aria-current={progress === 'current' ? 'step' : undefined}
                >
                  <StepIcon
                    size={16}
                    aria-hidden="true"
                    className={
                      progress === 'current' && task.status === 'working' ? 'spin' : undefined
                    }
                  />
                  <span>{step}</span>
                </li>
              );
            })}
          </ol>
        )}
        <p className="task-preview-meta">
          <Clock size={16} aria-hidden="true" />
          <span>
            {task.closedAt
              ? `${task.status === 'cancelled' ? 'Stopped' : 'Finished'} ${formatDateTime(task.closedAt, format)}`
              : `Started ${formatDateTime(task.createdAt, format)}`}
          </span>
        </p>
        {!closed(task) && (task.waitingFor.length > 0 || task.nextCheck || task.doneWhen) && (
          <ul className="task-facts">
            {task.waitingFor.map((wait) => (
              <li key={`${wait.who}:${wait.via}`}>
                <span>Waiting on</span>
                {wait.who} · {wait.via}
              </li>
            ))}
            {task.nextCheck && (
              <li>
                <span>Next check</span>
                {when(task.nextCheck)}
              </li>
            )}
            {task.doneWhen && (
              <li>
                <span>Done when</span>
                {task.doneWhen}
              </li>
            )}
          </ul>
        )}
        {(task.revision ?? 0) > (task.appliedRevision ?? 0) && !closed(task) && (
          <p className="task-preview-meta">Owner update queued</p>
        )}
        <div className="task-preview-actions">
          {onReply && (
            <Button variant="ghost" size="sm" onClick={onReply}>
              Reply
            </Button>
          )}
          {!onReply && task.messageId && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                window.dispatchEvent(
                  new window.CustomEvent('otto:focus-message', {
                    detail: { messageId: task.messageId },
                  }),
                )
              }
            >
              <MessageSquare size={16} aria-hidden="true" />
              Show in chat
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showActivity}
            onClick={() => setShowActivity(!showActivity)}
          >
            {showActivity ? 'Hide activity' : 'Show activity'}
          </Button>
          {!closed(task) && (
            <Button
              variant="ghost"
              size="sm"
              disabled={stopping}
              onClick={async () => {
                setStopping(true);
                setError('');
                try {
                  await post(`/api/tasks/${task.id}/stop`);
                } catch (cause) {
                  setError(errorMessage(cause));
                } finally {
                  setStopping(false);
                }
              }}
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </Button>
          )}
        </div>
        {error && <Notice>{error}</Notice>}
        {expanded && showActivity && <TaskActivity id={task.id} />}
        {task.status === 'done' && <ScheduleTask taskId={task.id} onCreated={onScheduled} />}
      </div>
    </article>
  );
}

function LoadError({
  what,
  refreshing,
  retry,
}: {
  what: string;
  refreshing: boolean;
  retry(): Promise<unknown>;
}) {
  return (
    <Notice>
      Could not load {what}.{' '}
      <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void retry()}>
        {refreshing ? 'Retrying…' : 'Try again'}
      </Button>
    </Notice>
  );
}

function Pending({ label }: { label: string }) {
  return (
    <div role="status">
      <Loading label={label} />
    </div>
  );
}

function Empty({ title, children }: { title: string; children: string }) {
  return (
    <div className="secondary-empty">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function Tasks({ onAsk }: { onAsk(text: string): void }) {
  const tasks = usePageData<Task[]>('/api/tasks');
  const schedules = usePageData<Schedule[]>('/api/schedules');
  const history = useScheduleHistory();
  const [view, setView] = useState<(typeof views)[number]>('current');
  const tabsId = useId();
  const open = (tasks.data ?? [])
    .filter((task) => !closed(task))
    .sort(
      (a, b) =>
        order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const upcoming = (schedules.data ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRun)
    .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!) || a.id.localeCompare(b.id));
  const inactive = (schedules.data ?? []).filter(
    (schedule) =>
      !upcoming.includes(schedule) &&
      (schedule.kind !== 'once' || schedule.lastRun?.scheduledFor !== schedule.runAt),
  );
  const oldestRun = history.cursor ? history.runs.at(-1)?.createdAt : undefined;
  const previous: Array<{ at: string; task: Task } | { at: string; run: ScheduleRun }> = [
    ...(tasks.data ?? [])
      .filter((task) => closed(task) && (!oldestRun || task.closedAt! >= oldestRun))
      .map((task) => ({ at: task.closedAt!, task })),
    ...history.runs
      .filter((run) => run.status !== 'queued' && run.status !== 'running')
      .map((run) => ({ at: run.createdAt, run })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const counts = {
    current: tasks.data ? open.length : null,
    scheduled: schedules.data ? upcoming.length : null,
    previous: null,
  };
  return (
    <div className="content-page secondary-page tasks-page">
      <PlanToast />
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/tasks" />
          <p>What Otto is working on, what’s scheduled and what’s done.</p>
        </div>
        {view === 'scheduled' && (
          <div className="secondary-heading-actions">
            <NewPlan onAsk={onAsk} />
          </div>
        )}
      </header>
      <div
        className="secondary-tabs"
        role="tablist"
        aria-label="Task views"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const index = views.indexOf(view);
          const step = event.key === 'ArrowLeft' ? views.length - 1 : 1;
          const next =
            views[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? views.length - 1
                  : (index + step) % views.length
            ];
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
        }}
      >
        {views.map((item) => (
          <button
            key={item}
            id={`${tabsId}-tab-${item}`}
            data-view={item}
            role="tab"
            tabIndex={view === item ? 0 : -1}
            aria-selected={view === item}
            aria-controls={`${tabsId}-panel`}
            onClick={() => setView(item)}
          >
            {viewLabels[item]}
            {counts[item] !== null && <span>{counts[item]}</span>}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${view}`}
        tabIndex={0}
      >
        {view !== 'scheduled' && tasks.error && (
          <LoadError what="tasks" refreshing={tasks.refreshing} retry={tasks.refresh} />
        )}
        {view === 'scheduled' && schedules.error && (
          <LoadError what="schedules" refreshing={schedules.refreshing} retry={schedules.refresh} />
        )}
        {view === 'previous' && history.error && (
          <LoadError
            what="scheduled runs"
            refreshing={history.refreshing}
            retry={history.refresh}
          />
        )}
        {view === 'current' ? (
          !tasks.data ? (
            tasks.loading && <Pending label="Loading tasks…" />
          ) : open.length ? (
            <div className="saved-plan-list">
              {open.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          ) : (
            <Empty title="Nothing in progress">
              When you hand Otto something that takes time, like getting quotes or chasing a refund,
              it shows up here with how it’s going.
            </Empty>
          )
        ) : view === 'scheduled' ? (
          !schedules.data ? (
            schedules.loading && <Pending label="Loading schedules…" />
          ) : (
            <>
              {upcoming.length ? (
                <div className="saved-plan-list">
                  {upcoming.map((schedule) => (
                    <ScheduleRow key={schedule.id} schedule={schedule} onAsk={onAsk} />
                  ))}
                </div>
              ) : (
                <Empty title="Nothing scheduled">
                  Schedule a one-time task or something that repeats.
                </Empty>
              )}
              {desktopSettingsAvailable() && (
                <p className="saved-plan-note schedule-availability">
                  Scheduled tasks run only while your Mac is on and Otto is open.
                </p>
              )}
              {inactive.length > 0 && (
                <details className="schedule-inactive" open={!upcoming.length}>
                  <summary>
                    Not scheduled <span>{inactive.length}</span>
                    <ChevronDown size={16} aria-hidden="true" />
                  </summary>
                  <div className="saved-plan-list">
                    {inactive.map((schedule) => (
                      <ScheduleRow key={schedule.id} schedule={schedule} onAsk={onAsk} />
                    ))}
                  </div>
                </details>
              )}
            </>
          )
        ) : (tasks.loading && !tasks.error) || (history.loading && !history.error) ? (
          <Pending label="Loading previous tasks…" />
        ) : previous.length ? (
          <>
            <div className="saved-plan-list">
              {previous.map((item) =>
                'task' in item ? (
                  <TaskCard
                    key={`task:${item.task.id}`}
                    task={item.task}
                    onScheduled={() => setView('scheduled')}
                  />
                ) : (
                  <ScheduleRunRow key={`run:${item.run.id}`} run={item.run} />
                ),
              )}
            </div>
            {history.earlierError && <Notice>{history.earlierError}</Notice>}
            {history.cursor && (
              <Button
                variant="ghost"
                className="schedule-history-more"
                size="sm"
                disabled={history.loadingEarlier}
                onClick={() => void history.loadEarlier()}
              >
                {history.loadingEarlier ? 'Loading…' : 'Load earlier'}
              </Button>
            )}
          </>
        ) : (
          (tasks.data || history.data) && (
            <Empty title="Nothing finished yet">
              Tasks Otto finishes or stops, and past scheduled runs, appear here.
            </Empty>
          )
        )}
      </div>
    </div>
  );
}
