import { useState, type FormEvent } from 'react';
import { ArrowRight, ChevronLeft, Plus } from 'lucide-react';
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
import { cn } from '../lib/utils';

type Stage = MemoryStatus | 'archive';
type Selection = { note: string } | { archived: string } | null;

const stages: Array<{ id: Stage; label: string; hint: string }> = [
  {
    id: 'tentative',
    label: 'Mentioned once',
    hint: 'Heard once. A guess until you confirm it or say it again.',
  },
  { id: 'observed', label: 'Learned', hint: 'Heard in two or more messages. Otto uses it.' },
  { id: 'stated', label: 'Confirmed', hint: 'You said it, wrote it or confirmed it.' },
  {
    id: 'archive',
    label: 'Let go',
    hint: 'Replaced, expired or not mentioned for 60 days. You can bring it back.',
  },
];
const stageLabel = Object.fromEntries(stages.map((stage) => [stage.id, stage.label])) as Record<
  Stage,
  string
>;
const areaLabels: Record<MemoryArea, string> = {
  about: 'About you',
  preferences: 'Preferences',
  people: 'People',
  routines: 'Routines',
  lessons: 'Lessons',
};
const profileLabels = {
  name: 'Name',
  location: 'Location',
  phone: 'Phone',
  preferences: 'Preferences',
} as const;
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

const archivedKey = (item: MemoryArchived) => `${item.path}@${item.archived}`;

function MemoryMark({ stage }: { stage: Stage }) {
  return (
    <svg className={cn('memory-mark', stage)} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="memory-mark-ring" cx="8" cy="8" r="5.5" />
      {stage === 'observed' && <path className="memory-mark-fill" d="M8 2.5a5.5 5.5 0 0 0 0 11z" />}
      {stage === 'archive' && <path className="memory-mark-cross" d="M4.1 11.9l7.8-7.8" />}
    </svg>
  );
}

function Stages({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<Stage, number>;
  selected: Stage | null;
  onSelect(stage: Stage | null): void;
}) {
  return (
    <div className="memory-stages" role="group" aria-label="Filter by status">
      {stages.map((stage, index) => (
        <div
          key={stage.id}
          className={cn('memory-stage-slot', stage.id === 'archive' && 'is-apart')}
        >
          <button
            type="button"
            className="memory-stage"
            aria-pressed={selected === stage.id}
            onClick={() => onSelect(selected === stage.id ? null : stage.id)}
          >
            <span className="memory-stage-head">
              <MemoryMark stage={stage.id} />
              {stage.label}
              <span className="memory-stage-count">{counts[stage.id]}</span>
            </span>
            <span className="memory-stage-hint">{stage.hint}</span>
          </button>
          {index < 2 && <ArrowRight className="memory-stage-arrow" size={16} aria-hidden="true" />}
        </div>
      ))}
    </div>
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

function Back({ onBack }: { onBack?: () => void }) {
  return onBack ? (
    <Button variant="ghost" size="sm" className="memory-back" onClick={onBack}>
      <ChevronLeft size={16} aria-hidden="true" />
      Memory
    </Button>
  ) : null;
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
  const cancel = (
    <Button type="button" variant="ghost" size="sm" onClick={() => setMode('view')}>
      Cancel
    </Button>
  );
  return (
    <article className="memory-detail">
      <Back onBack={onBack} />
      <p className="memory-status">
        <MemoryMark stage={note.status} />
        {stageLabel[note.status]}
        {!note.inMind && note.status !== 'tentative' && ' · used when relevant'}
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
            {cancel}
          </div>
        </form>
      ) : (
        <h2 className="memory-text">{note.text}</h2>
      )}
      {mode === 'expires' ? (
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
            {cancel}
          </div>
        </form>
      ) : (
        note.expires && (
          <p className="memory-meta">Until {formatCalendarDate(note.expires, format)}</p>
        )
      )}
      {note.edited && (
        <p className="memory-meta">
          {note.sources.length ? 'Updated by you' : 'Written by you'} ·{' '}
          {formatDayLabel(note.edited, format)}
        </p>
      )}
      <Sources sources={note.sources} />
      {history.map((item) => (
        <p key={archivedKey(item)} className="memory-meta">
          {reasons[item.reason]} “{item.text}” · {formatDayLabel(item.archived, format)}
        </p>
      ))}
      {error && <Notice>{error}</Notice>}
      {mode === 'forget' ? (
        <div className="memory-confirm">
          <p>Forget this note and its earlier versions?</p>
          <div className="memory-actions">
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => run(onForget)}>
              Forget
            </Button>
            {cancel}
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
      <Back onBack={onBack} />
      <p className="memory-status">
        <MemoryMark stage="archive" />
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
  onClose,
  onAdd,
}: {
  onClose(): void;
  onAdd(body: { area: MemoryArea; text: string; expires?: string }): Promise<void>;
}) {
  const format = useDateFormat();
  const [area, setArea] = useState<MemoryArea>('about');
  const [text, setText] = useState('');
  const [expires, setExpires] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onAdd({ area, text: text.trim(), ...(expires ? { expires } : {}) });
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
                value={area}
                onChange={(event) => setArea(event.target.value as MemoryArea)}
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
  const [stage, setStage] = useState<Stage | null>(null);
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
  function filter(next: Stage | null) {
    setStage(next);
    setChosen(undefined);
  }

  const profileFields = (Object.keys(profileLabels) as Array<keyof typeof profileLabels>).filter(
    (field) => view?.profile[field],
  );
  const counts = {
    tentative: 0,
    observed: 0,
    stated: profileFields.length,
    archive: view?.archive.length ?? 0,
  } satisfies Record<Stage, number>;
  for (const note of view?.notes ?? []) counts[note.status]++;
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => !search || text.toLocaleLowerCase().includes(search);
  const notes = (view?.notes ?? []).filter(
    (note) => (!stage || stage === note.status) && matches(note.text),
  );
  const archive =
    stage === 'archive' ? (view?.archive ?? []).filter((item) => matches(item.text)) : [];
  const profile =
    view && (!stage || stage === 'stated')
      ? profileFields.filter((field) => matches(view.profile[field]))
      : [];
  const visible: NonNullable<Selection>[] =
    stage === 'archive'
      ? archive.map((item) => ({ archived: archivedKey(item) }))
      : memoryAreas.flatMap((area) =>
          notes.filter((note) => note.area === area).map((note) => ({ note: note.path })),
        );
  const listed = (value: NonNullable<Selection>) =>
    visible.some((item) =>
      'note' in value
        ? 'note' in item && item.note === value.note
        : 'archived' in item && item.archived === value.archived,
    );
  const selection =
    chosen === undefined || (chosen && !listed(chosen)) ? (phone ? null : visible[0]) : chosen;
  const note =
    selection && 'note' in selection
      ? view?.notes.find((n) => n.path === selection.note)
      : undefined;
  const archived =
    selection && 'archived' in selection
      ? view?.archive.find((item) => archivedKey(item) === selection.archived)
      : undefined;
  const pageMode = phone && Boolean(note || archived);
  const back = phone ? () => setChosen(null) : undefined;

  const row = (item: MemoryNote) => (
    <button
      key={item.path}
      type="button"
      className="memory-row"
      aria-current={!phone && note?.path === item.path ? 'true' : undefined}
      onClick={() => setChosen({ note: item.path })}
    >
      <MemoryMark stage={item.status} />
      <span className={cn('memory-row-text', item.status === 'tentative' && 'is-muted')}>
        {item.text}
      </span>
      <span className="memory-row-meta">
        {stage
          ? item.expires && `Until ${formatCalendarDate(item.expires, format)}`
          : stageLabel[item.status]}
      </span>
    </button>
  );

  const list =
    stage === 'archive' ? (
      archive.length ? (
        archive.map((item) => (
          <button
            key={archivedKey(item)}
            type="button"
            className="memory-row"
            aria-current={!phone && archived === item ? 'true' : undefined}
            onClick={() => setChosen({ archived: archivedKey(item) })}
          >
            <MemoryMark stage="archive" />
            <span className="memory-row-text is-muted">{item.text}</span>
            <span className="memory-row-meta">{reasons[item.reason]}</span>
          </button>
        ))
      ) : (
        <p className="memory-empty">Nothing here.</p>
      )
    ) : notes.length || profile.length ? (
      <>
        {profile.length > 0 && view && (
          <div className="memory-group">
            <h3>Profile</h3>
            {profile.map((field) => (
              <div key={field} className="memory-row is-static">
                <MemoryMark stage="stated" />
                <span className="memory-row-text" title={view.profile[field]}>
                  {profileLabels[field]}: {view.profile[field]}
                </span>
                <span className="memory-row-meta">{stage ? '' : stageLabel.stated}</span>
              </div>
            ))}
          </div>
        )}
        {memoryAreas.map((area) => {
          const group = notes.filter((n) => n.area === area);
          return group.length ? (
            <div key={area} className="memory-group">
              <h3>{areaLabels[area]}</h3>
              {group.map(row)}
            </div>
          ) : null;
        })}
      </>
    ) : (
      <p className="memory-empty">
        {search || stage
          ? 'Nothing here.'
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
        setStage(null);
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
          <PageTitle path="/memory" />
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
          <Stages counts={counts} selected={stage} onSelect={filter} />
          <div className="memory-bar">
            <SearchField
              className="memory-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search memory"
              onChange={(event) => setQuery(event.target.value)}
            />
            {stage && (
              <Button variant="ghost" size="sm" onClick={() => filter(null)}>
                Show all
              </Button>
            )}
          </div>
          <div className={cn('memory-layout', detail && !phone && 'has-detail')}>
            <div className="memory-list">{list}</div>
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
          onClose={() => setAdding(false)}
          onAdd={async (body) => {
            const next = await send('/api/memory/notes', 'POST', body);
            setStage(null);
            setQuery('');
            setChosen(next.path ? { note: next.path } : undefined);
          }}
        />
      )}
    </div>
  );
}
