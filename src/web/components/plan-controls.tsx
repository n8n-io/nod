import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowUp, LoaderCircle, Sparkles } from 'lucide-react';
import type { Schedule } from '../../shared/contracts';
import { Button, Field, Input, Notice, Switch } from './ui';
import { SearchPicker, TimeZonePicker, type PickerOption } from './time-zone-picker';
import { api, errorMessage } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import {
  readSchedule,
  scheduleExpression,
  scheduleLocalTime,
  scheduleRunAt,
  scheduleWeekDays,
  type ScheduleFrequency,
} from '../lib/schedules';

type Subject = { title?: string };

function subjectPrefix(subject: Subject) {
  return subject.title ? `About the schedule ${JSON.stringify(subject.title)}: ` : 'New schedule: ';
}

const suggestions = {
  schedule: ['Move it to 8:00 on weekdays', 'Run it every Monday', 'Add the weather'],
  newSchedule: ['Remind me to stretch at 16:00', 'Summarize my inbox each Friday'],
};

function AskOtto({
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
  const chips = subject.title ? suggestions.schedule : suggestions.newSchedule;
  const submit = (value: string) => {
    if (!value.trim()) return;
    onAsk(`${subjectPrefix(subject)}${value.trim()}`);
  };
  const placeholder = subject.title
    ? `What should change in ${subject.title}?`
    : 'What should Otto do, and when?';
  return (
    <div className="ask-otto" role="group" aria-labelledby={`${id}-label`}>
      <span className="sr-only" id={`${id}-label`}>
        Ask Otto {subject.title ? `about ${subject.title}` : 'for a new schedule'}
      </span>
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
        <Button type="submit" size="icon" aria-label="Send to Otto" disabled={!text.trim()}>
          <ArrowUp size={16} />
        </Button>
      </form>
      <div className="ask-otto-chips">
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

function useDirectChange(id: string) {
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

function pauseNote(pausing: boolean, title: string) {
  return pausing
    ? `Paused ${title}. Otto will not run it until you resume it.`
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
  return change.busy ? <LoaderCircle size={16} className="spin" aria-label="Saving" /> : null;
}

function ScheduleControls({ schedule, canPause }: { schedule: Schedule; canPause: boolean }) {
  const change = useDirectChange(schedule.id);
  return (
    <div className="schedule-controls">
      <div className="schedule-control-status">
        {canPause && (
          <Toggle
            label={`${schedule.title} active`}
            on={schedule.enabled}
            text={schedule.enabled ? 'Active' : 'Paused'}
            disabled={change.busy}
            onChange={() =>
              void change.apply(
                { enabled: !schedule.enabled },
                pauseNote(schedule.enabled, schedule.title),
                { enabled: schedule.enabled },
              )
            }
          />
        )}
        <Note change={change} />
      </div>
      <ScheduleTiming
        key={`${schedule.kind}:${schedule.cron}:${schedule.runAt}:${schedule.timeZone}`}
        schedule={schedule}
        change={change}
      />
    </div>
  );
}

function ScheduleTiming({
  schedule,
  change,
}: {
  schedule: Schedule;
  change: ReturnType<typeof useDirectChange>;
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
          Custom timing is kept as saved. Choose a repeat option to replace it, or ask Otto to
          adjust it.
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

export function PlanFooter({
  item,
  meta,
  remove,
  canPause,
  onAsk,
}: {
  item: Schedule;
  meta: ReactNode;
  remove: ReactNode;
  canPause: boolean;
  onAsk(text: string): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ScheduleControls schedule={item} canPause={canPause} />
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
            <Sparkles size={16} aria-hidden="true" />
            Ask Otto
          </Button>
          {remove}
        </div>
      </div>
      {open && (
        <AskOtto subject={{ title: item.title }} onAsk={onAsk} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

export function NewPlan({ onAsk }: { onAsk(text: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Sparkles size={16} aria-hidden="true" />
        New schedule
      </Button>
      {open && (
        <div className="connection-menu-options menu new-plan-card">
          <AskOtto subject={{}} onAsk={onAsk} onClose={() => setOpen(false)} />
        </div>
      )}
    </>
  );
}
