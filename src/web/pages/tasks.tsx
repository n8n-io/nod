import { useId, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Hourglass,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Schedule, ScheduleRun, Task, TaskStatus } from '../../shared/contracts';
import { PageTitle } from '../components/page-title';
import { NewPlan, PlanToast, ScheduleTask } from '../components/plan-controls';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { desktopSettingsAvailable } from '../lib/desktop';
import { ScheduleRow, ScheduleRunRow, useScheduleHistory } from './schedule';

const labels: Record<TaskStatus, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  scheduled: 'Checking back',
  stalled: 'Stalled',
  done: 'Done',
  cancelled: 'Stopped',
};
const icons = {
  working: LoaderCircle,
  needs_you: MessageCircle,
  waiting: Hourglass,
  scheduled: CalendarClock,
  stalled: CircleAlert,
  done: CircleCheck,
  cancelled: CircleSlash,
};
const order: TaskStatus[] = ['needs_you', 'working', 'stalled', 'waiting', 'scheduled'];
const views = ['current', 'scheduled', 'previous'] as const;
const viewLabels = { current: 'Current', scheduled: 'Scheduled', previous: 'Previous' };
const closed = (task: Task) => task.status === 'done' || task.status === 'cancelled';

function headline(task: Task) {
  if (closed(task)) return task.result || task.now;
  if (task.status === 'needs_you')
    return (
      task.question ??
      'Something stopped this before it finished. Check what happened, then tell Otto to continue.'
    );
  if (task.status === 'stalled') return 'Nothing is planned next. Tell Otto to keep going or stop.';
  return task.now;
}

export function TaskCard({ task, onScheduled }: { task: Task; onScheduled?(): void }) {
  const headingId = useId();
  const format = useDateFormat();
  const Icon = icons[task.status];
  const when = (value: string) => formatDateTime(value, format, { weekday: true });
  return (
    <article className="saved-plan task-card" aria-labelledby={headingId}>
      <div className="saved-plan-title">
        <h2 id={headingId}>{task.title}</h2>
        <span className="task-status" data-status={task.status}>
          <Icon
            size={16}
            aria-hidden="true"
            className={task.status === 'working' ? 'spin' : undefined}
          />
          {labels[task.status]}
        </span>
      </div>
      <p className="saved-plan-meta">
        <Clock size={16} aria-hidden="true" />
        <span>
          {task.closedAt
            ? `${task.status === 'cancelled' ? 'Stopped' : 'Finished'} ${formatDateTime(task.closedAt, format)}`
            : `Started ${formatDateTime(task.createdAt, format)}`}
        </span>
      </p>
      <p className="task-now">{headline(task)}</p>
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
      {task.status === 'done' && <ScheduleTask taskId={task.id} onCreated={onScheduled} />}
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
