import { useEffect, useRef, useState } from 'react';
import type { Activity, Connection, Schedule, Task } from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import type { ChannelSettings } from '../lib/secondary-pages';
import { navigate } from '../lib/navigation';
import { readUiPreference, writeUiPreference } from '../lib/ui-preferences';
import { ScheduleRow } from '../pages/schedule';
import { LoadError, Pending, TaskCard } from '../pages/tasks';
import { ChevronDown, X } from './icons';
import { NodGlyph, prefersReducedMotion } from './motion';
import { NewPlan } from './plan-controls';
import { Button } from './ui';

type Step = {
  id: string;
  title: string;
  hint: string;
  action: string;
  ask: string;
  done: boolean;
  go?: { label: string; path: string };
};

const limit = 5;
const closed = (task: Task) => task.status === 'done' || task.status === 'cancelled';

function useFresh(done: string[], ready: boolean) {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<string[]>([]);
  const timers = useRef<number[]>([]);
  const key = done.join('|');
  useEffect(() => () => timers.current.forEach((timer) => window.clearTimeout(timer)), []);
  useEffect(() => {
    if (!ready) return;
    const previous = seen.current;
    seen.current = new Set(done);
    if (!previous) return;
    const added = done.filter((id) => !previous.has(id));
    if (!added.length) return;
    setFresh((current) => [...current, ...added]);
    timers.current.push(
      window.setTimeout(
        () => setFresh((current) => current.filter((id) => !added.includes(id))),
        1600,
      ),
    );
  }, [key, ready]);
  return fresh;
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" fill="none">
      <circle cx="16" cy="16" r="10" stroke="currentColor" strokeWidth="4" />
      <circle cx="25" cy="6" r="4" fill="var(--brand-pink)" />
    </svg>
  );
}

function Tick({ done, fresh }: { done: boolean; fresh: boolean }) {
  return (
    <span className="side-mark" data-anchor data-done={done} data-fresh={fresh} aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" />
        {done && <path d="M7.5 12.4l3 3 6-6.4" pathLength={1} />}
      </svg>
    </span>
  );
}

export function sidePanelOpenByDefault() {
  return (
    window.matchMedia('(min-width: 1180px)').matches &&
    readUiPreference('nod.side-open') !== 'false'
  );
}

export function SidePanel({
  tasks,
  activity,
  connections,
  disabled,
  onAsk,
  onClose,
}: {
  tasks: Task[];
  activity: Activity[];
  connections: Connection[] | null;
  disabled: boolean;
  onAsk(text: string): void;
  onClose(): void;
}) {
  const scheduled = usePageData<Schedule[]>('/api/schedules');
  const schedules = scheduled.data;
  const { data: channels } = usePageData<ChannelSettings>('/api/channel-settings');
  const ready = Boolean(connections && schedules && channels);
  const recurring = (schedules ?? []).filter((item) => item.kind === 'recurring' && item.enabled);
  const finished = tasks.filter((item) => item.status === 'done');
  const running = tasks.filter((task) => !closed(task));
  const past = tasks.filter(closed);
  const upcoming = (schedules ?? [])
    .filter((schedule) => schedule.enabled && schedule.nextRun)
    .sort((a, b) => a.nextRun!.localeCompare(b.nextRun!) || a.id.localeCompare(b.id));
  const inactive = (schedules ?? []).filter((schedule) => !upcoming.includes(schedule));
  const elsewhere = [
    ...(upcoming.length > limit ? [`${upcoming.length - limit} more upcoming`] : []),
    ...(inactive.length ? [`${inactive.length} inactive`] : []),
  ];

  const [skipped, setSkipped] = useState(() =>
    (readUiPreference('nod.side-skipped') ?? '').split(',').filter(Boolean),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [skipping, setSkipping] = useState<string | null>(null);
  const skippedNow = useRef(skipped);
  const skip = (ids: string[]) => {
    skippedNow.current = ids;
    setSkipped(ids);
    writeUiPreference('nod.side-skipped', ids.join(','));
  };
  const every: Step[] = [
    {
      id: 'app',
      title: 'Connect an app',
      hint: 'Nod can only help with what it can see.',
      action: 'Ask Nod to help',
      ask: 'Help me connect my first app',
      go: { label: 'Open Apps', path: '/apps' },
      done: (connections ?? []).some((item) => item.status === 'connected'),
    },
    {
      id: 'task',
      title: 'Hand over a first task',
      hint: 'Something small you would rather not do yourself.',
      action: 'Suggest one',
      ask: 'What is one thing you could take off my plate right now?',
      done: finished.length > 0,
    },
    {
      id: 'job',
      title: 'Give Nod a recurring job',
      hint: 'Work it does without being asked.',
      action: 'Ask Nod for ideas',
      ask: 'Suggest one recurring job you could run for me',
      go: { label: 'Open Scheduled', path: '/tasks' },
      done: recurring.length > 0,
    },
    {
      id: 'phone',
      title: 'Reach Nod from your phone',
      hint: 'Message it from Telegram or WhatsApp.',
      action: 'Ask Nod to help',
      ask: 'Help me reach you from my phone',
      go: { label: 'Open Channels', path: '/channels' },
      done: (channels?.channels ?? []).some((item) => item.enabled),
    },
  ];
  const [seen, setSeen] = useState(() => readUiPreference('nod.side-seen'));
  useEffect(() => {
    if (!ready || seen) return;
    const done = every.filter((step) => step.done).map((step) => step.id);
    const kind = done.length ? `returning:${done.join(',')}` : 'new';
    setSeen(kind);
    writeUiPreference('nod.side-seen', kind);
  }, [ready, seen]);
  const already = seen?.startsWith('returning:') ? seen.slice(10).split(',') : [];
  const steps = every.filter((step) => !skipped.includes(step.id) && !already.includes(step.id));
  const stepsDone = steps.filter((step) => step.done);
  const complete = steps.length > 0 && stepsDone.length === steps.length;
  const next = steps.find((step) => !step.done);
  const open = picked ?? next?.id;

  const fresh = useFresh(
    stepsDone.map((step) => step.id),
    ready,
  );
  const settling = steps.some((step) => fresh.includes(step.id));
  const root = useRef<HTMLElement>(null);
  const courier = useRef<HTMLSpanElement>(null);
  const latest = fresh.at(-1);
  useEffect(() => {
    const panel = root.current;
    const logo = courier.current;
    if (!latest || !panel || !logo || prefersReducedMotion()) return;
    const home = panel.querySelector('.side-glyph');
    const target = panel.querySelector(`[data-id="${CSS.escape(latest)}"] [data-anchor]`);
    if (!home || !target) return;
    const from = home.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const x = to.left + to.width / 2 - (from.left + from.width / 2);
    const y = to.top + to.height / 2 - (from.top + from.height / 2);
    const at = (px: number, py: number, turn: number, sx: number, sy = sx) =>
      `translate(${px}px, ${py}px) rotate(${turn}deg) scale(${sx}, ${sy})`;
    logo.style.left = `${from.left}px`;
    logo.style.top = `${from.top}px`;
    panel.dataset.flying = 'true';
    const flight = logo.animate(
      [
        { transform: at(0, 0, 0, 1) },
        { transform: at(x * 0.45 - 36, y * 0.4, -150, 1.2), offset: 0.26 },
        { transform: at(x, y, -360, 0.85), offset: 0.5 },
        { transform: at(x, y + 2, -360, 1, 0.68), offset: 0.56 },
        { transform: at(x, y, -360, 0.85), offset: 0.66 },
        { transform: at(x * 0.5 + 24, y * 0.5, -180, 1.1), offset: 0.86 },
        { transform: at(0, 0, 0, 1) },
      ],
      { duration: 1500, easing: 'cubic-bezier(0.5, 0, 0.3, 1)' },
    );
    const land = () => delete panel.dataset.flying;
    flight.onfinish = land;
    return () => {
      flight.cancel();
      land();
    };
  }, [latest]);

  return (
    <aside ref={root} className="artifact-drawer side-panel" aria-label="Tasks">
      <span ref={courier} className="side-courier" aria-hidden="true">
        <Logo />
      </span>
      <div className="artifact-drawer-panel">
        <header className="artifact-drawer-header">
          <NodGlyph size={24} mode="still" className="side-glyph" />
          <div className="artifact-drawer-title">
            <h2>Your Nod</h2>
          </div>
          <div className="artifact-drawer-actions">
            <Button variant="ghost" size="icon" aria-label="Hide tasks" onClick={onClose}>
              <X size={16} />
            </Button>
          </div>
        </header>
        <div className="side-body">
          {seen && steps.length > 0 && (!complete || settling) && (
            <section className="side-section">
              <div className="side-heading">
                <h3>{already.length ? 'Get more from Nod' : 'Getting started'}</h3>
                <span className="side-tally">
                  <b key={stepsDone.length}>{stepsDone.length}</b> of {steps.length}
                </span>
              </div>
              <div className="side-meter" aria-hidden="true">
                {steps.map((step) => (
                  <i key={step.id} data-on={step.done} />
                ))}
              </div>
              <ul className="side-steps">
                {steps.map((step) => (
                  <li
                    key={step.id}
                    className="side-step"
                    data-id={step.id}
                    data-done={step.done}
                    data-open={open === step.id}
                    data-next={step === next}
                    data-fresh={fresh.includes(step.id)}
                    data-closing={skipping === step.id ? 'dismissed' : undefined}
                  >
                    <Tick done={step.done} fresh={fresh.includes(step.id)} />
                    <button
                      type="button"
                      className="side-step-title"
                      aria-expanded={open === step.id}
                      onClick={() => setPicked(open === step.id ? '' : step.id)}
                    >
                      {step.title}
                      <span className="sr-only">{step.done ? ' (done)' : ' (not done)'}</span>
                    </button>
                    {open === step.id && (
                      <span className="side-step-hint">{step.done ? 'Done.' : step.hint}</span>
                    )}
                    {open === step.id && (
                      <span className="side-step-action">
                        {step.go && (
                          <Button
                            size="sm"
                            variant={step.done ? 'secondary' : 'default'}
                            onClick={() => navigate(step.go!.path)}
                          >
                            {step.go.label}
                          </Button>
                        )}
                        {!step.done && (
                          <Button
                            size="sm"
                            variant={step.go ? 'secondary' : 'default'}
                            disabled={disabled}
                            onClick={() => onAsk(step.ask)}
                          >
                            {step.action}
                          </Button>
                        )}
                        {!step.done && (
                          <button
                            type="button"
                            onClick={() => {
                              setSkipping(step.id);
                              window.setTimeout(() => {
                                skip([...new Set([...skippedNow.current, step.id])]);
                                setSkipping(null);
                                setPicked(null);
                              }, 320);
                            }}
                          >
                            Skip
                          </button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {skipped.length > 0 && (
                <div className="side-links">
                  <button type="button" onClick={() => skip([])}>
                    Bring back {skipped.length} skipped
                  </button>
                </div>
              )}
            </section>
          )}
          <section className="side-section">
            <div className="side-heading">
              <h3>Tasks</h3>
              <span className="side-tally">
                <b key={running.length}>{running.length}</b> open
              </span>
            </div>
            {running.length ? (
              <div className="saved-plan-list open-task-list">
                {running.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    live={activity.find((item) => item.taskId === task.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="side-nudge">
                Nothing open. Work you hand to Nod in chat shows up here.
              </p>
            )}
            {past.length > 0 && (
              <details className="schedule-inactive">
                <summary>
                  Finished <span>{past.length}</span>
                  <ChevronDown size={16} aria-hidden="true" />
                </summary>
                <div className="saved-plan-list">
                  {past.slice(0, limit).map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
                {past.length > limit && (
                  <div className="side-links">
                    <button type="button" onClick={() => navigate('/tasks')}>
                      All {past.length} finished tasks
                    </button>
                  </div>
                )}
              </details>
            )}
          </section>
          <section className="side-section">
            <div className="side-heading">
              <h3>Schedules</h3>
              <span className="side-tally">
                <b key={upcoming.length}>{upcoming.length}</b> upcoming
              </span>
            </div>
            <div>
              <NewPlan onAsk={onAsk} />
            </div>
            {scheduled.error && (
              <LoadError
                what="schedules"
                refreshing={scheduled.refreshing}
                retry={scheduled.refresh}
              />
            )}
            {!schedules ? (
              scheduled.loading && <Pending label="Loading schedules…" />
            ) : upcoming.length ? (
              <div className="schedule-list">
                {upcoming.slice(0, limit).map((schedule) => (
                  <ScheduleRow
                    key={schedule.id}
                    schedule={schedule}
                    activity={activity}
                    onAsk={onAsk}
                  />
                ))}
              </div>
            ) : (
              <p className="side-nudge">No upcoming schedules.</p>
            )}
            {elsewhere.length > 0 && (
              <div className="side-links">
                <button type="button" onClick={() => navigate('/tasks')}>
                  {elsewhere.join(', ')}
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </aside>
  );
}
