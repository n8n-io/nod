import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, Check, ChevronDown, ChevronLeft, ChevronUp } from 'lucide-react';
import { captureAnalytics } from '../lib/analytics';
import { errorMessage, post } from '../lib/api';
import type { Activity, Task } from '../../shared/contracts';
import { LiveLine } from './live-line';
import { MessageText } from './message';

const started = (task: Task) => task.status === 'queued' || task.status === 'working';

function progress(task: Task, finishing: boolean) {
  if (task.status === 'needs_you') return 'Needs you';
  if (finishing) return 'Finishing';
  const steps = task.steps?.length ?? 0;
  return steps ? `${Math.min((task.stepIndex ?? 0) + 1, steps)}/${steps}` : 'Working';
}

function textBottom(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  return (rects.at(-1) ?? element.getBoundingClientRect()).bottom;
}

function lastLine(thinking: HTMLElement) {
  const step = thinking.querySelector('details.live-line[open] > ol > li:last-child');
  if (step) return step;
  const lines = Array.from(
    thinking.querySelectorAll('.live-line-current, .working-receipt, .message-work'),
  ).filter((element) => element.getClientRects().length > 0);
  return lines.at(-1);
}

export function TaskLine({
  tasks,
  live,
  card,
}: {
  tasks: Task[];
  live: Activity[];
  card(task: Task, close: () => void, back?: () => void): ReactNode;
}) {
  const running = new Set(live.flatMap((item) => (item.taskId ? [item.taskId] : [])));
  const open = tasks.filter(
    (task) =>
      Boolean(task.messageId) &&
      (started(task) || task.status === 'needs_you' || running.has(task.id)),
  );
  const ids = open.map((task) => task.id).join(' ');
  const [view, setView] = useState<string | null>(null);
  const [room, setRoom] = useState<number | undefined>();
  const [linked, setLinked] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const text = useRef<HTMLSpanElement>(null);
  const show = (next: string) => {
    const line = root.current;
    const scroller = line?.closest('.conversation-scroll');
    if (line && scroller) {
      line.scrollIntoView({ block: 'nearest' });
      setRoom(
        Math.max(
          160,
          Math.round(line.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12),
        ),
      );
    }
    setView(next);
  };
  useEffect(() => {
    const openTask = (event: Event) => {
      const id = (event as CustomEvent<{ taskId?: unknown }>).detail?.taskId;
      if (typeof id !== 'string' || !ids.split(' ').includes(id)) return;
      event.preventDefault();
      show(id);
    };
    window.addEventListener('nod:open-task', openTask);
    return () => window.removeEventListener('nod:open-task', openTask);
  }, [ids]);
  useEffect(() => {
    const hover = (event: Event) => {
      const id = (event as CustomEvent<{ taskId?: unknown }>).detail?.taskId;
      setLinked(typeof id === 'string' && ids.split(' ').includes(id));
    };
    window.addEventListener('nod:hover-task', hover);
    return () => window.removeEventListener('nod:hover-task', hover);
  }, [ids]);
  useEffect(() => {
    if (!view) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setView(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setView(null);
      summary.current?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [view]);
  const visible = open.length > 0;
  useEffect(() => {
    const line = root.current;
    const button = summary.current;
    const words = text.current;
    const list = line?.parentElement;
    if (!line || !button || !words || !list) return;
    let stopped = false;
    const scroller = line.closest('.conversation-scroll');
    const place = () => {
      list.style.setProperty('--task-line-width', `${Math.ceil(button.offsetWidth)}px`);
      line.style.marginTop = '0px';
      line.style.marginBottom = '0px';
      const thinking = line.previousElementSibling;
      if (!(thinking instanceof HTMLElement) || !thinking.matches('.thinking:not([hidden])'))
        return;
      const target = lastLine(thinking);
      if (!target) return;
      const box = line.getBoundingClientRect();
      const end = thinking.getBoundingClientRect().bottom;
      const shift = Math.round(textBottom(target) - textBottom(words));
      line.style.marginTop = `${shift}px`;
      line.style.marginBottom = `${Math.round(end - (box.bottom + shift))}px`;
    };
    const atEnd = () =>
      !scroller || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2;
    let pinned = atEnd();
    const track = () => {
      pinned = atEnd();
    };
    const align = () => {
      if (stopped) return;
      place();
      if (pinned && scroller && !window.getSelection()?.toString())
        scroller.scrollTop = scroller.scrollHeight;
    };
    align();
    void document.fonts?.ready.then(align);
    const resize = new ResizeObserver(align);
    resize.observe(list);
    resize.observe(button);
    list.addEventListener('toggle', align, true);
    scroller?.addEventListener('scroll', track, { passive: true });
    return () => {
      stopped = true;
      resize.disconnect();
      list.removeEventListener('toggle', align, true);
      scroller?.removeEventListener('scroll', track);
      list.style.removeProperty('--task-line-width');
      line.style.marginTop = '';
      line.style.marginBottom = '';
    };
  }, [visible]);
  const count = open.length;
  const needs = open.filter((task) => task.status === 'needs_you').length;
  const current = view && view !== 'list' ? open.find((task) => task.id === view) : undefined;
  const listing = view === 'list' && count > 1;
  const expanded = Boolean(current || listing);
  useEffect(() => {
    if (view && !expanded) setView(null);
  }, [view, expanded]);
  if (!visible) return null;
  const move = (next: string | null) => {
    setView(next);
    (next ? pop.current : summary.current)?.focus();
  };
  return (
    <div className="task-line" ref={root}>
      <button
        type="button"
        ref={summary}
        className={`task-line-summary${linked ? ' task-line-linked' : ''}`}
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) setView(null);
          else show(count > 1 ? 'list' : open[0]!.id);
        }}
      >
        <span className="task-line-text" ref={text}>
          {needs === count ? (
            <span className="task-line-needs">
              {count === 1 ? '1 task needs you' : `${count} tasks need you`}
            </span>
          ) : (
            <>
              <span>
                {count} {count === 1 ? 'task' : 'tasks'}
                <span className="task-line-running"> running</span>
              </span>
              {needs > 0 && (
                <>
                  <span className="task-line-sep" aria-hidden="true">
                    ·
                  </span>
                  <span className="task-line-needs">{needs} needs you</span>
                </>
              )}
            </>
          )}
        </span>
        <ChevronUp size={14} aria-hidden="true" />
      </button>
      {expanded && (
        <div
          className="task-line-pop"
          ref={pop}
          tabIndex={-1}
          role="group"
          aria-label={current ? current.title : 'Running tasks'}
          style={room ? { maxHeight: room } : undefined}
        >
          {current ? (
            card(current, () => move(null), count > 1 ? () => move('list') : undefined)
          ) : (
            <div className="task-line-list" aria-label="Running tasks">
              {open.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  className="task-line-row"
                  onClick={() => move(task.id)}
                >
                  <span className="task-line-title">{task.title}</span>
                  <span className="task-line-status" data-status={task.status}>
                    {progress(task, !started(task) && task.status !== 'needs_you')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function TaskStackCard({
  task,
  live,
  onReply,
  onClose,
  onBack,
}: {
  task: Task;
  live?: Activity;
  onReply?(): void;
  onClose(): void;
  onBack?(): void;
}) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(false);
  const steps = task.steps ?? [];
  const index = Math.min(task.stepIndex ?? 0, steps.length);
  const handoff = task.browserHandoff ? task.questionMessageId : null;
  return (
    <article className="task-stack-panel" data-status={task.status}>
      <header className="task-stack-panel-head">
        {onBack && (
          <button
            type="button"
            className="task-stack-close task-stack-back"
            aria-label="All running tasks"
            onClick={onBack}
          >
            <ChevronLeft size={16} aria-hidden="true" />
          </button>
        )}
        <h3>{task.title}</h3>
        <button
          type="button"
          className="task-stack-close"
          aria-label="Close task"
          onClick={onClose}
        >
          <ChevronDown size={16} aria-hidden="true" />
        </button>
      </header>
      {task.status === 'needs_you' && task.question && (
        <div className="task-stack-ask">
          <MessageText text={task.question} />
        </div>
      )}
      {live && task.status !== 'needs_you' && (
        <p className="task-stack-now">
          <LiveLine item={live} history={false} />
        </p>
      )}
      {steps.length ? (
        <ol className="task-todo" data-status={task.status}>
          {steps.map((step, i) => (
            <li key={i} data-s={i < index ? 'done' : i === index ? 'current' : 'todo'}>
              <span className="task-todo-box" aria-hidden="true">
                {i < index && <Check size={10} strokeWidth={3} />}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      ) : (
        !live && task.now && <p className="task-stack-now">{task.now}</p>
      )}
      {details && task.doneWhen && (
        <div className="task-stack-details" id={`task-details-${task.id}`}>
          <span className="task-stack-details-head">Done when</span>
          <p>{task.doneWhen}</p>
        </div>
      )}
      <footer className="task-stack-panel-foot">
        {steps.length > 0 && (
          <span className="task-todo-count">
            {index} of {steps.length} done
          </span>
        )}
        <span className="task-stack-actions">
          {task.doneWhen && (
            <button
              type="button"
              aria-expanded={details}
              aria-controls={details ? `task-details-${task.id}` : undefined}
              onClick={() => {
                if (!details) captureAnalytics('task_action', { action: 'expand' });
                setDetails(!details);
              }}
            >
              {details ? 'Less' : 'Details'}
            </button>
          )}
          {handoff ? (
            <button
              type="button"
              onClick={() => {
                captureAnalytics('task_action', { action: 'open_browser' });
                window.dispatchEvent(
                  new CustomEvent('nod:focus-message', { detail: { messageId: handoff } }),
                );
                onClose();
              }}
            >
              Open browser
            </button>
          ) : (
            onReply && (
              <button
                type="button"
                onClick={() => {
                  captureAnalytics('task_action', { action: 'reply' });
                  onReply();
                }}
              >
                Reply
              </button>
            )
          )}
          <button
            type="button"
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
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </span>
      </footer>
      {error && (
        <p className="task-stack-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function TaskChip({
  task,
  running,
  answerId,
}: {
  task: Task;
  running: boolean;
  answerId?: string;
}) {
  const inStack = started(task) || task.status === 'needs_you' || running;
  const state =
    task.status === 'needs_you'
      ? 'needs_you'
      : inStack
        ? 'working'
        : task.status === 'done'
          ? 'done'
          : 'idle';
  const kicker =
    task.status === 'needs_you'
      ? 'Needs you'
      : inStack
        ? started(task)
          ? 'Task started'
          : 'Finishing'
        : task.status === 'done'
          ? 'Task done'
          : task.status === 'failed'
            ? 'Task failed'
            : task.status === 'cancelled'
              ? 'Task stopped'
              : 'Task waiting';
  const action = inStack
    ? task.status === 'needs_you'
      ? 'Reply'
      : 'Show'
    : task.status === 'done' && answerId
      ? 'See answer'
      : null;
  const link = (taskId: string | null) =>
    window.dispatchEvent(new CustomEvent('nod:hover-task', { detail: { taskId } }));
  const content = (
    <>
      <span className="task-chip-kicker">{kicker}</span>
      <span className="task-chip-title">{task.title}</span>
      {action && (
        <span className="task-chip-action">
          {action}
          <ArrowDown size={14} aria-hidden="true" />
        </span>
      )}
    </>
  );
  if (!action)
    return (
      <div className="task-chip" data-status={state}>
        {content}
      </div>
    );
  return (
    <button
      type="button"
      className="task-chip"
      data-status={state}
      aria-label={inStack ? `${action}: ${task.title}` : `See the answer to ${task.title}`}
      onPointerEnter={() => inStack && link(task.id)}
      onPointerLeave={() => link(null)}
      onFocus={() => inStack && link(task.id)}
      onBlur={() => link(null)}
      onClick={() => {
        link(null);
        if (inStack) {
          window.dispatchEvent(
            new CustomEvent('nod:open-task', { detail: { taskId: task.id }, cancelable: true }),
          );
          return;
        }
        window.dispatchEvent(
          new CustomEvent('nod:focus-message', { detail: { messageId: answerId } }),
        );
      }}
    >
      {content}
    </button>
  );
}
