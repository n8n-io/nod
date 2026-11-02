import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  Copy,
  Download,
  Ellipsis,
  FileArchive,
  Import,
  MessageCircle,
  PenLine,
  Plus,
  Trash2,
  Undo2,
  X,
} from '../components/icons';
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
import { Tooltip } from '../components/tooltip';
import { ActionMenu, ActionMenuItem } from '../components/action-menu';
import { useSettingsDraft } from '../components/settings-drafts';
import {
  dayKey,
  formatCalendarDate,
  formatDayLabel,
  formatNumber,
  useDateFormat,
} from '../lib/date-format';
import { cn } from '../lib/utils';
import { isPrimaryModifier } from '../lib/navigation';

type Stage = MemoryStatus | 'archive' | 'skills';
type Selection = { note: string } | { archived: string } | { skill: string } | null;

export type MemoryNavigationState = {
  stage: Stage | null;
  query: string;
  selection: Selection;
  detailsOpen: boolean;
};

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
  manual: 'Archived by you',
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
  return [compact, setPanel, panel] as const;
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
  disabled,
}: {
  counts: Record<Stage, number>;
  selected: Stage | null;
  onSelect(stage: Stage | null): void;
  disabled?: boolean;
}) {
  return (
    <div className="memory-stages" role="group" aria-label="Filter by status">
      <button
        type="button"
        className="memory-stage"
        disabled={disabled}
        aria-pressed={!selected}
        onClick={() => onSelect(null)}
      >
        All
        <span className="memory-stage-count">
          {counts.tentative + counts.observed + counts.stated}
        </span>
      </button>
      {stages.map((stage) => (
        <Tooltip key={stage.id} content={stage.hint}>
          <button
            type="button"
            className="memory-stage"
            disabled={disabled}
            aria-pressed={selected === stage.id}
            onClick={() => onSelect(selected === stage.id ? null : stage.id)}
          >
            <MemoryMark stage={stage.id} />
            {stage.label}
            <span className="memory-stage-count">{counts[stage.id]}</span>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

function Sources({
  sources,
  onOpenSource,
}: {
  sources: MemorySource[];
  onOpenSource(messageId: string): void;
}) {
  const format = useDateFormat();
  return sources
    .toSorted((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
    .map((source) => (
      <figure key={source.id} className="memory-source">
        {source.canOpenInCurrentChat ? (
          <Button
            variant="ghost"
            size="sm"
            className="memory-source-link"
            onClick={() => onOpenSource(source.id)}
          >
            <MessageCircle size={14} aria-hidden="true" />
            View message
          </Button>
        ) : (
          <blockquote>
            {source.quote || source.text || 'This message is no longer in your chat history.'}
          </blockquote>
        )}
        {source.at && (
          <figcaption>
            {channels[source.channel ?? 'web'] ?? source.channel} ·{' '}
            {formatDayLabel(source.at, format)}
          </figcaption>
        )}
      </figure>
    ));
}

function MemoryDetails({
  updated,
  sources = [],
  history = [],
  origin,
  task,
  onOpenSource,
  initiallyOpen = false,
}: {
  updated: string;
  sources?: MemorySource[];
  history?: MemoryArchived[];
  origin?: string;
  task?: string | null;
  onOpenSource(messageId: string): void;
  initiallyOpen?: boolean;
}) {
  const format = useDateFormat();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="memory-provenance"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        Details
        <ChevronDown size={14} aria-hidden="true" />
      </summary>
      <dl>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={updated}>{formatDayLabel(updated, format)}</time>
          </dd>
        </div>
        <div>
          <dt>{task !== undefined ? 'Original task' : 'Source'}</dt>
          <dd>
            {task !== undefined ? (
              task || 'Source unavailable.'
            ) : sources.length ? (
              <Sources sources={sources} onOpenSource={onOpenSource} />
            ) : (
              origin || 'Source unavailable.'
            )}
          </dd>
        </div>
        {history.length > 0 && (
          <div>
            <dt>Earlier versions</dt>
            <dd className="memory-history">
              {history.map((item) => (
                <p key={archivedKey(item)}>
                  {reasons[item.reason]} “{item.text}” · {formatDayLabel(item.archived, format)}
                </p>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </details>
  );
}

function Back({ onBack, disabled }: { onBack?: () => void; disabled?: boolean }) {
  return onBack ? (
    <Button variant="ghost" size="sm" className="memory-back" disabled={disabled} onClick={onBack}>
      <ChevronLeft size={16} aria-hidden="true" />
      Memory
    </Button>
  ) : null;
}

function NoteDetail({
  note,
  history,
  onChange,
  onArchive,
  onForget,
  onBack,
  onDirtyChange,
  onOpenSource,
  detailsOpen,
}: {
  note: MemoryNote;
  history: MemoryArchived[];
  onChange(body: { text?: string; expires?: string | null; confirm?: true }): Promise<void>;
  onArchive(): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
  onDirtyChange?(dirty: boolean): void;
  onOpenSource(messageId: string): void;
  detailsOpen?: boolean;
}) {
  const format = useDateFormat();
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view');
  const [text, setText] = useState(note.text);
  const [expires, setExpires] = useState(note.expires ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const form = useRef<HTMLFormElement>(null);
  const editFocus = useRef<'textarea' | 'input'>('textarea');
  const latest = useRef({ text, expires, note });
  latest.current = { text, expires, note };
  const changes =
    mode === 'edit'
      ? [
          ...(text.trim() !== note.text
            ? [{ label: 'Note text', before: note.text, after: text.trim() }]
            : []),
          ...((expires || null) !== note.expires
            ? [
                {
                  label: 'Note end date',
                  before: note.expires || 'No end date',
                  after: expires || 'No end date',
                },
              ]
            : []),
        ]
      : [];
  const dirty = changes.length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [dirty, busy, onDirtyChange]);
  useEffect(() => {
    if (mode === 'edit') form.current?.querySelector<HTMLElement>(editFocus.current)?.focus();
  }, [mode]);
  function discard() {
    if (busyRef.current) return;
    setText(latest.current.note.text);
    setExpires(latest.current.note.expires ?? '');
    setError('');
    setMode('view');
  }
  function edit(focus: 'textarea' | 'input' = 'textarea') {
    editFocus.current = focus;
    setText(note.text);
    setExpires(note.expires ?? '');
    setError('');
    setMode('edit');
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveDraft() {
    if (busyRef.current) return false;
    if (!dirty) {
      discard();
      return true;
    }
    if (!text.trim()) {
      setError('Write a note before saving.');
      form.current?.querySelector('textarea')?.focus();
      return false;
    }
    if (!form.current?.reportValidity()) return false;
    const submitted = { text: text.trim(), expires: expires || null };
    const body = {
      ...(submitted.text !== note.text ? { text: submitted.text } : {}),
      ...(submitted.expires !== note.expires ? { expires: submitted.expires } : {}),
    };
    const saved = await run(() => onChange(body));
    if (
      saved &&
      latest.current.text.trim() === submitted.text &&
      (latest.current.expires || null) === submitted.expires
    )
      setMode('view');
    return saved;
  }
  useSettingsDraft(`memory-note:${note.path}`, { changes, busy, save: saveDraft, discard });
  return (
    <article className="memory-detail">
      <Back onBack={onBack} disabled={dirty || busy} />
      <div className="memory-detail-header">
        <p className="memory-status">
          <MemoryMark stage={note.status} />
          {stageLabel[note.status]}
        </p>
        {mode === 'view' && (
          <ActionMenu
            label="Note options"
            disabled={busy}
            contentClassName="memory-note-menu"
            trigger={
              <Button variant="ghost" size="icon" title="Note options">
                <Ellipsis size={18} aria-hidden="true" />
              </Button>
            }
          >
            {(close) => (
              <>
                <ActionMenuItem
                  onClick={() => {
                    close();
                    edit();
                  }}
                >
                  <PenLine size={16} aria-hidden="true" />
                  Edit note
                </ActionMenuItem>
                <ActionMenuItem
                  onClick={() => {
                    close();
                    edit('input');
                  }}
                >
                  <CalendarClock size={16} aria-hidden="true" />
                  {note.expires ? 'Change end date' : 'Set end date'}
                </ActionMenuItem>
                {note.status !== 'stated' && (
                  <ActionMenuItem
                    onClick={() => {
                      close();
                      void run(() => onChange({ confirm: true }));
                    }}
                  >
                    <Check size={16} aria-hidden="true" />
                    Confirm note
                  </ActionMenuItem>
                )}
                <div className="memory-menu-separator" role="separator" />
                <ActionMenuItem
                  onClick={() => {
                    close();
                    void run(onArchive);
                  }}
                >
                  <FileArchive size={16} aria-hidden="true" />
                  Archive note
                </ActionMenuItem>
                <ActionMenuItem
                  destructive
                  onClick={() => {
                    close();
                    setMode('forget');
                  }}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  Forget note…
                </ActionMenuItem>
              </>
            )}
          </ActionMenu>
        )}
      </div>
      {mode === 'edit' ? (
        <form
          ref={form}
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              event.stopPropagation();
              if (!dirty) discard();
            }
            if (
              event.key === 'Enter' &&
              isPrimaryModifier(event) &&
              !event.altKey &&
              !event.shiftKey &&
              !event.repeat
            ) {
              event.preventDefault();
              if (!busy) event.currentTarget.requestSubmit();
            }
          }}
        >
          <Field label="Note">
            <textarea
              className="input"
              value={text}
              maxLength={noteChars}
              rows={4}
              required
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Field label="Keep until">
            <input
              className="input"
              type="date"
              value={expires}
              min={expires === (note.expires ?? '') ? undefined : dayKey(Date.now(), format)}
              onChange={(event) => setExpires(event.target.value)}
            />
          </Field>
          <div className="memory-actions">
            <Button type="submit" size="sm" disabled={busy || !text.trim() || !dirty}>
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={discard}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <h4 className="memory-text">{note.text}</h4>
      )}
      {mode !== 'edit' && note.expires && (
        <Button
          variant="ghost"
          size="sm"
          className="memory-end-date"
          disabled={busy || mode !== 'view'}
          onClick={() => edit('input')}
        >
          <CalendarClock size={15} aria-hidden="true" />
          Keep until {formatCalendarDate(note.expires, format)}
        </Button>
      )}
      {error && <Notice>{error}</Notice>}
      {mode === 'forget' ? (
        <div className="memory-confirm">
          <p>Forget this note and its earlier versions?</p>
          <div className="memory-actions">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(onForget)}
            >
              Forget note
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>
              Keep note
            </Button>
          </div>
        </div>
      ) : (
        mode === 'view' && (
          <div className="memory-actions">
            <Button variant="outline" size="sm" disabled={busy} onClick={() => edit()}>
              <PenLine size={15} aria-hidden="true" />
              Edit
            </Button>
          </div>
        )
      )}
      {mode === 'view' && (
        <MemoryDetails
          initiallyOpen={detailsOpen}
          updated={note.updated}
          sources={note.sources}
          history={history}
          origin={
            note.learnedFrom === 'email'
              ? 'Learned from your sent email.'
              : note.edited
                ? 'Written by you.'
                : undefined
          }
          onOpenSource={onOpenSource}
        />
      )}
    </article>
  );
}

function ArchivedDetail({
  item,
  onRestore,
  onForget,
  onBack,
  onOpenSource,
  detailsOpen,
}: {
  item: MemoryArchived;
  onRestore(): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
  onOpenSource(messageId: string): void;
  detailsOpen?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <article className="memory-detail">
      <Back onBack={onBack} disabled={busy} />
      <div className="memory-detail-header">
        <p className="memory-status">
          <MemoryMark stage="archive" />
          Let go
        </p>
        <ActionMenu
          label="Archived note options"
          disabled={busy || forgetting}
          contentClassName="memory-note-menu"
          trigger={
            <Button variant="ghost" size="icon" title="Archived note options">
              <Ellipsis size={18} aria-hidden="true" />
            </Button>
          }
        >
          {(close) => (
            <>
              <ActionMenuItem
                onClick={() => {
                  close();
                  void run(onRestore);
                }}
              >
                <Undo2 size={16} aria-hidden="true" />
                Restore note
              </ActionMenuItem>
              <ActionMenuItem
                destructive
                onClick={() => {
                  close();
                  setForgetting(true);
                }}
              >
                <Trash2 size={16} aria-hidden="true" />
                Forget note…
              </ActionMenuItem>
            </>
          )}
        </ActionMenu>
      </div>
      <h4 className="memory-text is-archived">{item.text}</h4>
      <p className="memory-meta">{reasons[item.reason]}</p>
      {error && <Notice>{error}</Notice>}
      {forgetting ? (
        <div className="memory-confirm">
          <p>Forget this archived note?</p>
          <div className="memory-actions">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(onForget)}
            >
              Forget note
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setForgetting(false)}>
              Keep note
            </Button>
          </div>
        </div>
      ) : (
        <div className="memory-actions">
          <Button size="sm" disabled={busy} onClick={() => void run(onRestore)}>
            <Undo2 size={15} aria-hidden="true" />
            Bring back
          </Button>
        </div>
      )}
      <MemoryDetails
        updated={item.archived}
        sources={item.sources}
        onOpenSource={onOpenSource}
        initiallyOpen={detailsOpen}
      />
    </article>
  );
}

function SkillDetail({
  skill,
  onChange,
  onForget,
  onBack,
  onDirtyChange,
  onOpenSource,
}: {
  skill: LearnedSkill;
  onChange(body: { description: string; body: string }): Promise<void>;
  onForget(): Promise<void>;
  onBack?: () => void;
  onDirtyChange?(dirty: boolean): void;
  onOpenSource(messageId: string): void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'forget'>('view');
  const [description, setDescription] = useState(skill.description);
  const [body, setBody] = useState(skill.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  const latest = useRef({ description, body, skill });
  latest.current = { description, body, skill };
  const changes =
    mode === 'edit'
      ? [
          ...(description.trim() !== skill.description
            ? [{ label: 'Skill description', before: skill.description, after: description.trim() }]
            : []),
          ...(body.trim() !== skill.body
            ? [{ label: 'Skill steps', before: skill.body, after: body.trim() }]
            : []),
        ]
      : [];
  const dirty = changes.length > 0;
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
    return () => onDirtyChange?.(false);
  }, [dirty, busy, onDirtyChange]);
  function discard() {
    if (busyRef.current) return;
    setDescription(latest.current.skill.description);
    setBody(latest.current.skill.body);
    setError('');
    setMode('view');
  }
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveDraft() {
    if (busyRef.current) return false;
    if (!description.trim() || !body.trim()) {
      setError('Add a description and steps before saving.');
      return false;
    }
    if (!dirty) {
      discard();
      return true;
    }
    const submitted = { description: description.trim(), body: body.trim() };
    const saved = await run(() => onChange(submitted));
    if (
      saved &&
      latest.current.description.trim() === submitted.description &&
      latest.current.body.trim() === submitted.body
    )
      setMode('view');
    return saved;
  }
  useSettingsDraft(`memory-skill:${skill.name}`, { changes, busy, save: saveDraft, discard });
  return (
    <article className="memory-detail">
      <Back onBack={onBack} disabled={dirty || busy} />
      <p className="memory-status">
        <MemoryMark stage="skills" />
        Skill
      </p>
      {mode === 'edit' ? (
        <form
          className="memory-form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveDraft();
          }}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            if (event.key === 'Escape' && !busy) {
              event.preventDefault();
              event.stopPropagation();
              if (!dirty) discard();
            }
            if (
              event.key === 'Enter' &&
              isPrimaryModifier(event) &&
              !event.altKey &&
              !event.shiftKey &&
              !event.repeat
            ) {
              event.preventDefault();
              if (!busy) event.currentTarget.requestSubmit();
            }
          }}
        >
          <Field label="When to use it">
            <input
              className="input"
              value={description}
              maxLength={skillDescriptionChars}
              required
              autoFocus
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          <Field label="Steps">
            <textarea
              className="input memory-skill-body"
              value={body}
              maxLength={skillChars}
              rows={12}
              required
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <div className="memory-actions">
            <Button
              type="submit"
              size="sm"
              disabled={busy || !description.trim() || !body.trim() || !dirty}
            >
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={discard}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          <h4 className="memory-text">{skillTitle(skill.name)}</h4>
          <p className="memory-meta">{skill.description}</p>
          <pre className="memory-skill-body">{skill.body}</pre>
        </>
      )}
      {error && <Notice>{error}</Notice>}
      {mode === 'forget' ? (
        <div className="memory-confirm">
          <p>Forget this skill?</p>
          <div className="memory-actions">
            <Button
              variant="destructive"
              size="sm"
              disabled={busy}
              onClick={() => void run(onForget)}
            >
              Forget skill
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={discard}>
              Keep skill
            </Button>
          </div>
        </div>
      ) : (
        mode === 'view' && (
          <div className="memory-actions">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDescription(skill.description);
                setBody(skill.body);
                setMode('edit');
              }}
            >
              <PenLine size={15} aria-hidden="true" />
              Edit skill
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setMode('forget')}>
              Forget skill
            </Button>
          </div>
        )
      )}
      {mode === 'view' && (
        <MemoryDetails updated={skill.updated} task={skill.task} onOpenSource={onOpenSource} />
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
  onOpenSource,
  initialView,
}: {
  onDone(): void;
  onDirtyChange?(dirty: boolean): void;
  onOpenSource?(messageId: string, view: MemoryNavigationState): void;
  initialView?: MemoryNavigationState;
}) {
  const { data: view, error: loadError, loading, update } = usePageData<MemoryView>('/api/memory');
  const format = useDateFormat();
  const [compact, panelRef, panel] = useCompact();
  const [restoredView] = useState(initialView);
  const [stage, setStage] = useState<Stage | null>(initialView?.stage ?? null);
  const [query, setQuery] = useState(initialView?.query ?? '');
  const [chosen, setChosen] = useState<Selection | undefined>(initialView?.selection);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const importButton = useRef<HTMLButtonElement>(null);
  const [settingError, setSettingError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(0);
  const requests = useRef(new Set<AbortController>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, []);
  useSettingsDraft('memory-operations', {
    changes: [],
    busy: saving > 0 || exporting,
    save: async () => false,
    discard: () => {},
  });
  const locked = dirty || saving > 0;
  function openSource(messageId: string) {
    if (onOpenSource)
      onOpenSource(messageId, {
        stage,
        query,
        selection: selectionRef.current ?? null,
        detailsOpen: panel?.querySelector<HTMLDetailsElement>('.memory-provenance')?.open ?? false,
      });
    else window.dispatchEvent(new CustomEvent('nod:focus-message', { detail: { messageId } }));
  }
  useEffect(() => {
    onDirtyChange?.(dirty || saving > 0 || exporting);
    return () => onDirtyChange?.(false);
  }, [dirty, saving, exporting, onDirtyChange]);

  async function send(path: string, method: string, body?: object) {
    const request = new AbortController();
    requests.current.add(request);
    setSaving((count) => count + 1);
    try {
      const next = await api<MemoryUpdate>(path, {
        method,
        signal: request.signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!mounted.current || request.signal.aborted)
        throw new DOMException('Request cancelled.', 'AbortError');
      update(() => next);
      return next;
    } finally {
      requests.current.delete(request);
      if (mounted.current) setSaving((count) => count - 1);
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
  function focusList() {
    requestAnimationFrame(() => {
      if (!mounted.current) return;
      const target =
        panel?.querySelector<HTMLElement>('.memory-row[aria-current="true"]') ??
        panel?.querySelector<HTMLElement>('.memory-search input,.memory-detail .button');
      target?.focus({ preventScroll: true });
    });
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
    chosen === undefined || (!locked && chosen && !listed(chosen))
      ? compact
        ? null
        : visible[0]
      : chosen;
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
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const detailDirty = useCallback((next: boolean) => {
    if (next && selectionRef.current) setChosen(selectionRef.current);
    setDirty(next);
  }, []);

  const row = (item: MemoryNote) => (
    <button
      key={item.path}
      type="button"
      className="memory-row"
      disabled={locked}
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
            disabled={locked}
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
            disabled={locked}
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
      key={note.path}
      note={note}
      onOpenSource={openSource}
      detailsOpen={Boolean(
        restoredView?.detailsOpen &&
        restoredView.selection &&
        'note' in restoredView.selection &&
        restoredView.selection.note === note.path,
      )}
      onDirtyChange={detailDirty}
      history={(view?.archive ?? []).filter(
        (item) => item.path === note.path || item.by === note.path,
      )}
      onBack={back}
      onChange={async (body) => {
        await send(`/api/memory/notes/${note.path}`, 'PATCH', body);
      }}
      onArchive={async () => {
        await send(`/api/memory/notes/${note.path}/archive`, 'POST');
        setChosen(undefined);
        focusList();
      }}
      onForget={async () => {
        await send(`/api/memory/notes/${note.path}`, 'DELETE');
        setChosen(undefined);
        focusList();
      }}
    />
  ) : archived ? (
    <ArchivedDetail
      key={archivedKey(archived)}
      item={archived}
      onOpenSource={openSource}
      detailsOpen={Boolean(
        restoredView?.detailsOpen &&
        restoredView.selection &&
        'archived' in restoredView.selection &&
        restoredView.selection.archived === archivedKey(archived),
      )}
      onBack={back}
      onRestore={async () => {
        const next = await send('/api/memory/archive/restore', 'POST', {
          path: archived.path,
          archived: archived.archived,
        });
        setStage(null);
        setChosen(next.path ? { note: next.path } : undefined);
        focusList();
      }}
      onForget={async () => {
        await send('/api/memory/archive/forget', 'POST', {
          path: archived.path,
          archived: archived.archived,
        });
        setChosen(undefined);
        focusList();
      }}
    />
  ) : skill ? (
    <SkillDetail
      key={skill.name}
      skill={skill}
      onOpenSource={openSource}
      onDirtyChange={detailDirty}
      onBack={back}
      onChange={async (body) => {
        await send(`/api/memory/skills/${skill.name}`, 'PATCH', body);
      }}
      onForget={async () => {
        await send(`/api/memory/skills/${skill.name}`, 'DELETE');
        setChosen(undefined);
        focusList();
      }}
    />
  ) : null;

  return (
    <div className="memory-panel" ref={panelRef} data-analytics-private>
      {view && (
        <div className="memory-settings">
          <label className="memory-setting">
            <Switch
              checked={view.saving}
              disabled={saving > 0}
              onCheckedChange={(saving) => void setting({ saving })}
            />
            Save new notes
          </label>
          <label className="memory-setting">
            <Switch
              checked={view.sensitive}
              disabled={saving > 0}
              onCheckedChange={(sensitive) => void setting({ sensitive })}
            />
            <span className="memory-setting-copy">
              <span>Include sensitive details</span>
              <span className="memory-setting-hint">Such as health, religion and politics</span>
            </span>
          </label>
        </div>
      )}
      {settingError && <Notice>{settingError}</Notice>}
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
              disabled={locked}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button
              ref={importButton}
              variant="ghost"
              size="sm"
              aria-label="Import"
              title="Import"
              disabled={locked}
              onClick={() => setImporting(true)}
            >
              <Import size={16} aria-hidden="true" />
              <span className="memory-bar-label">Import</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Export"
              title="Export"
              disabled={locked || exporting}
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
            <Button size="sm" disabled={locked} onClick={() => setAdding(true)}>
              <Plus size={16} aria-hidden="true" />
              Add note
            </Button>
          </div>
          <Stages counts={counts} selected={stage} onSelect={filter} disabled={locked} />
          {stage && <p className="memory-hint">{stages.find((item) => item.id === stage)?.hint}</p>}
          <div className={cn('memory-layout', detail && !compact && 'has-detail')}>
            <div className="memory-list">{list}</div>
            {!compact && detail && <div className="memory-detail-column">{detail}</div>}
          </div>
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
