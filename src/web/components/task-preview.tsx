import { useEffect, useId, useRef, useState } from 'react';
import {
  CalendarClock,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  Download,
  FileImage,
  FileText,
  Hourglass,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  MessageSquare,
  Square,
  X,
} from 'lucide-react';
import type { Artifact, Task, TaskStatus } from '../../shared/contracts';
import { errorMessage, post } from '../lib/api';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import { Button, Notice } from './ui';
import { MessageText } from './message';
import { ScheduleTask } from './plan-controls';
import {
  artifactPreview,
  attachmentKind,
  ownedArtifactUrl,
  PreviewContent,
} from './attachment-images';
import { fileSize, fileType } from './attachment-card';

export const taskLabels: Record<TaskStatus, string> = {
  queued: 'Queued',
  working: 'Working',
  needs_you: 'Needs you',
  waiting: 'Waiting',
  done: 'Done',
  stopped: 'Stopped',
  failed: 'Failed',
};
const icons = {
  queued: Hourglass,
  working: LoaderCircle,
  needs_you: MessageCircle,
  waiting: CalendarClock,
  done: CircleCheck,
  stopped: CircleSlash,
  failed: CircleAlert,
};
export const openTaskOrder: TaskStatus[] = ['needs_you', 'working', 'waiting', 'queued'];
export const isOpenTask = (task: Task) => openTaskOrder.includes(task.status);

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

function plain(text: string) {
  const line =
    text.split('\n').find((value) => value.trim() && !/^\s*\[[^\]]+\]:\s/.test(value)) ?? '';
  return line
    .replace(/!?\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g, '$1')
    .replace(/[*_`#>~]/g, '')
    .trim();
}

function minutes(task: Task) {
  const end = Date.parse(task.closedAt ?? task.updatedAt);
  return Math.max(1, Math.round((end - Date.parse(task.createdAt)) / 60_000));
}

function summary(task: Task) {
  if (task.status === 'needs_you') return plain(task.question ?? '') || 'Waiting for your answer';
  if (task.status === 'done') return `Finished in ${minutes(task)} min`;
  if (task.status === 'stopped') return `Stopped after ${minutes(task)} min`;
  if (task.status === 'failed')
    return plain(task.error ?? '') || `Failed after ${minutes(task)} min`;
  if (task.status === 'waiting' && !task.now)
    return `Waiting on ${task.waitingFor.map((wait) => wait.who).join(', ')}`;
  return task.now || task.steps[task.stepIndex] || taskLabels[task.status];
}

function stepState(task: Task, index: number) {
  if (task.status === 'done' || index < task.stepIndex) return 'done';
  return index === task.stepIndex ? 'current' : 'todo';
}

async function stopTask(id?: string) {
  await post(id ? `/api/tasks/${encodeURIComponent(id)}/stop` : '/api/thread/stop');
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
          <span>{fileType(artifact.name)}</span>
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
  open: shown,
  onToggle,
  onScheduled,
}: {
  task: Task;
  place: 'chat' | 'page';
  open?: boolean;
  onToggle?(): void;
  onScheduled?(): void;
}) {
  const format = useDateFormat();
  const bodyId = useId();
  const [expanded, setExpanded] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const open = shown ?? expanded;
  const done =
    task.status === 'done' ? task.steps.length : Math.min(task.stepIndex, task.steps.length);
  async function stop() {
    setStopping(true);
    setError('');
    try {
      await stopTask(task.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStopping(false);
    }
  }
  const showInChat = place === 'page' && task.onItMessageId !== null;
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
        </span>
        <span className="task-preview-line">{summary(task)}</span>
        <span className="task-preview-foot">
          {task.steps.length > 0 && (
            <span className="task-steps-bar" aria-hidden="true">
              {task.steps.map((step, index) => (
                <i key={`${index}:${step}`} data-state={stepState(task, index)} />
              ))}
            </span>
          )}
          <span className="task-preview-count">
            {task.steps.length > 0 && `${done} of ${task.steps.length} steps`}
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </span>
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
            {(showInChat || isOpenTask(task)) && (
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
                {isOpenTask(task) && (
                  <Button variant="ghost" size="sm" disabled={stopping} onClick={() => void stop()}>
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                    Stop task
                  </Button>
                )}
              </div>
            )}
            {place === 'page' && task.status === 'done' && task.onItMessageId !== null && (
              <ScheduleTask taskId={task.id} onCreated={onScheduled} />
            )}
            {error && <Notice>{error}</Notice>}
          </>
        )}
      </div>
    </div>
  );
}

export function StopAllTasks() {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  async function stop() {
    setStopping(true);
    setError('');
    try {
      await stopTask();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStopping(false);
    }
  }
  return (
    <>
      <Button variant="ghost" size="sm" disabled={stopping} onClick={() => void stop()}>
        <Square size={14} fill="currentColor" aria-hidden="true" />
        Stop all
      </Button>
      {error && <Notice>{error}</Notice>}
    </>
  );
}

export function TasksStrip({ tasks, onOpen }: { tasks: Task[]; onOpen(task: Task): void }) {
  const [stopping, setStopping] = useState('');
  const [error, setError] = useState('');
  const open = tasks
    .filter((task) => isOpenTask(task) && task.onItMessageId)
    .sort((a, b) => openTaskOrder.indexOf(a.status) - openTaskOrder.indexOf(b.status));
  if (open.length < 2 && !open.some((task) => task.status === 'needs_you')) return null;
  async function stop(id: string) {
    setStopping(id);
    setError('');
    try {
      await stopTask(id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setStopping('');
    }
  }
  return (
    <div className="tasks-strip" role="group" aria-label="Open tasks">
      <div className="tasks-strip-items">
        {open.map((task) => (
          <span key={task.id} className="task-status tasks-strip-item" data-status={task.status}>
            <button type="button" className="tasks-strip-open" onClick={() => onOpen(task)}>
              <StatusIcon status={task.status} size={14} />
              <span className="tasks-strip-title">{task.title}</span>
              <span className="tasks-strip-state">{taskLabels[task.status]}</span>
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
      </div>
      <StopAllTasks />
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
