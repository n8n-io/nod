import { useEffect, useState } from 'react';
import {
  CirclePause,
  CreditCard,
  Globe,
  Hash,
  KeyRound,
  MessageCircleQuestion,
} from 'lucide-react';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultActivityReason,
} from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { formatDayLabel, formatNumber, formatTime, useDateFormat } from '../lib/date-format';
import { originLabel } from '../lib/vault-name';
import { Button, Notice } from './ui';

const reasons: Record<VaultActivityReason, string> = {
  asked: 'You asked',
  schedule: 'Schedule',
  always: 'Allowed without asking',
  allowed: 'You allowed it',
  entered: 'You entered it',
  picked: 'You chose it',
  mailbox: 'From your email',
  readonly: 'Read-only work',
  background: 'Background work',
  injection: 'A page had instructions',
  unrequested: 'You didn’t mention it',
  payment: 'Payments always ask',
  new_shop: 'New shops need Otto',
  chat_app: 'Pay from Otto or Telegram',
  code_typed: 'You sent the code',
  said_yes: 'You said yes',
};

export function formatMoney(amount: { minor: number; currency: string }) {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: amount.currency });
  return format.format(amount.minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

const icons = {
  sign_in: KeyRound,
  session: Globe,
  code: Hash,
  held: CirclePause,
  asked: MessageCircleQuestion,
  paid: CreditCard,
};

function title(entry: VaultActivityEntry) {
  const site = originLabel(entry.origin);
  const amount = entry.amount ? formatMoney(entry.amount) : '';
  if (entry.itemKind === 'card')
    switch (entry.action) {
      case 'paid':
        return `Used your card for ${amount} at ${site}`;
      case 'held':
        return `Didn’t pay at ${site}`;
      default:
        return `Asked to pay ${amount} at ${site}`;
    }
  switch (entry.action) {
    case 'sign_in':
      return `Signed in to ${site}`;
    case 'session':
      return `Used your session on ${site}`;
    case 'code':
      return `Entered a code on ${site}`;
    case 'held':
      return entry.itemKind === 'session'
        ? `Didn’t use your session on ${site}`
        : `Didn’t sign in to ${site}`;
    default:
      return entry.itemKind === 'session'
        ? `Asked to use your session on ${site}`
        : `Asked to sign in to ${site}`;
  }
}

function times(count: number, one: string, many: string) {
  return count === 1 ? one : `${formatNumber(count)} ${many}`;
}

export function VaultActivityList({
  entries,
  opener,
}: {
  entries: VaultActivityEntry[];
  opener?(entry: VaultActivityEntry): (() => void) | undefined;
}) {
  const format = useDateFormat();
  const days = new Map<string, VaultActivityEntry[]>();
  for (const entry of entries) {
    const label = formatDayLabel(entry.at, format);
    days.set(label, [...(days.get(label) ?? []), entry]);
  }
  return (
    <>
      {[...days].map(([label, items]) => (
        <div key={label} className="statement-day">
          <h4>{label}</h4>
          <ul>
            {items.map((entry) => {
              const Icon = icons[entry.action];
              const open = opener?.(entry);
              const content = (
                <>
                  <Icon size={16} aria-hidden="true" />
                  <div>
                    <span className="statement-entry-title">{title(entry)}</span>
                    <span className="statement-entry-meta">
                      {[formatTime(entry.at, format), entry.task].filter(Boolean).join(' · ')}
                    </span>
                  </div>
                  <span
                    className={`vault-reason${['held', 'asked'].includes(entry.action) ? ' is-held' : ''}`}
                  >
                    {reasons[entry.reason]}
                  </span>
                </>
              );
              return (
                <li key={entry.id} className="statement-entry">
                  {open ? (
                    <button type="button" className="vault-activity-open" onClick={open}>
                      {content}
                    </button>
                  ) : (
                    content
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

export function VaultActivityPages({
  activity,
  origin,
  item,
  opener,
}: {
  activity: VaultActivity;
  origin?: string;
  item?: string;
  opener?(entry: VaultActivityEntry): (() => void) | undefined;
}) {
  const [more, setMore] = useState<VaultActivityEntry[]>([]);
  const [next, setNext] = useState(activity.next);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setMore([]);
    setNext(activity.next);
  }, [activity]);
  async function load() {
    if (!next) return;
    setLoading(true);
    setError('');
    try {
      const page = await api<VaultActivity>(
        `/api/vault/activity?at=${encodeURIComponent(next.at)}&id=${next.id}${
          origin ? `&origin=${encodeURIComponent(origin)}` : ''
        }${item ? `&item=${encodeURIComponent(item)}` : ''}`,
      );
      setMore((current) => [...current, ...page.entries]);
      setNext(page.next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <>
      <VaultActivityList entries={[...activity.entries, ...more]} opener={opener} />
      {error && <Notice>{error}</Notice>}
      {next && (
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
          Show earlier
        </Button>
      )}
    </>
  );
}

export function VaultStatement({
  activity,
  opener,
}: {
  activity: VaultActivity;
  opener(entry: VaultActivityEntry): (() => void) | undefined;
}) {
  const { signIns, payments, held } = activity.week;
  return (
    <div className="vault-statement">
      <p className="statement-summary">
        {signIns || payments ? (
          <>
            This week Otto{' '}
            {signIns > 0 && (
              <>
                signed in <b>{times(signIns, 'once', 'times')}</b>
              </>
            )}
            {signIns > 0 && payments > 0 && ' and '}
            {payments > 0 && (
              <>
                used your card <b>{times(payments, 'once', 'times')}</b>
              </>
            )}
            , all on your say-so.
          </>
        ) : (
          'Otto hasn’t used your Vault this week.'
        )}
        {held > 0 && (
          <>
            {' '}
            <b>{times(held, '1 attempt was held', 'attempts were held')}</b>.
          </>
        )}
      </p>
      {activity.entries.length ? (
        <section className="statement" aria-label="Activity">
          <VaultActivityPages activity={activity} opener={opener} />
        </section>
      ) : (
        <p className="statement-empty">Sign-ins, sessions and payments will show up here.</p>
      )}
    </div>
  );
}
