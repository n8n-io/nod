import { useEffect, useRef, useState } from 'react';
import { CircleHelp, CreditCard, Hash, KeyRound, Pause } from './icons';
import type {
  VaultActivity,
  VaultActivityEntry,
  VaultActivityReason,
} from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { formatDayLabel, formatTime, useDateFormat } from '../lib/date-format';
import { originLabel } from '../lib/vault-name';
import { Button, Notice } from './ui';
import { becauseText } from '../lib/trust-because';

const reasons: Record<VaultActivityReason, string> = {
  owner: 'You requested it',
  asked: 'You asked',
  schedule: 'Schedule',
  always: 'Always for this site',
  allowed: 'You allowed it',
  revoked: 'You removed access',
  entered: 'You entered it',
  picked: 'You chose it',
  mailbox: 'From your email',
  readonly: 'Read-only work',
  background: 'Background work',
  injection: 'A page had instructions',
  unrequested: 'You didn’t mention it',
  rule: 'Your rule',
  payment: 'You approved',
  code_typed: 'You approved',
  said_yes: 'You approved',
};

export function formatMoney(amount: { minor: number; currency: string }) {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency: amount.currency });
  return format.format(amount.minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

const icons = {
  sign_in: KeyRound,
  session: KeyRound,
  code: Hash,
  held: Pause,
  asked: CircleHelp,
  card: CreditCard,
  uncertain: Pause,
  permission: KeyRound,
  reveal: KeyRound,
};

function title(entry: VaultActivityEntry) {
  const site = originLabel(entry.origin).replace(/^www\./, '');
  const amount = entry.amount ? `${formatMoney(entry.amount)} ` : '';
  const card = entry.itemKind === 'card';
  switch (entry.action) {
    case 'card':
      return `Submitted card for ${amount}at ${site}`;
    case 'uncertain':
      return `Result unknown at ${site}`;
    case 'permission':
      return card ? 'Changed payment permission' : `Changed access to ${site}`;
    case 'reveal':
      return card ? 'Revealed a saved card value' : `Revealed a saved value for ${site}`;
    case 'session':
      return `Opened a saved session on ${site}`;
    case 'code':
      return `Entered a code on ${site}`;
    case 'held':
      return card ? `Didn’t pay at ${site}` : `Didn’t sign in to ${site}`;
    case 'asked':
      return card ? `Asked to pay ${amount}at ${site}` : `Asked to sign in to ${site}`;
    default:
      return `Submitted a login to ${site}`;
  }
}

function pill(entry: VaultActivityEntry): [string, string] {
  if (entry.action === 'asked') return ['Not used', 'is-held'];
  if (entry.action === 'held') return [`Held: ${reasons[entry.reason].toLowerCase()}`, 'is-held'];
  if (['always', 'allowed', 'code_typed', 'said_yes'].includes(entry.reason))
    return [reasons[entry.reason], 'is-approved'];
  if (entry.reason === 'schedule') return [reasons.schedule, 'is-schedule'];
  return [reasons[entry.reason], ''];
}

export function VaultUse({ entry, open }: { entry: VaultActivityEntry; open?(): void }) {
  const format = useDateFormat();
  const Icon = icons[entry.action];
  const [text, tone] = pill(entry);
  const content = (
    <>
      <span className={`vault-glyph is-${entry.action}`} aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="vault-use-text">
        <b>{title(entry)}</b>
        <span>{[formatTime(entry.at, format), entry.task].filter(Boolean).join(' · ')}</span>
        {entry.because && entry.because.kind !== 'approved' && (
          <small className="usage-because" title={becauseText(entry.because)}>
            {becauseText(entry.because)}
          </small>
        )}
      </span>
      <span className={`vault-pill ${tone}`}>{text}</span>
    </>
  );
  return open ? (
    <button type="button" className="vault-use" data-vault-activity={entry.id} onClick={open}>
      {content}
    </button>
  ) : (
    <div className="vault-use">{content}</div>
  );
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
        <div key={label} className="vault-day">
          <h4>{label}</h4>
          <ul>
            {items.map((entry) => (
              <li key={entry.id}>
                <VaultUse entry={entry} open={opener?.(entry)} />
              </li>
            ))}
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
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    request.current?.abort();
    request.current = null;
    setLoading(false);
    setError('');
    setMore([]);
    setNext(activity.next);
    return () => request.current?.abort();
  }, [activity]);
  async function load() {
    if (!next) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const page = await api<VaultActivity>(
        `/api/vault/activity?at=${encodeURIComponent(next.at)}&id=${next.id}${
          origin ? `&origin=${encodeURIComponent(origin)}` : ''
        }${item ? `&item=${encodeURIComponent(item)}` : ''}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setMore((current) => [...current, ...page.entries]);
      setNext(page.next);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
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
