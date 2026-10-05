import { useId, useState } from 'react';
import {
  CalendarClock,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Hourglass,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Task, TaskStatus } from '../../shared/contracts';
import { PageTitle } from '../components/page-title';
import { Button, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { formatDateTime, useDateFormat } from '../lib/date-format';

const labels: Record<TaskStatus, string> = {
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
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

export function TaskCard({ task }: { task: Task }) {
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
            size={13}
            aria-hidden="true"
            className={task.status === 'working' ? 'spin' : undefined}
          />
          {labels[task.status]}
        </span>
      </div>
      <p className="task-now">{headline(task)}</p>
      {!closed(task) && (
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
          <li>
            <span>Done when</span>
            {task.doneWhen}
          </li>
        </ul>
      )}
      <p className="saved-plan-footer">
        {task.closedAt
          ? `${task.status === 'cancelled' ? 'Stopped' : 'Finished'} ${formatDateTime(task.closedAt, format)}`
          : `Started ${formatDateTime(task.createdAt, format)}`}
      </p>
    </article>
  );
}

export function Tasks() {
  const { data: tasks, error, loading, refreshing, refresh } = usePageData<Task[]>('/api/tasks');
  const [view, setView] = useState<'open' | 'closed'>('open');
  const tabsId = useId();
  const open = (tasks ?? [])
    .filter((task) => !closed(task))
    .sort(
      (a, b) =>
        order.indexOf(a.status) - order.indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt),
    );
  const finished = (tasks ?? []).filter(closed);
  const shown = view === 'open' ? open : finished;
  return (
    <div className="content-page secondary-page tasks-page">
      <header className="page-heading secondary-heading">
        <div>
          <PageTitle path="/tasks" />
          <p>What Otto is working on, and how it’s going.</p>
        </div>
      </header>
      <div
        className="task-views"
        role="tablist"
        aria-label="Task views"
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next =
            event.key === 'Home'
              ? 'open'
              : event.key === 'End'
                ? 'closed'
                : view === 'open'
                  ? 'closed'
                  : 'open';
          setView(next);
          event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
        }}
      >
        {(['open', 'closed'] as const).map((item) => (
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
            {item === 'open' ? 'In progress' : 'Finished'}
            {tasks && <span>{item === 'open' ? open.length : finished.length}</span>}
          </button>
        ))}
      </div>
      {error && (
        <Notice>
          Could not load tasks.{' '}
          <Button
            variant="ghost"
            size="sm"
            aria-label="Retry loading tasks"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </Notice>
      )}
      <div
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${view}`}
        tabIndex={0}
      >
        {!tasks ? (
          loading ? (
            <div role="status">
              <Loading label="Loading tasks…" />
            </div>
          ) : null
        ) : shown.length ? (
          <div className="saved-plan-list">
            {shown.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        ) : view === 'open' ? (
          <div className="secondary-empty">
            <h2>Nothing in progress</h2>
            <p>
              When you hand Otto something that takes time, like getting quotes or chasing a refund,
              it shows up here with how it’s going.
            </p>
          </div>
        ) : (
          <div className="secondary-empty">
            <h2>No finished tasks yet</h2>
            <p>Tasks Otto finishes or stops will appear here.</p>
          </div>
        )}
      </div>
    </div>
  );
}
