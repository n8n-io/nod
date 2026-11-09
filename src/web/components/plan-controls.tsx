import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown, LoaderCircle, Pencil, Plus } from './icons';
import type { Schedule } from '../../shared/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Notice,
  Switch,
} from './ui';
import { SearchPicker, type PickerOption } from './search-picker';
import { TimeZonePicker } from './time-zone-picker';
import { api, ApiError, errorMessage, requestAccountVersion } from '../lib/api';
import { pageDataCache } from '../lib/page-data-cache';
import {
  reconcileSchedule,
  scheduleMatchesPatch,
  schedulesPath,
  uncertainScheduleMutation,
} from '../lib/schedule-reconciliation';
import { formatDateTime, useDateFormat } from '../lib/date-format';
import {
  readSchedule,
  scheduleExpression,
  scheduleLocalTime,
  scheduleRunAt,
  scheduleWeekDays,
  type ScheduleFrequency,
} from '../lib/schedules';

async function patchSchedule(id: string, body: Record<string, unknown>) {
  const saved = await api<Schedule>(`${schedulesPath}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });
  pageDataCache.update<Schedule[]>(schedulesPath, (items) =>
    items ? items.map((entry) => (entry.id === id ? { ...entry, ...saved } : entry)) : items,
  );
  void pageDataCache.refresh(schedulesPath, true);
  return saved;
}

type Toast = { id: number; text: string; kind?: 'info' | 'error'; undo?(): void };
let toast: Toast | null = null;
const toastListeners = new Set<() => void>();
function showToast(value: Toast | null) {
  toast = value;
  for (const listener of toastListeners) listener();
}

export function PlanToast() {
  const [held, setHeld] = useState(false);
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible');
  useEffect(() => {
    const change = () => setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  const value = useSyncExternalStore(
    (listener) => {
      toastListeners.add(listener);
      return () => toastListeners.delete(listener);
    },
    () => toast,
    () => null,
  );
  useEffect(() => {
    if (!value || held || !visible) return;
    const timer = setTimeout(() => {
      if (toast?.id === value.id) showToast(null);
    }, 6000);
    return () => clearTimeout(timer);
  }, [value, held, visible]);
  useEffect(() => () => showToast(null), []);
  return (
    <div
      className="plan-toast"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
    >
      {value && (
        <Notice kind={value.kind ?? 'success'}>
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
  const [uncertain, setUncertain] = useState(false);
  const [retryable, setRetryable] = useState(false);
  const working = useRef(false);
  const pending = useRef<{
    body: Record<string, unknown>;
    note: string;
    undo?: Record<string, unknown>;
    accountVersion: number;
  } | null>(null);
  const unknownText =
    'The change may still finish. Check schedule status before changing it again.';
  const retryText =
    'The change may still finish. The schedule is unchanged. Check again or try again.';
  function complete(saved: Schedule, note: string, undo?: Record<string, unknown>) {
    pending.current = null;
    setUncertain(false);
    setRetryable(false);
    showToast({
      id: Date.now(),
      text: note,
      ...(undo
        ? {
            undo: () =>
              void apply(
                { ...undo, expectedRevision: saved.revision },
                `Undid the change to ${saved.title}.`,
              ),
          }
        : {}),
    });
  }
  async function settle(change: NonNullable<typeof pending.current>, checked = false) {
    const result = await reconcileSchedule(
      id,
      (schedule) => scheduleMatchesPatch(schedule, change.body),
      change.accountVersion,
    );
    if (result.status === 'aborted') return 'The schedule status could not be checked.';
    if (result.schedules) pageDataCache.update<Schedule[]>(schedulesPath, () => result.schedules!);
    if (result.status === 'confirmed') {
      const saved = result.schedules.find((schedule) => schedule.id === id)!;
      complete(saved, change.note, change.undo);
      void pageDataCache.refresh(schedulesPath, true);
      return;
    }
    const current = result.schedules?.find((schedule) => schedule.id === id);
    const expectedRevision = change.body.expectedRevision;
    if (current && typeof expectedRevision === 'number' && current.revision > expectedRevision) {
      const conflict = 'The schedule changed. Review its current settings before trying again.';
      pending.current = null;
      setUncertain(false);
      setRetryable(false);
      showToast({ id: Date.now(), text: conflict, kind: 'info' });
      return conflict;
    }
    const canRetry = checked && current?.revision === expectedRevision;
    pending.current = change;
    setUncertain(true);
    setRetryable(canRetry);
    showToast({ id: Date.now(), text: canRetry ? retryText : unknownText, kind: 'info' });
    return canRetry ? retryText : unknownText;
  }
  async function apply(
    body: Record<string, unknown>,
    note: string,
    undo?: Record<string, unknown>,
    reconcileConflict = false,
  ) {
    if (working.current || pending.current) return unknownText;
    working.current = true;
    setBusy(true);
    const change = { body, note, undo, accountVersion: requestAccountVersion() };
    try {
      const saved = await patchSchedule(id, body);
      complete(saved, note, undo);
    } catch (cause) {
      if (uncertainScheduleMutation(cause)) return await settle(change);
      if (cause instanceof ApiError && cause.status === 409 && reconcileConflict)
        return await settle(change);
      if (cause instanceof ApiError && cause.status === 409)
        void pageDataCache.refresh(schedulesPath, true);
      const error = errorMessage(cause);
      showToast({ id: Date.now(), text: error, kind: 'error' });
      return error;
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function check() {
    const change = pending.current;
    if (!change || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      return await settle(change, true);
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  async function retry() {
    const change = pending.current;
    if (!change || !retryable || working.current) return unknownText;
    pending.current = null;
    setUncertain(false);
    setRetryable(false);
    return apply(change.body, change.note, change.undo, true);
  }
  return { busy, uncertain, retryable, apply, check, retry };
}

type ScheduleChange = ReturnType<typeof useDirectChange>;

function pauseNote(pausing: boolean, title: string) {
  return pausing
    ? `Paused ${title}. Nod will not run it until you resume it.`
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
      {change.uncertain && (
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={change.busy}
            onClick={() => void change.check()}
          >
            Check status
          </Button>
          {change.retryable && (
            <Button
              variant="outline"
              size="sm"
              disabled={change.busy}
              onClick={() => void change.retry()}
            >
              Try again
            </Button>
          )}
        </>
      )}
      <Switch
        checked={schedule.enabled}
        aria-label={`${schedule.title} active`}
        disabled={change.busy || change.uncertain}
        onCheckedChange={() =>
          void change.apply(
            { enabled: !schedule.enabled, expectedRevision: schedule.revision },
            pauseNote(schedule.enabled, schedule.title),
            { enabled: schedule.enabled },
          )
        }
      />
    </>
  );
}

export function ScheduleEditor({
  schedule,
  change,
}: {
  schedule: Schedule;
  change: ScheduleChange;
}) {
  const [editing, setEditing] = useState<Schedule | null>(null);
  return (
    <Dialog
      open={Boolean(editing)}
      onOpenChange={(open) => {
        if (!change.busy) setEditing(open ? { ...schedule } : null);
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={change.busy}
          aria-label={`Edit schedule ${schedule.title}`}
        >
          <Pencil size={16} aria-hidden="true" />
          Edit schedule
        </Button>
      </DialogTrigger>
      {editing && (
        <DialogContent
          className="schedule-editor-dialog"
          aria-describedby={undefined}
          aria-busy={change.busy}
        >
          <DialogTitle>Edit schedule</DialogTitle>
          <ScheduleEditorForm schedule={editing} change={change} onClose={() => setEditing(null)} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ScheduleEditorForm({
  schedule,
  change,
  onClose,
}: {
  schedule: Schedule;
  change: ScheduleChange;
  onClose(): void;
}) {
  const initial = {
    title: schedule.title,
    prompt: schedule.prompt,
    ...readSchedule(schedule.cron ?? ''),
    ...(schedule.kind === 'once' && schedule.runAt
      ? scheduleLocalTime(schedule.runAt, schedule.timeZone)
      : { date: '' }),
    timeZone: schedule.timeZone,
  };
  const dateFormat = useDateFormat();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const timeZoneLabel = useId();
  const [nextRun, setNextRun] = useState<string | null>(schedule.nextRun);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const timingDirty =
    draft.frequency !== initial.frequency ||
    draft.time !== initial.time ||
    draft.day !== initial.day ||
    draft.date !== initial.date ||
    draft.timeZone !== initial.timeZone;
  const dirty =
    timingDirty || draft.title.trim() !== schedule.title || draft.prompt.trim() !== schedule.prompt;
  const locked = change.busy || change.uncertain;
  const timing = () => ({
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
  });
  useEffect(() => {
    setPreviewError('');
    if (!timingDirty) {
      setNextRun(schedule.nextRun);
      setPreviewing(false);
      return;
    }
    const controller = new AbortController();
    setNextRun(null);
    setPreviewing(true);
    const timer = setTimeout(() => {
      try {
        void api<{ nextRun: string | null }>(`/api/schedules/${schedule.id}/preview`, {
          method: 'POST',
          body: JSON.stringify(timing()),
          signal: controller.signal,
        })
          .then((result) => {
            if (!controller.signal.aborted) {
              setNextRun(result.nextRun);
              setPreviewing(false);
            }
          })
          .catch((cause) => {
            if (!controller.signal.aborted) {
              setPreviewError(errorMessage(cause));
              setPreviewing(false);
            }
          });
      } catch (cause) {
        setPreviewError(errorMessage(cause));
        setPreviewing(false);
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft.frequency, draft.time, draft.day, draft.date, draft.timeZone, timingDirty, schedule]);
  const zones = [
    ...new Set([schedule.timeZone, 'UTC', ...(Intl.supportedValuesOf?.('timeZone') ?? [])]),
  ].sort();
  const update = (value: Partial<typeof draft>) => {
    setDraft((previous) => ({ ...previous, ...value }));
    setError('');
  };
  return (
    <form
      className="schedule-editor-form"
      aria-label={`Edit ${schedule.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!dirty || locked || !draft.title.trim() || !draft.prompt.trim()) return;
        try {
          const values = {
            title: draft.title.trim(),
            prompt: draft.prompt.trim(),
            ...(timingDirty ? timing() : {}),
          };
          const body = Object.fromEntries(
            Object.entries(values).filter(
              ([key, value]) => value !== schedule[key as keyof Schedule],
            ),
          );
          const undo = Object.fromEntries(
            Object.keys(body).map((key) => [key, schedule[key as keyof Schedule]]),
          );
          setError('');
          void change
            .apply(
              { ...body, expectedRevision: schedule.revision },
              `Updated ${draft.title.trim()}.`,
              undo,
            )
            .then((error) => {
              if (error) setError(error);
              else onClose();
            });
        } catch (cause) {
          setError(errorMessage(cause));
        }
      }}
    >
      <div className="schedule-editor-fields">
        <Field label="Name">
          <Input
            value={draft.title}
            maxLength={160}
            required
            disabled={locked}
            onChange={(event) => update({ title: event.target.value })}
          />
        </Field>
        <Field label="What Nod should do">
          <textarea
            className="input"
            rows={4}
            value={draft.prompt}
            required
            disabled={locked}
            onChange={(event) => update({ prompt: event.target.value })}
          />
        </Field>
        <div className="schedule-editor-timing" role="group" aria-label="Timing">
          <div
            className="schedule-timing-fields"
            data-columns={
              schedule.kind === 'recurring' && ['weekly', 'monthly'].includes(draft.frequency)
                ? 3
                : 2
            }
            data-custom={
              (schedule.kind === 'recurring' && draft.frequency === 'custom') || undefined
            }
          >
            {schedule.kind === 'once' ? (
              <Field label="Date">
                <Input
                  type="date"
                  value={draft.date}
                  required
                  disabled={locked}
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
                disabled={locked}
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
                disabled={locked}
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
                disabled={locked}
                onChange={(day) => update({ day })}
              />
            )}
            {(schedule.kind === 'once' || draft.frequency !== 'custom') && (
              <Field label="Time">
                <Input
                  type="time"
                  value={draft.time}
                  required
                  disabled={locked}
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
                disabled={locked}
                labelledBy={timeZoneLabel}
                onChange={(timeZone) => update({ timeZone })}
              />
            </div>
          </div>
          {schedule.kind === 'recurring' && draft.frequency === 'custom' && (
            <p className="field-hint">
              Custom timing is kept as saved. Choose a repeat option to replace it, or ask Nod to
              adjust it.
            </p>
          )}
          {schedule.kind === 'recurring' &&
            draft.frequency === 'monthly' &&
            Number(draft.day) > 28 && (
              <p className="field-hint">Months without this day are skipped.</p>
            )}
          <div
            className="schedule-editor-status"
            role="status"
            data-error={Boolean(previewError) || undefined}
          >
            {previewError ||
              (nextRun ? (
                <>
                  {schedule.enabled ? 'Next run:' : 'Next run if enabled:'}{' '}
                  {formatDateTime(nextRun, dateFormat, { timeZone: draft.timeZone })} (
                  {draft.timeZone})
                </>
              ) : previewing ? (
                'Checking next run…'
              ) : timingDirty ? (
                'No upcoming run for this timing.'
              ) : null)}
          </div>
        </div>
        {(error || change.uncertain) && (
          <Notice>
            {error || 'The schedule status is still unconfirmed.'}
            {change.uncertain && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={change.busy}
                  onClick={() =>
                    void change.check().then((result) => {
                      if (result) setError(result);
                      else onClose();
                    })
                  }
                >
                  Check status
                </Button>
                {change.retryable && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={change.busy}
                    onClick={() =>
                      void change.retry().then((result) => {
                        if (result) setError(result);
                        else onClose();
                      })
                    }
                  >
                    Try again
                  </Button>
                )}
              </>
            )}
          </Notice>
        )}
      </div>
      <div className="schedule-timing-actions">
        <Button type="button" variant="ghost" disabled={change.busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="submit"
          disabled={!dirty || locked || !draft.title.trim() || !draft.prompt.trim()}
        >
          {change.busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
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
  onOpenChange,
}: {
  label: string;
  summary?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  onOpenChange?(open: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      {!open && summary && <p className="saved-plan-summary">{summary}</p>}
      <div
        className="saved-plan-details"
        id={id}
        data-open={open}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="saved-plan-details-content">{children}</div>
      </div>
      <div className="saved-plan-footer">
        <Button
          variant="ghost"
          size="sm"
          className="saved-plan-more"
          aria-expanded={open}
          aria-controls={id}
          aria-label={`${open ? 'Hide' : 'See'} details for ${label}`}
          onClick={() => {
            setOpen(!open);
            onOpenChange?.(!open);
          }}
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
  return (
    <Button
      size="sm"
      onClick={() =>
        onAsk(
          'Help me create a schedule. Ask me one question at a time to work out what to do and when.',
        )
      }
    >
      <Plus size={16} aria-hidden="true" />
      New schedule
    </Button>
  );
}
