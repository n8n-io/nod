import { useEffect, useId, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  CalendarClock,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Clock,
  Globe2,
  Hourglass,
  Link2,
  LoaderCircle,
  LockKeyhole,
  MessageCircle,
  MessageSquare,
} from '../components/icons';
import type {
  Activity,
  Schedule,
  Task,
  TaskDetail,
  WorkspaceCommand,
} from '../../shared/contracts';
import { taskHeadline, taskLabels, taskNext, taskNextLabels } from '../../shared/task-status';
import { taskPath } from '../../shared/app-links';
import { navigate } from '../lib/navigation';
import { InlineName } from '../components/inline-name';
import { WorkspaceCommandDialog, WorkspaceCommandLine } from '../components/workspace-command';
import { pageDataCache } from '../lib/page-data-cache';
import { api } from '../lib/api';
import { PageTitle } from '../components/page-title';
import { NewPlan, PlanToast, ScheduleTask } from '../components/plan-controls';
import { Button, Loading, Notice } from '../components/ui';
import { MessageText } from '../components/message';
import { usePageData } from '../hooks/use-page-data';
import { captureAnalytics } from '../lib/analytics';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { post, errorMessage } from '../lib/api';
import { ScheduleRow } from './schedule';
import { LiveLine } from '../components/live-line';

const icons = {
  queued: Clock,
  failed: CircleAlert,
  working: LoaderCircle,
  needs_you: MessageCircle,
  waiting: Hourglass,
  scheduled: CalendarClock,
  done: CircleCheck,
  cancelled: CircleSlash,
};
const closed = (task: Task) => task.status === 'done' || task.status === 'cancelled';
const showMessage = (messageId: string, taskId?: string) =>
  window.dispatchEvent(
    new window.CustomEvent('nod:focus-message', { detail: { messageId, taskId } }),
  );

function TaskActivity({ id }: { id: string }) {
  const data = usePageData<TaskDetail>(`/api/tasks/${id}`);
  if (data.error) return <Notice>Could not load activity.</Notice>;
  const rows: Array<TaskDetail['events'][number] & { count: number }> = [];
  for (const event of data.data?.events ?? []) {
    const last = rows.at(-1);
    if (
      last &&
      event.type !== 'message' &&
      event.type !== 'step' &&
      last.type === event.type &&
      last.summary === event.summary &&
      last.site === event.site &&
      last.parentRunId === event.parentRunId
    )
      last.count++;
    else rows.push({ ...event, count: 1 });
  }
  return (
    <ol className="task-activity" role="list">
      {rows.map((event) => (
        <li
          key={event.id}
          data-kind={event.type === 'message' || event.type === 'step' ? event.type : 'tool'}
          data-helper={Boolean(event.parentRunId)}
        >
          {event.type === 'message' || event.type === 'step' ? (
            <Markdown allowedElements={[]} unwrapDisallowed>
              {event.summary}
            </Markdown>
          ) : (
            <span>
              {event.type === 'tool_failed' && (
                <CircleAlert size={14} aria-label="Failed" className="task-activity-failed" />
              )}
              {event.parentRunId ? 'Helper · ' : ''}
              {event.summary}
              {event.site ? ` · ${event.site}` : ''}
              {event.count > 1 ? ` ×${event.count}` : ''}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function TaskCommands({ id }: { id: string }) {
  const data = usePageData<{ commands: WorkspaceCommand[] }>(`/api/tasks/${id}/commands`);
  const commands = data.data?.commands ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <section className="task-commands" aria-label="Workspace commands">
      <p className="task-commands-where">
        <LockKeyhole size={14} aria-hidden="true" />
        Nod runs these in its isolated workspace. You can view them here.
      </p>
      {data.error ? (
        <Notice>{data.error}</Notice>
      ) : !data.data ? (
        <Loading label="Loading commands…" />
      ) : !commands.length ? (
        <p className="task-preview-meta">No commands yet.</p>
      ) : (
        <ol role="list">
          {commands.map((command) => (
            <li
              key={command.id}
              className={
                command.state === 'failed' || (command.exitCode !== null && command.exitCode !== 0)
                  ? 'is-failed'
                  : undefined
              }
            >
              {command.helper && <small>Helper</small>}
              <WorkspaceCommandLine command={command} onOpen={() => setSelected(command.id)} />
            </li>
          ))}
        </ol>
      )}
      {selected && <WorkspaceCommandDialog id={selected} onClose={() => setSelected(null)} />}
    </section>
  );
}

export function TaskCard({
  task,
  live,
  page,
  onScheduled,
  onReply,
}: {
  task: Task;
  live?: Activity;
  page?: boolean;
  onScheduled?(): void;
  onReply?(): void;
}) {
  const headingId = useId();
  const stuck = task.status === 'failed';
  const [expanded, setExpanded] = useState(stuck || Boolean(page));
  useEffect(() => {
    if (stuck) setExpanded(true);
  }, [stuck]);
  const card = useRef<HTMLElement>(null);
  const inChat = Boolean(onReply);
  useEffect(() => {
    if (!inChat) return;
    const open = (event: Event) => {
      const element = card.current;
      if (
        (event as CustomEvent<{ taskId?: unknown }>).detail?.taskId !== task.id ||
        !element?.getClientRects().length
      )
        return;
      event.preventDefault();
      setExpanded(true);
      element.focus({ preventScroll: true });
      element.classList.remove('task-preview-pulse');
      void element.offsetWidth;
      element.classList.add('task-preview-pulse');
    };
    window.addEventListener('nod:open-task', open);
    return () => window.removeEventListener('nod:open-task', open);
  }, [inChat, task.id]);
  const [showActivity, setShowActivity] = useState(false);
  const [showCommands, setShowCommands] = useState(false);
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
  const handoffMessage = task.browserHandoff ? task.questionMessageId : null;
  const startMessage = task.questionMessageId ?? task.messageId;
  const line =
    !onReply && expanded && task.status === 'needs_you'
      ? task.now || 'Waiting for your answer'
      : taskHeadline(task);
  const showLive = live && (task.status === 'working' || task.status === 'queued') ? live : null;
  const next = taskNext(task);
  const facts = [
    ...(next ? [['Next for you', taskNextLabels[next]]] : []),
    ...(task.uncertainAction
      ? [
          [
            'May have run',
            `${task.uncertainAction.label} · ${formatDateTime(task.uncertainAction.at, format)}. Check it before asking again.`,
          ],
        ]
      : []),
    ...(task.lastAction
      ? [
          [
            'Last action',
            `${task.lastAction.label} · ${formatDateTime(task.lastAction.at, format)}`,
          ],
        ]
      : []),
    ...(closed(task)
      ? []
      : [
          ...task.waitingFor.map((wait) => ['Waiting on', `${wait.who} · ${wait.via}`]),
          ...(task.nextCheck ? [['Next check', when(task.nextCheck)]] : []),
          ...(task.doneWhen ? [['Done when', task.doneWhen]] : []),
        ]),
  ];
  return (
    <article
      ref={card}
      className="task-preview"
      data-status={task.status}
      data-task-id={task.id}
      onAnimationEnd={(event) => {
        if (event.animationName === 'task-preview-pulse')
          event.currentTarget.classList.remove('task-preview-pulse');
      }}
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
          onClick={() => {
            if (!expanded) captureAnalytics('task_action', { action: 'expand' });
            setExpanded(!expanded);
          }}
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
            {chevron}
          </span>
          <span className="task-preview-line">
            {showLive ? (
              <LiveLine item={showLive} />
            ) : (
              <Markdown allowedElements={[]} unwrapDisallowed>
                {line}
              </Markdown>
            )}
          </span>
        </button>
      </h2>
      <div
        className="task-preview-disclosure"
        id={`${headingId}-body`}
        data-open={expanded}
        aria-hidden={!expanded}
        inert={!expanded}
      >
        <div className="task-preview-clip">
          <div className="task-preview-body">
            <InlineName
              value={task.title}
              label="task title"
              save={async (title) => {
                await api(`/api/tasks/${task.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({ title }),
                });
                await pageDataCache.refresh('/api/tasks', true);
              }}
            />
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
            {facts.length > 0 && (
              <ul className="task-facts">
                {facts.map(([label, value], index) => (
                  <li key={`${label}:${index}`}>
                    <span>{label}</span>
                    {value}
                  </li>
                ))}
              </ul>
            )}
            {(task.revision ?? 0) > (task.appliedRevision ?? 0) && !closed(task) && (
              <p className="task-preview-meta">Owner update queued</p>
            )}
            <div className="task-preview-actions">
              {handoffMessage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    captureAnalytics('task_action', { action: 'open_browser' });
                    showMessage(handoffMessage);
                  }}
                >
                  <Globe2 size={16} aria-hidden="true" />
                  Open browser
                </Button>
              ) : onReply ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    captureAnalytics('task_action', { action: 'reply' });
                    onReply();
                  }}
                >
                  Reply
                </Button>
              ) : (
                startMessage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      captureAnalytics('task_action', { action: 'show_in_chat' });
                      showMessage(startMessage, task.id);
                    }}
                  >
                    <MessageSquare size={16} aria-hidden="true" />
                    Show in chat
                  </Button>
                )
              )}
              {!page && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    captureAnalytics('task_action', { action: 'open_page' });
                    navigate(taskPath(task.id));
                  }}
                >
                  <Link2 size={16} aria-hidden="true" />
                  Task page
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showActivity}
                onClick={() => {
                  if (!showActivity) captureAnalytics('task_action', { action: 'show_activity' });
                  setShowActivity(!showActivity);
                }}
              >
                {showActivity ? 'Hide activity' : 'Show activity'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={showCommands}
                onClick={() => {
                  if (!showCommands) captureAnalytics('task_action', { action: 'show_commands' });
                  setShowCommands(!showCommands);
                }}
              >
                {showCommands ? 'Hide commands' : 'Show commands'}
              </Button>
              {!closed(task) && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={stopping}
                  onClick={async () => {
                    captureAnalytics('task_action', { action: 'stop' });
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
                  {stopping ? 'Stopping…' : 'Stop this task'}
                </Button>
              )}
            </div>
            {error && <Notice>{error}</Notice>}
            {showActivity && <TaskActivity id={task.id} />}
            {showCommands && <TaskCommands id={task.id} />}
            {task.status === 'done' && <ScheduleTask taskId={task.id} onCreated={onScheduled} />}
          </div>
        </div>
      </div>
    </article>
  );
}

export function TaskPage({ id, activity = [] }: { id: string; activity?: Activity[] }) {
  const { data, error, refreshing, refresh } = usePageData<TaskDetail>(`/api/tasks/${id}`);
  const tasks = usePageData<Task[]>('/api/tasks');
  const task = tasks.data?.find((item) => item.id === id) ?? data?.task;
  return (
    <div className="content-page secondary-page tasks-page" data-analytics-private>
      <h1 className="sr-only">Task</h1>
      <Button variant="ghost" onClick={() => navigate('/tasks')}>
        Back to Scheduled
      </Button>
      {error && !task ? (
        <LoadError what="this task" refreshing={refreshing} retry={refresh} />
      ) : !task ? (
        <Pending label="Loading task…" />
      ) : (
        <div className="saved-plan-list open-task-list">
          <TaskCard task={task} page live={activity.find((item) => item.taskId === id)} />
        </div>
      )}
      <PlanToast />
    </div>
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

export function Scheduled({
  onAsk,
  activity = [],
}: {
  onAsk(text: string): void;
  activity?: Activity[];
}) {
  const schedules = usePageData<Schedule[]>('/api/schedules');
  const tasks = usePageData<Task[]>('/api/tasks');
  const open = (tasks.data ?? []).filter((task) => !closed(task));
  const upcoming = (schedules.data ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRun)
    .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!) || a.id.localeCompare(b.id));
  const inactive = (schedules.data ?? []).filter((schedule) => !upcoming.includes(schedule));
  const empty = Boolean(schedules.data && !schedules.data.length);
  return (
    <div className="content-page secondary-page tasks-page">
      <PlanToast />
      <header className="page-heading secondary-heading">
        <PageTitle path="/tasks" />
        <div className="secondary-heading-actions">
          <Button variant="ghost" size="sm" onClick={() => onAsk('Show my rules')}>
            Rules
          </Button>
          {!empty && <NewPlan onAsk={onAsk} />}
        </div>
      </header>
      {schedules.error && (
        <LoadError what="schedules" refreshing={schedules.refreshing} retry={schedules.refresh} />
      )}
      {tasks.error && (
        <LoadError what="tasks" refreshing={tasks.refreshing} retry={tasks.refresh} />
      )}
      {open.length > 0 && (
        <div className="saved-plan-list open-task-list">
          {open.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              live={activity.find((item) => item.taskId === task.id)}
            />
          ))}
        </div>
      )}
      {!schedules.data ? (
        schedules.loading && <Pending label="Loading schedules…" />
      ) : (
        <>
          {upcoming.length ? (
            <div className="saved-plan-list">
              {upcoming.map((schedule) => (
                <ScheduleRow key={schedule.id} schedule={schedule} onAsk={onAsk} />
              ))}
            </div>
          ) : empty ? (
            <section className="schedule-empty" aria-labelledby="schedule-empty-title">
              <span className="schedule-empty-icon" aria-hidden="true">
                <CalendarClock size={32} />
              </span>
              <h2 id="schedule-empty-title">Your first schedule</h2>
              <p>
                Set up a reminder, a regular summary or a check-in. Nod will help you work out what
                to do and when.
              </p>
              <NewPlan onAsk={onAsk} />
              <span className="schedule-empty-note">Start with a conversation.</span>
            </section>
          ) : (
            <p className="muted">No upcoming schedules.</p>
          )}
          {inactive.length > 0 && (
            <details className="schedule-inactive" open={!upcoming.length}>
              <summary>
                Inactive <span>{inactive.length}</span>
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
      )}
    </div>
  );
}
