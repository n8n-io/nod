import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Check, ChevronLeft, Copy, Download, Plus, Undo2, Upload, X } from '../components/icons';
import {
  areaLabels,
  memoryAreas,
  noteChars,
  skillChars,
  skillDescriptionChars,
  type LearnedSkill,
  type MemoryArchived,
  type MemoryArea,
  type MemoryImported,
  type MemoryNote,
  type MemorySource,
  type MemoryStatus,
  type MemoryUpdate,
  type MemoryView,
} from '../../shared/memory';
import { memoryImportPrompt, parseMemoryImport, type ImportedNote } from '../lib/memory-import';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Field,
  Loading,
  Notice,
  SearchField,
  Switch,
} from '../components/ui';
import { usePageData } from '../hooks/use-page-data';
import { api, errorMessage } from '../lib/api';
import { exportMemory } from '../lib/memory-export';
import {
  dayKey,
  formatCalendarDate,
  formatDayLabel,
  formatNumber,
  useDateFormat,
} from '../lib/date-format';
import { cn } from '../lib/utils';

type Stage = MemoryStatus | 'archive' | 'skills';
type Selection = { note: string } | { archived: string } | { skill: string } | null;

const stages: Array<{ id: Stage; label: string; hint: string }> = [
  {
    id: 'tentative',
    label: 'Mentioned once',
    hint: 'Heard once. A guess until you confirm it or say it again.',
  },
  { id: 'observed', label: 'Learned', hint: 'Heard in two or more messages. Nod uses it.' },
  { id: 'stated', label: 'Confirmed', hint: 'You said it, wrote it or confirmed it.' },
  {
    id: 'archive',
    label: 'Let go',
    hint: 'Replaced, expired or not mentioned for 60 days. You can bring it back.',
  },
  {
    id: 'skills',
    label: 'Skills',
    hint: 'How Nod did a task, written by Nod from what it did and read. It follows them next time.',
  },
];
const stageLabel = Object.fromEntries(stages.map((stage) => [stage.id, stage.label])) as Record<
  Stage,
  string
>;
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
  web: 'Nod web',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
};

const archivedKey = (item: MemoryArchived) => `${item.path}@${item.archived}`;
const noteCount = (count: number) => (count === 1 ? '1 note' : `${formatNumber(count)} notes`);
const skillTitle = (name: string) =>
  `${name[0]!.toUpperCase()}${name.slice(1).replaceAll('-', ' ')}`;
function useCompact() {
  const [panel, setPanel] = useState<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (!panel || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width <= 640));
    observer.observe(panel);
    return () => observer.disconnect();
  }, [panel]);
  return [compact, setPanel] as const;
}

function MemoryMark({ stage }: { stage: Stage }) {
  return (
    <svg className={cn('memory-mark', stage)} viewBox="0 0 16 16" aria-hidden="true">
      <circle className="memory-mark-ring" cx="8" cy="8" r="5.5" />
      {stage === 'observed' && <path className="memory-mark-fill" d="M8 2.5a5.5 5.5 0 0 0 0 11z" />}
      {stage === 'archive' && <path className="memory-mark-cross" d="M4.1 11.9l7.8-7.8" />}
      {stage === 'skills' && <path className="memory-mark-cross" d="M5.5 6.5h5M5.5 9.5h5" />}
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
      <button
        type="button"
        className="memory-stage"
        aria-pressed={!selected}
        onClick={() => onSelect(null)}
      >
        All
        <span className="memory-stage-count">
          {counts.tentative + counts.observed + counts.stated}
        </span>
      </button>
      {stages.map((stage) => (
        <button
          key={stage.id}
          type="button"
          className="memory-stage"
          aria-pressed={selected === stage.id}
          title={stage.hint}
          onClick={() => onSelect(selected === stage.id ? null : stage.id)}
        >
          <MemoryMark stage={stage.id} />
          {stage.label}
          <span className="memory-stage-count">{counts[stage.id]}</span>
        </button>
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
  onDirtyChange,
}: {
  note: MemoryNote;
  history: MemoryArchived[];
  onChange(body: { text?: string; expires?: string | null; confirm?: true }): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const format = useDateFormat();
  const [mode, setMode] = useState<'view' | 'edit' | 'expires' | 'forget'>('view');
  const [text, setText] = useState(note.text);
  const [expires, setExpires] = useState(note.expires ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const dirty =
    (mode === 'edit' && text.trim() !== note.text) ||
    (mode === 'expires' && (expires || null) !== note.expires);
  useEffect(() => {
    if (error && !busy) form.current?.querySelector<HTMLElement>('textarea,input')?.focus();
  }, [error, busy]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
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
    if (busy || (mode === 'edit' && !text.trim())) return;
    const body = mode === 'edit' ? { text: text.trim() } : { expires: expires || null };
    const unchanged = 'text' in body ? body.text === note.text : body.expires === note.expires;
    if (unchanged) setMode('view');
    else void run(() => onChange(body));
  }
  const cancel = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={busy}
      onClick={() => {
        setText(note.text);
        setExpires(note.expires ?? '');
        setError('');
        setMode('view');
      }}
    >
      Cancel
    </Button>
  );
  return (
    <article className="memory-detail">
      <Back onBack={onBack} />
      <p className="memory-status">
        <MemoryMark stage={note.status} />
        {stageLabel[note.status]}
      </p>
      {mode === 'edit' ? (
        <form
          ref={form}
          className="memory-form"
          onSubmit={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              event.stopPropagation();
              if (!dirty) setMode('view');
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!busy && text.trim() && !event.nativeEvent.isComposing)
                event.currentTarget.requestSubmit();
            }
          }}
        >
          <textarea
            className="input"
            disabled={busy}
            value={text}
            maxLength={noteChars}
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
        <h4 className="memory-text">{note.text}</h4>
      )}
      {mode === 'expires' ? (
        <form
          ref={form}
          className="memory-form"
          onSubmit={save}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              event.stopPropagation();
              if (!dirty) setMode('view');
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!busy && !event.nativeEvent.isComposing) event.currentTarget.requestSubmit();
            }
          }}
        >
          <input
            className="input"
            type="date"
            disabled={busy}
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
      {note.learnedFrom === 'email' && (
        <p className="memory-meta">
          Learned from your sent email · {formatDayLabel(note.updated, format)}
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
      <h4 className="memory-text is-archived">{item.text}</h4>
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

function SkillDetail({
  skill,
  onChange,
  onForget,
  onBack,
  onDirtyChange,
}: {
  skill: LearnedSkill;
  onChange(body: { description: string; body: string }): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const format = useDateFormat();
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view');
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dirty =
    mode === 'edit' && (description.trim() !== skill.description || body.trim() !== skill.body);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
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
    const next = { description: description.trim(), body: body.trim() };
    if (next.description === skill.description && next.body === skill.body) setMode('view');
    else void run(() => onChange(next));
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
        <MemoryMark stage="skills" />
        Skill
      </p>
      {mode === 'edit' ? (
        <form className="memory-form" onSubmit={save}>
          <input
            className="input"
            value={description}
            maxLength={skillDescriptionChars}
            aria-label="When to use it"
            autoFocus
            onChange={(event) => setDescription(event.target.value)}
          />
          <textarea
            className="input memory-skill-body"
            value={body}
            maxLength={skillChars}
            rows={14}
            aria-label="Steps"
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="memory-actions">
            <Button type="submit" size="sm" disabled={busy || !description.trim() || !body.trim()}>
              Save
            </Button>
            {cancel}
          </div>
        </form>
      ) : (
        <>
          <h4 className="memory-text">{skillTitle(skill.name)}</h4>
          <p className="memory-meta">{skill.description}</p>
          <pre className="memory-skill-body">{skill.body}</pre>
        </>
      )}
      {skill.task && (
        <figure className="memory-source">
          <blockquote>“{skill.task}”</blockquote>
          <figcaption>Learned · {formatDayLabel(skill.learned, format)}</figcaption>
        </figure>
      )}
      <p className="memory-meta">
        {skill.edited ? 'Edited by you' : 'Updated by Nod'} ·{' '}
        {formatDayLabel(skill.edited ?? skill.updated, format)}
      </p>
      {error && <Notice>{error}</Notice>}
      {mode === 'forget' ? (
        <div className="memory-confirm">
          <p>Forget this skill?</p>
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDescription(skill.description);
                setBody(skill.body);
                setMode('edit');
              }}
            >
              Edit
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
            maxLength={noteChars}
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

function ImportNotes({
  onClose,
  onFinish,
  onImport,
}: {
  onClose(): void;
  onFinish(): void;
  onImport(notes: ImportedNote[]): Promise<MemoryImported | undefined>;
}) {
  const answer = useRef<HTMLTextAreaElement>(null);
  const prompt = useRef<HTMLPreElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [removed, setRemoved] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<MemoryImported>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const notes = parseMemoryImport(text);
  const kept = notes.filter((_, index) => !removed.has(index));
  async function copy() {
    setError('');
    try {
      await navigator.clipboard.writeText(memoryImportPrompt);
      setCopied(true);
      answer.current?.focus();
    } catch {
      if (prompt.current) window.getSelection()?.selectAllChildren(prompt.current);
      setError('Could not copy to the clipboard. The prompt is selected, so copy it yourself.');
    }
  }
  function change(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setText(value);
    setRemoved(new Set());
    if (
      (event.nativeEvent as InputEvent).inputType === 'insertFromPaste' &&
      parseMemoryImport(value).length
    )
      setReviewing(true);
  }
  function toggle(index: number) {
    const next = new Set(removed);
    if (!next.delete(index)) next.add(index);
    setRemoved(next);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reviewing) return setReviewing(true);
    setBusy(true);
    setError('');
    try {
      setResult(await onImport(kept));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        className="memory-dialog memory-import"
        data-analytics-private
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          copyButton.current?.focus();
        }}
      >
        <DialogTitle>
          {!result ? 'Import memory' : result.added ? 'Memory imported' : 'Nothing new to add'}
        </DialogTitle>
        <DialogDescription>
          {result
            ? [
                result.added
                  ? `Nod now knows ${formatNumber(result.added)} more ${result.added === 1 ? 'thing' : 'things'} about you.`
                  : '',
                result.existing
                  ? `${formatNumber(result.existing)} ${result.existing === 1 ? 'was' : 'were'} already saved.`
                  : '',
                result.skipped
                  ? `${formatNumber(result.skipped)} looked like a password or card number, so Nod left ${result.skipped === 1 ? 'it' : 'them'} out.`
                  : '',
              ]
                .filter(Boolean)
                .join(' ')
            : reviewing
              ? 'Remove anything you don’t want Nod to keep.'
              : 'Copy this prompt into ChatGPT, Claude or Gemini, then paste its answer below.'}
        </DialogDescription>
        {result ? (
          <div className="memory-form">
            <Button autoFocus onClick={onFinish}>
              Continue using Nod
            </Button>
          </div>
        ) : (
          <form className="memory-form" onSubmit={submit}>
            {reviewing ? (
              <div className="memory-import-review">
                {memoryAreas.map((area) => {
                  const group = notes.flatMap((note, index) =>
                    note.area === area ? [{ ...note, index }] : [],
                  );
                  return group.length ? (
                    <section key={area} className="memory-group">
                      <h3>{areaLabels[area]}</h3>
                      <ul>
                        {group.map((note) => {
                          const gone = removed.has(note.index);
                          return (
                            <li
                              key={note.index}
                              className={cn('memory-import-note', gone && 'is-removed')}
                            >
                              <span>{note.text}</span>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                disabled={busy}
                                aria-label={`${gone ? 'Keep' : 'Remove'} “${note.text}”`}
                                title={gone ? 'Keep' : 'Remove'}
                                onClick={() => toggle(note.index)}
                              >
                                {gone ? (
                                  <Undo2 size={14} aria-hidden="true" />
                                ) : (
                                  <X size={14} aria-hidden="true" />
                                )}
                              </Button>
                            </li>
                          );
                        })}
                      </ul>
                    </section>
                  ) : null;
                })}
              </div>
            ) : (
              <>
                <div className="memory-import-prompt">
                  <pre ref={prompt} tabIndex={0} role="region" aria-label="Prompt">
                    {memoryImportPrompt}
                  </pre>
                  <Button
                    ref={copyButton}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void copy()}
                  >
                    {copied ? (
                      <Check size={16} aria-hidden="true" />
                    ) : (
                      <Copy size={16} aria-hidden="true" />
                    )}
                    {copied ? 'Copied' : 'Copy prompt'}
                  </Button>
                </div>
                <textarea
                  ref={answer}
                  className="input"
                  value={text}
                  rows={4}
                  placeholder="Paste the answer here"
                  aria-label="Answer"
                  onChange={change}
                />
              </>
            )}
            {error && <Notice>{error}</Notice>}
            {(reviewing || text.trim()) && (
              <div className="memory-import-actions">
                {reviewing && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setReviewing(false);
                      requestAnimationFrame(() => answer.current?.focus());
                    }}
                  >
                    Back
                  </Button>
                )}
                <Button type="submit" disabled={busy || !kept.length}>
                  {!kept.length
                    ? reviewing
                      ? 'Import'
                      : 'Review notes'
                    : `${reviewing ? 'Import' : 'Review'} ${noteCount(kept.length)}`}
                </Button>
              </div>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Memory({
  onDone,
  onDirtyChange,
}: {
  onDone(): void;
  onDirtyChange?(dirty: boolean): void;
}) {
  const { data: view, error: loadError, loading, update } = usePageData<MemoryView>('/api/memory');
  const format = useDateFormat();
  const [compact, panelRef] = useCompact();
  const [stage, setStage] = useState<Stage | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<Selection | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const [settingError, setSettingError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(0);
  useEffect(() => {
    onDirtyChange?.(dirty || saving > 0 || exporting);
    return () => onDirtyChange?.(false);
  }, [dirty, saving, exporting, onDirtyChange]);

  async function send(path: string, method: string, body?: object) {
    setSaving((count) => count + 1);
    try {
      const next = await api<MemoryUpdate>(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      update(() => next);
      return next;
    } finally {
      setSaving((count) => count - 1);
    }
  }
  async function setting(body: { saving?: boolean; sensitive?: boolean }) {
    setSettingError('');
    await send('/api/memory', 'PATCH', body).catch((cause) => setSettingError(errorMessage(cause)));
  }
  function filter(next: Stage | null) {
    setStage(next);
    setChosen(undefined);
  }

  const counts = {
    tentative: 0,
    observed: 0,
    stated: 0,
    archive: view?.archive.length ?? 0,
    skills: view?.skills.length ?? 0,
  } satisfies Record<Stage, number>;
  for (const note of view?.notes ?? []) counts[note.status]++;
  const search = query.trim().toLocaleLowerCase();
  const matches = (text: string) => !search || text.toLocaleLowerCase().includes(search);
  const notes = (view?.notes ?? []).filter(
    (note) => (!stage || stage === note.status) && matches(note.text),
  );
  const archive =
    stage === 'archive' ? (view?.archive ?? []).filter((item) => matches(item.text)) : [];
  const skills =
    stage === 'skills'
      ? (view?.skills ?? []).filter((item) =>
          matches(`${item.name} ${item.description} ${item.body}`),
        )
      : [];
  const visible: NonNullable<Selection>[] =
    stage === 'archive'
      ? archive.map((item) => ({ archived: archivedKey(item) }))
      : stage === 'skills'
        ? skills.map((item) => ({ skill: item.name }))
        : memoryAreas.flatMap((area) =>
            notes.filter((note) => note.area === area).map((note) => ({ note: note.path })),
          );
  const listed = (value: NonNullable<Selection>) =>
    visible.some((item) =>
      'note' in value
        ? 'note' in item && item.note === value.note
        : 'archived' in value
          ? 'archived' in item && item.archived === value.archived
          : 'skill' in item && item.skill === value.skill,
    );
  const selection =
    chosen === undefined || (chosen && !listed(chosen)) ? (compact ? null : visible[0]) : chosen;
  const note =
    selection && 'note' in selection
      ? view?.notes.find((n) => n.path === selection.note)
      : undefined;
  const archived =
    selection && 'archived' in selection
      ? view?.archive.find((item) => archivedKey(item) === selection.archived)
      : undefined;
  const skill =
    selection && 'skill' in selection
      ? view?.skills.find((item) => item.name === selection.skill)
      : undefined;
  const pageMode = compact && Boolean(note || archived || skill);
  const back = compact ? () => setChosen(null) : undefined;

  const row = (item: MemoryNote) => (
    <button
      key={item.path}
      type="button"
      className="memory-row"
      aria-current={!compact && note?.path === item.path ? 'true' : undefined}
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
    stage === 'skills' ? (
      skills.length ? (
        skills.map((item) => (
          <button
            key={item.name}
            type="button"
            className="memory-row"
            aria-current={!compact && skill === item ? 'true' : undefined}
            onClick={() => setChosen({ skill: item.name })}
          >
            <MemoryMark stage="skills" />
            <span className="memory-row-text">{skillTitle(item.name)}</span>
            <span className="memory-row-meta">{formatDayLabel(item.updated, format)}</span>
          </button>
        ))
      ) : (
        <p className="memory-empty">
          {search ? 'Nothing here.' : 'Nothing yet. Nod writes one after a task worth repeating.'}
        </p>
      )
    ) : stage === 'archive' ? (
      archive.length ? (
        archive.map((item) => (
          <button
            key={archivedKey(item)}
            type="button"
            className="memory-row"
            aria-current={!compact && archived === item ? 'true' : undefined}
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
    ) : notes.length ? (
      memoryAreas.map((area) => {
        const group = notes.filter((n) => n.area === area);
        return group.length ? (
          <div key={area} className="memory-group">
            <h4>{areaLabels[area]}</h4>
            {group.map(row)}
          </div>
        ) : null;
      })
    ) : (
      <p className="memory-empty">
        {search || stage ? (
          'Nothing here.'
        ) : (
          <>
            Nothing yet. Tell Nod something to remember, add a note or{' '}
            <button type="button" onClick={() => setImporting(true)}>
              import from another assistant
            </button>
            .
          </>
        )}
      </p>
    );

  const detail = note ? (
    <NoteDetail
      key={`${note.path}:${note.updated}`}
      note={note}
      onDirtyChange={setDirty}
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
  ) : skill ? (
    <SkillDetail
      key={`${skill.name}:${skill.updated}`}
      skill={skill}
      onDirtyChange={setDirty}
      onBack={back}
      onChange={async (body) => {
        await send(`/api/memory/skills/${skill.name}`, 'PATCH', body);
      }}
      onForget={async () => {
        await send(`/api/memory/skills/${skill.name}`, 'DELETE');
        setChosen(undefined);
      }}
    />
  ) : null;

  return (
    <div className="memory-panel" ref={panelRef} data-analytics-private>
      {loadError && !view && <Notice>Could not load your memory.</Notice>}
      {!view ? (
        loading && <Loading label="Loading memory…" />
      ) : pageMode ? (
        detail
      ) : (
        <>
          <div className="memory-bar">
            <SearchField
              className="memory-search"
              type="search"
              value={query}
              placeholder="Search"
              aria-label="Search memory"
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              ref={importButton}
              variant="ghost"
              size="sm"
              aria-label="Import"
              title="Import"
              onClick={() => setImporting(true)}
            >
              <Upload size={16} aria-hidden="true" />
              <span className="memory-bar-label">Import</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Export"
              title="Export"
              disabled={exporting}
              onClick={() => {
                setExporting(true);
                setSettingError('');
                exportMemory()
                  .catch((cause) => setSettingError(errorMessage(cause)))
                  .finally(() => setExporting(false));
              }}
            >
              <Download size={16} aria-hidden="true" />
              <span className="memory-bar-label">Export</span>
            </Button>
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" />
              Add note
            </Button>
          </div>
          <Stages counts={counts} selected={stage} onSelect={filter} />
          {stage && <p className="memory-hint">{stages.find((item) => item.id === stage)?.hint}</p>}
          <div className={cn('memory-layout', detail && !compact && 'has-detail')}>
            <div className="memory-list">{list}</div>
            {!compact && detail && <div className="memory-detail-column">{detail}</div>}
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
        </>
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
      {importing && (
        <ImportNotes
          onClose={() => {
            setImporting(false);
            requestAnimationFrame(() => importButton.current?.focus());
          }}
          onFinish={() => {
            setImporting(false);
            onDone();
          }}
          onImport={async (notes) => {
            const next = await send('/api/memory/import', 'POST', { notes });
            setStage(null);
            setQuery('');
            setChosen(undefined);
            return next.imported;
          }}
        />
      )}
    </div>
  );
}
