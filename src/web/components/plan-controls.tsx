import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUp, LoaderCircle, MessageCircle, Sparkles } from 'lucide-react';
import type { AppState, Goal, Schedule } from '../../shared/contracts';
import { BrandMark } from './brand';
import { MessageText } from './message';
import { Button, Input, Notice, Switch } from './ui';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { focusChatMessage } from '../lib/secondary-pages';

type Kind = 'goal' | 'schedule';
type Subject = { kind: Kind; title?: string };
type Ask = { text: string; messageId: string; turnId?: string; error?: string };

function subjectPrefix(subject: Subject) {
  if (!subject.title) return subject.kind === 'goal' ? 'New goal: ' : 'New schedule: ';
  return `About the ${subject.kind} ${JSON.stringify(subject.title)}: `;
}

function useAskOtto(conversation: AppState | null) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const asked = conversation?.messages.find((message) => message.id === ask?.messageId);
  const turnId = ask?.turnId ? (asked?.turnId ?? ask.turnId) : undefined;
  const answer = turnId
    ? conversation?.messages
        .filter(
          (message) =>
            message.turnId === turnId &&
            message.role === 'assistant' &&
            (!asked || Date.parse(message.createdAt) > Date.parse(asked.createdAt)),
        )
        .at(-1)
    : undefined;
  const turn = conversation?.turns.find((item) => item.id === turnId);
  const status: 'idle' | 'working' | 'waiting' | 'done' | 'failed' = !ask
    ? 'idle'
    : ask.error || turn?.status === 'failed' || turn?.status === 'cancelled'
      ? 'failed'
      : !turn || turn.status === 'queued' || turn.status === 'running'
        ? 'working'
        : turn.status === 'waiting'
          ? 'waiting'
          : 'done';
  async function send(text: string) {
    const messageId =
      ask?.error && ask.text === text && !ask.turnId ? ask.messageId : crypto.randomUUID();
    setAsk({ text, messageId });
    try {
      const result = await api<{ turnId: string }>('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientMessageId: messageId,
          text,
          attachmentIds: [],
          ...(conversation?.threadId ? { threadId: conversation.threadId } : {}),
        }),
      });
      setAsk((current) =>
        current?.messageId === messageId ? { ...current, turnId: result.turnId } : current,
      );
    } catch (cause) {
      setAsk((current) =>
        current?.messageId === messageId ? { ...current, error: errorMessage(cause) } : current,
      );
    }
  }
  useEffect(() => {
    if (status !== 'done') return;
    void pageDataCache.refresh('/api/goals', true);
    void pageDataCache.refresh('/api/schedules', true);
  }, [status]);
  return { ask, status, answer, send };
}

const suggestions = {
  goal: ['Mark it 50% done', 'Change the next step', 'Move the target date'],
  schedule: ['Move it to 8:00 on weekdays', 'Run it every Monday', 'Add the weather'],
  newGoal: ['Run a 10 km race', 'Read more books', 'Save for a trip'],
  newSchedule: ['Remind me to stretch at 16:00', 'Summarize my inbox each Friday'],
};

function AskOtto({
  subject,
  conversation,
  onClose,
}: {
  subject: Subject;
  conversation: AppState | null;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const otto = useAskOtto(conversation);
  const id = useId();
  useEffect(() => input.current?.focus(), []);
  const chips = subject.title
    ? suggestions[subject.kind]
    : subject.kind === 'goal'
      ? suggestions.newGoal
      : suggestions.newSchedule;
  const submit = (value: string) => {
    if (!value.trim() || otto.status === 'working') return;
    void otto.send(`${subjectPrefix(subject)}${value.trim()}`);
    setText('');
  };
  const placeholder = subject.title
    ? `What should change in ${subject.title}?`
    : subject.kind === 'goal'
      ? 'What do you want to achieve?'
      : 'What should Otto do, and when?';
  return (
    <div className="ask-otto" role="group" aria-labelledby={`${id}-label`}>
      <span className="sr-only" id={`${id}-label`}>
        Ask Otto {subject.title ? `about ${subject.title}` : `for a new ${subject.kind}`}
      </span>
      {otto.ask && (
        <div className="ask-otto-exchange" aria-live="polite">
          <p className="ask-otto-request">{otto.ask.text.replace(subjectPrefix(subject), '')}</p>
          <div className="ask-otto-reply">
            <span className="assistant-mark">
              <BrandMark small />
            </span>
            {otto.status === 'working' ? (
              <span className="ask-otto-working" role="status">
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
                Otto is on it
              </span>
            ) : otto.status === 'failed' ? (
              <span className="ask-otto-failed">
                {otto.ask.error || 'Otto could not finish this. Try again.'}
              </span>
            ) : (
              <MessageText
                text={
                  otto.answer?.text ||
                  (otto.status === 'waiting'
                    ? 'Otto needs your input. Open the conversation to continue.'
                    : 'Otto finished this request.')
                }
              />
            )}
          </div>
          {otto.status !== 'working' && (
            <div className="ask-otto-after">
              {otto.ask.turnId && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => focusChatMessage(otto.ask!.messageId)}
                >
                  <MessageCircle size={13} aria-hidden="true" />
                  Open conversation
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          )}
        </div>
      )}
      {otto.status !== 'working' && (
        <>
          <form
            className="ask-otto-field"
            onSubmit={(event) => {
              event.preventDefault();
              submit(text);
            }}
          >
            <Input
              ref={input}
              value={text}
              placeholder={otto.ask ? 'Anything else?' : placeholder}
              aria-label={placeholder}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  onClose();
                }
              }}
            />
            <Button type="submit" size="icon" aria-label="Send to Otto" disabled={!text.trim()}>
              <ArrowUp size={16} />
            </Button>
          </form>
          {!otto.ask && (
            <div className="ask-otto-chips">
              {chips.map((chip) => (
                <Button
                  key={chip}
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => submit(chip)}
                >
                  {chip}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function statusChange(kind: Kind, item: Goal | Schedule) {
  if (kind === 'goal') return { status: (item as Goal).status === 'active' ? 'paused' : 'active' };
  return { enabled: !(item as Schedule).enabled };
}

async function patchPlan(kind: Kind, id: string, body: Record<string, unknown>) {
  const path = `/api/${kind}s`;
  const saved = await api<Goal | Schedule>(`${path}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  pageDataCache.update<Array<Goal | Schedule>>(path, (items) =>
    items ? items.map((entry) => (entry.id === id ? { ...entry, ...saved } : entry)) : items,
  );
  void pageDataCache.refresh(path, true);
}

type Toast = { id: number; text: string; failed?: boolean; undo?(): void };
let toast: Toast | null = null;
const toastListeners = new Set<() => void>();
function showToast(value: Toast | null) {
  toast = value;
  for (const listener of toastListeners) listener();
}

export function PlanToast() {
  const value = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toast,
    () => null,
  );
  useEffect(() => {
    if (!value) return;
    const timer = setTimeout(() => {
      if (toast?.id === value.id) showToast(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [value]);
  useEffect(() => () => showToast(null), []);
  return (
    <div className="plan-toast">
      {value && (
        <Notice kind={value.failed ? 'error' : 'success'}>
          <span>{value.text}</span>
          {value.undo && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                showToast(null);
                value.undo!();
              }}
            >
              Undo
            </Button>
          )}
        </Notice>
      )}
    </div>
  );
}

function useDirectChange(kind: Kind, id: string) {
  const [busy, setBusy] = useState(false);
  async function apply(
    body: Record<string, unknown>,
    note: string,
    undo?: Record<string, unknown>,
  ) {
    setBusy(true);
    try {
      await patchPlan(kind, id, body);
      showToast({
        id: Date.now(),
        text: note,
        ...(undo
          ? {
              undo: () =>
                void patchPlan(kind, id, undo).catch((cause) =>
                  showToast({ id: Date.now(), text: errorMessage(cause), failed: true }),
                ),
            }
          : {}),
      });
    } catch (cause) {
      showToast({ id: Date.now(), text: errorMessage(cause), failed: true });
    } finally {
      setBusy(false);
    }
  }
  return { busy, apply };
}

function pauseNote(kind: Kind, pausing: boolean, title: string) {
  if (!pausing) return `Resumed ${title}.`;
  return kind === 'schedule'
    ? `Paused ${title}. Otto will not run it until you resume it.`
    : `Paused ${title}. Progress and next step stay saved.`;
}

const frequencies = [
  { value: '*', label: 'Every day' },
  { value: '1-5', label: 'Weekdays' },
  { value: '0,6', label: 'Weekends' },
  { value: '1', label: 'Mondays' },
  { value: '2', label: 'Tuesdays' },
  { value: '3', label: 'Wednesdays' },
  { value: '4', label: 'Thursdays' },
  { value: '5', label: 'Fridays' },
  { value: '6', label: 'Saturdays' },
  { value: '0', label: 'Sundays' },
];

function simpleCron(cron: string | null) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|0,6|[0-6])$/.exec(cron ?? '');
  return match ? { minute: match[1], hour: match[2], day: match[3] } : null;
}

function Toggle({
  label,
  on,
  text,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  text: string;
  disabled: boolean;
  onChange(): void;
}) {
  return (
    <span className="plan-toggle">
      <Switch checked={on} aria-label={label} disabled={disabled} onCheckedChange={onChange} />
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

function Note({ change }: { change: { busy: boolean } }) {
  return change.busy ? <LoaderCircle size={14} className="spin" aria-label="Saving" /> : null;
}

function ScheduleControls({ schedule, canPause }: { schedule: Schedule; canPause: boolean }) {
  const change = useDirectChange('schedule', schedule.id);
  const cron = simpleCron(schedule.cron);
  const time = cron ? `${cron.hour.padStart(2, '0')}:${cron.minute.padStart(2, '0')}` : '';
  return (
    <div className="plan-controls">
      {canPause && (
        <Toggle
          label={`${schedule.title} on`}
          on={schedule.enabled}
          text={schedule.enabled ? 'On' : 'Paused'}
          disabled={change.busy}
          onChange={() =>
            void change.apply(
              { enabled: !schedule.enabled },
              pauseNote('schedule', schedule.enabled, schedule.title),
              { enabled: schedule.enabled },
            )
          }
        />
      )}
      {cron && (
        <>
          <select
            className="input plan-input"
            aria-label={`${schedule.title} days`}
            value={frequencies.some((item) => item.value === cron.day) ? cron.day : '*'}
            disabled={change.busy}
            onChange={(event) =>
              void change.apply(
                { cron: `${cron.minute} ${cron.hour} * * ${event.target.value}` },
                `${schedule.title} now runs ${event.target.value === '*' ? 'every day' : `on ${frequencies.find((item) => item.value === event.target.value)!.label.toLowerCase()}`}.`,
                { cron: schedule.cron },
              )
            }
          >
            {frequencies.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
          <Input
            className="plan-input"
            type="time"
            aria-label={`${schedule.title} time`}
            defaultValue={time}
            key={time}
            disabled={change.busy}
            onBlur={(event) => {
              const [hour, minute] = event.target.value.split(':');
              if (!hour || event.target.value === time) return;
              void change.apply(
                { cron: `${Number(minute)} ${Number(hour)} * * ${cron.day}` },
                `${schedule.title} now runs at ${event.target.value}.`,
                { cron: schedule.cron },
              );
            }}
          />
        </>
      )}
      <Note change={change} />
    </div>
  );
}

function GoalControls({ goal }: { goal: Goal }) {
  const change = useDirectChange('goal', goal.id);
  if (goal.status === 'completed') return null;
  const save = (value: string) =>
    void change.apply({ progress: Number(value) }, `${goal.title} is ${value}% done.`, {
      progress: goal.progress,
    });
  return (
    <div className="plan-controls">
      <Toggle
        label={`${goal.title} active`}
        on={goal.status === 'active'}
        text={goal.status === 'active' ? 'Active' : 'Paused'}
        disabled={change.busy}
        onChange={() =>
          void change.apply(
            statusChange('goal', goal),
            pauseNote('goal', goal.status === 'active', goal.title),
            { status: goal.status },
          )
        }
      />
      <input
        className="plan-range"
        type="range"
        min={0}
        max={100}
        step={5}
        defaultValue={goal.progress}
        key={goal.progress}
        aria-label={`${goal.title} progress`}
        disabled={change.busy}
        onPointerUp={(event) => save(event.currentTarget.value)}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            save(event.currentTarget.value);
        }}
      />
      <span className="plan-range-value">{goal.progress}%</span>
      <Note change={change} />
    </div>
  );
}

export function PlanFooter({
  kind,
  item,
  meta,
  remove,
  canPause,
  conversation,
}: {
  kind: Kind;
  item: Goal | Schedule;
  meta: ReactNode;
  remove: ReactNode;
  canPause: boolean;
  conversation: AppState | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {kind === 'goal' ? (
        <GoalControls goal={item as Goal} />
      ) : (
        <ScheduleControls schedule={item as Schedule} canPause={canPause} />
      )}
      <div className="saved-plan-footer">
        <span>{meta}</span>
        <div className="saved-plan-actions">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={open}
            aria-label={`Ask Otto about ${item.title}`}
            onClick={() => setOpen(!open)}
          >
            <Sparkles size={13} aria-hidden="true" />
            Ask Otto
          </Button>
          {remove}
        </div>
      </div>
      {open && (
        <AskOtto
          subject={{ kind, title: item.title }}
          conversation={conversation}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function NewPlan({ kind, conversation }: { kind: Kind; conversation: AppState | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Sparkles size={14} aria-hidden="true" />
        {kind === 'goal' ? 'New goal' : 'New schedule'}
      </Button>
      {open && (
        <div className="connection-menu-options menu new-plan-card">
          <AskOtto subject={{ kind }} conversation={conversation} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
