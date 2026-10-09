import { useEffect, useState } from 'react';
import { CirclePause, Globe, Hash, KeyRound, MessageCircleQuestion } from 'lucide-react';
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
};

const icons = {
  sign_in: KeyRound,
  session: Globe,
  code: Hash,
  held: CirclePause,
  asked: MessageCircleQuestion,
};

function title(entry: VaultActivityEntry) {
  const site = originLabel(entry.origin);
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
    case 'asked':
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
  opener,
}: {
  activity: VaultActivity;
  origin?: string;
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
        }`,
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
  const { signIns, held } = activity.week;
  return (
    <div className="vault-statement">
      <p className="statement-summary">
        {signIns ? (
          <>
            This week Otto signed in <b>{times(signIns, 'once', 'times')}</b>, all on your say-so.
          </>
        ) : (
          'Otto hasn’t signed in anywhere this week.'
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
        <p className="statement-empty">Sign-ins and saved sessions Otto uses will show up here.</p>
      )}
    </div>
  );
}
