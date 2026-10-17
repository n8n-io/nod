import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarClock, MessageCircle, ScanSearch, Undo2, Zap } from 'lucide-react';
import type { TrustEntry, TrustPage, TrustSource, TrustView } from '../../shared/trust';
import type { VaultActivity, VaultActivityEntry } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { savePreferences } from '../lib/preferences';
import {
  formatDayLabel,
  formatNumber,
  formatTime,
  useDateFormat,
  type DateFormat,
} from '../lib/date-format';
import { Button, Input, Notice } from './ui';
import { VaultUse } from './vault-activity';

const day = 86_400_000;
const taskChoices = [2, 5, 20, null] as const;
const sources: Record<TrustSource, { icon: typeof Zap; label: string }> = {
  chat: { icon: MessageCircle, label: '' },
  task: { icon: MessageCircle, label: 'Task' },
  schedule: { icon: CalendarClock, label: 'Schedule' },
  event: { icon: Zap, label: '' },
  check: { icon: ScanSearch, label: 'Activity check' },
  resume: { icon: Undo2, label: 'Approved action' },
};

function money(value: number) {
  if (value > 0 && value < 0.01) return '<$0.01';
  return formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(value) && value >= 1 ? 0 : 2,
  });
}

function date(ms: number, format: DateFormat) {
  return new Date(ms).toLocaleDateString(format.locale, {
    day: 'numeric',
    month: 'long',
    timeZone: format.timeZone,
  });
}

function times(count: number) {
  return count === 1 ? 'once' : count === 2 ? 'twice' : `${formatNumber(count)} times`;
}

function saveLimits(body: { monthlyUsd?: number | null; taskUsd?: number | null }) {
  return api('/api/trust/limit', { method: 'PUT', body: JSON.stringify(body) });
}

function Value({
  text,
  label,
  children,
}: {
  text: ReactNode;
  label: string;
  children(close: () => void): ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="trust-value">{text}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="trust-pop" align="start" sideOffset={8} aria-label={label}>
          {children(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Chart({ month, limit }: { month: TrustView['month']; limit: number | undefined }) {
  const top = Math.max(month.forecastUsd, month.spentUsd, limit ?? 0) * 1.1 || 1;
  const x = (days: number) => (days / month.days) * 600;
  const y = (usd: number) => 116 - (usd / top) * 108;
  let total = 0;
  const points = [`${x(0)},${y(0)}`];
  month.daily.forEach((value, index) => {
    total += value;
    points.push(`${x(Math.min(index + 1, month.elapsedDays))},${y(total)}`);
  });
  const now = `${x(month.elapsedDays)},${y(month.spentUsd)}`;
  return (
    <svg
      className="trust-chart"
      viewBox="0 0 600 120"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {limit !== undefined && (
        <line className="trust-chart-limit" x1="0" x2="600" y1={y(limit)} y2={y(limit)} />
      )}
      <polygon
        className="trust-chart-area"
        points={`${points.join(' ')} ${x(month.elapsedDays)},116`}
      />
      <polyline className="trust-chart-spent" points={points.join(' ')} />
      <polyline
        className="trust-chart-forecast"
        points={`${now} ${x(month.days)},${y(month.forecastUsd)}`}
      />
    </svg>
  );
}

function Month({ view }: { view: TrustView }) {
  const format = useDateFormat();
  const { month, limit } = view;
  const pace = month.spentUsd / Math.max(month.elapsedDays, 1);
  const crossing =
    limit && !limit.reached && month.forecastUsd > limit.monthlyUsd && pace > 0
      ? date(
          Date.parse(month.start) +
            (month.elapsedDays + (limit.monthlyUsd - month.spentUsd) / pace) * day,
          format,
        )
      : undefined;
  return (
    <div className="trust-month">
      {month.spentUsd > 0 && (
        <span className={crossing ? 'is-over' : undefined}>
          On track for {money(month.forecastUsd)}
          {crossing && `, reaching your limit around ${crossing}`}
        </span>
      )}
      <Chart month={month} limit={limit?.monthlyUsd} />
      {month.unpriced && <small>Some usage has no price, so it isn’t counted here.</small>}
    </div>
  );
}

function MonthlyLimit({
  view,
  resets,
  onSaved,
}: {
  view: TrustView;
  resets: string;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState(String(view.limit?.monthlyUsd ?? ''));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(monthlyUsd: number | null) {
    setBusy(true);
    setError('');
    try {
      await saveLimits({ monthlyUsd });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(draft);
    if (Number.isFinite(value) && value >= 1) void save(value);
    else setError('Enter a limit of at least $1.');
  }
  return (
    <form className="trust-limit-form" onSubmit={submit}>
      <label className="trust-limit-input">
        <span aria-hidden="true">$</span>
        <Input
          type="number"
          inputMode="decimal"
          min={1}
          step={0.01}
          value={draft}
          autoFocus
          aria-label="Monthly limit in US dollars"
          onChange={(event) => setDraft(event.target.value)}
        />
      </label>
      <Button size="sm" type="submit" disabled={busy || !draft}>
        Save
      </Button>
      {view.limit && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => void save(null)}
        >
          Remove
        </Button>
      )}
      <small>At the limit, new requests pause until {resets}.</small>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}

function TaskLimit({ view, onSaved }: { view: TrustView; onSaved(): void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(taskUsd: number | null) {
    setBusy(true);
    setError('');
    try {
      await saveLimits({ taskUsd });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <div className="trust-task-limit">
      <div className="vault-seg" role="group" aria-label="Check in when a task passes">
        {taskChoices.map((value) => (
          <button
            key={String(value)}
            type="button"
            aria-pressed={view.taskUsd === value}
            disabled={busy}
            onClick={() => void save(value)}
          >
            {value === null ? 'No limit' : money(value)}
          </button>
        ))}
      </div>
      <small>Otto asks before a task spends more.</small>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function StandingInstruction({ rule, onSaved }: { rule: string; onSaved(): void }) {
  const [draft, setDraft] = useState(rule);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(notificationRule: string) {
    setBusy(true);
    setError('');
    try {
      await savePreferences({ notificationRule });
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void save(draft.trim());
  }
  return (
    <form className="trust-rule-form" onSubmit={submit}>
      <textarea
        className="input"
        rows={4}
        maxLength={4000}
        value={draft}
        autoFocus
        aria-label="Standing instruction"
        placeholder="Whenever Ana sends an invoice, forward it to accounting@acme.com."
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="trust-rule-actions">
        <Button size="sm" type="submit" disabled={busy || draft.trim() === rule}>
          Save
        </Button>
        {rule && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void save('')}
          >
            Stop
          </Button>
        )}
      </div>
      <small>Otto reads and drafts on its own, and does only what this says.</small>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}

function Sentence({
  view,
  vault,
  rule,
  onSaved,
}: {
  view: TrustView;
  vault: VaultActivity;
  rule: string;
  onSaved(): void;
}) {
  const format = useDateFormat();
  const { month, limit, taskUsd, week } = view;
  const name = new Date(month.start).toLocaleDateString(format.locale, {
    month: 'long',
    timeZone: format.timeZone,
  });
  const resets = date(Date.parse(month.start) + month.days * day + day / 2, format);
  const limitForm = (close: () => void) => (
    <MonthlyLimit
      view={view}
      resets={resets}
      onSaved={() => {
        close();
        onSaved();
      }}
    />
  );
  const used = [
    vault.week.signIns > 0 && (
      <>
        your logins <b>{times(vault.week.signIns)}</b>
      </>
    ),
    vault.week.payments > 0 && (
      <>
        your cards <b>{times(vault.week.payments)}</b>
      </>
    ),
  ].filter(Boolean);
  const done = [
    week.things > 0 && (
      <>
        did{' '}
        <b>
          {formatNumber(week.things)} {week.things === 1 ? 'thing' : 'things'}
        </b>
      </>
    ),
    used.length > 0 && (
      <>
        used {used[0]}
        {used[1] && <> and {used[1]}</>}
      </>
    ),
  ].filter(Boolean);
  return (
    <>
      <p className="statement-summary trust-sentence">
        {name}:{' '}
        <Value text={money(month.spentUsd)} label={`Spending in ${name}`}>
          {() => <Month view={view} />}
        </Value>
        {limit ? (
          <>
            {' '}
            of{' '}
            <Value text={money(limit.monthlyUsd)} label="Monthly limit">
              {limitForm}
            </Value>
          </>
        ) : (
          <>
            ,{' '}
            <Value text="no monthly limit" label="Monthly limit">
              {limitForm}
            </Value>
          </>
        )}
        . {taskUsd === null ? 'Tasks ' : 'Tasks check in at '}
        <Value text={taskUsd === null ? 'never check in' : money(taskUsd)} label="Task check-in">
          {(close) => (
            <TaskLimit
              view={view}
              onSaved={() => {
                close();
                onSaved();
              }}
            />
          )}
        </Value>
        .
        <br />
        {done.length ? (
          <>
            This week Otto{' '}
            {done.map((part, index) => (
              <span key={index}>
                {index ? (used.length > 1 ? ', ' : ' and ') : ''}
                {part}
              </span>
            ))}
            .
          </>
        ) : (
          'Nothing yet this week.'
        )}
        <br />
        On its own, Otto{' '}
        <Value
          text={rule ? 'follows your instruction' : 'watches nothing'}
          label="Standing instruction"
        >
          {(close) => <StandingInstruction rule={rule} onSaved={close} />}
        </Value>
        {rule ? <>: “{rule}”</> : '.'}
      </p>
      {limit?.reached && (
        <Notice kind="info">
          Limit reached. New chat and background requests pause until {resets}. Running turns can
          finish. Raise your limit to resume.
        </Notice>
      )}
    </>
  );
}

function TrustRow({ entry }: { entry: TrustEntry }) {
  const format = useDateFormat();
  const { icon: Icon, label } = sources[entry.source];
  const did = [...new Set(entry.actions)].join(', ');
  return (
    <div className="vault-use">
      <span className="vault-glyph" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="vault-use-text">
        <b>{entry.title}</b>
        <span className={entry.error ? 'is-error' : undefined}>
          {[formatTime(entry.at, format), label].filter(Boolean).join(' · ')}
          {entry.error ? ` · ${entry.error}` : did ? ` · ${did}` : ''}
        </span>
      </span>
      <span className="trust-row-cost" title={entry.unpriced ? 'Included in your plan' : undefined}>
        {entry.costUsd !== null ? money(entry.costUsd) : '—'}
      </span>
    </div>
  );
}

type Stream<T> = { entries: T[]; next: { at: string; id: string } | null };

function frontier<T extends { at: string }>(stream: Stream<T>) {
  return stream.next ? Date.parse(stream.entries.at(-1)!.at) : -Infinity;
}

function Statement({
  view,
  vault,
  opener,
}: {
  view: TrustView;
  vault: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
}) {
  const format = useDateFormat();
  const [trust, setTrust] = useState<Stream<TrustEntry>>(view);
  const [uses, setUses] = useState<Stream<VaultActivityEntry>>({
    entries: vault.entries,
    next: vault.next ?? null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    setTrust(view);
    setUses({ entries: vault.entries, next: vault.next ?? null });
    setLoading(false);
    setError('');
    return () => request.current?.abort();
  }, [view, vault]);
  const cutoff = Math.max(frontier(trust), frontier(uses));
  const rows: Array<{ at: string; key: string; trust?: TrustEntry; use?: VaultActivityEntry }> = [
    ...trust.entries.map((entry) => ({ at: entry.at, key: `t${entry.id}`, trust: entry })),
    ...uses.entries.map((entry) => ({ at: entry.at, key: `v${entry.id}`, use: entry })),
  ]
    .filter((row) => Date.parse(row.at) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  async function load() {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    const query = (next: { at: string; id: string }) =>
      `at=${encodeURIComponent(next.at)}&id=${next.id}`;
    try {
      const [olderTrust, olderUses] = await Promise.all([
        frontier(trust) === cutoff
          ? api<TrustPage>(`/api/trust/entries?${query(trust.next!)}`, {
              signal: controller.signal,
            })
          : undefined,
        frontier(uses) === cutoff
          ? api<VaultActivity>(`/api/vault/activity?${query(uses.next!)}`, {
              signal: controller.signal,
            })
          : undefined,
      ]);
      if (controller.signal.aborted) return;
      if (olderTrust)
        setTrust((current) => ({
          entries: [...current.entries, ...olderTrust.entries],
          next: olderTrust.next,
        }));
      if (olderUses)
        setUses((current) => ({
          entries: [...current.entries, ...olderUses.entries],
          next: olderUses.next ?? null,
        }));
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  if (!rows.length && cutoff === -Infinity)
    return <p className="statement-empty">What Otto does and spends will show up here.</p>;
  const days = new Map<string, typeof rows>();
  for (const row of rows) {
    const label = formatDayLabel(row.at, format);
    days.set(label, [...(days.get(label) ?? []), row]);
  }
  return (
    <section className="vault-days" aria-label="Activity">
      {[...days].map(([label, items]) => (
        <div key={label} className="vault-day">
          <h4>{label}</h4>
          <ul>
            {items.map((row) => (
              <li key={row.key}>
                {row.use ? (
                  <VaultUse entry={row.use} open={opener(row.use)} />
                ) : (
                  <TrustRow entry={row.trust!} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error && <Notice>{error}</Notice>}
      {cutoff > -Infinity && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          Show earlier
        </Button>
      )}
    </section>
  );
}

export function TrustActivity({
  view,
  vault,
  rule,
  opener,
  onSaved,
}: {
  view: TrustView;
  vault: VaultActivity;
  rule: string;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
  onSaved(): void;
}) {
  return (
    <div className="trust-activity">
      <Sentence view={view} vault={vault} rule={rule} onSaved={onSaved} />
      <Statement view={view} vault={vault} opener={opener} />
    </div>
  );
}
