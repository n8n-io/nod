import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { CalendarClock, MessageCircle, ScanSearch, Undo2, Zap } from '../components/icons';
import type { TrustEntry, TrustPage, TrustSource, TrustView } from '../../shared/trust';
import type { AccountPreferences } from '../../shared/account';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultListEntry,
  VaultSession,
} from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/navigation';
import { savePreferences } from '../lib/preferences';
import {
  formatDayLabel,
  formatNumber,
  formatTime,
  useDateFormat,
  type DateFormat,
} from '../lib/date-format';
import { PageTitle } from '../components/page-title';
import { Button, Input, Loading, Notice } from '../components/ui';
import { VaultUse } from '../components/vault-activity';
import { becauseText } from '../lib/trust-because';
import { money } from '../lib/money';
import { vaultItems } from './vault';

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
      <Popover.Trigger className="usage-value">{text}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="usage-pop" align="start" sideOffset={8} aria-label={label}>
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
      className="usage-chart"
      viewBox="0 0 600 120"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {limit !== undefined && (
        <line className="usage-chart-limit" x1="0" x2="600" y1={y(limit)} y2={y(limit)} />
      )}
      <polygon
        className="usage-chart-area"
        points={`${points.join(' ')} ${x(month.elapsedDays)},116`}
      />
      <polyline className="usage-chart-spent" points={points.join(' ')} />
      <polyline
        className="usage-chart-forecast"
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
    <div className="usage-month">
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
    <form className="usage-limit-form" onSubmit={submit}>
      <label className="usage-limit-input">
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
    <div className="usage-task-limit">
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
      <small>nod asks before a task spends more.</small>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function RuleEditor({
  field,
  value,
  label,
  placeholder,
  hint,
  remove,
  onSaved,
}: {
  field: 'notificationRule' | 'rules';
  value: string;
  label: string;
  placeholder: string;
  hint: string;
  remove: string;
  onSaved(): void;
}) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(text: string) {
    setBusy(true);
    setError('');
    try {
      await savePreferences({ [field]: text });
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
    <form className="usage-rule-form" onSubmit={submit}>
      <textarea
        className="input"
        rows={4}
        maxLength={4000}
        value={draft}
        autoFocus
        aria-label={label}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="usage-rule-actions">
        <Button size="sm" type="submit" disabled={busy || draft.trim() === value}>
          Save
        </Button>
        {value && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void save('')}
          >
            {remove}
          </Button>
        )}
      </div>
      <small>{hint}</small>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}

function Sentence({
  view,
  vault,
  rule,
  rules,
  onSaved,
}: {
  view: TrustView;
  vault: VaultActivity;
  rule: string;
  rules: string;
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
      <p className="statement-summary usage-sentence">
        nod spent{' '}
        <Value text={money(month.spentUsd)} label={`Spending in ${name}`}>
          {() => <Month view={view} />}
        </Value>
        {limit ? (
          <>
            {' '}
            of{' '}
            <Value text={money(limit.monthlyUsd)} label="Monthly limit">
              {limitForm}
            </Value>{' '}
            in {name}
          </>
        ) : (
          <>
            {' '}
            in {name}, with{' '}
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
            This week nod{' '}
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
        On its own, nod{' '}
        <Value
          text={rule ? 'follows your instruction' : 'watches nothing'}
          label="Standing instruction"
        >
          {(close) => (
            <RuleEditor
              field="notificationRule"
              value={rule}
              label="Standing instruction"
              placeholder="Whenever Ana sends an invoice, forward it to accounting@acme.com."
              hint="nod reads and drafts on its own, and does only what this says."
              remove="Stop"
              onSaved={() => {
                close();
                onSaved();
              }}
            />
          )}
        </Value>
        {rule ? <>: “{rule}”</> : '.'}
        <br />
        {rules ? 'Everywhere, nod keeps ' : 'You haven’t set any '}
        <Value text={rules ? 'your rules' : 'rules'} label="Rules">
          {(close) => (
            <RuleEditor
              field="rules"
              value={rules}
              label="Rules"
              placeholder="Always ask before sending email outside my company."
              hint="Say what nod may do without asking, or must ask you about first."
              remove="Clear"
              onSaved={() => {
                close();
                onSaved();
              }}
            />
          )}
        </Value>
        {rules ? <>: “{rules}”</> : '.'}
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
  const did = [...new Set(entry.actions.map((action) => action.label))].join(', ');
  const explained = entry.actions.filter((action) => action.because);
  const reasons = [
    ...new Set(
      explained.map((action) =>
        new Set(explained.map((item) => item.label)).size > 1
          ? `${action.label} · ${becauseText(action.because!)}`
          : becauseText(action.because!),
      ),
    ),
  ];
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
        {reasons.map((reason) => (
          <small key={reason} className="usage-because" title={reason}>
            {reason}
          </small>
        ))}
      </span>
      {entry.costUsd !== null && <span className="usage-row-cost">{money(entry.costUsd)}</span>}
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
  session,
}: {
  view: TrustPage;
  vault: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
  session?: string;
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
      `at=${encodeURIComponent(next.at)}&id=${next.id}${session ? `&session=${session}` : ''}`;
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
    return <p className="statement-empty">What nod does and spends will show up here.</p>;
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

function SessionStatement({
  session,
  vault,
  opener,
  onClear,
}: {
  session: string;
  vault: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
  onClear(): void;
}) {
  const page = usePageData<TrustPage>(`/api/trust/entries?session=${session}`);
  const none = useMemo(() => ({ ...vault, entries: [], next: undefined }), [vault]);
  if (page.error) return <Notice>{page.error}</Notice>;
  if (!page.data) return <Loading label="Opening usage…" />;
  return (
    <>
      <p className="usage-filter">
        One task or run.{' '}
        <button type="button" onClick={onClear}>
          Show all
        </button>
      </p>
      <Statement view={page.data} vault={none} opener={opener} session={session} />
    </>
  );
}

function sessionFilter() {
  const match = /^\?session=([0-9a-f-]{36})$/.exec(
    window.location.pathname === '/usage' ? window.location.search : '',
  );
  return match?.[1];
}

export function Usage({ hidden = false }: { hidden?: boolean }) {
  const [session, setSession] = useState(sessionFilter);
  useEffect(() => {
    if (!hidden) setSession(sessionFilter());
  }, [hidden]);
  const trust = usePageData<TrustView>('/api/trust');
  const vault = usePageData<VaultActivity>('/api/vault/activity');
  const preferences = usePageData<AccountPreferences>('/api/preferences');
  const entries = usePageData<VaultListEntry[]>('/api/vault');
  const sessions = usePageData<VaultSession[]>('/api/vault/sessions');
  const items = vaultItems(entries.data ?? [], sessions.data ?? []);
  function opener(entry: VaultActivityEntry) {
    const item =
      items.find((value) => value.id === entry.itemId) ??
      (!entry.itemId &&
        items.find((value) => value.kind === 'session' && value.origin === entry.origin));
    return item
      ? () => {
          window.history.replaceState({ usage: entry.id }, '');
          navigate(`/vault?item=${encodeURIComponent(item.id)}`);
        }
      : undefined;
  }
  const ready = Boolean(trust.data && vault.data && preferences.data && entries.data);
  useEffect(() => {
    const id = (window.history.state as { usage?: string } | null)?.usage;
    if (hidden || !ready || !id) return;
    window.history.replaceState(null, '');
    [...document.querySelectorAll<HTMLElement>('[data-vault-activity]')]
      .find((row) => row.dataset.vaultActivity === id)
      ?.focus();
  }, [ready, hidden]);
  const error = trust.error || vault.error || preferences.error;
  const itemsError = entries.error || sessions.error;
  return (
    <div className="content-page secondary-page" hidden={hidden}>
      <header className="page-heading secondary-heading">
        <PageTitle path="/usage" />
      </header>
      {itemsError && <Notice>{itemsError}</Notice>}
      {trust.data && vault.data && preferences.data ? (
        <div className="usage">
          <Sentence
            view={trust.data}
            vault={vault.data}
            rule={preferences.data.notificationRule}
            rules={preferences.data.rules}
            onSaved={() => {
              void trust.refresh();
              void preferences.refresh();
            }}
          />
          {session ? (
            <SessionStatement
              session={session}
              vault={vault.data}
              opener={opener}
              onClear={() => {
                window.history.replaceState(null, '', '/usage');
                setSession(undefined);
              }}
            />
          ) : (
            <Statement view={trust.data} vault={vault.data} opener={opener} />
          )}
        </div>
      ) : error ? (
        <Notice>{error}</Notice>
      ) : (
        <Loading label="Opening usage…" />
      )}
    </div>
  );
}
