import { Tooltip } from './tooltip';
import { useEffect, useRef, useState } from 'react';
import { CircleHelp, CreditCard, Hash, KeyRound, Pause } from './icons';
import type { VaultActivity, VaultActivityEntry } from '../../shared/contracts';
import { api, errorMessage } from '../lib/api';
import { formatDayLabel, formatTime, useDateFormat, type DateFormat } from '../lib/date-format';
import { Button, Notice } from './ui';
import { becauseText } from '../../shared/trust';
import { vaultActivityTitle, vaultReasons as reasons } from '../../shared/vault-activity';

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

function pill(entry: VaultActivityEntry): [string, string] {
  if (entry.action === 'asked') return ['Not used', 'is-held'];
  if (entry.action === 'held') return [`Held: ${reasons[entry.reason].toLowerCase()}`, 'is-held'];
  if (['always', 'allowed', 'code_typed', 'said_yes'].includes(entry.reason))
    return [reasons[entry.reason], 'is-approved'];
  if (entry.reason === 'schedule') return [reasons.schedule, 'is-schedule'];
  return [reasons[entry.reason], ''];
}

export function VaultUse({
  entry,
  open,
  format,
}: {
  entry: VaultActivityEntry;
  open?(): void;
  format?: DateFormat;
}) {
  const savedFormat = useDateFormat();
  const displayFormat = format ?? savedFormat;
  const Icon = icons[entry.action];
  const [text, tone] = pill(entry);
  const content = (
    <>
      <span className={`vault-glyph is-${entry.action}`} aria-hidden="true">
        <Icon size={14} />
      </span>
      <span className="vault-use-text">
        <b>{vaultActivityTitle(entry, displayFormat.locale)}</b>
        <span>{[formatTime(entry.at, displayFormat), entry.task].filter(Boolean).join(' · ')}</span>
        {entry.because && entry.because.kind !== 'approved' && (
          <Tooltip content={becauseText(entry.because)}>
            <small className="usage-because">{becauseText(entry.because)}</small>
          </Tooltip>
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

function VaultActivityList({
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
