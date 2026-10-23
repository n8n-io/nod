import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUp, ChevronDown, LoaderCircle, Plus } from './icons';
import type { Schedule } from '../../shared/contracts';
import { Button, Field, Input, Notice, Switch } from './ui';
import { SearchPicker, TimeZonePicker, type PickerOption } from './time-zone-picker';
import { api, ApiError, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import { useDateFormat } from '../lib/date-format';
import {
  readSchedule,
  scheduleExpression,
  scheduleLocalTime,
  scheduleRunAt,
  scheduleWeekDays,
  type ScheduleFrequency,
} from '../lib/schedules';

type Subject = { kind: 'task' } | { kind: 'schedule'; title?: string };

const suggestions = {
  task: ['Get three quotes for a boiler service', 'Follow up on emails nobody answered this week'],
  schedule: ['Move it to 8:00 on weekdays', 'Run it every Monday', 'Add the weather'],
  newSchedule: ['Remind me to stretch at 16:00', 'Summarize my inbox each Friday'],
};

function askFor(subject: Subject) {
  if (subject.kind === 'task')
    return {
      prefix: '',
      placeholder: 'What should nod take care of?',
      label: 'Ask nod for a task',
      chips: suggestions.task,
    };
  if (subject.title)
    return {
      prefix: `About the schedule ${JSON.stringify(subject.title)}: `,
      placeholder: `What should change in ${subject.title}?`,
      label: `Ask nod about ${subject.title}`,
      chips: suggestions.schedule,
    };
  return {
    prefix: 'New schedule: ',
    placeholder: 'What should nod do, and when?',
    label: 'Ask nod for a new schedule',
    chips: suggestions.newSchedule,
  };
}

export function AskNod({
  subject,
  onAsk,
  onClose,
}: {
  subject: Subject;
  onAsk(text: string): void;
  onClose(): void;
}) {
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  useEffect(() => input.current?.focus(), []);
  const { prefix, placeholder, label, chips } = askFor(subject);
  const submit = (value: string) => {
    if (!value.trim()) return;
    onAsk(`${prefix}${value.trim()}`);
  };
  return (
    <div className="ask-nod" role="group" aria-labelledby={`${id}-label`}>
      <span className="sr-only" id={`${id}-label`}>
        {label}
      </span>
      <form
        className="ask-nod-field"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <Input
          ref={input}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <Button type="submit" size="icon" aria-label="Send to nod" disabled={!text.trim()}>
          <ArrowUp size={16} />
        </Button>
      </form>
      <div className="ask-nod-chips">
        {chips.map((chip) => (
          <Button key={chip} type="button" variant="outline" size="sm" onClick={() => submit(chip)}>
            {chip}
          </Button>
        ))}
      </div>
    </div>
  );
}

async function patchSchedule(id: string, body: Record<string, unknown>) {
  const path = '/api/schedules';
  const saved = await api<Schedule>(`${path}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  pageDataCache.update<Schedule[]>(path, (items) =>
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

export function useDirectChange(id: string) {
  const [busy, setBusy] = useState(false);
  async function apply(
    body: Record<string, unknown>,
    note: string,
    undo?: Record<string, unknown>,
  ) {
    setBusy(true);
    try {
      await patchSchedule(id, body);
      showToast({
        id: Date.now(),
        text: note,
        ...(undo
          ? {
              undo: () =>
                void patchSchedule(id, undo).catch((cause) =>
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

type ScheduleChange = ReturnType<typeof useDirectChange>;

function pauseNote(pausing: boolean, title: string) {
  return pausing
    ? `Paused ${title}. nod will not run it until you resume it.`
    : `Resumed ${title}.`;
}

const frequencies = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekends', label: 'Weekends' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

function SchedulePicker({
  label,
  ...props
}: {
  label: string;
  value: string;
  options: PickerOption[];
  disabled: boolean;
  onChange(value: string): void;
}) {
  const id = useId();
  return (
    <div className="schedule-timing-field">
      <span className="field-label" id={id}>
        {label}
      </span>
      <SearchPicker
        {...props}
        labelledBy={id}
        labels={{
          choose: `Choose ${label.toLowerCase()}`,
          search: `Search ${label.toLowerCase()}`,
          placeholder: 'Search options',
          clear: 'Clear search',
          list: label,
          empty: 'No options found.',
        }}
      />
    </div>
  );
}

export function PauseSwitch({ schedule, change }: { schedule: Schedule; change: ScheduleChange }) {
  return (
    <>
      {change.busy && <LoaderCircle size={16} className="spin" aria-label="Saving" />}
      <Switch
        checked={schedule.enabled}
        aria-label={`${schedule.title} active`}
        disabled={change.busy}
        onCheckedChange={() =>
          void change.apply(
            { enabled: !schedule.enabled },
            pauseNote(schedule.enabled, schedule.title),
            { enabled: schedule.enabled },
          )
        }
      />
    </>
  );
}

export function ScheduleTiming({
  schedule,
  change,
}: {
  schedule: Schedule;
  change: ScheduleChange;
}) {
  const initial = {
    ...readSchedule(schedule.cron ?? ''),
    ...(schedule.kind === 'once' && schedule.runAt
      ? scheduleLocalTime(schedule.runAt, schedule.timeZone)
      : { date: '' }),
    timeZone: schedule.timeZone,
  };
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const timeZoneLabel = useId();
  const dirty = Object.keys(initial).some(
    (key) => draft[key as keyof typeof draft] !== initial[key as keyof typeof initial],
  );
  const zones = [
    ...new Set([schedule.timeZone, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [])]),
  ].sort();
  const update = (value: Partial<typeof draft>) => {
    setDraft((previous) => ({ ...previous, ...value }));
    setError('');
  };
  return (
    <form
      className="schedule-timing"
      aria-label={`Timing for ${schedule.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || change.busy) return;
        try {
          const body = {
            timeZone: draft.timeZone,
            ...(schedule.kind === 'once'
              ? { runAt: scheduleRunAt(draft.date, draft.time, draft.timeZone) }
              : {
                  cron: scheduleExpression(
                    draft.frequency,
                    draft.time,
                    draft.day,
                    schedule.cron ?? undefined,
                  ),
                }),
          };
          setError('');
          void change.apply(body, `Updated ${schedule.title}.`, {
            timeZone: schedule.timeZone,
            ...(schedule.kind === 'once' ? { runAt: schedule.runAt } : { cron: schedule.cron }),
          });
        } catch (cause) {
          setError(errorMessage(cause));
        }
      }}
    >
      <div className="schedule-timing-fields">
        {schedule.kind === 'once' ? (
          <Field label="Date">
            <Input
              type="date"
              value={draft.date}
              required
              disabled={change.busy}
              onChange={(event) => update({ date: event.target.value })}
            />
          </Field>
        ) : (
          <SchedulePicker
            label="Repeat"
            value={draft.frequency}
            options={
              initial.frequency === 'custom'
                ? [...frequencies, { value: 'custom', label: 'Custom schedule' }]
                : frequencies
            }
            disabled={change.busy}
            onChange={(frequency) =>
              update({
                frequency: frequency as ScheduleFrequency,
                day: initial.frequency === frequency ? initial.day : '1',
              })
            }
          />
        )}
        {schedule.kind === 'recurring' && draft.frequency === 'weekly' && (
          <SchedulePicker
            label="Day"
            value={draft.day}
            options={[1, 2, 3, 4, 5, 6, 0].map((day) => ({
              value: String(day),
              label: scheduleWeekDays[day],
            }))}
            disabled={change.busy}
            onChange={(day) => update({ day })}
          />
        )}
        {schedule.kind === 'recurring' && draft.frequency === 'monthly' && (
          <SchedulePicker
            label="Day of month"
            value={draft.day}
            options={Array.from({ length: 31 }, (_, index) => ({
              value: String(index + 1),
              label: String(index + 1),
            }))}
            disabled={change.busy}
            onChange={(day) => update({ day })}
          />
        )}
        {(schedule.kind === 'once' || draft.frequency !== 'custom') && (
          <Field label="Time">
            <Input
              type="time"
              value={draft.time}
              required
              disabled={change.busy}
              onChange={(event) => update({ time: event.target.value })}
            />
          </Field>
        )}
        <div className="schedule-timing-field schedule-time-zone">
          <span className="field-label" id={timeZoneLabel}>
            Time zone
          </span>
          <TimeZonePicker
            value={draft.timeZone}
            zones={zones}
            disabled={change.busy}
            labelledBy={timeZoneLabel}
            onChange={(timeZone) => update({ timeZone })}
          />
        </div>
      </div>
      {schedule.kind === 'recurring' && draft.frequency === 'custom' && (
        <p className="field-hint">
          Custom timing is kept as saved. Choose a repeat option to replace it, or ask nod to adjust
          it.
        </p>
      )}
      {schedule.kind === 'recurring' && draft.frequency === 'monthly' && Number(draft.day) > 28 && (
        <p className="field-hint">Months without this day are skipped.</p>
      )}
      {error && <Notice>{error}</Notice>}
      {dirty && (
        <div className="schedule-timing-actions">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={change.busy}
            onClick={() => {
              setDraft(initial);
              setError('');
            }}
          >
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={change.busy}>
            {change.busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </form>
  );
}

function TaskScheduleForm({
  taskId,
  onClose,
  onCreated,
}: {
  taskId: string;
  onClose(): void;
  onCreated(): void;
}) {
  const format = useDateFormat();
  const [draft, setDraft] = useState<{
    title: string;
    prompt: string;
    omittedSensitive: boolean;
    hasAttachments: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const [frequency, setFrequency] = useState<ScheduleFrequency | ''>('');
  const [day, setDay] = useState('1');
  const [time, setTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(format.timeZone);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const zoneLabel = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setDraft(null);
    setError('');
    void api<NonNullable<typeof draft>>(`/api/tasks/${encodeURIComponent(taskId)}/schedule-draft`, {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]),
    })
      .then((value) => {
        if (!controller.signal.aborted) setDraft(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [taskId, attempt]);
  const valid = Boolean(
    !uncertain && draft?.title.trim() && draft.prompt.trim() && frequency && time,
  );
  async function submit() {
    if (!valid || !draft || !frequency || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    let unconfirmed = false;
    try {
      const saved = await api<Schedule>('/api/schedules', {
        method: 'POST',
        body: JSON.stringify({
          title: draft.title.trim(),
          prompt: draft.prompt.trim(),
          kind: 'recurring',
          cron: scheduleExpression(frequency, time, day),
          timeZone,
        }),
        signal: AbortSignal.timeout(10000),
      });
      pageDataCache.update<Schedule[]>('/api/schedules', (items) => [saved, ...(items ?? [])]);
      void pageDataCache.refresh('/api/schedules', true);
      if (mounted.current) {
        showToast({ id: Date.now(), text: `Scheduled ${saved.title}.` });
        onCreated();
      }
    } catch (cause) {
      unconfirmed = !(cause instanceof ApiError && cause.status >= 400 && cause.status < 500);
      if (mounted.current) {
        setUncertain(unconfirmed);
        setError(
          unconfirmed
            ? 'Could not confirm whether the schedule was saved. Check Scheduled before creating another schedule.'
            : errorMessage(cause),
        );
      }
    } finally {
      submitting.current = unconfirmed;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <form
      className="schedule-timing task-schedule-form"
      aria-label="Schedule completed task"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {draft ? (
        <>
          <p className="field-hint">Review the original requests and adapt them for future runs.</p>
          <Field label="Name">
            <Input
              value={draft.title}
              disabled={busy}
              required
              onChange={(event) => setDraft({ ...draft, title: event.target.value })}
            />
          </Field>
          <Field label="Instructions for each run">
            <textarea
              className="input"
              rows={5}
              value={draft.prompt}
              disabled={busy}
              required
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </Field>
          {draft.omittedSensitive && (
            <Notice kind="info">
              Sign-in codes and messages containing sensitive details were left out. Review the
              remaining instructions.
            </Notice>
          )}
          {draft.hasAttachments && (
            <Notice kind="info">
              Attachments from this task are not added to the schedule. Include the details each run
              needs.
            </Notice>
          )}
          <div className="schedule-timing-fields">
            <SchedulePicker
              label="Repeat"
              value={frequency}
              options={[{ value: '', label: 'Choose frequency' }, ...frequencies]}
              disabled={busy}
              onChange={(value) => {
                setFrequency(value as ScheduleFrequency);
                setDay('1');
              }}
            />
            {(frequency === 'weekly' || frequency === 'monthly') && (
              <SchedulePicker
                label={frequency === 'weekly' ? 'Day' : 'Day of month'}
                value={day}
                options={
                  frequency === 'weekly'
                    ? [1, 2, 3, 4, 5, 6, 0].map((day) => ({
                        value: String(day),
                        label: scheduleWeekDays[day],
                      }))
                    : Array.from({ length: 31 }, (_, index) => ({
                        value: String(index + 1),
                        label: String(index + 1),
                      }))
                }
                disabled={busy}
                onChange={setDay}
              />
            )}
            <Field label="Time">
              <Input
                type="time"
                value={time}
                required
                disabled={busy}
                onChange={(event) => setTime(event.target.value)}
              />
            </Field>
            <div className="schedule-timing-field schedule-time-zone">
              <span className="field-label" id={zoneLabel}>
                Time zone
              </span>
              <TimeZonePicker
                value={timeZone}
                zones={[
                  ...new Set([
                    format.timeZone,
                    'UTC',
                    ...(Intl.supportedValuesOf?.('timeZone') ?? []),
                  ]),
                ].sort()}
                disabled={busy}
                labelledBy={zoneLabel}
                onChange={setTimeZone}
              />
            </div>
          </div>
          {frequency === 'monthly' && Number(day) > 28 && (
            <p className="field-hint">Months without this day are skipped.</p>
          )}
        </>
      ) : !error ? (
        <p role="status">Loading task instructions…</p>
      ) : null}
      {error && (
        <Notice>
          {error}
          {!draft && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </Button>
          )}
        </Notice>
      )}
      <div className="schedule-timing-actions">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {uncertain && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              void pageDataCache.refresh('/api/schedules', true);
              onCreated();
            }}
          >
            View schedules
          </Button>
        )}
        {draft && (
          <Button type="submit" size="sm" disabled={busy || !valid}>
            {busy ? 'Creating…' : 'Create schedule'}
          </Button>
        )}
      </div>
    </form>
  );
}

export function ScheduleTask({ taskId, onCreated }: { taskId: string; onCreated?(): void }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <TaskScheduleForm
      key={taskId}
      taskId={taskId}
      onClose={() => setOpen(false)}
      onCreated={() => {
        setOpen(false);
        onCreated?.();
      }}
    />
  ) : (
    <div className="saved-plan-footer">
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Schedule task
      </Button>
    </div>
  );
}

export function PlanDetails({
  label,
  summary,
  children,
  actions,
}: {
  label: string;
  summary?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      {!open && summary && <p className="saved-plan-summary">{summary}</p>}
      <div className="saved-plan-details" id={id} hidden={!open}>
        {children}
      </div>
      <div className="saved-plan-footer">
        <Button
          variant="ghost"
          size="sm"
          className="saved-plan-more"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${open ? 'Hide' : 'See'} details for ${label}`}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide details' : 'See details'}
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
        {actions && <div className="saved-plan-actions">{actions}</div>}
      </div>
    </>
  );
}

export function NewPlan({ onAsk }: { onAsk(text: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Plus size={16} aria-hidden="true" />
        New schedule
      </Button>
      {open && (
        <div className="connection-menu-options menu new-plan-card">
          <AskNod subject={{ kind: 'schedule' }} onAsk={onAsk} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
