import { useState, type FormEvent } from 'react';
import { CalendarClock, MessageCircle, Pencil, ScanSearch, Undo2, Zap } from 'lucide-react';
import type { TrustEntry, TrustSource, TrustView } from '../../shared/trust';
import { Button, Input, Loading, Notice } from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import {
  formatDayLabel,
  formatNumber,
  formatTime,
  useDateFormat,
  type DateFormat,
} from '../lib/date-format';

const day = 86_400_000;
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

function money(value: number) {
  if (value > 0 && value < 0.01) return '<$0.01';
  return formatNumber(value, {
    style: 'currency',
    currency: 'USD',
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: Number.isInteger(value) && value >= 1 ? 0 : 2,
  });
}

function Summary({ week }: { week: TrustView['week'] }) {
  if (!week.things && !week.actions && !week.spentUsd)
    return <p className="statement-summary">Nothing yet this week.</p>;
  return (
    <p className="statement-summary">
      In the last 7 days, Otto did{' '}
      <b>
        {formatNumber(week.things)} {week.things === 1 ? 'thing' : 'things'}
      </b>
      .{' '}
      {week.actions > 0 && (
        <>
          It used your apps{' '}
          <b>{week.actions === 1 ? 'once' : `${formatNumber(week.actions)} times`}</b>.{' '}
        </>
      )}
      {week.spentUsd > 0 && (
        <>
          It spent <b>{money(week.spentUsd)}</b>.
        </>
      )}
    </p>
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

function Limit({ view, onSaved }: { view: TrustView; onSaved(): void }) {
  const format = useDateFormat();
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const resets = date(Date.parse(view.month.start) + view.month.days * day + day / 2, format);
  async function save(monthlyUsd: number | null) {
    setBusy(true);
    setError('');
    try {
      await api('/api/trust/limit', { method: 'PUT', body: JSON.stringify({ monthlyUsd }) });
      setDraft(undefined);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = Number(draft);
    if (Number.isFinite(value) && value >= 1) void save(value);
    else setError('Enter a limit of at least $1.');
  }
  const amount = draft ? Number(draft) : view.limit?.monthlyUsd;
  return (
    <div className="trust-limit">
      {draft === undefined ? (
        <Button
          variant={view.limit ? 'ghost' : 'outline'}
          size="sm"
          onClick={() => setDraft(String(view.limit?.monthlyUsd ?? ''))}
        >
          {view.limit ? (
            <>
              <Pencil size={14} aria-hidden="true" />
              {money(view.limit.monthlyUsd)} monthly limit
            </>
          ) : (
            'Set a monthly limit'
          )}
        </Button>
      ) : (
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
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setDraft(undefined)}
          >
            Cancel
          </Button>
        </form>
      )}
      {view.limit?.reached ? (
        <Notice kind="info">
          Limit reached. New chat and background requests pause until {resets}. Running turns can
          finish. Raise your limit to resume.
        </Notice>
      ) : (
        (view.limit || draft !== undefined) && (
          <p className="trust-limit-note">
            {amount ? `At ${money(amount)}` : 'At the limit'}, new chat and background requests
            pause until {resets}.
          </p>
        )
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

function Cost({ view, onSaved }: { view: TrustView; onSaved(): void }) {
  const format = useDateFormat();
  const { month, limit } = view;
  const name = new Date(month.start).toLocaleDateString(format.locale, {
    month: 'long',
    timeZone: format.timeZone,
  });
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
    <section className="trust-cost" aria-label="Spending">
      <div className="trust-cost-head">
        <div>
          <span className="trust-label">{name}</span>
          <div className="trust-amount">
            {money(month.spentUsd)}
            {limit && <small>of {money(limit.monthlyUsd)}</small>}
          </div>
          {month.spentUsd > 0 && (
            <span className={`trust-forecast${crossing ? ' is-over' : ''}`}>
              On track for {money(month.forecastUsd)}
              {crossing && `, reaching your limit around ${crossing}`}
            </span>
          )}
        </div>
        <Limit view={view} onSaved={onSaved} />
      </div>
      <Chart month={month} limit={limit?.monthlyUsd} />
      {month.unpriced && (
        <p className="trust-limit-note">Some usage has no price, so it isn’t counted here.</p>
      )}
    </section>
  );
}

function Entry({ entry }: { entry: TrustEntry }) {
  const format = useDateFormat();
  const { icon: Icon, label } = sources[entry.source];
  const did = [...new Set(entry.actions)].join(', ');
  return (
    <li className="statement-entry">
      <Icon size={16} aria-hidden="true" />
      <div>
        <span className="statement-entry-title">{entry.title}</span>
        <span className={`statement-entry-meta${entry.error ? ' is-error' : ''}`}>
          {[formatTime(entry.at, format), label].filter(Boolean).join(' · ')}
          {entry.error ? ` · ${entry.error}` : did ? ` · ${did}` : ''}
        </span>
      </div>
      <span
        className="statement-entry-end"
        title={entry.unpriced ? 'Included in your plan' : undefined}
      >
        {entry.costUsd !== null ? money(entry.costUsd) : '—'}
      </span>
    </li>
  );
}

function Statement({ view }: { view: TrustView }) {
  const format = useDateFormat();
  const [more, setMore] = useState<TrustEntry[]>([]);
  const [next, setNext] = useState(view.next);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const entries = [...view.entries, ...more];
  async function load() {
    if (!next) return;
    setLoading(true);
    try {
      const page = await api<{ entries: TrustEntry[]; next: TrustView['next'] }>(
        `/api/trust/entries?at=${encodeURIComponent(next.at)}&id=${next.id}`,
      );
      setMore((current) => [...current, ...page.entries]);
      setNext(page.next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  if (!entries.length)
    return <p className="statement-empty">What Otto spends will show up here.</p>;
  const days = new Map<string, TrustEntry[]>();
  for (const entry of entries) {
    const label = formatDayLabel(entry.at, format);
    days.set(label, [...(days.get(label) ?? []), entry]);
  }
  return (
    <section className="statement" aria-label="Statement">
      {[...days].map(([label, items]) => (
        <div key={label} className="statement-day">
          <h4>{label}</h4>
          <ul>
            {items.map((entry) => (
              <Entry key={entry.id} entry={entry} />
            ))}
          </ul>
        </div>
      ))}
      {error && <Notice>{error}</Notice>}
      {next && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          Show earlier
        </Button>
      )}
    </section>
  );
}

export function Trust() {
  const { data, error, loading, refresh } = usePageData<TrustView>('/api/trust');
  if (!data)
    return loading ? <Loading /> : <Notice>{error || 'Trust could not be loaded.'}</Notice>;
  return (
    <div className="trust">
      <Summary week={data.week} />
      <Cost view={data} onSaved={() => void refresh()} />
      <Statement key={data.entries[0]?.id ?? 'empty'} view={data} />
    </div>
  );
}
