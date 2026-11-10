import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  CalendarClock,
  LoaderCircle,
  MessageCircle,
  ScanSearch,
  Undo2,
  Zap,
} from '../components/icons';
import type {
  TrustEntry,
  TrustModel,
  TrustOutside,
  TrustPage,
  TrustSource,
  TrustView,
} from '../../shared/trust';
import { modelProviderNames, modelSource, type ModelsResponse } from '../../shared/models';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultListEntry,
  VaultSession,
} from '../../shared/contracts';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { navigate } from '../lib/navigation';
import {
  dayKey,
  formatDayLabel,
  formatNumber,
  formatTime,
  useDateFormat,
  type DateFormat,
} from '../lib/date-format';
import { PageTitle } from '../components/page-title';
import { StatementValue } from '../components/statement-value';
import { Tooltip } from '../components/tooltip';
import { Button, Input, Loading, Notice } from '../components/ui';
import { VaultUse } from '../components/vault-activity';
import { becauseText } from '../lib/trust-because';
import { money } from '../lib/money';
import { vaultItems } from './vault';

const day = 86_400_000;
const sources: Record<TrustSource, { icon: typeof Zap; label: string }> = {
  chat: { icon: MessageCircle, label: '' },
  task: { icon: MessageCircle, label: 'Task' },
  started: { icon: ScanSearch, label: 'Task Nod started' },
  schedule: { icon: CalendarClock, label: 'Schedule' },
  event: { icon: Zap, label: '' },
  check: { icon: ScanSearch, label: 'Activity check' },
  resume: { icon: Undo2, label: '' },
};

const outsideNames: Record<TrustOutside['kind'], string> = {
  email: 'email checks',
  memory: 'memory upkeep',
  style: 'writing style',
  ideas: 'first task ideas',
  other: 'other work',
};

function date(ms: number, format: DateFormat) {
  return new Date(ms).toLocaleDateString(format.locale, {
    day: 'numeric',
    month: 'long',
    timeZone: format.timeZone,
  });
}

function saveLimits(body: { monthlyUsd: number | null }) {
  return api('/api/trust/limit', { method: 'PUT', body: JSON.stringify(body) });
}

function Chart({ month, limit }: { month: TrustView['month']; limit: number | undefined }) {
  const format = useDateFormat();
  const count = Math.max(1, Math.min(month.daily.length, Math.ceil(month.elapsedDays)));
  const [selected, setSelected] = useState(count - 1);
  const current = Math.min(selected, count - 1);
  const spent = month.daily[current] ?? 0;
  const cumulative = month.daily.slice(0, current + 1).reduce((sum, value) => sum + value, 0);
  const firstDay = Date.parse(dayKey(month.start, format));
  const dayLabel = (index: number) => date(firstDay + index * day, { ...format, timeZone: 'UTC' });
  const selectedDate = dayLabel(current);
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
  function selectDay(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setSelected(
      Math.max(
        0,
        Math.min(count - 1, Math.ceil(((event.clientX - rect.left) / rect.width) * month.days) - 1),
      ),
    );
  }
  return (
    <div className="usage-chart-detail">
      <div className="usage-chart-summary" aria-live="polite">
        <span>{selectedDate}</span>
        <strong>
          {money(spent)} <small>that day</small>
        </strong>
        <span>{money(cumulative)} total</span>
      </div>
      <svg
        className="usage-chart"
        viewBox="0 0 600 120"
        preserveAspectRatio="none"
        role="slider"
        tabIndex={0}
        aria-label="Daily spending"
        aria-valuemin={1}
        aria-valuemax={count}
        aria-valuenow={current + 1}
        aria-valuetext={`${selectedDate}: ${money(spent)}, ${money(cumulative)} total`}
        onPointerMove={selectDay}
        onClick={selectDay}
        onKeyDown={(event) => {
          if (
            !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
          )
            return;
          event.preventDefault();
          setSelected(
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? count - 1
                : Math.max(
                    0,
                    Math.min(
                      count - 1,
                      current + (['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1),
                    ),
                  ),
          );
        }}
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
        <line
          className="usage-chart-cursor"
          x1={x(Math.min(current + 1, month.elapsedDays))}
          x2={x(Math.min(current + 1, month.elapsedDays))}
          y1="0"
          y2="120"
        />
        <circle
          className="usage-chart-point"
          cx={x(Math.min(current + 1, month.elapsedDays))}
          cy={y(cumulative)}
          r="4"
        />
      </svg>
      <div className="usage-chart-dates">
        <span>{dayLabel(0)}</span>
        <span>{dayLabel(month.days - 1)}</span>
      </div>
    </div>
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
  const notes = [
    month.planUsd > 0 &&
      `Your ChatGPT plan covered about ${money(month.planUsd)}${month.spentUsd > 0 ? ' more' : ''} at API prices.`,
    month.unpriced && 'Some usage has no price in Nod, such as a local or free model.',
    month.backgroundUsd > 0 &&
      `${money(month.backgroundUsd)} was background work: source checks, schedules and tasks Nod started.`,
    month.outside.length > 0 &&
      `Of that, ${month.outside.map((item) => `${outsideNames[item.kind]} ${money(item.costUsd)}`).join(', ')} ran outside a check or task.`,
  ].filter((note): note is string => Boolean(note));
  const chart = month.spentUsd > 0 || !notes.length;
  const Note = chart ? 'small' : 'span';
  return (
    <div className="usage-month" data-analytics-private>
      {month.spentUsd > 0 && (
        <span className={crossing ? 'is-over' : undefined}>
          On track for {money(month.forecastUsd)}
          {crossing && `, reaching your limit around ${crossing}`}
        </span>
      )}
      {chart && <Chart month={month} limit={limit?.monthlyUsd} />}
      {notes.map((note) => (
        <Note key={note}>{note}</Note>
      ))}
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
      <small>
        At the limit, new requests pause until {resets}.
        {(view.month.planUsd > 0 || view.month.unpriced) && ' Only paid usage counts.'}
      </small>
      {error && <Notice>{error}</Notice>}
    </form>
  );
}

function UsageSummary({
  view,
  plan,
  onSaved,
}: {
  view: TrustView;
  plan?: string;
  onSaved(): void;
}) {
  const format = useDateFormat();
  const { month, limit } = view;
  const name = new Date(month.start).toLocaleDateString(format.locale, {
    month: 'long',
    timeZone: format.timeZone,
  });
  const resets = date(Date.parse(month.start) + month.days * day + day / 2, format);
  const planNote = month.planUsd > 0 ? ' beyond your ChatGPT plan' : '';
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
  if (plan)
    return (
      <div className="usage-overview">
        <p className="statement-summary usage-sentence">
          Your usage comes from your <strong>{plan}</strong>.
        </p>
        {limit?.reached && (
          <Notice kind="info">
            An existing API spending limit is pausing new requests. You can review it with an API
            model selected.
          </Notice>
        )}
      </div>
    );
  return (
    <div className="usage-overview">
      <p className="statement-summary usage-sentence">
        Your usage is{' '}
        <StatementValue
          text={limit || month.spentUsd > 0 ? money(month.spentUsd) : 'nothing'}
          label={`API spending in ${name}`}
        >
          {() => <Month view={view} />}
        </StatementValue>
        {limit ? (
          <>
            {' '}
            of{' '}
            <StatementValue text={money(limit.monthlyUsd)} label="Monthly limit">
              {limitForm}
            </StatementValue>
            {planNote} in {name}
          </>
        ) : (
          <>
            {planNote} in {name}, with{' '}
            <StatementValue text="no monthly limit" label="Monthly limit">
              {limitForm}
            </StatementValue>
          </>
        )}
        .
      </p>
      {month.planUsage && (
        <p className="usage-plan-note">Plan usage this month is separate from API spending.</p>
      )}
      {limit?.reached && (
        <Notice kind="info">
          Limit reached. New chat and background requests pause until {resets}. Running turns can
          finish. Raise your limit to resume.
        </Notice>
      )}
    </div>
  );
}

function billingSource(model: TrustModel) {
  if (model.billing === 'plan') return 'ChatGPT plan';
  const provider = model.provider
    ? modelProviderNames[model.provider as keyof typeof modelProviderNames]
    : undefined;
  return provider ? `${provider} API` : 'API usage';
}

function TrustRow({ entry, showCosts }: { entry: TrustEntry; showCosts: boolean }) {
  const format = useDateFormat();
  const models = entry.models ?? [];
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
  const content = (
    <>
      <span className="vault-glyph" aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="vault-use-text">
        <b>{entry.title}</b>
        <span className={entry.error ? 'is-error' : undefined}>
          {[formatTime(entry.at, format), label].filter(Boolean).join(' · ')}
          {entry.error ? ` · ${entry.error}` : did ? ` · ${did}` : ''}
        </span>
        {models.length > 0 && (
          <span className="usage-models" aria-label="Models used">
            {models.map((model) => (
              <span key={`${model.provider}:${model.model}:${model.billing}`}>
                {model.model ?? 'Model not recorded'}
                <span className="usage-model-source"> · {billingSource(model)}</span>
              </span>
            ))}
          </span>
        )}
        {reasons.map((reason) => (
          <Tooltip key={reason} content={reason}>
            <small className="usage-because">{reason}</small>
          </Tooltip>
        ))}
      </span>
      {showCosts && entry.costUsd !== null ? (
        <span className="usage-row-cost">
          {money(entry.costUsd)}
          {models.some((model) => model.billing === 'plan') && <small>API</small>}
        </span>
      ) : (
        entry.pricing && (
          <span className="usage-row-cost is-label">
            {entry.pricing === 'plan' ? 'ChatGPT plan' : 'No price'}
          </span>
        )
      )}
    </>
  );
  return entry.messageId ? (
    <Tooltip content="Show in chat">
      <button
        type="button"
        className="vault-use"
        aria-label={`Open ${entry.title} in chat`}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent('nod:focus-message', { detail: { messageId: entry.messageId } }),
          )
        }
      >
        {content}
      </button>
    </Tooltip>
  ) : (
    <div className="vault-use">{content}</div>
  );
}

type Stream<T> = { entries: T[]; next: { at: string; id: string } | null };

function frontier<T extends { at: string }>(stream: Stream<T>) {
  return stream.next ? Date.parse(stream.next.at) : -Infinity;
}

function refreshStream<T extends { id: string }>(current: Stream<T>, fresh: Stream<T>): Stream<T> {
  const boundary = fresh.next && current.entries.findIndex((entry) => entry.id === fresh.next!.id);
  if (boundary === null || boundary === -1) return fresh;
  const ids = new Set(fresh.entries.map((entry) => entry.id));
  return {
    entries: [
      ...fresh.entries,
      ...current.entries.slice(boundary + 1).filter((entry) => !ids.has(entry.id)),
    ],
    next: current.next,
  };
}

function appendStream<T extends { id: string }>(current: Stream<T>, older: Stream<T>): Stream<T> {
  const ids = new Set(current.entries.map((entry) => entry.id));
  return {
    entries: [...current.entries, ...older.entries.filter((entry) => !ids.has(entry.id))],
    next: older.next,
  };
}

function Statement({
  view,
  vault,
  opener,
  session,
  showCosts,
  hidden,
}: {
  view: TrustPage;
  vault: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
  session?: string;
  showCosts: boolean;
  hidden: boolean;
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
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setTrust((current) => refreshStream(current, view));
    setUses((current) =>
      refreshStream(current, { entries: vault.entries, next: vault.next ?? null }),
    );
    setLoading(false);
  }, [view, vault]);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!hidden) return;
    request.current?.abort();
    request.current = null;
    setLoading(false);
  }, [hidden]);
  const cutoff = Math.max(frontier(trust), frontier(uses));
  const rows: Array<{ at: string; key: string; trust?: TrustEntry; use?: VaultActivityEntry }> = [
    ...trust.entries.map((entry) => ({ at: entry.at, key: `t${entry.id}`, trust: entry })),
    ...uses.entries.map((entry) => ({ at: entry.at, key: `v${entry.id}`, use: entry })),
  ]
    .filter((row) => Date.parse(row.at) >= cutoff)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const load = useCallback(async () => {
    if (hidden || request.current || cutoff === -Infinity) return;
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
      if (olderTrust) setTrust((current) => appendStream(current, olderTrust));
      if (olderUses)
        setUses((current) =>
          appendStream(current, { entries: olderUses.entries, next: olderUses.next ?? null }),
        );
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  }, [trust, uses, cutoff, session, hidden]);
  useEffect(() => {
    const target = sentinel.current;
    if (!target || hidden || error || cutoff === -Infinity) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void load();
      },
      { root: target.closest('.main-workspace'), rootMargin: '0px 0px 240px' },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [cutoff, error, hidden, load]);
  if (!rows.length && cutoff === -Infinity)
    return <p className="statement-empty">Your activity and the models used will show up here.</p>;
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
                  <TrustRow entry={row.trust!} showCosts={showCosts} />
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {error && cutoff > -Infinity ? (
        <Notice>
          {error}{' '}
          <button type="button" onClick={() => void load()}>
            Try again
          </button>
        </Notice>
      ) : cutoff > -Infinity ? (
        <div ref={sentinel} className="usage-load-more" role="status" aria-live="polite">
          {loading && (
            <>
              <LoaderCircle size={16} className="spin" aria-hidden="true" />
              <span>Loading activity…</span>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

function SessionStatement({
  session,
  vault,
  opener,
  onClear,
  showCosts,
  hidden,
}: {
  session: string;
  vault: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
  onClear(): void;
  showCosts: boolean;
  hidden: boolean;
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
      <Statement
        view={page.data}
        vault={none}
        opener={opener}
        session={session}
        showCosts={showCosts}
        hidden={hidden}
      />
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
  const models = usePageData<ModelsResponse>('/api/models');
  const vault = usePageData<VaultActivity>('/api/vault/activity');
  const entries = usePageData<VaultListEntry[]>('/api/vault');
  const sessions = usePageData<VaultSession[]>('/api/vault/sessions');
  const items = vaultItems(entries.data ?? [], sessions.data ?? []);
  const selected = models.data?.connections.find(
    (connection) => connection.id === models.data?.selection?.connectionId,
  );
  const plan = selected?.method === 'subscription' ? modelSource(selected) : undefined;
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
  const ready = Boolean(trust.data && vault.data && entries.data);
  useEffect(() => {
    const id = (window.history.state as { usage?: string } | null)?.usage;
    if (hidden || !ready || !id) return;
    window.history.replaceState(null, '');
    [...document.querySelectorAll<HTMLElement>('[data-vault-activity]')]
      .find((row) => row.dataset.vaultActivity === id)
      ?.focus();
  }, [ready, hidden]);
  const error = trust.error || vault.error || models.error;
  const itemsError = entries.error || sessions.error;
  return (
    <div className="content-page secondary-page" hidden={hidden}>
      <header className="page-heading secondary-heading">
        <PageTitle path="/usage" />
      </header>
      {itemsError && <Notice>{itemsError}</Notice>}
      {trust.data && vault.data && models.data ? (
        <div className="usage">
          <UsageSummary
            view={trust.data}
            plan={plan}
            onSaved={() => {
              void trust.refresh();
            }}
          />
          {session ? (
            <SessionStatement
              session={session}
              vault={vault.data}
              opener={opener}
              showCosts={!plan}
              hidden={hidden}
              onClear={() => {
                window.history.replaceState(null, '', '/usage');
                setSession(undefined);
              }}
            />
          ) : (
            <Statement
              view={trust.data}
              vault={vault.data}
              opener={opener}
              showCosts={!plan}
              hidden={hidden}
            />
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
