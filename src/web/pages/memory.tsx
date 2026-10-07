import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { ChevronLeft, Plus } from 'lucide-react';
import type { Connection, VaultListEntry } from '../../shared/contracts';
import {
  memoryAreas,
  type MemoryArchived,
  type MemoryArea,
  type MemoryNote,
  type MemorySource,
  type MemoryStatus,
  type MemoryUpdate,
  type MemoryView,
} from '../../shared/memory';
import { PageTitle } from '../components/page-title';
import { ServiceLogo } from '../components/service-logo';
import {
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Field,
  Loading,
  Notice,
  SearchField,
  Switch,
} from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { usePhone } from '../hooks/use-phone';
import { api, errorMessage } from '../lib/api';
import { dayKey, formatCalendarDate, formatDayLabel, useDateFormat } from '../lib/date-format';
import { navigate } from '../lib/navigation';
import { cn } from '../lib/utils';

const areaLabels: Record<MemoryArea, string> = {
  about: 'About you',
  preferences: 'Preferences',
  people: 'People',
  routines: 'Routines',
  lessons: 'Lessons',
};
const reasons: Record<MemoryArchived['reason'], string> = {
  superseded: 'Replaced',
  merged: 'Merged',
  duplicate: 'Duplicate',
  expired: 'Expired',
  stale: 'Not mentioned again',
  obsolete: 'No longer true',
  contradicted: 'Contradicted',
};
const channels: Record<string, string> = {
  web: 'Otto web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

type Tab = 'all' | MemoryArea | 'archive';
type Scope = 'mind' | 'lookup' | null;
type Selection = { note: string } | { archived: string } | null;

const archivedKey = (item: MemoryArchived) => `${item.path}@${item.archived}`;

function statusLabel(note: MemoryNote) {
  if (note.status === 'tentative') return 'Noticed once';
  if (note.status === 'observed') return `Noticed ${note.sources.length} times`;
  if (!note.edited) return 'You said this';
  return note.sources.length ? 'Updated by you' : 'Written by you';
}

function MemoryMark({ status, inMind }: { status: MemoryStatus; inMind: boolean }) {
  return (
    <svg className={cn('memory-mark', status)} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="memory-mark-ring" cx="6.6" cy="9.4" r="4.9" />
      {status === 'observed' && (
        <path className="memory-mark-half" d="M6.6 4.5a4.9 4.9 0 0 0 0 9.8z" />
      )}
      {inMind && <circle className="memory-mark-dot" cx="12.4" cy="3.6" r="3" />}
    </svg>
  );
}

function RingIcon({ ring }: { ring: 'mind' | 'lookup' | 'reach' }) {
  return (
    <svg className={cn('memory-ring', ring)} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" />
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3.5" />
    </svg>
  );
}

function Reach({
  view,
  scope,
  onScope,
}: {
  view: MemoryView;
  scope: Scope;
  onScope(scope: Scope): void;
}) {
  const apps = usePageData<Connection[]>('/api/apps').data ?? [];
  const vault = usePageData<VaultListEntry[]>('/api/vault').data;
  const connected = [
    ...new Map(
      apps
        .filter((app) => app.connectionId && app.status === 'connected')
        .map((app) => [app.slug, app]),
    ).values(),
  ];
  const mind = view.notes.filter((note) => note.inMind).length;
  const lookup = view.notes.length - mind;
  const profile = (['name', 'location', 'phone', 'preferences'] as const).filter(
    (field) => view.profile[field],
  );
  const scoped = (value: Exclude<Scope, null>, count: number, label: string) => (
    <button
      type="button"
      className="memory-chip"
      aria-pressed={scope === value}
      onClick={() => onScope(scope === value ? null : value)}
    >
      {count} {count === 1 ? label : `${label}s`}
    </button>
  );
  const link = (path: string, children: ReactNode, key?: string) => (
    <a
      key={key}
      className="memory-chip"
      href={path}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
        event.preventDefault();
        navigate(path);
      }}
    >
      {children}
    </a>
  );
  return (
    <section className="memory-reach" aria-label="What Otto can draw on">
      <div>
        <h2>
          <RingIcon ring="mind" />
          Always in mind
        </h2>
        <div className="memory-chips">
          {profile.map((field) => (
            <span
              key={field}
              className="memory-item"
              title={field === 'preferences' ? view.profile.preferences : undefined}
            >
              {view.profile[field]}
            </span>
          ))}
          {scoped('mind', mind, 'note')}
          <span className="memory-item">This chat</span>
        </div>
      </div>
      <div>
        <h2>
          <RingIcon ring="lookup" />
          Looked up when needed
        </h2>
        <div className="memory-chips">
          {lookup > 0 && scoped('lookup', lookup, 'note')}
          <span className="memory-item">Earlier chats</span>
          <span className="memory-item">Files</span>
          <span className="memory-item">Tasks</span>
        </div>
      </div>
      <div>
        <h2>
          <RingIcon ring="reach" />
          Reachable through your accounts
        </h2>
        <div className="memory-chips">
          {connected.map((app) =>
            link(
              '/apps',
              <>
                <ServiceLogo connection={app} size={16} />
                {app.name}
              </>,
              app.slug,
            ),
          )}
          {!connected.length && link('/apps', 'Connect apps')}
          {!!vault?.length && link('/vault', `Vault · ${vault.length}`)}
        </div>
      </div>
    </section>
  );
}

function Sources({ sources }: { sources: MemorySource[] }) {
  const format = useDateFormat();
  return sources
    .toSorted((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .map((source) => (
      <figure key={source.id} className="memory-source">
        <blockquote>
          {source.text ? `“${source.text}”` : 'This message is no longer in your chat history.'}
        </blockquote>
        {source.at && (
          <figcaption>
            {channels[source.channel ?? 'web'] ?? source.channel} ·{' '}
            {formatDayLabel(source.at, format)}
          </figcaption>
        )}
      </figure>
    ));
}

function NoteDetail({
  note,
  history,
  onChange,
  onForget,
  onBack,
}: {
  note: MemoryNote;
  history: MemoryArchived[];
  onChange(body: { text?: string; expires?: string | null; confirm?: true }): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
}) {
  const format = useDateFormat();
  const [mode, setMode] = useState<'view' | 'edit' | 'expires' | 'forget'>('view');
  const [text, setText] = useState(note.text);
  const [expires, setExpires] = useState(note.expires ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
      setMode('view');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    const body = mode === 'edit' ? { text: text.trim() } : { expires: expires || null };
    const unchanged = 'text' in body ? body.text === note.text : body.expires === note.expires;
    if (unchanged) setMode('view');
    else void run(() => onChange(body));
  }
  return (
    <article className="memory-detail">
      {onBack && (
        <Button variant="ghost" size="sm" className="memory-back" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
          Memory
        </Button>
      )}
      <p className="memory-status">
        <MemoryMark status={note.status} inMind={note.inMind} />
        {statusLabel(note)} · {note.inMind ? 'always in mind' : 'looked up when relevant'}
      </p>
      {mode === 'edit' ? (
        <form className="memory-form" onSubmit={save}>
          <textarea
            className="input"
            value={text}
            maxLength={600}
            rows={3}
            aria-label="Note"
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <div className="memory-actions">
            <Button type="submit" size="sm" disabled={busy || !text.trim()}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <h2 className="memory-text">{note.text}</h2>
      )}
      {note.expires && mode !== 'expires' && (
        <p className="memory-meta">Until {formatCalendarDate(note.expires, format)}</p>
      )}
      {mode === 'expires' && (
        <form className="memory-form" onSubmit={save}>
          <input
            className="input"
            type="date"
            value={expires}
            min={dayKey(Date.now(), format)}
            aria-label="Keep until"
            autoFocus
            onChange={(event) => setExpires(event.target.value)}
          />
          <div className="memory-actions">
            <Button type="submit" size="sm" disabled={busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <Sources sources={note.sources} />
      {history.map((item) => (
        <p key={archivedKey(item)} className="memory-meta">
          {reasons[item.reason]} “{item.text}” · {formatDayLabel(item.archived, format)}
        </p>
      ))}
      {note.lookups && (
        <p className="memory-meta">
          Looked up {note.lookups.count === 1 ? 'once' : `${note.lookups.count} times`} ·{' '}
          {formatDayLabel(note.lookups.last, format)}
        </p>
      )}
      {error && <Notice>{error}</Notice>}
      {mode === 'forget' ? (
        <div className="memory-confirm">
          <p>Forget this note and its earlier versions?</p>
          <div className="memory-actions">
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(onForget)}>
              Forget
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode('view')}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        mode === 'view' && (
          <div className="memory-actions">
            {note.status !== 'stated' && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => run(() => onChange({ confirm: true }))}
              >
                Confirm
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setMode('edit')}>
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setMode('expires')}>
              End date
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setMode('forget')}>
              Forget
            </Button>
          </div>
        )
      )}
    </article>
  );
}

function ArchivedDetail({
  item,
  onRestore,
  onForget,
  onBack,
}: {
  item: MemoryArchived;
  onRestore(): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
}) {
  const format = useDateFormat();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <article className="memory-detail">
      {onBack && (
        <Button variant="ghost" size="sm" className="memory-back" onClick={onBack}>
          <ChevronLeft size={16} aria-hidden="true" />
          Memory
        </Button>
      )}
      <p className="memory-status">
        {reasons[item.reason]} · {formatDayLabel(item.archived, format)}
      </p>
      <h2 className="memory-text is-archived">{item.text}</h2>
      <Sources sources={item.sources} />
      {error && <Notice>{error}</Notice>}
      <div className="memory-actions">
        <Button size="sm" disabled={busy} onClick={() => run(onRestore)}>
          Bring back
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => run(onForget)}>
          Forget
        </Button>
      </div>
    </article>
  );
}

function AddNote({
  area,
  onClose,
  onAdd,
}: {
  area: MemoryArea;
  onClose(): void;
  onAdd(body: { area: MemoryArea; text: string; expires?: string }): Promise<void>;
}) {
  const format = useDateFormat();
  const [target, setTarget] = useState(area);
  const [text, setText] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onAdd({ area: target, text: text.trim(), ...(expires ? { expires } : {}) });
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="memory-dialog" aria-describedby={undefined} data-analytics-private>
        <DialogTitle>Add a note</DialogTitle>
        <form className="memory-form" onSubmit={submit}>
          <textarea
            className="input"
            value={text}
            maxLength={600}
            rows={3}
            placeholder="I prefer an aisle seat"
            aria-label="Note"
            autoFocus
            onChange={(event) => setText(event.target.value)}
          />
          <div className="memory-dialog-row">
            <Field label="Kind">
              <select
                className="input"
                value={target}
                onChange={(event) => setTarget(event.target.value as MemoryArea)}
              >
                {memoryAreas.map((value) => (
                  <option key={value} value={value}>
                    {areaLabels[value]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Keep until">
              <input
                className="input"
                type="date"
                value={expires}
                min={dayKey(Date.now(), format)}
                onChange={(event) => setExpires(event.target.value)}
              />
            </Field>
          </div>
          {error && <Notice>{error}</Notice>}
          <Button type="submit" disabled={busy || !text.trim()}>
            Add note
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function Memory() {
  const { data: view, error: loadError, loading, update } = usePageData<MemoryView>('/api/memory');
  const format = useDateFormat();
  const phone = usePhone();
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>('all');
  const [scope, setScope] = useState<Scope>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Selection | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [settingError, setSettingError] = useState('');

  async function send(path: string, method: string, body?: object) {
    const next = await api<MemoryUpdate>(path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    update(() => next);
    return next;
  }
  async function setting(body: { saving?: boolean; sensitive?: boolean }) {
    setSettingError('');
    await send('/api/memory', 'PATCH', body).catch((cause) => setSettingError(errorMessage(cause)));
  }

  const counts: Record<Tab, number> = {
    all: view?.notes.length ?? 0,
    archive: view?.archive.length ?? 0,
    ...(Object.fromEntries(
      memoryAreas.map((area) => [area, view?.notes.filter((n) => n.area === area).length ?? 0]),
    ) as Record<MemoryArea, number>),
  };
  const tabs: Tab[] = ['all', ...memoryAreas.filter((area) => counts[area]), 'archive'];
  const active = tabs.includes(tab) ? tab : 'all';
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => !search || text.toLocaleLowerCase().includes(search);
  const notes = (view?.notes ?? []).filter(
    (note) =>
      (active === 'all' || active === note.area) &&
      (!scope || note.inMind === (scope === 'mind')) &&
      matches(note.text),
  );
  const archive = (view?.archive ?? []).filter((item) => matches(item.text));
  const visible: Selection[] =
    active === 'archive'
      ? archive.map((item) => ({ archived: archivedKey(item) }))
      : memoryAreas.flatMap((area) =>
          notes.filter((note) => note.area === area).map((note) => ({ note: note.path })),
        );
  const selection =
    chosen === undefined || (chosen && !exists(chosen)) ? (phone ? null : visible[0]) : chosen;
  const note =
    selection && 'note' in selection
      ? view?.notes.find((n) => n.path === selection.note)
      : undefined;
  const archived =
    selection && 'archived' in selection
      ? view?.archive.find((item) => archivedKey(item) === selection.archived)
      : undefined;
  const detailOpen = Boolean(note || archived);
  const pageMode = phone && detailOpen;

  function exists(value: NonNullable<Selection>) {
    return 'note' in value
      ? notes.some((n) => n.path === value.note)
      : active === 'archive' && archive.some((item) => archivedKey(item) === value.archived);
  }
  function choose(value: Tab) {
    setTab(value);
    setChosen(undefined);
  }
  const back = phone ? () => setChosen(null) : undefined;

  const row = (item: MemoryNote) => (
    <button
      key={item.path}
      type="button"
      className="memory-row"
      aria-current={!phone && note?.path === item.path ? 'true' : undefined}
      onClick={() => setChosen({ note: item.path })}
    >
      <MemoryMark status={item.status} inMind={item.inMind} />
      <span className={cn('memory-row-text', item.status === 'tentative' && 'is-tentative')}>
        {item.text}
      </span>
      <span className="memory-row-meta">
        {item.expires
          ? `Until ${formatCalendarDate(item.expires, format)}`
          : formatDayLabel(item.updated, format)}
      </span>
    </button>
  );

  const list =
    active === 'archive' ? (
      archive.length ? (
        archive.map((item) => (
          <button
            key={archivedKey(item)}
            type="button"
            className="memory-row"
            aria-current={!phone && archived === item ? 'true' : undefined}
            onClick={() => setChosen({ archived: archivedKey(item) })}
          >
            <span className="memory-row-gone" aria-hidden="true" />
            <span className="memory-row-text is-archived">{item.text}</span>
            <span className="memory-row-meta">{reasons[item.reason]}</span>
          </button>
        ))
      ) : (
        <p className="memory-empty">Nothing here. Notes Otto lets go of stay here for a while.</p>
      )
    ) : notes.length ? (
      memoryAreas.map((area) => {
        const group = notes.filter((n) => n.area === area);
        if (!group.length) return null;
        return active === 'all' ? (
          <div key={area} className="memory-group">
            <h3>{areaLabels[area]}</h3>
            {group.map(row)}
          </div>
        ) : (
          group.map(row)
        );
      })
    ) : (
      <p className="memory-empty">
        {search || scope
          ? 'No notes match.'
          : 'Nothing yet. Tell Otto something to remember, or add a note.'}
      </p>
    );

  const detail = note ? (
    <NoteDetail
      key={`${note.path}:${note.updated}`}
      note={note}
      history={(view?.archive ?? []).filter(
        (item) => item.path === note.path || item.by === note.path,
      )}
      onBack={back}
      onChange={async (body) => {
        await send(`/api/memory/notes/${note.path}`, 'PATCH', body);
      }}
      onForget={async () => {
        await send(`/api/memory/notes/${note.path}`, 'DELETE');
        setChosen(undefined);
      }}
    />
  ) : archived ? (
    <ArchivedDetail
      key={archivedKey(archived)}
      item={archived}
      onBack={back}
      onRestore={async () => {
        const next = await send('/api/memory/archive/restore', 'POST', {
          path: archived.path,
          archived: archived.archived,
        });
        setTab('all');
        setChosen(next.path ? { note: next.path } : undefined);
      }}
      onForget={async () => {
        await send('/api/memory/archive/forget', 'POST', {
          path: archived.path,
          archived: archived.archived,
        });
        setChosen(undefined);
      }}
    />
  ) : null;

  return (
    <div className={cn('content-page secondary-page memory-page', pageMode && 'is-detail')}>
      {!pageMode && (
        <header className="page-heading secondary-heading">
          <div>
            <PageTitle path="/memory" />
            <p>What Otto knows about you, and where it learned it.</p>
          </div>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus size={16} aria-hidden="true" />
            Add note
          </Button>
        </header>
      )}
      {loadError && !view && <Notice>Could not load your memory.</Notice>}
      {!view ? (
        loading && <Loading label="Loading memory…" />
      ) : pageMode ? (
        <div className="memory-page-detail" data-analytics-private>
          {detail}
        </div>
      ) : (
        <div data-analytics-private>
          <Reach
            view={view}
            scope={scope}
            onScope={(value) => {
              setScope(value);
              setChosen(undefined);
              if (value && active === 'archive') setTab('all');
            }}
          />
          <div className="memory-bar">
            <SearchField
              className="memory-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search memory"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div
              className="task-views memory-tabs"
              role="tablist"
              aria-label="Memory"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const index = tabs.indexOf(active);
                const next =
                  tabs[
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? tabs.length - 1
                        : (index + (event.key === 'ArrowLeft' ? tabs.length - 1 : 1)) % tabs.length
                  ];
                choose(next);
                document.getElementById(`${tabsId}-${next}`)?.focus();
              }}
            >
              {tabs.map((value) => (
                <button
                  key={value}
                  id={`${tabsId}-${value}`}
                  role="tab"
                  type="button"
                  tabIndex={active === value ? 0 : -1}
                  aria-selected={active === value}
                  aria-controls={`${tabsId}-panel`}
                  onClick={() => choose(value)}
                >
                  {value === 'all' ? 'All' : value === 'archive' ? 'Let go' : areaLabels[value]}
                  <span>{counts[value]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className={cn('memory-layout', detail && !phone && 'has-detail')}>
            <div
              className="memory-list"
              id={`${tabsId}-panel`}
              role="tabpanel"
              aria-labelledby={`${tabsId}-${active}`}
            >
              {list}
            </div>
            {!phone && detail && <div className="memory-detail-column">{detail}</div>}
          </div>
          <footer className="memory-settings">
            <label className="memory-setting">
              <Switch
                checked={view.saving}
                onCheckedChange={(saving) => void setting({ saving })}
              />
              Save new notes
            </label>
            <label className="memory-setting">
              <Switch
                checked={view.sensitive}
                onCheckedChange={(sensitive) => void setting({ sensitive })}
              />
              Remember sensitive topics
              <span className="memory-setting-hint">Health, religion, politics and similar</span>
            </label>
          </footer>
          {settingError && <Notice>{settingError}</Notice>}
        </div>
      )}
      {adding && (
        <AddNote
          area={active !== 'all' && active !== 'archive' ? active : 'about'}
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            const next = await send('/api/memory/notes', 'POST', body);
            setTab('all');
            setScope(null);
            setQuery('');
            setChosen(next.path ? { note: next.path } : undefined);
          }}
        />
      )}
    </div>
  );
}
