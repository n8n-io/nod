import { useEffect, useId, useRef, useState } from 'react';
import {
  CalendarClock,
  CalendarPlus,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Download,
  FileImage,
  FileText,
  Hourglass,
  ListChecks,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Square,
  X,
} from 'lucide-react';
import type { Artifact, Task, TaskStatus } from '../../shared/contracts';
import {
  completedSteps,
  isOpenTask,
  openTaskOrder,
  taskLabels,
  taskSummary,
} from '../../shared/tasks';
import { errorMessage, post } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';
import { Button, Notice } from './ui';
import { MessageText } from './message';
import { TaskScheduleForm } from './plan-controls';
import {
  artifactPreview,
  attachmentKind,
  ownedArtifactUrl,
  PreviewContent,
} from './attachment-images';
import { fileSize, fileType } from './attachment-card';

const icons = {
  queued: Hourglass,
  working: LoaderCircle,
  needs_you: MessageCircle,
  waiting: CalendarClock,
  done: CircleCheck,
  stopped: CircleSlash,
  failed: CircleAlert,
};
function StatusIcon({ status, size = 16 }: { status: TaskStatus; size?: number }) {
  const Icon = icons[status];
  return (
    <Icon size={size} aria-hidden="true" className={status === 'working' ? 'spin' : undefined} />
  );
}

export function TaskStatusPill({ status }: { status: TaskStatus }) {
  return (
    <span className="task-status" data-status={status}>
      <StatusIcon status={status} />
      {taskLabels[status]}
    </span>
  );
}

function stepState(task: Task, index: number) {
  if (task.status === 'done' || index < task.stepIndex) return 'done';
  return index === task.stepIndex && task.status !== 'stopped' ? 'current' : 'todo';
}

function showTasksPage(event: React.MouseEvent) {
  if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate('/tasks');
}

function focusTask(task: Task) {
  window.dispatchEvent(
    new window.CustomEvent('otto:focus-message', {
      detail: { messageId: task.onItMessageId, taskId: task.id },
    }),
  );
}

export function TaskQuote({ task }: { task: Task }) {
  return (
    <button
      type="button"
      className="message-reply-quote message-task-quote"
      aria-label={`Show task: ${task.title}`}
      onClick={() => focusTask(task)}
    >
      <strong>
        <ListChecks size={14} aria-hidden="true" />
        {task.title}
      </strong>
    </button>
  );
}

function useStop() {
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function stop(id = '') {
    setStopping(id);
    setError('');
    try {
      await post(id ? `/api/tasks/${encodeURIComponent(id)}/stop` : '/api/thread/stop');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStopping(null);
    }
  }
  return { stopping, error, stop };
}

export function TaskAnswer({ approvalId }: { approvalId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function answer(approved: boolean) {
    setBusy(true);
    setError('');
    try {
      await post(`/api/approvals/${encodeURIComponent(approvalId)}/answer`, { approved });
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <div className="task-answer">
      <Button size="sm" disabled={busy} onClick={() => void answer(true)}>
        Yes
      </Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void answer(false)}>
        No
      </Button>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

export function ArtifactCard({ artifact }: { artifact: Artifact }) {
  const preview = artifactPreview(artifact);
  if (!ownedArtifactUrl(artifact.url)) return null;
  const Icon = attachmentKind(artifact.mimeType, artifact.name) === 'image' ? FileImage : FileText;
  const content = (
    <>
      <span className="artifact-card-icon" aria-hidden="true">
        <Icon size={16} />
      </span>
      <span className="artifact-card-text">
        <span className="artifact-card-name">{artifact.name}</span>
        <span className="artifact-card-meta">
          {fileType(artifact.name)} · {fileSize(artifact.size)}
        </span>
      </span>
      {preview ? (
        <Maximize2 size={16} aria-hidden="true" />
      ) : (
        <Download size={16} aria-hidden="true" />
      )}
    </>
  );
  return preview ? (
    <button
      type="button"
      className="artifact-card"
      aria-label={`Open ${artifact.name}`}
      onClick={() =>
        window.dispatchEvent(new window.CustomEvent('otto:open-artifact', { detail: artifact }))
      }
    >
      {content}
    </button>
  ) : (
    <a className="artifact-card" href={artifact.url} download={artifact.name}>
      {content}
    </a>
  );
}

export function ArtifactPanel({ artifact, onClose }: { artifact: Artifact; onClose(): void }) {
  const panel = useRef<HTMLElement>(null);
  const preview = artifactPreview(artifact);
  useEffect(() => {
    const trigger = document.activeElement;
    panel.current?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected)
        trigger.focus({ preventScroll: true });
    };
  }, []);
  return (
    <aside
      className="artifact-panel"
      ref={panel}
      tabIndex={-1}
      aria-label={artifact.name}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="artifact-panel-header">
        <div className="artifact-panel-title">
          <span>Document</span>
          <h2>{artifact.name}</h2>
        </div>
        <Button variant="ghost" size="icon" asChild>
          <a href={artifact.url} download={artifact.name} aria-label={`Download ${artifact.name}`}>
            <Download size={16} />
          </a>
        </Button>
        <Button variant="ghost" size="icon" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </Button>
      </header>
      <div className="artifact-panel-body">
        {preview && <PreviewContent key={`${artifact.id}:${artifact.url}`} image={preview} />}
      </div>
    </aside>
  );
}

export function TaskPreview({
  task,
  place,
  threadId,
  open: shown,
  onToggle,
  onScheduled,
}: {
  task: Task;
  place: 'chat' | 'page';
  threadId?: string;
  open?: boolean;
  onToggle?(): void;
  onScheduled?(): void;
}) {
  const format = useDateFormat();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const { stopping, error, stop } = useStop();
  const open = shown ?? expanded;
  const done = completedSteps(task);
  const showInChat = place === 'page' && task.onItMessageId !== null && task.threadId === threadId;
  const schedule = place === 'page' && task.status === 'done' && task.onItMessageId !== null;
  const line =
    place === 'page' && open && task.status === 'needs_you'
      ? task.now || 'Waiting for your answer'
      : taskSummary(task);
  const chevron = <ChevronDown size={16} aria-hidden="true" className="task-preview-chevron" />;
  return (
    <div className="task-preview" data-status={task.status}>
      <button
        type="button"
        className="task-preview-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle ?? (() => setExpanded(!expanded))}
      >
        <span className="task-preview-top">
          <span className="task-preview-title">{task.title}</span>
          <TaskStatusPill status={task.status} />
          {task.steps.length === 0 && chevron}
        </span>
        {line && <span className="task-preview-line">{line}</span>}
        {task.steps.length > 0 && (
          <span className="task-preview-foot">
            <span className="task-steps-bar" aria-hidden="true">
              {task.steps.map((step, index) => (
                <i key={`${index}:${step}`} data-state={stepState(task, index)} />
              ))}
            </span>
            <span className="task-preview-count">
              {done} of {task.steps.length} steps
              {chevron}
            </span>
          </span>
        )}
      </button>
      <div className="task-preview-body" id={bodyId} hidden={!open}>
        {open && (
          <>
            {place === 'page' && task.status === 'needs_you' && task.question && (
              <div className="task-preview-question">
                <MessageText text={task.question} />
                {task.approvalId && (
                  <TaskAnswer key={task.approvalId} approvalId={task.approvalId} />
                )}
              </div>
            )}
            {task.status === 'done' && task.result && (
              <div className="task-preview-result">
                <MessageText text={task.result} />
              </div>
            )}
            {task.status === 'done' && task.artifact && <ArtifactCard artifact={task.artifact} />}
            {task.steps.length > 0 && (
              <ol className="task-preview-steps">
                {task.steps.map((step, index) => {
                  const state = stepState(task, index);
                  return (
                    <li key={`${index}:${step}`} data-state={state}>
                      {state === 'done' ? (
                        <CircleCheck size={16} aria-hidden="true" />
                      ) : state === 'current' ? (
                        <StatusIcon status={task.status} />
                      ) : (
                        <Circle size={16} aria-hidden="true" />
                      )}
                      <span>{step}</span>
                    </li>
                  );
                })}
              </ol>
            )}
            {task.status === 'waiting' && (
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
                    {formatDateTime(task.nextCheck, format, { weekday: true })}
                  </li>
                )}
              </ul>
            )}
            {place === 'page' && (
              <p className="task-preview-meta">
                {task.closedAt
                  ? `${task.status === 'done' ? 'Finished' : taskLabels[task.status]} ${formatDateTime(task.closedAt, format)}`
                  : `Started ${formatDateTime(task.createdAt, format)}`}
              </p>
            )}
            {(showInChat || schedule || isOpenTask(task)) && (
              <div className="task-preview-actions">
                {showInChat && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      window.dispatchEvent(
                        new window.CustomEvent('otto:focus-message', {
                          detail: { messageId: task.onItMessageId },
                        }),
                      )
                    }
                  >
                    <MessageSquare size={16} aria-hidden="true" />
                    Show in chat
                  </Button>
                )}
                {schedule && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={scheduling}
                    onClick={() => setScheduling(!scheduling)}
                  >
                    <CalendarPlus size={16} aria-hidden="true" />
                    Schedule task
                  </Button>
                )}
                {isOpenTask(task) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={stopping !== null}
                    onClick={() => void stop(task.id)}
                  >
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                    Stop task
                  </Button>
                )}
              </div>
            )}
            {schedule && scheduling && (
              <TaskScheduleForm
                key={task.id}
                taskId={task.id}
                onClose={() => setScheduling(false)}
                onCreated={() => {
                  setScheduling(false);
                  onScheduled?.();
                }}
              />
            )}
            {error && <Notice>{error}</Notice>}
          </>
        )}
      </div>
    </div>
  );
}

export function StopAllTasks() {
  const { stopping, error, stop } = useStop();
  return (
    <>
      <Button variant="ghost" size="sm" disabled={stopping !== null} onClick={() => void stop()}>
        <Square size={14} fill="currentColor" aria-hidden="true" />
        Stop all
      </Button>
      {error && <Notice>{error}</Notice>}
    </>
  );
}

export function TasksStrip({ tasks }: { tasks: Task[] }) {
  const { stopping, error, stop } = useStop();
  const open = tasks
    .filter((task) => isOpenTask(task) && task.onItMessageId)
    .sort((a, b) => openTaskOrder.indexOf(a.status) - openTaskOrder.indexOf(b.status));
  const asking = open.filter((task) => task.status === 'needs_you').length;
  if (open.length < 2 && !asking) return null;
  const more = open.length - 3;
  return (
    <div className="tasks-strip" role="group" aria-label="Open tasks">
      <div className="tasks-strip-items">
        {open.slice(0, 3).map((task) => (
          <span key={task.id} className="task-status tasks-strip-item" data-status={task.status}>
            <button
              type="button"
              className="tasks-strip-open"
              aria-label={`${task.title}, ${taskLabels[task.status]}`}
              title={task.title}
              onClick={() => focusTask(task)}
            >
              <StatusIcon status={task.status} size={14} />
              <span className="tasks-strip-title">{task.title}</span>
            </button>
            <button
              type="button"
              className="tasks-strip-stop"
              aria-label={`Stop ${task.title}`}
              disabled={stopping === task.id}
              onClick={() => void stop(task.id)}
            >
              <Square size={10} fill="currentColor" aria-hidden="true" />
            </button>
          </span>
        ))}
        {more > 0 && (
          <a
            className="task-status tasks-strip-more"
            href="/tasks"
            aria-label={`${more} more ${more === 1 ? 'task' : 'tasks'}`}
            onClick={showTasksPage}
          >
            +{more}
          </a>
        )}
      </div>
      <a
        className="task-status tasks-strip-summary"
        data-status={open[0].status}
        href="/tasks"
        onClick={showTasksPage}
      >
        <ListChecks size={14} aria-hidden="true" />
        {open.length === 1
          ? '1 task needs you'
          : `${open.length} tasks${asking ? ` · ${asking} ${asking === 1 ? 'needs' : 'need'} you` : ''}`}
      </a>
      {open.length > 1 && <StopAllTasks />}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
